// Teste do Login Atos: os aplicativos e clientes do "Entrar com Atos" cadastrados no painel (worker/oidc-painel.js,
// pela fila da Atos) e o login com eles (worker/oidc.js): validacoes, cliente publico com PKCE, confidencial com
// segredo (basic e post), desligar, apagar, retroagir, os fixos intactos e o prefixo do Worker de teste. Sem rede.
//   node worker/teste-oauth.mjs
import worker from "./index.js";
import { conferirIdToken } from "./oidc.js";
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
const env = {
  CONTAS, ATOS_CHAVE: JSON.stringify(jwk),
  ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }, { email: "fin@atos.dev.br", nome: "Fin", papel: "financeiro" }]),
  ASSETS: { fetch: async () => new Response("<p>pagina</p>", { headers: { "content-type": "text/html" } }) },
};
const envT = { ...env, AMBIENTE: "teste" };
const A = "https://atos.dev.br";

async function sessao(email) {
  const segredo = "s-" + email;
  guardados.set("id:conta:" + email, JSON.stringify({ sub: "sub-" + email.split("@")[0], nome: "Nome " + email.split("@")[0] }));
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub: "sub-" + email.split("@")[0], email, auth_time: Math.floor(Date.now() / 1000) }));
  return "__Host-atos=" + segredo;
}
async function chamar(caminho, { metodo = "POST", corpo, form, cookie, origem = A, headers = {}, e = env } = {}) {
  const h = { ...headers };
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
const dono = await sessao("dono@atos.dev.br");
const fin = await sessao("fin@atos.dev.br");
const joao = await sessao("joao@escritorio.adv.br");
const fila = (tipo, dados, e = env) => chamar("/api/admin/alteracoes", { cookie: dono, corpo: { tela: "oauth", tipo, alvo: dados.id || "", dados, texto: tipo + " " + (dados.acao || "") + " " + (dados.id || "") }, e });
const publicar = (e = env) => chamar("/api/admin/publicar", { cookie: dono, corpo: { confirmacao: "comitar e pushar" }, e });
const b64url = (b) => Buffer.from(b).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, desafio: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}
const consulta = (cliente, volta, desafio, extra = {}) => new URLSearchParams({ client_id: cliente, redirect_uri: volta, response_type: "code", scope: "openid email profile",
  state: "st", nonce: "nn", code_challenge_method: "S256", code_challenge: desafio, ...extra }).toString();
/* O caminho todo ate o codigo: o pedido e o permitir (a sessao do joao). */
async function codigoPara(cliente, volta, e = env) {
  const p = await pkce();
  const r = await chamar("/api/autorizar", { cookie: joao, corpo: { consulta: consulta(cliente, volta, p.desafio), permitir: true }, e });
  return { ...p, code: r.d && r.d.ir ? new URL(r.d.ir).searchParams.get("code") : null, r };
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const APP = { acao: "criar", id: "plantare", nome: "Plantare Maps", descricao: "mapas de plantio", site: "https://plantare.example", privacidade: "https://plantare.example/privacidade",
  termos: "https://plantare.example/termos", icone: PNG, liberados: ["Joao@Escritorio.adv.br"] };
const WEB = "https://plantare.example/entrar/volta";
const SRV = "https://plantare.example/srv/volta";

console.log("a tela e quem pode");
let r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: dono });
checar(r.status === 200 && r.d.apps.length === 1 && r.d.apps[0].id === "pavlvs" && r.d.apps[0].codigo && r.d.clientes.length === 3 && r.d.clientes.every((c) => c.codigo),
  "o dono vê os fixos do código (o PAVLVS e os três clientes dele)", r.d);
checar(r.d.descoberta === A + "/.well-known/openid-configuration" && r.d.token === A + "/oauth/token" && r.d.token_s === 3600 && r.d.escopos.length === 3, "e o que precisa para integrar");
checar(r.d.clientes.find((c) => c.id === "pavlvs-escritorio").padrao.includes("paulus.ia.br"), "o cliente do escritório mostra o padrão da volta");
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: fin });
checar(r.status === 403, "o financeiro não vê o Login Atos");
r = await chamar("/api/admin/alteracoes", { cookie: fin, corpo: { tipo: "oauth.app", dados: APP } });
checar(r.status === 403, "nem põe na fila");
r = await chamar("/api/admin/oauth/clientes/x-y-z/segredo", { cookie: fin, corpo: { confirmar: true } });
checar(r.status === 403, "nem gera segredo");

