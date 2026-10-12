// @atos.dev.br/entrar: o "Entrar com Atos" (OpenID Connect) em JavaScript, no navegador e no Node (18 ou mais novo).
// Sem dependencias: o PKCE e a conferencia do id_token (ES256, pela JWKS da Atos) usam o WebCrypto da plataforma.
//
//   import { entrarComAtos } from "@atos.dev.br/entrar";
//   const atos = entrarComAtos({ clientId: "u-...-......", voltaPara: "https://seusistema.com.br/retorno" });
//
// Navegador (cliente publico):
//   botao.onclick = () => atos.entrar();          // gera state, nonce e code_verifier, guarda em sessionStorage e vai a Atos
//   criar.onclick = () => atos.entrar({ criarConta: true }); // o mesmo, abrindo a Atos em "Criar a conta Atos" (prompt=create)
//   const pessoa = await atos.retorno();          // na pagina de volta: confere tudo e devolve {id, nome, email, ...} (ou null)
//
// Servidor (cliente confidencial; o segredo vem de process.env.ATOS_CLIENT_SECRET, nunca das opcoes):
//   const { url, guardar } = await atos.comecar(); // guarde `guardar` na sessao do usuario e redirecione para `url`
//   const pessoa = await atos.concluir(req.url, guardar);
//
// "Continuar como" (FedCM, Chrome e Edge; nos outros, o redirecionamento): no clique de um botao,
//   const pessoa = await atos.continuarComFedCM();   // publico; no confidencial, comecarFedCM() + continuarComFedCM({ params }) + concluirFedCM()
//
// O botao oficial (https://atos.dev.br/marca/): botaoEntrarComAtos({ tema, tamanho, texto, href }).
//
// Avisos ao sistema (webhooks): const aviso = await verificarAviso(corpoCru, req.headers["atos-assinatura"], process.env.ATOS_AVISOS_SEGREDO);
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
    if (e.criarConta) {
      // prompt=create ("Initiating User Registration via OpenID Connect 1.0"): a Atos abre em "Criar a conta Atos".
      // A especificacao recomenda nao combinar create com outro prompt.
      if (e.prompt && String(e.prompt) !== "create") throw new ErroAtos("configuracao", "criarConta não combina com prompt (\"" + e.prompt + "\"): use um dos dois.");
      // Uma Atos que nao anuncia create na descoberta: vai a tela de entrar de sempre, que tem o "Criar conta".
      if ((d.prompt_values_supported || []).includes("create")) q.prompt = "create";
    } else if (e.prompt) q.prompt = String(e.prompt);
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
    return trocarCodigo(code, guardado, guardado.voltaPara || voltaPara);
  }

  /* Troca o codigo no token_endpoint (PKCE; no servidor, o segredo de ATOS_CLIENT_SECRET) e confere o id_token.
     `volta`: o redirect_uri da ida; null no codigo do FedCM (que nao tem volta). */
  async function trocarCodigo(code, guardado, volta) {
    const d = await config();
    const corpo = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: guardado.verifier });
    if (volta !== null) corpo.set("redirect_uri", volta);
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

  // ---------------------------------------------------------------- "Continuar como" (FedCM)
  //
  // O navegador mostra a Conta Atos aberta nele e a pessoa escolhe, sem sair do site (Chrome e Edge com FedCM). A Atos
  // devolve um CODIGO, que se troca no token_endpoint como o da volta: com o PKCE e, no servidor, com o segredo.

  const configFedCM = () => emissor + "/fedcm/config.json";

  /* Servidor (ou navegador): o nonce e o code_challenge da ida pelo FedCM, e o que guardar ate a troca. */
  async function comecarFedCM() {
    const c = await cripto();
    const verifier = await aleatorio(32);
    const nonce = await aleatorio(24);
    const desafio = b64url(await c.subtle.digest("SHA-256", te.encode(verifier)));
    return { params: { nonce, desafio }, guardar: { fedcm: true, nonce, verifier, criado: Date.now() } };
  }

  /* Servidor (ou navegador): troca o codigo que o FedCM entregou (sem redirect_uri) e confere o id_token. */
  async function concluirFedCM(codigo, guardado) {
    if (!guardado || typeof guardado !== "object" || !guardado.fedcm || !guardado.nonce || !guardado.verifier) {
      throw new ErroAtos("state", "Não há uma entrada pelo FedCM começada aqui (o que comecarFedCM() devolveu em guardar não veio).");
    }
    if (typeof guardado.criado === "number" && Date.now() - guardado.criado > VALIDADE_DA_IDA_MS) throw new ErroAtos("state", "A entrada demorou demais: comece de novo.");
    if (typeof codigo !== "string" || !codigo || codigo.length > 100) throw new ErroAtos("invalid_request", "O FedCM não trouxe o código.");
    return trocarCodigo(codigo, guardado, null);
  }

  /* O navegador tem o FedCM? (Chrome e Edge; Firefox e Safari, nao.) */
  function temFedCM() {
    return noNavegador() && typeof window.IdentityCredential !== "undefined" && typeof navigator !== "undefined" && navigator.credentials && typeof navigator.credentials.get === "function";
  }

  /**
   * Navegador: "Continuar como <nome>". modo "ativo" (padrao; chame no clique de um botao) ou "passivo" (o aviso do
   * navegador no canto, ao abrir a pagina). Sem `params`: cliente publico, troca o codigo aqui e devolve a pessoa.
   * Com `params` (o que comecarFedCM() deu no servidor): devolve { codigo } para o servidor chamar concluirFedCM().
   * Sem FedCM no navegador, ou se a pessoa fecha a janela no modo ativo, vai pelo redirecionamento: entrar(extra), ou
   * o endereco `semFedCM` (o caminho do servidor que comeca o login); semFedCM: false nao redireciona (devolve null).
   */
  async function continuarComFedCM(opcoes) {
    const o = opcoes || {};
    const modo = o.modo === undefined ? "ativo" : o.modo;
    if (modo !== "ativo" && modo !== "passivo") throw new ErroAtos("configuracao", "modo: \"ativo\" (no clique de um botão) ou \"passivo\".");
    const pelaVolta = () => {
      if (o.semFedCM === false || !noNavegador()) return null;
      if (typeof o.semFedCM === "string") location.assign(o.semFedCM);
      else entrar(o.extra).catch(() => null);
      return null;
    };
    if (!temFedCM()) return pelaVolta();
    let ida = null;
    let params;
    if (o.params) {
      if (typeof o.params.nonce !== "string" || typeof o.params.desafio !== "string") throw new ErroAtos("configuracao", "params precisa ser o que comecarFedCM() devolveu: { nonce, desafio }.");
      params = o.params;
    } else {
      ida = await comecarFedCM();
      params = ida.params;
    }
    const provedor = {
      configURL: configFedCM(), clientId,
      // O nonce vai em params (o campo nonce de fora o Chrome marca como obsoleto). O params e do Chrome 132 em diante;
      // um navegador sem ele nao manda o code_challenge, e a Atos recusa (o site cai no erro, nunca num login sem PKCE).
      params: { nonce: params.nonce, code_challenge: params.desafio, code_challenge_method: "S256", scope: escopos.join(" ") },
    };
    if (o.dica) provedor.loginHint = String(o.dica);
    let cred;
    try {
      cred = await navigator.credentials.get({ identity: { providers: [provedor], mode: modo === "ativo" ? "active" : "passive", context: o.contexto || "signin" } });
    } catch (e) {
      // O erro que a Atos deu (IdentityCredentialError: error; "code" no Chrome 142 e antes).
      const codigo = e && (e.error || e.code);
      if (e && e.name === "IdentityCredentialError" && typeof codigo === "string" && codigo) {
        throw new ErroAtos(codigo, MENSAGENS[codigo] || "A Atos recusou a entrada (" + codigo + ").", e.message);
      }
      // Fechou a janela, o navegador bloqueou ou nao ha conta: no modo ativo, o login de sempre.
      return modo === "ativo" ? pelaVolta() : null;
    }
    if (!cred || typeof cred.token !== "string") return modo === "ativo" ? pelaVolta() : null;
    if (!ida) return { codigo: cred.token };
    return concluirFedCM(cred.token, ida.guardar);
  }

  /* Navegador: tira a permissao deste aplicativo na Atos (IdentityCredential.disconnect). `conta`: o id ou o e-mail. */
  async function desconectarFedCM(conta) {
    if (!temFedCM() || typeof window.IdentityCredential.disconnect !== "function") return false;
    await window.IdentityCredential.disconnect({ configURL: configFedCM(), clientId, accountHint: String(conta || "") });
    return true;
  }

  return { entrar, retorno, comecar, concluir, sair, continuarComFedCM, comecarFedCM, concluirFedCM, desconectarFedCM, temFedCM, clientId, voltaPara, emissor };
}

