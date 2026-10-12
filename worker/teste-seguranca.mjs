// Testes da seguranca da Conta Atos: o TOTP (vetores da RFC 6238), os codigos de recuperacao, a cifra, as chaves de
// acesso (WebAuthn com autenticadores gerados aqui: ES256 e RS256), a segunda etapa no login (senha, Google, codigo do
// cadastro, "Esqueci a senha"), o amr no id_token, o painel, as sessoes e os avisos por e-mail. Sem rede.
//   node worker/teste-seguranca.mjs
import worker from "./index.js";
import { conferirIdToken } from "./oidc.js";
import { b64url, deB64url, sha256 } from "./comum.js";
import { comSeguranca } from "./apoio-teste-seguranca.mjs";
import { base32, chaveMestra, cifrar, conferirTotp, decifrar, deBase32, hotp, normalCodigo, totp } from "./seguranca/totp.js";
import { cborInteiro, derParaBruta, lerDadosDoAutenticador } from "./seguranca/webauthn.js";
import { navegadorDe } from "./seguranca/atividade.js";
import { TENTATIVAS } from "./seguranca/objeto.js";

let falhas = 0;
function checar(cond, texto, extra) {
  console.log((cond ? "  ok   " : "  FALHA ") + texto + (cond || extra === undefined ? "" : " -> " + JSON.stringify(extra)));
  if (!cond) falhas++;
}
const te = new TextEncoder();

// ------------------------------------------------------------------ o ambiente

const guardados = new Map();
const CONTAS = {
  async get(k, tipo) { const v = guardados.get(k); return v === undefined ? null : tipo === "json" ? JSON.parse(v) : v; },
  async put(k, v) { guardados.set(k, v); },
  async delete(k) { guardados.delete(k); },
};
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };
const emails = [];
let googleDiz = {};
globalThis.fetch = async (u, op) => {
  if (String(u).startsWith("https://api.resend.com")) { emails.push(JSON.parse(op.body)); return new Response("{}", { status: 200 }); }
  if (String(u) === "https://oauth2.googleapis.com/token") {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const corpo = { iss: "https://accounts.google.com", aud: "cliente-atos", exp: Math.floor(Date.now() / 1000) + 3600, email_verified: true, ...googleDiz };
    return new Response(JSON.stringify({ access_token: "g", id_token: enc({ alg: "RS256" }) + "." + enc(corpo) + ".x" }), { status: 200 });
  }
  throw new Error("fetch inesperado: " + u);
};
const CHAVE_MESTRA = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const env = comSeguranca({
  CONTAS, ATOS_CHAVE: JSON.stringify(jwk), RESEND_API_KEY: "re_teste", CONTA_CHAVE_MESTRA: CHAVE_MESTRA,
  GOOGLE_CLIENT_ID: "cliente-atos", GOOGLE_CLIENT_SECRET: "segredo",
  ATOS_EQUIPE: JSON.stringify([{ email: "ana@exemplo.com.br", nome: "Ana", papel: "dono" }]),
  ASSETS: { fetch: async () => new Response("<p>pagina</p>", { headers: { "content-type": "text/html" } }) },
});
const A = "https://atos.dev.br";

