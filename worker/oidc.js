// "Entrar com Atos": a Atos como provedor de identidade OpenID Connect, do
// mesmo jeito que o Google e para o "Entrar com o Google". O primeiro
// aplicativo e o PAVLVS (o site paulus.ia.br e o PAULUS instalado).
//
// Os aplicativos e clientes: os fixos do codigo (APPS, CLIENTES: os do PAVLVS)
// e os cadastrados no painel (Login Atos, worker/oidc-painel.js), no KV em
// "atos:oidc:registro" ("atos-teste:oidc:registro" no Worker de teste). O fixo
// vale sobre o do KV com o mesmo id. Um cliente e publico (pagina ou programa:
// PKCE, sem segredo) ou confidencial (um servidor: PKCE e o client_secret, por
// client_secret_basic ou client_secret_post; o segredo fica so como hash, em
// "atos:oidc:segredo:<client_id>"). Desligado ou apagado, o cliente nao comeca
// login, nao troca codigo e o access_token dele deixa de valer no userinfo; o
// id_token ja emitido vale ate vencer (1 hora), porque e assinado e o
// aplicativo o confere sozinho.
//
// O fluxo e o do codigo de autorizacao com PKCE (S256, obrigatorio para todos):
//
//   1. o aplicativo abre  https://atos.dev.br/entrar?client_id=...&redirect_uri=...
//      &response_type=code&scope=openid email profile&state=...&nonce=...
//      &code_challenge=...&code_challenge_method=S256
//   2. a pagina /entrar pede POST /api/pedido: o Worker confere o aplicativo e
//      o endereco de volta e diz o que mostrar (entrar, consentimento ou nada);
//   3. a pessoa entra (contas.js) e, na primeira vez, permite: POST /api/autorizar;
//      a permissao fica guardada por aplicativo ("atos:apps:<sub>") e da segunda
//      vez em diante a pagina segue sozinha;
//   4. volta ao aplicativo com ?code=...&state=...&iss=https://atos.dev.br;
//   5. o aplicativo troca o codigo em POST /oauth/token (com o code_verifier)
//      pelo id_token (ES256, 1 hora) e um access_token (1 hora, para /oauth/userinfo).
//
// Endpoints: /.well-known/openid-configuration, /entrar (autorizacao),
// /oauth/token, /oauth/userinfo, /oauth/jwks, /oauth/revogar.
// A pessoa ve e revoga os aplicativos em /conta (GET /api/apps, POST /api/apps/revogar).
//
// A chave de assinatura e o segredo ATOS_CHAVE do Worker: a JWK privada P-256
// com "kid" (tools/gerar-chave.mjs a cria). ATOS_CHAVES_ANTIGAS (var, opcional)
// guarda as publicas que ainda valem durante uma troca de chave.
//
// O codigo vale 2 minutos e so uma vez. O KV nao e transacional: duas trocas
// do mesmo codigo no mesmo instante, em dois lugares do mundo, poderiam passar
// as duas - o PKCE garante que so quem comecou o pedido tem o verifier.
//
// Quem pode entrar: cada aplicativo tem um modo de acesso - "liberados" (so o
// dono do aplicativo e os e-mails da lista dele; o padrao de todo aplicativo
// novo) ou "todos" (qualquer Conta Atos; os fixos do PAVLVS, que cuida do
// proprio plano). A Atos confere antes de mostrar o consentimento e de emitir
// o codigo (/api/pedido e /api/autorizar; com prompt=none, volta com
// error=access_denied), de novo na troca do codigo (/oauth/token) e em cada
// /oauth/userinfo: tirar alguem da lista corta o proximo login e o userinfo; o
// id_token ja emitido vale ate vencer.
//
// Os aplicativos de terceiros: qualquer Conta Atos cadastra os proprios em
// Minha conta > Integracoes (worker/integracoes.js). Ficam um por chave
// ("atos:oidc:app:<id>", id "u-" + 10 letras; os clientes deles, "<id>-" + 6),
// fora do registro da equipe, e entram aqui so quando um pedido os cita
// (comTerceiro).

import { EMISSOR, aleatorio, emissorDe, b64url, b64urlTexto, deB64url, iguais, json, kv, lerJson, normal, sha256 } from "./comum.js";
import { sessaoDe } from "./contas.js";
import { googleLigado } from "./google.js";
import { aliasDaConta } from "./email-atos.js";

const CODIGO_S = 120;
export const TOKEN_S = 3600;
const RECENTE_S = 300;

/* Os aplicativos que podem pedir "Entrar com Atos". Um aplicativo pode ter mais
   de um cliente (o site e o programa): a permissao e por aplicativo, entao
   quem permitiu no site nao precisa permitir de novo no programa. */