// ------------------------------------------------------------------ o botao oficial (https://atos.dev.br/marca/)

// O "A" da marca (viewBox 0 0 64 64), o mesmo dos SVG de atos.dev.br/marca/.
const MARCA_A = "M26.93 48.65V50H15.73V48.65L19.59 47.97L31.19 15.67H36.02L48.08 47.97L52.4 48.65V50H38V48.65L42.57 47.97L39.19 38.14H25.79L22.36 47.97ZM32.39 19.33 26.55 35.86H38.41Z";
const BOTAO_TEMAS = ["claro", "escuro", "neutro"];
const BOTAO_TAMANHOS = ["grande", "medio", "pequeno"];
const BOTAO_TEXTOS = { entrar: "Entrar com Atos", continuar: "Continuar com Atos", "criar-conta": "Criar conta com Atos" };

const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * O HTML do botao oficial "Entrar com Atos" (um <a>, sem script). Precisa da folha https://atos.dev.br/marca/botao.css
 * (ou da copia em "@atos.dev.br/entrar/botao.css"). Sem estilo inline: passa em CSP sem 'unsafe-inline'.
 * @param {{tema?: "claro"|"escuro"|"neutro", tamanho?: "grande"|"medio"|"pequeno", texto?: "entrar"|"continuar"|"criar-conta",
 *   href?: string, icone?: boolean, largo?: boolean, id?: string}} [opcoes]
 */
