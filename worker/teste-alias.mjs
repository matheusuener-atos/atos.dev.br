// Teste do endereco Atos como login e como requisito (decisoes de 11/10/2026): entrar com <alias>@atos.dev.br e a senha
// da conta (certo, senha errada, alias inexistente, fora do formato, suspenso, removido - a mesma resposta - e o limite
// de tentativas contado a parte), "Esqueci a senha" pelo alias (o codigo vai ao e-mail cadastrado, mascarado na
// resposta), a sessao com `via`, as excecoes do Workspace (ativar e a guia E-mail Atos com qualquer login), os 403 das
// Integracoes (workspace, sem_alias, alias_nao_confirmado, entrar_pelo_alias), a mascara de "Cadastrado por" no
// /api/pedido e na Minha conta, os aplicativos antigos (continuam funcionando), o e-mail que o aplicativo recebe (o da
// conta) e o Worker de teste (as chaves com prefixo, a Cloudflare simulada pelas rotas). Sem rede.
//   node worker/teste-alias.mjs
import worker from "./index.js";
import { comSeguranca, ligarSegundaEtapa } from "./apoio-teste-seguranca.mjs";
import { conferirIdToken } from "./oidc.js";
import { ClienteCobranca } from "./cobranca/cliente.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { EmailAtos } from "./email-atos.js";
import { mascarar } from "./contas.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------------ o ambiente falso

const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
  list: async ({ prefix = "" } = {}) => ({ keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
// O Resend falso: guarda cada e-mail que sairia (para quem, o assunto e o texto).
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
function novoEnv(extra = {}) {
  const objetos = new Map();
  const env = {
    CONTAS, ATOS_CHAVE: JSON.stringify(jwk), RESEND_API_KEY: "re_teste",
    ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }]),
    ASSETS: { fetch: async (req) => new Response("<p>pagina " + new URL(req.url).pathname + "</p>", { headers: { "content-type": "text/html" } }) },
    ...extra,
  };
  const ns = (Classe) => ({ idFromName: (n) => n, get(id) {
    if (!objetos.has(Classe.name + id)) objetos.set(Classe.name + id, new Classe({ storage: storage() }, env));
    const o = objetos.get(Classe.name + id);
    return { fetch: (url, op) => o.fetch(new Request(url, op)) };
  } });
  env.CLIENTES = ns(ClienteCobranca);
  env.EMAIL_ATOS = ns(EmailAtos);
  return env;
}
const env = novoEnv();
// O Worker de teste: a Cloudflare simulada (o e-mail Atos ligado sem token) e os proprios objetos.
// O Worker de teste so aceita a equipe (contas.js, equipeNoTeste): a Lia e o Pedro estao na equipe do teste.
const envT = novoEnv({ AMBIENTE: "teste", EMAIL_CF_SIMULADA: "1", ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" },
  { email: "lia@outlook.com", nome: "Lia", papel: "suporte", areas: ["atos"] }, { email: "pedro@gmail.com", nome: "Pedro", papel: "suporte", areas: ["atos"] }]) });
const A = "https://atos.dev.br";
const VERSAO = PRODUTOS.workspace.termos.versao;

