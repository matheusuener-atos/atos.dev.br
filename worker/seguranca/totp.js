// A verificacao em duas etapas por aplicativo (TOTP, RFC 6238 sobre o HOTP da RFC 4226), os codigos de recuperacao e a
// cifra do segredo. Sem biblioteca: so a WebCrypto do Worker.
//
// O segredo TOTP: 20 bytes aleatorios (160 bits, o tamanho do HMAC-SHA1), mostrados em base32 (RFC 4648, sem "=") e no
// QR code (otpauth://totp/...). Guardado CIFRADO: AES-256-GCM com a chave CONTA_CHAVE_MESTRA (segredo do Worker, 32 bytes
// em base64) e o sub da conta como dado adicional (AAD), para a cifra de uma conta nao servir em outra.
//
// No Worker de teste (AMBIENTE "teste"), sem CONTA_CHAVE_MESTRA propria, a chave sai do NFSE_CHAVE_MESTRA de teste por
// HKDF-SHA256 com um rotulo so deste uso: o teste funciona sem um segredo novo e a producao nunca deriva (sem o segredo,
// a producao nao liga a etapa). Criado o CONTA_CHAVE_MESTRA no teste, ele passa a valer (e o que foi ligado antes deixa
// de abrir: e o teste).

import { b64url, deB64url, hex } from "../comum.js";

const te = new TextEncoder();
export const PASSO_S = 30;
export const DIGITOS = 6;
export const JANELA = 1; // um passo antes e um depois (o relogio do celular pode estar 30 s fora)

// ------------------------------------------------------------------ base32 (RFC 4648)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes) {
  let bits = 0, valor = 0, s = "";
  for (const b of new Uint8Array(bytes)) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) { s += B32[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) s += B32[(valor << (5 - bits)) & 31];
  return s;
}

