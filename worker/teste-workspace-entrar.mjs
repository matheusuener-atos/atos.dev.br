// Teste da tela de entrar do Atos Workspace (/workspace/entrar; public/assets/workspace-entrar.js): a pagina com a CSP
// da conta, o login por ela so com o endereco Atos ({workspace: true} em /api/entrar, /api/esqueci e /api/redefinir:
// outro e-mail responde 400 "so_alias" sem consultar nada; um @atos.dev.br que e o e-mail de uma conta, e nao alias,
// responde como senha errada), o "Esqueci a senha" pelo alias (o codigo ao e-mail cadastrado), o ?volta= (so
// /workspace/*), os redirecionamentos (a area sem sessao vai a tela; a tela com a sessao pelo alias vai ao Workspace) e
// os links das paginas. Sem rede.
//   node worker/teste-workspace-entrar.mjs
import { readFile } from "node:fs/promises";
import worker from "./index.js";
import { ClienteCobranca } from "./cobranca/cliente.js";
import { EmailAtos } from "./email-atos.js";
import { VOLTA_DO_WORKSPACE } from "./workspace.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------------ o ambiente falso

const PUBLICO = new URL("../public/", import.meta.url);
const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
  list: async ({ prefix = "" } = {}) => ({ keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
const enviados = [];
globalThis.fetch = async (u, op) => {
  if (String(u).startsWith("https://api.resend.com/")) { enviados.push(JSON.parse(op.body)); return new Response("{}", { status: 200 }); }
  throw new Error("fetch inesperado: " + u);
};
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };
function storage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; }, async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))); },
    async setAlarm() {}, async getAlarm() { return null; },
  };
}
// Os arquivos de verdade de public/ (a pasta com index.html), como o ASSETS os serviria.
const ASSETS = { fetch: async (req) => {
  let p = new URL(req.url).pathname;
  if (p.endsWith("/")) p += "index.html";
  try {
    const corpo = await readFile(new URL("." + p, PUBLICO));
    return new Response(corpo, { headers: { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" } });
  } catch { return new Response("nao ha", { status: 404, headers: { "content-type": "text/plain" } }); }
} };
const objetos = new Map();
const env = { CONTAS, ATOS_CHAVE: JSON.stringify(jwk), RESEND_API_KEY: "re_teste", ASSETS,
  ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }]) };
const ns = (Classe) => ({ idFromName: (n) => n, get(id) {
  if (!objetos.has(Classe.name + id)) objetos.set(Classe.name + id, new Classe({ storage: storage() }, env));
  const o = objetos.get(Classe.name + id);
  return { fetch: (url, op) => o.fetch(new Request(url, op)) };
} });
env.CLIENTES = ns(ClienteCobranca);
env.EMAIL_ATOS = ns(EmailAtos);
const A = "https://atos.dev.br";

async function chamar(caminho, { metodo = "POST", corpo, cookie, origem = A } = {}) {
  const h = {};
  if (origem) h.origin = origem;
  if (cookie) h.cookie = cookie;
  let body;
  if (corpo !== undefined) { body = JSON.stringify(corpo); h["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body, redirect: "manual" }), env);
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d, r };
}
const GET = (caminho, cookie) => chamar(caminho, { metodo: "GET", cookie });
const cookieDe = (r) => (r.r.headers.get("set-cookie") || "").split(";")[0];
const ultimoCodigo = () => { const m = /(\d{6})/.exec(enviados[enviados.length - 1].subject); return m ? m[1] : ""; };
const op = (nome, d) => env.EMAIL_ATOS.get("registro").fetch("https://email-atos/", { method: "POST", body: JSON.stringify({ op: nome, ...d }) }).then((r) => r.json());
async function criarConta(email, senha, nome) {
  await chamar("/api/cadastrar", { corpo: { email, senha, nome } });
  const r = await chamar("/api/confirmar", { corpo: { email, codigo: ultimoCodigo() } });
  return { cookie: cookieDe(r), sub: JSON.parse(guardados.get("id:conta:" + email)).sub };
}
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
/* Uma conta cujo e-mail e @atos.dev.br (a equipe): o cadastro nao deixa, entao direto no KV, no formato de contas.js. */
async function contaDireta(email, senha) {
  const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(sal.match(/../g).map((x) => parseInt(x, 16))), iterations: 30000 }, chave, 256);
  guardados.set("id:conta:" + email, JSON.stringify({ sub: "pv-direta", sal, hash: hex(bits), iteracoes: 30000, nome: "Equipe", criada: new Date().toISOString() }));
}

const SENHA = "senha-certa-123";
const ERRO_LOGIN = { erro: "e-mail ou senha não conferem" };
const local = (r) => { const l = r.r.headers.get("location") || ""; return l.startsWith(A) ? l.slice(A.length) : l; };

const pedro = await criarConta("pedro@gmail.com", SENHA, "Pedro Silva");
await op("reservar", { sub: pedro.sub, conta: "pedro@gmail.com", alias: "pedro.silva" });
await contaDireta("equipe@atos.dev.br", SENHA);