async function chamar(caminho, { metodo = "POST", corpo, form, cookie, origem = A, e = env } = {}) {
  const h = {};
  if (origem) h.origin = origem;
  if (cookie) h.cookie = cookie;
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
  else if (corpo !== undefined) { body = JSON.stringify(corpo); h["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body }), e);
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d, r };
}
const GET = (caminho, cookie, e = env) => chamar(caminho, { metodo: "GET", cookie, e });
const cookieDe = (r) => { const c = r.r.headers.get("set-cookie") || ""; return c.split(";")[0]; };
const ultimoCodigo = () => { const m = /(\d{6})/.exec(enviados[enviados.length - 1].subject); return m ? m[1] : ""; };
const sessaoGuardada = async (cookie) => {
  const segredo = cookie.split("=")[1];
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(segredo)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return JSON.parse(guardados.get("atos:sessao:" + h) || "null");
};
/* Uma op direta no registro do e-mail Atos (o que a tela e o painel fariam). */
const op = (e, nome, d) => e.EMAIL_ATOS.get("registro").fetch("https://email-atos/", { method: "POST", body: JSON.stringify({ op: nome, ...d }) }).then((r) => r.json());
async function aliasConfirmado(e, sub, conta, alias, destino) {
  await op(e, "reservar", { sub, conta, alias });
  await op(e, "destino_pedir", { sub, destino, hash: "h" });
  await op(e, "codigo_conferir", { sub, hash: "h" });
  return op(e, "destino_cf", { sub, email: destino, cf_id: "cf-" + alias, criado: true, verificado: true });
}
/* Cria uma Conta Atos de verdade (cadastrar + o codigo do e-mail): devolve o cookie (a sessao pelo e-mail) e o sub. */
async function criarConta(email, senha, nome) {
  let r = await chamar("/api/cadastrar", { corpo: { email, senha, nome } });
  r = await chamar("/api/confirmar", { corpo: { email, codigo: ultimoCodigo() } });
  return { cookie: cookieDe(r), sub: JSON.parse(guardados.get("id:conta:" + email)).sub };
}
const b64url = (b) => Buffer.from(b).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, desafio: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}
const consulta = (cliente, volta, desafio) => new URLSearchParams({ client_id: cliente, redirect_uri: volta, response_type: "code", scope: "openid email profile",
  state: "st", nonce: "nn", code_challenge_method: "S256", code_challenge: desafio }).toString();

const SENHA = "senha-certa-123";
const ERRO_LOGIN = { erro: "e-mail ou senha não conferem" };

// ------------------------------------------------------------------ as contas

console.log("as contas");
const pedro = await criarConta("pedro@gmail.com", SENHA, "Pedro Silva");
const lia = await criarConta("lia@outlook.com", SENHA, "Lia");
checar(pedro.cookie && lia.cookie, "o Pedro e a Lia criam a Conta Atos (o código pelo e-mail)");
let r = await chamar("/api/cadastrar", { corpo: { email: "novo@atos.dev.br", senha: SENHA } });
checar(r.status === 400 && r.d.erro.includes("e-mail Atos"), "um endereço @atos.dev.br não vira conta nova", r.d);
r = await chamar("/api/confirmar", { corpo: { email: "novo@atos.dev.br", codigo: "123456" } });
checar(r.status === 400 && r.d.erro.includes("e-mail Atos"), "nem pela confirmação", r.d);
await aliasConfirmado(env, pedro.sub, "pedro@gmail.com", "pedro.silva", "pedro@gmail.com");
checar(true, "o Pedro tem pedro.silva@atos.dev.br, com o destino confirmado");

// ------------------------------------------------------------------ entrar pelo alias

console.log("entrar pelo endereço Atos");
r = await chamar("/api/entrar", { corpo: { email: "Pedro.Silva@ATOS.dev.br", senha: SENHA } });
const pedroAlias = cookieDe(r);
checar(r.status === 200 && r.d.conta.email === "pedro@gmail.com" && r.d.via === "alias" && pedroAlias.startsWith("__Host-atos="), "o alias e a senha da conta abrem a MESMA conta", r.d);
let s = await sessaoGuardada(pedroAlias);
checar(s.sub === pedro.sub && s.email === "pedro@gmail.com" && s.via === "alias" && s.alias === "pedro.silva", "a sessão lembra que entrou pelo alias (o sub e o e-mail são os da conta)", s);
r = await GET("/api/eu", pedroAlias);
checar(r.d.conta.email === "pedro@gmail.com" && r.d.conta.via === "alias" && r.d.conta.alias === "pedro.silva@atos.dev.br", "/api/eu diz por onde entrou", r.d);
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: SENHA } });
const pedroEmail = cookieDe(r);
s = await sessaoGuardada(pedroEmail);
checar(r.status === 200 && r.d.via === "email" && !s.via && !s.alias, "pelo e-mail da conta: a sessão sem via (o e-mail)", s);
r = await GET("/api/eu", pedroEmail);
checar(r.d.conta.via === "email" && !r.d.conta.alias, "/api/eu: via e-mail");