export function deBase32(texto) {
  const t = String(texto || "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, valor = 0;
  const saida = [];
  for (const c of t) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("base32 inválido");
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) { saida.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(saida);
}

// ------------------------------------------------------------------ HOTP e TOTP

/* HOTP (RFC 4226): o codigo de `digitos` digitos do contador `n` com a chave `segredo` (bytes). */
export async function hotp(segredo, n, digitos = DIGITOS, hash = "SHA-1") {
  const chave = await crypto.subtle.importKey("raw", segredo, { name: "HMAC", hash }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let x = BigInt(n);
  for (let i = 7; i >= 0; i--) { msg[i] = Number(x & 255n); x >>= 8n; }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", chave, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digitos).padStart(digitos, "0");
}

export const passoDe = (ms) => Math.floor(ms / 1000 / PASSO_S);

/* O codigo TOTP de agora (para os testes e para o QR de demonstracao). */
export const totp = (segredo, ms, digitos = DIGITOS, hash = "SHA-1") => hotp(segredo, passoDe(ms), digitos, hash);

/* Confere `codigo` (6 digitos) no passo de `ms` e nos vizinhos (JANELA). Devolve o passo que bateu, ou -1. O codigo
   de um passo ja usado (<= `ultimo`) nao vale: o mesmo codigo nao entra duas vezes. Todos os passos sao calculados
   (o tempo nao entrega qual bateu). */
export async function conferirTotp(segredo, codigo, ms, ultimo = -1) {
  const c = String(codigo || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return -1;
  const agora = passoDe(ms);
  let achado = -1;
  for (let d = -JANELA; d <= JANELA; d++) {
    const p = agora + d;
    const esperado = await hotp(segredo, p);
    let dif = 0;
    for (let i = 0; i < DIGITOS; i++) dif |= esperado.charCodeAt(i) ^ c.charCodeAt(i);
    if (dif === 0 && p > ultimo && achado < 0) achado = p;
  }
  return achado;
}

export function novoSegredoTotp() {
  return crypto.getRandomValues(new Uint8Array(20));
}

/* O endereco que o aplicativo autenticador le no QR code. */
export function uriTotp(segredoB32, email) {
  return "otpauth://totp/" + encodeURIComponent("Atos:" + email) + "?secret=" + segredoB32 + "&issuer=Atos&algorithm=SHA1&digits=" + DIGITOS + "&period=" + PASSO_S;
}

// ------------------------------------------------------------------ os codigos de recuperacao

// 32 simbolos sem os que se confundem (i, l, o, u): 12 por codigo = 60 bits.
const REC = "0123456789abcdefghjkmnpqrstvwxyz";
export const QUANTOS_CODIGOS = 10;

export function novosCodigos(n = QUANTOS_CODIGOS) {
  const l = [];
  while (l.length < n) {
    const b = crypto.getRandomValues(new Uint8Array(12));
    const s = [...b].map((x) => REC[x & 31]).join("");
    const c = s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
    if (!l.includes(c)) l.push(c);
  }
  return l;
}

/* O codigo como a pessoa digitou -> a forma guardada (minusculas, sem espacos nem tracos; i/l viram 1, o vira 0). */
export function normalCodigo(texto) {
  return String(texto || "").toLowerCase().replace(/[\s-]/g, "").replace(/[il]/g, "1").replace(/o/g, "0");
}

/* So o resumo fica guardado: SHA-256 do codigo com o sub (o mesmo codigo em outra conta tem outro resumo). */
export async function resumoCodigo(sub, texto) {
  return hex(await crypto.subtle.digest("SHA-256", te.encode("atos-rec:" + sub + ":" + normalCodigo(texto))));
}

// ------------------------------------------------------------------ a cifra

const cacheChave = { texto: "", chave: null, kid: "" };

function bytesDoB64(texto) {
  try {
    const b = atob(String(texto).trim());
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/* A chave AES-GCM da conta ({chave, kid}) ou null quando a etapa ainda nao pode ser ligada. */
export async function chaveMestra(env) {
  let fonte = "", bruto = null;
  if (env && env.CONTA_CHAVE_MESTRA) {
    fonte = "conta:" + env.CONTA_CHAVE_MESTRA;
    bruto = bytesDoB64(env.CONTA_CHAVE_MESTRA);
    if (!bruto || bruto.length !== 32) {
      console.warn("seguranca: CONTA_CHAVE_MESTRA precisa ser 32 bytes em base64");
      return null;
    }
  } else if (env && env.AMBIENTE === "teste" && env.NFSE_CHAVE_MESTRA) {
    fonte = "teste:" + env.NFSE_CHAVE_MESTRA;
  } else {
    return null;
  }
  if (cacheChave.texto === fonte) return cacheChave;
  if (!bruto) {
    const base = await crypto.subtle.importKey("raw", te.encode(String(env.NFSE_CHAVE_MESTRA)), "HKDF", false, ["deriveBits"]);
    bruto = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: te.encode("atos-conta"), info: te.encode("conta-chave-mestra-teste") }, base, 256));
  }
  const chave = await crypto.subtle.importKey("raw", bruto, "AES-GCM", false, ["encrypt", "decrypt"]);
  const kid = hex(await crypto.subtle.digest("SHA-256", bruto)).slice(0, 8);
  Object.assign(cacheChave, { texto: fonte, chave, kid });
  return cacheChave;
}

export async function cifrar(env, sub, bytes) {
  const k = await chaveMestra(env);
  if (!k) throw new Error("sem a chave da conta");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("atos-totp:" + sub) }, k.chave, bytes);
  return { iv: b64url(iv), dado: b64url(c), kid: k.kid };
}

/* Os bytes, ou null (outra chave, cifra adulterada, outra conta). */
export async function decifrar(env, sub, cifra) {
  const k = await chaveMestra(env);
  if (!k || !cifra || cifra.kid !== k.kid) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64url(cifra.iv), additionalData: te.encode("atos-totp:" + sub) }, k.chave, deB64url(cifra.dado)));
  } catch {
    return null;
  }
}