/* Um navegador: guarda os cookies (todos os Set-Cookie) e manda nos pedidos. */
class Navegador {
  constructor() { this.cookies = new Map(); }
  get cabecalho() { return [...this.cookies].map(([k, v]) => k + "=" + v).join("; "); }
  guardar(r) {
    for (const sc of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [par] = sc.split(";");
      const i = par.indexOf("=");
      const k = par.slice(0, i), v = par.slice(i + 1);
      if (!v || /Max-Age=0/i.test(sc)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async chamar(caminho, { metodo, corpo, origem = A, headers = {}, e = env } = {}) {
    const h = { ...headers };
    if (origem) h.origin = origem;
    if (this.cookies.size) h.cookie = this.cabecalho;
    const m = metodo || (corpo !== undefined ? "POST" : "GET");
    if (corpo !== undefined) h["content-type"] = "application/json";
    const r = await worker.fetch(new Request(A + caminho, { method: m, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) }), e);
    this.guardar(r);
    let d = null;
    try { d = await r.clone().json(); } catch { d = null; }
    return { status: r.status, d, r };
  }
}

const codigoDe = (m) => (m.subject.match(/\b(\d{6})\b/) || [])[1];
async function criarConta(email, senha, nome = "Pessoa") {
  const n = new Navegador();
  await n.chamar("/api/cadastrar", { corpo: { email, senha, nome } });
  const r = await n.chamar("/api/confirmar", { corpo: { email, codigo: codigoDe(emails.at(-1)) } });
  return { n, r, sub: JSON.parse(guardados.get("id:conta:" + email)).sub };
}
const comAgora = async (ms, fn) => { const antes = Date.now; Date.now = () => antes() + ms; try { return await fn(); } finally { Date.now = antes; } };
async function sessaoGuardada(n) { return JSON.parse(guardados.get("atos:sessao:" + (await sha256(n.cookies.get("__Host-atos")))) || "null"); }

// ------------------------------------------------------------------ TOTP (RFC 6238)

console.log("TOTP: os vetores da RFC 6238 (SHA-1, 8 dígitos)");
{
  const segredo = te.encode("12345678901234567890");
  const vetores = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  let ok = true;
  for (const [t, esperado] of vetores) if ((await totp(segredo, t * 1000, 8)) !== esperado) ok = false;
  checar(ok, "os seis vetores da RFC 6238 batem");
  checar((await hotp(segredo, 0)) === "755224" && (await hotp(segredo, 9)) === "520489", "HOTP: os vetores da RFC 4226 (contador 0 e 9)");
  const b = crypto.getRandomValues(new Uint8Array(20));
  checar(Buffer.from(deBase32(base32(b))).equals(Buffer.from(b)) && base32(te.encode("foobar")) === "MZXW6YTBOI", "base32 vai e volta (e o vetor da RFC 4648)");
  const t0 = 1760000000000;
  const agora = await totp(segredo, t0), antes = await totp(segredo, t0 - 30000), depois = await totp(segredo, t0 + 30000), longe = await totp(segredo, t0 - 60000);
  const p = Math.floor(t0 / 30000);
  checar((await conferirTotp(segredo, agora, t0)) === p && (await conferirTotp(segredo, antes, t0)) === p - 1 && (await conferirTotp(segredo, depois, t0)) === p + 1,
    "a janela: o passo de agora e um de cada lado valem");
  checar((await conferirTotp(segredo, longe, t0)) === -1 || longe === antes || longe === agora, "dois passos atrás: não vale");
  checar((await conferirTotp(segredo, agora, t0, p)) === -1, "o código de um passo já usado não vale de novo");
  checar((await conferirTotp(segredo, antes, t0, p)) === -1, "nem um código de antes do último usado");
  checar((await conferirTotp(segredo, "12345", t0)) === -1 && (await conferirTotp(segredo, "abcdef", t0)) === -1, "código fora do formato: não vale");
}

console.log("a cifra do segredo");
{
  const segredo = crypto.getRandomValues(new Uint8Array(20));
  const c = await cifrar(env, "sub-a", segredo);
  checar(!JSON.stringify(c).includes(Buffer.from(segredo).toString("base64url")), "o segredo não aparece na cifra");
  checar(Buffer.from(await decifrar(env, "sub-a", c)).equals(Buffer.from(segredo)), "decifra com a mesma conta");
  checar((await decifrar(env, "sub-b", c)) === null, "a cifra de uma conta não abre em outra (o sub é o AAD)");
  checar((await decifrar({ ...env, CONTA_CHAVE_MESTRA: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") }, "sub-a", c)) === null, "outra chave mestra: não abre");
  checar((await chaveMestra({})) === null && (await chaveMestra({ CONTA_CHAVE_MESTRA: "curta" })) === null, "sem a chave (ou fora do formato): nada liga");
  checar((await chaveMestra({ AMBIENTE: "teste", NFSE_CHAVE_MESTRA: "x" })) !== null && (await chaveMestra({ NFSE_CHAVE_MESTRA: "x" })) === null,
    "o Worker de teste deriva a chave do NFSE_CHAVE_MESTRA dele; a produção nunca deriva");
  checar(normalCodigo(" AB1L-O0X ") === "ab110" + "0x", "o código de recuperação aceita maiúsculas, espaços e i/l/o trocados");
}

// ------------------------------------------------------------------ o autenticador de mentira (WebAuthn)

function cbor(v) {
  const cab = (maior, n) => {
    if (n < 24) return [(maior << 5) | n];
    if (n < 256) return [(maior << 5) | 24, n];
    if (n < 65536) return [(maior << 5) | 25, n >> 8, n & 255];
    return [(maior << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  if (typeof v === "number") return Uint8Array.from(v >= 0 ? cab(0, v) : cab(1, -1 - v));
  if (typeof v === "string") { const b = te.encode(v); return Uint8Array.from([...cab(3, b.length), ...b]); }
  if (v instanceof Uint8Array) return Uint8Array.from([...cab(2, v.length), ...v]);
  if (Array.isArray(v)) return Uint8Array.from([...cab(4, v.length), ...v.flatMap((x) => [...cbor(x)])]);
  if (v instanceof Map) return Uint8Array.from([...cab(5, v.size), ...[...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)])]);
  throw new Error("cbor: tipo");
}
const junta = (...ps) => { const t = ps.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(t); let i = 0; for (const p of ps) { o.set(p, i); i += p.length; } return o; };
const u32 = (n) => Uint8Array.from([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
function brutaParaDer(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let x = b.slice(i); if (x[0] & 0x80) x = junta(Uint8Array.of(0), x); return junta(Uint8Array.of(2, x.length), x); };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
  return junta(Uint8Array.of(0x30, r.length + s.length), r, s);
}

class Autenticador {
  static async novo(alg = -7, { sincronizada = false } = {}) {
    const a = new Autenticador();
    a.alg = alg; a.sincronizada = sincronizada; a.contador = 0; a.id = crypto.getRandomValues(new Uint8Array(32));
    if (alg === -257) a.par = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, true, ["sign", "verify"]);
    else a.par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return a;
  }
  async cose(algNoCose) {
    const j = await crypto.subtle.exportKey("jwk", this.par.publicKey);
    if (this.alg === -257) return new Map([[1, 3], [3, algNoCose ?? -257], [-1, deB64url(j.n)], [-2, deB64url(j.e)]]);
    return new Map([[1, 2], [3, algNoCose ?? -7], [-1, 1], [-2, deB64url(j.x)], [-3, deB64url(j.y)]]);
  }
  flags(o) { return (o.up === false ? 0 : 1) | (o.uv === false ? 0 : 4) | (this.sincronizada ? 0x08 : 0); }
  async cadastrar(opcoes, o = {}) {
    const pk = opcoes.publicKey;
    const cd = te.encode(JSON.stringify({ type: o.tipo || "webauthn.create", challenge: o.desafio || pk.challenge, origin: o.origem || A, crossOrigin: false }));
    const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(o.rpId || pk.rp.id)));
    const ad = junta(rpHash, Uint8Array.of(this.flags(o) | 0x40), u32(this.contador), new Uint8Array(16), Uint8Array.of(0, this.id.length), this.id, cbor(await this.cose(o.algNoCose)));
    const ao = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]));
    this.userHandle = pk.user ? pk.user.id : "";
    return { id: b64url(this.id), rawId: b64url(this.id), type: "public-key", response: { clientDataJSON: b64url(cd), attestationObject: b64url(ao), transports: ["internal"] } };
  }
  async assinar(opcoes, o = {}) {
    const pk = opcoes.publicKey;
    if (o.contador !== undefined) this.contador = o.contador; else this.contador++;
    const cd = te.encode(JSON.stringify({ type: o.tipo || "webauthn.get", challenge: o.desafio || pk.challenge, origin: o.origem || A, crossOrigin: false }));
    const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(o.rpId || pk.rpId)));
    const ad = junta(rpHash, Uint8Array.of(this.flags(o)), u32(this.contador));
    const dados = junta(ad, new Uint8Array(await crypto.subtle.digest("SHA-256", cd)));
    const algo = this.alg === -257 ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
    let ass = new Uint8Array(await crypto.subtle.sign(algo, this.par.privateKey, dados));
    if (this.alg === -7) ass = brutaParaDer(ass);
    if (o.estragar) ass[ass.length - 1] ^= 1;
    return { id: b64url(this.id), rawId: b64url(this.id), type: "public-key",
      response: { clientDataJSON: b64url(cd), authenticatorData: b64url(ad), signature: b64url(ass), userHandle: o.userHandle !== undefined ? o.userHandle : this.userHandle } };
  }
}

