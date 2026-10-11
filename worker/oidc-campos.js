// Os campos de um aplicativo e de um cliente (acesso) do "Entrar com Atos", conferidos e limpos. Usados pelo painel
// da equipe (worker/oidc-painel.js, Login Atos) e pela Minha conta (worker/integracoes.js, Integracoes): as mesmas
// regras para os dois.

import { emailValido, limparNome, normal } from "./comum.js";

// O icone: so imagem embutida (data:), porque a CSP de /entrar e /conta (img-src 'self' data:) nao carrega imagem de
// fora. Sem icone, as paginas mostram a inicial do nome.
const ICONE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const ICONE_MAX = 40000;
export const LIBERADOS_MAX = 500;

const ehLoopback = (h) => h === "127.0.0.1" || h === "[::1]";

/* Um endereco https para mostrar (site, privacidade, termos): sem usuario/senha. "" se nao vale. */
export function urlHttps(s) {
  s = String(s || "").trim();
  if (!s || s.length > 300) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
}

/* Um endereco de volta exato: https, ou http so em 127.0.0.1 / [::1]; sem fragmento nem usuario. Volta o texto como
   foi digitado (a comparacao no login e exata) ou "". */
export function voltaValida(s) {
  s = String(s || "").trim();
  if (!s || s.length > 500) return "";
  try {
    const u = new URL(s);
    if (u.username || u.password || u.hash || s.includes("#")) return "";
    if (u.protocol === "https:") return u.href === s || u.href === s + "/" ? u.href : "";
    if (u.protocol === "http:" && ehLoopback(u.hostname)) return u.href === s || u.href === s + "/" ? u.href : "";
    return "";
  } catch {
    return "";
  }
}

/* Uma origem para CORS (so o esquema, o host e a porta): https, ou http em 127.0.0.1 / [::1]. */
export function origemValida(s) {
  s = String(s || "").trim().replace(/\/$/, "");
  try {
    const u = new URL(s);
    if (u.origin !== s) return "";
    return u.protocol === "https:" || (u.protocol === "http:" && ehLoopback(u.hostname)) ? u.origin : "";
  } catch {
    return "";
  }
}

export const listaDe = (x, sep = /\s+/) => (Array.isArray(x) ? x : typeof x === "string" ? x.split(sep) : []).map((s) => String(s).trim()).filter(Boolean);

/* Os campos de um aplicativo, limpos, ou {erro}. */
export function camposDoApp(d) {
  const nome = limparNome(d.nome).slice(0, 60);
  if (nome.length < 2) return { erro: "diga o nome do aplicativo" };
  const descricao = limparNome(d.descricao).slice(0, 140);
  if (descricao.length < 3) return { erro: "diga em poucas palavras o que o aplicativo faz (aparece para quem entra)" };
  const site = urlHttps(d.site), privacidade = urlHttps(d.privacidade), termos = urlHttps(d.termos);
  if (!site) return { erro: "o site precisa ser um endereço https" };
  if (!privacidade) return { erro: "a política de privacidade precisa ser um endereço https (aparece para quem entra)" };
  if (!termos) return { erro: "os termos de uso precisam ser um endereço https (aparecem para quem entra)" };
  const icone = String(d.icone || "");
  if (icone && (icone.length > ICONE_MAX || !ICONE.test(icone))) return { erro: "o ícone precisa ser uma imagem PNG, JPEG ou WebP de até 30 KB (ou nenhum)" };
  return { nome, descricao, site, privacidade, termos, icone };
}

/* Os campos de um cliente, limpos, ou {erro}. */
export function camposDoCliente(d) {
  const voltasDadas = listaDe(d.voltas);
  if (voltasDadas.length > 10) return { erro: "no máximo 10 endereços de volta" };
  const voltas = [];
  for (const v of voltasDadas) {
    const ok = voltaValida(v);
    if (!ok) return { erro: "endereço de volta inválido: " + v.slice(0, 80) + " (https exato; http só em 127.0.0.1 ou [::1]; sem #)" };
    if (!voltas.includes(ok)) voltas.push(ok);
  }
  const loopback = d.loopback === true;
  if (!voltas.length && !loopback) return { erro: "diga pelo menos um endereço de volta (ou marque o programa instalado, que volta a 127.0.0.1)" };
  const origensDadas = listaDe(d.origens);
  if (origensDadas.length > 10) return { erro: "no máximo 10 origens" };
  const origens = [];
  for (const o of origensDadas) {
    const ok = origemValida(o);
    if (!ok) return { erro: "origem inválida: " + o.slice(0, 80) + " (só esquema, host e porta, como https://exemplo.com.br)" };
    if (!origens.includes(ok)) origens.push(ok);
  }
  return { voltas, loopback, origens };
}

/* O modo de acesso: "liberados" (so as pessoas da lista; o padrao) ou "todos" (qualquer Conta Atos). */
export const modoDeAcesso = (x) => (x === "todos" ? "todos" : "liberados");

/* Uma lista de e-mails para liberar: normalizados, sem repetir. {emails} ou {erro}. */
export function emailsLimpos(x, max = LIBERADOS_MAX) {
  const emails = [];
  for (const e of listaDe(x, /[\s,;]+/)) {
    const n = normal(e);
    if (!emailValido(n) || n.length > 200) return { erro: "e-mail inválido: " + String(e).slice(0, 80) };
    if (!emails.includes(n)) emails.push(n);
  }
  if (emails.length > max) return { erro: "no máximo " + max + " pessoas liberadas por aplicativo" };
  return { emails };
}
