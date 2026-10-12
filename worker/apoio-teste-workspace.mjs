// Para os testes dos recursos do Atos Workspace (formularios, avisos, entradas, status): o ambiente falso inteiro (o KV,
// os Durable Objects na memoria - o do cliente, o do e-mail Atos, o da seguranca e o WorkspaceDados -, o Resend e a
// rede capturados), as sessoes e os atalhos de sempre (ativar o Workspace, criar o alias confirmado e ligado).
import worker from "./index.js";
import { comSeguranca, ligarSegundaEtapa } from "./apoio-teste-seguranca.mjs";
import { sha256 } from "./comum.js";
import { ClienteCobranca, idDoCliente } from "./cobranca/cliente.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { EmailAtos } from "./email-atos.js";
import { WorkspaceDados } from "./workspace-dados.js";

export const A = "https://atos.dev.br";
export let falhas = 0;
export const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};
export function fim() {
  console.log(falhas ? "\n" + falhas + " FALHA(S)" : "\ntudo certo");
  process.exit(falhas ? 1 : 0);
}

export const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
  list: async ({ prefix = "" } = {}) => ({ keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};

/* O storage de um Durable Object (a API de chave e valor), com o alarme anotado. */
export function storage() {
  const m = new Map();
  const s = {
    m, alarme: null,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { let n = 0; for (const x of Array.isArray(k) ? k : [k]) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = "", reverse = false, limit, start, end } = {}) {
      let l = [...m].filter(([k]) => k.startsWith(prefix) && (start === undefined || k >= start) && (end === undefined || k < end)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (reverse) l.reverse();
      if (limit) l = l.slice(0, limit);
      return new Map(l.map(([k, v]) => [k, structuredClone(v)]));
    },
    async setAlarm(t) { s.alarme = t; }, async getAlarm() { return s.alarme; }, async deleteAlarm() { s.alarme = null; },
  };
  return s;
}

// A rede: o Resend (capturado), e o resto pelo `rede` que cada teste troca (os avisos, o status, o Turnstile).
export const enviados = [];
export const rede = { fn: null, chamadas: [] };
export let resendFalha = false;
export const resendFalhar = (v) => { resendFalha = v; };
globalThis.fetch = async (u, op = {}) => {
  const url = String(u instanceof Request ? u.url : u);
  if (url.startsWith("https://api.resend.com/")) {
    if (resendFalha) return new Response("{}", { status: 500 });
    enviados.push(JSON.parse(op.body));
    return new Response("{}", { status: 200 });
  }
  rede.chamadas.push({ url, op });
  if (rede.fn) return rede.fn(url, op);
  throw new Error("fetch inesperado: " + url);
};

const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };

export function novoEnv(extra = {}) {
  const objetos = new Map();
  const env = {
    CONTAS, ATOS_CHAVE: JSON.stringify(jwk), RESEND_API_KEY: "re_teste", CF_ACCOUNT_ID: "conta-cf", AMBIENTE: "teste", EMAIL_CF_SIMULADA: "1",
    ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }, { email: "sup@atos.dev.br", nome: "Sup", papel: "suporte" },
      { email: "fin@atos.dev.br", nome: "Fin", papel: "financeiro" }]),
    ASSETS: { fetch: async (req) => new Response("<p>pagina " + new URL(req.url).pathname + "</p>", { headers: { "content-type": "text/html" } }) },
    ...extra,
  };
  const ns = (Classe) => ({ idFromName: (n) => n, get(id) {
    if (!objetos.has(Classe.name + id)) objetos.set(Classe.name + id, new Classe({ storage: storage() }, env));
    const o = objetos.get(Classe.name + id);
    return { fetch: (url, op) => o.fetch(new Request(url, op)), o };
  } });
  env.CLIENTES = ns(ClienteCobranca);
  env.EMAIL_ATOS = ns(EmailAtos);
  env.WS_DADOS = ns(WorkspaceDados);
  comSeguranca(env);
  return env;
}
export const env = novoEnv();
/* O objeto WorkspaceDados `nome` ("indice" ou "conta:<sub>") de um env. */
export const objeto = (nome, e = env) => e.WS_DADOS.get(nome).o;

