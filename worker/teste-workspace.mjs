// Teste do Atos Workspace (worker/workspace.js): o produto gratuito no catalogo, ativar (aceitando os termos, com login
// recente), desativar, as Integracoes so com ele ativo (403 sem), os aplicativos de quem desativou (continuam
// funcionando para quem entra; a gestao pede a ativacao), a Minha conta (o Workspace como produto), o painel da equipe
// (o Workspace do dono), as paginas e o endereco antigo /conta/integracoes. Sem rede.
//   node worker/teste-workspace.mjs
import worker from "./index.js";
import { comSeguranca, ligarSegundaEtapa } from "./apoio-teste-seguranca.mjs";
import { sha256 } from "./comum.js";
import { ClienteCobranca } from "./cobranca/cliente.js";
import { PRODUTOS, catalogoPublico, produtoGratuito, resolveOffer } from "./cobranca/catalogo.js";
import { EmailAtos } from "./email-atos.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
  list: async ({ prefix = "" } = {}) => ({ keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
globalThis.fetch = async (u) => { throw new Error("fetch inesperado: " + u); };
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };
const objetos = new Map();
function storage() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; }, async put(k, v) { m.set(k, structuredClone(v)); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); }, async setAlarm() {} };
}
const env = {
  CONTAS, ATOS_CHAVE: JSON.stringify(jwk),
  ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }]),
  ASSETS: { fetch: async (req) => new Response("<p>pagina " + new URL(req.url).pathname + "</p>", { headers: { "content-type": "text/html" } }) },
};
env.CLIENTES = { idFromName: (n) => n, get(id) {
  if (!objetos.has(id)) objetos.set(id, new ClienteCobranca({ storage: storage() }, env));
  return { fetch: (url, op) => objetos.get(id).fetch(new Request(url, op)) };
} };
// O registro do e-mail Atos: as Integracoes pedem o alias confirmado e o login por ele (a Maria o tem).
{
  const m = new Map();
  const st = { async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; }, async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); }, async setAlarm() {}, async getAlarm() { return null; } };
  const o = new EmailAtos({ storage: st }, env);
  env.EMAIL_ATOS = { idFromName: (n) => n, get() { return { fetch: (url, op) => o.fetch(new Request(url, op)) }; } };
  const pedir = (op, d) => env.EMAIL_ATOS.get().fetch("https://email-atos/", { method: "POST", body: JSON.stringify({ op, sub: "sub-maria", conta: "maria@exemplo.test", ...d }) });
  await pedir("reservar", { alias: "maria.loja" });
  await pedir("destino_pedir", { destino: "maria@destino.example", hash: "h" });
  await pedir("codigo_conferir", { hash: "h" });
  await pedir("destino_cf", { email: "maria@destino.example", cf_id: "cf1", criado: true, verificado: true });
}
const A = "https://atos.dev.br";
const VERSAO = PRODUTOS.workspace.termos.versao;

async function sessao(email, { idade = 0, alias = "" } = {}) {
  const segredo = "s-" + email + "-" + idade + "-" + alias;
  const sub = "sub-" + email.split("@")[0];
  guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: "Nome " + email.split("@")[0] }));
  await ligarSegundaEtapa(env, sub);
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000) - idade, mfa: true, ...(alias ? { via: "alias", alias } : {}) }));
  return "__Host-atos=" + segredo;
}
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
const b64url = (b) => Buffer.from(b).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, desafio: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}
const consulta = (cliente, volta, desafio) => new URLSearchParams({ client_id: cliente, redirect_uri: volta, response_type: "code", scope: "openid email profile",
  state: "st", nonce: "nn", code_challenge_method: "S256", code_challenge: desafio }).toString();
