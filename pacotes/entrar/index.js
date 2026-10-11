// @atos.dev.br/entrar: o "Entrar com Atos" (OpenID Connect) em JavaScript, no navegador e no Node (18 ou mais novo).
// Sem dependencias: o PKCE e a conferencia do id_token (ES256, pela JWKS da Atos) usam o WebCrypto da plataforma.
//
//   import { entrarComAtos } from "@atos.dev.br/entrar";
//   const atos = entrarComAtos({ clientId: "u-...-......", voltaPara: "https://seusistema.com.br/retorno" });
//
// Navegador (cliente publico):
//   botao.onclick = () => atos.entrar();          // gera state, nonce e code_verifier, guarda em sessionStorage e vai a Atos
//   const pessoa = await atos.retorno();          // na pagina de volta: confere tudo e devolve {id, nome, email, ...} (ou null)
//
// Servidor (cliente confidencial; o segredo vem de process.env.ATOS_CLIENT_SECRET, nunca das opcoes):
//   const { url, guardar } = await atos.comecar(); // guarde `guardar` na sessao do usuario e redirecione para `url`
//   const pessoa = await atos.concluir(req.url, guardar);
//
// Licenca MIT.

const EMISSOR = "https://atos.dev.br";
const ESCOPOS = ["openid", "email", "profile"];
const TOLERANCIA_S = 60;
const VALIDADE_DA_IDA_MS = 30 * 60 * 1000;
const CHAVE_SESSAO = "atos-entrar:";

/** O erro de toda falha do login. `codigo` diz qual (access_denied, state, iss, id_token, invalid_grant...). */
export class ErroAtos extends Error {
  constructor(codigo, mensagem, descricao) {
    super(mensagem);
    this.name = "ErroAtos";
    this.codigo = codigo;
    if (descricao) this.descricao = descricao;
  }
}

const MENSAGENS = {
  access_denied: "A sua Conta Atos não tem acesso a este aplicativo, ou o acesso não foi permitido. Peça a quem administra o sistema ou entre com outra conta.",
  login_required: "É preciso entrar na Conta Atos.",
  consent_required: "É preciso permitir o acesso deste aplicativo na Atos.",
  invalid_grant: "O código de entrada venceu, já foi usado ou o acesso foi tirado. Entre de novo.",
  invalid_client: "A Atos não reconheceu este aplicativo (client_id ou segredo).",
};

// ------------------------------------------------------------------ utilitarios

const te = new TextEncoder();

async function cripto() {
  if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
  // Node 18: o WebCrypto ainda nao e global.
  const m = await import("node:" + "crypto");
  return m.webcrypto;
}

