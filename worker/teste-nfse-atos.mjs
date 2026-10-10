// O emissor de NFS-e ligado a Atos (worker/nfse/atos.js, o adaptador), sem rede:
//   node worker/teste-nfse-atos.mjs
//
//   1. a compra paga na Atos (cobranca/api.js, aplicarOrder) entra na fila uma vez e, com o "auto" ligado, a nota
//      sai sozinha com o tomador do perfil fiscal da Atos: o DO de verdade (node:sqlite), a Sefin simulada;
//   2. a entrega ao cliente da Atos (atos:nfse:nota:<cliente>:nfse-<id>, o XML, o PDF pelo Cron) e o e-mail pelo
//      Resend da Atos, com o PDF e o XML anexos;
//   3. o tomador incompleto (sem o codigo IBGE): o motivo fica no pagamento; o ajuste do painel completa SO a nota
//      (o perfil do cliente nao muda) e o botao emite;
//   4. o cancelamento avisa o cliente; a API do painel (prefixo /api/admin/nfse/) sem o emissor ligado;
//   5. sem o SEFIN_MTLS (o Worker de teste), a nota vai para a fila;
//   6. o mTLS: o auxiliar atos-nfse-mtls, o token cifrado e as chaves;
//   7. todas as chaves do KV com o prefixo atos:nfse: (nada de admin:* nem nfse:nota* do PAVLVS).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ClienteCobranca, cliente, idDoCliente, novaRef } from "./cobranca/cliente.js";
import { aplicarOrder, conferirPerfil } from "./cobranca/api.js";
import { EmissorNFSe, K_DEPOIS } from "./nfse/emissor.js";
import { atenderEmissor, depoisPendentes, PREFIXO } from "./nfse/api.js";
import { K, notasDoCliente, porNaFila, tomadorDoPerfil } from "./nfse/atos.js";
import { CODIGO_AUXILIAR, instalarMtls, SCRIPT_AUXILIAR } from "./nfse/mtls.js";
import { SefinSimulada } from "./nfse/sefin-simulada.js";
import { lerPfx } from "./nfse/pfx.js";
import { b64 } from "./nfse/assinatura.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIX = join(AQUI, "nfse", "fixtures");

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 1200)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------- o ambiente
const kv = new Map();
const gravacoes = new Map();
const CONTAS = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { gravacoes.set(k, (gravacoes.get(k) || 0) + 1); kv.set(k, v); },
  delete: async (k) => { kv.delete(k); },
  list: async ({ prefix }) => ({ list_complete: true, keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
};
const kvJson = (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null);

function storageMemoria() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
    async setAlarm() {},
  };
}
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

const objetos = new Map();
const CLIENTES = {
  idFromName: (n) => n,
  get(id) {
    if (!objetos.has(id)) objetos.set(id, new ClienteCobranca({ storage: storageMemoria() }, env));
    return { fetch: (url, op) => objetos.get(id).fetch(new Request(url, op)) };
  },
};
let instancia = null;
const nomesDoEmissor = new Set();
const EMISSOR_NFSE = {
  idFromName: (n) => { nomesDoEmissor.add(n); return n; },
  get: () => ({ fetch: (url, init) => instancia.fetch(new Request(url, init)) }),
};
const sim = new SefinSimulada("sucesso");
const env = {
  CONTAS, CLIENTES, EMISSOR_NFSE, NFSE_CHAVE_MESTRA: b64(crypto.getRandomValues(new Uint8Array(32))), SEFIN_MTLS: { fetch: sim.fetch },
  RESEND_API_KEY: "re_teste", CF_ACCOUNT_ID: "conta-cf",
};
instancia = new EmissorNFSe({ storage: storageSqlite() }, env);

// O Resend e a API da Cloudflare, simulados. Os eventos ao produto (o alarme do cliente) nao rodam aqui.
const emails = [];
const cf = [];
globalThis.fetch = async (url, op = {}) => {
  url = String(url);
  if (url === "https://api.resend.com/emails") {
    emails.push(JSON.parse(op.body));
    return new Response(JSON.stringify({ id: "em_" + emails.length }), { status: 200 });
  }
  if (url.startsWith("https://api.cloudflare.com/client/v4/")) {
    cf.push({ url, metodo: op.method || "GET" });
    if (url.endsWith("/mtls_certificates") && op.method === "POST") return new Response(JSON.stringify({ success: true, result: { id: "mtls-" + cf.length } }));
    return new Response(JSON.stringify({ success: true, result: {} }));
  }
  throw new Error("fetch inesperado: " + url);
};

