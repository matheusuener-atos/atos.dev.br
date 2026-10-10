// O emissor de NFS-e da Atos (worker/nfse/emissor.js, o Durable Object
// EmissorNFSe, e worker/nfse/api.js), sem rede - o teste do PAVLVS
// (C:\coryphaeus\worker\teste-nfse-emissor.mjs) com as chaves e os ids da Atos:
//   node worker/teste-nfse-emissor.mjs
//
//   1. ouro: configuração, conta, conferência e XML da DPS IDÊNTICOS ao
//      emissor em Python (fixtures/emissor.json, de fixtures/gerar_emissor.py),
//      e o pedido de evento também;
//   2. o DO com SQLite de verdade (node:sqlite no lugar do ctx.storage.sql) e a
//      Sefin simulada (porte de _sefin_simulada.py) atrás do SEFIN_MTLS:
//      sucesso, rejeição com frase, tempo esgotado antes/depois (consulta
//      antes de reenviar, sem duplicar), 503, E0014, servidor fora e a fila;
//   3. numeração sob concorrência (20 emissões ao mesmo tempo);
//   4. cancelamento e substituição, com o aviso ao cliente da Atos (KV atos:nfse:nota*);
//   5. produção trancada;
//   6. a CPU de uma emissão completa (process.cpuUsage, média).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { conferirPrestador } from "./nfse/prestador.js";
import { calcular } from "./nfse/tributos.js";
import { conferir } from "./nfse/conferencia.js";
import { hojeBrasilia, montarDps } from "./nfse/dps.js";
import { montarPedidoEvento } from "./nfse/eventos.js";
import { EmissorNFSe, lerNfse } from "./nfse/emissor.js";
import { atenderEmissor, depoisDeEmitir } from "./nfse/api.js";
import { SefinSimulada } from "./nfse/sefin-simulada.js";
import { ClienteSefin, ProducaoBloqueada } from "./nfse/sefin.js";
import { cifrar, decifrar } from "./nfse/cofre.js";
import { lerPfx } from "./nfse/pfx.js";
import { b64 } from "./nfse/assinatura.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIX = join(AQUI, "nfse", "fixtures");

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 1500)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------- 1. ouro
console.log("1. ouro: o mesmo resultado do emissor em Python");
const ouro = JSON.parse(readFileSync(join(FIX, "emissor.json"), "utf8"));
let iguais = 0;
for (const c of ouro.casos) {
  const dif = [];
  const { prest, faltas } = conferirPrestador(structuredClone(c.prest_cru));
  if (!isDeepStrictEqual(prest, c.prest)) dif.push(["prestador", prest, c.prest]);
  if (!isDeepStrictEqual(faltas, c.faltas)) dif.push(["faltas", faltas, c.faltas]);
  const conta = calcular(prest, c.nota, { municipioAtivo: c.municipio_ativo });
  if (!isDeepStrictEqual(conta, c.conta)) dif.push(["conta", conta, c.conta]);
  const r = conferir({ prest, nota: c.nota, conta, municipio: { pode_emitir: true }, hoje: ouro.hoje });
  if (!isDeepStrictEqual(r.erros, c.erros)) dif.push(["erros", r.erros, c.erros]);
  if (!isDeepStrictEqual(r.avisos, c.avisos)) dif.push(["avisos", r.avisos, c.avisos]);
  try {
    const { xml, id } = montarDps({ prest, nota: c.nota, conta, ambiente: c.ambiente, serie: c.serie, numero: c.numero,
      quando: new Date(ouro.quando), verAplic: "PAVLVS-nuvem" });
    if (xml !== Buffer.from(c.xml_b64, "base64").toString("utf8")) dif.push(["xml", xml]);
    if (id !== c.id) dif.push(["id", id, c.id]);
  } catch (e) {
    if (!c.erro_montar) dif.push(["montar", String(e)]);
  }
  if (!dif.length) iguais++;
  else checar(false, c.nome, dif);
}
checar(iguais === ouro.casos.length, `${iguais}/${ouro.casos.length} casos (20 da planilha N2, 4 de software do PAVLVS, 4 de borda): configuração, conta com linhas, erros, avisos e XML byte a byte`);
const soft = ouro.casos.filter((c) => c.nome.startsWith("software"));
checar(soft.length === 4 && soft.every((c) => /<cClassTrib>000001<\/cClassTrib>/.test(Buffer.from(c.xml_b64, "base64").toString()) && /<CST>000<\/CST>/.test(Buffer.from(c.xml_b64, "base64").toString())),
  "os de software levam cClassTrib 000001 e CST 000 (cIndOp 100501 e 100301)");
