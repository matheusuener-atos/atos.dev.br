// Os testes do @atos/entrar contra a Atos de verdade (o Worker de C:\atos em `wrangler dev`, teste/atos-local.mjs):
// o servidor (cliente confidencial, segredo pela variavel de ambiente), o navegador (cliente publico, sessionStorage),
// quem nao tem acesso (access_denied), state e iss trocados, o codigo usado duas vezes e os id_token forjados
// (assinatura de outra chave, corpo mexido, alg none e HS256, kid desconhecido, e assinados pela chave certa com
// exp, aud, iss ou nonce errados).
//   cd pacotes/entrar && npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { entrarComAtos, ErroAtos } from "../index.js";
import { subirAtos, PESSOAS } from "./atos-local.mjs";

const VOLTA_PAGINA = "http://127.0.0.1:5173/retorno";
const VOLTA_SERVIDOR = "http://127.0.0.1:5174/auth/atos/retorno";
const SEGREDO = "segredo-de-teste-" + Math.random().toString(36).slice(2);
let atos;
let PUB;
let CONF;

before(async () => {
  atos = await subirAtos({
    clientes: {
      pagina: { tipo: "publico", voltas: [VOLTA_PAGINA], origens: ["http://127.0.0.1:5173"] },
      servid: { tipo: "confidencial", voltas: [VOLTA_SERVIDOR], segredo: SEGREDO },
    },
  });
  PUB = atos.ids.pagina;
  CONF = atos.ids.servid;
});
after(async () => {
  delete process.env.ATOS_CLIENT_SECRET;
  if (atos) await atos.parar();
});

const servidor = (extra = {}) => entrarComAtos({ clientId: CONF, voltaPara: VOLTA_SERVIDOR, emissor: atos.emissor, ...extra });

async function rejeita(promessa, codigo, trecho) {
  await assert.rejects(promessa, (e) => {
    assert.ok(e instanceof ErroAtos, "ErroAtos: " + e);
    assert.equal(e.codigo, codigo, e.message);
    if (trecho) assert.match(e.message + " " + (e.descricao || ""), trecho);
    return true;
  });
}

test("servidor: o login inteiro com o segredo da variável de ambiente", async () => {
  process.env.ATOS_CLIENT_SECRET = SEGREDO;
  const a = servidor();
  const { url, guardar } = await a.comecar();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, atos.emissor + "/entrar");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("scope"), "openid email profile");
  assert.ok(!url.includes(SEGREDO), "o segredo nunca vai na ida");
  const volta = await atos.navegador(url, "joao");
  const p = await a.concluir(volta, guardar);
  assert.equal(p.id, PESSOAS.joao.sub);
  assert.equal(p.nome, PESSOAS.joao.nome);
  assert.equal(p.email, PESSOAS.joao.email);
  assert.equal(p.emailVerificado, true);
  assert.ok(p.expiraEm > Date.now());
  // o access_token vale no userinfo; depois de sair(), nao
  let r = await fetch(atos.emissor + "/oauth/userinfo", { headers: { authorization: "Bearer " + p.accessToken } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sub, PESSOAS.joao.sub);
  await a.sair(p.accessToken);
  r = await fetch(atos.emissor + "/oauth/userinfo", { headers: { authorization: "Bearer " + p.accessToken } });
  assert.equal(r.status, 401);
  // o mesmo codigo outra vez
  await rejeita(a.concluir(volta, guardar), "invalid_grant");
});

test("servidor: segredo errado ou ausente é recusado pela Atos", async () => {
  const a = servidor();
  process.env.ATOS_CLIENT_SECRET = "outro";
  let ida = await a.comecar();
  await rejeita(a.concluir(await atos.navegador(ida.url, "joao"), ida.guardar), "invalid_client");
  delete process.env.ATOS_CLIENT_SECRET;
  ida = await a.comecar();
  await rejeita(a.concluir(await atos.navegador(ida.url, "joao"), ida.guardar), "invalid_client", /confidencial/);
});

