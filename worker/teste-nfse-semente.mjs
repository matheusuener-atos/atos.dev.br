// Os dados de exemplo do Worker de teste (worker/nfse/semente.js) e a Sefin simulada do Worker de teste
// (emissor.js, simulada()), sem rede:
//   node worker/teste-nfse-semente.mjs
//
//   1. em produção (sem AMBIENTE "teste") nada muda: as rotas teste/* dão 404, a Sefin simulada nunca entra (sem o
//      SEFIN_MTLS a nota vai para a fila, como antes) e a ação "simular" do DO é recusada;
//   2. no teste COM o SEFIN_MTLS, a conexão é a de verdade e a semeadura recusa;
//   3. no teste sem o SEFIN_MTLS: a Sefin simulada; só o dono semeia; as quatro etapas; os estados das notas, os
//      pagamentos sem nota, os clientes (um com falta) e o PDF;
//   4. semear de novo não duplica nada;
//   5. nenhum e-mail sai (nem com a RESEND_API_KEY): só fica anotado; e @exemplo.test é recusado em qualquer lugar;
//   6. o DO despejado volta com a Sefin simulada guardada (o cancelamento acha a nota de antes);
//   7. a nota segurada na fila: o alarme e o "Processar a fila" não a soltam; o Tentar de novo de uma pessoa, sim;
//   8. todas as chaves do KV são atos-teste:nfse:*; limpar e semear de novo (tudo de uma vez).
import { DatabaseSync } from "node:sqlite";

import { ClienteCobranca } from "./cobranca/cliente.js";
import { EmissorNFSe } from "./nfse/emissor.js";
import { atenderEmissor, PREFIXO } from "./nfse/api.js";
import { MARCA_EMAIL_DE_TESTE } from "./nfse/atos.js";
import { enderecoDeTeste, enviarEmail } from "./email.js";
import { SefinSimulada } from "./nfse/sefin-simulada.js";
import { b64 } from "./nfse/assinatura.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 1200)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------- o ambiente
function kvMemoria() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix }) => ({ list_complete: true, keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
}

function storageMemoria() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
    async setAlarm() {},
  };
}

/* O storage do DO: o SQL (node:sqlite) e o chave-valor (a Sefin simulada guarda nele), como no SQLite da Cloudflare. */
function storageDoEmissor() {
  const db = new DatabaseSync(":memory:");
  const kv = new Map();
  let alarme = null;
  return {
    db, kv,
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
    async get(k) { return kv.has(k) ? structuredClone(kv.get(k)) : undefined; },
    async put(k, v) { kv.set(k, structuredClone(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) kv.delete(x); },
    async list({ prefix = "" } = {}) { return new Map([...kv].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); },
    getAlarm: async () => alarme,
    setAlarm: async (t) => { alarme = Number(t); },
    deleteAlarm: async () => { alarme = null; },
  };
}

/* Um Worker inteiro (KV, clientes da cobranca, o DO do emissor), com as vars dadas. */
function montar(vars = {}) {
  const CONTAS = kvMemoria();
  const objetos = new Map();
  const env = { CONTAS, NFSE_CHAVE_MESTRA: b64(crypto.getRandomValues(new Uint8Array(32))), RESEND_API_KEY: "re_teste", ...vars };
  env.CLIENTES = {
    idFromName: (n) => n,
    get(id) {
      if (!objetos.has(id)) objetos.set(id, new ClienteCobranca({ storage: storageMemoria() }, env));
      return { fetch: (url, op) => objetos.get(id).fetch(new Request(url, op)) };
    },
  };
  const storage = storageDoEmissor();
  const mundo = { env, storage, instancia: null };
  mundo.instancia = new EmissorNFSe({ storage }, env);
  env.EMISSOR_NFSE = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => mundo.instancia.fetch(new Request(url, init)) }) };
  return mundo;
}

// Nenhum pedido sai para a rede: o Resend (ou qualquer outro) seria um e-mail de verdade.
const saidas = [];
globalThis.fetch = async (url) => {
  saidas.push(String(url));
  throw new Error("fetch inesperado: " + url);
};