// ------------------------------------------------------------------ a pagina

console.log("a pagina /workspace/entrar");
let r = await GET("/workspace/entrar/");
const csp = r.r.headers.get("content-security-policy") || "";
const html = await r.r.text();
checar(r.status === 200 && html.includes("<title>Entrar no Atos Workspace") && html.includes("/assets/workspace-entrar.js") && html.includes("/assets/entrar-comum.js"),
  "sem sessão: a página (título, o script dela e o comum)", r.status);
checar(csp.includes("script-src 'self';") && csp.includes("style-src 'self';") && csp.includes("frame-ancestors 'none'") && !csp.includes("cloudflareinsights"),
  "com a CSP da conta (sem nada de fora)", csp);
checar(r.r.headers.get("cache-control") === "no-store" && r.r.headers.get("referrer-policy") === "no-referrer" && r.r.headers.get("x-frame-options") === "DENY",
  "sem cache, sem referrer, sem moldura");
checar(!/style="|<script>(?!<\/)/.test(html) && !/Google|Criar conta/.test(html), "sem estilo nem script inline, sem Google nem Criar conta");
checar(html.includes('href="/termos/#workspace"') && html.includes('href="/privacidade/"'), "rodapé: os termos do Workspace e a privacidade");
const js = await readFile(new URL("./assets/workspace-entrar.js", PUBLICO), "utf8");
checar(js.includes(VOLTA_DO_WORKSPACE.source), "o ?volta= da tela é o mesmo do Worker (VOLTA_DO_WORKSPACE)");
checar(js.includes("workspace: true") && !/Google|Criar conta|modo=criar/.test(js), "a tela pede {workspace: true} e não oferece Google nem Criar conta");
checar(js.includes('"/entrar/?volta=" + encodeURIComponent("/workspace/email")'), "o caminho da Conta Atos leva a criar o e-mail Atos (/entrar/?volta=/workspace/email)");

// ------------------------------------------------------------------ o login so com o alias

console.log("o login pela tela: só o endereço Atos");
enviados.length = 0;
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: SENHA, workspace: true } });
checar(r.status === 400 && r.d.codigo === "so_alias" && r.d.erro.includes("@atos.dev.br") && !r.r.headers.get("set-cookie"),
  "o e-mail pessoal com a senha CERTA: 400 so_alias, sem sessão", r.d);
r = await chamar("/api/entrar", { corpo: { email: "naoexiste@gmail.com", senha: "qualquer-1", workspace: true } });
checar(r.status === 400 && r.d.codigo === "so_alias", "um e-mail que não tem conta: a mesma resposta (não entrega quem existe)", r.d);
checar(!guardados.has("id:erros:pedro@gmail.com") && !guardados.has("id:erros:naoexiste@gmail.com"), "a recusa não conta tentativa");
r = await chamar("/api/entrar", { corpo: { email: "equipe@atos.dev.br", senha: SENHA, workspace: true } });
checar(r.status === 401 && JSON.stringify(r.d) === JSON.stringify(ERRO_LOGIN), "uma conta cujo e-mail é @atos.dev.br (não alias): como senha errada", r.d);
r = await chamar("/api/entrar", { corpo: { email: "equipe@atos.dev.br", senha: SENHA } });
checar(r.status === 200 && r.d.via === "email", "e ela continua entrando pelo /entrar", r.d);
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: "senha-errada-1", workspace: true } });
checar(r.status === 401 && JSON.stringify(r.d) === JSON.stringify(ERRO_LOGIN), "o alias com a senha errada: 401 de sempre", r.d);
r = await chamar("/api/entrar", { corpo: { email: "ninguem@atos.dev.br", senha: SENHA, workspace: true } });
checar(r.status === 401 && JSON.stringify(r.d) === JSON.stringify(ERRO_LOGIN), "alias que não existe: 401 de sempre", r.d);
r = await chamar("/api/entrar", { corpo: { email: "Pedro.Silva@atos.dev.br", senha: SENHA, workspace: true } });
const sessaoAlias = cookieDe(r);
checar(r.status === 200 && r.d.via === "alias" && r.d.conta.email === "pedro@gmail.com" && sessaoAlias.startsWith("__Host-atos="), "o alias e a senha: entra, via alias", r.d);
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: SENHA } });
const peloEmail = cookieDe(r);
checar(r.status === 200 && r.d.via === "email", "sem a marca do Workspace, o /entrar continua aceitando o e-mail pessoal", r.d);