test("navegador: entrar() guarda em sessionStorage e retorno() confere e devolve a pessoa", async () => {
  const guardado = new Map();
  const g = globalThis;
  const antes = { window: g.window, document: g.document, sessionStorage: g.sessionStorage, location: g.location, history: g.history };
  let foiPara = "";
  let trocou = "";
  Object.assign(g, {
    window: {}, document: {},
    sessionStorage: { getItem: (k) => (guardado.has(k) ? guardado.get(k) : null), setItem: (k, v) => guardado.set(k, String(v)), removeItem: (k) => guardado.delete(k) },
    location: { href: VOLTA_PAGINA, assign: (u) => { foiPara = u; } },
    history: { state: null, replaceState: (s, t, u) => { trocou = u; } },
  });
  // Mesmo com a variavel de ambiente, o navegador nunca manda segredo (o cliente publico recusaria).
  process.env.ATOS_CLIENT_SECRET = SEGREDO;
  try {
    const a = entrarComAtos({ clientId: PUB, voltaPara: VOLTA_PAGINA, emissor: atos.emissor });
    assert.equal(await a.retorno(), null, "sem code nem error, retorno() devolve null");
    await a.entrar();
    assert.ok(foiPara.startsWith(atos.emissor + "/entrar?"));
    assert.equal(guardado.size, 1);
    g.location.href = await atos.navegador(foiPara, "joao");
    const p = await a.retorno();
    assert.equal(p.id, PESSOAS.joao.sub);
    assert.equal(p.nome, PESSOAS.joao.nome);
    assert.equal(guardado.size, 0, "o que estava guardado sai");
    assert.equal(trocou, "/retorno", "o código sai da barra de endereço");
    // A mesma volta de novo (recarregar a pagina): nada guardado, state recusado.
    await rejeita(a.retorno(), "state");
    // prompt=none com a permissao ja dada: volta direto com o codigo.
    await a.entrar({ prompt: "none" });
    g.location.href = await atos.navegador(foiPara, "joao");
    assert.equal((await a.retorno()).email, PESSOAS.joao.email);
  } finally {
    delete process.env.ATOS_CLIENT_SECRET;
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete g[k]; else g[k] = v; }
  }
});

test("quem não está liberado volta com access_denied, com erro claro", async () => {
  process.env.ATOS_CLIENT_SECRET = SEGREDO;
  const a = servidor();
  const ida = await a.comecar();
  const volta = await atos.navegador(ida.url, "pedro");
  assert.equal(new URL(volta).searchParams.get("error"), "access_denied");
  await rejeita(a.concluir(volta, ida.guardar), "access_denied", /não tem acesso/);
  // A dona recusa a permissao: tambem access_denied.
  const ida2 = await a.comecar();
  await rejeita(a.concluir(await atos.navegador(ida2.url, "maria", { permitir: false }), ida2.guardar), "access_denied", /não permitiu/);
});

test("state e iss trocados na volta são recusados antes de trocar o código", async () => {
  process.env.ATOS_CLIENT_SECRET = SEGREDO;
  const a = servidor();
  let ida = await a.comecar();
  let volta = new URL(await atos.navegador(ida.url, "joao"));
  volta.searchParams.set("state", "outro");
  await rejeita(a.concluir(volta.toString(), ida.guardar), "state");
  ida = await a.comecar();
  volta = new URL(await atos.navegador(ida.url, "joao"));
  volta.searchParams.set("iss", "https://falso.example");
  await rejeita(a.concluir(volta.toString(), ida.guardar), "iss");
  volta.searchParams.delete("iss");
  await rejeita(a.concluir(volta.toString(), ida.guardar), "iss", /ausente/);
  await rejeita(a.concluir(volta.toString(), null), "state");
});

