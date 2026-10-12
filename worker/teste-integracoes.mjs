// Teste da Minha conta > Integracoes (worker/integracoes.js) e de quem pode entrar em cada aplicativo
// (worker/oidc.js): o dono cadastra o proprio sistema, os acessos, o segredo e a lista de liberados; o /entrar recusa
// antes do consentimento, o prompt=none volta com access_denied, o token e o userinfo conferem de novo; limites, nomes
// reservados, login recente, outra conta, o painel da equipe (ver, desligar por abuso, ligar, apagar) e o CORS. Sem rede.
//   node worker/teste-integracoes.mjs
import worker from "./index.js";
import { comSeguranca, ligarSegundaEtapa } from "./apoio-teste-seguranca.mjs";
import { conferirIdToken } from "./oidc.js";
import { nomeReservado } from "./integracoes.js";
import { sha256 } from "./comum.js";
import { ClienteCobranca } from "./cobranca/cliente.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { EmailAtos } from "./email-atos.js";
const PRODUTOS_TERMOS = PRODUTOS.workspace.termos.versao;

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
  ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }]),
  ASSETS: { fetch: async (req) => new Response("<p>pagina " + new URL(req.url).pathname + "</p>", { headers: { "content-type": "text/html" } }) },
};
// Os objetos dos clientes (o Atos Workspace e o direito:workspace deles), de verdade, com storage em memoria. O Worker
// de teste tem os proprios (cada Worker tem os seus Durable Objects).
function objetosDeClientes(e) {
  const objetos = new Map();
  const storage = () => {
    const m = new Map();
    return { async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; }, async put(k, v) { m.set(k, structuredClone(v)); },
      async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); }, async setAlarm() {} };
  };
  return { idFromName: (n) => n, get(id) {
    if (!objetos.has(id)) objetos.set(id, new ClienteCobranca({ storage: storage() }, e));
    return { fetch: (url, op) => objetos.get(id).fetch(new Request(url, op)) };
  } };
}
env.CLIENTES = objetosDeClientes(env);
// O registro do e-mail Atos (o alias de quem cadastra sistemas: as Integracoes pedem o alias confirmado e o login por ele).
function objetoDoEmail(e) {
  const m = new Map();
  const st = { async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; }, async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); }, async setAlarm() {}, async getAlarm() { return null; } };
  const o = new EmailAtos({ storage: st }, e);
  return { idFromName: (n) => n, get() { return { fetch: (url, op) => o.fetch(new Request(url, op)) }; } };
}
env.EMAIL_ATOS = objetoDoEmail(env);
const envT = { ...env, AMBIENTE: "teste" };
envT.CLIENTES = objetosDeClientes(envT);
envT.EMAIL_ATOS = objetoDoEmail(envT);
/* Da a conta (pelo e-mail) o alias com o destino confirmado (o codigo da Atos e a Cloudflare), pelas ops do objeto. */
async function darAlias(e, email, alias) {
  const sub = "sub-" + email.split("@")[0];
  const pedir = (op, d) => e.EMAIL_ATOS.get().fetch("https://email-atos/", { method: "POST", body: JSON.stringify({ op, sub, conta: email, ...d }) }).then((r) => r.json());
  await pedir("reservar", { alias });
  await pedir("destino_pedir", { destino: email.split("@")[0] + "@destino.example", hash: "h" });
  await pedir("codigo_conferir", { hash: "h" });
  return pedir("destino_cf", { email: email.split("@")[0] + "@destino.example", cf_id: "cf-" + alias, criado: true, verificado: true });
}
const ativar = (cookie, e = env) => chamar("/api/workspace/ativar", { cookie, corpo: { aceito: true, versao: PRODUTOS_TERMOS }, e });
const A = "https://atos.dev.br";

async function sessao(email, { idade = 0, alias = "" } = {}) {
  const segredo = "s-" + email + "-" + idade + "-" + alias;
  const sub = "sub-" + email.split("@")[0];
  guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: "Nome " + email.split("@")[0] }));
  await ligarSegundaEtapa(env, sub);
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000) - idade, mfa: true, ...(alias ? { via: "alias", alias } : {}) }));
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
const b64url = (b) => Buffer.from(b).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, desafio: b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}
const consulta = (cliente, volta, desafio, extra = {}) => new URLSearchParams({ client_id: cliente, redirect_uri: volta, response_type: "code", scope: "openid email profile",
  state: "st", nonce: "nn", code_challenge_method: "S256", code_challenge: desafio, ...extra }).toString();