/* Um login inteiro de quem entra: o pedido, o consentimento, o code e o token. */
async function entrarNo(cookie, cliente, volta) {
  const p = await pkce();
  const ped = await chamar("/api/pedido", { cookie, corpo: { consulta: consulta(cliente, volta, p.desafio) } });
  const aut = await chamar("/api/autorizar", { cookie, corpo: { consulta: consulta(cliente, volta, p.desafio), permitir: true } });
  const code = aut.d && aut.d.ir ? new URL(aut.d.ir).searchParams.get("code") : null;
  const tok = code ? await chamar("/oauth/token", { origem: "", form: { grant_type: "authorization_code", code, redirect_uri: volta, client_id: cliente, code_verifier: p.verifier } }) : null;
  return { pedido: ped, token: tok };
}

const maria = await sessao("maria@exemplo.test", { alias: "maria.loja" });
const mariaVelha = await sessao("maria@exemplo.test", { idade: 13 * 3600, alias: "maria.loja" });
const joao = await sessao("joao@exemplo.test");
const dono = await sessao("dono@atos.dev.br");
const SITE = { nome: "Loja da Maria", descricao: "bolos e doces", site: "https://loja.exemplo.test", privacidade: "https://loja.exemplo.test/privacidade", termos: "https://loja.exemplo.test/termos" };
const VOLTA = "https://loja.exemplo.test/volta";

console.log("o produto no catálogo");
checar(PRODUTOS.workspace && PRODUTOS.workspace.nome === "Atos Workspace" && produtoGratuito("workspace") && !produtoGratuito("pavlvs"), "o Atos Workspace é um produto gratuito do catálogo");
checar(PRODUTOS.workspace.precos.length === 0 && !resolveOffer("workspace.gratis.mes") && !PRODUTOS.workspace.eventos, "sem preço (nada passa pelo Mercado Pago) e sem eventos");
let r = await chamar("/api/cobranca/v1/catalogo/workspace", { metodo: "GET" });
checar(r.status === 200 && r.d.gratuito === true && r.d.precos.length === 0 && catalogoPublico("workspace").nome === "Atos Workspace", "o catálogo público diz gratuito", r.d);

console.log("a área do Workspace");
r = await chamar("/api/workspace", { metodo: "GET" });
checar(r.status === 401 && r.d.entrar, "sem sessão: 401");
r = await chamar("/api/workspace", { metodo: "GET", cookie: maria });
checar(r.status === 200 && r.d.ativo === false && r.d.aceito === null && r.d.termos.versao === VERSAO && r.d.termos.endereco === "/termos/#workspace" && r.d.recente && r.d.apps === 0 &&
  r.d.produto.gratuito === true, "com sessão: não ativado, os termos atuais e nenhum aplicativo", r.d);
for (const pagina of ["/workspace/", "/workspace/integracoes"]) {
  r = await chamar(pagina, { metodo: "GET" });
  checar(r.status === 302 && r.r.headers.get("location") === A + "/workspace/entrar/?volta=" + encodeURIComponent(pagina), pagina + " sem sessão: a tela de entrar do Workspace", r.r.headers.get("location"));
  r = await chamar(pagina, { metodo: "GET", cookie: maria });
  const csp = r.r.headers.get("content-security-policy") || "";
  checar(r.status === 200 && (await r.r.text()).includes("/workspace/") && csp.includes("script-src 'self'") && !csp.includes("cloudflareinsights") && r.r.headers.get("cache-control") === "no-store",
    pagina + " serve a página do Workspace, com a CSP da conta", csp);
}
r = await chamar("/conta/integracoes?x=1", { metodo: "GET" });
checar(r.status === 301 && r.r.headers.get("location") === A + "/workspace/integracoes?x=1", "o endereço antigo /conta/integracoes leva a /workspace/integracoes", r.r.headers.get("location"));
r = await chamar("/conta/assinaturas", { metodo: "GET" });
checar(r.status === 200 && (await r.r.text()).includes("/conta/"), "as outras seções da Minha conta continuam");