checar(ouro.casos.find((c) => c.nome.includes("110322000")).erros.some((e) => e.includes("E0316")),
  "NBS 110322000 não está na tabela oficial: Python e JS acusam E0316 (a de 01.05 é 111032200)");
for (const e of ouro.eventos) {
  const { xml, id } = montarPedidoEvento({ chave: e.chave, ambiente: e.ambiente, documento: e.documento, tipo: e.tipo, motivo: e.motivo,
    texto: e.texto, quando: new Date(ouro.quando), verAplic: e.ver_aplic });
  checar(xml === Buffer.from(e.xml_b64, "base64").toString("utf8") && id === e.id, `pedido de evento idêntico: ${e.nome}`);
}

// ------------------------------------------------------------- o ambiente
const kv = new Map();
const CONTAS = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { kv.set(k, v); },
  delete: async (k) => { kv.delete(k); },
  list: async ({ prefix }) => ({ list_complete: true, keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
};
const kvJson = (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null);

function storageSqlite() {
  const db = new DatabaseSync(":memory:");
  let alarme = null;
  return {
    db,
    sql: { exec(q, ...b) { const linhas = db.prepare(q).all(...b); return { toArray: () => linhas }; } },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    getAlarm: async () => alarme,
    setAlarm: async (t) => { alarme = Number(t); },
    deleteAlarm: async () => { alarme = null; },
  };
}

const sim = new SefinSimulada("sucesso");
const mestra = b64(crypto.getRandomValues(new Uint8Array(32)));
const storage = storageSqlite();
let instancia = null;
const EMISSOR_NFSE = {
  idFromName: (n) => n,
  get: (n) => ({
    fetch: (url, init) => {
      if (n !== "atos") throw new Error("instância errada: " + n);
      return instancia.fetch(new Request(url, init));
    },
  }),
};
const env = { CONTAS, EMISSOR_NFSE, NFSE_CHAVE_MESTRA: mestra, SEFIN_MTLS: { fetch: sim.fetch } };
instancia = new EmissorNFSe({ storage }, env);
let relogio = null; // null = hora real
instancia.agora = () => (relogio === null ? new Date() : new Date(relogio));

const esperando = [];
const ctx = { waitUntil: (p) => esperando.push(p) };
async function api(metodo, caminho, corpo) {
  const req = new Request("https://atos.dev.br/api/admin/nfse/" + caminho, { method: metodo,
    headers: { "content-type": "application/json" }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const r = await atenderEmissor(req, env, new URL(req.url), { email: "teste@atos.dev.br", papel: "dono" }, { ctx });
  const tipo = r.headers.get("content-type") || "";
  return { status: r.status, dados: tipo.includes("json") ? await r.json() : await r.text(), tipo };
}

const CONTA = "c".repeat(32);
const CONTA2 = "d".repeat(32);
kv.set("atos:nfse:clientes:" + CONTA, JSON.stringify({ id: CONTA, nome: "Ana Advocacia" }));
kv.set("atos:nfse:clientes:" + CONTA2, JSON.stringify({ id: CONTA2, nome: "Outro" }));
kv.set("atos:nfse:config", JSON.stringify({ auto: false, email: true, mail: false }));
const HOJE = hojeBrasilia();
const pagar = (id, cliente, valor) => kv.set("atos:nfse:pag:" + id, JSON.stringify({ id, cliente, produto: "pavlvs", descricao: "PAVLVS Escritório · mensalidade", valor, quando: HOJE + "T10:00:00Z", nota: "pendente" }));
const TOMADOR = { nome: "Ana Advocacia", documento: "529.982.247-25", logradouro: "Rua dos Mundurucus", numero: "1500",
  bairro: "Batista Campos", cep: "66010-000", cmun: "1501402", email: "ana@escritorio.com.br" };
const PRESTADOR = {
  documento: "11222333000181", razao_social: "PAVLVS Tecnologia", inscricao_municipal: "7788990", municipio: "1501402",
  opcao_simples: "1", regime_especial: "0",
  servico: { ctribnac: "010301", nbs: "115062100", descricao: "Assinatura do PAULUS", aliquota_iss_bp: 200 },
  retencoes: Object.fromEntries(["iss", "irrf", "pis", "cofins", "csll", "cp"].map((k) => [k, { quando: "nunca" }])),
  ibscbs: { enviar: true, cst: "000", cclasstrib: "000001", cindop: "100301", indfinal: "1" },
  total_tributos: { modo: "percentual", federal_bp: 1345, municipal_bp: 200 },
};
const senha = "segredo-de-teste";
const cert = lerPfx(readFileSync(join(FIX, "a1-cn.pfx")), senha);
const outro = lerPfx(readFileSync(join(FIX, "a1-ecnpj.pfx")), senha);

// ------------------------------------------------------------- 2. configurar
console.log("2. configurar, certificado e comunicação");
let r = await api("GET", "situacao");
checar(r.status === 200 && r.dados.pode_emitir === false && r.dados.motivos.some((m) => m.includes("certificado")), "sem configuração: não pode emitir, e diz por quê", r.dados.motivos);
r = await api("POST", "notas", { tomador: TOMADOR, valor: 300, descricao: "x" });
checar(r.status === 409 && /ainda não dá para emitir/.test(r.dados.erro), "emitir antes de configurar é recusado (409)", r);
r = await api("POST", "prestador", { prestador: { ...PRESTADOR, documento: "11222333000182" } });
checar(r.status === 400 && /CNPJ do prestador não confere/.test(r.dados.erro), "CNPJ errado na configuração: a frase do Python", r.dados);
r = await api("POST", "prestador", { prestador: PRESTADOR });
checar(r.status === 200 && r.dados.mudou && r.dados.versao === 1 && r.dados.faltas.length === 0, "configuração gravada como versão 1, sem faltas", r.dados);
r = await api("POST", "prestador", { prestador: PRESTADOR });
checar(r.dados.mudou === false && r.dados.versao === 1, "gravar igual não cria versão nova");
r = await api("POST", "certificado", { certificado: cert.certPem, chave: b64(outro.chavePkcs8), titular: cert.titular, documento: cert.documento });
checar(r.status === 400 && /não é a deste certificado/.test(r.dados.erro), "chave de outro certificado é recusada", r.dados);
r = await api("POST", "certificado", { certificado: cert.certPem, chave: "-----BEGIN PRIVATE KEY-----\n" + b64(cert.chavePkcs8) + "\n-----END PRIVATE KEY-----",
  titular: cert.titular, documento: cert.documento });
checar(r.status === 200 && r.dados.certificado.instalado && r.dados.certificado.documento === "11222333000181" && r.dados.certificado.valido_ate === cert.validoAte.replace(/\.\d+Z$/, ".000Z"),
  "certificado guardado; a validade sai do próprio certificado", r.dados);
const linhaCert = storage.db.prepare("SELECT * FROM certificado WHERE ativo = 1").get();
checar(linhaCert.chave_cifrada.startsWith("v1.") && !linhaCert.chave_cifrada.includes(b64(cert.chavePkcs8).slice(10, 40)),
  "a chave fica cifrada no DO (AES-GCM com a NFSE_CHAVE_MESTRA)");
let abriuComOutra = true;
try {
  await decifrar({ NFSE_CHAVE_MESTRA: b64(new Uint8Array(32)) }, linhaCert.chave_cifrada, "chave");
} catch {
  abriuComOutra = false;
}
checar(!abriuComOutra, "com outra chave mestra, a chave não abre");
let trocouRotulo = true;
try {
  await decifrar(env, await cifrar(env, new Uint8Array([1, 2, 3]), "certificado"), "chave");
} catch {
  trocouRotulo = false;
}
checar(!trocouRotulo, "o cifrado do certificado não serve como chave (rótulo no dado associado)");
r = await api("POST", "testar");
checar(r.status === 200 && r.dados.municipio.situacao === "conveniado" && r.dados.municipio.prazo_cancelamento_dias === 30,
  "testar comunicação: convênio de Belém ativo, prazo de cancelamento de 30 dias", r.dados);
r = await api("GET", "situacao");
checar(r.dados.pode_emitir === true && r.dados.ambiente === "producao_restrita" && r.dados.proximo_numero === 1, "pronto para emitir, em produção restrita", r.dados.motivos);

// ------------------------------------------------------------- 3. emissão
console.log("3. emissão contra a Sefin simulada");
pagar("PAY1", CONTA, 300);
r = await api("POST", "notas", { conta: CONTA, pagamento: "PAY1", tomador: TOMADOR });
const n1 = r.dados;
checar(r.status === 200 && n1.estado === "emitida" && n1.numero_dps === 1 && n1.numero === "1" && n1.chave.length === 50,
  "emitida: DPS número 1, NFS-e com chave de 50 posições", r.dados);
checar(n1.centavos === 30000 && n1.descricao === "PAVLVS Escritório · mensalidade" && n1.competencia === HOJE.slice(0, 7),
  "valor, descrição e competência vêm do pagamento quando não vêm no pedido");
const det = (await api("GET", "notas/" + n1.id)).dados;
checar(det.passos.map((p) => p.para).join(">") === "rascunho>assinada>enviando>emitida>emitida", "passos gravados: rascunho > assinada > enviando > emitida", det.passos.map((p) => p.para));
const dpsAssinada = storage.db.prepare("SELECT xml_dps FROM notas WHERE id = ?").get(n1.id).xml_dps;
checar(dpsAssinada.includes("<Signature xmlns=\"http://www.w3.org/2000/09/xmldsig#\">") && dpsAssinada.includes("<cClassTrib>000001</cClassTrib>"),
  "a DPS foi assinada (XMLDSig) e leva o grupo IBSCBS");
const base1 = CONTA + ":nfse-" + n1.id;
const meta1 = kvJson("atos:nfse:nota:" + base1);
checar(meta1 && meta1.numero === "1" && meta1.valor === 300 && meta1.competencia === HOJE.slice(0, 7) && meta1.tem_xml && !meta1.tem_pdf && meta1.cancelada === false,
  "a nota foi para as chaves do cliente da Atos (atos:nfse:nota:<cliente>:nfse-<id>)", meta1);
const xmlKv = Buffer.from(kv.get("atos:nfse:nota-xml:" + base1), "base64").toString("utf8");
checar(lerNfse(xmlKv).chave === n1.chave, "atos:nfse:nota-xml guarda o XML da NFS-e (base64)");
checar(kvJson("atos:nfse:pag:PAY1").nota === "emitida" && kvJson("atos:nfse:pag:PAY1").numero === "1", "o pagamento atos:nfse:pag:PAY1 ficou emitida, com o número");
r = await api("POST", "notas", { conta: CONTA, pagamento: "PAY1", tomador: TOMADOR });
checar(r.status === 409 && /já tem nota/.test(r.dados.erro), "o mesmo pagamento não gera segunda nota (409)", r);
r = await api("GET", "notas/" + n1.id + "/xml");
checar(r.status === 200 && r.tipo.startsWith("application/xml") && r.dados.includes("<NFSe"), "GET xml devolve a NFS-e como application/xml");
r = await api("POST", "notas", { conta: CONTA, tomador: { ...TOMADOR, documento: "11222333000182" }, valor: 10, descricao: "x" });
checar(r.status === 400 && r.dados.erros.some((e) => e.includes("E0188")), "conferência barra o CNPJ do tomador errado, sem reservar número", r.dados);
checar((await api("GET", "situacao")).dados.proximo_numero === 2, "o número 2 continua livre");

// rejeição
sim.usar(["rejeicao", "sucesso"]);
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: "150,00", descricao: "Recarga" });
const rej = r.dados;
checar(rej.estado === "rejeitada" && rej.numero_dps === 2 && rej.rejeicao[0].codigo === "E0595" && /Campo: alíquota do ISS\./.test(rej.rejeicao[0].frase),
  "rejeição traduzida: código, frase oficial e o campo", rej.rejeicao);
r = await api("POST", "notas/" + rej.id + "/descartar");
checar(r.dados.estado === "descartada", "a rejeitada é descartada");
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 150, descricao: "Recarga de novo" });
checar(r.dados.estado === "emitida" && r.dados.numero_dps === 2, "o número 2 devolvido vai para a próxima nota (sem buraco)", r.dados);