export const APPS = {
  pavlvs: {
    nome: "PAVLVS",
    descricao: "assistente jurídico para escritórios de advocacia",
    site: "https://paulus.ia.br",
    privacidade: "https://paulus.ia.br/politica-de-privacidade",
    termos: "https://paulus.ia.br/termos-de-uso",
    icone: "/assets/paulus-p.png",
    daAtos: true,
    // Qualquer Conta Atos entra: o PAVLVS cuida do proprio plano.
    acesso: "todos",
  },
};

export const CLIENTES = {
  // O site do PAVLVS (assinatura, Minha conta): a pagina de volta troca o codigo.
  "pavlvs-site": { app: "pavlvs", voltas: ["https://paulus.ia.br/entrar-atos/"], origens: ["https://paulus.ia.br"] },
  // O PAULUS instalado: volta a um endereco local da maquina (RFC 8252, porta qualquer).
  "pavlvs-app": { app: "pavlvs", loopback: true, origens: [] },
  // A equipe que entra de fora, pelo endereco do escritorio (<escritorio>.paulus.ia.br, o tunel ate o PAULUS
  // dele): volta direto ao escritorio, que troca o codigo do proprio servidor (sem CORS).
  "pavlvs-escritorio": { app: "pavlvs", padraoTexto: "https://<escritório>.paulus.ia.br/api/acesso/atos/retorno", padrao: /^https:\/\/(?!www\.|admin\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.paulus\.ia\.br\/api\/acesso\/atos\/retorno$/, origens: [] },
};

export const ESCOPOS = {
  openid: "Saber que é você (um identificador da sua conta Atos)",
  email: "Ver o seu endereço de e-mail",
  profile: "Ver o seu nome",
};

/* O que um sistema precisa para integrar (o painel e a Minha conta mostram no "Como integrar"). */
export function dadosParaIntegrar(env) {
  const EMISSOR = emissorDe(env);
  return {
    emissor: EMISSOR,
    descoberta: EMISSOR + "/.well-known/openid-configuration",
    autorizacao: EMISSOR + "/entrar",
    token: EMISSOR + "/oauth/token",
    userinfo: EMISSOR + "/oauth/userinfo",
    jwks: EMISSOR + "/oauth/jwks",
    revogacao: EMISSOR + "/oauth/revogar",
    escopos: Object.entries(ESCOPOS).map(([id, texto]) => ({ id, texto })),
    token_s: TOKEN_S,
  };
}

const lista = (s) => String(s || "").split(/\s+/).filter(Boolean);
const temChave = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

// ------------------------------------------------- o registro (codigo + KV)

/* As chaves do registro no KV CONTAS (o mesmo KV do Worker de teste: prefixo proprio la). */
export function KO(env) {
  const p = env && env.AMBIENTE === "teste" ? "atos-teste:oidc:" : "atos:oidc:";
  return {
    registro: p + "registro", segredo: (id) => p + "segredo:" + id, log: p + "log",
    // Os de terceiros (worker/integracoes.js): o aplicativo, o registro dele, os de cada dono, o indice de todos (o
    // painel e as origens do CORS) e o ritmo de mudancas de cada conta.
    app: (id) => p + "app:" + id, appLog: (id) => p + "applog:" + id, dono: (sub) => p + "dono:" + sub, terceiros: p + "terceiros",
    ritmo: (sub) => p + "ritmo:" + sub,
  };
}

export const ID_APP_TERCEIRO = /^u-[a-z0-9]{10}$/;
const ID_CLIENTE_TERCEIRO = /^(u-[a-z0-9]{10})-[a-z0-9]{6}$/;
/* O aplicativo de terceiro de um client_id ("u-xxxxxxxxxx-yyyyyy" -> "u-xxxxxxxxxx"), ou "". */
export const appDoCliente = (id) => { const m = ID_CLIENTE_TERCEIRO.exec(String(id || "")); return m ? m[1] : ""; };

/* O aplicativo de terceiro guardado, ou null. */
export async function appTerceiro(env, id) {
  if (!ID_APP_TERCEIRO.test(String(id || ""))) return null;
  const a = await kv(env, KO(env).app(id));
  return a && typeof a === "object" && !Array.isArray(a) && a.dono && a.dono.sub ? a : null;
}

/* O indice dos aplicativos de terceiros: {<id>: {nome, email (do dono), origens, bloqueado}}. */
export async function indiceDeTerceiros(env) {
  const i = await kv(env, KO(env).terceiros);
  return i && typeof i === "object" && !Array.isArray(i) ? i : {};
}

const textos = (x) => (Array.isArray(x) ? x.map(String) : []);

/* Poe no registro `reg` o aplicativo de terceiro `appId` e os clientes dele (sem passar por cima de um fixo ou da
   equipe). Bloqueado pela Atos, os clientes ficam desligados. */
export async function comTerceiro(env, reg, appId) {
  if (!appId || temChave(reg.apps, appId)) return reg;
  const a = await appTerceiro(env, appId);
  if (!a) return reg;
  reg.apps[appId] = {
    nome: String(a.nome || appId), descricao: String(a.descricao || ""), site: String(a.site || ""), privacidade: String(a.privacidade || ""),
    termos: String(a.termos || ""), icone: String(a.icone || ""), criado: String(a.criado || ""), doKV: true, terceiro: true,
    dono: { sub: String(a.dono.sub), email: String(a.dono.email || "") }, acesso: a.acesso === "todos" ? "todos" : "liberados",
    liberados: textos(a.liberados), bloqueado: a.bloqueado ? true : false,
  };
  const clientes = a.clientes && typeof a.clientes === "object" ? a.clientes : {};
  for (const [id, c] of Object.entries(clientes)) {
    if (temChave(reg.clientes, id) || appDoCliente(id) !== appId || !c || typeof c !== "object") continue;
    reg.clientes[id] = {
      app: appId, voltas: textos(c.voltas), loopback: c.loopback === true, origens: textos(c.origens), confidencial: c.tipo === "confidencial",
      ativo: c.ativo !== false && !a.bloqueado, doKV: true, terceiro: true,
    };
  }
  return reg;
}

/* A pessoa ({sub, email}) pode entrar no aplicativo? "todos": qualquer Conta Atos. "liberados": o dono do aplicativo
   (de terceiro: a conta que o cadastrou; da equipe: quem o criou) e os e-mails da lista. */
export function podeEntrar(app, pessoa) {
  if (!app || !pessoa || !pessoa.sub) return false;
  if (app.acesso === "todos") return true;
  const email = normal(pessoa.email);
  if (app.dono && app.dono.sub && app.dono.sub === pessoa.sub) return true;
  if (app.por && normal(app.por) === email) return true;
  return Array.isArray(app.liberados) && app.liberados.includes(email);
}

/* O registro do KV como esta guardado: {apps: {id: {...}}, clientes: {id: {...}}}. */
export async function registroDoKV(env) {
  const r = await kv(env, KO(env).registro);
  const ok = (x) => x && typeof x === "object" && !Array.isArray(x);
  return { apps: ok(r) && ok(r.apps) ? r.apps : {}, clientes: ok(r) && ok(r.clientes) ? r.clientes : {} };
}

/* Os fixos mais os do KV, no formato que o fluxo usa. Cliente do KV: {app, voltas, loopback, origens, confidencial,
   ativo, doKV}; aplicativo do KV: {nome, descricao, site, privacidade, termos, icone, criado, doKV}. */
export async function registro(env) {
  const doKV = await registroDoKV(env);
  const apps = { ...APPS };
  for (const [id, a] of Object.entries(doKV.apps)) {
    if (temChave(APPS, id) || !a || typeof a !== "object") continue;
    // Sem o campo, "liberados" (o padrao de todo aplicativo novo): so quem o criou e a lista.
    apps[id] = { nome: String(a.nome || id), descricao: String(a.descricao || ""), site: String(a.site || ""), privacidade: String(a.privacidade || ""),
      termos: String(a.termos || ""), icone: String(a.icone || ""), criado: String(a.criado || ""), doKV: true,
      acesso: a.acesso === "todos" ? "todos" : "liberados", liberados: textos(a.liberados), por: String(a.por || "") };
  }
  const clientes = { ...CLIENTES };
  for (const [id, c] of Object.entries(doKV.clientes)) {
    if (temChave(CLIENTES, id) || !c || typeof c !== "object" || !temChave(apps, c.app)) continue;
    clientes[id] = {
      app: c.app, voltas: Array.isArray(c.voltas) ? c.voltas.map(String) : [], loopback: c.loopback === true,
      origens: Array.isArray(c.origens) ? c.origens.map(String) : [], confidencial: c.tipo === "confidencial", ativo: c.ativo !== false, doKV: true,
    };
  }
  return { apps, clientes };
}

const FIXOS = { apps: APPS, clientes: CLIENTES };

/* O cliente que pode ser usado agora (existe e esta ligado), ou null. */
function clienteAtivo(reg, id) {
  const c = temChave(reg.clientes, id) ? reg.clientes[id] : null;
  return c && c.ativo !== false ? c : null;
}

function voltaPermitida(cliente, volta) {
  if (!volta || volta.length > 500) return false;
  if (cliente.voltas && cliente.voltas.includes(volta)) return true;
  if (cliente.padrao && cliente.padrao.test(volta)) return true;
  if (cliente.loopback) {
    try {
      const u = new URL(volta);
      return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]") && !u.username && !u.password && !u.hash;
    } catch {
      return false;
    }
  }
  return false;
}