console.log("validações do aplicativo");
const recusa = async (tipo, dados, trecho, texto) => { const x = await fila(tipo, dados); checar(x.status === 400 && (!trecho || String(x.d.erro).includes(trecho)), texto, x.d); };
await recusa("oauth.app", { ...APP, id: "pavlvs" }, "do código", "o id de um aplicativo do código: recusado");
await recusa("oauth.app", { ...APP, id: "Plantare!" }, "id", "id fora do formato: recusado");
await recusa("oauth.app", { ...APP, site: "http://plantare.example" }, "https", "site sem https: recusado");
await recusa("oauth.app", { ...APP, privacidade: "" }, "privacidade", "sem política de privacidade: recusado");
await recusa("oauth.app", { ...APP, icone: "https://plantare.example/icone.png" }, "ícone", "ícone de fora (a CSP de /entrar não carrega): recusado");
await recusa("oauth.app", { ...APP, icone: "data:image/svg+xml;base64,PHN2Zz4=" }, "ícone", "ícone SVG: recusado");
await recusa("oauth.app", { ...APP, acao: "editar" }, "não existe", "editar o que não existe: recusado");
await recusa("oauth.cliente", { acao: "criar", id: "plantare-web", app: "plantare", tipo: "publico", voltas: [WEB] }, "não existe", "cliente de aplicativo que ainda não existe (na fila não conta): recusado");
await recusa("oauth.app", { ...APP, id: "u-abcdefghij" }, "Minha conta", "id com u- (dos aplicativos da Minha conta): recusado");
await recusa("oauth.app", { ...APP, liberados: ["não é e-mail"] }, "e-mail", "lista de liberados com e-mail inválido: recusada");
r = await fila("oauth.app", APP);
checar(r.status === 200 && !guardados.has("atos:oidc:registro"), "o aplicativo entra na fila; nada muda antes de publicar");
r = await publicar();
const plantare = JSON.parse(guardados.get("atos:oidc:registro")).apps.plantare;
checar(r.d.ok && plantare.nome === "Plantare Maps" && plantare.acesso === "liberados" && plantare.liberados.join() === "joao@escritorio.adv.br",
  "publicado: o aplicativo vai para o KV, só para os liberados (o e-mail normalizado)", plantare);
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: dono });
checar(r.d.apps.find((a) => a.id === "plantare").acesso === "liberados" && r.d.apps.find((a) => a.id === "pavlvs").acesso === "todos" && Array.isArray(r.d.terceiros),
  "a tela mostra quem pode entrar (o PAVLVS: qualquer Conta Atos) e a lista de terceiros", r.d.apps);

console.log("validações do cliente");
const CW = { acao: "criar", id: "plantare-web", app: "plantare", tipo: "publico", voltas: [WEB], origens: ["https://plantare.example"] };
await recusa("oauth.cliente", { ...CW, id: "pavlvs-site" }, "do código", "o client_id de um fixo: recusado");
await recusa("oauth.cliente", { ...CW, voltas: ["http://plantare.example/volta"] }, "volta", "volta http fora do loopback: recusada");
await recusa("oauth.cliente", { ...CW, voltas: [WEB + "#x"] }, "volta", "volta com fragmento: recusada");
await recusa("oauth.cliente", { ...CW, voltas: ["https://eu:senha@plantare.example/v"] }, "volta", "volta com usuário e senha: recusada");
await recusa("oauth.cliente", { ...CW, voltas: ["http://localhost:3000/v"] }, "volta", "localhost (só 127.0.0.1 ou [::1]): recusado");
await recusa("oauth.cliente", { ...CW, voltas: [] }, "volta", "sem volta e sem loopback: recusado");
await recusa("oauth.cliente", { ...CW, origens: ["https://plantare.example/caminho"] }, "origem", "origem com caminho: recusada");
await recusa("oauth.cliente", { ...CW, tipo: "secreto" }, "tipo", "tipo desconhecido: recusado");
checar((await fila("oauth.cliente", CW)).status === 200, "o cliente público (página)");
checar((await fila("oauth.cliente", { acao: "criar", id: "plantare-srv", app: "plantare", tipo: "confidencial", voltas: [SRV] })).status === 200, "o confidencial (servidor)");
checar((await fila("oauth.cliente", { acao: "criar", id: "plantare-app", app: "plantare", tipo: "publico", loopback: true, voltas: ["http://127.0.0.1:8765/volta"] })).status === 200,
  "o programa instalado (loopback)");
