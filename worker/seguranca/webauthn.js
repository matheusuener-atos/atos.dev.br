// As chaves de acesso (passkeys, WebAuthn nivel 2) do lado do servidor, sem biblioteca: o CBOR minimo, os dados do
// autenticador, a chave publica COSE e a assinatura pela WebCrypto.
//
// O que se confere (https://www.w3.org/TR/webauthn-2/, 7.1 e 7.2):
//   - clientDataJSON: o tipo (webauthn.create / webauthn.get), o desafio (de uso unico, guardado no servidor) e a
//     origem exata (https://atos.dev.br; no teste, a do Worker de teste; no local, http://localhost:<porta>);
//     crossOrigin precisa ser falso;
//   - authenticatorData: o resumo do rpId (SHA-256), as marcas UP (presenca) e UV (verificacao: PIN ou biometria; exigida),
//     o contador e, no cadastro, a credencial (AT) com a chave publica;
//   - os algoritmos: ES256 (-7, P-256) e RS256 (-257, RSA PKCS#1 v1.5 com SHA-256). Outro: recusado.
// A atestacao nao e conferida nem usada: a Atos pede "none" (nao quer saber o modelo do aparelho), e o que vier no
// attStmt e ignorado. A confianca vem do desafio, da origem e da assinatura em cada uso.

import { b64url, deB64url } from "../comum.js";

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

export const ALGORITMOS = [-7, -257];
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_BE = 0x08, FLAG_BS = 0x10, FLAG_AT = 0x40, FLAG_ED = 0x80;

export class ErroWebAuthn extends Error {
  constructor(motivo) { super(motivo); this.motivo = motivo; }
}
const falha = (m) => { throw new ErroWebAuthn(m); };

// ------------------------------------------------------------------ CBOR (RFC 8949), so o que o WebAuthn usa

/* Le um item CBOR de `b` (Uint8Array) a partir de `i`: {valor, fim}. Mapas viram Map (as chaves COSE sao numeros).
   Sem tamanho indefinido, sem tags, sem numeros de ponto flutuante: o CTAP2 usa a forma canonica, sem eles. */
export function lerCbor(b, i = 0, prof = 0) {
  if (prof > 16) falha("CBOR fundo demais");
  if (i >= b.length) falha("CBOR curto");
  const ini = b[i++];
  const maior = ini >> 5, menor = ini & 31;
  let n;
  if (menor < 24) n = menor;
  else if (menor === 24) { if (i + 1 > b.length) falha("CBOR curto"); n = b[i]; i += 1; }
  else if (menor === 25) { if (i + 2 > b.length) falha("CBOR curto"); n = (b[i] << 8) | b[i + 1]; i += 2; }
  else if (menor === 26) { if (i + 4 > b.length) falha("CBOR curto"); n = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; i += 4; }
  else if (menor === 27) {
    if (i + 8 > b.length) falha("CBOR curto");
    let x = 0n;
    for (let k = 0; k < 8; k++) x = (x << 8n) | BigInt(b[i + k]);
    if (x > BigInt(Number.MAX_SAFE_INTEGER)) falha("CBOR: número grande demais");
    n = Number(x); i += 8;
  } else falha("CBOR: tamanho indefinido ou reservado");
  switch (maior) {
    case 0: return { valor: n, fim: i };
    case 1: return { valor: -1 - n, fim: i };
    case 2: if (i + n > b.length) falha("CBOR curto"); return { valor: b.slice(i, i + n), fim: i + n };
    case 3: {
      if (i + n > b.length) falha("CBOR curto");
      let s;
      try { s = td.decode(b.subarray(i, i + n)); } catch { falha("CBOR: texto inválido"); }
      return { valor: s, fim: i + n };
    }
    case 4: {
      if (n > 1000) falha("CBOR: lista grande demais");
      const l = [];
      for (let k = 0; k < n; k++) { const x = lerCbor(b, i, prof + 1); l.push(x.valor); i = x.fim; }
      return { valor: l, fim: i };
    }
    case 5: {
      if (n > 1000) falha("CBOR: mapa grande demais");
      const m = new Map();
      for (let k = 0; k < n; k++) {
        const c = lerCbor(b, i, prof + 1);
        if (typeof c.valor !== "number" && typeof c.valor !== "string") falha("CBOR: chave de mapa inválida");
        if (m.has(c.valor)) falha("CBOR: chave repetida");
        const v = lerCbor(b, c.fim, prof + 1);
        m.set(c.valor, v.valor); i = v.fim;
      }
      return { valor: m, fim: i };
    }
    case 7:
      if (menor === 20) return { valor: false, fim: i };
      if (menor === 21) return { valor: true, fim: i };
      if (menor === 22) return { valor: null, fim: i };
      return falha("CBOR: valor simples não aceito");
    default:
      return falha("CBOR: tag não aceita");
  }
}