async function codigoPara(cookie, cliente, volta, e = env) {
  const p = await pkce();
  const r = await chamar("/api/autorizar", { cookie, corpo: { consulta: consulta(cliente, volta, p.desafio), permitir: true }, e });
  return { ...p, code: r.d && r.d.ir ? new URL(r.d.ir).searchParams.get("code") : null, r };
}
const trocar = (cod, cliente, volta, extra = {}, headers = {}) => chamar("/oauth/token", { origem: "", headers,
  form: { grant_type: "authorization_code", code: cod.code, redirect_uri: volta, client_id: cliente, code_verifier: cod.verifier, ...extra } });

// A dona e a Bia cadastram sistemas: cada uma tem o e-mail Atos confirmado e entra por ele (a Bia tambem no Worker de teste).
await darAlias(env, "ana@dev.example", "ana.horta");
await darAlias(env, "bia@fora.example", "bia.fora");
await darAlias(envT, "bia@fora.example", "bia.fora");
const ana = await sessao("ana@dev.example", { alias: "ana.horta" });          // dona do sistema
const joao = await sessao("joao@escritorio.adv.br");  // quem vai ser liberado
const bia = await sessao("bia@fora.example", { alias: "bia.fora" });         // nunca liberada
const anaVelha = await sessao("ana@dev.example", { idade: 13 * 3600, alias: "ana.horta" });
const dono = await sessao("dono@atos.dev.br");        // a equipe da Atos
const SITE = { nome: "Horta Viva", descricao: "controle de canteiros", site: "https://horta.example", privacidade: "https://horta.example/privacidade", termos: "https://horta.example/termos" };
const WEB = "https://horta.example/volta";
const SRV = "https://horta.example/srv/volta";

console.log("nomes reservados");
for (const n of ["Atos", "atos login", "Login Atos", "PAVLVS", "pAuLuS Jurídico", "Mercado Pago", "mercado-livre", "G00gle Agenda", "Entrar com Google", "Átos", "Gmail tools"]) {
  checar(nomeReservado(n), "\"" + n + "\" é reservado");
}
for (const n of ["Contatos", "Fatos do Dia", "Horta Viva", "Pagode", "Paulista Imóveis"]) checar(!nomeReservado(n), "\"" + n + "\" passa");

console.log("a tela do Atos Workspace > Integrações");
let r = await chamar("/api/integracoes", { metodo: "GET" });
checar(r.status === 401 && r.d.entrar, "sem sessão: 401");
r = await chamar("/api/integracoes", { metodo: "GET", cookie: ana });
checar(r.status === 403 && r.d.workspace === false && r.d.erro.includes("ative o Atos Workspace"), "sem o Atos Workspace ativo: 403, pedindo a ativação", r.d);
r = await chamar("/api/integracoes/apps", { cookie: ana, corpo: SITE });
checar(r.status === 403 && r.d.workspace === false, "nem cria", r.d);
r = await ativar(ana);
checar(r.status === 200 && r.d.ativo === true, "a dona ativa o Workspace", r.d);
checar((await ativar(bia)).d.ativo === true, "a Bia também (para as recusas de outra conta abaixo)");
r = await chamar("/api/integracoes", { metodo: "GET", cookie: ana });
checar(r.status === 200 && r.d.apps.length === 0 && r.d.limites.apps === 5 && r.d.limites.acessos === 5 && r.d.recente && r.d.descoberta === A + "/.well-known/openid-configuration",
  "com sessão: nenhum aplicativo, os limites e o que precisa para integrar", r.d);
r = await chamar("/conta/integracoes", { metodo: "GET" });
checar(r.status === 301 && r.r.headers.get("location") === A + "/workspace/integracoes", "/conta/integracoes leva ao Atos Workspace", r.r.headers.get("location"));
r = await chamar("/workspace/integracoes", { metodo: "GET", cookie: ana });
checar(r.status === 200 && (await r.r.text()).includes("/workspace/") && r.r.headers.get("content-security-policy").includes("script-src 'self'"), "/workspace/integracoes serve a página do Workspace, com a CSP da conta");