console.log("WebAuthn: as peças");
{
  checar(cborInteiro(cbor(new Map([[1, 2], [-1, 1], ["a", Uint8Array.of(1, 2)]]))).get(-1) === 1, "CBOR lê mapa com chaves negativas e de texto");
  let erro = "";
  try { cborInteiro(Uint8Array.of(0x9f, 0x01, 0xff)); } catch (e) { erro = e.message; }
  checar(/indefinido/.test(erro), "CBOR de tamanho indefinido: recusado");
  try { erro = ""; cborInteiro(Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0xff)); } catch (e) { erro = e.message; }
  checar(/curto/.test(erro), "CBOR com tamanho maior que os bytes: recusado");
  try { erro = ""; cborInteiro(Uint8Array.of(0xa2, 0x01, 0x01, 0x01, 0x02)); } catch (e) { erro = e.message; }
  checar(/repetida/.test(erro), "CBOR com chave repetida: recusado");
  const raw = crypto.getRandomValues(new Uint8Array(64)); raw[0] |= 0x80; raw[32] = 0; raw[33] = 5;
  checar(Buffer.from(derParaBruta(brutaParaDer(raw))).equals(Buffer.from(raw)), "a assinatura DER vira r||s (com zero à esquerda e bit alto)");
  let e2 = "";
  try { lerDadosDoAutenticador(new Uint8Array(36)); } catch (e) { e2 = e.message; }
  checar(/curtos/.test(e2), "dados do autenticador curtos: recusados");
  checar(navegadorDe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36") === "Chrome no Windows" &&
    navegadorDe("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1") === "Safari no iPhone" &&
    navegadorDe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0") === "Edge no Windows",
    "o navegador resumido do user-agent");
}

// ------------------------------------------------------------------ a guia Seguranca: o aplicativo autenticador

console.log("ligar o aplicativo autenticador");
const ana = await criarConta("ana@exemplo.com.br", "senhaforte123", "Ana");
let r = await ana.n.chamar("/api/seguranca");
checar(r.status === 200 && r.d.ativa === false && r.d.disponivel.totp === true && r.d.disponivel.chaves === true && r.d.sessoes.length === 1 && r.d.sessoes[0].atual,
  "o estado: nada ligado, tudo disponível, esta sessão na lista", r.d);
checar(r.d.atividade.length === 1 && r.d.atividade[0].como === "cadastro", "a atividade tem a entrada do cadastro", r.d.atividade);
{
  const sem = await new Navegador().chamar("/api/seguranca");
  checar(sem.status === 401, "sem sessão: 401");
  const envSem = { ...env, CONTA_CHAVE_MESTRA: "" };
  r = await ana.n.chamar("/api/seguranca", { e: envSem });
  checar(r.d.disponivel.totp === false, "sem CONTA_CHAVE_MESTRA, a tela sabe que o aplicativo não está disponível");
  r = await ana.n.chamar("/api/seguranca/totp/iniciar", { corpo: {}, e: envSem });
  checar(r.status === 503 && r.d.codigo === "indisponivel", "e iniciar responde 503", r.d);
}
r = await comAgora(3601 * 1000, () => ana.n.chamar("/api/seguranca/totp/iniciar", { corpo: {} }));
checar(r.status === 401 && r.d.reentrar, "login de mais de uma hora: pede para entrar de novo", r.d);
r = await ana.n.chamar("/api/seguranca/totp/iniciar", { corpo: {} });
const segredoAna = deBase32(r.d.chave.replace(/\s/g, ""));
checar(r.status === 200 && segredoAna.length === 20 && r.d.uri.startsWith("otpauth://totp/Atos%3Aana%40exemplo.com.br?secret=") && /^<svg[^>]*>.*<\/svg>$/.test(r.d.qr) && !/script/i.test(r.d.qr),
  "iniciar: a chave (20 bytes em base32), o endereço otpauth e o QR em SVG sem script", r.d.uri);
{
  const objeto = env.SEGURANCA.get(ana.sub).o;
  const pend = await objeto.ctx.storage.get("pend-totp");
  checar(pend && pend.cifra && !JSON.stringify(pend).includes(r.d.chave.replace(/\s/g, "")), "o segredo pendente fica cifrado no objeto");
}
r = await ana.n.chamar("/api/seguranca/totp/ligar", { corpo: { codigo: "000000" === (await totp(segredoAna, Date.now())) ? "111111" : "000000" } });
checar(r.status === 400 && r.d.codigo === "codigo", "código errado: não liga", r.d);
r = await ana.n.chamar("/api/seguranca/totp/ligar", { corpo: { codigo: await totp(segredoAna, Date.now()) } });
const codigosAna = r.d.codigos;
checar(r.status === 200 && Array.isArray(codigosAna) && codigosAna.length === 10 && new Set(codigosAna).size === 10 && codigosAna.every((c) => /^[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/.test(c)),
  "código certo: liga e mostra 10 códigos de recuperação (uma vez)", r.d);
checar((await sessaoGuardada(ana.n)).mfa === true, "ligar marca esta sessão como mfa (a pessoa acabou de provar o segundo fator)");
{
  const reg = await env.SEGURANCA.get(ana.sub).o.ctx.storage.get("reg");
  checar(reg.totp.cifra && reg.rec.hashes.length === 10 && reg.rec.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)) && !JSON.stringify(reg).includes(codigosAna[0]),
    "guardados: o segredo cifrado e só os resumos dos códigos");
  const aviso = emails.at(-1);
  checar(aviso.to[0] === "ana@exemplo.com.br" && /ligada/.test(aviso.subject) && !/https?:\/\//.test(aviso.text) && !/<a\s/i.test(aviso.html) && /contato@atos\.dev\.br/.test(aviso.text),
    "aviso por e-mail: verificação ligada, sem link, com contato@", aviso.subject);
}
r = await ana.n.chamar("/api/seguranca");
checar(r.d.ativa === true && r.d.totp && r.d.recuperacao.restantes === 10 && r.d.atividade.some((x) => x.evento === "totp-ligada"), "o estado mostra ligado, 10 códigos e a mudança na atividade", r.d);
r = await ana.n.chamar("/api/seguranca/totp/iniciar", { corpo: {} });
checar(r.status === 409, "iniciar de novo com o aplicativo ligado: 409");

// ------------------------------------------------------------------ o login com a segunda etapa