const recusas = [];
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: "senha-errada-1" } });
recusas.push(["senha errada pelo alias", r]);
r = await chamar("/api/entrar", { corpo: { email: "ninguem.aqui@atos.dev.br", senha: SENHA } });
recusas.push(["alias que não existe", r]);
r = await chamar("/api/entrar", { corpo: { email: "x@atos.dev.br", senha: SENHA } });
recusas.push(["fora do formato", r]);
r = await chamar("/api/entrar", { corpo: { email: "contato@atos.dev.br", senha: SENHA } });
recusas.push(["nome reservado sem conta", r]);
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: "senha-errada-1" } });
recusas.push(["senha errada pelo e-mail", r]);
for (const [nome, x] of recusas) checar(x.status === 401 && JSON.stringify(x.d) === JSON.stringify(ERRO_LOGIN) && !x.r.headers.get("set-cookie"), nome + ": 401, a mesma resposta", x.d);

await op(env, "suspender", { alias: "pedro.silva", motivo: "teste", por: "dono@atos.dev.br" });
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: SENHA } });
checar(r.status === 401 && JSON.stringify(r.d) === JSON.stringify(ERRO_LOGIN), "alias suspenso: a mesma resposta, mesmo com a senha certa", r.d);
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: SENHA } });
checar(r.status === 200, "e o e-mail da conta continua entrando");
await op(env, "reativar", { alias: "pedro.silva", por: "dono@atos.dev.br" });
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: SENHA } });
checar(r.status === 200, "reativado: entra de novo (o encaminhamento desligado não importa)");

// O limite: 8 erros pelo alias bloqueiam o alias por 15 minutos - contados a parte do e-mail da conta.
await aliasConfirmado(env, lia.sub, "lia@outlook.com", "lia.dev", "lia@outlook.com");
for (let i = 0; i < 8; i++) await chamar("/api/entrar", { corpo: { email: "lia.dev@atos.dev.br", senha: "errada-" + i + "abc" } });
r = await chamar("/api/entrar", { corpo: { email: "lia.dev@atos.dev.br", senha: SENHA } });
checar(r.status === 429 && guardados.has("atos:erros-alias:lia.dev"), "8 erros pelo alias: 429, mesmo com a senha certa (a chave atos:erros-alias:)", r.d);
for (let i = 0; i < 8; i++) await chamar("/api/entrar", { corpo: { email: "inventado@atos.dev.br", senha: "errada-" + i + "abc" } });
const r2 = await chamar("/api/entrar", { corpo: { email: "inventado@atos.dev.br", senha: SENHA } });
checar(r2.status === 429 && JSON.stringify(r2.d) === JSON.stringify(r.d), "alias inexistente: o mesmo limite e a mesma resposta", r2.d);
r = await chamar("/api/entrar", { corpo: { email: "lia@outlook.com", senha: SENHA } });
checar(r.status === 200 && !guardados.has("id:erros:lia@outlook.com"), "o e-mail da conta não fica bloqueado (o bloqueio não revela de quem é o alias)", r.d);

// ------------------------------------------------------------------ esqueci a senha pelo alias