// tempo esgotado DEPOIS de gerar: consulta e acha, não reenvia
sim.usar(["timeout_depois", "sucesso"]);
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 50, descricao: "Timeout depois" });
let idDps = r.dados.id_dps;
checar(r.dados.estado === "emitida" && sim.recebidas.get(idDps) === 1, "tempo esgotado depois de gerar: a consulta acha a nota; a DPS chegou uma vez só", { estado: r.dados.estado, rec: sim.recebidas.get(idDps) });

// tempo esgotado ANTES: consulta diz que não existe; na fila; tentar reenvia a MESMA DPS
sim.usar(["timeout_antes", "sucesso"]);
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 51, descricao: "Timeout antes" });
const ta = r.dados;
checar(ta.estado === "na_fila" && ta.proxima_tentativa && sim.geradas.size === 3, "tempo esgotado antes de gerar: a consulta (404) põe na fila, sem reenviar às cegas", ta);
checar((await storage.getAlarm()) !== null, "o alarme do DO ficou marcado para tentar de novo");
r = await api("POST", "notas/" + ta.id + "/tentar");
checar(r.dados.estado === "emitida" && sim.recebidas.get(ta.id_dps) === 2 && r.dados.id_dps === ta.id_dps && r.dados.numero_dps === ta.numero_dps,
  "tentar: consulta, não existe, reenvia a MESMA DPS (mesmo Id) e emite uma vez", r.dados);