console.log("criar o aplicativo");
r = await chamar("/api/integracoes/apps", { cookie: anaVelha, corpo: SITE });
checar(r.status === 401 && r.d.reentrar, "login de mais de 12 horas: pede para entrar de novo", r.d);
r = await chamar("/api/integracoes/apps", { cookie: ana, corpo: SITE, origem: "https://mal.example" });
checar(r.status === 403, "de outra origem: recusado");
r = await chamar("/api/integracoes/apps", { cookie: ana, corpo: { ...SITE, nome: "Atos Horta" } });
checar(r.status === 400 && r.d.erro.includes("reservado"), "nome reservado: recusado", r.d);
r = await chamar("/api/integracoes/apps", { cookie: ana, corpo: { ...SITE, site: "http://horta.example" } });
checar(r.status === 400 && r.d.erro.includes("https"), "site sem https: recusado", r.d);
r = await chamar("/api/integracoes/apps", { cookie: ana, corpo: SITE });
const app = r.d.app;
checar(r.status === 200 && /^u-[a-z0-9]{10}$/.test(app.id) && app.acesso === "liberados" && app.liberados.length === 0 && app.dono === "ana@dev.example" && app.registro[0].oque.includes("criou"),
  "criado: só as pessoas liberadas, a dona e o registro", r.d);
const guardado = JSON.parse(guardados.get("atos:oidc:app:" + app.id));
checar(guardado.dono.sub === "sub-ana" && JSON.parse(guardados.get("atos:oidc:dono:sub-ana")).includes(app.id) && JSON.parse(guardados.get("atos:oidc:terceiros"))[app.id].email === "ana@dev.example",
  "no KV: o aplicativo com o sub da dona, a lista da conta e o índice");
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "editar", ...SITE, nome: "Pavlvs Horta" } });
checar(r.status === 400 && r.d.erro.includes("reservado"), "editar para um nome reservado: recusado");

console.log("os acessos");
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: ana, corpo: { tipo: "publico", voltas: ["http://horta.example/volta"] } });
checar(r.status === 400 && r.d.erro.includes("volta"), "volta http fora do loopback: recusada", r.d);
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: ana, corpo: { tipo: "secreto", voltas: [WEB] } });
checar(r.status === 400, "tipo desconhecido: recusado");
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: ana, corpo: { tipo: "publico", voltas: [WEB], origens: ["https://horta.example"] } });
const web = r.d.acesso;
checar(r.status === 200 && web.startsWith(app.id + "-") && r.d.app.acessos.length === 1, "o acesso público (página)", r.d);
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: ana, corpo: { tipo: "confidencial", voltas: [SRV] } });
const srv = r.d.acesso;
checar(r.status === 200 && r.d.app.acessos.find((c) => c.id === srv).segredo === null, "o confidencial (servidor), ainda sem segredo");
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: bia, corpo: { tipo: "publico", voltas: [WEB] } });
checar(r.status === 404, "outra conta não mexe no aplicativo de ninguém", r.d);
r = await chamar("/api/integracoes/acessos/" + web, { cookie: bia, corpo: { acao: "desligar" } });
checar(r.status === 404, "nem nos acessos dele");
r = await chamar("/api/integracoes", { metodo: "GET", cookie: bia });
checar(r.d.apps.length === 0, "e não vê os aplicativos dos outros");

console.log("quem pode entrar (só os liberados)");
let p = await pkce();
r = await chamar("/api/pedido", { cookie: ana, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 200 && r.d.negado === false && r.d.app.terceiro === true && r.d.app.cadastrado_por === "ana.horta@atos.dev.br" && !r.d.app.daAtos,
  "a dona entra sempre; o consentimento diz quem cadastrou e que não é da Atos", r.d);
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 200 && r.d.negado === true && r.d.permitido === false && r.d.app.nome === "Horta Viva" && new URL(r.d.voltar).searchParams.get("error") === "access_denied",
  "fora da lista: recusado antes do consentimento, com a volta access_denied", r.d);
r = await chamar("/api/pedido", { corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 200 && r.d.entrar === true && r.d.negado === false, "sem sessão: primeiro entrar (ainda não se sabe quem é)", r.d);
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta(web, WEB, p.desafio, { prompt: "none" }) } });
const volta = r.d.ir ? new URL(r.d.ir) : null;
checar(volta && volta.searchParams.get("error") === "access_denied" && volta.searchParams.get("state") === "st" && !volta.searchParams.get("code"), "prompt=none: volta ao app com error=access_denied", r.d);
r = await chamar("/api/autorizar", { cookie: joao, corpo: { consulta: consulta(web, WEB, p.desafio), permitir: true } });
checar(r.status === 403 && r.d.negado && !r.d.ir, "o permitir direto também não emite código", r.d);
checar(![...guardados.keys()].some((k) => k.startsWith("atos:codigo:")), "nenhum código foi emitido");