console.log("esqueci a senha pelo alias");
enviados.length = 0;
r = await chamar("/api/esqueci", { corpo: { email: "pedro.silva@atos.dev.br" } });
checar(r.status === 200 && r.d.alias === true && r.d.para === "p***@gmail.com" && mascarar("pedro@gmail.com") === "p***@gmail.com", "a resposta diz o e-mail cadastrado, mascarado", r.d);
checar(enviados.length === 1 && enviados[0].to[0] === "pedro@gmail.com" && !JSON.stringify(enviados).includes("\"to\":[\"pedro.silva@"), "o código foi ao e-mail cadastrado, nunca ao alias", enviados.map((x) => x.to));
const cod = ultimoCodigo();
enviados.length = 0;
r = await chamar("/api/esqueci", { corpo: { email: "ninguem.aqui@atos.dev.br" } });
checar(r.status === 200 && r.d.ok && r.d.alias === true && !r.d.para && enviados.length === 0, "alias inexistente: ok, sem e-mail e sem endereço", r.d);
r = await chamar("/api/redefinir", { corpo: { email: "pedro.silva@atos.dev.br", codigo: "000000", senha: "outra-senha-456" } });
checar(r.status === 400 && r.d.erro.includes("não confere"), "o código errado pelo alias: recusado", r.d);
// A sessao do alias aberta antes da troca (um minuto antes): a troca a fecha.
{
  const segredo = pedroAlias.split("=")[1];
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(segredo)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const v = JSON.parse(guardados.get("atos:sessao:" + h));
  guardados.set("atos:sessao:" + h, JSON.stringify({ ...v, auth_time: v.auth_time - 60 }));
}
r = await chamar("/api/redefinir", { corpo: { email: "pedro.silva@atos.dev.br", codigo: cod, senha: "outra-senha-456" } });
const pedroRedef = cookieDe(r);
s = await sessaoGuardada(pedroRedef);
checar(r.status === 200 && r.d.conta.email === "pedro@gmail.com" && s.via === "alias" && s.alias === "pedro.silva", "troca a senha da conta e abre a sessão pelo alias", r.d);
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: "outra-senha-456" } });
checar(r.status === 200, "a senha nova vale no e-mail da conta");
r = await GET("/api/eu", pedroAlias);
checar(r.d.conta === null, "a troca fechou as sessões antigas (também a do alias)");
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: "outra-senha-456" } });
const pa = cookieDe(r);
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: "outra-senha-456" } });
const pe = cookieDe(r);
checar(pa && pe, "as duas sessões de agora: pelo alias e pelo e-mail");

// A segunda etapa (worker/seguranca/etapa.js) vale tambem pelo alias e pela tela do Workspace: a senha certa nao abre a
// sessao, vem a etapa. Depois, a etapa sai (o resto do teste entra so com a senha).
console.log("a segunda etapa pelo endereço Atos");
await ligarSegundaEtapa(env, pedro.sub);
for (const [nome, corpo] of [["pelo alias", { email: "pedro.silva@atos.dev.br", senha: "outra-senha-456" }],
  ["pela tela do Workspace", { email: "pedro.silva@atos.dev.br", senha: "outra-senha-456", workspace: true }],
  ["pelo e-mail da conta", { email: "pedro@gmail.com", senha: "outra-senha-456" }]]) {
  r = await chamar("/api/entrar", { corpo });
  const sc = r.r.headers.getSetCookie();
  checar(r.status === 200 && r.d.etapa && r.d.etapa.chave === true && !r.d.ok && sc.length === 1 && sc[0].startsWith("__Host-atos-etapa="), nome + ": a senha certa pede a segunda etapa (sem sessão)", { d: r.d, sc });
}
await env.SEGURANCA.get(pedro.sub).o.ctx.storage.put("reg", { chaves: [] });
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: "outra-senha-456" } });
checar(r.status === 200 && r.d.ok && cookieDe(r).startsWith("__Host-atos="), "sem a etapa, o alias entra direto de novo", r.d);

// ------------------------------------------------------------------ o Workspace e as excecoes

console.log("o Workspace");
r = await GET("/api/integracoes", pa);
checar(r.status === 403 && r.d.codigo === "workspace" && r.d.workspace === false, "Workspace inativo: 403 workspace", r.d);
r = await chamar("/api/workspace/ativar", { cookie: pe, corpo: { aceito: true, versao: VERSAO } });
checar(r.status === 200 && r.d.ativo && r.d.via_alias === false && r.d.pendencia === "entrar_pelo_alias" && r.d.alias.endereco === "pedro.silva@atos.dev.br",
  "ativar abre com o e-mail pessoal (exceção), e a área diz para entrar pelo alias", r.d);