console.log("esqueci a senha pela tela");
enviados.length = 0;
r = await chamar("/api/esqueci", { corpo: { email: "pedro@gmail.com", workspace: true } });
checar(r.status === 400 && r.d.codigo === "so_alias" && enviados.length === 0, "pelo e-mail pessoal: 400 so_alias, nenhum e-mail sai", r.d);
r = await chamar("/api/esqueci", { corpo: { email: "pedro.silva@atos.dev.br", workspace: true } });
checar(r.status === 200 && r.d.para === "p***@gmail.com" && enviados.length === 1 && enviados[0].to[0] === "pedro@gmail.com", "pelo alias: o código vai ao e-mail cadastrado (mascarado na resposta)", r.d);
const cod = ultimoCodigo();
enviados.length = 0;
r = await chamar("/api/esqueci", { corpo: { email: "equipe@atos.dev.br", workspace: true } });
checar(r.status === 200 && r.d.alias === true && !r.d.para && enviados.length === 0, "@atos.dev.br que não é alias: a resposta de alias inexistente, sem e-mail", r.d);
r = await chamar("/api/redefinir", { corpo: { email: "pedro@gmail.com", codigo: cod, senha: "outra-senha-456", workspace: true } });
checar(r.status === 400 && r.d.codigo === "so_alias", "redefinir pelo e-mail pessoal pela tela: 400 so_alias", r.d);
r = await chamar("/api/redefinir", { corpo: { email: "pedro.silva@atos.dev.br", codigo: cod, senha: "outra-senha-456", workspace: true } });
const redef = cookieDe(r);
checar(r.status === 200 && r.d.via === "alias" && redef.startsWith("__Host-atos="), "redefinir pelo alias: troca e abre a sessão pelo alias", r.d);

// ------------------------------------------------------------------ os redirecionamentos

console.log("os redirecionamentos");
for (const [caminho, volta] of [["/workspace/", "/workspace/"], ["/workspace", "/workspace"], ["/workspace/integracoes", "/workspace/integracoes"], ["/workspace/email", "/workspace/email"]]) {
  r = await GET(caminho);
  checar(r.status === 302 && local(r) === "/workspace/entrar/?volta=" + encodeURIComponent(volta) && r.r.headers.get("cache-control") === "no-store",
    caminho + " sem sessão: a tela de entrar do Workspace, voltando", local(r));
}
r = await GET("/workspace/", peloEmail);
checar(r.status === 200, "/workspace/ com a sessão pelo e-mail pessoal: a área (a ativação abre com qualquer login)", r.status);
r = await GET("/workspace/entrar/", peloEmail);
checar(r.status === 200 && (await r.r.text()).includes("Entrar no Atos Workspace"), "a tela com a sessão pelo e-mail pessoal: pede o alias (não redireciona)", r.status);
r = await GET("/workspace/entrar/", redef);
checar(r.status === 302 && local(r) === "/workspace/", "a tela com a sessão pelo alias: direto ao /workspace/", local(r));
const voltas = [
  ["/workspace/integracoes", "/workspace/integracoes"], ["/workspace/email", "/workspace/email"], ["//mal.example/x", "/workspace/"],
  ["https://mal.example/", "/workspace/"], ["/conta/", "/workspace/"], ["/workspace/entrar/", "/workspace/"], ["/workspace/../conta", "/workspace/"],
  ["/workspace/email?x=1", "/workspace/"], ["/\\mal.example", "/workspace/"],
];
for (const [v, esperado] of voltas) {
  r = await GET("/workspace/entrar/?volta=" + encodeURIComponent(v), redef);
  checar(r.status === 302 && local(r) === esperado, "volta=" + v + " -> " + esperado, local(r));
}
r = await GET("/workspace/entrar/?modo=entrar&volta=/workspace/integracoes", redef);
checar(r.status === 200, "?modo=entrar (o login recente): a tela abre mesmo com a sessão pelo alias", r.status);
r = await chamar("/workspace/entrar/", { metodo: "POST", cookie: redef });
checar(r.status !== 302, "só o GET redireciona");

// ------------------------------------------------------------------ os links das paginas

console.log("os links");
const ler = (p) => readFile(new URL(p, PUBLICO), "utf8");
const integracao = await ler("./integracao/index.html");
checar(integracao.includes('<a class="btn" href="/workspace/entrar/">Já tenho, ir ao Workspace</a>'), "/integracao: “Já tenho, ir ao Workspace” vai à tela do Workspace");
const ws = await ler("./assets/workspace.js");
checar(ws.includes('"/workspace/entrar/?login_hint="') && !ws.includes("/entrar/?modo=entrar&login_hint"), "o botão “Entrar com <alias>” da área vai à tela do Workspace");
checar(!/location\.replace\("\/entrar\//.test(ws), "a área sem sessão vai à tela do Workspace (não ao /entrar)");
for (const f of ["./assets/workspace-email.js", "./assets/workspace-integracoes.js"]) {
  const t = await ler(f);
  checar(!/location\.replace\("\/entrar\//.test(t) && t.includes('location.replace("/workspace/entrar/?volta='), f.slice(9) + ": sem sessão, a tela do Workspace");
}
const ig = await ler("./assets/workspace-integracoes.js");
checar(ig.includes('"/workspace/entrar/?modo=entrar&volta="'), "Integrações: o “Entrar de novo” é pela tela do Workspace (o login pelo alias)");
const entrar = await ler("./entrar/index.html");
checar(entrar.indexOf("/assets/entrar-comum.js") > 0 && entrar.indexOf("/assets/entrar-comum.js") < entrar.indexOf("/assets/entrar.js"), "o /entrar carrega o comum antes do entrar.js");

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
