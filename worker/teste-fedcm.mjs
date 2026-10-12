// Teste do "Continuar como" (worker/fedcm.js): a Atos como provedora FedCM. O well-known e a configuracao, a conta
// (Sec-Fetch-Dest exigido, sem sessao, a sessao pelo cookie FedCM, approved_clients), o cliente (privacidade e termos),
// /fedcm/afirmar (origem errada sem CORS, cliente desligado ou bloqueado, sem sessao, outra conta, sem PKCE, fora da
// lista do aplicativo, a primeira vez com a permissao da Atos - continue_on - e a segunda direta), a troca do codigo no
// /oauth/token (PKCE, sem redirect_uri, o segredo do confidencial, uma vez so), o disconnect e o Login Status
// (Set-Login e o cookie FedCM ao abrir e fechar a sessao). Sem rede.
//   node worker/teste-fedcm.mjs
import worker from "./index.js";
import { comSeguranca } from "./apoio-teste-seguranca.mjs";
import { conferirIdToken } from "./oidc.js";
import { comLoginStatus } from "./fedcm.js";
import { sha256 } from "./comum.js";

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
};
globalThis.fetch = async (u) => { throw new Error("fetch inesperado: " + u); };
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };
const env = comSeguranca({ CONTAS, ATOS_CHAVE: JSON.stringify(jwk), ASSETS: { fetch: async () => new Response("<p>pagina</p>", { headers: { "content-type": "text/html" } }) } });
const A = "https://atos.dev.br";
const LOJA = "https://loja.example";
const b64url = (b) => Buffer.from(b).toString("base64url");

// O aplicativo de terceiro da Maria: "liberados" (o Joao na lista), com um acesso publico (origem e volta da loja), um
// confidencial (so a volta) e um desligado.
const APP = "u-lojamaria1";
const PUB = APP + "-pub001", CONF = APP + "-conf01", DESL = APP + "-desl01";
const SEGREDO = "segredo-do-confidencial";
function gravarApp(extra = {}) {
  guardados.set("atos:oidc:app:" + APP, JSON.stringify({
    id: APP, nome: "Loja da Maria", descricao: "bolos e doces", site: LOJA, privacidade: LOJA + "/privacidade", termos: LOJA + "/termos", icone: "",
    criado: "2026-01-01T00:00:00.000Z", dono: { sub: "sub-maria", email: "maria@exemplo.test" }, acesso: "liberados", liberados: ["joao@exemplo.test"],
    clientes: {
      [PUB]: { tipo: "publico", voltas: [LOJA + "/retorno"], origens: [LOJA], ativo: true },
      [CONF]: { tipo: "confidencial", voltas: ["https://srv.loja.example/auth/volta"], origens: [], ativo: true },
      [DESL]: { tipo: "publico", voltas: [LOJA + "/x"], origens: [LOJA], ativo: false },
    },
    ...extra,
  }));
}
gravarApp();
guardados.set("atos:oidc:segredo:" + CONF, JSON.stringify({ hash: await sha256(SEGREDO) }));

const pessoas = {};
async function sessao(nome) {
  const email = nome + "@exemplo.test", sub = "sub-" + nome, segredo = "s-" + nome + "-" + Math.random().toString(36).slice(2);
  guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: nome[0].toUpperCase() + nome.slice(1) + " Exemplo" }));
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000), criada: Date.now(), amr: ["pwd", "mfa"], mfa: true }));
  pessoas[nome] = { email, sub, cookie: "__Host-atos=" + segredo };
  return pessoas[nome];
}
async function chamar(caminho, { metodo = "GET", corpo, form, cookie, origem, headers = {} } = {}) {
  const h = { ...headers };
  if (origem) h.origin = origem;
  if (cookie) h.cookie = cookie;
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
  else if (corpo !== undefined) { body = JSON.stringify(corpo); h["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body }), env);
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d, r, h: r.headers };
}
const WI = { "sec-fetch-dest": "webidentity" };
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, desafio: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}
/* O cookie FedCM de `p` (pela /api/fedcm/ligar, como a janela do login_url faz com a sessao de antes). */
async function ligar(p) {
  const r = await chamar("/api/fedcm/ligar", { metodo: "POST", corpo: {}, cookie: p.cookie, origem: A });
  const c = r.r.headers.getSetCookie().find((x) => x.startsWith("__Host-atos-fedcm="));
  p.fedcm = c ? c.split(";")[0] : "";
  return r;
}
const afirmar = (p, campos, { origem = LOJA, headers = WI, cookie } = {}) =>
  chamar("/fedcm/afirmar", { metodo: "POST", form: { client_id: PUB, account_id: p.sub, disclosure_text_shown: "false", is_auto_selected: "false", ...campos }, cookie: cookie === undefined ? p.fedcm : cookie, origem, headers });