// 503 depois de gerar
sim.usar(["erro500_depois", "sucesso"]);
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 52, descricao: "503" });
checar(r.dados.estado === "emitida" && sim.recebidas.get(r.dados.id_dps) === 1, "503 depois de gerar: consulta e acha", r.dados.estado);

// E0014: a consulta ainda não enxerga; o reenvio esbarra em E0014 e vira consulta
sim.usar(["timeout_depois", "nao_acha", "nao_acha", "sucesso"]);
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 53, descricao: "E0014" });
const e14 = r.dados;
checar(e14.estado === "na_fila", "sem resposta e consulta que não acha: fica na fila", e14.estado);
const geradasAntes = sim.geradas.size;
r = await api("POST", "notas/" + e14.id + "/tentar");
const passosE14 = (await api("GET", "notas/" + e14.id)).dados.passos.map((p) => p.detalhe).join(" | ");
checar(r.dados.estado === "emitida" && sim.geradas.size === geradasAntes && sim.recebidas.get(e14.id_dps) === 2 && passosE14.includes("E0014"),
  "reenvio com E0014 vira consulta: emitida, ZERO nota duplicada", { estado: r.dados.estado, passos: passosE14 });

// servidor fora: fila com espera crescente, e o alarme resolve
sim.usar("fora");
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 54, descricao: "Fora" });
const fora = r.dados;
checar(fora.estado === "na_fila" && /não saiu/.test(fora.erro) && sim.recebidas.get(fora.id_dps) === undefined, "servidor fora: na fila, e a DPS nunca chegou", fora);
sim.usar("sucesso");
relogio = null;
await instancia.alarm();
checar(instancia.obter(fora.id).estado === "na_fila", "o alarme antes da hora marcada não mexe na nota");
relogio = Date.now() + 2 * 60000;
await instancia.alarm();
checar(instancia.obter(fora.id).estado === "emitida", "na hora marcada, o alarme consulta e envia: emitida");
relogio = null;

