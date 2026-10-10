// O painel da Atos (atos.dev.br/admin): onde a equipe cuida do que e da Atos e nao de um produto so. Hoje, as
// notas fiscais (o emissor de NFS-e, worker/nfse/). A pagina e public/admin/ (assets/admin.js).
//
// Quem entra: a Conta Atos (a sessao do atos.dev.br, worker/contas.js), com o e-mail na equipe (ATOS_EQUIPE, var do
// Worker: [{"email","nome","papel"}]) e o login de ate 12 horas (RECENTE_S): o painel mexe com o certificado e com
// notas fiscais, entao uma sessao antiga (elas duram 30 dias) pede para entrar de novo.
//
// Papeis: "dono" e "financeiro" emitem, cancelam e configuram; "suporte" so le (GET).
//
//   GET  /api/admin/eu         quem esta no painel {email, nome, papel}; 401 {entrar} ou {reentrar}; 403 fora da equipe
//   *    /api/admin/nfse/...   o emissor (deps.emissor, worker/nfse/), com quem pediu
//
// Os POST so da propria pagina (a origem e conferida em worker/index.js).

import { json, normal } from "./comum.js";
import { sessaoDe } from "./contas.js";

export const RECENTE_S = 12 * 3600;
const PAPEIS = ["dono", "financeiro", "suporte"];

export function ehRotaDoAdmin(url) {
  return url.pathname.startsWith("/api/admin/");
}

/* A equipe do painel (ATOS_EQUIPE). Lista vazia: o painel nao abre para ninguem. */
export function equipe(env) {
  try {
    const l = JSON.parse(env.ATOS_EQUIPE || "[]");
    return Array.isArray(l)
      ? l.filter((x) => x && x.email && PAPEIS.includes(x.papel)).map((x) => ({ email: normal(x.email), nome: String(x.nome || ""), papel: x.papel }))
      : [];
  } catch {
    return [];
  }
}

/* Quem pede: {email, nome, papel}, ou a resposta de recusa (401/403). */
export async function quemNoPainel(request, env, agora = Date.now()) {
  const s = await sessaoDe(request, env);
  if (!s) return { recusa: json({ erro: "entre com a sua Conta Atos", entrar: true }, 401) };
  const membro = equipe(env).find((x) => x.email === normal(s.email));
  if (!membro) return { recusa: json({ erro: "esta Conta Atos não é da equipe do painel" }, 403) };
  if (!(agora / 1000 - Number(s.auth_time || 0) < RECENTE_S)) {
    return { recusa: json({ erro: "o painel pede um login de até 12 horas: entre de novo", reentrar: true }, 401) };
  }
  return { email: membro.email, nome: membro.nome || s.nome || "", papel: membro.papel };
}

export async function atenderAdmin(request, env, url, deps = {}) {
  const quem = await quemNoPainel(request, env, deps.agora ? deps.agora() : Date.now());
  if (quem.recusa) return quem.recusa;
  const p = url.pathname;
  if (p === "/api/admin/eu" && request.method === "GET") return json({ email: quem.email, nome: quem.nome, papel: quem.papel });
  if (p.startsWith("/api/admin/nfse/")) {
    if (quem.papel === "suporte" && request.method !== "GET") return json({ erro: "o suporte só consulta as notas" }, 403);
    if (!deps.emissor) return json({ erro: "o emissor de notas ainda não está ligado" }, 503);
    return deps.emissor(request, env, url, quem);
  }
  return json({ erro: "rota não existe" }, 404);
}
