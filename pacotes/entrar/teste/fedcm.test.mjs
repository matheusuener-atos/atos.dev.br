// O "Continuar como" (FedCM) do @atos.dev.br/entrar contra o Worker da Atos de verdade (worker/index.js, no mesmo
// processo, com um KV na memoria), com o FedCM do navegador SIMULADO: o navigator.credentials.get daqui faz o que o
// Chrome faz (a configuracao, /fedcm/contas com Sec-Fetch-Dest e o cookie FedCM, /fedcm/afirmar com a origem da
// pagina e, no continue_on, a pessoa permitindo na janela da Atos). Cobre o cliente publico (a pessoa conferida), o
// confidencial (o codigo vai ao servidor, que troca com o segredo), quem nao esta na lista (access_denied), a pessoa
// que fecha a janela e o navegador sem FedCM (os dois vao pelo redirecionamento), e o modo passivo (nao redireciona).
//   node --test teste/fedcm.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { entrarComAtos, ErroAtos } from "../index.js";
import worker from "../../../worker/index.js";
import { sha256 } from "../../../worker/comum.js";

const A = "https://atos.dev.br";
const LOJA = "https://loja.example";
const APP = "u-lojamaria1", PUB = APP + "-pub001", CONF = APP + "-conf01";
const SEGREDO = "segredo-do-confidencial";
const guardados = new Map();
const env = {
  CONTAS: {
    get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
    put: async (k, v) => { guardados.set(k, v); },
    delete: async (k) => { guardados.delete(k); },
  },
  ASSETS: { fetch: async () => new Response("", { status: 404 }) },
};
const chamarAtos = (url, init = {}) => worker.fetch(new Request(url, init), env);

const pessoas = {};
let navegadorDe = null; // quem esta "dentro" da Atos neste navegador simulado
let fechaJanela = false;
let semPermitir = false;
const idas = [];