/* Um item que ocupa `b` inteiro (sem sobra). */
export function cborInteiro(b) {
  const x = lerCbor(b, 0);
  if (x.fim !== b.length) falha("CBOR com sobra");
  return x.valor;
}

// ------------------------------------------------------------------ os dados do autenticador

/* {rpIdHash, flags, up, uv, be, bs, contador, credencial?: {aaguid, id, chaveCose (Map), chaveBytes}} */
export function lerDadosDoAutenticador(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 37) falha("dados do autenticador curtos");
  const flags = b[32];
  const r = {
    rpIdHash: b.slice(0, 32), flags, up: Boolean(flags & FLAG_UP), uv: Boolean(flags & FLAG_UV), be: Boolean(flags & FLAG_BE),
    bs: Boolean(flags & FLAG_BS), contador: ((b[33] << 24) >>> 0) + (b[34] << 16) + (b[35] << 8) + b[36], credencial: null,
  };
  let i = 37;
  if (flags & FLAG_AT) {
    if (b.length < i + 18) falha("credencial curta");
    const aaguid = b.slice(i, i + 16); i += 16;
    const n = (b[i] << 8) | b[i + 1]; i += 2;
    if (n < 16 || n > 1023 || b.length < i + n) falha("identificador da credencial inválido");
    const id = b.slice(i, i + n); i += n;
    const k = lerCbor(b, i);
    if (!(k.valor instanceof Map)) falha("chave pública inválida");
    r.credencial = { aaguid, id, chaveCose: k.valor, chaveBytes: b.slice(i, k.fim) };
    i = k.fim;
  }
  if (flags & FLAG_ED) {
    const e = lerCbor(b, i);
    if (!(e.valor instanceof Map)) falha("extensões inválidas");
    i = e.fim;
  }
  if (i !== b.length) falha("dados do autenticador com sobra");
  return r;
}

// ------------------------------------------------------------------ a chave publica (COSE, RFC 9053)

/* A chave COSE -> {alg, jwk} (o que se guarda), ou recusa. */
export function chaveDoCose(m) {
  const kty = m.get(1), alg = m.get(3);
  if (!ALGORITMOS.includes(alg)) falha("algoritmo não aceito");
  if (alg === -7) {
    const x = m.get(-2), y = m.get(-3);
    if (kty !== 2 || m.get(-1) !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) falha("chave ES256 inválida");
    return { alg, jwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) } };
  }
  const n = m.get(-1), e = m.get(-2);
  if (kty !== 3 || !(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256 || n.length > 512 || e.length < 1 || e.length > 8) falha("chave RS256 inválida");
  return { alg, jwk: { kty: "RSA", n: b64url(n), e: b64url(e) } };
}

async function importar(alg, jwk) {
  if (alg === -7) return crypto.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (alg === -257) return crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return falha("algoritmo não aceito");
}

/* A assinatura ECDSA do autenticador vem em DER (SEQUENCE de dois INTEGER); a WebCrypto quer r||s (64 bytes). */
export function derParaBruta(der) {
  const b = der instanceof Uint8Array ? der : new Uint8Array(der);
  let i = 0;
  const tam = () => {
    let n = b[i++];
    if (n & 0x80) { const k = n & 0x7f; if (k < 1 || k > 2) falha("assinatura inválida"); n = 0; for (let j = 0; j < k; j++) n = (n << 8) | b[i++]; }
    return n;
  };
  if (b[i++] !== 0x30) falha("assinatura inválida");
  const total = tam();
  if (i + total !== b.length) falha("assinatura inválida");
  const inteiro = () => {
    if (b[i++] !== 0x02) falha("assinatura inválida");
    const n = tam();
    if (n < 1 || n > 33 || i + n > b.length) falha("assinatura inválida");
    let v = b.slice(i, i + n); i += n;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) falha("assinatura inválida");
    const s = new Uint8Array(32); s.set(v, 32 - v.length);
    return s;
  };
  const r = inteiro(), s = inteiro();
  if (i !== b.length) falha("assinatura inválida");
  const out = new Uint8Array(64); out.set(r, 0); out.set(s, 32);
  return out;
}

// ------------------------------------------------------------------ o que vem do navegador

const ehB64url = (s, max = 20000) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);
function bytes(s, nome, max) {
  if (!ehB64url(s, max)) falha(nome + " inválido");
  try { return deB64url(s); } catch { return falha(nome + " inválido"); }
}