r = await publicar();
checar(r.d.ok && r.d.publicacao.n === 3, "publicados os três", r.d);
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: dono });
const cSrv = r.d.clientes.find((c) => c.id === "plantare-srv");
checar(r.d.apps.some((a) => a.id === "plantare" && !a.codigo && a.icone === PNG) && cSrv && cSrv.tipo === "confidencial" && cSrv.segredo === null && cSrv.ativo,
  "a tela lista os do KV (o confidencial ainda sem segredo)", r.d.clientes);

console.log("login com o cliente público do KV");
let p = await pkce();
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("plantare-web", WEB, p.desafio) } });
checar(r.status === 200 && r.d.app.nome === "Plantare Maps" && r.d.app.icone === PNG && r.d.permitido === false && !r.d.app.daAtos, "/entrar mostra o aplicativo e pede a permissão", r.d);
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("plantare-web", WEB + "x", p.desafio) } });
checar(r.status === 400, "volta que não é exatamente a cadastrada: recusada");
let cod = await codigoPara("plantare-web", WEB);
r = await chamar("/oauth/token", { origem: "https://plantare.example", form: { grant_type: "authorization_code", code: cod.code, redirect_uri: WEB, client_id: "plantare-web", code_verifier: cod.verifier } });
checar(r.status === 200 && r.d.id_token && r.r.headers.get("access-control-allow-origin") === "https://plantare.example", "o código vira tokens, com CORS para a origem cadastrada", r.d);
const info = await conferirIdToken(env, r.d.id_token);
checar(info && info.aud === "plantare-web" && info.iss === A && info.nonce === "nn" && info.sub === "sub-joao", "id_token ES256 com aud do cliente", info);
const acessoWeb = r.d.access_token;
r = await chamar("/api/apps", { metodo: "GET", cookie: joao });
checar(r.d.apps.some((a) => a.nome === "Plantare Maps" && a.icone === PNG), "a Minha conta lista o aplicativo (para revogar)", r.d);
cod = await codigoPara("plantare-web", WEB);
r = await chamar("/oauth/token", { form: { grant_type: "authorization_code", code: cod.code, redirect_uri: WEB, client_id: "plantare-web", code_verifier: cod.verifier, client_secret: "qualquer" } });
checar(r.status === 401 && r.d.error === "invalid_client", "cliente público com client_secret: recusado", r.d);
p = await pkce();
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("plantare-app", "http://127.0.0.1:50123/qualquer", p.desafio) } });
checar(r.status === 200 && r.d.permitido === true, "o programa (loopback) volta a qualquer porta de 127.0.0.1, já com a permissão do aplicativo", r.d);

