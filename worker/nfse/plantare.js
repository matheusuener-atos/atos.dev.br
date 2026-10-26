import { idDoCliente } from "../cobranca/cliente.js";
import { checkoutAtivo } from "../cobranca/plantare/config.js";
import { compararLancamento, COMPRA, conferirLancamento, descricaoPlantare, ErroFaturamento } from "../cobranca/plantare/faturamento-contrato.js";
import { clienteDaAtos, configNfse, indexarCliente, K } from "./atos.js";

export function criarTabelaPlantare(o) {
  o.sql.exec(`CREATE TABLE IF NOT EXISTS plantare_financeiro (id TEXT PRIMARY KEY, dados TEXT NOT NULL,
    pendente INTEGER NOT NULL DEFAULT 1, proxima INTEGER NOT NULL DEFAULT 0, tentativas INTEGER NOT NULL DEFAULT 0,
    motivo TEXT NOT NULL DEFAULT '')`);
  o.sql.exec("CREATE INDEX IF NOT EXISTS plantare_financeiro_fila ON plantare_financeiro (pendente, proxima, id)");
  o.sql.exec(`CREATE TABLE IF NOT EXISTS plantare_conciliacoes (id TEXT NOT NULL,versao INTEGER NOT NULL,
    texto TEXT NOT NULL,quem TEXT NOT NULL,quando TEXT NOT NULL,PRIMARY KEY(id,versao))`);
}

function ler(o, id) {
  const r = o.um("SELECT * FROM plantare_financeiro WHERE id = ?", id);
  return r ? { ...r, dados: JSON.parse(r.dados) } : null;
}

export function pagamentoPlantare(o, id) {
  const r = ler(o, id);
  if (!r) return null;
  const p = r.dados, n = o.um("SELECT id, estado, numero_nfse FROM notas WHERE pagamento = ? ORDER BY id DESC LIMIT 1", id);
  const conciliacao = o.um("SELECT texto,quem,quando FROM plantare_conciliacoes WHERE id=? AND versao=?", id, p.versao);
  const revisao = p.estado === "devolvida" && !conciliacao;
  return { id, cliente: p.cliente, produto: "plantare", preco: "plantare.talhao", descricao: descricaoPlantare(p),
    valor: p.centavos / 100, quando: p.pago_em, versao: p.versao, situacao_financeira: p.estado,
    nota: n?.estado === "emitida" ? "emitida" : n?.estado === "cancelada" ? "cancelada" : "pendente",
    numero: n?.numero_nfse || "", nota_id: n ? "nfse-" + n.id : "", revisao_fiscal: revisao, conciliacao,
    motivo: revisao ? "Pagamento devolvido ou contestado: conferir a conciliação fiscal antes de emitir ou alterar a nota." : r.motivo };
}

export async function conciliarPlantare(o, { id, versao, texto, quem }) {
  if (!checkoutAtivo(o.env)) throw new ErroFaturamento("integração Plantare desabilitada", 503);
  if (!COMPRA.test(id || "") || !Number.isSafeInteger(versao) || typeof texto !== "string"
      || texto.trim().length < 10 || texto.length > 1000 || typeof quem !== "string" || !quem)
    throw new ErroFaturamento("informe versão e registro da conferência (10 a 1000 caracteres)");
  await o.agendar(o.agora().getTime() + 60000);
  o.ctx.storage.transactionSync(() => {
    const r = ler(o, id);
    if (!r || r.dados.estado !== "devolvida" || r.dados.versao !== versao)
      throw new ErroFaturamento("pagamento mudou; consulte a versão atual antes de conciliar", 409);
    const anterior = o.um("SELECT texto FROM plantare_conciliacoes WHERE id=? AND versao=?", id, versao);
    if (anterior && anterior.texto !== texto.trim()) throw new ErroFaturamento("conferência já registrada nesta versão", 409);
    if (!anterior) o.rodar("INSERT INTO plantare_conciliacoes VALUES (?,?,?,?,?)", id, versao, texto.trim(), quem.slice(0, 120), o.agoraIso());
    o.rodar("UPDATE plantare_financeiro SET pendente=1,proxima=0 WHERE id=?", id);
  });
  await processarUm(o, id);
  return { ok: true, pagamento: pagamentoPlantare(o, id) };
}