console.log("entrar com a senha: a segunda etapa");
const b1 = new Navegador();
r = await b1.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
checar(r.status === 200 && !r.d.ok && r.d.etapa && r.d.etapa.otp === true && r.d.etapa.recuperacao === true && r.d.etapa.chave === false && !b1.cookies.has("__Host-atos") && b1.cookies.has("__Host-atos-etapa"),
  "senha certa: a sessão NÃO abre; vem a etapa (cookie da etapa, os métodos)", r.d);
r = await b1.chamar("/api/eu");
checar(r.d.conta === null, "sem a segunda etapa, ninguém está dentro");
r = await b1.chamar("/api/segunda-etapa/opcoes", { corpo: {} });
checar(r.status === 200 && r.d.metodos.otp && !r.d.publicKey && r.d.email === "a***@exemplo.com.br", "as opções da etapa (sem chave de acesso ainda)", r.d);
r = await b1.chamar("/api/segunda-etapa", { corpo: { codigo: "123456" === (await totp(segredoAna, Date.now())) ? "654321" : "123456" } });
checar(r.status === 400 && r.d.codigo === "codigo" && !b1.cookies.has("__Host-atos"), "código errado: continua fora", r.d);
const codigoAgora = await totp(segredoAna, Date.now());
r = await b1.chamar("/api/segunda-etapa", { corpo: { codigo: codigoAgora } });
// O codigo usado para ligar e do mesmo passo: nao vale de novo. Espera o proximo passo.
if (r.status !== 200) r = await comAgora(30000, async () => b1.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(segredoAna, Date.now()) } }));
const s1 = await sessaoGuardada(b1);
checar(r.status === 200 && r.d.ok && s1 && s1.mfa === true && JSON.stringify(s1.amr) === JSON.stringify(["pwd", "otp", "mfa"]) && !b1.cookies.has("__Host-atos-etapa"),
  "código certo: a sessão abre com mfa e amr pwd+otp+mfa; o cookie da etapa some", { d: r.d, s1 });
{
  // O mesmo codigo, em outra tentativa: nao vale (o ultimo passo fica guardado).
  const b2 = new Navegador();
  await b2.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  const reg = await env.SEGURANCA.get(ana.sub).o.ctx.storage.get("reg");
  const usado = await hotp(segredoAna, reg.totp.ultimo);
  r = await comAgora((reg.totp.ultimo * 30 - Math.floor(Date.now() / 1000)) * 1000 + 1000, () => b2.chamar("/api/segunda-etapa", { corpo: { codigo: usado } }));
  checar(r.status === 400 && !b2.cookies.has("__Host-atos"), "o mesmo código não entra duas vezes", r.d);
  // A etapa morre depois de 5 erros.
  let ultima;
  for (let i = 0; i < 5; i++) ultima = await b2.chamar("/api/segunda-etapa", { corpo: { codigo: "000001" } });
  checar(ultima.d.recomecar === true && !b2.cookies.has("__Host-atos-etapa"), "5 erros: a etapa acaba e pede para entrar de novo", ultima.d);
  r = await b2.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(segredoAna, Date.now()) } });
  checar(r.status === 400 && r.d.recomecar, "depois disso, nem o código certo vale naquela etapa", r.d);
  // A etapa vence em 5 minutos.
  const b3 = new Navegador();
  await b3.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  r = await comAgora(301 * 1000, async () => b3.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(segredoAna, Date.now()) } }));
  checar(r.status === 400 && r.d.recomecar && !b3.cookies.has("__Host-atos"), "a etapa vence em 5 minutos", r.d);
  // A etapa de uma conta nao serve para outra: o cookie forjado com outro sub nao acha a etapa.
  const b4 = new Navegador();
  await b4.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  const [, token] = b4.cookies.get("__Host-atos-etapa").split(".");
  b4.cookies.set("__Host-atos-etapa", Buffer.from("outra-conta").toString("base64url") + "." + token);
  r = await b4.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(segredoAna, Date.now()) } });
  checar(r.status === 400 && r.d.recomecar, "o cookie da etapa com outro sub: não acha nada", r.d);
}

console.log("os códigos de recuperação");
{
  const b = new Navegador();
  await b.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  const antes = emails.length;
  r = await b.chamar("/api/segunda-etapa", { corpo: { recuperacao: codigosAna[0].toUpperCase().replace(/-/g, " ") } });
  const s = await sessaoGuardada(b);
  checar(r.status === 200 && s.mfa && JSON.stringify(s.amr) === JSON.stringify(["pwd", "otp", "mfa"]), "um código de recuperação entra (maiúsculas e espaços valem)", r.d);
  checar(emails.length === antes + 1 && /recuperação foi usado/.test(emails.at(-1).subject) && /Restam 9/.test(emails.at(-1).text), "e manda o aviso, com quantos restam", emails.at(-1).subject);
  const b2 = new Navegador();
  await b2.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  r = await b2.chamar("/api/segunda-etapa", { corpo: { recuperacao: codigosAna[0] } });
  checar(r.status === 400 && !b2.cookies.has("__Host-atos"), "o mesmo código de recuperação não vale duas vezes", r.d);
  r = await ana.n.chamar("/api/seguranca/recuperacao/gerar", { corpo: {} });
  const novos = r.d.codigos;
  checar(r.status === 200 && novos.length === 10 && !novos.includes(codigosAna[1]) && /Novos códigos/.test(emails.at(-1).subject), "gerar de novo: 10 novos (e o aviso)", r.d);
  r = await b2.chamar("/api/segunda-etapa", { corpo: { recuperacao: codigosAna[1] } });
  checar(r.status === 400, "os antigos deixam de valer", r.d);
  r = await b2.chamar("/api/segunda-etapa", { corpo: { recuperacao: novos[3] } });
  checar(r.status === 200, "os novos valem", r.d);
  codigosAna.splice(0, 10, ...novos.filter((_, i) => i !== 3));
}