const segundoPlano = [];
const ctx = { waitUntil: (p) => segundoPlano.push(p) };
const quem = { email: "dono@atos.dev.br", papel: "dono" };
async function api(metodo, caminho, corpo, e = env) {
  const req = new Request("https://atos.dev.br" + PREFIXO + caminho, { method: metodo,
    headers: { "content-type": "application/json" }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const r = await atenderEmissor(req, e, new URL(req.url), quem, { ctx });
  await Promise.all(segundoPlano.splice(0));
  const tipo = r.headers.get("content-type") || "";
  return { status: r.status, dados: tipo.includes("json") ? await r.json() : await r.text(), tipo };
}

/* Uma compra paga de verdade pela cobranca: registrada no objeto do cliente e aplicada como o aviso aplica. */
async function compraPaga(clienteId, preco, periodo, centavos, orderId) {
  const ref = novaRef(clienteId, "compra");
  await cliente(env, clienteId).pedir("registrar", { tipo: "compra", registro: { ref, produto: "pavlvs", preco, plano: preco.split(".")[1], periodo, centavos, forma: "pix", status: "aguardando" } });
  const order = { id: orderId, external_reference: ref, status: "processed", transactions: { payments: [{ payment_method: { id: "pix" } }] } };
  const c = await aplicarOrder(env, order, { ctx });
  await Promise.all(segundoPlano.splice(0));
  return { ref, order, compra: c };
}

const PRESTADOR = {
  documento: "11222333000181", razao_social: "Atos Tecnologia", inscricao_municipal: "7788990", municipio: "1501402",
  opcao_simples: "1", regime_especial: "0",
  servico: { ctribnac: "010301", nbs: "115062100", descricao: "Licença de uso de software", aliquota_iss_bp: 200 },
  retencoes: Object.fromEntries(["iss", "irrf", "pis", "cofins", "csll", "cp"].map((k) => [k, { quando: "nunca" }])),
  ibscbs: { enviar: true, cst: "000", cclasstrib: "000001", cindop: "100301", indfinal: "1" },
  total_tributos: { modo: "percentual", federal_bp: 1345, municipal_bp: 200 },
};

// ------------------------------------------------------------- 0. a API sem o emissor ligado
console.log("0. a API do painel sem o emissor ligado");
{
  const semEmissor = { CONTAS };
  let r = await api("GET", "situacao", undefined, semEmissor);
  checar(r.status === 503 && /EMISSOR_NFSE/.test(r.dados.erro), "sem o Durable Object: 503, dizendo o que falta", r.dados);
  r = await api("GET", "resumo", undefined, semEmissor);
  checar(r.status === 200 && r.dados.emissor.ligado === false && /EMISSOR_NFSE/.test(r.dados.emissor.falta) && Array.isArray(r.dados.pagamentos),
    "o resumo abre assim mesmo (o emissor desligado e dito)", r.dados.emissor);
  r = await api("GET", "situacao", undefined, { ...env, NFSE_CHAVE_MESTRA: "" });
  checar(r.status === 503 && /NFSE_CHAVE_MESTRA/.test(r.dados.erro), "sem a chave mestra: 503, com o comando", r.dados);
  r = await api("GET", "rota-que-nao-existe");
  checar(r.status === 404, "rota que nao existe: 404");
}

// ------------------------------------------------------------- 1. configurar
console.log("1. configurar (o prestador e o certificado do titular)");
const cert = lerPfx(readFileSync(join(FIX, "a1-cn.pfx")), "segredo-de-teste");
let r = await api("POST", "prestador", { prestador: PRESTADOR });
checar(r.status === 200 && r.dados.versao === 1 && r.dados.faltas.length === 0, "prestador gravado (versão 1)", r.dados);
r = await api("POST", "certificado", { certPem: cert.certPem, chavePkcs8: b64(cert.chavePkcs8), titular: cert.titular, documento: cert.documento });
checar(r.status === 200 && r.dados.certificado.instalado && r.dados.conexao.falta_token === true, "certificado guardado; sem o token da Cloudflare, a tela diz que falta", r.dados.conexao);
r = await api("POST", "testar");
checar(r.status === 200 && r.dados.municipio.situacao === "conveniado", "testar: convênio ativo", r.dados.etapas);
checar([...nomesDoEmissor].join() === "atos", "o Durable Object é o idFromName(\"atos\")", [...nomesDoEmissor]);
r = await api("POST", "config", { auto: true, email: true, mail: true });
checar(r.status === 200 && r.dados.config.auto && r.dados.config.email && r.dados.config.mail && kvJson(K(env).config).auto === true, "interruptores gravados em atos:nfse:config", r.dados);

// ------------------------------------------------------------- 2. a compra paga vira nota
console.log("2. a compra paga na Atos vira nota sozinha");
const cidA = await idDoCliente("sub-ana");
const perfilA = conferirPerfil({ documento: "529.982.247-25", nome: "Ana Advocacia", endereco: { cep: "66010-000", logradouro: "Rua dos Mundurucus", numero: "1500",
  bairro: "Batista Campos", cidade: "Belém", uf: "PA", ibge: "1501402" } }, "ana@escritorio.com.br");
await cliente(env, cidA, { sub: "sub-ana", email: "ana@escritorio.com.br" }).pedir("perfil_salvar", { perfil: perfilA });
checar(JSON.stringify(tomadorDoPerfil(perfilA)) === JSON.stringify({ nome: "Ana Advocacia", documento: "52998224725", email: "ana@escritorio.com.br", telefone: "",
  logradouro: "Rua dos Mundurucus", numero: "1500", complemento: "", bairro: "Batista Campos", cep: "66010000", cmun: "1501402", uf: "PA", inscricao_municipal: "" }),
  "o perfil fiscal da Atos vira o tomador (ibge -> cmun)", tomadorDoPerfil(perfilA));
const pA = await compraPaga(cidA, "pavlvs.escritorio.ano", "ano", 1149000, "ORD-A");
const pagA = kvJson(K(env).pag + pA.ref);
checar(pA.compra.status === "paga" && pagA && pagA.cliente === cidA && pagA.valor === 11490 && pagA.descricao === "PAVLVS Escritório · anual",
  "a compra paga entrou na fila (atos:nfse:pag:<ref>) com o cliente, o valor e a descrição do catálogo", pagA);
checar(pagA.nota === "emitida" && pagA.numero === "1" && pagA.nota_id === "nfse-1" && !pagA.motivo, "com o \"auto\" ligado, a nota saiu sozinha e marcou o pagamento", pagA);
checar(kvJson(K(env).clientes + cidA) && kvJson(K(env).clientes + cidA).nome === "Ana Advocacia", "o pagamento também põe o cliente no índice (atos:nfse:clientes:<cliente>)");
let notas = (await api("GET", "notas")).dados.notas;
const n1 = notas[0];
checar(notas.length === 1 && n1.estado === "emitida" && n1.conta === cidA && n1.pagamento === pA.ref && n1.centavos === 1149000 && n1.descricao === "PAVLVS Escritório · anual",
  "a nota: emitida, do cliente da Atos, com o pagamento, o valor e a descrição", n1);
const det = (await api("GET", "notas/" + n1.id)).dados;
checar(det.passos[0].quem === "automático" && det.passos.some((p) => p.quem === "Atos" && /entregue ao cliente/.test(p.detalhe)),
  "os passos: quem emitiu foi o automático; a entrega é da Atos", det.passos.map((p) => p.quem + ": " + p.detalhe));
// O mesmo aviso de novo (e a consulta da tela): nada se repete.
const gravacoesAntes = gravacoes.get(K(env).pag + pA.ref);
await aplicarOrder(env, pA.order, { ctx });
await Promise.all(segundoPlano.splice(0));
await porNaFila(env, { id: pA.ref, cliente: cidA, valor: 11490 });
notas = (await api("GET", "notas")).dados.notas;
checar(notas.length === 1 && gravacoes.get(K(env).pag + pA.ref) === gravacoesAntes && kvJson(K(env).pag + pA.ref).nota === "emitida",
  "o aviso repetido e a fila chamada de novo: uma nota só, o pagamento nem é regravado (não volta a pendente)", { n: notas.length, antes: gravacoesAntes, depois: gravacoes.get(K(env).pag + pA.ref) });

// ------------------------------------------------------------- 3. a entrega ao cliente e o e-mail
console.log("3. a entrega ao cliente da Atos, o PDF e o e-mail");
const baseA = cidA + ":nfse-" + n1.id;
const metaA = kvJson(K(env).nota + baseA);
checar(metaA && metaA.numero === "1" && metaA.valor === 11490 && metaA.pagamento === pA.ref && metaA.chave === n1.chave && metaA.tem_xml && !metaA.tem_pdf && metaA.cancelada === false,
  "a meta da nota para o cliente: atos:nfse:nota:<cliente>:nfse-<id>, com número, valor, pagamento e chave", metaA);
checar(Buffer.from(kv.get(K(env).notaXml + baseA), "base64").toString("utf8").includes(n1.chave), "o XML em atos:nfse:nota-xml:<cliente>:<id>");
checar(kvJson(K_DEPOIS(env)).some((x) => x.id === n1.id), "a nota espera o PDF na lista atos:nfse:depois (o Cron faz)");
checar(emails.length === 0, "o e-mail não sai no pedido que emite (o PDF ainda não existe)");
let feitas = await depoisPendentes(env, Date.now());
checar(feitas.feitas === 0, "o Cron espera 1 min (a tela pede antes)");
feitas = await depoisPendentes(env, Date.now() + 2 * 60000);
const metaComPdf = kvJson(K(env).nota + baseA);
checar(feitas.feitas === 1 && Buffer.from(kv.get(K(env).pdf + n1.id), "base64").subarray(0, 5).toString() === "%PDF-" && metaComPdf.tem_pdf === true
  && kv.get(K(env).notaPdf + baseA) === kv.get(K(env).pdf + n1.id), "o Cron fez o DANFSe: atos:nfse:pdf:<id> e atos:nfse:nota-pdf:<cliente>:<id>, a meta diz tem_pdf");
const em = emails[0] || {};
checar(emails.length === 1 && em.to[0] === "ana@escritorio.com.br" && /naoresponda@atos\.dev\.br/.test(em.from) && /— Atos$/.test(em.subject)
  && em.attachments.length === 2 && em.attachments[0].filename === "NFS-e 1.pdf" && em.attachments[1].filename === "NFS-e 1.xml"
  && Buffer.from(em.attachments[0].content, "base64").subarray(0, 5).toString() === "%PDF-" && /pagamento na Atos/.test(em.text),
  "o e-mail pelo Resend da Atos, ao e-mail dos dados fiscais, com o PDF e o XML anexos", { to: em.to, from: em.from, subject: em.subject, n: (em.attachments || []).length });
checar(!/PAVLVS|PAULUS/.test(em.subject) && !/paulus\.ia\.br/.test(em.html || ""), "o e-mail é da Atos (nada do PAVLVS no assunto nem no endereço)");
r = await api("GET", "notas/" + n1.id + "/pdf");
checar(r.status === 200 && r.tipo === "application/pdf", "GET notas/:id/pdf devolve o DANFSe guardado");
const doCliente = await notasDoCliente(env, cidA);
checar(doCliente.length === 1 && doCliente[0].numero === "1" && doCliente[0].tem_pdf, "notasDoCliente: o que a Minha conta mostraria", doCliente);

// ------------------------------------------------------------- 4. o tomador incompleto
console.log("4. o tomador sem o código IBGE e o ajuste do painel");
const cidB = await idDoCliente("sub-bia");
const perfilB = conferirPerfil({ documento: "11.222.333/0001-81", nome: "Escritório Bia Ltda", endereco: { cep: "68380-000", logradouro: "Av. Paraná", numero: "10",
  bairro: "Centro", cidade: "São Félix do Xingu", uf: "PA" } }, "bia@x.com.br");
await cliente(env, cidB, { sub: "sub-bia", email: "bia@x.com.br" }).pedir("perfil_salvar", { perfil: perfilB });
const pB = await compraPaga(cidB, "pavlvs.advogado.recarga", "avulso", 5000, "ORD-B");
const pagB = kvJson(K(env).pag + pB.ref);
checar(pagB.nota === "pendente" && /falta município \(código IBGE\)/.test(pagB.motivo), "sem o código IBGE: a nota não sai, e o motivo fica no pagamento", pagB);
r = await api("GET", "clientes");
const cliB = r.dados.clientes.find((c) => c.id === cidB);
checar(r.status === 200 && r.dados.clientes.length === 2 && cliB && cliB.faltas.join() === "município (código IBGE)" && cliB.tem_perfil,
  "GET clientes: os dois clientes do índice, com o que falta", r.dados.clientes.map((c) => [c.nome, c.faltas]));
r = await api("POST", "clientes/" + cidB, { tomador: { cmun: "15073" } });
checar(r.status === 400 && /7 dígitos/.test(r.dados.erro), "o código do município com menos de 7 dígitos é recusado");
r = await api("POST", "clientes/" + "e".repeat(32), { tomador: { cmun: "1507300" } });
checar(r.status === 404, "cliente que não existe na Atos: 404");
r = await api("POST", "clientes/" + cidB, { tomador: { cmun: "1507300" } });
checar(r.status === 200 && r.dados.faltas.length === 0 && r.dados.ajustado && r.dados.tomador.cmun === "1507300", "o ajuste completa o tomador", r.dados);
const perfilDepois = (await cliente(env, cidB).pedir("perfil_ler")).perfil;
checar(perfilDepois.endereco.ibge === "" && kvJson(K(env).tomador + cidB).cmun === "1507300", "o perfil fiscal do cliente NÃO muda: o ajuste fica só para a nota (atos:nfse:tomador:<cliente>)", perfilDepois.endereco);
r = await api("GET", "pagamentos");
checar(r.status === 200 && r.dados.pagamentos.some((p) => p.id === pB.ref && p.nota === "pendente" && p.nome === "Escritório Bia Ltda"), "GET pagamentos: a recarga pendente, com o nome do cliente", r.dados.pagamentos);
r = await api("POST", "pagamentos/" + pB.ref + "/emitir");
checar(r.status === 200 && r.dados.estado === "emitida" && r.dados.conta === cidB && r.dados.centavos === 5000 && kvJson(K(env).pag + pB.ref).nota === "emitida",
  "o botão emite a nota da fila com o tomador ajustado", r.dados);
const dpsB = instancia.obter(r.dados.id).xml_dps;
checar(dpsB.includes("<cMun>1507300</cMun>") && dpsB.includes("<CNPJ>11222333000181</CNPJ>"), "a DPS leva o município do ajuste e o CNPJ do tomador");
r = await api("POST", "pagamentos/" + pB.ref + "/emitir");
checar(r.status === 409 && /já tem nota/.test(r.dados.erro), "o mesmo pagamento não gera segunda nota (409)", r.dados);

// ------------------------------------------------------------- 5. cancelar
console.log("5. o cancelamento avisa o cliente");
emails.length = 0;
r = await api("POST", "notas/" + n1.id + "/cancelar", { motivo: "1", texto: "Erro na emissão: valor errado na nota" });
const metaCanc = kvJson(K(env).nota + baseA);
checar(r.status === 200 && r.dados.nota.estado === "cancelada" && metaCanc.cancelada === true && kvJson(K(env).pag + pA.ref).nota === "cancelada",
  "cancelada: a meta do cliente diz cancelada e o pagamento fica \"cancelada\"", metaCanc);
checar(emails.length === 1 && /cancelada — Atos$/.test(emails[0].subject) && emails[0].to[0] === "ana@escritorio.com.br" && /pagamento na Atos foi cancelada/.test(emails[0].text),
  "o aviso de cancelamento vai por e-mail, da Atos", emails.map((e) => e.subject));
r = await api("GET", "resumo");
checar(r.status === 200 && r.dados.emissor.ligado && r.dados.notas.length === 2 && r.dados.pagamentos.length === 0, "GET resumo: o emissor ligado, as duas notas e nenhum pagamento sem nota", { e: r.dados.emissor, n: r.dados.notas.length, p: r.dados.pagamentos });

// ------------------------------------------------------------- 6. sem o SEFIN_MTLS
console.log("6. sem o SEFIN_MTLS (o Worker de teste): a nota vai para a fila");
delete env.SEFIN_MTLS;
r = await api("POST", "notas", { conta: cidA, tomador: tomadorDoPerfil(perfilA), valor: 10, descricao: "Teste sem conexão" });
checar(r.status === 200 && r.dados.estado === "na_fila" && /SEFIN_MTLS/.test(r.dados.erro), "sem o service binding, a nota fica na fila (sem quebrar)", { estado: r.dados.estado, erro: r.dados.erro });
env.SEFIN_MTLS = { fetch: sim.fetch };
r = await api("POST", "notas/" + r.dados.id + "/tentar");
checar(r.dados.estado === "emitida", "com o binding de volta, tentar emite");
r = await api("POST", "notas", { conta: "c".repeat(24), tomador: tomadorDoPerfil(perfilA), valor: 10, descricao: "x" });
checar(r.status === 400 && /cliente inválido/.test(r.dados.erro), "conta com o id do PAVLVS (24 hex) é recusada: o cliente é o da Atos (32 hex)", r.dados);

// ------------------------------------------------------------- 7. mTLS
console.log("7. o mTLS: o auxiliar atos-nfse-mtls");
checar(SCRIPT_AUXILIAR === "atos-nfse-mtls", "o script do auxiliar é atos-nfse-mtls");
checar(CODIGO_AUXILIAR === readFileSync(join(AQUI, "..", "nfse-mtls", "index.js"), "utf8").replace(/\r\n/g, "\n"), "CODIGO_AUXILIAR é o texto de nfse-mtls/index.js");
r = await api("POST", "cloudflare", { token: "x".repeat(40) });
const tokenGuardado = kv.get(K(env).cfToken) || "";
checar(r.status === 200 && r.dados.cloudflare.token && tokenGuardado.startsWith("v1.") && !tokenGuardado.includes("x".repeat(20)), "o token fica cifrado em atos:nfse:cf:token", r.dados.cloudflare);
checar(r.dados.conexao && r.dados.conexao.ok && cf.some((c) => c.metodo === "PUT" && c.url.endsWith("/accounts/conta-cf/workers/scripts/atos-nfse-mtls")),
  "com o token, o certificado guardado vai para a Cloudflare e o auxiliar atos-nfse-mtls é republicado", { conexao: r.dados.conexao, cf });
checar(kvJson(K(env).cfMtls) && kvJson(K(env).cfMtls).script === "atos-nfse-mtls" && kvJson(K(env).cfMtls).documento === "11222333000181", "o mTLS em uso fica em atos:nfse:cf:mtls", kvJson(K(env).cfMtls));
const inst = await instalarMtls(env, { certPem: cert.certPem, chavePkcs8: b64(cert.chavePkcs8), documento: cert.documento, validoAte: cert.validoAte });
checar(inst.ok && cf.some((c) => c.metodo === "DELETE"), "trocar o certificado tira o mTLS anterior da Cloudflare", inst);
{
  const antes = cf.length;
  const t = await instalarMtls({ ...env, AMBIENTE: "teste" }, { certPem: cert.certPem, chavePkcs8: b64(cert.chavePkcs8), documento: cert.documento });
  checar(!t.ok && cf.length === antes, "no Worker de teste, o painel nunca republica o auxiliar (que é o de produção)", t);
}

// ------------------------------------------------------------- 8. as chaves
console.log("8. as chaves do KV");
{
  // O Worker de teste usa o MESMO KV da producao: as chaves dele levam outro prefixo.
  const kvTeste = new Map();
  const envTeste = { AMBIENTE: "teste", CONTAS: { get: async (k) => kvTeste.get(k) ?? null, put: async (k, v) => { kvTeste.set(k, v); } } };
  const q = await porNaFila(envTeste, { id: "ref-de-teste", cliente: cidA, valor: 1 });
  checar(q.ok && [...kvTeste.keys()].join() === "atos-teste:nfse:pag:ref-de-teste" && K(envTeste).config === "atos-teste:nfse:config" && K(envTeste).cfToken === "atos-teste:nfse:cf:token",
    "no Worker de teste (AMBIENTE teste), as chaves são atos-teste:nfse:* (a fila e o token de teste não se misturam com os de produção)", [...kvTeste.keys()]);
}
const fora = [...kv.keys()].filter((k) => !k.startsWith("atos:nfse:"));
checar(fora.length === 0, "todas as chaves que o emissor gravou começam com atos:nfse:", fora);
checar(![...kv.keys()].some((k) => k.startsWith("admin:") || k.startsWith("nfse:")), "nenhuma chave admin:* nem nfse:* (as do PAVLVS no mesmo namespace)");
console.log("  chaves: " + [...new Set([...kv.keys()].map((k) => k.split(":").slice(0, 3).join(":")))].sort().join(", "));

console.log(falhas ? `\n  emissor na Atos: ${falhas} FALHA(S)` : "\n  emissor na Atos: todos os testes passaram");
process.exit(falhas ? 1 : 0);