console.log("liberar e tirar");
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "liberar", emails: "João@Escritorio.adv.br, nova@ainda-sem-conta.example; nao-e-email" } });
checar(r.status === 400 && r.d.erro.includes("nao-e-email"), "e-mail inválido na lista: recusa tudo", r.d);
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "liberar", emails: "Joao@Escritorio.adv.br, nova@ainda-sem-conta.example" } });
checar(r.status === 200 && r.d.app.liberados.join() === "joao@escritorio.adv.br,nova@ainda-sem-conta.example" && r.d.app.registro[0].oque.includes("liberou"), "liberados, normalizados, com registro", r.d);
let cod = await codigoPara(joao, web, WEB);
checar(Boolean(cod.code), "liberado: o joão permite e recebe o código", cod.r.d);
r = await chamar("/oauth/token", { origem: "https://horta.example", form: { grant_type: "authorization_code", code: cod.code, redirect_uri: WEB, client_id: web, code_verifier: cod.verifier } });
checar(r.status === 200 && r.r.headers.get("access-control-allow-origin") === "https://horta.example", "troca o código (CORS para a origem do acesso)", r.d);
const info = await conferirIdToken(env, r.d.id_token);
checar(info && info.aud === web && info.email === "joao@escritorio.adv.br", "id_token com aud do acesso", info);
const acesso = r.d.access_token;
r = await chamar("/oauth/userinfo", { metodo: "OPTIONS", origem: "https://horta.example" });
checar(r.status === 204 && r.r.headers.get("access-control-allow-origin") === "https://horta.example", "o pré-voo do CORS aceita a origem do terceiro (pelo índice)");
r = await chamar("/oauth/userinfo", { metodo: "GET", origem: "https://horta.example", headers: { authorization: "Bearer " + acesso } });
checar(r.status === 200 && r.d.email === "joao@escritorio.adv.br", "o userinfo responde", r.d);
r = await chamar("/api/apps", { metodo: "GET", cookie: joao });
checar(r.d.apps.some((a) => a.id === app.id && a.terceiro && a.cadastrado_por === "ana.horta@atos.dev.br"), "a Minha conta do joão lista o aplicativo de terceiro (para tirar o acesso)", r.d);
const codPendente = await codigoPara(joao, web, WEB);
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "tirar", email: "joao@escritorio.adv.br" } });
checar(r.status === 200 && !r.d.app.liberados.includes("joao@escritorio.adv.br"), "a dona tira o joão da lista");
r = await chamar("/oauth/userinfo", { metodo: "GET", headers: { authorization: "Bearer " + acesso } });
checar(r.status === 401 && r.d.error === "invalid_token" && r.d.error_description.includes("acesso"), "o userinfo para de responder na hora", r.d);
r = await trocar(codPendente, web, WEB);
checar(r.status === 400 && r.d.error === "invalid_grant" && r.d.error_description.includes("acesso"), "o código emitido antes não vira token", r.d);
r = await chamar("/api/pedido", { cookie: joao, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.d.negado === true, "e o próximo login é recusado");
const nova = await sessao("nova@ainda-sem-conta.example");
r = await chamar("/api/pedido", { cookie: nova, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 200 && r.d.negado === false, "o e-mail liberado antes de ter conta entra quando a conta existe", r.d);

console.log("qualquer Conta Atos");
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "acesso", acesso: "qualquer" } });
checar(r.status === 400, "modo desconhecido: recusado");
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "acesso", acesso: "todos" } });
checar(r.status === 200 && r.d.app.acesso === "todos" && r.d.app.registro[0].oque.includes("qualquer Conta Atos"), "cadastro aberto, com registro");
r = await chamar("/api/pedido", { cookie: bia, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.d.negado === false, "a bia entra");
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "acesso", acesso: "liberados" } });
checar(r.d.app.acesso === "liberados", "e fecha de novo");

console.log("o segredo e ligar/desligar");
r = await chamar("/api/integracoes/acessos/" + srv, { cookie: ana, corpo: { acao: "segredo" } });
checar(r.status === 400, "gerar sem confirmar: recusado");
r = await chamar("/api/integracoes/acessos/" + web, { cookie: ana, corpo: { acao: "segredo", confirmar: true } });
checar(r.status === 400 && r.d.erro.includes("público"), "o público não tem segredo");
r = await chamar("/api/integracoes/acessos/" + srv, { cookie: ana, corpo: { acao: "segredo", confirmar: true } });
const segredo = r.d.segredo;
checar(r.status === 200 && /^atos_cs_/.test(segredo) && r.d.app.acessos.find((c) => c.id === srv).segredo.por === "ana@dev.example" && !JSON.stringify(r.d.app).includes(segredo),
  "gerado uma vez; a tela diz quem e quando, sem o valor", r.d.app.acessos);