console.log("o limite de tentativas (o mesmo do login)");
{
  const z = await criarConta("zeca@exemplo.com.br", "senhaforte123");
  r = await z.n.chamar("/api/seguranca/totp/iniciar", { corpo: {} });
  const seg = deBase32(r.d.chave.replace(/\s/g, ""));
  await z.n.chamar("/api/seguranca/totp/ligar", { corpo: { codigo: await totp(seg, Date.now()) } });
  let bloqueou = null;
  for (let i = 0; i < TENTATIVAS + 1 && !bloqueou; i++) {
    const b = new Navegador();
    await b.chamar("/api/entrar", { corpo: { email: "zeca@exemplo.com.br", senha: "senhaforte123" } });
    for (let j = 0; j < 2; j++) {
      const x = await b.chamar("/api/segunda-etapa", { corpo: { codigo: "999999" } });
      if (x.status === 429) { bloqueou = x; break; }
    }
  }
  checar(bloqueou && bloqueou.status === 429, "depois de " + TENTATIVAS + " códigos errados na conta: 429, espere 15 minutos", bloqueou && bloqueou.d);
  const b = new Navegador();
  await b.chamar("/api/entrar", { corpo: { email: "zeca@exemplo.com.br", senha: "senhaforte123" } });
  r = await comAgora(30000, async () => b.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(seg, Date.now()) } }));
  checar(r.status === 429, "bloqueado: nem o código certo entra", r.d);
  r = await comAgora(16 * 60 * 1000, async () => {
    const c = new Navegador();
    await c.chamar("/api/entrar", { corpo: { email: "zeca@exemplo.com.br", senha: "senhaforte123" } });
    return c.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(seg, Date.now()) } });
  });
  checar(r.status === 200, "15 minutos depois, entra", r.d);
}

// ------------------------------------------------------------------ as chaves de acesso

console.log("chaves de acesso: cadastrar");
const chaveAna = await Autenticador.novo(-7);
r = await ana.n.chamar("/api/seguranca/chaves/opcoes", { corpo: {} });
const opReg = r.d;
checar(r.status === 200 && opReg.publicKey.rp.id === "atos.dev.br" && opReg.publicKey.authenticatorSelection.userVerification === "required" &&
  opReg.publicKey.authenticatorSelection.residentKey === "required" && opReg.publicKey.attestation === "none" &&
  JSON.stringify(opReg.publicKey.pubKeyCredParams.map((x) => x.alg)) === "[-7,-257]" && Buffer.from(opReg.publicKey.user.id, "base64url").toString() === ana.sub,
  "as opções: rp atos.dev.br, UV e chave descobrível exigidas, atestação none, ES256 e RS256", opReg.publicKey);
{
  const casos = [
    ["origem errada", { origem: "https://mal.example" }],
    ["rpId errado", { rpId: "mal.example" }],
    ["sem UV", { uv: false }],
    ["sem presença (UP)", { up: false }],
    ["tipo errado", { tipo: "webauthn.get" }],
    ["algoritmo desconhecido (EdDSA, -8)", { algNoCose: -8 }],
  ];
  for (const [nome, o] of casos) {
    const op = (await ana.n.chamar("/api/seguranca/chaves/opcoes", { corpo: {} })).d;
    const x = await ana.n.chamar("/api/seguranca/chaves/registrar", { corpo: { nome: "x", credencial: await (await Autenticador.novo(-7)).cadastrar(op, o) } });
    checar(x.status === 400 && x.d.codigo === "invalida", "cadastro recusado: " + nome, x.d);
  }
  const op = (await ana.n.chamar("/api/seguranca/chaves/opcoes", { corpo: {} })).d;
  const x = await ana.n.chamar("/api/seguranca/chaves/registrar", { corpo: { nome: "x", credencial: await (await Autenticador.novo(-7)).cadastrar(op, { desafio: b64url(crypto.getRandomValues(new Uint8Array(32))) }) } });
  checar(x.status === 400 && x.d.codigo === "desafio", "cadastro com um desafio que o servidor não deu: recusado", x.d);
}
r = await ana.n.chamar("/api/seguranca/chaves/registrar", { corpo: { nome: "Notebook <b>", credencial: await chaveAna.cadastrar(opReg) } });
checar(r.status === 200 && r.d.chave.nome === "Notebook b" && r.d.chave.sincronizada === false && !r.d.codigos, "cadastra a chave ES256 (sem códigos novos: já existiam)", r.d);
checar(JSON.parse(guardados.get("atos:seg:chave:" + b64url(chaveAna.id))).sub === ana.sub && /chave de acesso foi cadastrada/.test(emails.at(-1).subject),
  "o índice da chave (para entrar sem senha) e o aviso por e-mail");
r = await ana.n.chamar("/api/seguranca/chaves/registrar", { corpo: { nome: "de novo", credencial: await chaveAna.cadastrar(opReg) } });
checar(r.status !== 200, "o mesmo desafio não vale duas vezes", r.d);
{
  const op = (await ana.n.chamar("/api/seguranca/chaves/opcoes", { corpo: {} })).d;
  checar(op.publicKey.excludeCredentials.length === 1 && op.publicKey.excludeCredentials[0].id === b64url(chaveAna.id), "as opções excluem a chave que já existe");
  const x = await ana.n.chamar("/api/seguranca/chaves/registrar", { corpo: { nome: "repetida", credencial: await chaveAna.cadastrar(op) } });
  checar(x.status === 409, "a mesma credencial de novo: 409", x.d);
}
const chaveRsa = await Autenticador.novo(-257, { sincronizada: true });
{
  const op = (await ana.n.chamar("/api/seguranca/chaves/opcoes", { corpo: {} })).d;
  r = await ana.n.chamar("/api/seguranca/chaves/registrar", { corpo: { nome: "Celular", credencial: await chaveRsa.cadastrar(op) } });
  checar(r.status === 200 && r.d.chave.sincronizada === true, "cadastra uma chave RS256 (sincronizada: a marca BE)", r.d);
}

