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
// O menu de conta (0.5.0): lugar.innerHTML = menuContaAtos({ menu: true, marca: "a", email, sair: "/sair" });
//   ligarMenuContaAtos(lugar, opcoes)  // abrir/fechar, setas, Esc e, se confirmarSair: true, a caixa "Sair da conta?"
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
      // atos_dono: a Atos so manda (true) quando quem entrou e o dono deste aplicativo; para os outros, nao vem.
      dono: c.atos_dono === true,
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
// "curto" (0.5.0): so "Entrar", para topbars; a marca ao lado diz que e com a Atos.
const BOTAO_TEXTOS = { entrar: "Entrar com Atos", continuar: "Continuar com Atos", "criar-conta": "Criar conta com Atos", curto: "Entrar" };

const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * O HTML do botao oficial "Entrar com Atos" (um <a>, sem script). Precisa da folha https://atos.dev.br/marca/botao.css
 * (ou da copia em "@atos.dev.br/entrar/botao.css"). Sem estilo inline: passa em CSP sem 'unsafe-inline'.
 * @param {{tema?: "claro"|"escuro"|"neutro", tamanho?: "grande"|"medio"|"pequeno", texto?: "entrar"|"continuar"|"criar-conta"|"curto",
 *   href?: string, icone?: boolean, largo?: boolean, id?: string}} [opcoes]
 */