r = await GET("/api/workspace", pe);
checar(r.status === 200 && r.d.pendencia === "entrar_pelo_alias", "a área pelo e-mail pessoal: entrar_pelo_alias");
r = await GET("/api/workspace/email", pe);
checar(r.status === 200 && r.d.alias.endereco === "pedro.silva@atos.dev.br" && r.d.entrou_pelo_alias === false, "a guia E-mail Atos abre com o e-mail pessoal (exceção)", r.d);
r = await GET("/api/integracoes", pe);
checar(r.status === 403 && r.d.codigo === "entrar_pelo_alias" && r.d.alias === "pedro.silva@atos.dev.br" && r.d.erro.includes("entre com pedro.silva@atos.dev.br"), "as Integrações pelo e-mail pessoal: 403 entrar_pelo_alias", r.d);
r = await chamar("/api/integracoes/apps", { cookie: pe, corpo: { nome: "Agenda do Pedro" } });
checar(r.status === 403 && r.d.codigo === "entrar_pelo_alias", "nem cria");
r = await GET("/api/workspace", pa);
checar(r.d.via_alias === true && r.d.pendencia === null, "pelo alias: nada pendente", r.d);
r = await GET("/api/workspace/email", pa);
checar(r.d.entrou_pelo_alias === true, "e a guia E-mail Atos sabe");
r = await GET("/api/integracoes", pa);
checar(r.status === 200 && Array.isArray(r.d.apps), "as Integrações abrem pelo alias", r.d);

// O destino trocado (ainda nao confirmado): alias_nao_confirmado.
await op(env, "destino_pedir", { sub: pedro.sub, destino: "pedro.novo@gmail.com", hash: "h2" });
r = await GET("/api/integracoes", pa);
checar(r.status === 403 && r.d.codigo === "alias_nao_confirmado", "destino trocado e não confirmado: 403 alias_nao_confirmado", r.d);
r = await GET("/api/workspace", pa);
checar(r.d.pendencia === "alias_nao_confirmado" && r.d.alias.confirmado === false, "a área diz o mesmo");
await op(env, "codigo_conferir", { sub: pedro.sub, hash: "h2" });
await op(env, "destino_cf", { sub: pedro.sub, email: "pedro.novo@gmail.com", cf_id: "cf-novo", criado: true, verificado: true });
r = await GET("/api/integracoes", pa);
checar(r.status === 200, "confirmado de novo: abre");

// Quem nao tem alias: sem_alias.
const ze = await criarConta("ze@yahoo.com", SENHA, "Zé");
r = await chamar("/api/workspace/ativar", { cookie: ze.cookie, corpo: { aceito: true, versao: VERSAO } });
checar(r.d.ativo && r.d.alias === null && r.d.pendencia === "sem_alias", "sem alias: a área diz sem_alias", r.d);
r = await GET("/api/integracoes", ze.cookie);
checar(r.status === 403 && r.d.codigo === "sem_alias" && r.d.erro.includes("crie o seu e-mail Atos") === false && r.d.disponivel === false,
  "sem alias (e-mail Atos desligado nesta Atos): 403 sem_alias, dizendo que está em preparação", r.d);
r = await chamar("/api/integracoes", { metodo: "GET", cookie: ze.cookie, e: { ...env, CF_EMAIL_TOKEN: "t", CF_ACCOUNT_ID: "c" } });
checar(r.status === 403 && r.d.codigo === "sem_alias" && r.d.erro.includes("crie o seu e-mail Atos"), "com o e-mail Atos ligado: \"crie o seu e-mail Atos\"", r.d);

// ------------------------------------------------------------------ o aplicativo e a mascara

console.log("o aplicativo e a máscara");
const SITE = { nome: "Agenda do Pedro", descricao: "horários", site: "https://agenda.example", privacidade: "https://agenda.example/p", termos: "https://agenda.example/t" };
const VOLTA = "https://agenda.example/volta";
r = await chamar("/api/integracoes/apps", { cookie: pa, corpo: SITE });
const app = r.d.app;
checar(r.status === 200 && app && app.dono === "pedro@gmail.com", "o Pedro, pelo alias, cria o aplicativo", r.d);
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: pa, corpo: { tipo: "publico", voltas: [VOLTA] } });
const cid = r.d.acesso;
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: pa, corpo: { acao: "acesso", acesso: "todos" } });
checar(cid && r.status === 200, "um acesso público e qualquer Conta Atos entra");