console.log("chaves de acesso: a segunda etapa");
{
  const b = new Navegador();
  r = await b.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  checar(r.d.etapa && r.d.etapa.chave === true, "a etapa oferece a chave de acesso", r.d);
  let op = (await b.chamar("/api/segunda-etapa/opcoes", { corpo: {} })).d;
  checar(op.publicKey && op.publicKey.rpId === "atos.dev.br" && op.publicKey.allowCredentials.length === 2 && op.publicKey.userVerification === "required", "as opções do get: as duas chaves, UV exigida", op);
  r = await b.chamar("/api/segunda-etapa", { corpo: { credencial: await chaveAna.assinar(op, { estragar: true }) } });
  checar(r.status === 400 && r.d.codigo === "chave", "assinatura errada: recusada", r.d);
  op = (await b.chamar("/api/segunda-etapa/opcoes", { corpo: {} })).d;
  r = await b.chamar("/api/segunda-etapa", { corpo: { credencial: await chaveAna.assinar(op, { uv: false }) } });
  checar(r.status === 400, "sem UV: recusada", r.d);
  op = (await b.chamar("/api/segunda-etapa/opcoes", { corpo: {} })).d;
  r = await b.chamar("/api/segunda-etapa", { corpo: { credencial: await chaveAna.assinar(op, { origem: "https://atos.dev.br.mal.example" }) } });
  checar(r.status === 400, "origem errada: recusada", r.d);
  op = (await b.chamar("/api/segunda-etapa/opcoes", { corpo: {} })).d;
  const certa = await chaveAna.assinar(op);
  r = await b.chamar("/api/segunda-etapa", { corpo: { credencial: certa } });
  const s = await sessaoGuardada(b);
  checar(r.status === 200 && s.mfa && JSON.stringify(s.amr) === JSON.stringify(["pwd", "hwk", "user", "mfa"]), "a chave certa entra: amr pwd+hwk+user+mfa", { d: r.d, amr: s && s.amr });
  const b2 = new Navegador();
  await b2.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  r = await b2.chamar("/api/segunda-etapa", { corpo: { credencial: certa } });
  checar(r.status === 400 && !b2.cookies.has("__Host-atos"), "a mesma asserção (desafio já usado) não vale em outra tentativa", r.d);
}

console.log("chaves de acesso: entrar sem senha");
{
  const b = new Navegador();
  let op = (await b.chamar("/api/chave/opcoes", { corpo: {} })).d;
  checar(op.publicKey && op.publicKey.allowCredentials.length === 0 && op.publicKey.rpId === "atos.dev.br", "as opções: chave descobrível (sem lista)", op);
  r = await b.chamar("/api/chave/entrar", { corpo: { credencial: await chaveRsa.assinar(op) } });
  const s = await sessaoGuardada(b);
  checar(r.status === 200 && r.d.conta.email === "ana@exemplo.com.br" && s.mfa && s.como === "chave" && JSON.stringify(s.amr) === JSON.stringify(["swk", "user", "mfa"]),
    "a chave sozinha entra (as duas etapas): amr swk+user+mfa", { d: r.d, s });
  r = await new Navegador().chamar("/api/chave/entrar", { corpo: { credencial: await chaveRsa.assinar(op) } });
  checar(r.status === 400 && r.d.codigo === "desafio", "o desafio do entrar é de uso único", r.d);
  op = (await b.chamar("/api/chave/opcoes", { corpo: {} })).d;
  r = await new Navegador().chamar("/api/chave/entrar", { corpo: { credencial: await chaveAna.assinar(op, { userHandle: b64url(te.encode("outra-conta")) }) } });
  checar(r.status === 400 && r.d.codigo === "chave_desconhecida", "o userHandle de outra conta: recusado", r.d);
  op = (await b.chamar("/api/chave/opcoes", { corpo: {} })).d;
  r = await new Navegador().chamar("/api/chave/entrar", { corpo: { credencial: await (await Autenticador.novo(-7)).assinar(op) } });
  checar(r.status === 400 && r.d.codigo === "chave_desconhecida", "uma chave que não é de ninguém: recusada", r.d);
  // O contador que volta: entra, mas fica o aviso na chave e na atividade.
  op = (await b.chamar("/api/chave/opcoes", { corpo: {} })).d;
  r = await new Navegador().chamar("/api/chave/entrar", { corpo: { credencial: await chaveAna.assinar(op, { contador: 1 }) } });
  const est = (await ana.n.chamar("/api/seguranca")).d;
  const c = est.chaves.find((x) => x.nome === "Notebook b");
  checar(r.status === 200 && c.alerta && c.alerta.motivo === "contador" && est.atividade.some((x) => x.evento === "chave-contador"), "o contador que regride: entra com aviso (a chave fica marcada)", { r: r.d, c });
}

// ------------------------------------------------------------------ desligar, remover e as regras das mudancas

console.log("as regras das mudanças");
{
  // Uma sessao sem mfa (de antes de ligar) nao muda nada com a etapa ligada.
  const velha = new Navegador();
  const segredo = "sessao-velha-da-ana";
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub: ana.sub, email: "ana@exemplo.com.br", auth_time: Math.floor(Date.now() / 1000), criada: Date.now() }));
  velha.cookies.set("__Host-atos", segredo);
  r = await velha.chamar("/api/seguranca/chaves/opcoes", { corpo: {} });
  checar(r.status === 401 && r.d.reentrar, "sessão sem mfa: não cadastra chave com a etapa ligada", r.d);
  r = await velha.chamar("/api/seguranca/recuperacao/gerar", { corpo: {} });
  checar(r.status === 401, "nem gera códigos", r.d);
  r = await velha.chamar("/api/seguranca/chaves/remover", { corpo: { id: b64url(chaveAna.id) } });
  checar(r.status === 401, "nem remove chave", r.d);
  r = await ana.n.chamar("/api/seguranca/totp/desligar", { corpo: {} });
  checar(r.status === 400, "desligar sem código: recusado", r.d);
  r = await ana.n.chamar("/api/seguranca/totp/desligar", { corpo: { codigo: "000002" } });
  checar(r.status === 400, "desligar com código errado: recusado", r.d);
  r = await ana.n.chamar("/api/seguranca/totp/desligar", { corpo: { recuperacao: codigosAna[0] } });
  checar(r.status === 200 && r.d.ativa === true && /aplicativo autenticador foi desligado/.test(emails.at(-1).subject), "desligar com um código de recuperação: o aplicativo sai, as chaves ficam (e o aviso)", r.d);
  r = await ana.n.chamar("/api/seguranca/chaves/remover", { corpo: { id: b64url(chaveAna.id) } });
  checar(r.status === 200 && r.d.ativa === true && !guardados.has("atos:seg:chave:" + b64url(chaveAna.id)) && /removida/.test(emails.at(-1).subject), "remover uma chave: sai do índice (e o aviso)", r.d);
  const op = (await new Navegador().chamar("/api/chave/opcoes", { corpo: {} })).d;
  r = await new Navegador().chamar("/api/chave/entrar", { corpo: { credencial: await chaveAna.assinar(op) } });
  checar(r.status === 400, "a chave removida não entra mais", r.d);
  r = await ana.n.chamar("/api/seguranca/chaves/remover", { corpo: { id: b64url(chaveRsa.id) } });
  const est = (await ana.n.chamar("/api/seguranca")).d;
  checar(r.status === 200 && r.d.ativa === false && est.ativa === false && est.recuperacao === null && /está desligada/.test(emails.at(-1).subject),
    "a última segunda etapa sai: a verificação desliga e os códigos somem (e o aviso diz)", { r: r.d, est });
  const b = new Navegador();
  r = await b.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  checar(r.status === 200 && r.d.ok && b.cookies.has("__Host-atos"), "sem segunda etapa, a senha entra direto", r.d);
  checar(JSON.stringify((await sessaoGuardada(b)).amr) === '["pwd"]' && (await sessaoGuardada(b)).mfa !== true, "amr pwd, sem mfa");
}