// a nota que ficou "enviando" (o DO caiu no meio): a fila consulta antes de reenviar
sim.usar(["timeout_depois", "fora", "sucesso"]);
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 55, descricao: "Caiu no meio" });
const caiu = r.dados;
storage.db.prepare("UPDATE notas SET estado = 'enviando', atualizado_em = ? WHERE id = ?").run(new Date(Date.now() - 10 * 60000).toISOString(), caiu.id);
relogio = Date.now() + 2 * 3600000;
await instancia.alarm();
relogio = null;
checar(instancia.obter(caiu.id).estado === "emitida" && sim.recebidas.get(caiu.id_dps) === 1, "nota parada em \"enviando\": o alarme consulta, acha e não reenvia");

// ------------------------------------------------------------- 4. concorrência
console.log("4. numeração sob concorrência");
const antes = (await api("GET", "situacao")).dados.proximo_numero;
const vinte = await Promise.all(Array.from({ length: 20 }, (_, i) => api("POST", "notas", { conta: CONTA2, tomador: TOMADOR, valor: 10 + i, descricao: "Concorrente " + i })));
const numeros = vinte.map((x) => x.dados.numero_dps).sort((a, b) => a - b);
checar(vinte.every((x) => x.dados.estado === "emitida"), "20 emissões ao mesmo tempo: todas emitidas", vinte.map((x) => x.dados.estado || x.dados.erro));
checar(new Set(numeros).size === 20 && numeros[0] === antes && numeros[19] === antes + 19, "os 20 números são distintos e seguidos (sem repetir, sem buraco)", numeros);
const todosNum = storage.db.prepare("SELECT numero FROM notas WHERE numero IS NOT NULL ORDER BY numero").all().map((x) => x.numero);
checar(todosNum.every((n, i) => n === i + 1), "na base, os números vão de 1 a " + todosNum.length + " sem buraco", todosNum);