console.log("quem pode entrar (aplicativo da equipe)");
const maria = await sessao("maria@outra.com.br");
p = await pkce();
r = await chamar("/api/pedido", { cookie: maria, corpo: { consulta: consulta("plantare-web", WEB, p.desafio) } });
checar(r.status === 200 && r.d.negado === true && r.d.permitido === false && r.d.voltar.includes("error=access_denied"), "fora da lista: /entrar recusa antes do consentimento", r.d);
r = await chamar("/api/autorizar", { cookie: maria, corpo: { consulta: consulta("plantare-web", WEB, p.desafio), permitir: true } });
checar(r.status === 403 && !r.d.ir, "e o permitir não emite código", r.d);
r = await chamar("/api/pedido", { cookie: dono, corpo: { consulta: consulta("plantare-web", WEB, p.desafio) } });
checar(r.status === 200 && r.d.negado === false, "quem criou o aplicativo (o por) entra sem estar na lista", r.d);
checar((await fila("oauth.app", { ...APP, acao: "editar", acesso: "todos", liberados: [] })).status === 200 && (await publicar()).d.ok, "a equipe abre o cadastro (pela fila)");
r = await chamar("/api/pedido", { cookie: maria, corpo: { consulta: consulta("plantare-web", WEB, p.desafio) } });
checar(r.status === 200 && r.d.negado === false, "qualquer Conta Atos: a maria entra", r.d);
checar((await fila("oauth.app", { ...APP, acao: "editar" })).status === 200 && (await publicar()).d.ok, "e fecha de novo (só os liberados)");

console.log("o confidencial: o segredo");
cod = await codigoPara("plantare-srv", SRV);
const formSrv = (extra) => ({ grant_type: "authorization_code", code: cod.code, redirect_uri: SRV, code_verifier: cod.verifier, ...extra });
r = await chamar("/oauth/token", { origem: "", form: formSrv({ client_id: "plantare-srv" }) });
checar(r.status === 401 && r.d.error === "invalid_client", "sem segredo: invalid_client", r.d);
r = await chamar("/api/admin/oauth/clientes/plantare-srv/segredo", { cookie: dono, corpo: {} });
checar(r.status === 400, "gerar sem confirmar: recusado");
r = await chamar("/api/admin/oauth/clientes/plantare-web/segredo", { cookie: dono, corpo: { confirmar: true } });
checar(r.status === 400 && r.d.erro.includes("público"), "cliente público não tem segredo");
r = await chamar("/api/admin/oauth/clientes/pavlvs-site/segredo", { cookie: dono, corpo: { confirmar: true } });
checar(r.status === 400, "nem os do código");
r = await chamar("/api/admin/oauth/clientes/plantare-srv/segredo", { cookie: dono, corpo: { confirmar: true }, origem: "https://mal.example" });
checar(r.status === 403, "de outra origem: recusado");
r = await chamar("/api/admin/oauth/clientes/plantare-srv/segredo", { cookie: dono, corpo: { confirmar: true } });
const segredo1 = r.d.segredo;
checar(r.status === 200 && /^atos_cs_[A-Za-z0-9_-]{43}$/.test(segredo1) && !r.d.trocado, "gerado na hora, mostrado uma vez", r.d);
checar(![...guardados.values()].some((v) => String(v).includes(segredo1)) && JSON.parse(guardados.get("atos:oidc:segredo:plantare-srv")).hash === (await sha256(segredo1)),
  "no KV fica só o hash");
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: dono });
const sTela = r.d.clientes.find((c) => c.id === "plantare-srv").segredo;
checar(sTela && sTela.por === "dono@atos.dev.br" && sTela.quando && !JSON.stringify(r.d).includes("hash"), "a tela diz quem gerou e quando, sem o hash", sTela);
r = await chamar("/api/admin/oauth/log", { metodo: "GET", cookie: dono });
checar(r.d.log[0].cliente === "plantare-srv" && r.d.log[0].acao === "gerou o segredo", "e fica no registro", r.d);
const basic = (id, s) => "Basic " + Buffer.from(encodeURIComponent(id) + ":" + encodeURIComponent(s)).toString("base64");
r = await chamar("/oauth/token", { origem: "", form: formSrv({}), headers: { authorization: basic("plantare-srv", "errado") } });
checar(r.status === 401 && r.d.error === "invalid_client" && r.r.headers.get("www-authenticate"), "segredo errado (basic): 401 com WWW-Authenticate", r.d);
r = await chamar("/oauth/token", { origem: "", form: formSrv({ client_id: "plantare-srv", client_secret: segredo1 }), headers: { authorization: basic("plantare-srv", segredo1) } });
checar(r.status === 400 && r.d.error === "invalid_request", "o segredo dos dois jeitos: recusado", r.d);
r = await chamar("/oauth/token", { origem: "", form: formSrv({ code_verifier: "x".repeat(43) }), headers: { authorization: basic("plantare-srv", segredo1) } });
checar(r.status === 400 && r.d.error === "invalid_grant", "segredo certo, mas o verifier errado: o PKCE vale para o confidencial também", r.d);
cod = await codigoPara("plantare-srv", SRV);
r = await chamar("/oauth/token", { origem: "", form: formSrv({}), headers: { authorization: basic("plantare-srv", segredo1) } });
checar(r.status === 200 && r.d.id_token, "client_secret_basic certo: tokens", r.d);
cod = await codigoPara("plantare-srv", SRV);
r = await chamar("/oauth/token", { origem: "", form: formSrv({ client_id: "plantare-srv", client_secret: segredo1 }) });
checar(r.status === 200 && r.d.id_token, "client_secret_post certo: tokens", r.d);
r = await chamar("/api/admin/oauth/clientes/plantare-srv/segredo", { cookie: dono, corpo: { confirmar: true } });
const segredo2 = r.d.segredo;
checar(r.d.trocado && segredo2 !== segredo1, "trocar o segredo");
cod = await codigoPara("plantare-srv", SRV);
r = await chamar("/oauth/token", { origem: "", form: formSrv({ client_id: "plantare-srv", client_secret: segredo1 }) });
checar(r.status === 401, "o segredo antigo para de valer na hora");
r = await chamar("/oauth/token", { origem: "", form: formSrv({ client_id: "plantare-srv", client_secret: segredo2 }) });
checar(r.status === 200, "o novo vale (e o código não morreu com a tentativa errada)");
r = await chamar("/.well-known/openid-configuration", { metodo: "GET" });
checar(r.d.token_endpoint_auth_methods_supported.join() === "none,client_secret_basic,client_secret_post", "a descoberta diz os três métodos");