export async function registrarPlantare(o, entrada) {
  if (!checkoutAtivo(o.env)) throw new ErroFaturamento("integração Plantare desabilitada", 503);
  const p = conferirLancamento(entrada);
  if (await idDoCliente(p.sub) !== p.cliente || p.centavos <= 0 || !p.pago_em)
    throw new ErroFaturamento("pagamento Plantare sem valor ou dono conferido");
  await o.agendar(o.agora().getTime() + 60000);
  const versao = o.ctx.storage.transactionSync(() => {
    const anterior = ler(o, p.id), resultado = compararLancamento(anterior?.dados, p);
    if (resultado === "novo") o.rodar(`INSERT INTO plantare_financeiro (id,dados) VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET dados=excluded.dados,pendente=1,proxima=0,tentativas=0,motivo=''`, p.id, JSON.stringify(p));
    return resultado === "novo" ? p.versao : anterior.dados.versao;
  });
  // O ACK é do registro durável. Configuração, KV ou emissão indisponível
  // continuam recuperáveis na fila SQL do emissor, independentemente da origem.
  await processarUm(o, p.id);
  return { ok: true, versao };
}

// Executado antes de criar DPS e imediatamente antes de qualquer novo envio.
// Consultar uma DPS já enviada continua permitido para resolver resposta perdida.
export function exigirPlantare(o, pagamento, conta, { nova = false, substitui = false } = {}) {
  if (!COMPRA.test(pagamento || "")) return;
  if (!checkoutAtivo(o.env) || o.prestadorAtual()?.dados.ambiente !== "producao_restrita")
    throw new ErroFaturamento("emissão Plantare disponível apenas em homologação", 403);
  const r = ler(o, pagamento);
  if (!r || r.dados.estado !== "paga" || (conta && r.dados.cliente !== conta))
    throw new ErroFaturamento("pagamento Plantare não está disponível para emissão", 409);
  if (nova && !substitui && o.um("SELECT id FROM notas WHERE pagamento = ? LIMIT 1", pagamento))
    throw new ErroFaturamento("este pagamento Plantare já possui registro de nota", 409);
}

async function processarUm(o, id) {
  o.plantareOcupadas ||= new Set();
  if (o.plantareOcupadas.has(id)) return;
  const r = ler(o, id), agora = o.agora().getTime();
  if (!r || !r.pendente || r.proxima > agora) return;
  o.plantareOcupadas.add(id);
  o.rodar("UPDATE plantare_financeiro SET tentativas=tentativas+1,proxima=? WHERE id=?",
    agora + Math.min(3600000, 60000 * 2 ** Math.min(r.tentativas, 6)), id);
  try {
    if (!o.env.CONTAS) throw new Error("índice fiscal indisponível");
    const p = r.dados;
    try { await o.env.CONTAS.put(K(o.env).pag + id, JSON.stringify(pagamentoPlantare(o, id))); }
    catch { /* a projeção será retomada; a autoridade continua no SQL */ }
    if (p.estado === "paga" && !o.um("SELECT id FROM notas WHERE pagamento = ? LIMIT 1", id) && (await configNfse(o.env)).auto) {
      const c = await clienteDaAtos(o.env, p.cliente);
      if (!c.tem_perfil && !c.ajustado) throw new Error("cliente sem dados fiscais");
      if (c.faltas.length) throw new Error("falta " + c.faltas.join(", ") + " do cliente");
      if (!await indexarCliente(o.env, p.cliente, { nome: c.nome, email: c.email, documento: c.documento }))
        throw new Error("índice do cliente indisponível");
      await o.emitir({ conta: p.cliente, pagamento: id, tomador: c.tomador, quem: "automático Plantare" });
    }
    // KV é só projeção. Nunca usa sua ausência para decidir emitir novamente.
    const atual = pagamentoPlantare(o, id);
    await o.env.CONTAS.put(K(o.env).pag + id, JSON.stringify(atual));
    const maisNovo = ler(o, id);
    if (maisNovo.dados.versao === r.dados.versao) o.rodar("UPDATE plantare_financeiro SET pendente=0,motivo='' WHERE id=?", id);
  } catch (e) {
    if (ler(o, id)?.dados.versao === r.dados.versao)
      o.rodar("UPDATE plantare_financeiro SET motivo=? WHERE id=?", String(e.message || e).slice(0, 200), id);
    try { await o.env.CONTAS?.put(K(o.env).pag + id, JSON.stringify(pagamentoPlantare(o, id))); } catch { /* índice será recuperado */ }
    await o.agendar(o.agora().getTime() + 60000);
  } finally { o.plantareOcupadas.delete(id); }
}

export async function processarPlantare(o) {
  if (!checkoutAtivo(o.env)) return;
  const agora = o.agora().getTime();
  const pendentes = o.todos("SELECT id FROM plantare_financeiro WHERE pendente=1 AND proxima<=? ORDER BY proxima,id LIMIT 16", agora);
  if (pendentes.length) await o.agendar(agora + 60000);
  for (const p of pendentes) await processarUm(o, p.id);
  const proximo = o.um("SELECT MIN(proxima) AS p FROM plantare_financeiro WHERE pendente=1");
  if (proximo?.p != null) await o.agendar(Math.max(agora + 1000, proximo.p));
}