const DONO = { email: "matheusueners@hotmail.com", papel: "dono" };
async function api(mundo, metodo, caminho, corpo, quem = DONO) {
  const espera = [];
  const req = new Request("https://atos-teste.exemplo.workers.dev" + PREFIXO + caminho, { method: metodo,
    headers: { "content-type": "application/json" }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const r = await atenderEmissor(req, mundo.env, new URL(req.url), quem, { ctx: { waitUntil: (p) => espera.push(p) } });
  await Promise.all(espera);
  const tipo = r.headers.get("content-type") || "";
  return { status: r.status, dados: tipo.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer()), tipo };
}
async function semearTudo(mundo) {
  const passos = [];
  const pdf = [];
  for (let i = 0; i < 8; i++) {
    const r = await api(mundo, "POST", "teste/semear", {});
    passos.push(r);
    if (r.status !== 200) break;
    pdf.push(...(r.dados.pdf || []));
    if (r.dados.pronto) break;
  }
  for (const id of pdf) await api(mundo, "POST", "notas/" + id + "/depois", {});
  return { passos, pdf };
}
const contar = (notas) => notas.reduce((c, n) => ({ ...c, [n.estado]: (c[n.estado] || 0) + 1 }), {});

// ------------------------------------------------------------- 1. produção
console.log("1. em produção nada muda");
{
  const prod = montar({});
  let r = await api(prod, "POST", "teste/semear", {});
  checar(r.status === 404, "POST teste/semear em produção: 404", r);
  r = await api(prod, "POST", "teste/limpar", {});
  checar(r.status === 404, "POST teste/limpar em produção: 404", r);
  r = await api(prod, "GET", "resumo");
  checar(r.status === 200 && r.dados.teste === false, "o resumo diz que não é o Worker de teste", r.dados.teste);
  r = await api(prod, "GET", "situacao");
  checar(r.status === 200 && r.dados.sefin === "", "sem o SEFIN_MTLS, produção fica sem conexão (nunca a simulada)", r.dados.sefin);
  checar(prod.instancia.simulada() === null && prod.instancia.modoSefin() === "", "simulada() é null sem AMBIENTE teste");
  const s = await prod.instancia.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ acao: "simular", dados: { modos: ["sucesso"] } }) }));
  checar(s.status === 404, "a ação simular do DO é recusada em produção", s.status);
  const z = await prod.instancia.fetch(new Request("https://x/", { method: "POST", body: JSON.stringify({ acao: "zerar_teste", dados: {} }) }));
  checar(z.status === 404, "a ação zerar_teste do DO é recusada em produção", z.status);
  const outroAmbiente = montar({ AMBIENTE: "producao" });
  checar(outroAmbiente.instancia.simulada() === null, "AMBIENTE diferente de \"teste\": nunca a simulada");
}

// ------------------------------------------------------------- 2. teste com o SEFIN_MTLS
console.log("2. no teste com o SEFIN_MTLS, a conexão de verdade");
{
  const sim = new SefinSimulada("sucesso");
  const comMtls = montar({ AMBIENTE: "teste", SEFIN_MTLS: { fetch: sim.fetch } });
  const r = await api(comMtls, "GET", "situacao");
  checar(r.dados.sefin === "mtls" && comMtls.instancia.simulada() === null, "com o binding, o teste usa o mTLS (não a simulada)", r.dados.sefin);
  const s = await api(comMtls, "POST", "teste/semear", {});
  checar(s.status === 409 && /Sefin simulada/.test(s.dados.erro), "a semeadura recusa sem a Sefin simulada (409)", s.dados);
}

// ------------------------------------------------------------- 3. semear
console.log("3. no Worker de teste: a Sefin simulada e os dados de exemplo");
const T = montar({ AMBIENTE: "teste" });
let r = await api(T, "GET", "resumo");
checar(r.status === 200 && r.dados.teste === true, "o resumo diz que é o Worker de teste");
r = await api(T, "GET", "situacao");
checar(r.dados.sefin === "simulada", "situacao.sefin = simulada (o painel mostra \"Sefin simulada (teste)\")", r.dados.sefin);
r = await api(T, "POST", "teste/semear", {}, { email: "suporte@atos.dev.br", papel: "suporte" });
checar(r.status === 403, "o suporte não semeia (403)");
r = await api(T, "POST", "teste/semear", {}, { email: "fin@atos.dev.br", papel: "financeiro" });
checar(r.status === 403, "o financeiro não semeia (403): só o dono");
r = await api({ env: { ...T.env, NFSE_CHAVE_MESTRA: "" } }, "POST", "teste/semear", {});
checar(r.status === 503 && /NFSE_CHAVE_MESTRA --env teste/.test(r.dados.erro), "sem a chave mestra: 503 com o comando do --env teste", r.dados);
const { passos, pdf } = await semearTudo(T);
checar(passos.length === 4 && passos.every((p) => p.status === 200) && passos.map((p) => p.dados.etapa).join() === "base,clientes,notas,eventos" && passos[3].dados.pronto,
  "quatro etapas, uma por pedido, até pronto", passos.map((p) => [p.status, p.dados.etapa, p.dados.erro]));