console.log("desligar, apagar e retroagir");
const codAntes = await codigoPara("plantare-web", WEB);
checar((await fila("oauth.cliente", { acao: "desligar", id: "plantare-web" })).status === 200 && (await publicar()).d.ok, "desligar o cliente");
p = await pkce();
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("plantare-web", WEB, p.desafio) } });
checar(r.status === 400 && r.d.erro.includes("desligado"), "desligado: o login não começa", r.d);
r = await chamar("/oauth/token", { form: { grant_type: "authorization_code", code: codAntes.code, redirect_uri: WEB, client_id: "plantare-web", code_verifier: codAntes.verifier } });
checar(r.status === 401 && r.d.error === "invalid_client", "o código emitido antes não vira token", r.d);
r = await chamar("/oauth/userinfo", { metodo: "GET", headers: { authorization: "Bearer " + acessoWeb } });
checar(r.status === 401, "e o access_token de antes para de valer no userinfo");
await fila("oauth.cliente", { acao: "ligar", id: "plantare-web" });
await publicar();
r = await chamar("/oauth/userinfo", { metodo: "GET", headers: { authorization: "Bearer " + acessoWeb } });
checar(r.status === 200 && r.d.email === "joao@escritorio.adv.br", "ligado de novo: volta a valer (o token ainda não venceu)");
await recusa("oauth.cliente", { acao: "editar", id: "plantare-srv", tipo: "publico", voltas: [SRV] }, "tipo", "trocar o tipo do cliente: recusado (crie outro)");
checar((await fila("oauth.cliente", { acao: "editar", id: "plantare-srv", voltas: [SRV, SRV + "2"] })).status === 200 && (await publicar()).d.ok
  && JSON.parse(guardados.get("atos:oidc:registro")).clientes["plantare-srv"].voltas.length === 2, "editar as voltas");
await fila("oauth.cliente", { acao: "apagar", id: "plantare-srv" });
const pubApagar = (await publicar()).d.publicacao;
checar(!guardados.has("atos:oidc:segredo:plantare-srv") && !JSON.parse(guardados.get("atos:oidc:registro")).clientes["plantare-srv"], "apagar o cliente leva o segredo junto");
p = await pkce();
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("plantare-srv", SRV, p.desafio) } });
checar(r.status === 400 && r.d.erro.includes("não está registrado"), "apagado: o login não começa", r.d);
r = await chamar("/api/admin/retroagir", { cookie: dono, corpo: { publicacao: pubApagar.id, confirmacao: "retroagir" } });
checar(r.status === 200 && JSON.parse(guardados.get("atos:oidc:registro")).clientes["plantare-srv"] && r.d.avisos.some((a) => a.includes("segredo")),
  "retroagir traz o cliente de volta, e avisa que o segredo não volta", r.d);