// ------------------------------------------------------------- 5. cancelar e substituir
console.log("5. cancelamento e substituição");
r = await api("POST", "notas/" + n1.id + "/cancelar", { motivo: "1", texto: "curto" });
checar(r.status === 400 && /15 a 255/.test(r.dados.erro), "motivo com menos de 15 caracteres é recusado", r.dados);
r = await api("POST", "notas/" + n1.id + "/cancelar", { motivo: "7", texto: "Erro na emissão do valor da nota" });
checar(r.status === 400 && /tabela oficial/.test(r.dados.erro), "motivo fora da tabela oficial é recusado");
r = await api("POST", "notas/" + n1.id + "/cancelar", { motivo: "1", texto: "Erro na emissão: valor errado na nota" });
checar(r.status === 200 && r.dados.nota.estado === "cancelada" && r.dados.evento.estado === "registrado", "cancelada: evento e101101 registrado na Sefin", r.dados);
const metaCanc = kvJson("atos:nfse:nota:" + base1);
checar(metaCanc.cancelada === true && kvJson("atos:nfse:pag:PAY1").nota === "cancelada", "o cliente vê a nota cancelada e o pagamento fica \"cancelada\"", metaCanc);
r = await api("POST", "notas/" + n1.id + "/cancelar", { motivo: "1", texto: "Erro na emissão: valor errado na nota" });
checar(r.status === 409, "cancelar de novo é recusado (409)");

const listaEmitidas = (await api("GET", "notas?estado=emitida")).dados.notas;
const paraFora = listaEmitidas[0];
sim.usar(["fora_do_prazo", "sucesso"]);
r = await api("POST", "notas/" + paraFora.id + "/cancelar", { motivo: "2", texto: "Serviço não prestado ao cliente" });
checar(r.dados.evento.estado === "rejeitado" && /E0822/.test(r.dados.evento.rejeicao[0].codigo) && r.dados.nota.estado === "emitida",
  "fora do prazo na Sefin: o evento volta rejeitado com a frase, e a nota continua emitida", r.dados.evento);
const paraTimeout = listaEmitidas[1];
sim.usar(["timeout_depois", "sucesso"]);
r = await api("POST", "notas/" + paraTimeout.id + "/cancelar", { motivo: "9", texto: "Outros: pedido do cliente por escrito" });
checar(r.dados.nota.estado === "cancelada" && sim.pedidosEvento.get(paraTimeout.chave + "101101") === 1,
  "evento sem resposta: consulta os eventos da nota, acha e não pede de novo", r.dados);