console.log("ativar");
r = await chamar("/api/integracoes", { metodo: "GET", cookie: maria });
checar(r.status === 403 && r.d.workspace === false && r.d.erro.includes("ative o Atos Workspace"), "antes: as Integrações respondem 403 com a mensagem", r.d);
r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { aceito: true, versao: VERSAO }, origem: "https://mal.example" });
checar(r.status === 403, "de outra origem: recusado");
r = await chamar("/api/workspace/ativar", { cookie: mariaVelha, corpo: { aceito: true, versao: VERSAO } });
checar(r.status === 401 && r.d.reentrar, "login de mais de 12 horas: pede para entrar de novo", r.d);
r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { versao: VERSAO } });
checar(r.status === 400 && r.d.erro.includes("aceite os termos"), "sem aceitar os termos: recusado", r.d);
r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { aceito: true, versao: "2026-01-01" } });
checar(r.status === 409 && r.d.termos.versao === VERSAO, "aceitando outra versão dos termos: pede a atual", r.d);
r = await chamar("/api/workspace/ativar", { cookie: maria, metodo: "GET" });
checar(r.status === 404 || r.status === 405, "ativar é POST");
r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { aceito: true, versao: VERSAO } });
const ativado = r.d && r.d.ativado;
checar(r.status === 200 && r.d.ativo === true && ativado && r.d.aceito.versao === VERSAO && r.d.aceito.quando && r.d.desativado === null, "ativa: a versão dos termos e a data guardadas", r.d);
r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { aceito: true, versao: VERSAO } });
checar(r.status === 200 && r.d.ativo && r.d.ativado === ativado, "ativar de novo não muda nada");
r = await chamar("/api/cobranca/v1/minhas", { metodo: "GET", cookie: maria });
const dir = r.d.direitos.find((x) => x.produto === "workspace");
checar(dir && dir.ativo && dir.gratuito && dir.termos.versao === VERSAO && dir.historico.length === 1 && dir.historico[0].oque === "ativou" && !dir.ate,
  "no registro do cliente: o direito ao Workspace (o mesmo dos produtos pagos), com o histórico", dir);

console.log("a Minha conta");
r = await chamar("/api/cobranca/v1/conta", { metodo: "GET", cookie: maria });
const g = r.d && r.d.gratuitos && r.d.gratuitos[0];
checar(r.status === 200 && g && g.produto === "workspace" && g.nome === "Atos Workspace" && g.ativo && g.endereco === "/workspace/" && g.termos.versao === VERSAO &&
  !r.d.produtos.some((x) => x.produto === "workspace"), "o Workspace aparece como produto ativo (fora das assinaturas pagas)", r.d);
r = await chamar("/api/cobranca/v1/conta", { metodo: "GET", cookie: joao });
checar(r.status === 200 && r.d.gratuitos[0].ativo === false && r.d.gratuitos[0].termos === null, "para quem não ativou: o Workspace a ativar", r.d.gratuitos);

console.log("as Integrações com o Workspace ativo");
r = await chamar("/api/integracoes/apps", { cookie: maria, corpo: SITE });
const app = r.d && r.d.app;
checar(r.status === 200 && app && app.id, "cria o aplicativo", r.d);
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: maria, corpo: { tipo: "publico", voltas: [VOLTA] } });
const cid = r.d.acesso;
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: maria, corpo: { acao: "liberar", emails: "joao@exemplo.test" } });
checar(r.status === 200 && cid, "o acesso e o João liberado");
let e = await entrarNo(joao, cid, VOLTA);
checar(e.pedido.d.negado === false && e.token && e.token.status === 200 && e.token.d.id_token, "o João entra", e.token && e.token.d);
r = await chamar("/api/workspace", { metodo: "GET", cookie: maria });
checar(r.d.apps === 1, "a área conta o aplicativo");