checar(![...guardados.values()].some((v) => String(v).includes(segredo)), "no KV fica só o hash");
cod = await codigoPara(ana, srv, SRV);
const basic = "Basic " + Buffer.from(encodeURIComponent(srv) + ":" + encodeURIComponent(segredo)).toString("base64");
r = await chamar("/oauth/token", { origem: "", headers: { authorization: basic }, form: { grant_type: "authorization_code", code: cod.code, redirect_uri: SRV, code_verifier: cod.verifier } });
checar(r.status === 200 && r.d.id_token, "o confidencial troca com client_secret_basic", r.d);
r = await chamar("/api/integracoes/acessos/" + web, { cookie: ana, corpo: { acao: "desligar" } });
checar(r.status === 200 && r.d.app.acessos.find((c) => c.id === web).ativo === false && !JSON.parse(guardados.get("atos:oidc:terceiros"))[app.id].origens.length,
  "desligar o acesso (as origens dele saem do índice)");
r = await chamar("/api/pedido", { cookie: ana, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 400 && r.d.erro.includes("desligado"), "desligado: o login não começa", r.d);
r = await chamar("/api/integracoes/acessos/" + web, { cookie: ana, corpo: { acao: "ligar" } });
checar(r.d.app.acessos.find((c) => c.id === web).ativo === true, "ligar de novo");
r = await chamar("/api/integracoes/acessos/" + web, { cookie: ana, corpo: { acao: "editar", tipo: "confidencial", voltas: [WEB] } });
checar(r.status === 400, "trocar o tipo do acesso: recusado");
r = await chamar("/api/integracoes/acessos/" + web, { cookie: ana, corpo: { acao: "editar", voltas: [WEB, WEB + "2"], origens: [] } });
checar(r.status === 200 && r.d.app.acessos.find((c) => c.id === web).voltas.length === 2, "editar as voltas");

console.log("os limites");
const extras = [];
for (let i = 0; i < 3; i++) {
  r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: ana, corpo: { tipo: "publico", loopback: true } });
  extras.push(r.d.acesso);
}
r = await chamar("/api/integracoes/apps/" + app.id + "/acessos", { cookie: ana, corpo: { tipo: "publico", loopback: true } });
checar(r.status === 409 && r.d.erro.includes("5"), "o sexto acesso: recusado", r.d);
for (let i = 2; i <= 5; i++) await chamar("/api/integracoes/apps", { cookie: ana, corpo: { ...SITE, nome: "Horta " + i } });
r = await chamar("/api/integracoes/apps", { cookie: ana, corpo: { ...SITE, nome: "Horta 6" } });
checar(r.status === 409 && r.d.erro.includes("5"), "o sexto aplicativo: recusado", r.d);
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "liberar", emails: Array.from({ length: 501 }, (_, i) => "p" + i + "@x.example") } });
checar(r.status === 400 && r.d.erro.includes("500"), "mais de 500 liberados: recusado", r.d);
guardados.set("atos:oidc:ritmo:sub-ana", JSON.stringify({ n: 60 }));
r = await chamar("/api/integracoes/apps/" + app.id, { cookie: ana, corpo: { acao: "acesso", acesso: "todos" } });
checar(r.status === 429, "mais de 60 mudanças na hora: espera", r.d);
guardados.delete("atos:oidc:ritmo:sub-ana");
let limitado = false;
r = await worker.fetch(new Request(A + "/api/integracoes/apps", { method: "POST", headers: { origin: A, cookie: bia, "content-type": "application/json" }, body: JSON.stringify(SITE) }),
  { ...env, LIMITE: { limit: async () => { limitado = true; return { success: false }; } } });
checar(r.status === 429 && limitado, "criar passa pelo limite por endereço de internet");