const paramsCom = (desafio, extra = {}) => JSON.stringify({ nonce: "n-123", code_challenge: desafio, code_challenge_method: "S256", ...extra });

const joao = await sessao("joao");
const pedro = await sessao("pedro");

console.log("o well-known e a configuração");
let r = await chamar("/.well-known/web-identity");
checar(r.status === 200 && r.d.provider_urls[0] === A + "/fedcm/config.json" && r.d.accounts_endpoint === A + "/fedcm/contas" && r.d.login_url === A + "/entrar/?fedcm=entrar"
  && /application\/json/.test(r.h.get("content-type")), "o well-known: provider_urls, accounts_endpoint e login_url", r.d);
const cfg = (await chamar("/fedcm/config.json")).d;
checar(cfg.accounts_endpoint === r.d.accounts_endpoint && cfg.login_url === r.d.login_url && cfg.id_assertion_endpoint === A + "/fedcm/afirmar" && cfg.disconnect_endpoint === A + "/fedcm/desconectar"
  && cfg.client_metadata_endpoint === A + "/fedcm/cliente" && cfg.branding.icons[0].url.endsWith(".png") && cfg.branding.icons[0].size >= 40, "a configuração (os mesmos endereços do well-known, o ícone PNG)", cfg);

console.log("o cliente");
r = await chamar("/fedcm/cliente?client_id=" + PUB);
checar(r.status === 200 && r.d.privacy_policy_url === LOJA + "/privacidade" && r.d.terms_of_service_url === LOJA + "/termos", "a política e os termos do aplicativo", r.d);
checar((await chamar("/fedcm/cliente?client_id=" + DESL)).status === 404 && (await chamar("/fedcm/cliente?client_id=u-naoexiste-aaaaaa")).status === 404, "desligado ou desconhecido: 404");

console.log("a conta");
await ligar(joao);
await ligar(pedro);
checar(joao.fedcm.startsWith("__Host-atos-fedcm=") && !joao.fedcm.includes(joao.cookie.split("=")[1]), "a /api/fedcm/ligar dá o cookie FedCM, com outro segredo", joao.fedcm);
const lig = await chamar("/api/fedcm/ligar", { metodo: "POST", corpo: {}, cookie: joao.cookie, origem: A });
const cookieLig = lig.r.headers.getSetCookie().find((x) => x.startsWith("__Host-atos-fedcm="));
checar(/SameSite=None/.test(cookieLig) && /HttpOnly/.test(cookieLig) && /Secure/.test(cookieLig) && lig.h.get("set-login") === "logged-in", "o cookie FedCM é SameSite=None, HttpOnly e Secure, com Set-Login: logged-in", cookieLig);
checar((await chamar("/api/fedcm/ligar", { metodo: "POST", corpo: {}, cookie: joao.cookie, origem: LOJA })).status === 403, "a /api/fedcm/ligar só da própria Atos");
checar((await chamar("/api/fedcm/ligar", { metodo: "POST", corpo: {}, origem: A })).status === 401, "a /api/fedcm/ligar sem sessão: 401");
r = await chamar("/fedcm/contas", { cookie: joao.fedcm });
checar(r.status === 400, "sem Sec-Fetch-Dest: webidentity, a conta não sai", r.d);
r = await chamar("/fedcm/contas", { headers: WI });
checar(r.status === 401, "sem sessão: 401");
r = await chamar("/fedcm/contas", { headers: WI, cookie: joao.cookie });
checar(r.status === 401, "o cookie Lax da sessão (__Host-atos) não serve aqui: só o FedCM");
r = await chamar("/fedcm/contas", { headers: WI, cookie: joao.fedcm });
const conta = r.d && r.d.accounts && r.d.accounts[0];
checar(r.status === 200 && r.d.accounts.length === 1 && conta.id === "sub-joao" && conta.email === "joao@exemplo.test" && conta.name === "Joao Exemplo" && Array.isArray(conta.approved_clients)
  && conta.approved_clients.length === 0 && !("picture" in conta), "a conta: id = sub, nome, e-mail, approved_clients vazio (ainda não permitiu)", r.d);