export function botaoEntrarComAtos(opcoes) {
  const o = opcoes || {};
  const tema = o.tema === undefined ? "claro" : o.tema;
  const tamanho = o.tamanho === undefined ? "medio" : o.tamanho;
  const texto = o.texto === undefined ? "entrar" : o.texto;
  if (!BOTAO_TEMAS.includes(tema)) throw new ErroAtos("configuracao", "tema do botão: claro, escuro ou neutro.");
  if (!BOTAO_TAMANHOS.includes(tamanho)) throw new ErroAtos("configuracao", "tamanho do botão: grande, medio ou pequeno.");
  if (!Object.prototype.hasOwnProperty.call(BOTAO_TEXTOS, texto)) throw new ErroAtos("configuracao", "texto do botão: entrar, continuar ou criar-conta.");
  const href = o.href === undefined ? "#" : String(o.href);
  // O botao leva ao login da Atos: nunca um javascript: (nem data: ou vbscript:).
  if (/^\s*(javascript|data|vbscript):/i.test(href)) throw new ErroAtos("configuracao", "o href do botão não pode ser javascript:, data: ou vbscript:.");
  const classes = ["atos-entrar", "atos-entrar--" + tema, "atos-entrar--" + tamanho];
  if (o.icone) classes.push("atos-entrar--icone");
  if (o.largo && !o.icone) classes.push("atos-entrar--largo");
  const id = o.id ? ' id="' + escHtml(o.id) + '"' : "";
  return '<a class="' + classes.join(" ") + '" href="' + escHtml(href) + '"' + id + ">" +
    '<svg class="atos-entrar__marca" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" fill="#131312"/>' +
    '<path fill="#d8d8d8" d="' + MARCA_A + '"/></svg>' +
    '<span class="atos-entrar__texto">' + BOTAO_TEXTOS[texto] + "</span></a>";
}

// ------------------------------------------------------------------ os avisos ao sistema (webhooks)

const AVISO_IDADE_S = 300;

/**
 * Confere um aviso da Atos ao seu sistema (Atos Workspace > Integracoes > Avisos ao seu sistema): a assinatura HMAC-SHA256
 * do cabecalho Atos-Assinatura ("t=<segundos>,v1=<hex>", sobre "<t>.<corpo>") com o segredo do aviso, e a idade (5 minutos).
 * `corpo` e o texto cru da requisicao (antes de qualquer JSON.parse). Devolve o aviso ({id, tipo, criado, app, dados}) ou
 * lanca ErroAtos com codigo "aviso". Guarde o `id`: o mesmo aviso pode chegar mais de uma vez (as novas tentativas).
 */
export async function verificarAviso(corpo, cabecalho, segredo, { agora = Date.now() } = {}) {
  if (typeof corpo !== "string") throw new ErroAtos("aviso", "o corpo do aviso tem de ser o texto cru da requisição");
  if (!segredo) throw new ErroAtos("aviso", "falta o segredo do aviso");
  const p = {};
  for (const parte of String(cabecalho || "").split(",")) {
    const i = parte.indexOf("=");
    if (i > 0) p[parte.slice(0, i).trim()] = parte.slice(i + 1).trim();
  }
  const t = Number(p.t);
  if (!t || !/^[0-9a-f]{64}$/i.test(p.v1 || "")) throw new ErroAtos("aviso", "o cabeçalho Atos-Assinatura não está no formato t=...,v1=...");
  if (Math.abs(agora / 1000 - t) > AVISO_IDADE_S) throw new ErroAtos("aviso", "o aviso é de mais de 5 minutos atrás (ou o relógio está fora)");
  const c = await cripto();
  const chave = await c.subtle.importKey("raw", te.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const certo = [...new Uint8Array(await c.subtle.sign("HMAC", chave, te.encode(t + "." + corpo)))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const dado = String(p.v1).toLowerCase();
  let d = 0;
  for (let i = 0; i < certo.length; i++) d |= certo.charCodeAt(i) ^ dado.charCodeAt(i);
  if (d !== 0) throw new ErroAtos("aviso", "a assinatura do aviso não confere");
  try {
    return JSON.parse(corpo);
  } catch {
    throw new ErroAtos("aviso", "o corpo do aviso não é JSON");
  }
}

export default entrarComAtos;