const original = listaEmitidas[2];
r = await api("POST", "notas/" + original.id + "/substituir", { motivo: "99", texto: "curto" });
checar(r.status === 400, "substituição com descrição curta é recusada");
r = await api("POST", "notas/" + original.id + "/substituir", { motivo: "99", texto: "Valor digitado errado na nota anterior", ajustes: { valor: "99,90" } });
const subs = r.dados;
checar(r.status === 200 && subs.nota.estado === "emitida" && subs.nota.centavos === 9990 && subs.nota.substitui_id === original.id && subs.original.estado === "substituida"
  && subs.original.substituida_por_id === subs.nota.id, "substituta emitida com o valor novo; a original fica substituída e ligada a ela", r.dados);
const dpsSub = storage.db.prepare("SELECT xml_dps FROM notas WHERE id = ?").get(subs.nota.id).xml_dps;
checar(dpsSub.includes(`<subst><chSubstda>${original.chave}</chSubstda><cMotivo>99</cMotivo><xMotivo>Valor digitado errado na nota anterior</xMotivo></subst>`),
  "a DPS substituta leva o grupo subst com a chave da original");
const metaOrig = kvJson("atos:nfse:nota:" + CONTA2 + ":nfse-" + original.id);
checar(metaOrig.cancelada === true && metaOrig.substituta === subs.nota.numero && kvJson("atos:nfse:nota:" + CONTA2 + ":nfse-" + subs.nota.id).numero === subs.nota.numero,
  "cliente: a original cancelada com o número da substituta, e a substituta lá", metaOrig);
checar((sim.eventos.get(original.chave) || []).some((e) => e.tipo === "105102"), "a Sefin registrou o cancelamento por substituição (e105102)");
r = await api("POST", "notas/" + original.id + "/substituir", { motivo: "99", texto: "Valor digitado errado na nota anterior" });
checar(r.status === 409, "a substituída não se substitui de novo");
// por ofício: o município cancela; a consulta mostra
const oficio = listaEmitidas[3];
await sim.registrarEvento(oficio.chave, "<evento><e305101/></evento>", "305101");
r = await api("POST", "notas/" + oficio.id + "/situacao");
checar(r.dados.estado === "cancelada", "atualizar situação: o cancelamento por ofício aparece", r.dados.estado);

// ------------------------------------------------------------- depois de emitir
console.log("6. depois de emitir (PDF), em pedido separado");
const ultima = (await api("GET", "notas?estado=emitida&limite=1")).dados.notas[0];
r = await api("POST", "notas/" + ultima.id + "/depois");
checar(r.status === 202 && esperando.length === 1, "POST depois responde 202 e deixa o trabalho no ctx.waitUntil");
await Promise.all(esperando.splice(0));
const baseU = ultima.conta + ":nfse-" + ultima.id;
const pdfKv = kv.get("atos:nfse:nota-pdf:" + baseU);
checar(pdfKv && Buffer.from(pdfKv, "base64").subarray(0, 5).toString() === "%PDF-" && kvJson("atos:nfse:nota:" + baseU).tem_pdf === true,
  "o DANFSe foi para atos:nfse:nota-pdf e a meta diz tem_pdf");
checar(instancia.obter(ultima.id).pdf_em !== "", "a nota marca quando o PDF foi feito");

// ------------------------------------------------------------- 7. produção
console.log("7. produção trancada");
let bloqueou = false;
try {
  new ClienteSefin({ ambiente: "producao", fetch: sim.fetch, producaoLiberada: false });
} catch (e) {
  bloqueou = e instanceof ProducaoBloqueada;
}
checar(bloqueou, "o cliente da Sefin recusa produção sem a liberação");
checar(!sim.pedidos.some(([, u]) => /\/\/(sefin|adn)\.nfse\.gov\.br/.test(u)), "até aqui, nenhum pedido saiu para a produção");
r = await api("POST", "prestador", { prestador: { ambiente: "producao" } });
checar((await api("GET", "situacao")).dados.ambiente === "producao_restrita", "a configuração não muda o ambiente");
r = await api("POST", "producao/liberar");
checar(r.status === 200 && r.dados.ambiente === "producao" && r.dados.producao_liberada, "liberar: ambiente de produção, liberação registrada", r.dados);
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 300, descricao: "Produção" });
checar(r.status === 409 && /Ainda não consultei/.test(r.dados.erro), "em produção, o município precisa ser consultado de novo antes de emitir", r.dados);
await api("POST", "testar");
checar(sim.pedidos.some(([, u]) => u.startsWith("https://adn.nfse.gov.br/parametrizacao")), "liberada, a consulta vai ao endereço de produção");
r = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 300, descricao: "Produção" });
const prod = r.dados;
checar(prod.estado === "emitida" && prod.ambiente === "producao" && prod.numero_dps === 1 && sim.pedidos.some(([m, u]) => m === "POST" && u.startsWith("https://sefin.nfse.gov.br/")),
  "em produção, a numeração é própria (começa no 1) e a DPS vai à Sefin de produção", prod);