function voltar(volta, campos) {
  const u = new URL(volta);
  for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== "") u.searchParams.set(k, v);
  return u.toString();
}

/* O pedido de autorizacao, conferido. {fatal} quando nao da para voltar ao
   aplicativo (cliente ou endereco desconhecido); {ir} quando o erro volta a ele;
   senao {pedido}. */
export function lerPedido(consulta, reg = FIXOS, emissor = EMISSOR) {
  const q = new URLSearchParams(String(consulta || "").replace(/^\?/, ""));
  const clienteId = q.get("client_id") || "";
  const registrado = temChave(reg.clientes, clienteId) ? reg.clientes[clienteId] : null;
  if (!registrado) return { fatal: "Este aplicativo não está registrado na Atos." };
  const cliente = clienteAtivo(reg, clienteId);
  if (!cliente) return { fatal: "Este aplicativo está desligado na Atos." };
  const volta = q.get("redirect_uri") || "";
  if (!voltaPermitida(cliente, volta)) return { fatal: "O endereço de volta não pertence a este aplicativo." };
  const state = (q.get("state") || "").slice(0, 500);
  const erro = (error, error_description) => ({ ir: voltar(volta, { error, error_description, state, iss: emissor }) });
  if (q.get("response_type") !== "code") return erro("unsupported_response_type", "só response_type=code");
  if ((q.get("response_mode") || "query") !== "query") return erro("invalid_request", "só response_mode=query");
  const desafio = q.get("code_challenge") || "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(desafio)) return erro("invalid_request", "PKCE com S256 é obrigatório");
  const escopos = lista(q.get("scope")).filter((s) => ESCOPOS[s]);
  if (!escopos.includes("openid")) return erro("invalid_scope", "o escopo openid é obrigatório");
  const prompt = lista(q.get("prompt"));
  if (prompt.includes("none") && prompt.length > 1) return erro("invalid_request", "prompt=none não combina com outro");
  // prompt=create ("Initiating User Registration via OpenID Connect 1.0"): sem sessao, a /entrar abre em "Criar a
  // conta Atos". Com sessao aberta, a especificacao deixa fora do escopo se a conta e nova ou ja existia (4.1: o que
  // vale e o id_token da volta); entao o pedido segue como sempre (consentimento ou volta), com "Trocar de conta" a mao.
  const maxAge = q.has("max_age") ? Math.max(0, parseInt(q.get("max_age"), 10) || 0) : null;
  return {
    pedido: {
      clienteId, app: cliente.app, volta, state, escopos: [...new Set(escopos)], desafio,
      nonce: (q.get("nonce") || "").slice(0, 200), prompt, maxAge, dica: (q.get("login_hint") || "").slice(0, 200),
    },
  };
}