console.log("/fedcm/afirmar: as recusas");
const pk = await pkce();
r = await afirmar(joao, { params: paramsCom(pk.desafio) }, { headers: {} });
checar(r.status === 400 && !r.d.token, "sem Sec-Fetch-Dest: recusado", r.d);
r = await afirmar(joao, { params: paramsCom(pk.desafio) }, { origem: "https://golpe.example" });
checar(r.status === 400 && !r.d.token && !r.h.get("access-control-allow-origin"), "origem que não é do acesso: recusado e sem CORS", r.d);
r = await afirmar(joao, { client_id: CONF, params: paramsCom(pk.desafio) }, { origem: "https://srv.loja.example" });
checar(r.status === 200 && r.d.continue_on, "a origem da volta cadastrada vale (o acesso confidencial)", r.d);
r = await afirmar(joao, { client_id: DESL, params: paramsCom(pk.desafio) });
checar(r.status === 400 && r.d.error.code === "invalid_client" && !r.d.token, "acesso desligado: invalid_client", r.d);
r = await afirmar(joao, { params: paramsCom(pk.desafio) }, { cookie: "" });
checar(r.status === 401 && r.d.error.code === "login_required" && r.h.get("access-control-allow-origin") === LOJA && r.h.get("access-control-allow-credentials") === "true", "sem sessão: login_required (com CORS da origem certa, nunca *)", r.d);
r = await afirmar(joao, { account_id: "sub-pedro", params: paramsCom(pk.desafio) });
checar(r.status === 400 && !r.d.token, "account_id de outra conta: recusado", r.d);
r = await afirmar(joao, { params: JSON.stringify({ nonce: "n" }) });
checar(r.status === 400 && r.d.error.code === "invalid_request", "sem o code_challenge (PKCE): invalid_request", r.d);
r = await afirmar(joao, { params: paramsCom(pk.desafio, { code_challenge_method: "plain" }) });
checar(r.status === 400, "PKCE plain: recusado");
r = await afirmar(joao, { params: paramsCom(pk.desafio), nonce: "outro" });
checar(r.status === 400, "nonce no campo e em params, diferentes: recusado");
r = await afirmar(joao, { params: "{nao e json" });
checar(r.status === 400, "params que não é JSON: recusado");
r = await afirmar(pedro, { params: paramsCom(pk.desafio) });
checar(r.status === 403 && r.d.error.code === "access_denied" && !r.d.token && !r.d.continue_on, "fora da lista do aplicativo (modo liberados): access_denied, nada para o site", r.d);

console.log("a primeira vez: a permissão da Atos (continue_on)");
r = await afirmar(joao, { params: paramsCom(pk.desafio), disclosure_text_shown: "true" });
checar(r.status === 200 && !r.d.token && /^https:\/\/atos\.dev\.br\/entrar\/\?fedcm_pedido=[A-Za-z0-9_-]{32}$/.test(r.d.continue_on), "sem permissão, mesmo com o aviso do navegador: continue_on para a tela da Atos", r.d);
const pedido = new URL(r.d.continue_on).searchParams.get("fedcm_pedido");
r = await chamar("/api/fedcm/continuar", { metodo: "POST", corpo: { pedido }, cookie: pedro.cookie, origem: A });
checar(r.status === 409, "a janela com outra conta aberta: recusado", r.d);
r = await chamar("/api/fedcm/continuar", { metodo: "POST", corpo: { pedido }, cookie: joao.cookie, origem: LOJA });
checar(r.status === 403, "a /api/fedcm/continuar só da própria Atos");
r = await chamar("/api/fedcm/continuar", { metodo: "POST", corpo: { pedido }, cookie: joao.cookie, origem: A });
checar(r.status === 200 && r.d.app.nome === "Loja da Maria" && r.d.app.terceiro && r.d.origem === LOJA && r.d.escopos.length === 3 && r.d.conta.email === "joao@exemplo.test",
  "a tela: o aplicativo (de terceiro), o site que pediu, o que ele recebe e a conta", r.d);