checar(pdf.length === 3, "três notas esperando o PDF (duas emitidas e a substituta)", pdf);
r = await api(T, "GET", "resumo");
const notas = r.dados.notas;
const est = contar(notas);
checar(est.emitida === 3 && est.cancelada === 1 && est.substituida === 1 && est.rejeitada === 1 && est.na_fila === 1 && notas.length === 7,
  "notas: 3 emitidas, 1 cancelada, 1 substituída, 1 rejeitada, 1 na fila", est);
checar(r.dados.situacao.pode_emitir === true && r.dados.situacao.certificado.instalado && r.dados.situacao.prestador.dados.documento === "11222333000181"
  && r.dados.situacao.municipio.situacao === "conveniado", "prestador, certificado de teste e convênio (Belém) prontos", r.dados.situacao.motivos);
const cert = T.storage.db.prepare("SELECT * FROM certificado WHERE ativo = 1").get();
checar(cert && cert.chave_cifrada.startsWith("v1.") && !cert.chave_cifrada.includes("BEGIN"), "o certificado de teste ficou cifrado com a NFSE_CHAVE_MESTRA");
checar(r.dados.pagamentos.length === 4 && r.dados.pagamentos.every((x) => /^semente-pag-[6-9]$/.test(x.id)), "4 pagamentos sem nota (6 a 9)", r.dados.pagamentos.map((x) => x.id));
const rej = notas.find((n) => n.estado === "rejeitada");
checar(rej && rej.rejeicao[0].codigo === "E0595", "a rejeitada traz o código da Sefin (E0595)", rej && rej.rejeicao);
const subst = notas.find((n) => n.estado === "substituida");
checar(subst && notas.some((n) => n.id === subst.substituida_por_id && n.estado === "emitida"), "a substituída aponta para a substituta emitida");
checar(notas.filter((n) => n.estado === "emitida").every((n) => n.tem_pdf), "as emitidas têm o PDF (POST notas/:id/depois)", notas.map((n) => [n.id, n.estado, n.tem_pdf]));
const emitida = notas.find((n) => n.estado === "emitida");
const pdfR = await api(T, "GET", "notas/" + emitida.id + "/pdf?baixar=1");
checar(pdfR.status === 200 && pdfR.tipo === "application/pdf" && new TextDecoder().decode(pdfR.dados.slice(0, 5)) === "%PDF-", "o PDF baixa (application/pdf)");
const pdfC = await api(T, "GET", "notas/" + notas.find((n) => n.estado === "cancelada").id + "/pdf");
checar(pdfC.status === 200 && pdfC.tipo === "application/pdf", "o PDF da cancelada também sai");
r = await api(T, "GET", "clientes");
const cls = r.dados.clientes;
checar(cls.length === 6 && cls.filter((c) => c.faltas.length).length === 1 && cls.find((c) => c.faltas.length).faltas.join() === "bairro,município (código IBGE)"
  && cls.every((c) => c.email.endsWith(".exemplo.test") || c.email.endsWith("@exemplo.test")), "6 clientes, um com bairro e IBGE faltando, todos @exemplo.test", cls.map((c) => [c.nome, c.faltas, c.email]));
checar(cls.some((c) => c.documento.length === 11) && cls.some((c) => c.documento.length === 14), "pessoa física e jurídica");
r = await api(T, "POST", "pagamentos/semente-pag-8/emitir", {});
checar(r.status === 409 && /bairro/.test(r.dados.erro), "o pagamento do cliente sem bairro não emite e diz o que falta", r.dados);