// ------------------------------------------------------------------ Google, cadastro, Esqueci a senha, alias de outra conta

console.log("a segunda etapa em todos os caminhos de entrar");
const bia = await criarConta("bia@exemplo.com.br", "senhaforte123", "Bia");
r = await bia.n.chamar("/api/seguranca/totp/iniciar", { corpo: {} });
const segredoBia = deBase32(r.d.chave.replace(/\s/g, ""));
await bia.n.chamar("/api/seguranca/totp/ligar", { corpo: { codigo: await totp(segredoBia, Date.now()) } });
const proximo = (ms = 30000) => (fn) => comAgora(ms, fn);
{
  // Google
  const g = await worker.fetch(new Request(A + "/oauth/google?consulta="), env);
  const state = new URL(g.headers.get("location")).searchParams.get("state");
  const k = [...guardados.keys()].find((x) => x.startsWith("atos:google:"));
  googleDiz = { sub: "g-bia", email: "bia@exemplo.com.br", name: "Bia", nonce: JSON.parse(guardados.get(k)).nonce };
  const v = await worker.fetch(new Request(A + "/oauth/google/volta?code=c&state=" + encodeURIComponent(state)), env);
  const loc = v.headers.get("location") || "";
  const scs = v.headers.getSetCookie();
  checar(v.status === 302 && loc === A + "/entrar/?etapa=1" && scs.length === 1 && scs[0].startsWith("__Host-atos-etapa=") && /HttpOnly/.test(scs[0]),
    "Google com a etapa: volta a /entrar?etapa=1 só com o cookie da etapa (sem sessão)", { loc, scs });
  const b = new Navegador();
  b.guardar(v);
  r = await proximo()(async () => b.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(segredoBia, Date.now()) } }));
  checar(r.status === 200 && JSON.stringify((await sessaoGuardada(b)).amr) === '["fed","otp","mfa"]', "e o código abre a sessão: amr fed+otp+mfa", r.d);
}
{
  // O codigo do cadastro numa conta que ja existe nao pula a etapa.
  const b = new Navegador();
  guardados.set("id:pend:bia@exemplo.com.br", JSON.stringify({ sal: "00", hash: "00", iteracoes: 1, nome: "", codigo: await sha256("cod:bia@exemplo.com.br:123456") }));
  r = await b.chamar("/api/confirmar", { corpo: { email: "bia@exemplo.com.br", codigo: "123456" } });
  checar(r.status === 200 && r.d.etapa && !b.cookies.has("__Host-atos"), "o código do cadastro numa conta que já existe: pede a etapa", r.d);
}
{
  // Esqueci a senha: a senha troca, mas entrar ainda pede a etapa.
  const b = new Navegador();
  const sessaoAntiga = new Navegador(); sessaoAntiga.cookies = new Map(bia.n.cookies);
  await b.chamar("/api/esqueci", { corpo: { email: "bia@exemplo.com.br" } });
  const cod = codigoDe(emails.at(-1));
  const antes = emails.length;
  r = await comAgora(2000, () => b.chamar("/api/redefinir", { corpo: { email: "bia@exemplo.com.br", codigo: cod, senha: "outrasenha456" } }));
  checar(r.status === 200 && r.d.etapa && !b.cookies.has("__Host-atos") && b.cookies.has("__Host-atos-etapa"), "redefinir com a etapa ligada: a senha troca, a sessão não abre", r.d);
  const aviso = emails.slice(antes).find((m) => /senha da sua Conta Atos foi trocada/.test(m.subject));
  checar(aviso && !/https?:\/\//.test(aviso.text) && !/<a\s/i.test(aviso.html), "aviso de senha trocada, sem link", emails.slice(antes).map((m) => m.subject));
  r = await sessaoAntiga.chamar("/api/eu");
  checar(r.d.conta === null, "a troca derruba as sessões de antes");
  r = await proximo(60000)(async () => b.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(segredoBia, Date.now()) } }));
  checar(r.status === 200 && (await sessaoGuardada(b)).como === "redefinir", "o código conclui a entrada", r.d);
  r = await new Navegador().chamar("/api/entrar", { corpo: { email: "bia@exemplo.com.br", senha: "outrasenha456" } });
  checar(r.d.etapa, "a senha nova também passa pela etapa");
}

// ------------------------------------------------------------------ o id_token diz como entrou (amr)