const dpsProd = storage.db.prepare("SELECT xml_dps FROM notas WHERE id = ?").get(prod.id).xml_dps;
checar(dpsProd.includes("<tpAmb>1</tpAmb>"), "a DPS de produção sai com tpAmb 1");
r = await api("POST", "producao/voltar");
checar(r.dados.ambiente === "producao_restrita" && !r.dados.producao_liberada, "voltar para testes revoga a liberação");
storage.db.prepare("UPDATE notas SET estado = 'na_fila' WHERE id = ?").run(prod.id);
const pedidosAntes = sim.pedidos.length;
r = await api("POST", "notas/" + prod.id + "/tentar");
checar(r.status === 403 && sim.pedidos.length === pedidosAntes, "nota de produção com a produção trancada: 403 e nenhum pedido sai", r);

// ------------------------------------------------------------- 8. CPU
console.log("8. CPU de uma emissão completa (o limite do plano grátis é 10 ms por pedido)");
storage.db.prepare("UPDATE notas SET estado = 'emitida' WHERE id = ?").run(prod.id);
sim.usar("sucesso");
const cpu = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };
let cpuSim = 0;
const atenderOriginal = sim.atender.bind(sim);
sim.atender = async (req) => {
  const c0 = cpu();
  try {
    return await atenderOriginal(req);
  } finally {
    cpuSim += cpu() - c0;
  }
};
const N = 150;
let t = performance.now();
await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 1, descricao: "aquecer" });
const primeira = performance.now() - t;
const c0 = cpu();
cpuSim = 0;
const tempos = [];
for (let i = 0; i < N; i++) {
  t = performance.now();
  const x = await api("POST", "notas", { conta: CONTA, tomador: TOMADOR, valor: 1 + i, descricao: "Medida " + i });
  tempos.push(performance.now() - t);
  if (x.dados.estado !== "emitida") { checar(false, "emissão da medida", x.dados); break; }
}
const total = (cpu() - c0) / N;
const daSim = cpuSim / N;
tempos.sort((a, b) => a - b);
console.log(`  emissão completa (API -> DO -> conferência -> número -> DPS -> assinatura -> gzip -> Sefin -> NFS-e lida -> KV):`);
console.log(`    CPU média ${(total - daSim).toFixed(2)} ms sem a Sefin simulada (${total.toFixed(2)} ms com ela; a simulada gasta ${daSim.toFixed(2)} ms)`);
console.log(`    relógio: 1ª ${primeira.toFixed(1)} ms, mediana ${tempos[N >> 1].toFixed(2)} ms, p90 ${tempos[Math.floor(N * 0.9)].toFixed(2)} ms`);
const idsPdf = (await api("GET", "notas?estado=emitida&limite=30")).dados.notas.map((n) => n.id);
const c1 = cpu();
for (const id of idsPdf) await depoisDeEmitir(env, id);
console.log(`  depois de emitir (DANFSe + KV), em pedido separado: CPU média ${((cpu() - c1) / idsPdf.length).toFixed(2)} ms`);
checar(total - daSim < 10, "emissão completa abaixo de 10 ms de CPU (média, nesta máquina)", total - daSim);

{
  const doPavlvs = [...kv.keys()].filter((k) => !k.startsWith("atos:nfse:"));
  checar(doPavlvs.length === 0, "todas as chaves que o emissor gravou no KV começam com atos:nfse: (nada de admin:* nem nfse:nota* do PAVLVS)", doPavlvs.slice(0, 10));
}

console.log(falhas ? `\n  emissor da nuvem: ${falhas} FALHA(S)` : "\n  emissor da nuvem: todos os testes passaram");
process.exit(falhas ? 1 : 0);