// A Lia (o alias dela ainda bloqueado pelas tentativas acima) entra pelo e-mail no aplicativo do Pedro: ve o alias dele.
r = await chamar("/api/entrar", { corpo: { email: "lia.dev@atos.dev.br", senha: SENHA } });
checar(r.status === 429, "(a Lia ainda está bloqueada pelo alias; entra pelo e-mail)");
r = await chamar("/api/entrar", { corpo: { email: "lia@outlook.com", senha: SENHA } });
const liaCookie = cookieDe(r);
let p = await pkce();
r = await chamar("/api/pedido", { cookie: liaCookie, corpo: { consulta: consulta(cid, VOLTA, p.desafio) } });
checar(r.status === 200 && r.d.app.terceiro && r.d.app.cadastrado_por === "pedro.silva@atos.dev.br" && !JSON.stringify(r.d).includes("pedro@gmail.com") && !JSON.stringify(r.d).includes("pedro.novo"),
  "o consentimento mostra o alias do dono, nunca o e-mail pessoal dele", r.d);
r = await chamar("/api/autorizar", { cookie: liaCookie, corpo: { consulta: consulta(cid, VOLTA, p.desafio), permitir: true } });
const code = new URL(r.d.ir).searchParams.get("code");
r = await chamar("/oauth/token", { origem: "", form: { grant_type: "authorization_code", code, redirect_uri: VOLTA, client_id: cid, code_verifier: p.verifier } });
let tok = await conferirIdToken(env, r.d.id_token);
checar(r.status === 200 && tok.email === "lia@outlook.com", "o aplicativo recebe o e-mail da conta de quem entra", tok);
r = await GET("/api/apps", liaCookie);
let x = r.d.apps.find((a) => a.id === app.id);
checar(x && x.cadastrado_por === "pedro.silva@atos.dev.br" && !JSON.stringify(r.d).includes("pedro@gmail.com"), "a Minha conta da Lia também mostra o alias", x);

// Quem entra pelo alias: o id_token traz o e-mail da conta (o alias nao entra nos escopos).
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: "outra-senha-456" } });
const pa2 = cookieDe(r);
p = await pkce();
r = await chamar("/api/autorizar", { cookie: pa2, corpo: { consulta: consulta(cid, VOLTA, p.desafio), permitir: true } });
r = await chamar("/oauth/token", { origem: "", form: { grant_type: "authorization_code", code: new URL(r.d.ir).searchParams.get("code"), redirect_uri: VOLTA, client_id: cid, code_verifier: p.verifier } });
tok = await conferirIdToken(env, r.d.id_token);
checar(tok.email === "pedro@gmail.com" && !JSON.stringify(tok).includes("pedro.silva"), "entrou pelo alias: o aplicativo recebe o e-mail da conta, não o alias", tok);

// Suspenso: "uma Conta Atos" (a pagina), a gestao parada, o aplicativo funcionando.
await op(env, "suspender", { alias: "pedro.silva", motivo: "abuso", por: "dono@atos.dev.br" });
p = await pkce();
r = await chamar("/api/pedido", { cookie: liaCookie, corpo: { consulta: consulta(cid, VOLTA, p.desafio) + "&prompt=consent" } });
checar(r.status === 200 && r.d.app.cadastrado_por === "" && !JSON.stringify(r.d).includes("pedro"), "alias suspenso: sem endereço (a página diz \"uma Conta Atos\")", r.d.app);
r = await GET("/api/integracoes", pa2);
checar(r.status === 403 && r.d.codigo === "sem_alias" && r.d.suspenso === true, "e a gestão para: 403 sem_alias (suspenso)", r.d);
await op(env, "reativar", { alias: "pedro.silva", por: "dono@atos.dev.br" });