console.log("o painel da equipe");
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: dono });
const naTela = r.d.terceiros.find((x) => x.id === app.id);
checar(r.status === 200 && r.d.terceiros.length === 5 && naTela && naTela.dono === "ana@dev.example" && naTela.acessos.length === 5, "a equipe vê todos os de terceiros, com o dono", r.d.terceiros && r.d.terceiros.length);
r = await chamar("/api/admin/oauth/terceiros/" + app.id + "/desligar", { cookie: ana, corpo: { motivo: "teste" } });
checar(r.status === 401 || r.status === 403, "quem não é da equipe não desliga", r.status);
r = await chamar("/api/admin/oauth/terceiros/" + app.id + "/desligar", { cookie: dono, corpo: {} });
checar(r.status === 400 && r.d.erro.includes("motivo"), "desligar pede o motivo");
r = await chamar("/api/admin/oauth/terceiros/" + app.id + "/desligar", { cookie: dono, corpo: { motivo: "imita outro serviço" } });
checar(r.status === 200, "a equipe desliga por abuso, na hora");
r = await chamar("/api/pedido", { cookie: ana, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 400 && r.d.erro.includes("desligado"), "desligado pela Atos: nenhum acesso começa login", r.d);
r = await chamar("/api/integracoes/acessos/" + web, { cookie: ana, corpo: { acao: "ligar" } });
checar(r.status === 403 && r.d.erro.includes("imita outro serviço"), "a dona não religa, e vê o motivo", r.d);
r = await chamar("/api/integracoes", { metodo: "GET", cookie: ana });
const visto = r.d.apps.find((x) => x.id === app.id);
checar(visto.bloqueado && visto.bloqueado.motivo === "imita outro serviço" && visto.registro[0].quem === "equipe", "a tela da dona mostra o desligamento no registro", visto.registro[0]);
r = await chamar("/api/admin/oauth/log", { metodo: "GET", cookie: dono });
checar(r.d.log[0].app === app.id && r.d.log[0].por === "dono@atos.dev.br", "e fica no registro do Login Atos", r.d.log[0]);
r = await chamar("/api/admin/oauth/terceiros/" + app.id + "/ligar", { cookie: dono, corpo: {} });
r = await chamar("/api/pedido", { cookie: ana, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 200, "ligado de novo pela equipe: volta a entrar", r.d);
r = await chamar("/api/admin/oauth/terceiros/" + app.id + "/apagar", { cookie: dono, corpo: { motivo: "pedido" } });
checar(r.status === 400, "apagar pede confirmação");
r = await chamar("/api/admin/oauth/terceiros/" + app.id + "/apagar", { cookie: dono, corpo: { confirmar: true, motivo: "pedido da dona" } });
checar(r.status === 200 && !guardados.has("atos:oidc:app:" + app.id) && !guardados.has("atos:oidc:segredo:" + srv) && !JSON.parse(guardados.get("atos:oidc:terceiros"))[app.id] &&
  !JSON.parse(guardados.get("atos:oidc:dono:sub-ana")).includes(app.id), "a equipe apaga: o aplicativo, os segredos, a conta da dona e o índice");
checar(JSON.parse(guardados.get("atos:oidc:applog:" + app.id))[0].oque.includes("apagou"), "o registro do aplicativo fica");
r = await chamar("/api/pedido", { cookie: ana, corpo: { consulta: consulta(web, WEB, p.desafio) } });
checar(r.status === 400 && r.d.erro.includes("não está registrado"), "apagado: o login não começa", r.d);

console.log("a dona apaga");
r = await chamar("/api/integracoes", { metodo: "GET", cookie: ana });
const outro = r.d.apps[0];
checar(r.d.apps.length === 4, "sobram quatro (pode criar mais um)");
r = await chamar("/api/integracoes/apps/" + outro.id, { cookie: ana, corpo: { acao: "apagar" } });
checar(r.status === 400, "apagar sem confirmar: recusado");
r = await chamar("/api/integracoes/apps/" + outro.id, { cookie: ana, corpo: { acao: "apagar", confirmar: true } });
checar(r.status === 200 && !guardados.has("atos:oidc:app:" + outro.id), "apagado na hora");

console.log("o Worker de teste");
r = await chamar("/api/integracoes/apps", { cookie: bia, corpo: SITE, e: envT });
checar(r.status === 403 && r.d.workspace === false, "o Worker de teste tem as próprias ativações: lá a Bia ainda não ativou", r.d);
checar((await ativar(bia, envT)).d.ativo === true, "ativa no teste");
r = await chamar("/api/integracoes/apps", { cookie: bia, corpo: SITE, e: envT });
checar(r.status === 200 && guardados.has("atos-teste:oidc:app:" + r.d.app.id) && !guardados.has("atos:oidc:app:" + r.d.app.id), "o teste guarda com o prefixo atos-teste:");
r = await chamar("/api/integracoes", { metodo: "GET", cookie: bia });
checar(r.d.apps.length === 0, "e a produção não vê");

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
