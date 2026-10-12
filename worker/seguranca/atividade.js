// O registro de acessos e as sessoes abertas de cada Conta Atos (Minha conta > Seguranca).
//
// No KV CONTAS, com o prefixo do ambiente ("atos:" na producao, "atos-teste:" no Worker de teste; o KV e o mesmo):
//   <p>seg:atividade:<sub>  os ultimos ATIVIDADE_N acontecimentos (entradas e mudancas na seguranca), ATIVIDADE_DIAS dias
//   <p>seg:sessoes:<sub>    as sessoes abertas por este Worker: {id, h (o resumo do cookie, a chave da sessao), criada,
//                           como, onde, navegador}; a lista confere se a sessao ainda existe
//   <p>seg:chave:<id>       a chave de acesso -> {sub, email} (o "Entrar com chave de acesso" acha a conta por ela)
//
// O que se anota de cada acesso: quando, como (senha, endereco Atos, Google, chave de acesso; e a segunda etapa), o
// lugar aproximado que a Cloudflare deduz do endereco de internet (cidade, estado e pais: request.cf) e o navegador e o
// sistema resumidos do user-agent ("Chrome no Windows"). O endereco de internet (IP) NAO e guardado, nem truncado.

import { kv, sha256 } from "../comum.js";

export const ATIVIDADE_N = 30;
export const ATIVIDADE_DIAS = 90;
const ATIVIDADE_S = ATIVIDADE_DIAS * 24 * 3600;
const SESSOES_N = 30;
const SESSOES_S = 30 * 24 * 3600;

export const prefixo = (env) => (env && env.AMBIENTE === "teste" ? "atos-teste:" : "atos:");
export const KS = (env) => {
  const p = prefixo(env) + "seg:";
  return { atividade: (sub) => p + "atividade:" + sub, sessoes: (sub) => p + "sessoes:" + sub, chave: (id) => p + "chave:" + id };
};

/* "Sao Paulo, SP, BR": o lugar aproximado pela Cloudflare; "" sem ele (os testes, o wrangler dev). */
export function ondeDe(request) {
  const cf = (request && request.cf) || {};
  const limpa = (x) => String(x || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
  return [limpa(cf.city), limpa(cf.regionCode || cf.region), limpa(cf.country)].filter(Boolean).join(", ");
}

/* "Chrome no Windows", "Safari no iPhone"...: so o nome do navegador e do sistema, sem versao. */
export function navegadorDe(ua) {
  const u = String(ua || "").slice(0, 500);
  if (!u) return "";
  let nav = "";
  if (/Edg(e|A|iOS)?\//.test(u)) nav = "Edge";
  else if (/OPR\/|Opera/.test(u)) nav = "Opera";
  else if (/SamsungBrowser\//.test(u)) nav = "Samsung Internet";
  else if (/Firefox\/|FxiOS\//.test(u)) nav = "Firefox";
  else if (/Chrome\/|CriOS\//.test(u)) nav = /HeadlessChrome/.test(u) ? "Chrome (automatizado)" : "Chrome";
  else if (/Safari\//.test(u)) nav = "Safari";
  let so = "";
  if (/iPhone/.test(u)) so = "iPhone";
  else if (/iPad/.test(u)) so = "iPad";
  else if (/Android/.test(u)) so = "Android";
  else if (/Windows/.test(u)) so = "Windows";
  else if (/CrOS/.test(u)) so = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(u)) so = "Mac";
  else if (/Linux/.test(u)) so = "Linux";
  if (nav && so) return nav + " no " + so;
  return nav || so || "outro navegador";
}

/* O lugar e o navegador de um pedido. */
export function deOnde(request) {
  return { onde: ondeDe(request), navegador: navegadorDe(request && request.headers ? request.headers.get("user-agent") : "") };
}

/* Anota um acontecimento: {tipo: "entrada" | "mudanca", como?, segunda?, evento?, detalhe?} + onde e navegador. */
export async function anotar(env, sub, item, agora, request) {
  try {
    const k = KS(env).atividade(sub);
    const lista = (await kv(env, k)) || [];
    const limite = agora - ATIVIDADE_S * 1000;
    const nova = [{ quando: new Date(agora).toISOString(), ...item, ...deOnde(request) }, ...(Array.isArray(lista) ? lista : [])]
      .filter((x) => x && Date.parse(x.quando) > limite).slice(0, ATIVIDADE_N);
    await env.CONTAS.put(k, JSON.stringify(nova), { expirationTtl: ATIVIDADE_S });
  } catch {
    // o registro nao impede a entrada
  }
}

export async function atividadeDe(env, sub, agora) {
  const lista = (await kv(env, KS(env).atividade(sub))) || [];
  const limite = agora - ATIVIDADE_S * 1000;
  return (Array.isArray(lista) ? lista : []).filter((x) => x && Date.parse(x.quando) > limite).slice(0, ATIVIDADE_N);
}

/* O identificador que a tela ve de uma sessao (nunca a chave dela). */
export const idDaSessao = async (h) => (await sha256("sid:" + h)).slice(0, 20);

export async function indexarSessao(env, sub, h, info, agora, request) {
  try {
    const k = KS(env).sessoes(sub);
    const lista = (await kv(env, k)) || [];
    const limite = agora - SESSOES_S * 1000;
    const nova = [{ id: await idDaSessao(h), h, criada: new Date(agora).toISOString(), como: info.como || "", segunda: info.segunda || "", ...deOnde(request) },
      ...(Array.isArray(lista) ? lista : []).filter((x) => x && x.h !== h && Date.parse(x.criada) > limite)].slice(0, SESSOES_N);
    await env.CONTAS.put(k, JSON.stringify(nova), { expirationTtl: SESSOES_S });
  } catch {
    // a lista nao impede a entrada
  }
}

/* As sessoes que ainda existem (as que sairam, venceram ou cairam saem da lista). */
export async function sessoesDe(env, sub, agora) {
  const k = KS(env).sessoes(sub);
  const lista = (await kv(env, k)) || [];
  const vivas = [];
  for (const x of Array.isArray(lista) ? lista : []) {
    if (!x || !x.h) continue;
    const s = await kv(env, "atos:sessao:" + x.h);
    if (s && s.sub === sub) vivas.push(x);
  }
  if (vivas.length !== (Array.isArray(lista) ? lista.length : 0)) await env.CONTAS.put(k, JSON.stringify(vivas), { expirationTtl: SESSOES_S });
  return vivas;
}

export async function guardarSessoes(env, sub, lista) {
  await env.CONTAS.put(KS(env).sessoes(sub), JSON.stringify(lista), { expirationTtl: SESSOES_S });
}