before(async () => {
  const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  env.ATOS_CHAVE = JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" });
  guardados.set("atos:oidc:app:" + APP, JSON.stringify({
    id: APP, nome: "Loja da Maria", descricao: "bolos", site: LOJA, privacidade: LOJA + "/p", termos: LOJA + "/t", icone: "", criado: "2026-01-01T00:00:00.000Z",
    dono: { sub: "sub-maria", email: "maria@exemplo.test" }, acesso: "liberados", liberados: ["joao@exemplo.test"],
    clientes: { [PUB]: { tipo: "publico", voltas: [LOJA + "/retorno"], origens: [LOJA], ativo: true }, [CONF]: { tipo: "confidencial", voltas: [LOJA + "/auth/volta"], origens: [], ativo: true } },
  }));
  guardados.set("atos:oidc:segredo:" + CONF, JSON.stringify({ hash: await sha256(SEGREDO) }));
  for (const nome of ["joao", "pedro"]) {
    const email = nome + "@exemplo.test", sub = "sub-" + nome, segredo = "s-" + nome + "-" + Math.random().toString(36).slice(2);
    guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: nome === "joao" ? "João Exemplo" : "Pedro Exemplo" }));
    guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000), criada: Date.now(), amr: ["pwd"] }));
    const lax = "__Host-atos=" + segredo;
    const r = await chamarAtos(A + "/api/fedcm/ligar", { method: "POST", headers: { origin: A, cookie: lax, "content-type": "application/json" }, body: "{}" });
    const fedcm = r.headers.getSetCookie().find((c) => c.startsWith("__Host-atos-fedcm=")).split(";")[0];
    pessoas[nome] = { sub, lax, fedcm };
  }

  // O navegador simulado (a pagina da loja em https://loja.example).
  class IdentityCredentialError extends Error { constructor(m, o) { super(m); this.name = "IdentityCredentialError"; this.error = o.error; } }
  const credentials = {
    async get(op) {
      const pv = op.identity.providers[0];
      idas.push(op);
      if (fechaJanela) throw new DOMException("Error retrieving a token.", "NetworkError");
      const cfg = await (await chamarAtos(pv.configURL, { headers: { "sec-fetch-dest": "webidentity" } })).json();
      const quem = pessoas[navegadorDe];
      const contas = await chamarAtos(cfg.accounts_endpoint, { headers: { "sec-fetch-dest": "webidentity", cookie: quem ? quem.fedcm : "" } });
      if (contas.status !== 200) throw new DOMException("Error retrieving a token.", "NetworkError");
      const conta = (await contas.json()).accounts[0];
      const corpo = new URLSearchParams({ client_id: pv.clientId, account_id: conta.id, disclosure_text_shown: "true", is_auto_selected: "false", params: JSON.stringify(pv.params || {}) });
      if (pv.nonce) corpo.set("nonce", pv.nonce);
      const r = await chamarAtos(cfg.id_assertion_endpoint, { method: "POST", headers: { "sec-fetch-dest": "webidentity", origin: LOJA, cookie: quem.fedcm, "content-type": "application/x-www-form-urlencoded" }, body: corpo.toString() });
      assert.equal(r.headers.get("access-control-allow-origin"), LOJA, "o navegador so le com CORS da origem da pagina");
      const d = await r.json();
      if (d.error) throw new IdentityCredentialError("erro da Atos", { error: d.error.code });
      if (d.token) return { token: d.token, isAutoSelected: false, configURL: pv.configURL };
      // continue_on: a janela da Atos (com o cookie da sessao de sempre); a pessoa permite (ou fecha).
      const pedido = new URL(d.continue_on).searchParams.get("fedcm_pedido");
      if (semPermitir) throw new DOMException("Error retrieving a token.", "NetworkError");
      const c = await chamarAtos(A + "/api/fedcm/continuar", { method: "POST", headers: { origin: A, cookie: quem.lax, "content-type": "application/json" }, body: JSON.stringify({ pedido, permitir: true }) });
      return { token: (await c.json()).token, isAutoSelected: false, configURL: pv.configURL };
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: { credentials }, configurable: true, writable: true });
  globalThis.document = {};
  globalThis.window = globalThis;
  const guardadoSessao = new Map();
  globalThis.sessionStorage = { getItem: (k) => guardadoSessao.get(k) ?? null, setItem: (k, v) => guardadoSessao.set(k, String(v)), removeItem: (k) => guardadoSessao.delete(k) };
  globalThis.location = { href: LOJA + "/", assign(u) { this.foiPara = u; } };
});
after(() => { delete globalThis.window; delete globalThis.document; delete globalThis.location; delete globalThis.sessionStorage; delete globalThis.IdentityCredential; });

const loja = (clientId = PUB) => entrarComAtos({ clientId, voltaPara: LOJA + "/retorno", fetch: chamarAtos });
const comFedCM = () => { globalThis.IdentityCredential = function IdentityCredential() {}; };
const semFedCM = () => { delete globalThis.IdentityCredential; };

test("público: a primeira vez passa pela permissão da Atos e devolve a pessoa conferida", async () => {
  comFedCM(); navegadorDe = "joao"; fechaJanela = false; semPermitir = false;
  const p = await loja().continuarComFedCM();
  assert.equal(p.id, "sub-joao");
  assert.equal(p.nome, "João Exemplo");
  assert.equal(p.email, "joao@exemplo.test");
  const op = idas.at(-1).identity;
  assert.equal(op.mode, "active");
  assert.equal(op.providers[0].configURL, A + "/fedcm/config.json");
  assert.equal(op.providers[0].params.code_challenge_method, "S256");
  assert.ok(op.providers[0].params.nonce && op.providers[0].nonce === undefined, "o nonce só em params");
});