// Removido (o aplicativo "antigo", sem alias): continua funcionando para quem entra; a gestao pede o alias de novo.
await op(env, "remover", { alias: "pedro.silva", por: "dono@atos.dev.br" });
p = await pkce();
r = await chamar("/api/pedido", { cookie: liaCookie, corpo: { consulta: consulta(cid, VOLTA, p.desafio) } });
checar(r.status === 200 && r.d.permitido === true && r.d.app.cadastrado_por === "" && !JSON.stringify(r.d).includes("pedro@gmail.com"), "alias removido: \"uma Conta Atos\", e o aplicativo segue", r.d);
r = await chamar("/api/autorizar", { cookie: liaCookie, corpo: { consulta: consulta(cid, VOLTA, p.desafio), permitir: true } });
r = await chamar("/oauth/token", { origem: "", form: { grant_type: "authorization_code", code: new URL(r.d.ir).searchParams.get("code"), redirect_uri: VOLTA, client_id: cid, code_verifier: p.verifier } });
checar(r.status === 200 && r.d.id_token, "a Lia ainda entra no aplicativo (os aplicativos de quem perdeu o requisito continuam)");
r = await chamar("/api/entrar", { corpo: { email: "pedro.silva@atos.dev.br", senha: "outra-senha-456" } });
checar(r.status === 401 && JSON.stringify(r.d) === JSON.stringify(ERRO_LOGIN), "alias removido: não entra mais (a mesma resposta)");
r = await GET("/api/integracoes", pa2);
checar(r.status === 403 && r.d.codigo === "sem_alias", "a sessão aberta pelo alias removido: 403 sem_alias", r.d);
r = await GET("/api/apps", liaCookie);
x = r.d.apps.find((a) => a.id === app.id);
checar(x && x.cadastrado_por === "", "a Minha conta também (sem endereço)", x);

// Outro alias depois: a sessao aberta pelo antigo nao vale como "pelo alias".
await aliasConfirmado(env, pedro.sub, "pedro@gmail.com", "pedro.agenda", "pedro@gmail.com");
r = await GET("/api/integracoes", pa2);
checar(r.status === 403 && r.d.codigo === "entrar_pelo_alias" && r.d.alias === "pedro.agenda@atos.dev.br", "alias novo: a sessão do antigo pede entrar pelo novo", r.d);
r = await chamar("/api/entrar", { corpo: { email: "pedro.agenda@atos.dev.br", senha: "outra-senha-456" } });
r = await GET("/api/integracoes", cookieDe(r));
checar(r.status === 200 && r.d.apps.some((a) => a.id === app.id), "entrando pelo novo, o aplicativo volta à gestão");

// O painel da equipe ve o dono real e o alias.
guardados.set("id:conta:dono@atos.dev.br", JSON.stringify({ sub: "sub-dono", nome: "Dono" }));
{
  const segredo = "dono-sessao";
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(segredo)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  await ligarSegundaEtapa(env, "sub-dono");
  guardados.set("atos:sessao:" + h, JSON.stringify({ sub: "sub-dono", email: "dono@atos.dev.br", auth_time: Math.floor(Date.now() / 1000), mfa: true }));
  r = await GET("/api/admin/oauth", "__Host-atos=" + segredo);
}
const t = r.d && r.d.terceiros && r.d.terceiros.find((a) => a.id === app.id);
checar(t && t.dono === "pedro@gmail.com" && t.dono_sub === pedro.sub && t.dono_alias.endereco === "pedro.agenda@atos.dev.br", "o painel vê o dono real (e-mail e sub) e o alias", t);

// ------------------------------------------------------------------ o Worker de teste, pelas rotas