export function botaoEntrarComAtos(opcoes) {
  const o = opcoes || {};
  const tema = o.tema === undefined ? "claro" : o.tema;
  const tamanho = o.tamanho === undefined ? "medio" : o.tamanho;
  const texto = o.texto === undefined ? "entrar" : o.texto;
  if (!BOTAO_TEMAS.includes(tema)) throw new ErroAtos("configuracao", "tema do botão: claro, escuro ou neutro.");
  if (!BOTAO_TAMANHOS.includes(tamanho)) throw new ErroAtos("configuracao", "tamanho do botão: grande, medio ou pequeno.");
  if (!Object.prototype.hasOwnProperty.call(BOTAO_TEXTOS, texto)) throw new ErroAtos("configuracao", "texto do botão: entrar, continuar, criar-conta ou curto.");
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

// ------------------------------------------------------------------ o menu de conta (0.5.0; https://atos.dev.br/marca/#menu)
//
// No topo do seu site: antes de entrar, o botao "Entrar"; depois, o e-mail de quem entrou, e o clique abre o menu com Sair
// (ou, com menu: false, um botao so: "Entrar" antes, "Sair" depois). Precisa da folha https://atos.dev.br/marca/menu.css
// (ou "@atos.dev.br/entrar/menu.css"). Sem estilo inline nem script no HTML: o comportamento (abrir e fechar, as setas, o
// Esc, a confirmacao do Sair, se o site quiser) e o ligarMenuContaAtos(), no seu proprio script.
//
// O Sair sai do SEU site (o `sair`: o caminho que recebe um POST e apaga a sessao do seu sistema, ou uma funcao), nao da
// Atos: a Conta Atos continua aberta na Atos.

// A coroa de espinhos (viewBox 0 0 64 64), a mesma de atos.dev.br/marca/atos-coroa.svg (tools/gerar-marca.py).
const MARCA_COROA = "M34.4 4 36.5 4.1 36.5 4.4 35.9 4.8 35 5.8 34.8 5.8 34.5 6.2 36.2 6.9 37.2 7.8 37.6 7.8 38.1 6.9 38.5 6.6 38.6 8.1 39.8 7.8 41.9 7.8 44.2 8.6 44.4 8.9 45.8 9.6 47.5 11.4 47.5 11.6 48.6 13 49 14.1 50.8 13.8 50.6 14.2 49.9 15 49.8 15.5 51.4 15.8 52.5 16.2 54.1 17.8 54.8 18.8 56.8 19.1 57.1 21.4 55.6 21.1 55.6 23.6 55.4 24.5 57.2 24.9 57.2 25.1 56.1 25.6 56 26 57 26.8 58.1 28.6 58.5 30.1 58.5 32.6 57.5 35.6 57.2 35.8 57 36.4 56 37.2 56.1 37.8 57.1 38.1 57.4 38.5 55.4 38.9 55.9 41.4 55.9 43.5 55 46 56 47.6 55.5 49.8 55.2 49.8 54.5 48.2 53.8 47.4 52.9 48.2 51.6 48.9 49.9 49.2 50.5 50.5 48.9 50 48.1 51.9 47.1 53 47.1 53.2 45.5 54.8 44.1 55.5 42.9 55.9 40.6 55.9 38.9 55.4 38.4 56.9 38.1 56.8 37.8 55.6 37.4 55.6 36.8 56.4 35.4 57.1 32.6 57.6 30.4 60 27.9 60 27.8 59.9 28.6 59.1 28.6 58.9 30 57.6 29.9 57.2 28.4 56.9 26.5 55.8 26 57.2 25.9 57.5 25.6 57.5 25.1 55.6 23.6 56 21.9 56 20.5 55.8 18.6 55 17.5 54 17.2 54 16.2 52.8 15.6 51.4 15.2 49.5 13.5 50.1 13.5 49.8 14.2 48.6 14.1 48.2 12.2 47.9 11 47.1 9.5 45.6 9 44.8 6.2 44.8 5.5 42.1 8.2 42.5 8.2 40.2 8.6 38.4 6.6 38 7.1 37.5 7.9 37.2 8 36.8 7.2 35.6 6.5 33.6 6.1 31.6 6.1 29.9 6.9 27.4 7.1 27.2 7.4 26.6 8.2 25.9 8 25.4 7 25 6.8 24.6 8.6 24.4 8 21.6 8.2 19.9 9 18.4 8.5 15.1 9.6 13.6 10 14.1 10.4 16 10.5 16.2 10.8 16.2 12.1 15.4 13.6 15 13 13.9 14.9 14.2 15.5 12.6 16.4 11.6 16.4 11.4 18.8 9.2 20 8.6 21.9 8.1 23.5 8.1 25.4 8.6 25.5 6.9 25.9 7 26.1 7.6 26.8 8.2 27.4 7.6 28.9 6.8 31.8 6ZM32.1 8 30.2 8.4 28.2 9.5 28.4 9.9 28.8 9.9 29.6 10.4 32.1 10.9 33.6 10.8 36 9.5 35.8 9 34.5 8.2ZM40.1 9.8 39.6 9.9 39.5 10.1 40.2 10.9 40.5 11.5 40.9 11.8 40.9 12 41.2 12.2 41.9 13.5 42.1 13.6 42.1 14 41.6 14.1 40.6 14.9 40.2 14.6 39.5 13.2 38.8 12.5 38.5 11.9 37.9 11.4 37.9 11.1 37.4 11 35 12.4 33 12.9 31.1 15.1 28.9 15.1 28.9 14.8 30.5 13 30.5 12.6 28.9 12.2 27.1 11.4 26.6 11.4 26.6 11.6 26.2 11.9 26.2 12.1 24.8 13.9 24.8 14.1 22.8 15.9 20.5 16.8 16.5 16.9 16 20 15.8 21 15.5 21.2 15.5 21.9 17 24.4 16.2 26.5 16 26.6 15.8 26.4 14.4 23.6 14.1 23.6 12.9 24.9 12.6 24.9 12.4 25.2 10.2 26.6 8.5 28.6 8.1 30.1 8.2 32.2 9.4 35.4 9.8 35.6 10.2 34.1 11.4 32 13 32.8 13.1 33 12 35.1 11.2 37.4 13 38.5 13.2 38.9 13.9 39.1 14.2 39.6 14.5 39.6 15.5 40.6 15.5 40.9 18.9 41.8 19.9 43.8 19.1 43.9 16.9 43.2 17.2 46.4 17.2 49.2 17.5 50.6 18 51.8 18.8 52.6 20.5 53.6 22 54 23.4 53.9 24.2 53.8 24.1 53.2 23.4 52.6 23.4 52.4 22.8 51.9 22.8 51.6 21.4 50 21.4 49.6 22.6 48.8 23 48.8 23.2 49 23.2 49.2 25.2 51.5 25.2 51.8 26.2 52.8 26.5 52.8 29.4 51.1 30.9 50.6 32 50.5 34.2 48.2 36.6 48.2 36.5 48.6 34.5 50.6 34.5 50.9 35.5 51.1 37.6 52.2 38.6 50.6 39.1 50.2 39.1 50 40.8 48.5 42 47.9 43.4 47.5 47 47.4 47.2 43 47.6 41.8 48.1 41 47.5 37.8 49.4 37.4 49.8 39 50 39 54.8 35.9 56 34.1 56.5 32.2 56.5 30.4 56.2 29.4 55.6 28.2 54.9 27.5 54.4 27.5 53.9 29.1 52.8 31.5 51.1 30.9 51 30.2 52.1 28.1 52.8 26.1 50.2 24.5 49 23.2 48.4 22.2 45 21.8 44.9 19.5 47.8 20 47.4 15.8 46.8 13.8 44.4 11.1 44.1 11.1 43.2 10.4 41.6 9.8ZM22.1 10.1 21 10.4 19.2 11.4 17.2 13.6 16.9 14.9 19.4 14.8 20.6 14.6 22.1 13.9 23.5 12.5 23.5 12.2 24.8 10.8 24.8 10.5 24 10.2ZM13.9 17 12.9 17.2 11.8 17.9 10.9 18.9 10.2 20.1 10.1 22.2 10.6 23.9 11.5 23.4 12.9 22.1 13.8 20.6 14.4 17.5 14.4 17ZM49.8 17.5 49.5 17.6 49.6 19.5 50.2 21.5 51.8 23.1 53.4 24 53.6 23.1 53.6 21.1 53.1 19.9 51.5 18ZM53.1 39.4 50.8 40.9 49.5 42.5 49.1 44 49.1 47.2 49.9 47.2 51.9 46.5 52.9 45.5 53.6 44.1 53.9 43.4 53.9 41.8 53.4 39.4ZM10.6 39.5 10.2 40.6 10.2 42.6 10.8 43.9 11.6 44.8 11.6 45 12.8 45.9 14.8 46.4 15.1 46.4 15.1 44.9 14.9 43.6 14.4 42.5 13 41 11.4 40 11.1 39.6ZM44.5 49.4 43.1 49.6 41.8 50.2 39.5 52.9 39.5 53.4 41 53.9 41.8 53.9 42.8 53.9 43.9 53.4 44.5 52.8 44.8 52.8 46.4 50.9 46.9 49.4ZM31.9 52.5 30.1 53 28.1 54 28 54.2 28.4 54.6 29.8 55.2 32.4 55.6 34.6 55.2 36 54.4 36.2 53.9 33.8 52.6Z";
const MENU_MARCAS = ["a", "coroa", "nenhuma"];
const MENU_TEMAS = ["claro", "escuro"];
let menuSeq = 0;

function hrefSeguro(h, nome) {
  const s = String(h);
  if (/^\s*(javascript|data|vbscript):/i.test(s)) throw new ErroAtos("configuracao", "o " + nome + " do menu não pode ser javascript:, data: ou vbscript:.");
  return s;
}

/* As opcoes conferidas (lanca ErroAtos("configuracao") no que esta fora). */
function opcoesDoMenu(opcoes) {
  const o = opcoes || {};
  const modo = o.links ? "links" : o.menu === false ? "botao" : "menu";
  const marca = o.marca === undefined ? "a" : o.marca;
  const tema = o.tema === undefined ? "claro" : o.tema;
  if (!MENU_MARCAS.includes(marca)) throw new ErroAtos("configuracao", "marca do menu: a, coroa ou nenhuma.");
  if (!MENU_TEMAS.includes(tema)) throw new ErroAtos("configuracao", "tema do menu: claro ou escuro.");
  const emissor = String(o.emissor || EMISSOR).replace(/\/+$/, "");
  const itens = [];
  for (const x of Array.isArray(o.itens) ? o.itens.slice(0, 12) : []) {
    if (!x || typeof x.rotulo !== "string" || !x.rotulo.trim()) throw new ErroAtos("configuracao", "cada item do menu precisa de rotulo e href.");
    itens.push({ rotulo: x.rotulo.trim(), href: hrefSeguro(x.href === undefined ? "#" : x.href, "href do item") });
  }
  // Ao dono do aplicativo (pessoa.dono, o claim atos_dono), se o site quiser: Minha conta e Workspace da Atos.
  if (o.atalhosDoDono && o.dono === true) {
    itens.push({ rotulo: "Minha conta", href: emissor + "/conta/" }, { rotulo: "Workspace", href: emissor + "/workspace/" });
  }
  return {
    modo, marca, tema, itens,
    email: typeof o.email === "string" ? o.email.trim() : "",
    entrar: hrefSeguro(o.entrar === undefined ? "/entrar" : o.entrar, "entrar"),
    sair: typeof o.sair === "function" ? o.sair : hrefSeguro(o.sair === undefined ? "/sair" : o.sair, "sair"),
    confirmarSair: o.confirmarSair === true,
    id: o.id ? String(o.id) : "",
  };
}

function marcaDoMenu(marca) {
  if (marca === "a") {
    return '<svg class="atos-menu__marca" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><rect width="64" height="64" fill="#131312"/>' +
      '<path fill="#d8d8d8" d="' + MARCA_A + '"/></svg>';
  }
  if (marca === "coroa") {
    return '<svg class="atos-menu__marca atos-menu__marca--coroa" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + MARCA_COROA + '"/></svg>';
  }
  return "";
}

/* O Sair: um formulario POST para `sair` (funciona com o ligarMenuContaAtos, que pode pedir a confirmacao, ou chamar a
   funcao `sair`). */
function formSair(o, classe, conteudo, papel) {
  const acao = typeof o.sair === "string" ? ' action="' + escHtml(o.sair) + '"' : "";
  return '<form class="atos-menu__form" method="post"' + acao + ' role="none"><button type="submit" class="' + classe + '" data-atos-sair' +
    (papel ? ' role="menuitem" tabindex="-1"' : "") + ">" + conteudo + "</button></form>";
}

/**
 * O HTML do menu de conta (sem script nem estilo inline). Ligue o comportamento com ligarMenuContaAtos().
 * @param {{menu?: boolean, links?: boolean, marca?: "a"|"coroa"|"nenhuma", tema?: "claro"|"escuro", email?: string,
 *   entrar?: string, sair?: string|Function, confirmarSair?: boolean, dono?: boolean, atalhosDoDono?: boolean,
 *   itens?: {rotulo: string, href: string}[], id?: string}} [opcoes]
 */
export function menuContaAtos(opcoes) {
  const o = opcoesDoMenu(opcoes);
  const marca = marcaDoMenu(o.marca);
  const classes = "atos-menu atos-menu--" + o.tema + " atos-menu--" + o.modo + (o.marca === "nenhuma" ? " atos-menu--sem-marca" : "");
  if (!o.email) {
    return '<div class="' + classes + '" data-atos-menu><a class="atos-menu__entrar" href="' + escHtml(o.entrar) + '">' + marca +
      '<span class="atos-menu__rotulo">Entrar</span></a></div>';
  }
  if (o.modo === "botao") {
    return '<div class="' + classes + '" data-atos-menu>' +
      formSair(o, "atos-menu__entrar atos-menu__entrar--sair", marca + '<span class="atos-menu__rotulo">Sair</span>', false) + "</div>";
  }
  if (o.modo === "links") {
    return '<nav class="' + classes + '" data-atos-menu aria-label="Conta">' +
      o.itens.map((x) => '<a class="atos-menu__link" href="' + escHtml(x.href) + '">' + escHtml(x.rotulo) + "</a>").join("") +
      formSair(o, "atos-menu__link atos-menu__link--sair", "Sair", false) + "</nav>";
  }
  const id = o.id || "atos-menu-" + ++menuSeq + "-" + Math.random().toString(36).slice(2, 7);
  return '<div class="' + classes + '" data-atos-menu>' +
    '<button type="button" class="atos-menu__botao" aria-haspopup="menu" aria-expanded="false" aria-controls="' + escHtml(id) + '">' + marca +
    '<span class="atos-menu__email">' + escHtml(o.email) + "</span>" +
    '<svg class="atos-menu__seta" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>' +
    '<div class="atos-menu__lista" id="' + escHtml(id) + '" role="menu" aria-label="Conta ' + escHtml(o.email) + '" hidden>' +
    o.itens.map((x) => '<a class="atos-menu__item" role="menuitem" tabindex="-1" href="' + escHtml(x.href) + '">' + escHtml(x.rotulo) + "</a>").join("") +
    (o.itens.length ? '<hr class="atos-menu__separador" role="separator">' : "") +
    formSair(o, "atos-menu__item atos-menu__item--sair", "Sair", true) + "</div></div>";
}

/* A caixa "Sair?" (so com confirmarSair): um <dialog> modal; Esc, Cancelar ou o clique fora fecham sem sair. O foco fica
   preso nos dois botoes e volta a `devolver` ao fechar. Resolve true (Sair) ou false. */
function confirmarSaida(tema, devolver) {
  return new Promise((resolver) => {
    const d = document.createElement("dialog");
    const n = ++menuSeq;
    d.className = "atos-menu-dialogo atos-menu--" + tema;
    d.setAttribute("aria-modal", "true");
    d.setAttribute("aria-labelledby", "atos-sair-t" + n);
    d.setAttribute("aria-describedby", "atos-sair-d" + n);
    d.innerHTML = '<div class="atos-menu-dialogo__caixa"><h2 class="atos-menu-dialogo__titulo" id="atos-sair-t' + n + '">Sair da conta?</h2>' +
      '<p class="atos-menu-dialogo__texto" id="atos-sair-d' + n + '">Você sai da sua conta neste site. Para voltar, é só entrar de novo.</p>' +
      '<div class="atos-menu-dialogo__botoes"><button type="button" class="atos-menu-dialogo__botao" data-cancelar>Cancelar</button>' +
      '<button type="button" class="atos-menu-dialogo__botao atos-menu-dialogo__botao--sair" data-confirmar>Sair</button></div></div>';
    document.body.appendChild(d);
    const cancelar = d.querySelector("[data-cancelar]");
    const confirmar = d.querySelector("[data-confirmar]");
    let feito = false;
    const fim = (sim) => {
      if (feito) return;
      feito = true;
      if (d.open && d.close) d.close();
      d.remove();
      if (devolver && devolver.isConnected && !sim) devolver.focus();
      resolver(sim);
    };
    cancelar.addEventListener("click", () => fim(false));
    confirmar.addEventListener("click", () => fim(true));
    d.addEventListener("cancel", (e) => { e.preventDefault(); fim(false); });
    // O clique fora: no fundo (o proprio <dialog>, que nao tem margem interna), nunca na caixa.
    d.addEventListener("click", (e) => { if (e.target === d) fim(false); });
    d.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); fim(false); return; }
      if (e.key !== "Tab") return;
      // O foco preso: Tab e Shift+Tab so andam entre Cancelar e Sair.
      e.preventDefault();
      (document.activeElement === cancelar ? confirmar : cancelar).focus();
    });
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
    cancelar.focus();
  });
}