// ------------------------------------------------------------- 4. de novo
console.log("4. semear de novo não duplica");
r = await api(T, "POST", "teste/semear", {});
checar(r.status === 200 && r.dados.ja && r.dados.pronto, "de novo: \"já estão carregados\"", r.dados);
r = await api(T, "POST", "teste/semear", { tudo: true });
checar(r.status === 200 && r.dados.ja, "de novo com tudo: o mesmo");
checar((await api(T, "GET", "notas")).dados.notas.length === 7 && (await api(T, "GET", "clientes")).dados.clientes.length === 6, "as mesmas 7 notas e 6 clientes");
// Uma etapa refeita por cima (a marca apagada) acha o que já existe e não duplica.
await T.env.CONTAS.delete("atos-teste:nfse:semente");
const refeito = await semearTudo(T);
checar(refeito.passos.every((p) => p.status === 200) && refeito.pdf.length === 0, "sem a marca, as etapas refeitas não emitem nada de novo", refeito.passos.map((p) => p.dados.feito));
r = await api(T, "GET", "resumo");
checar(r.dados.notas.length === 7 && r.dados.pagamentos.length === 4, "continuam 7 notas e 4 pagamentos sem nota", contar(r.dados.notas));

// ------------------------------------------------------------- 5. e-mail
console.log("5. nenhum e-mail sai");
r = await api(T, "POST", "notas/" + emitida.id + "/enviar", {});
checar(r.status === 200 && r.dados.email === MARCA_EMAIL_DE_TESTE, "Enviar ao cliente no teste: \"" + MARCA_EMAIL_DE_TESTE + "\"", r.dados.email);
const anotados = JSON.parse(T.env.CONTAS.m.get("atos-teste:nfse:emails") || "[]");
checar(anotados.length >= 3 && anotados.every((e) => /exemplo\.test$/.test(e.para)), "os e-mails ficam só anotados (atos-teste:nfse:emails), todos @exemplo.test", anotados.length);
checar(notas.filter((n) => n.estado === "emitida").every((n) => n.email === MARCA_EMAIL_DE_TESTE), "o e-mail de cada nota emitida diz que não saiu", notas.map((n) => n.email));
checar(saidas.length === 0, "nenhum pedido à rede (nem ao Resend), com a RESEND_API_KEY presente", saidas);
const direto = await enviarEmail({ RESEND_API_KEY: "re_x" }, { para: "ana.ribeiro@exemplo.test", assunto: "x", titulo: "x", texto: "x" });
checar(!direto.ok && saidas.length === 0, "email.js recusa @exemplo.test em qualquer ambiente, sem chamar o Resend", direto);
checar(enderecoDeTeste("a@b.example.com") && enderecoDeTeste("x@y.invalid") && enderecoDeTeste("x@localhost") && !enderecoDeTeste("matheusueners@hotmail.com") && !enderecoDeTeste("a@teste.com.br"),
  "domínios reservados reconhecidos (e os de verdade, não)");

// ------------------------------------------------------------- 6. o DO despejado
console.log("6. o DO despejado volta com a Sefin simulada guardada");
T.instancia = new EmissorNFSe({ storage: T.storage }, T.env);
r = await api(T, "POST", "notas/" + emitida.id + "/cancelar", { motivo: "1", texto: "Cancelada depois de o objeto ser despejado (teste)" });
checar(r.status === 200 && r.dados.nota.estado === "cancelada", "uma instância nova do DO cancela a nota emitida antes (a Sefin simulada achou a NFS-e)", r.dados);
r = await api(T, "POST", "notas/" + emitida.id + "/situacao", {});
checar(r.status === 200 && r.dados.estado === "cancelada", "consultar a situação acha o evento guardado", r.dados.estado);

// ------------------------------------------------------------- 7. a nota segurada
console.log("7. a nota na fila");
const fila = (await api(T, "GET", "notas")).dados.notas.find((n) => n.estado === "na_fila");
r = await api(T, "POST", "fila", {});
checar((await api(T, "GET", "notas/" + fila.id)).dados.nota.estado === "na_fila", "Processar a fila não solta a nota segurada");
await T.instancia.alarm();
checar((await api(T, "GET", "notas/" + fila.id)).dados.nota.estado === "na_fila", "o alarme também não");
r = await api(T, "POST", "notas/" + fila.id + "/tentar", {});
checar(r.status === 200 && r.dados.estado === "emitida", "Tentar de novo (uma pessoa) emite", r.dados);