console.log("o Worker de teste (a Cloudflare simulada)");
const GT = (c, k) => GET(c, k, envT);
const PT = (c, corpo, k) => chamar(c, { corpo, cookie: k, e: envT });
// So a equipe entra no Worker de teste (as contas sao as da producao, sem a segunda etapa dela).
{
  const fora = await criarConta("fora.da.equipe@outlook.com", SENHA, "Fora");
  checar(Boolean(fora.cookie), "(uma conta de fora da equipe existe na producao)");
  for (const [rota, corpo] of [["/api/entrar", { email: "fora.da.equipe@outlook.com", senha: SENHA }], ["/api/entrar", { email: "fora.da.equipe@outlook.com", senha: "errada-de-proposito" }],
    ["/api/entrar", { email: "ninguem@outlook.com", senha: SENHA }], ["/api/cadastrar", { email: "novo@outlook.com", senha: SENHA }],
    ["/api/esqueci", { email: "fora.da.equipe@outlook.com" }], ["/api/entrar", { email: "pedro.silva@atos.dev.br", senha: SENHA }]]) {
    const x = await PT(rota, corpo);
    checar(x.status === 403 && x.d.codigo === "so_equipe" && !x.r.headers.get("set-cookie"), "teste: " + rota + " " + corpo.email + " (fora da equipe) -> 403 so_equipe, sem sessao", { status: x.status, d: x.d });
  }
}
r = await PT("/api/entrar", { email: "lia@outlook.com", senha: SENHA });
const liaT = cookieDe(r);
r = await PT("/api/workspace/ativar", { aceito: true, versao: VERSAO }, liaT);
checar(r.d.ativo && r.d.alias === null, "a Lia ativa no teste (o alias da produção não existe aqui)", r.d);
r = await PT("/api/workspace/email/alias", { alias: "lia.teste" }, liaT);
r = await PT("/api/workspace/email/destino", { destino: "lia@outlook.com" }, liaT);
const codT = r.d.codigo_teste;
r = await PT("/api/workspace/email/codigo", { codigo: codT }, liaT);
r = await PT("/api/workspace/email/conferir", {}, liaT);
checar(r.status === 200 && r.d.alias.destino.codigo_ok && r.d.alias.destino.cf_ok && r.d.entrou_pelo_alias === false, "pelas rotas: reserva, o código e a Cloudflare simulada", r.d);
r = await GT("/api/integracoes", liaT);
checar(r.status === 403 && r.d.codigo === "entrar_pelo_alias", "e as Integrações pedem o login pelo alias", r.d);
r = await PT("/api/entrar", { email: "lia.teste@atos.dev.br", senha: SENHA });
const liaTA = cookieDe(r);
checar(r.status === 200 && r.d.via === "alias", "entra pelo alias do teste");
r = await chamar("/api/entrar", { corpo: { email: "lia.teste@atos.dev.br", senha: SENHA } });
checar(r.status === 401, "o alias do teste não entra na produção (cada Worker tem os seus)");
r = await GT("/api/integracoes", liaTA);
checar(r.status === 200, "no teste, as Integrações abrem pelo alias", r.d);
r = await PT("/api/entrar", { email: "lia.teste@atos.dev.br", senha: "errada-abc-1" });
checar(JSON.parse(guardados.get("atos-teste:erros-alias:lia.teste")).n === 1, "as tentativas do teste com o prefixo atos-teste: (a da produção é outra chave)");
r = await PT("/api/esqueci", { email: "lia.teste@atos.dev.br" });
checar(r.d.para === "l***@outlook.com" && enviados[enviados.length - 1].to[0] === "lia@outlook.com", "o esqueci pelo alias do teste vai ao e-mail da conta", r.d);

// Sem o registro do e-mail Atos respondendo: 503 (nunca "sem alias" por engano).
const quebrado = { ...env, EMAIL_ATOS: { idFromName: (n) => n, get() { return { fetch: async () => new Response("{}", { status: 500 }) }; } } };
r = await chamar("/api/entrar", { corpo: { email: "pedro.agenda@atos.dev.br", senha: "outra-senha-456" }, e: quebrado });
checar(r.status === 503, "o login pelo alias sem o registro: 503", r.d);
r = await chamar("/api/entrar", { corpo: { email: "pedro@gmail.com", senha: "outra-senha-456" }, e: quebrado });
checar(r.status === 200, "o login pelo e-mail não depende do registro");
r = await GET("/api/integracoes", pa2, quebrado);
checar(r.status === 503, "as Integrações sem o registro: 503", r.d);

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
