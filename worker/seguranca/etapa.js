// A segunda etapa do login: depois da senha certa (ou do Google, ou do endereco Atos, ou da troca de senha), a conta
// que tem a verificacao em duas etapas (o aplicativo autenticador ou uma chave de acesso) NAO recebe a sessao ainda.
// A Atos guarda uma "etapa" (no objeto da conta: 5 minutos, ate 5 tentativas, atada a esta tentativa pelo cookie
// __Host-atos-etapa, HttpOnly) e a pagina pede "Confirme que e voce": o codigo do aplicativo, um codigo de recuperacao
// ou a chave de acesso. So entao a sessao abre (worker/seguranca.js, /api/segunda-etapa), com mfa e o amr certo.
//
// O amr (RFC 8176) que vai no id_token do Entrar com Atos: "pwd" (senha, tambem pelo endereco Atos), "fed" (o Google:
// a entrada foi confirmada por outro provedor), "otp" (o codigo do aplicativo ou de recuperacao), "hwk"/"swk" (a chave
// de acesso presa ao aparelho / sincronizada numa nuvem: a marca BE do autenticador), "user" (a pessoa confirmou no
// aparelho) e "mfa" (mais de um fator: a segunda etapa, ou a chave de acesso com PIN ou biometria).

import { b64urlTexto, deB64url, json } from "../comum.js";
import { seg, resumoDaSeguranca } from "./objeto.js";

export const COOKIE_ETAPA = "__Host-atos-etapa";
export const AMR = { senha: ["pwd"], alias: ["pwd"], cadastro: ["pwd"], redefinir: ["pwd"], google: ["fed"] };

export const amrDaChave = (sincronizada) => [sincronizada ? "swk" : "hwk", "user", "mfa"];
export const amrComSegunda = (base, metodo, sincronizada) => [...new Set([...(base || []), ...(metodo === "chave" ? amrDaChave(sincronizada) : ["otp", "mfa"])])];

/* O rpId e a origem do WebAuthn neste endereco: atos.dev.br; o Worker de teste; localhost (o wrangler dev). Em outro
   endereco (127.0.0.1: o WebAuthn nao aceita IP) as chaves de acesso nao funcionam: null. */
export function rpDe(url, env) {
  const h = url.hostname;
  if (h === "atos.dev.br") return { rpId: h, origem: "https://atos.dev.br" };
  if (h === "localhost") return { rpId: h, origem: url.origin };
  if (env && env.AMBIENTE === "teste" && /^atos-teste\.[a-z0-9-]+\.workers\.dev$/.test(h)) return { rpId: h, origem: "https://" + h };
  return null;
}

export function lerCookieEtapa(request) {
  for (const parte of (request.headers.get("cookie") || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === COOKIE_ETAPA) {
      const v = parte.slice(i + 1).trim();
      const m = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{20,100})$/.exec(v);
      if (!m) return null;
      let sub = "";
      try { sub = new TextDecoder("utf-8", { fatal: true }).decode(deB64url(m[1])); } catch { return null; }
      return sub ? { sub, token: m[2] } : null;
    }
  }
  return null;
}
export const cookieEtapaApagado = COOKIE_ETAPA + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

/* A conta tem a segunda etapa ligada? Lanca se o objeto nao responde (quem chama recusa: 503). */
export async function exigeSegunda(env, sub, agora) {
  const r = await resumoDaSeguranca(env, sub, agora);
  return Boolean(r && r.ativa);
}

/* Comeca a etapa da conta {sub, email, alias?}: {cookie, metodos}. `como`: senha, alias, google, cadastro, redefinir. */
export async function iniciarEtapa(env, conta, como, agora) {
  const dados = { sub: conta.sub, email: conta.email, alias: conta.alias || "", como, amr: AMR[como] || [] };
  const r = await seg(env, conta.sub)("etapa-criar", { dados, agora });
  const cookie = COOKIE_ETAPA + "=" + b64urlTexto(conta.sub) + "." + r.token + "; Path=/; Max-Age=" + 300 + "; HttpOnly; Secure; SameSite=Lax";
  const s = await resumoDaSeguranca(env, conta.sub, agora);
  return { cookie, metodos: { otp: Boolean(s.totp), recuperacao: Boolean(s.recuperacao && s.recuperacao.restantes), chave: s.chaves.length > 0 } };
}

/* A resposta de quem acertou a senha (ou o codigo) e ainda precisa da segunda etapa. */
export function respostaDaEtapa(e, extra = {}) {
  return json({ etapa: e.metodos, ...extra }, 200, { "set-cookie": e.cookie });
}