function precisaEntrar(pedido, sessao, agora) {
  if (!sessao) return true;
  const idade = agora / 1000 - sessao.auth_time;
  if (pedido.prompt.includes("login") && idade > RECENTE_S) return true;
  if (pedido.maxAge !== null && idade > pedido.maxAge) return true;
  return false;
}

async function appsDe(env, sub) {
  return (await kv(env, "atos:apps:" + sub)) || {};
}

/* A permissao guardada vale para o aplicativo de agora: um aplicativo do KV apagado e criado de novo com o mesmo id
   nao herda as permissoes de antes (a de antes e mais velha que ele). */
function permissaoVale(a, app) {
  if (!a || !app) return false;
  return !app.criado || Boolean(a.quando && String(a.quando) >= app.criado);
}

function jaPermitiu(apps, pedido, reg = FIXOS) {
  const a = temChave(apps, pedido.app) ? apps[pedido.app] : null;
  return permissaoVale(a, reg.apps[pedido.app]) && pedido.escopos.every((s) => (a.escopos || []).includes(s));
}

async function emitirCodigo(env, pedido, sessao) {
  const codigo = aleatorio(32);
  await env.CONTAS.put("atos:codigo:" + (await sha256(codigo)), JSON.stringify({
    clienteId: pedido.clienteId, volta: pedido.volta, desafio: pedido.desafio, nonce: pedido.nonce, escopos: pedido.escopos,
    sub: sessao.sub, email: sessao.email, auth_time: sessao.auth_time,
  }), { expirationTtl: CODIGO_S });
  return voltar(pedido.volta, { code: codigo, state: pedido.state, iss: emissorDe(env) });
}