// ------------------------------------------------------------- 8. chaves, limpar e semear de novo
console.log("8. as chaves, limpar e semear de novo");
const fora = [...T.env.CONTAS.m.keys()].filter((k) => !k.startsWith("atos-teste:nfse:"));
checar(fora.length === 0, "todas as chaves do KV são atos-teste:nfse:* (nada de atos:nfse:*, a produção)", fora);
// Um pagamento de teste de verdade (do checkout de teste) na fila: o limpar devolve para pendente, sem apagar.
await T.env.CONTAS.put("atos-teste:nfse:pag:atos-real-1", JSON.stringify({ id: "atos-real-1", cliente: "e".repeat(32), valor: 10, nota: "emitida", numero: "9", nota_id: "nfse-9" }));
r = await api(T, "POST", "teste/limpar", {}, { email: "fin@atos.dev.br", papel: "financeiro" });
checar(r.status === 403, "limpar também é só do dono");
r = await api(T, "POST", "teste/limpar", {});
checar(r.status === 200 && r.dados.ok, "limpar", r.dados);
r = await api(T, "GET", "resumo");
checar(r.dados.notas.length === 0 && r.dados.situacao.certificado.instalado === false && r.dados.situacao.proximo_numero === 1, "o emissor de teste zerado (sem notas, sem certificado, numeração do 1)");
const sobrou = [...T.env.CONTAS.m.keys()];
checar(sobrou.join() === "atos-teste:nfse:config,atos-teste:nfse:pag:atos-real-1" && JSON.parse(T.env.CONTAS.m.get("atos-teste:nfse:pag:atos-real-1")).nota === "pendente",
  "no KV só ficam os interruptores e o pagamento de verdade, de volta a pendente", sobrou);
checar(![...T.storage.kv.keys()].some((k) => k.startsWith("sim:g:")), "a Sefin simulada esqueceu as notas");
await T.env.CONTAS.delete("atos-teste:nfse:pag:atos-real-1");
r = await api(T, "POST", "teste/semear", { tudo: true });
checar(r.status === 200 && r.dados.pronto && r.dados.pdf.length === 3, "semear de novo com tudo: as quatro etapas num pedido", r.dados);
const est2 = contar((await api(T, "GET", "notas")).dados.notas);
checar(est2.emitida === 3 && est2.cancelada === 1 && est2.substituida === 1 && est2.rejeitada === 1 && est2.na_fila === 1, "os mesmos estados depois de limpar", est2);
checar(saidas.length === 0, "e nenhum pedido à rede em todo o teste", saidas);

// ------------------------------------------------------------- 9. a equipe do painel de teste
console.log("9. a equipe do painel de teste (wrangler.jsonc)");
{
  const { readFileSync } = await import("node:fs");
  const { equipeDaSemente: equipe } = await import("./admin.js");
  // JSONC: tira os comentarios fora das strings e as virgulas antes de } ou ].
  const bruto = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  let limpo = "";
  for (let i = 0, str = false; i < bruto.length; i++) {
    const c = bruto[i];
    if (str) { limpo += c; if (c === "\\") limpo += bruto[++i]; else if (c === "\"") str = false; continue; }
    if (c === "\"") { str = true; limpo += c; continue; }
    if (c === "/" && bruto[i + 1] === "/") { while (i < bruto.length && bruto[i] !== "\n") i++; limpo += "\n"; continue; }
    limpo += c;
  }
  const w = JSON.parse(limpo.replace(/,(\s*[}\]])/g, "$1"));
  const eq = equipe({ ATOS_EQUIPE: w.env.teste.vars.ATOS_EQUIPE });
  checar(eq.length === 3 && eq.every((x) => x.papel === "dono") && eq.map((x) => x.email).sort().join() === "arcaderetrorama@gmail.com,matheusuener.atos@gmail.com,matheusueners@hotmail.com",
    "env.teste: ATOS_EQUIPE com as três Contas Atos do dono, papel dono", eq);
  checar(!("ATOS_EQUIPE" in (w.vars || {})) && w.env.teste.vars.AMBIENTE === "teste" && !("AMBIENTE" in (w.vars || {})),
    "a produção não recebe ATOS_EQUIPE nem AMBIENTE pelo wrangler.jsonc");
  checar(!w.env.teste.services, "o teste continua sem o SEFIN_MTLS (por isso, a Sefin simulada)");
}

console.log(falhas ? `\n  dados de exemplo: ${falhas} FALHA(S)` : "\n  dados de exemplo: todos os testes passaram");
process.exit(falhas ? 1 : 0);