function b64url(bytes) {
  let s = "";
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deB64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("base64url inválido");
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function aleatorio(n = 32) {
  return b64url((await cripto()).getRandomValues(new Uint8Array(n)));
}

/* Igualdade em tempo constante (state e nonce). */
function iguais(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const noNavegador = () => typeof window !== "undefined" && typeof document !== "undefined";

function obrigatorio(valor, nome) {
  if (typeof valor !== "string" || !valor.trim()) throw new ErroAtos("configuracao", "Falta " + nome + " em entrarComAtos({ ... }).");
  return valor.trim();
}

// ------------------------------------------------------------------ o cliente

/**
 * Cria o cliente do "Entrar com Atos".
 * @param {{clientId: string, voltaPara: string, escopos?: string[], emissor?: string, fetch?: typeof fetch}} opcoes
 *   clientId: o do acesso cadastrado na Atos. voltaPara: o endereco de volta, exatamente como cadastrado.
 *   escopos: padrao ["openid", "email", "profile"] (openid sempre vai). emissor: so para testes (padrao https://atos.dev.br).
 */
export function entrarComAtos(opcoes) {
  const o = opcoes || {};
  for (const proibido of ["clientSecret", "client_secret", "segredo"]) {
    if (Object.prototype.hasOwnProperty.call(o, proibido)) {
      throw new ErroAtos("configuracao", "O segredo não vai nas opções: no servidor, ponha-o na variável de ambiente ATOS_CLIENT_SECRET (e nunca no navegador).");
    }
  }
  const clientId = obrigatorio(o.clientId, "clientId");
  const voltaPara = obrigatorio(o.voltaPara, "voltaPara");
  try {
    new URL(voltaPara);
  } catch {
    throw new ErroAtos("configuracao", "voltaPara precisa ser um endereço completo (https://...), igual ao cadastrado na Atos.");
  }
  const emissor = obrigatorio(o.emissor === undefined ? EMISSOR : o.emissor, "emissor").replace(/\/+$/, "");
  const escopos = [...new Set(["openid", ...(Array.isArray(o.escopos) ? o.escopos.map(String) : ESCOPOS)])];
  const buscar = o.fetch || globalThis.fetch;
  if (typeof buscar !== "function") throw new ErroAtos("configuracao", "Este ambiente não tem fetch: use Node 18 ou mais novo, ou passe { fetch }.");

  let descoberta = null;
  let chaves = null;

  async function pedirJson(url, init) {
    let r;
    try {
      r = await buscar(url, init);
    } catch (e) {
      throw new ErroAtos("rede", "Não foi possível falar com a Atos (" + url + ").", e && e.message);
    }
    let d = null;
    try {
      d = await r.json();
    } catch {
      d = null;
    }
    return { r, d };
  }

  async function config() {
    if (descoberta) return descoberta;
    const { r, d } = await pedirJson(emissor + "/.well-known/openid-configuration");
    if (!r.ok || !d) throw new ErroAtos("descoberta", "A Atos não respondeu a descoberta (HTTP " + r.status + ").");
    if (d.issuer !== emissor) throw new ErroAtos("descoberta", "A descoberta diz outro emissor (" + d.issuer + "), não " + emissor + ".");
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      if (typeof d[k] !== "string") throw new ErroAtos("descoberta", "A descoberta não tem " + k + ".");
    }
    if (!(d.code_challenge_methods_supported || []).includes("S256")) throw new ErroAtos("descoberta", "A descoberta não oferece PKCE S256.");
    descoberta = d;
    return d;
  }

  async function chavesPublicas(forcar) {
    if (chaves && !forcar) return chaves;
    const d = await config();
    const { r, d: j } = await pedirJson(d.jwks_uri);
    if (!r.ok || !j || !Array.isArray(j.keys)) throw new ErroAtos("id_token", "Não foi possível ler as chaves públicas da Atos (JWKS).");
    chaves = j.keys;
    return chaves;
  }

  /* Confere o id_token: ES256 pela JWKS (pelo kid), iss, aud, azp, exp, iat e nonce. Devolve o corpo. */
  async function conferirIdToken(idToken, nonce) {
    const falha = (motivo) => new ErroAtos("id_token", "O id_token não passou na conferência: " + motivo + ".");
    const partes = String(idToken || "").split(".");
    if (partes.length !== 3) throw falha("não é um JWT");
    let cab, corpo, assinatura;
    try {
      cab = JSON.parse(new TextDecoder().decode(deB64url(partes[0])));
      corpo = JSON.parse(new TextDecoder().decode(deB64url(partes[1])));
      assinatura = deB64url(partes[2]);
    } catch {
      throw falha("JWT malformado");
    }
    if (!cab || cab.alg !== "ES256") throw falha("o algoritmo precisa ser ES256 (veio " + (cab && cab.alg) + ")");
    if (typeof cab.kid !== "string" || !cab.kid) throw falha("sem kid");
    const acha = (l) => l.find((k) => k && k.kid === cab.kid && k.kty === "EC" && k.crv === "P-256" && (!k.alg || k.alg === "ES256") && (!k.use || k.use === "sig"));
    let jwk = acha(await chavesPublicas(false));
    if (!jwk) jwk = acha(await chavesPublicas(true)); // a Atos pode ter trocado de chave
    if (!jwk) throw falha("a chave " + cab.kid + " não está na JWKS da Atos");
    const c = await cripto();
    const chave = await c.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = assinatura.length === 64 &&
      (await c.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, chave, assinatura, te.encode(partes[0] + "." + partes[1])));
    if (!ok) throw falha("assinatura inválida");
    if (!corpo || typeof corpo !== "object") throw falha("corpo inválido");
    if (corpo.iss !== emissor) throw falha("iss não é " + emissor);
    const auds = Array.isArray(corpo.aud) ? corpo.aud : [corpo.aud];
    if (!auds.includes(clientId)) throw falha("aud não é este aplicativo");
    if ((auds.length > 1 || corpo.azp !== undefined) && corpo.azp !== clientId) throw falha("azp não é este aplicativo");
    const agora = Math.floor(Date.now() / 1000);
    if (typeof corpo.exp !== "number" || corpo.exp + TOLERANCIA_S < agora) throw falha("venceu");
    if (typeof corpo.iat !== "number" || corpo.iat - TOLERANCIA_S > agora) throw falha("iat no futuro");
    if (typeof corpo.nonce !== "string" || !iguais(corpo.nonce, nonce)) throw falha("nonce não confere");
    if (typeof corpo.sub !== "string" || !corpo.sub) throw falha("sem sub");
    return corpo;
  }

  /* O comeco: os valores de uma ida e o endereco da Atos. `guardar` fica com quem chamou (sessao ou sessionStorage). */
  async function comecar(extra) {
    const e = extra || {};
    const d = await config();
    const c = await cripto();
    const verifier = await aleatorio(32);
    const state = await aleatorio(24);
    const nonce = await aleatorio(24);
    const desafio = b64url(await c.subtle.digest("SHA-256", te.encode(verifier)));
    const u = new URL(d.authorization_endpoint);
    const q = { client_id: clientId, redirect_uri: voltaPara, response_type: "code", scope: escopos.join(" "), state, nonce, code_challenge: desafio, code_challenge_method: "S256" };
    if (e.prompt) q.prompt = String(e.prompt);
    if (e.dica) q.login_hint = String(e.dica);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return { url: u.toString(), guardar: { state, nonce, verifier, voltaPara, criado: Date.now() } };
  }

  /* A volta: confere state e iss, trata o erro, troca o codigo e confere o id_token. */
  async function concluir(urlDaVolta, guardado) {
    if (!guardado || typeof guardado !== "object" || !guardado.state || !guardado.nonce || !guardado.verifier) {
      throw new ErroAtos("state", "Não há uma entrada começada aqui (o que comecar() devolveu em guardar não veio).");
    }
    let u;
    try {
      u = new URL(String(urlDaVolta), voltaPara);
    } catch {
      throw new ErroAtos("state", "Endereço de volta inválido.");
    }
    const q = u.searchParams;
    if (!iguais(q.get("state") || "", guardado.state)) throw new ErroAtos("state", "O state da volta não confere: comece a entrada de novo.");
    if (typeof guardado.criado === "number" && Date.now() - guardado.criado > VALIDADE_DA_IDA_MS) throw new ErroAtos("state", "A entrada demorou demais: comece de novo.");
    const d = await config();
    const iss = q.get("iss");
    if (iss !== null ? iss !== emissor : d.authorization_response_iss_parameter_supported === true) {
      throw new ErroAtos("iss", "A volta não veio da Atos (iss " + (iss || "ausente") + ").");
    }
    const erro = q.get("error");
    if (erro) throw new ErroAtos(erro, MENSAGENS[erro] || "A Atos recusou a entrada (" + erro + ").", q.get("error_description") || undefined);
    const code = q.get("code");
    if (!code) throw new ErroAtos("invalid_request", "A volta não trouxe o código.");

    const corpo = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: guardado.voltaPara || voltaPara, code_verifier: guardado.verifier });
    const cab = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const segredo = !noNavegador() && typeof process !== "undefined" && process.env ? String(process.env.ATOS_CLIENT_SECRET || "") : "";
    if (segredo) {
      // client_secret_basic (RFC 6749 2.3.1: id e segredo em form-urlencoded antes do base64).
      const f = (s) => encodeURIComponent(s).replace(/%20/g, "+");
      cab.authorization = "Basic " + btoa(f(clientId) + ":" + f(segredo));
    } else {
      corpo.set("client_id", clientId);
    }
    const { r, d: t } = await pedirJson(d.token_endpoint, { method: "POST", headers: cab, body: corpo.toString() });
    if (!r.ok || !t || !t.id_token) {
      const codigo = (t && t.error) || "token";
      throw new ErroAtos(codigo, MENSAGENS[codigo] || "A Atos recusou a troca do código (HTTP " + r.status + ").", t && t.error_description);
    }
    const c = await conferirIdToken(t.id_token, guardado.nonce);
    return {
      id: c.sub, nome: typeof c.name === "string" ? c.name : "", email: typeof c.email === "string" ? c.email : "", emailVerificado: c.email_verified === true,
      idToken: t.id_token, accessToken: t.access_token || "", expiraEm: c.exp * 1000,
    };
  }

  /* Invalida o access_token na Atos (a sessao local, quem chama apaga). */
  async function sair(accessToken) {
    const d = await config();
    if (!accessToken || !d.revocation_endpoint) return;
    await pedirJson(d.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: accessToken, client_id: clientId }).toString() });
  }

  // ---------------------------------------------------------------- navegador

  function armazenamento() {
    if (typeof sessionStorage === "undefined") throw new ErroAtos("configuracao", "entrar() e retorno() são do navegador; no servidor, use comecar() e concluir().");
    return sessionStorage;
  }

  async function entrar(extra) {
    const s = armazenamento();
    const ida = await comecar(extra);
    s.setItem(CHAVE_SESSAO + clientId, JSON.stringify(ida.guardar));
    location.assign(ida.url);
  }

  async function retorno(endereco) {
    const s = armazenamento();
    const atual = endereco || location.href;
    const u = new URL(atual);
    if (!u.searchParams.has("code") && !u.searchParams.has("error")) return null;
    const bruto = s.getItem(CHAVE_SESSAO + clientId);
    s.removeItem(CHAVE_SESSAO + clientId);
    // O codigo sai da barra de endereco (e do historico) antes de qualquer outra coisa.
    if (!endereco && typeof history !== "undefined" && history.replaceState) history.replaceState(history.state, "", u.pathname + u.hash);
    let guardado = null;
    try {
      guardado = bruto ? JSON.parse(bruto) : null;
    } catch {
      guardado = null;
    }
    return concluir(atual, guardado);
  }

  return { entrar, retorno, comecar, concluir, sair, clientId, voltaPara, emissor };
}

export default entrarComAtos;
