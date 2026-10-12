// O GitHub App do Portfolio (worker/portfolio.js): o painel le os repositorios, publicos e privados, da conta onde o
// app foi instalado, so com a permissao "Metadata: read" (nome, descricao, homepage, topicos, linguagem, visibilidade).
// Nao le codigo nem escreve nada: e por isso que e um GitHub App, e nao o OAuth App "PAVLVS Admin" (worker/admin.js),
// que so le repositorio privado com o escopo "repo", que tambem da escrita em todos eles.
//
// A configuracao (wrangler.jsonc):
//   GITHUB_APP_ID      o App ID (var)
//   GITHUB_APP_SLUG    o nome na URL (github.com/apps/<slug>) (var)
//   GITHUB_APP_CHAVE   a chave privada .pem que o GitHub gera (segredo: npx wrangler secret put GITHUB_APP_CHAVE);
//                      vale a PKCS#1 ("BEGIN RSA PRIVATE KEY", a que o GitHub entrega) e a PKCS#8 ("BEGIN PRIVATE KEY")
//
// O Worker fala como o app (um JWT RS256 de 9 minutos) para conferir a instalacao e trocar por um token da instalacao
// (vale 1 hora; fica so na memoria deste isolate, nunca no KV).

const API = "https://api.github.com";
const te = new TextEncoder();

export function githubAppConfigurado(env) {
  return Boolean(env && env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_CHAVE);
}

/* O endereco onde o dono instala (ou muda os repositorios liberados) o app, com o `state` que volta no Setup URL. */
export function enderecoDeInstalar(env, state) {
  return "https://github.com/apps/" + encodeURIComponent(env.GITHUB_APP_SLUG) + "/installations/new?state=" + encodeURIComponent(state);
}

// ------------------------------------------------------------ a chave e o JWT

function b64url(bytes) {
  let s = "";
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* O tamanho DER de `n` bytes (forma curta ate 127, longa depois). */
function derTamanho(n) {
  if (n < 0x80) return [n];
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return [0x80 | b.length, ...b];
}
const der = (tag, conteudo) => Uint8Array.from([tag, ...derTamanho(conteudo.length), ...conteudo]);

/* PKCS#1 (RSAPrivateKey) dentro do PKCS#8 (PrivateKeyInfo), que e o que o WebCrypto importa:
   SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { a PKCS#1 } }. */
function pkcs1ParaPkcs8(pkcs1) {
  const versao = [0x02, 0x01, 0x00];
  const algoritmo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octeto = der(0x04, pkcs1);
  return der(0x30, Uint8Array.from([...versao, ...algoritmo, ...octeto]));
}

const CHAVES = new Map();
async function chavePrivada(pem) {
  if (CHAVES.has(pem)) return CHAVES.get(pem);
  const texto = String(pem).replace(/\\n/g, "\n");
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (?:RSA )?PRIVATE KEY-----/.exec(texto);
  if (!m) throw new Error("GITHUB_APP_CHAVE não é uma chave privada PEM");
  const bruto = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const pkcs8 = m[1] ? pkcs1ParaPkcs8(bruto) : bruto;
  const chave = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  CHAVES.set(pem, chave);
  return chave;
}

/* O JWT do app: iat 60 s antes (o relogio do GitHub), exp em 9 minutos (o maximo e 10). */
export async function jwtDoApp(env, agora = Date.now()) {
  const s = Math.floor(agora / 1000);
  const cab = b64url(te.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const corpo = b64url(te.encode(JSON.stringify({ iat: s - 60, exp: s + 540, iss: String(env.GITHUB_APP_ID) })));
  const assinatura = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await chavePrivada(env.GITHUB_APP_CHAVE), te.encode(cab + "." + corpo));
  return cab + "." + corpo + "." + b64url(assinatura);
}

// ------------------------------------------------------------ a API

async function chamar(buscar, metodo, caminho, token) {
  let r;
  try {
    r = await buscar(API + caminho, {
      method: metodo,
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "User-Agent": "Atos-portfolio", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, status: 0, dados: null };
  }
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    dados = null;
  }
  return { ok: r.ok, status: r.status, dados };
}

/* A instalacao, conferida como o app: {id, conta, tipo, selecao} ou null (nao existe, ou nao e deste app). */
export async function lerInstalacao(env, id, { buscar = fetch, agora = Date.now() } = {}) {
  if (!/^\d{1,20}$/.test(String(id))) return null;
  const r = await chamar(buscar, "GET", "/app/installations/" + id, await jwtDoApp(env, agora));
  if (!r.ok || !r.dados || !r.dados.account) return null;
  return { id: String(r.dados.id), conta: String(r.dados.account.login || ""), tipo: String(r.dados.account.type || ""), selecao: String(r.dados.repository_selection || "") };
}

const TOKENS = new Map();
/* O token da instalacao (1 hora no GitHub; aqui, ate 5 minutos antes de vencer). */
async function tokenDaInstalacao(env, id, { buscar = fetch, agora = Date.now() } = {}) {
  const t = TOKENS.get(id);
  if (t && t.vence - 300000 > agora) return t.token;
  const r = await chamar(buscar, "POST", "/app/installations/" + id + "/access_tokens", await jwtDoApp(env, agora));
  if (!r.ok || !r.dados || !r.dados.token) {
    const e = new Error(r.status === 404 ? "o GitHub App não está mais instalado nessa conta: conecte de novo" : "o GitHub não deu acesso aos repositórios agora (" + (r.status || "sem resposta") + ")");
    e.status = r.status;
    throw e;
  }
  TOKENS.set(id, { token: r.dados.token, vence: Date.parse(r.dados.expires_at) || agora + 3600000 });
  return r.dados.token;
}

/* Um repositorio no formato do painel (so o que a permissao de metadados mostra). */
export function repoLimpo(x) {
  return {
    nome: String(x.full_name || ""), curto: String(x.name || ""), descricao: String(x.description || ""), site: String(x.homepage || ""),
    privado: x.private === true, url: String(x.html_url || ""), linguagem: String(x.language || ""), topicos: Array.isArray(x.topics) ? x.topics.map(String).slice(0, 20) : [],
    arquivado: x.archived === true, atualizado: String(x.pushed_at || x.updated_at || ""),
  };
}

/* Os repositorios que a instalacao libera (ate 500), do mais mexido para o menos. */
export async function reposDaInstalacao(env, id, deps = {}) {
  const buscar = deps.buscar || fetch;
  const token = await tokenDaInstalacao(env, id, deps);
  const repos = [];
  for (let pagina = 1; pagina <= 5; pagina++) {
    const r = await chamar(buscar, "GET", "/installation/repositories?per_page=100&page=" + pagina, token);
    if (!r.ok || !r.dados || !Array.isArray(r.dados.repositories)) {
      if (r.status === 401) TOKENS.delete(id);
      throw new Error("o GitHub não listou os repositórios agora (" + (r.status || "sem resposta") + ")");
    }
    repos.push(...r.dados.repositories.map(repoLimpo));
    if (r.dados.repositories.length < 100) break;
  }
  return repos.sort((a, b) => String(b.atualizado).localeCompare(String(a.atualizado)));
}

/* Para os testes: esquece os tokens e as chaves guardados na memoria. */
export function esquecerGitHubApp() {
  TOKENS.clear();
  CHAVES.clear();
}