/* O que a pagina /entrar e a /conta mostram do aplicativo. Sem icone (""), elas mostram a inicial do nome. */
function publicoDoApp(id, reg = FIXOS) {
  const a = reg.apps[id];
  // O de terceiro diz quem o cadastrou (comCadastrador; e a pagina diz que nao e da Atos); os da Atos (fixos e da
  // equipe), nao. Aqui nunca vai o e-mail do dono.
  return {
    id, nome: a.nome, descricao: a.descricao, site: a.site, privacidade: a.privacidade, termos: a.termos, icone: a.icone || "", daAtos: Boolean(a.daAtos),
    terceiro: Boolean(a.terceiro), cadastrado_por: "",
  };
}

/* "Cadastrado por": o e-mail Atos do dono (<alias>@atos.dev.br), nunca o e-mail pessoal dele. Sem alias (aplicativo
   antigo, alias removido), suspenso ou sem conseguir ver o registro: "" (a pagina diz "uma Conta Atos"). */
async function comCadastrador(env, pub, reg) {
  const a = reg.apps[pub.id];
  if (!pub.terceiro || !a || !a.dono) return pub;
  let x = null;
  try { x = await aliasDaConta(env, a.dono.sub); } catch { x = null; }
  return { ...pub, cadastrado_por: x && !x.suspenso ? x.endereco : "" };
}

// ---------------------------------------------------------- a assinatura

let chaveCache = { texto: "", chave: null, publica: null };

async function chaveDeAssinar(env) {
  const texto = String(env.ATOS_CHAVE || "");
  if (!texto) return null;
  if (chaveCache.texto !== texto) {
    const jwk = JSON.parse(texto);
    const chave = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    chaveCache = { texto, chave, publica: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid: jwk.kid, alg: "ES256", use: "sig" } };
  }
  return chaveCache;
}

export async function jwks(env) {
  const chaves = [];
  const atual = await chaveDeAssinar(env);
  if (atual) chaves.push(atual.publica);
  try {
    for (const k of JSON.parse(env.ATOS_CHAVES_ANTIGAS || "[]")) if (k && k.kid && k.x && k.y) chaves.push({ kty: "EC", crv: "P-256", x: k.x, y: k.y, kid: k.kid, alg: "ES256", use: "sig" });
  } catch {
    // var malformada: so a chave atual
  }
  return { keys: chaves };
}

export async function assinarJWT(env, corpo) {
  const k = await chaveDeAssinar(env);
  const cab = b64urlTexto(JSON.stringify({ alg: "ES256", typ: "JWT", kid: k.publica.kid }));
  const c = b64urlTexto(JSON.stringify(corpo));
  const assinatura = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.chave, new TextEncoder().encode(cab + "." + c));
  return cab + "." + c + "." + b64url(assinatura);
}

function reivindicacoes(escopos, conta) {
  const r = { sub: conta.sub };
  if (escopos.includes("email")) Object.assign(r, { email: conta.email, email_verified: true });
  if (escopos.includes("profile")) r.name = conta.nome || "";
  return r;
}

// ---------------------------------------------------------------- as rotas

export function ehRotaDoOIDC(url) {
  return url.pathname === "/.well-known/openid-configuration" || url.pathname.startsWith("/oauth/") ||
    ["/api/pedido", "/api/autorizar", "/api/apps", "/api/apps/revogar"].includes(url.pathname);
}

/* Os cabecalhos CORS para a origem do pedido: com clienteId, so as origens daquele cliente; sem, as de todos os
   clientes ligados (os fixos, os da equipe e, pelo indice, os de terceiros nao bloqueados - `env` dado). */