export async function sessao(email, { idade = 0, alias = "", e = env } = {}) {
  const segredo = "s-" + email + "-" + idade + "-" + alias;
  const sub = "sub-" + email.split("@")[0];
  guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: "Nome " + email.split("@")[0] }));
  await ligarSegundaEtapa(e, sub);
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, nome: "Nome " + email.split("@")[0], auth_time: Math.floor(Date.now() / 1000) - idade, mfa: true, ...(alias ? { via: "alias", alias } : {}) }));
  return "__Host-atos=" + segredo;
}
export async function chamar(caminho, { metodo = "POST", corpo, cookie, origem = A, e = env, cabecalhos = {}, texto, tipo } = {}) {
  const h = { ...cabecalhos };
  if (origem) h.origin = origem;
  if (cookie) h.cookie = cookie;
  let body;
  if (texto !== undefined) { body = texto; if (tipo) h["content-type"] = tipo; }
  else if (corpo !== undefined) { body = JSON.stringify(corpo); h["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body }), e, { waitUntil() {} });
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d, r };
}
export const GET = (caminho, cookie, e = env) => chamar(caminho, { metodo: "GET", cookie, e });
export const ativar = (cookie, e = env) => chamar("/api/workspace/ativar", { cookie, corpo: { aceito: true, versao: PRODUTOS.workspace.termos.versao }, e });

/* Uma conta pronta para o Workspace: a sessao pelo e-mail pessoal, o Workspace ativo, o alias com o destino confirmado e
   ligado, e a sessao pelo alias. {pessoal, cookie (pelo alias), sub, alias, destino}. */
export async function contaPronta(nome, { e = env } = {}) {
  const email = nome + "@exemplo.com.br";
  const pessoal = await sessao(email, { e });
  await ativar(pessoal, e);
  const sub = "sub-" + nome;
  const alias = nome.replace(/[^a-z0-9]/g, "") + ".loja";
  const destino = nome + "@destino.com.br";
  const pedir = (op, d) => e.EMAIL_ATOS.get("registro").fetch("https://email-atos/", { method: "POST", body: JSON.stringify({ op, sub, conta: email, ...d }) });
  await pedir("reservar", { alias });
  await pedir("destino_pedir", { destino, hash: "h" });
  await pedir("codigo_conferir", { hash: "h" });
  await pedir("destino_cf", { email: destino, cf_id: "cf-" + nome, criado: true, verificado: true });
  await pedir("ligar", {});
  const cookie = await sessao(email, { alias, e });
  return { pessoal, cookie, sub, email, alias, endereco: alias + "@atos.dev.br", destino, pedirEmail: pedir };
}
/* O Atos Workspace Pro na conta `sub`, como a cobranca o deixa (cobranca/cliente.js, "estender": um mes, ou doze), e o
   objeto do cliente para conferir. */
let origemPro = 0;
export async function darPro(sub, { e = env, meses = 1 } = {}) {
  const o = e.CLIENTES.get(await idDoCliente(sub));
  const r = await (await o.fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "estender", produto: "workspace", plano: "pro", metadados: { plano: "pro" }, meses, origem: "order:teste-" + ++origemPro }) })).json();
  return r.direito;
}
/* O Pro que venceu: o "ate" do direito no passado (`diasAtras`), como fica quando o periodo pago acaba. */
export async function vencerPro(sub, { e = env, diasAtras = 1 } = {}) {
  const o = e.CLIENTES.get(await idDoCliente(sub)).o;
  const d = await o.ctx.storage.get("direito:workspace");
  d.ate = new Date(Date.now() - diasAtras * 864e5).toISOString();
  await o.ctx.storage.put("direito:workspace", d);
  return d;
}
export { worker };