/* Um cliente cujo fetch troca o id_token da resposta do /oauth/token por `forjar(idTokenVerdadeiro)`. */
function comTokenForjado(forjar) {
  return servidor({
    fetch: async (url, init) => {
      const r = await fetch(url, init);
      if (!String(url).endsWith("/oauth/token") || !r.ok) return r;
      const t = await r.json();
      t.id_token = await forjar(t.id_token);
      return new Response(JSON.stringify(t), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
}
const partes = (jwt) => jwt.split(".").map((p, i) => (i < 2 ? JSON.parse(Buffer.from(p, "base64url")) : p));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

async function tentarForjado(forjar, trecho) {
  process.env.ATOS_CLIENT_SECRET = SEGREDO;
  const a = comTokenForjado(forjar);
  const ida = await a.comecar();
  await rejeita(a.concluir(await atos.navegador(ida.url, "joao"), ida.guardar), "id_token", trecho);
}

test("id_token forjado: corpo mexido com a assinatura de antes", async () => {
  await tentarForjado((jwt) => { const [c, corpo, s] = partes(jwt); return b64(c) + "." + b64({ ...corpo, sub: PESSOAS.maria.sub }) + "." + s; }, /assinatura/);
});

test("id_token forjado: assinado por outra chave com o mesmo kid", async () => {
  const outra = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  await tentarForjado(async (jwt) => { const [c, corpo] = partes(jwt); return atos.assinar(corpo, c, outra.privateKey); }, /assinatura/);
});

test("id_token forjado: alg none e HS256", async () => {
  await tentarForjado((jwt) => { const [, corpo] = partes(jwt); return b64({ alg: "none", typ: "JWT" }) + "." + b64(corpo) + "."; }, /ES256/);
  await tentarForjado((jwt) => { const [c, corpo, s] = partes(jwt); return b64({ ...c, alg: "HS256" }) + "." + b64(corpo) + "." + s; }, /ES256/);
});

test("id_token forjado: kid que não está na JWKS", async () => {
  await tentarForjado(async (jwt) => { const [c, corpo] = partes(jwt); return atos.assinar(corpo, { ...c, kid: "nao-existe" }); }, /JWKS/);
});

test("id_token assinado pela chave certa, mas vencido, de outro aplicativo, de outro emissor ou com outro nonce", async () => {
  const agora = Math.floor(Date.now() / 1000);
  const com = (mudar) => async (jwt) => { const [, corpo] = partes(jwt); return atos.assinar({ ...corpo, ...mudar }); };
  await tentarForjado(com({ exp: agora - 120, iat: agora - 3720 }), /venceu/);
  await tentarForjado(com({ aud: "u-exemplo001-outroo", azp: "u-exemplo001-outroo" }), /aud/);
  await tentarForjado(com({ aud: [CONF, "outro"], azp: "outro" }), /azp/);
  await tentarForjado(com({ iss: "https://atos.dev.br" }), /iss/);
  await tentarForjado(com({ nonce: "outro-nonce" }), /nonce/);
  await tentarForjado(com({ iat: agora + 3600, exp: agora + 7200 }), /futuro/);
  // e o mesmo, sem mexer em nada, passa (a conferencia nao recusa o token bom)
  process.env.ATOS_CLIENT_SECRET = SEGREDO;
  const a = comTokenForjado(com({}));
  const ida = await a.comecar();
  assert.equal((await a.concluir(await atos.navegador(ida.url, "joao"), ida.guardar)).id, PESSOAS.joao.sub);
});

test("configuração difícil de errar: segredo nas opções, faltas e outro emissor", async () => {
  assert.throws(() => entrarComAtos({ clientId: CONF, voltaPara: VOLTA_SERVIDOR, clientSecret: "x" }), /ATOS_CLIENT_SECRET/);
  assert.throws(() => entrarComAtos({ voltaPara: VOLTA_SERVIDOR }), /clientId/);
  assert.throws(() => entrarComAtos({ clientId: CONF, voltaPara: "/retorno" }), /endereço completo/);
  assert.equal(entrarComAtos({ clientId: CONF, voltaPara: VOLTA_SERVIDOR }).emissor, "https://atos.dev.br");
  // A descoberta lida de um endereco que nao e o emissor dela e recusada.
  const a = entrarComAtos({ clientId: CONF, voltaPara: VOLTA_SERVIDOR, emissor: atos.emissor.replace("127.0.0.1", "localhost") });
  await rejeita(a.comecar(), "descoberta", /outro emissor/);
  // entrar() fora do navegador diz o que usar.
  await rejeita(servidor().entrar(), "configuracao", /comecar/);
});