async function sha(b) { return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
function iguaisBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/* O clientDataJSON lido e conferido: {json, bytes, desafio}. `desafio` (texto base64url) e conferido por quem chama,
   depois de tirado do servidor (o uso unico). */
function lerClientData(b64, tipo, origem) {
  const b = bytes(b64, "clientDataJSON", 8000);
  let c;
  try { c = JSON.parse(td.decode(b)); } catch { falha("clientDataJSON inválido"); }
  if (!c || typeof c !== "object") falha("clientDataJSON inválido");
  if (c.type !== tipo) falha("tipo errado");
  if (typeof c.challenge !== "string" || !ehB64url(c.challenge, 200)) falha("desafio ausente");
  if (c.origin !== origem) falha("origem errada");
  if (c.crossOrigin === true) falha("origem cruzada");
  return { json: c, bytes: b, desafio: c.challenge };
}

/* O desafio do clientDataJSON, sem conferir mais nada (para achar o desafio guardado e tira-lo do servidor). */
export function desafioDe(credencial) {
  try {
    const c = JSON.parse(td.decode(deB64url(credencial.response.clientDataJSON)));
    return typeof c.challenge === "string" && ehB64url(c.challenge, 200) ? c.challenge : "";
  } catch {
    return "";
  }
}

/* O cadastro (navigator.credentials.create): `cred` e o PublicKeyCredential em JSON (base64url). Devolve a chave a
   guardar: {id, alg, jwk, contador, sincronizada, transportes}. `desafio`: o que o servidor guardou (e ja tirou). */
export async function conferirCadastro(cred, { desafio, rpId, origem }) {
  if (!cred || typeof cred !== "object" || cred.type !== "public-key" || !cred.response) falha("credencial inválida");
  const cd = lerClientData(cred.response.clientDataJSON, "webauthn.create", origem);
  if (cd.desafio !== desafio) falha("desafio errado");
  const ao = cborInteiro(bytes(cred.response.attestationObject, "attestationObject", 40000));
  if (!(ao instanceof Map) || typeof ao.get("fmt") !== "string" || !(ao.get("authData") instanceof Uint8Array)) falha("attestationObject inválido");
  const ad = lerDadosDoAutenticador(ao.get("authData"));
  if (!iguaisBytes(ad.rpIdHash, await sha(te.encode(rpId)))) falha("rpId errado");
  if (!ad.up) falha("sem presença");
  if (!ad.uv) falha("sem verificação do usuário");
  if (!ad.credencial) falha("sem credencial");
  const id = b64url(ad.credencial.id);
  if (cred.id !== id || (cred.rawId !== undefined && cred.rawId !== id)) falha("identificador não confere");
  const { alg, jwk } = chaveDoCose(ad.credencial.chaveCose);
  await importar(alg, jwk); // chave que nao abre e recusada aqui
  const transportes = Array.isArray(cred.response.transports)
    ? cred.response.transports.filter((t) => typeof t === "string" && /^[a-z-]{2,20}$/.test(t)).slice(0, 6) : [];
  return { id, alg, jwk, contador: ad.contador, sincronizada: ad.be, transportes };
}

/* Uma assinatura (navigator.credentials.get) com a chave guardada `chave` ({id, alg, jwk, contador}). Devolve
   {contador, regrediu, sincronizada, userHandle}. */
export async function conferirAssinatura(cred, chave, { desafio, rpId, origem }) {
  if (!cred || typeof cred !== "object" || cred.type !== "public-key" || !cred.response) falha("credencial inválida");
  if (cred.id !== chave.id || (cred.rawId !== undefined && cred.rawId !== chave.id)) falha("outra credencial");
  const cd = lerClientData(cred.response.clientDataJSON, "webauthn.get", origem);
  if (cd.desafio !== desafio) falha("desafio errado");
  const adBytes = bytes(cred.response.authenticatorData, "authenticatorData", 4000);
  const ad = lerDadosDoAutenticador(adBytes);
  if (!iguaisBytes(ad.rpIdHash, await sha(te.encode(rpId)))) falha("rpId errado");
  if (!ad.up) falha("sem presença");
  if (!ad.uv) falha("sem verificação do usuário");
  if (!ALGORITMOS.includes(chave.alg)) falha("algoritmo não aceito");
  let assinatura = bytes(cred.response.signature, "assinatura", 2000);
  if (chave.alg === -7) assinatura = derParaBruta(assinatura);
  const dados = new Uint8Array(adBytes.length + 32);
  dados.set(adBytes, 0);
  dados.set(await sha(cd.bytes), adBytes.length);
  const pub = await importar(chave.alg, chave.jwk);
  const algo = chave.alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  if (!(await crypto.subtle.verify(algo, pub, assinatura, dados))) falha("assinatura errada");
  // O contador: quando um dos dois nao e zero, o novo tem de ser maior. Se nao for, pode ser uma copia da chave: a
  // entrada passa (chaves sincronizadas e alguns aparelhos nao contam direito), mas fica o aviso.
  const antes = Number(chave.contador) || 0;
  const regrediu = (antes !== 0 || ad.contador !== 0) && ad.contador <= antes;
  let userHandle = "";
  if (cred.response.userHandle) userHandle = b64url(bytes(cred.response.userHandle, "userHandle", 200));
  return { contador: Math.max(antes, ad.contador), regrediu, sincronizada: ad.be, userHandle };
}