console.log("desativar");
r = await chamar("/api/workspace/desativar", { cookie: maria, corpo: {} });
checar(r.status === 400 && r.d.erro.includes("confirme"), "sem confirmar: recusado", r.d);
r = await chamar("/api/workspace/desativar", { cookie: mariaVelha, corpo: { confirmar: true } });
checar(r.status === 401 && r.d.reentrar, "login velho: pede para entrar de novo");
r = await chamar("/api/workspace/desativar", { cookie: maria, corpo: { confirmar: true } });
checar(r.status === 200 && r.d.ativo === false && r.d.desativado && r.d.aceito.versao === VERSAO, "desativa (os termos aceitos ficam no registro)", r.d);
r = await chamar("/api/integracoes", { metodo: "GET", cookie: maria });
checar(r.status === 403 && r.d.workspace === false, "as Integrações pedem a ativação: não vê", r.d);
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: maria, corpo: { acao: "acesso", acesso: "todos" } });
checar(r.status === 403 && r.d.workspace === false, "nem muda quem entra");
r = await chamar("/api/integracoes/acessos/" + cid, { cookie: maria, corpo: { acao: "desligar" } });
checar(r.status === 403, "nem desliga um acesso");
e = await entrarNo(joao, cid, VOLTA);
checar(e.pedido.d.negado === false && e.token && e.token.status === 200, "o aplicativo continua funcionando para quem entra (o João entra)", e.token && e.token.d);
const bia = await sessao("bia@fora.example");
e = await entrarNo(bia, cid, VOLTA);
checar(e.pedido.d.negado === true, "e a lista continua valendo (a Bia, fora dela, não entra)", e.pedido.d);
r = await chamar("/api/cobranca/v1/conta", { metodo: "GET", cookie: maria });
checar(r.d.gratuitos[0].ativo === false && r.d.gratuitos[0].desativado, "a Minha conta mostra desativado", r.d.gratuitos);

console.log("o painel da equipe");
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: dono });
let t = r.d && r.d.terceiros && r.d.terceiros.find((x) => x.id === app.id);
checar(r.status === 200 && t && t.dono_workspace && t.dono_workspace.ativo === false && t.dono_workspace.desativado, "Login Atos mostra que a dona está sem o Workspace", t && t.dono_workspace);
checar(t && t.dono === "maria@exemplo.test" && t.dono_sub === "sub-maria" && t.dono_alias_lido && t.dono_alias.endereco === "maria.loja@atos.dev.br" && t.dono_alias.confirmado,
  "e a equipe vê o dono real (e-mail e sub) e o e-mail Atos dele", t);

console.log("reativar");
r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { aceito: true, versao: VERSAO } });
checar(r.status === 200 && r.d.ativo && r.d.ativado !== ativado && r.d.desativado === null, "ativa de novo");
r = await chamar("/api/integracoes", { metodo: "GET", cookie: maria });
checar(r.status === 200 && r.d.apps.length === 1 && r.d.apps[0].liberados.includes("joao@exemplo.test"), "o aplicativo volta inteiro à gestão", r.d);
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: dono });
t = r.d.terceiros.find((x) => x.id === app.id);
checar(t.dono_workspace.ativo === true && t.dono_workspace.ativado, "e o painel mostra ativo");
r = await chamar("/api/cobranca/v1/minhas", { metodo: "GET", cookie: maria });
checar(r.d.direitos.find((x) => x.produto === "workspace").historico.map((x) => x.oque).join(",") === "ativou,desativou,ativou", "o histórico guarda as três mudanças");

console.log("sem o registro dos clientes");
const semObjetos = { ...env, CLIENTES: undefined };
r = await chamar("/api/integracoes", { metodo: "GET", cookie: maria, e: semObjetos });
checar(r.status === 503, "as Integrações não abrem (nem fecham) por engano: 503", r.d);
r = await chamar("/api/workspace", { metodo: "GET", cookie: maria, e: semObjetos });
checar(r.status === 503, "nem a área");

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