r = await chamar("/api/fedcm/continuar", { metodo: "POST", corpo: { pedido, permitir: true }, cookie: joao.cookie, origem: A });
const codigo1 = r.d && r.d.token;
checar(r.status === 200 && typeof codigo1 === "string" && codigo1.length >= 40, "permitindo: o código (que o navegador entrega ao site)", r.d);
checar(JSON.parse(guardados.get("atos:apps:sub-joao"))[APP].escopos.length === 3, "a permissão fica guardada, como no login de sempre");
r = await chamar("/api/fedcm/continuar", { metodo: "POST", corpo: { pedido, permitir: true }, cookie: joao.cookie, origem: A });
checar(r.status === 400 && !r.d.token, "o pedido vale uma vez só");

console.log("a troca do código no /oauth/token");
const trocar = (code, extra = {}, h = {}) => chamar("/oauth/token", { metodo: "POST", form: { grant_type: "authorization_code", code, client_id: PUB, code_verifier: pk.verifier, ...extra }, origem: LOJA, headers: h });
r = await trocar(codigo1, { redirect_uri: LOJA + "/retorno" });
checar(r.status === 400 && r.d.error === "invalid_grant", "com redirect_uri: invalid_grant (o código do FedCM não é de volta nenhuma)", r.d);
const r2 = await afirmar(joao, { params: paramsCom(pk.desafio) });
checar(r2.status === 200 && typeof r2.d.token === "string" && r2.h.get("access-control-allow-origin") === LOJA && r2.h.get("access-control-allow-credentials") === "true",
  "a segunda vez (já permitiu): o código direto, com CORS da origem", r2.d);
r = await trocar(r2.d.token, { code_verifier: (await pkce()).verifier });
checar(r.status === 400 && r.d.error === "invalid_grant", "outro code_verifier: invalid_grant", r.d);
const pk3 = await pkce();
const r3 = await afirmar(joao, { params: paramsCom(pk3.desafio, { nonce: "n-xyz" }) });
r = await trocar(r3.d.token, { code_verifier: pk3.verifier });
const corpo = r.d && r.d.id_token ? await conferirIdToken(env, r.d.id_token) : null;
checar(r.status === 200 && corpo && corpo.aud === PUB && corpo.sub === "sub-joao" && corpo.nonce === "n-xyz" && corpo.email === "joao@exemplo.test" && corpo.iss === A && r.d.access_token,
  "o código certo: id_token ES256 com aud, nonce e sub, e o access_token", corpo);
r = await trocar(r3.d.token, { code_verifier: pk3.verifier });
checar(r.status === 400, "o mesmo código de novo: recusado");

console.log("o confidencial: o segredo continua obrigatório");
const pkc = await pkce();
const rc = await afirmar(joao, { client_id: CONF, params: paramsCom(pkc.desafio) }, { origem: "https://srv.loja.example" });
checar(rc.status === 200 && typeof rc.d.token === "string", "o código do acesso confidencial (a permissão é por aplicativo)", rc.d);
const trocarConf = (extra) => chamar("/oauth/token", { metodo: "POST", form: { grant_type: "authorization_code", code: rc.d.token, code_verifier: pkc.verifier, ...extra } });
r = await trocarConf({ client_id: CONF });
checar(r.status === 401 && r.d.error === "invalid_client", "sem o client_secret: invalid_client", r.d);
const rc2 = await afirmar(joao, { client_id: CONF, params: paramsCom(pkc.desafio) }, { origem: "https://srv.loja.example" });
r = await chamar("/oauth/token", { metodo: "POST", form: { grant_type: "authorization_code", code: rc2.d.token, code_verifier: pkc.verifier, client_id: CONF, client_secret: SEGREDO } });
checar(r.status === 200 && r.d.id_token, "com o segredo e o PKCE: o id_token", r.d);