async function cors(request, reg, clienteId, env) {
  const origem = request.headers.get("origin") || "";
  if (!origem) return {};
  let permitidas;
  if (clienteId) permitidas = (clienteAtivo(reg, clienteId) || {}).origens || [];
  else {
    permitidas = Object.keys(reg.clientes).map((id) => clienteAtivo(reg, id)).filter(Boolean).flatMap((c) => c.origens || []);
    if (env && !permitidas.includes(origem)) {
      for (const x of Object.values(await indiceDeTerceiros(env))) if (x && !x.bloqueado && Array.isArray(x.origens)) permitidas.push(...x.origens);
    }
  }
  if (!permitidas.includes(origem)) return {};
  return { "access-control-allow-origin": origem, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600", vary: "origin" };
}

const erroOAuth = (error, error_description, status = 400, extra = {}) => json({ error, error_description }, status, extra);

export async function atenderOIDC(request, env, url, deps = {}) {
  const p = url.pathname;
  const agora = (deps.agora || Date.now)();
  // O de producao; so o `wrangler dev` com ATOS_EMISSOR_LOCAL troca (comum.js, emissorDe).
  const EMISSOR = emissorDe(env);

  if (p === "/.well-known/openid-configuration") {
    return new Response(JSON.stringify({
      issuer: EMISSOR,
      authorization_endpoint: EMISSOR + "/entrar",
      token_endpoint: EMISSOR + "/oauth/token",
      userinfo_endpoint: EMISSOR + "/oauth/userinfo",
      jwks_uri: EMISSOR + "/oauth/jwks",
      revocation_endpoint: EMISSOR + "/oauth/revogar",
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
      scopes_supported: Object.keys(ESCOPOS),
      claims_supported: ["sub", "email", "email_verified", "name", "auth_time", "nonce"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      prompt_values_supported: ["none", "login", "consent", "create"],
      authorization_response_iss_parameter_supported: true,
      ui_locales_supported: ["pt-BR"],
    }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
  }

  if (p === "/oauth/jwks") {
    return new Response(JSON.stringify(await jwks(env)), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
  }

  const reg = await registro(env);

  if (request.method === "OPTIONS" && p.startsWith("/oauth/")) return new Response(null, { status: 204, headers: await cors(request, reg, "", env) });

  if (p === "/oauth/token") {
    if (request.method !== "POST") return erroOAuth("invalid_request", "use POST", 405);
    if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return erroOAuth("slow_down", "muitos pedidos seguidos", 429);
    let f;
    try {
      f = new URLSearchParams(await request.text());
    } catch {
      return erroOAuth("invalid_request", "corpo inválido");
    }
    // Quem pede: client_id no corpo, ou client_secret_basic (Authorization: Basic, id e segredo em
    // form-urlencoded, RFC 6749 2.3.1). Um metodo so.
    let clienteId = f.get("client_id") || "";
    let segredoDado = f.has("client_secret") ? f.get("client_secret") : null;
    const basico = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(request.headers.get("authorization") || "");
    if (basico) {
      let id = "", seg = "";
      try {
        const claro = atob(basico[1]);
        const i = claro.indexOf(":");
        if (i < 0) throw new Error("sem :");
        const de = (s) => decodeURIComponent(s.replace(/\+/g, " "));
        id = de(claro.slice(0, i));
        seg = de(claro.slice(i + 1));
      } catch {
        return erroOAuth("invalid_client", "Authorization Basic inválido", 401, { "www-authenticate": 'Basic realm="atos"' });
      }
      if (segredoDado !== null) return erroOAuth("invalid_request", "o segredo foi mandado de dois jeitos: use só um", 400);
      if (clienteId && clienteId !== id) return erroOAuth("invalid_request", "o client_id do corpo não é o do Authorization", 400);
      clienteId = id;
      segredoDado = seg;
    }
    await comTerceiro(env, reg, appDoCliente(clienteId));
    const extra = await cors(request, reg, clienteId);
    if (f.get("grant_type") !== "authorization_code") return erroOAuth("unsupported_grant_type", "só authorization_code", 400, extra);
    const cliente = clienteAtivo(reg, clienteId);
    const recusaCliente = (texto) => erroOAuth("invalid_client", texto, 401, basico ? { ...extra, "www-authenticate": 'Basic realm="atos"' } : extra);
    if (!cliente) return recusaCliente(temChave(reg.clientes, clienteId) ? "este aplicativo está desligado" : "aplicativo desconhecido");
    if (cliente.confidencial) {
      if (!segredoDado) return recusaCliente("este cliente é confidencial: mande o client_secret (client_secret_basic ou client_secret_post)");
      const guardado = await kv(env, KO(env).segredo(clienteId));
      if (!guardado || !guardado.hash) return recusaCliente("este cliente ainda não tem segredo: gere um no painel da Atos");
      if (segredoDado.length > 200 || !iguais(await sha256(segredoDado), guardado.hash)) return recusaCliente("o client_secret não confere");
    } else if (segredoDado) {
      return recusaCliente("este cliente é público: não usa client_secret");
    }
    if (!env.ATOS_CHAVE) return erroOAuth("temporarily_unavailable", "a assinatura de tokens ainda não está ligada", 503, extra);
    const codigo = f.get("code") || "";
    if (!codigo || codigo.length > 100) return erroOAuth("invalid_grant", "código inválido", 400, extra);
    const chave = "atos:codigo:" + (await sha256(codigo));
    const c = await kv(env, chave);
    if (!c) return erroOAuth("invalid_grant", "o código venceu ou já foi usado", 400, extra);
    await env.CONTAS.delete(chave);
    if (c.clienteId !== clienteId || c.volta !== (f.get("redirect_uri") || "")) return erroOAuth("invalid_grant", "o código é de outro aplicativo ou endereço", 400, extra);
    const verifier = f.get("code_verifier") || "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) !== c.desafio) {
      return erroOAuth("invalid_grant", "o code_verifier não confere", 400, extra);
    }
    // A conta ainda existe (e com o mesmo sub), e a permissao nao foi revogada no meio.
    const conta = await kv(env, "id:conta:" + c.email);
    if (!conta || conta.sub !== c.sub) return erroOAuth("invalid_grant", "a conta não existe mais", 400, extra);
    const apps = await appsDe(env, c.sub);
    if (!jaPermitiu(apps, { app: cliente.app, escopos: c.escopos }, reg)) return erroOAuth("invalid_grant", "a permissão foi revogada", 400, extra);
    // Quem pode entrar, de novo: tirada da lista entre o codigo e a troca, a pessoa nao recebe token.
    if (!podeEntrar(reg.apps[cliente.app], { sub: c.sub, email: c.email })) return erroOAuth("invalid_grant", "esta Conta Atos não tem acesso a este aplicativo", 400, extra);
    const dados = { sub: c.sub, email: c.email, nome: conta.nome || "" };
    const s = Math.floor(agora / 1000);
    const idToken = await assinarJWT(env, {
      iss: EMISSOR, aud: clienteId, azp: clienteId, iat: s, exp: s + TOKEN_S, auth_time: c.auth_time,
      ...(c.nonce ? { nonce: c.nonce } : {}), ...reivindicacoes(c.escopos, dados),
    });
    const acesso = aleatorio(32);
    await env.CONTAS.put("atos:acesso:" + (await sha256(acesso)), JSON.stringify({ sub: c.sub, email: c.email, clienteId, escopos: c.escopos }), { expirationTtl: TOKEN_S });
    // Anota quando o aplicativo entrou pela ultima vez (a pagina /conta mostra).
    apps[cliente.app] = { ...apps[cliente.app], ultimo: new Date(agora).toISOString() };
    await env.CONTAS.put("atos:apps:" + c.sub, JSON.stringify(apps));
    return json({ access_token: acesso, token_type: "Bearer", expires_in: TOKEN_S, id_token: idToken, scope: c.escopos.join(" ") }, 200, { ...extra, pragma: "no-cache" });
  }

  if (p === "/oauth/userinfo") {
    const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
    const a = m ? await kv(env, "atos:acesso:" + (await sha256(m[1]))) : null;
    if (a) await comTerceiro(env, reg, appDoCliente(a.clienteId));
    const extra = await cors(request, reg, "", env);
    const recusa = (descricao) => json({ error: "invalid_token", ...(descricao ? { error_description: descricao } : {}) }, 401, { ...extra, "www-authenticate": 'Bearer error="invalid_token"' });
    // O token de um cliente desligado ou apagado deixa de valer aqui na hora (o id_token vale ate vencer).
    if (!a || !clienteAtivo(reg, a.clienteId)) return recusa("");
    const conta = await kv(env, "id:conta:" + a.email);
    if (!conta || conta.sub !== a.sub) return recusa("");
    // Tirada da lista do aplicativo: o access_token para de valer aqui na hora.
    if (!podeEntrar(reg.apps[reg.clientes[a.clienteId].app], { sub: a.sub, email: a.email })) return recusa("esta Conta Atos não tem mais acesso a este aplicativo");
    return json(reivindicacoes(a.escopos, { sub: a.sub, email: a.email, nome: conta.nome || "" }), 200, extra);
  }

  if (p === "/oauth/revogar") {
    if (request.method !== "POST") return erroOAuth("invalid_request", "use POST", 405);
    let f;
    try {
      f = new URLSearchParams(await request.text());
    } catch {
      f = new URLSearchParams();
    }
    const token = f.get("token") || "";
    if (token && token.length <= 100) await env.CONTAS.delete("atos:acesso:" + (await sha256(token)));
    return new Response(null, { status: 200, headers: await cors(request, reg, "", env) });
  }

  // ------------------------------------------- as da pagina /entrar e /conta
  // So da propria atos.dev.br (contas.js tem a sessao no cookie SameSite=Lax;
  // aqui ainda se confere a origem, e o corpo e JSON - um formulario de outro
  // site nao consegue mandar).
  const sessao = await sessaoDe(request, env);

  if (p === "/api/apps") {
    if (!sessao) return json({ erro: "entre na sua conta" }, 401);
    const apps = await appsDe(env, sessao.sub);
    for (const id of Object.keys(apps)) if (ID_APP_TERCEIRO.test(id)) await comTerceiro(env, reg, id);
    return json({
      apps: await Promise.all(Object.entries(apps).filter(([id, a]) => temChave(reg.apps, id) && permissaoVale(a, reg.apps[id])).map(async ([id, a]) => ({
        ...(await comCadastrador(env, publicoDoApp(id, reg), reg)), escopos: (a.escopos || []).map((s) => ESCOPOS[s] || s), quando: a.quando || null, ultimo: a.ultimo || null,
      }))),
    });
  }
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);
  const d = (await lerJson(request)) || {};

  if (p === "/api/apps/revogar") {
    if (!sessao) return json({ erro: "entre na sua conta" }, 401);
    const apps = await appsDe(env, sessao.sub);
    delete apps[String(d.app || "")];
    await env.CONTAS.put("atos:apps:" + sessao.sub, JSON.stringify(apps));
    return json({ ok: true });
  }

  const idCliente = new URLSearchParams(String(d.consulta || "").replace(/^\?/, "")).get("client_id") || "";
  await comTerceiro(env, reg, appDoCliente(idCliente));
  const lido = lerPedido(d.consulta, reg, EMISSOR);
  if (lido.fatal) return json({ erro: lido.fatal }, 400);
  if (lido.ir) return json({ ir: lido.ir });
  const pedido = lido.pedido;
  const entrar = precisaEntrar(pedido, sessao, agora);
  // Quem pode entrar: conferido antes do consentimento e antes de qualquer codigo.
  const negado = Boolean(sessao) && !entrar && !podeEntrar(reg.apps[pedido.app], sessao);
  const apps = sessao ? await appsDe(env, sessao.sub) : {};
  const permitido = Boolean(sessao) && !negado && jaPermitiu(apps, pedido, reg) && !pedido.prompt.includes("consent");
  const semAcesso = () => voltar(pedido.volta, { error: "access_denied", error_description: "esta Conta Atos não tem acesso a este aplicativo", state: pedido.state, iss: EMISSOR });

  if (p === "/api/pedido") {
    if (pedido.prompt.includes("none")) {
      if (entrar) return json({ ir: voltar(pedido.volta, { error: "login_required", state: pedido.state, iss: EMISSOR }) });
      if (negado) return json({ ir: semAcesso() });
      if (!permitido) return json({ ir: voltar(pedido.volta, { error: "consent_required", state: pedido.state, iss: EMISSOR }) });
      return json({ ir: await emitirCodigo(env, pedido, sessao) });
    }
    return json({
      app: await comCadastrador(env, publicoDoApp(pedido.app, reg), reg),
      escopos: pedido.escopos.map((s) => ({ id: s, texto: ESCOPOS[s] })),
      conta: sessao ? { email: sessao.email, nome: sessao.nome } : null,
      entrar, permitido, negado, dica: pedido.dica, google: googleLigado(env),
      // prompt=create: quando precisa entrar, a pagina abre no "Criar a conta Atos" (com "Ja tem conta? Entrar").
      criar: entrar && pedido.prompt.includes("create"),
      // Sem acesso: a pagina oferece voltar ao aplicativo com error=access_denied.
      ...(negado ? { voltar: semAcesso() } : {}),
    });
  }

  if (p === "/api/autorizar") {
    if (d.permitir !== true) return json({ ir: voltar(pedido.volta, { error: "access_denied", error_description: "a pessoa não permitiu", state: pedido.state, iss: EMISSOR }) });
    if (!sessao || entrar) return json({ erro: "entre na sua conta de novo" }, 401);
    if (negado) return json({ erro: "a sua Conta Atos não tem acesso a este aplicativo", negado: true, voltar: semAcesso() }, 403);
    if (!jaPermitiu(apps, pedido, reg) || pedido.prompt.includes("consent")) {
      // A permissao de um aplicativo antigo com o mesmo id (apagado e criado de novo) nao soma: comeca do zero.
      const guardada = temChave(apps, pedido.app) ? apps[pedido.app] : null;
      const antes = permissaoVale(guardada, reg.apps[pedido.app]) ? guardada : {};
      apps[pedido.app] = { ...antes, escopos: [...new Set([...(antes.escopos || []), ...pedido.escopos])], quando: new Date(agora).toISOString() };
      await env.CONTAS.put("atos:apps:" + sessao.sub, JSON.stringify(apps));
    }
    return json({ ir: await emitirCodigo(env, pedido, sessao) });
  }

  return json({ erro: "rota não existe" }, 404);
}

// Para os testes: conferir um id_token com a chave publica.
export async function conferirIdToken(env, token) {
  const [cab, corpo, ass] = String(token).split(".");
  const k = await chaveDeAssinar(env);
  const pub = await crypto.subtle.importKey("jwk", { ...k.publica, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, deB64url(ass), new TextEncoder().encode(cab + "." + corpo));
  return ok ? JSON.parse(new TextDecoder().decode(deB64url(corpo))) : null;
}