console.log("OIDC: o amr no id_token");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, desafio: b64url(await crypto.subtle.digest("SHA-256", te.encode(verifier))) };
}
async function idTokenDe(n) {
  const p = await pkce();
  const consulta = new URLSearchParams({ client_id: "pavlvs-site", redirect_uri: "https://paulus.ia.br/entrar-atos/", response_type: "code", scope: "openid email",
    state: "s", nonce: "n", code_challenge_method: "S256", code_challenge: p.desafio }).toString();
  const a = await n.chamar("/api/autorizar", { corpo: { consulta, permitir: true } });
  const code = new URL(a.d.ir).searchParams.get("code");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://paulus.ia.br/entrar-atos/", client_id: "pavlvs-site", code_verifier: p.verifier }).toString();
  const r2 = await worker.fetch(new Request(A + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://paulus.ia.br" }, body }), env);
  return conferirIdToken(env, (await r2.json()).id_token);
}
{
  const b = new Navegador();
  await b.chamar("/api/entrar", { corpo: { email: "bia@exemplo.com.br", senha: "outrasenha456" } });
  await proximo(90000)(async () => b.chamar("/api/segunda-etapa", { corpo: { codigo: await totp(segredoBia, Date.now()) } }));
  const t = await proximo(90000)(() => idTokenDe(b));
  checar(t && JSON.stringify(t.amr) === '["pwd","otp","mfa"]' && t.sub === bia.sub, "senha + código do aplicativo: amr [pwd, otp, mfa]", t);
  const c = await criarConta("cris@exemplo.com.br", "senhaforte123");
  const t2 = await idTokenDe(c.n);
  checar(t2 && JSON.stringify(t2.amr) === '["pwd"]', "só a senha: amr [pwd]", t2);
  const velha = new Navegador();
  guardados.set("atos:sessao:" + (await sha256("velha-cris")), JSON.stringify({ sub: c.sub, email: "cris@exemplo.com.br", auth_time: Math.floor(Date.now() / 1000) }));
  velha.cookies.set("__Host-atos", "velha-cris");
  const t3 = await idTokenDe(velha);
  checar(t3 && t3.amr === undefined && t3.sub === c.sub, "sessão de antes do amr: o id_token sai sem amr (sub e e-mail iguais)", t3);
  const disc = await (await worker.fetch(new Request(A + "/.well-known/openid-configuration"), env)).json();
  checar(disc.claims_supported.includes("amr"), "a descoberta anuncia o amr");
}

// ------------------------------------------------------------------ o painel

console.log("o painel: ligar a etapa e voltar");
{
  r = await ana.n.chamar("/api/admin/eu");
  checar(r.status === 403 && r.d.configurar_2fa && r.d.ir === "/conta/seguranca", "a dona sem a etapa: 403 mandando a /conta/seguranca", r.d);
  r = await ana.n.chamar("/api/seguranca/totp/iniciar", { corpo: {} });
  const seg = deBase32(r.d.chave.replace(/\s/g, ""));
  await ana.n.chamar("/api/seguranca/totp/ligar", { corpo: { codigo: await totp(seg, Date.now()) } });
  r = await ana.n.chamar("/api/admin/eu");
  checar(r.status === 200 && r.d.email === "ana@exemplo.com.br", "liga o aplicativo na Minha conta e o painel abre na mesma sessão (sem trancar a dona)", r.d);
  const b = new Navegador();
  await b.chamar("/api/entrar", { corpo: { email: "ana@exemplo.com.br", senha: "senhaforte123" } });
  r = await b.chamar("/api/admin/eu");
  checar(r.status === 401 && r.d.entrar, "só com a senha (etapa pendente): o painel não abre", r.d);
}

// ------------------------------------------------------------------ as sessoes e a atividade

console.log("sessões: sair desta e sair de todas as outras");
{
  const d = await criarConta("davi@exemplo.com.br", "senhaforte123");
  const outra = new Navegador();
  await outra.chamar("/api/entrar", { corpo: { email: "davi@exemplo.com.br", senha: "senhaforte123" }, headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" } });
  const terceira = new Navegador();
  await terceira.chamar("/api/entrar", { corpo: { email: "davi@exemplo.com.br", senha: "senhaforte123" } });
  // uma sessao aberta antes da lista existir
  guardados.set("atos:sessao:" + (await sha256("davi-antiga")), JSON.stringify({ sub: d.sub, email: "davi@exemplo.com.br", auth_time: Math.floor(Date.now() / 1000) - 100 }));
  const antiga = new Navegador(); antiga.cookies.set("__Host-atos", "davi-antiga");
  r = await d.n.chamar("/api/seguranca");
  const sessoes = r.d.sessoes;
  checar(sessoes.length === 3 && sessoes.filter((x) => x.atual).length === 1 && sessoes.some((x) => x.navegador === "Safari no iPhone") && sessoes.every((x) => !x.h && /^[0-9a-f]{20}$/.test(x.id)),
    "a lista: as três sessões, a atual marcada, o navegador resumido, sem a chave da sessão", sessoes);
  checar(!JSON.stringify(r.d).match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/), "nenhum endereço de internet na resposta");
  const doIphone = sessoes.find((x) => x.navegador === "Safari no iPhone");
  r = await d.n.chamar("/api/seguranca/sessoes/sair", { corpo: { id: doIphone.id } });
  checar(r.status === 200 && (await outra.chamar("/api/eu")).d.conta === null && (await terceira.chamar("/api/eu")).d.conta, "sair desta (a do iPhone): só ela cai", r.d);
  r = await comAgora(5, () => d.n.chamar("/api/seguranca/sessoes/sair-outras", { corpo: {} }));
  checar(r.status === 200 && (await terceira.chamar("/api/eu")).d.conta === null && (await antiga.chamar("/api/eu")).d.conta === null && (await d.n.chamar("/api/eu")).d.conta,
    "sair de todas as outras: as outras caem (também a de antes da lista), esta continua", r.d);
  checar(JSON.parse(guardados.get("id:conta:davi@exemplo.com.br")).sessoes_desde > 0, "a conta guarda o instante (sessoes_desde)");
  r = await d.n.chamar("/api/seguranca");
  checar(r.d.sessoes.length === 1 && r.d.atividade.some((x) => x.evento === "sair-outras") && r.d.atividade.filter((x) => x.tipo === "entrada").length === 3,
    "a lista fica só com esta; a atividade tem as entradas e a mudança", r.d);
  const envT = { ...env, AMBIENTE: "teste" };
  checar(navegadorDe("") === "" && (await d.n.chamar("/api/seguranca", { e: envT })).d.atividade.length === 0, "o Worker de teste tem a própria atividade (o prefixo atos-teste:)");
}

console.log("a atividade: até 30, por 90 dias");
{
  const e = await criarConta("eva@exemplo.com.br", "senhaforte123");
  for (let i = 0; i < 32; i++) await new Navegador().chamar("/api/entrar", { corpo: { email: "eva@exemplo.com.br", senha: "senhaforte123" } });
  r = await e.n.chamar("/api/seguranca");
  checar(r.d.atividade.length === 30, "só as 30 últimas", r.d.atividade.length);
  const k = "atos:seg:atividade:" + e.sub;
  const lista = JSON.parse(guardados.get(k));
  lista[0].quando = new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString();
  guardados.set(k, JSON.stringify(lista));
  r = await e.n.chamar("/api/seguranca");
  checar(r.d.atividade.length === 29, "o que tem mais de 90 dias sai", r.d.atividade.length);
}

console.log("sem o objeto de segurança no ar: recusa, nunca entra sem a etapa");
{
  const fora = { ...env, SEGURANCA: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("fora do ar"); } }) } };
  r = await new Navegador().chamar("/api/entrar", { corpo: { email: "bia@exemplo.com.br", senha: "outrasenha456" }, e: fora });
  checar(r.status === 503 && !r.d.ok, "o login responde 503 (não abre a sessão)", r.d);
}

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