console.log("a conta depois de permitir, a lista e o bloqueio");
r = await chamar("/fedcm/contas", { headers: WI, cookie: joao.fedcm });
checar(r.d.accounts[0].approved_clients.includes(PUB) && r.d.accounts[0].approved_clients.includes(CONF) && !r.d.accounts[0].approved_clients.includes(DESL), "approved_clients: os acessos ligados do aplicativo permitido", r.d);
gravarApp({ liberados: [] });
const pk4 = await pkce();
r = await afirmar(joao, { params: paramsCom(pk4.desafio) });
checar(r.status === 403 && r.d.error.code === "access_denied", "tirado da lista: access_denied na hora, mesmo com a permissão", r.d);
gravarApp({ acesso: "todos", liberados: [] });
r = await afirmar(pedro, { params: paramsCom(pk4.desafio) });
checar(r.status === 200 && r.d.continue_on, "modo \"qualquer Conta Atos\": o Pedro entra (pela permissão da Atos)", r.d);
gravarApp({ bloqueado: true });
r = await afirmar(joao, { params: paramsCom(pk4.desafio) });
checar(r.status === 400 && r.d.error.code === "invalid_client" && !r.d.token, "aplicativo bloqueado pela Atos: invalid_client", r.d);
gravarApp();

console.log("o disconnect");
r = await chamar("/fedcm/desconectar", { metodo: "POST", form: { client_id: PUB, account_hint: "joao@exemplo.test" }, cookie: joao.fedcm, origem: LOJA });
checar(r.status === 400, "sem Sec-Fetch-Dest: recusado");
r = await chamar("/fedcm/desconectar", { metodo: "POST", form: { client_id: PUB, account_hint: "joao@exemplo.test" }, cookie: joao.fedcm, origem: "https://golpe.example", headers: WI });
checar(r.status === 400 && !r.h.get("access-control-allow-origin") && JSON.parse(guardados.get("atos:apps:sub-joao"))[APP], "de outra origem: recusado, e a permissão fica");
r = await chamar("/fedcm/desconectar", { metodo: "POST", form: { client_id: PUB, account_hint: "joao@exemplo.test" }, cookie: joao.fedcm, origem: LOJA, headers: WI });
checar(r.status === 200 && r.d.account_id === "sub-joao" && r.h.get("access-control-allow-origin") === LOJA && !JSON.parse(guardados.get("atos:apps:sub-joao"))[APP],
  "da origem certa: a permissão do aplicativo sai, e volta o account_id", r.d);
r = await afirmar(joao, { params: paramsCom(pk4.desafio) });
checar(r.status === 200 && r.d.continue_on && !r.d.token, "depois do disconnect, a permissão é pedida de novo");

console.log("o Login Status (Set-Login) e o cookie FedCM ao abrir e fechar a sessão");
const aberta = await comLoginStatus(new Response("{}", { headers: { "set-cookie": "__Host-atos=segredo-novo-123; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax" } }), env, new Request(A));
const novos = aberta.headers.getSetCookie();
const fed = novos.find((c) => c.startsWith("__Host-atos-fedcm="));
const mapa = fed ? JSON.parse(guardados.get("atos:fedcm:sessao:" + (await sha256(fed.split(";")[0].split("=")[1])))) : null;
checar(aberta.headers.get("set-login") === "logged-in" && novos.length === 2 && mapa && mapa.h === (await sha256("segredo-novo-123")), "sessão aberta: Set-Login logged-in e o cookie FedCM ligado a ela", novos);
const etapa = await comLoginStatus(new Response("{}", { headers: { "set-cookie": "__Host-atos-etapa=x; Path=/; Max-Age=300" } }), env, new Request(A));
checar(!etapa.headers.get("set-login") && etapa.headers.getSetCookie().length === 1, "o cookie da segunda etapa não abre nada (sem Set-Login)");
r = await chamar("/api/sair", { metodo: "POST", corpo: {}, cookie: joao.cookie + "; " + joao.fedcm, origem: A });
checar(r.status === 200 && r.h.get("set-login") === "logged-out" && r.r.headers.getSetCookie().some((c) => /^__Host-atos-fedcm=;.*Max-Age=0/.test(c)), "sair: Set-Login logged-out e o cookie FedCM apagado", r.r.headers.getSetCookie());
r = await chamar("/fedcm/contas", { headers: WI, cookie: joao.fedcm });
checar(r.status === 401, "depois de sair, o cookie FedCM antigo não lista mais a conta");
guardados.delete("atos:sessao:" + (await sha256(pedro.cookie.split("=")[1])));
r = await chamar("/fedcm/contas", { headers: WI, cookie: pedro.fedcm });
checar(r.status === 401, "sessão fechada em outro lugar (\"Sair desta sessão\"): o cookie FedCM cai junto");

console.log(falhas ? "\n" + falhas + " FALHA(S)" : "\ntudo ok");
process.exit(falhas ? 1 : 0);