test("público: a segunda vez vem direto (já permitiu)", async () => {
  comFedCM(); navegadorDe = "joao";
  const antes = [...guardados.keys()].filter((k) => k.startsWith("atos:fedcm:pedido:")).length;
  const p = await loja().continuarComFedCM({ modo: "passivo" });
  assert.equal(p.id, "sub-joao");
  assert.equal(idas.at(-1).identity.mode, "passive");
  assert.equal([...guardados.keys()].filter((k) => k.startsWith("atos:fedcm:pedido:")).length, antes, "sem pedido de permissão novo");
});

test("confidencial: o código vai ao servidor, que troca com o segredo", async () => {
  comFedCM(); navegadorDe = "joao";
  const servidor = loja(CONF);
  const { params, guardar } = await servidor.comecarFedCM();
  const { codigo } = await loja(CONF).continuarComFedCM({ params });
  assert.equal(typeof codigo, "string");
  // Sem o segredo: invalid_client.
  delete process.env.ATOS_CLIENT_SECRET;
  const g = globalThis.window; delete globalThis.window; const d = globalThis.document; delete globalThis.document;
  try {
    await assert.rejects(servidor.concluirFedCM(codigo, guardar), (e) => e instanceof ErroAtos && e.codigo === "invalid_client");
    const { codigo: c2 } = await (async () => { globalThis.window = g; globalThis.document = d; const x = await loja(CONF).continuarComFedCM({ params }); delete globalThis.window; delete globalThis.document; return x; })();
    process.env.ATOS_CLIENT_SECRET = SEGREDO;
    const p = await servidor.concluirFedCM(c2, guardar);
    assert.equal(p.id, "sub-joao");
    await assert.rejects(servidor.concluirFedCM(c2, guardar), (e) => e instanceof ErroAtos && e.codigo === "invalid_grant", "o código vale uma vez");
    await assert.rejects(servidor.concluirFedCM(c2, { ...guardar, fedcm: false }), (e) => e.codigo === "state");
  } finally {
    delete process.env.ATOS_CLIENT_SECRET;
    globalThis.window = g; globalThis.document = d;
  }
});

test("fora da lista do aplicativo: access_denied, sem redirecionar", async () => {
  comFedCM(); navegadorDe = "pedro"; location.foiPara = undefined;
  await assert.rejects(loja().continuarComFedCM(), (e) => e instanceof ErroAtos && e.codigo === "access_denied" && /não tem acesso/.test(e.message));
  assert.equal(location.foiPara, undefined);
});

test("a pessoa fecha a janela (modo ativo): vai pelo redirecionamento", async () => {
  comFedCM(); navegadorDe = "joao"; fechaJanela = true; location.foiPara = undefined;
  try {
    assert.equal(await loja().continuarComFedCM(), null);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(String(location.foiPara).startsWith(A + "/entrar?"), location.foiPara);
    assert.equal(await loja().continuarComFedCM({ semFedCM: "/entrar" }), null);
    assert.equal(location.foiPara, "/entrar");
    location.foiPara = undefined;
    assert.equal(await loja().continuarComFedCM({ modo: "passivo" }), null, "no passivo, fechar não redireciona");
    assert.equal(location.foiPara, undefined);
  } finally { fechaJanela = false; }
});

test("navegador sem FedCM (Firefox, Safari): vai pelo redirecionamento", async () => {
  semFedCM(); location.foiPara = undefined;
  const n = idas.length;
  assert.equal(loja().temFedCM(), false);
  assert.equal(await loja().continuarComFedCM({ semFedCM: "/entrar" }), null);
  assert.equal(location.foiPara, "/entrar");
  assert.equal(idas.length, n, "nem tenta o navigator.credentials.get");
  assert.equal(await loja().continuarComFedCM({ semFedCM: false }), null);
});

test("as opções erradas são recusadas", async () => {
  comFedCM();
  await assert.rejects(loja().continuarComFedCM({ modo: "botao" }), (e) => e.codigo === "configuracao");
  await assert.rejects(loja().continuarComFedCM({ params: { nonce: "x" } }), (e) => e.codigo === "configuracao");
});