cod = await codigoPara("plantare-srv", SRV);
r = await chamar("/oauth/token", { origem: "", form: formSrv({ client_id: "plantare-srv", client_secret: segredo2 }) });
checar(r.status === 401 && r.d.error_description.includes("ainda não tem segredo"), "sem segredo até gerar outro", r.d);
r = await chamar("/api/admin/oauth/clientes/plantare-srv/segredo", { cookie: dono, corpo: { confirmar: true } });
checar(r.status === 200, "(um segredo novo para o confidencial)");
await fila("oauth.app", { acao: "apagar", id: "plantare" });
r = await publicar();
const regFim = JSON.parse(guardados.get("atos:oidc:registro"));
checar(r.d.ok && !Object.keys(regFim.apps).length && !Object.keys(regFim.clientes).length && !guardados.has("atos:oidc:segredo:plantare-srv"),
  "apagar o aplicativo leva os clientes dele e os segredos", regFim);
r = await chamar("/api/apps", { metodo: "GET", cookie: joao });
checar(!r.d.apps.some((a) => a.nome === "Plantare Maps"), "e some da Minha conta");
await new Promise((ok) => setTimeout(ok, 5));
await fila("oauth.app", APP);
await publicar();
await fila("oauth.cliente", CW);
await publicar();
p = await pkce();
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("plantare-web", WEB, p.desafio) } });
checar(r.status === 200 && r.d.permitido === false, "criado de novo com o mesmo id: a permissão de antes não vale (pede de novo)", r.d);

console.log("os fixos intactos");
await recusa("oauth.cliente", { acao: "desligar", id: "pavlvs-site" }, "do código", "desligar um fixo: recusado");
await recusa("oauth.app", { acao: "apagar", id: "pavlvs" }, "do código", "apagar o PAVLVS: recusado");
p = await pkce();
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("pavlvs-site", "https://paulus.ia.br/entrar-atos/", p.desafio) } });
checar(r.status === 200 && r.d.app.nome === "PAVLVS" && r.d.app.icone === "/assets/paulus-p.png", "o PAVLVS continua entrando", r.d);
guardados.set("atos:oidc:registro", JSON.stringify({ apps: { pavlvs: { ...APP, nome: "Falso" } }, clientes: { "pavlvs-site": { app: "plantare", tipo: "publico", voltas: ["https://mal.example/"] } } }));
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("pavlvs-site", "https://mal.example/", p.desafio) } });
const r2 = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("pavlvs-site", "https://paulus.ia.br/entrar-atos/", p.desafio) } });
checar(r.status === 400 && r2.d.app.nome === "PAVLVS", "um registro do KV com o id de um fixo não vale sobre ele");
guardados.set("atos:oidc:registro", "isto não é json");
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("pavlvs-site", "https://paulus.ia.br/entrar-atos/", p.desafio) } });
checar(r.status === 200 && r.d.app.nome === "PAVLVS", "registro quebrado no KV: os fixos continuam");
guardados.delete("atos:oidc:registro");

console.log("o Worker de teste");
r = await fila("oauth.app", { ...APP, id: "so-teste" }, envT);
await publicar(envT);
checar(guardados.has("atos-teste:oidc:registro") && !guardados.has("atos:oidc:registro"), "o teste guarda em atos-teste:oidc:registro");
await fila("oauth.cliente", { ...CW, id: "so-teste-web", app: "so-teste" }, envT);
await publicar(envT);
p = await pkce();
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("so-teste-web", WEB, p.desafio) }, e: envT });
const rProd = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta("so-teste-web", WEB, p.desafio) } });
checar(r.status === 200 && rProd.status === 400, "o cliente do teste entra no teste e não existe na produção");

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
