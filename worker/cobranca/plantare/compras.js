import { sha256 } from "../../comum.js";
import { CHAVE, ID, SUB, falhar } from "./contrato.js";

export const COMPRA_ID = /^cmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ORCAMENTO_ID = /^orc-[a-f0-9-]{36}$/;
const numero = (n) => String(n).padStart(16, "0");

function identidade(sub) {
  if (typeof sub !== "string" || !SUB.test(sub)) falhar(400, "entrada_invalida", "identidade inválida");
}

function validar(d, chave) {
  if (!d || typeof d !== "object" || Array.isArray(d)
      || Object.keys(d).some((k) => !["schema", "sub", "intent_id", "orcamento_id"].includes(k))
      || d.schema !== "plantare-checkout/v1" || typeof d.intent_id !== "string" || !ID.test(d.intent_id)
      || typeof d.orcamento_id !== "string" || !ORCAMENTO_ID.test(d.orcamento_id))
    falhar(400, "entrada_invalida", "informe somente schema, sub, intenção e orçamento");
  identidade(d.sub);
  if (typeof chave !== "string" || !CHAVE.test(chave)) falhar(400, "idempotencia_invalida", "Idempotency-Key obrigatório");
  return { schema: d.schema, sub: d.sub, intent_id: d.intent_id, orcamento_id: d.orcamento_id };
}

// Esta etapa registra o rascunho. Não gera Pix nem concede direitos, inclusive
// para cortesia. O gateway só poderá usar a referência persistida aqui.
export async function criarCompra(objeto, entrada, chave) {
  const d = validar(entrada, chave);
  const digest = await sha256(JSON.stringify(d));
  const ik = await objeto.chaveIntencao(d.sub, d.intent_id);
  const idem = "idempotencia:" + await sha256(JSON.stringify(["plantare", d.sub, "checkouts", chave]));
  const conta = await sha256(d.sub);
  return objeto.ctx.storage.transaction(async (tx) => {
    const anterior = await tx.get(idem), intencao = await tx.get(ik);
    if (anterior && anterior.digest !== digest) falhar(409, "idempotencia_conflitante", "chave usada com outros parâmetros");
    if (!intencao) falhar(404, "intencao_nao_encontrada", "intenção não encontrada nesta conta");
    const q = intencao.orcamento;
    if (q.orcamento_id !== d.orcamento_id) falhar(409, "orcamento_divergente", "orçamento não pertence à intenção");
    if (anterior && anterior.compra !== intencao.compra_id)
      falhar(503, "registro_inconsistente", "registro de compra precisa de recuperação");
    if (intencao.compra_id) {
      const registro = await tx.get("compra:" + intencao.compra_id);
      if (!registro || registro.snapshot.sub !== d.sub) falhar(503, "registro_inconsistente", "compra indisponível");
      if (!anterior) await tx.put(idem, { digest, compra: intencao.compra_id });
      return resposta(registro.snapshot);
    }
    if (Date.parse(q.valido_ate) <= objeto.agora()) falhar(410, "orcamento_vencido", "crie outra intenção para obter novo orçamento");

    const id = "cmp-" + crypto.randomUUID();
    const snapshot = { schema: "plantare-compra/v1", id, produto: "plantare", sub: d.sub,
      intent_id: d.intent_id, orcamento_id: q.orcamento_id, versao: 1, estado: "aguardando",
      area_hash: q.area_hash, area_cent_ha: q.area_cent_ha, camadas: q.camadas,
      moeda: q.moeda, centavos: q.centavos, tarifa_versao: q.tarifa_versao,
      cupom: q.cupom, criado_em: new Date(objeto.agora()).toISOString(),
      pago_em: null, baixar_ate: null, direito_ativo: false };
    const contador = "compras-contador:" + conta;
    const sequencia = (await tx.get(contador) || 0) + 1;
    if (!Number.isSafeInteger(sequencia)) falhar(503, "registro_indisponivel", "limite do registro atingido");
    await tx.put("compra:" + id, { fase: "rascunho", referencia_gateway: "plantare-" + id,
      orcamento_valido_ate: q.valido_ate, snapshot });
    await tx.put(ik, { ...intencao, compra_id: id });
    await tx.put(idem, { digest, compra: id });
    await tx.put(contador, sequencia);
    await tx.put("compras-conta:" + conta + ":" + numero(sequencia), id);
    return resposta(snapshot);
  });
}

function resposta(compra) { return { compra, checkout_disponivel: false, checkout_url: null }; }

export async function consultarCompra(objeto, sub, id, tx = objeto.ctx.storage) {
  identidade(sub);
  if (typeof id !== "string" || !COMPRA_ID.test(id)) falhar(400, "entrada_invalida", "identificador de compra inválido");
  const registro = await tx.get("compra:" + id);
  if (!registro || registro.snapshot.sub !== sub) falhar(404, "compra_nao_encontrada", "compra não encontrada nesta conta");
  // Só o snapshot público: referências e fases do gateway ficam na Atos.
  return registro.snapshot;
}

export async function listarCompras(objeto, sub, limite = "25", cursor = null) {
  identidade(sub);
  if (typeof limite !== "string" || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limite))
    falhar(400, "entrada_invalida", "limite deve ser inteiro entre 1 e 100");
  const conta = await sha256(sub), prefix = "compras-conta:" + conta + ":";
  return objeto.ctx.storage.transaction(async (tx) => {
    const total = await tx.get("compras-contador:" + conta) || 0;
    let ate = total, depois = 0;
    if (cursor !== null) {
      const m = typeof cursor === "string" && /^v1\.([a-f0-9]{64})\.([0-9]{16})\.([0-9]{16})$/.exec(cursor);
      if (!m || m[1] !== conta) falhar(400, "cursor_invalido", "cursor inválido para esta conta");
      ate = Number(m[2]); depois = Number(m[3]);
      if (!Number.isSafeInteger(ate) || !Number.isSafeInteger(depois) || depois < 1 || depois >= ate || ate > total)
        falhar(400, "cursor_invalido", "cursor fora do intervalo");
    }
    if (ate === 0) return { compras: [], proximo_cursor: null };
    // Índice ordenado por conta: leitura limitada, sem varrer outras pessoas.
    const linhas = [...await tx.list({ prefix, startAfter: prefix + numero(depois),
      end: prefix + numero(ate) + "\u0000", limit: Number(limite) + 1 })];
    const pagina = linhas.slice(0, Number(limite));
    const compras = [];
    for (const [, id] of pagina) compras.push(await consultarCompra(objeto, sub, id, tx));
    const ultima = pagina.at(-1)?.[0].slice(prefix.length);
    return { compras, proximo_cursor: linhas.length > Number(limite)
      ? `v1.${conta}.${numero(ate)}.${ultima}` : null };
  });
}