/**
 * Liga o menu de conta em `elemento` (escreve o HTML de menuContaAtos(opcoes), se ainda nao estiver la): abrir e fechar,
 * as setas, Home e End, o Esc (o foco volta ao botao), o clique fora e o Sair - com a caixa de confirmacao so se
 * confirmarSair: true. `sair`: o caminho do POST do seu site, ou uma funcao (chamada no lugar do POST).
 * Devolve {fechar(), desligar()}.
 */
export function ligarMenuContaAtos(elemento, opcoes) {
  if (typeof document === "undefined" || !elemento || !elemento.querySelector) throw new ErroAtos("configuracao", "ligarMenuContaAtos precisa de um elemento da página.");
  const o = opcoesDoMenu(opcoes);
  let raiz = elemento.matches && elemento.matches("[data-atos-menu]") ? elemento : elemento.querySelector("[data-atos-menu]");
  if (!raiz) {
    elemento.innerHTML = menuContaAtos(opcoes);
    raiz = elemento.querySelector("[data-atos-menu]");
  }
  const botao = raiz.querySelector(".atos-menu__botao");
  const lista = raiz.querySelector(".atos-menu__lista");
  const itens = () => (lista ? [...lista.querySelectorAll('[role="menuitem"]')] : []);
  const aberto = () => Boolean(lista && !lista.hidden);
  const abrir = (qual) => {
    if (!lista) return;
    lista.hidden = false;
    botao.setAttribute("aria-expanded", "true");
    const l = itens();
    if (l.length) l[qual === "ultimo" ? l.length - 1 : 0].focus();
  };
  const fechar = (devolver) => {
    if (!aberto()) return;
    lista.hidden = true;
    botao.setAttribute("aria-expanded", "false");
    if (devolver) botao.focus();
  };
  const ouvintes = [];
  const ouvir = (alvo, tipo, f) => { alvo.addEventListener(tipo, f); ouvintes.push([alvo, tipo, f]); };
  if (botao && lista) {
    ouvir(botao, "click", () => (aberto() ? fechar(true) : abrir("primeiro")));
    ouvir(botao, "keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); abrir("primeiro"); }
      else if (e.key === "ArrowUp") { e.preventDefault(); abrir("ultimo"); }
      else if (e.key === "Escape") fechar(true);
    });
    ouvir(lista, "keydown", (e) => {
      const l = itens();
      const i = l.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); l[(i + 1) % l.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); l[(i - 1 + l.length) % l.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); l[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); l[l.length - 1].focus(); }
      else if (e.key === "Escape") { e.preventDefault(); fechar(true); }
      else if (e.key === "Tab") fechar(false);
    });
    ouvir(document, "pointerdown", (e) => { if (!raiz.contains(e.target)) fechar(false); });
  }
  ouvir(raiz, "submit", async (e) => {
    const form = e.target;
    if (!form.matches || !form.matches(".atos-menu__form")) return;
    e.preventDefault();
    const quem = botao || form.querySelector("button");
    fechar(false);
    if (o.confirmarSair && !(await confirmarSaida(o.tema, quem))) return;
    if (typeof o.sair === "function") o.sair();
    else HTMLFormElement.prototype.submit.call(form);
  });
  return {
    fechar: () => fechar(false),
    desligar: () => { for (const [alvo, tipo, f] of ouvintes) alvo.removeEventListener(tipo, f); ouvintes.length = 0; },
  };
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
