// O painel da Atos (atos.dev.br/admin): onde a equipe cuida do que e da Atos e dos produtos dela. As notas
// fiscais (o emissor de NFS-e, worker/nfse/), a equipe do painel inteiro e o painel do PAVLVS, que mora no
// Worker do PAVLVS e chega aqui por service binding. A pagina e public/admin/ (assets/admin.js).
//
// Quem entra: a Conta Atos (a sessao do atos.dev.br, worker/contas.js), com o e-mail na equipe e o login de ate
// 12 horas (RECENTE_S): o painel mexe com o certificado, notas fiscais e contas de clientes, entao uma sessao
// antiga (elas duram 30 dias) pede para entrar de novo.
//
// A equipe: no KV, "atos:admin:equipe" ("atos-teste:admin:equipe" no Worker de teste) ([{email, nome, papel,
// convidado?}]). Enquanto essa chave nao existe, vale
// a semente ATOS_EQUIPE (segredo/var do Worker, o mesmo formato): e por ela que o dono entra na primeira vez, e e
// dela que a primeira mudanca parte. Papeis: "dono", "financeiro" e "suporte".
//
// Rotas (o contrato inteiro em C:\coryphaeus\worker\admin-api.md, "O painel na Atos"):
//   GET  /api/admin/eu                       {email, nome, papel, github: login | null}; 401 {entrar} ou
//                                            {reentrar}; 403 fora da equipe
//   *    /api/admin/nfse/...                 o emissor da Atos (deps.emissor); suporte so GET
//   *    /api/admin/pavlvs/...               encaminhado ao Worker do PAVLVS (binding PAVLVS), assinado
//   GET  /api/admin/github/entrar?volta=     302 para o GitHub (OAuth App do painel do PAVLVS)
//   GET  /api/admin/github/retorno           volta do GitHub: confere a escrita no repositorio e guarda o token
//   POST /api/admin/github/sair              esquece o GitHub desta sessao
//   GET  /api/admin/equipe                   {membros, matriz, liberacao}
//   POST /api/admin/equipe/convite/:email/reenviar   (so o dono) o e-mail de aviso de novo
//   GET|POST /api/admin/alteracoes, DELETE /api/admin/alteracoes/:id, POST /api/admin/publicar,
//   POST /api/admin/retroagir                a fila da equipe (equipe.papel, equipe.membro), como a do PAVLVS
//
// Os POST so da propria pagina (a origem e conferida em worker/index.js).

import { aleatorio, b64url, deB64url, b64urlTexto, emailValido, json, kv, limparNome, normal, sha256 } from "./comum.js";
import { COOKIE, sessaoDe } from "./contas.js";
import { enviarEmail as enviarEmailPadrao } from "./email.js";

export const RECENTE_S = 12 * 3600;
export const PAPEIS = ["dono", "financeiro", "suporte"];
const NOME_DO_PAPEL = { dono: "Dono", financeiro: "Financeiro", suporte: "Suporte" };

// O painel do PAVLVS: o prefixo aqui e la (o Worker do PAVLVS atende o mesmo caminho) e a janela da assinatura.
export const PREFIXO_PAVLVS = "/api/admin/pavlvs/";
export const JANELA_PAVLVS_S = 60;

// O GitHub (o OAuth App "PAVLVS Admin"): so para comitar e pushar ou retroagir no PAVLVS. A conta precisa de
// escrita no repositorio. O token fica no KV cifrado com uma chave tirada do cookie da sessao (que so o navegador
// tem): o KV sozinho nao entrega o token. Vale 24 horas, e so nesta sessao (neste navegador).
const REPO = "matheusuener-atos/coryphaeus";
const GITHUB_S = 24 * 3600;

// A fila da equipe: a mesma regra do PAVLVS (mudar a equipe so na publicacao, com a frase).
const CONFIRMACAO = "comitar e pushar";
const RETRATO_S = 30 * 24 * 3600;
const PODE = { "equipe.papel": ["dono"], "equipe.membro": ["dono"] };

// As chaves do painel no KV CONTAS (o mesmo namespace do PAVLVS e do Worker de teste): "atos:admin:*" na producao
// e "atos-teste:admin:*" no Worker de teste (AMBIENTE "teste"), para a equipe de um nao valer no outro.
export function K(env) {
  const p = env && env.AMBIENTE === "teste" ? "atos-teste:admin:" : "atos:admin:";
  return {
    equipe: p + "equipe",
    acesso: (email) => p + "acesso:" + email,
    estado: (s) => p + "gh:" + s,
    github: (h) => p + "github:" + h,
    pendentes: (email) => p + "pendentes:" + email,
    publicacoes: p + "publicacoes",
    retrato: (id) => p + "retrato:" + id,
  };
}

// O que cada papel pode no que e da Atos (o do PAVLVS vem de GET /api/admin/pavlvs/papeis).
export const MATRIZ = [
  ["Ver as notas fiscais e baixar PDF e XML", PAPEIS],
  ["Emitir, cancelar e substituir notas fiscais; certificado e parâmetros", ["dono", "financeiro"]],
  ["Incluir, editar e tirar pessoas da equipe; mudar papéis", ["dono"]],
  ["Retroagir uma alteração da equipe", ["dono"]],
];

const te = new TextEncoder();
const iso = (ms) => new Date(ms).toISOString();
const novoId = () => aleatorio(6).toLowerCase().replace(/[^a-z0-9]/g, "x");

export function ehRotaDoAdmin(url) {
  return url.pathname.startsWith("/api/admin/");
}

// ------------------------------------------------------------------ a equipe

function membroValido(x) {
  return x && typeof x === "object" && emailValido(x.email) && PAPEIS.includes(x.papel);
}
function membroLimpo(x) {
  const m = { email: normal(x.email), nome: limparNome(x.nome), papel: x.papel };
  if (x.convidado && typeof x.convidado === "object") {
    m.convidado = { criado: String(x.convidado.criado || ""), por: String(x.convidado.por || ""), por_nome: limparNome(x.convidado.por_nome) };
  }
  return m;
}

/* A semente (ATOS_EQUIPE): vale enquanto a equipe nao esta no KV. Lista quebrada: ninguem. */
export function equipeDaSemente(env) {
  try {
    const l = JSON.parse(env.ATOS_EQUIPE || "[]");
    return Array.isArray(l)
      ? l.filter((x) => x && x.email && PAPEIS.includes(x.papel)).map((x) => ({ email: normal(x.email), nome: String(x.nome || ""), papel: x.papel }))
      : [];
  } catch {
    return [];
  }
}

/* A equipe de agora: a do KV ou, sem ela, a semente. Se o KV nao responde, ninguem (nunca a semente no lugar). */
export async function listaDaEquipe(env) {
  let bruto;
  try {
    bruto = await env.CONTAS.get(K(env).equipe);
  } catch {
    return [];
  }
  if (bruto === null || bruto === undefined) return equipeDaSemente(env);
  try {
    const l = JSON.parse(bruto);
    return Array.isArray(l) ? l.filter(membroValido).map(membroLimpo) : [];
  } catch {
    return [];
  }
}

async function guardarEquipe(env, lista) {
  await env.CONTAS.put(K(env).equipe, JSON.stringify(lista.map(membroLimpo)));
}

/* Quem pede: {email, nome, papel}, ou a resposta de recusa (401/403). */
export async function quemNoPainel(request, env, agora = Date.now()) {
  const s = await sessaoDe(request, env);
  if (!s) return { recusa: json({ erro: "entre com a sua Conta Atos", entrar: true }, 401) };
  const lista = await listaDaEquipe(env);
  // A lista que nao abre para ninguem e erro de configuracao: fica so no log do Worker (quem pede ve a mesma recusa).
  if (!lista.length) console.warn('painel: a equipe esta vazia (atos:admin:equipe) ou a semente ATOS_EQUIPE fora do formato [{"email","nome","papel"}]');
  const membro = lista.find((x) => x.email === normal(s.email));
  if (!membro) return { recusa: json({ erro: "esta Conta Atos não é da equipe do painel" }, 403) };
  if (!(agora / 1000 - Number(s.auth_time || 0) < RECENTE_S)) {
    return { recusa: json({ erro: "o painel pede um login de até 12 horas: entre de novo", reentrar: true }, 401) };
  }
  return { email: membro.email, nome: membro.nome || s.nome || "", papel: membro.papel };
}

// ------------------------------------------------------------------ o GitHub

function segredoDoCookie(request) {
  for (const parte of (request.headers.get("cookie") || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === COOKIE) {
      const v = parte.slice(i + 1).trim();
      return v && v.length <= 100 ? v : "";
    }
  }
  return "";
}

async function chaveDoGitHub(segredo) {
  const bruta = await crypto.subtle.digest("SHA-256", te.encode("atos-painel-github:" + segredo));
  return crypto.subtle.importKey("raw", bruta, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function guardarGitHub(env, segredo, email, login, token, agora) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await chaveDoGitHub(segredo), te.encode(token));
  await env.CONTAS.put(K(env).github(await sha256("github:" + segredo)), JSON.stringify({ email, login, iv: b64url(iv), token: b64url(cifrado), quando: iso(agora) }),
    { expirationTtl: GITHUB_S });
}

/* O GitHub ligado nesta sessao do painel: {login, token} ou null. */
export async function githubDaSessao(request, env, email) {
  const segredo = segredoDoCookie(request);
  if (!segredo) return null;
  const g = await kv(env, K(env).github(await sha256("github:" + segredo)));
  if (!g || g.email !== email || !g.login || !g.token) return null;
  try {
    const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64url(g.iv) }, await chaveDoGitHub(segredo), deB64url(g.token));
    return { login: String(g.login), token: new TextDecoder().decode(claro) };
  } catch {
    return null;
  }
}

async function chamarGitHub(metodo, url, token, corpo) {
  const headers = { "User-Agent": "Atos-painel", Accept: url.includes("/login/oauth/") ? "application/json" : "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (corpo) headers["Content-Type"] = "application/json";
  const r = await fetch(url, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
  let dados = null;
  try {
    dados = await r.json();
  } catch {
    dados = null;
  }
  return { ok: r.ok, status: r.status, dados };
}

const ir = (destino) => new Response(null, { status: 302, headers: { location: destino, "cache-control": "no-store" } });
const voltarComErro = (frase) => ir("/admin/?erro=" + encodeURIComponent(frase));
const retornoDoGitHub = (env) => String(env.APP_URL || "https://atos.dev.br").replace(/\/$/, "") + "/api/admin/github/retorno";

async function githubEntrar(c, url) {
  const { env } = c;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ erro: "falta o OAuth App do GitHub (GITHUB_CLIENT_ID e GITHUB_CLIENT_SECRET)" }, 503);
  const state = aleatorio(16);
  // A tela para onde voltar (#alteracoes etc.): so um nome simples, nunca um endereco.
  const pedida = String(url.searchParams.get("volta") || "");
  const volta = /^[a-z0-9-]{1,40}$/.test(pedida) ? pedida : "";
  await env.CONTAS.put(K(env).estado(state), JSON.stringify({ email: c.quem.email, volta }), { expirationTtl: 600 });
  const q = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: retornoDoGitHub(env), scope: "public_repo read:user", state, allow_signup: "false" });
  return ir("https://github.com/login/oauth/authorize?" + q.toString());
}

async function githubRetorno(c, request, url) {
  const { env } = c;
  const state = String(url.searchParams.get("state") || "");
  const code = String(url.searchParams.get("code") || "");
  const guardado = /^[A-Za-z0-9_-]{10,40}$/.test(state) ? await kv(env, K(env).estado(state)) : null;
  if (!guardado || guardado.email !== c.quem.email || !code) return voltarComErro("o login do GitHub venceu; tente de novo");
  await env.CONTAS.delete(K(env).estado(state));
  const segredo = segredoDoCookie(request);
  if (!segredo) return voltarComErro("a sessão da Conta Atos venceu; entre de novo");
  const gh = c.deps.github || chamarGitHub;
  const t = await gh("POST", "https://github.com/login/oauth/access_token", null, {
    client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: retornoDoGitHub(env),
  });
  const token = t.ok && t.dados && t.dados.access_token;
  if (!token) return voltarComErro("o GitHub não confirmou o login");
  const u = await gh("GET", "https://api.github.com/user", token);
  const login = u.ok && u.dados && u.dados.login;
  if (!login) return voltarComErro("o GitHub não disse quem é a conta");
  const perm = await gh("GET", "https://api.github.com/repos/" + REPO + "/collaborators/" + encodeURIComponent(login) + "/permission", token);
  const nivel = perm.ok && perm.dados ? String(perm.dados.permission || "") : "";
  if (!["admin", "write", "maintain"].includes(nivel)) return voltarComErro("a conta " + login + " não tem escrita em " + REPO);
  await guardarGitHub(env, segredo, c.quem.email, String(login), String(token), c.agora);
  return ir("/admin/" + (guardado.volta ? "?github=1#" + guardado.volta : ""));
}

async function githubSair(c, request) {
  const segredo = segredoDoCookie(request);
  if (segredo) await c.env.CONTAS.delete(K(c.env).github(await sha256("github:" + segredo)));
  return json({ ok: true });
}

// ----------------------------------------------------- o painel do PAVLVS

const hexDe = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmacHex(segredo, texto) {
  const k = await crypto.subtle.importKey("raw", te.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hexDe(await crypto.subtle.sign("HMAC", k, te.encode(texto)));
}

/* A assinatura do pedido encaminhado: "t=<segundos>,v1=<HMAC-SHA256 hex>" de
   "<t>.<METODO>.<caminho com a query>.<SHA-256 hex do corpo>.<Atos-Painel-Quem>". */
export async function assinarPedidoDoPainel(segredo, metodo, caminho, corpo, quem64, ts) {
  const resumo = hexDe(await crypto.subtle.digest("SHA-256", corpo || new Uint8Array(0)));
  return "t=" + ts + ",v1=" + (await hmacHex(segredo, [ts, metodo, caminho, resumo, quem64].join(".")));
}

/* /api/admin/pavlvs/* -> o Worker do PAVLVS, o mesmo caminho e a mesma query, com quem pede assinado. A resposta
   volta como veio. Quem pode o que no PAVLVS e decidido la (a tabela de papeis dele). */
async function encaminharAoPavlvs(request, env, url, c) {
  const servico = c.deps.pavlvs || env.PAVLVS;
  const segredo = String(env.PAINEL_SEGREDO_PAVLVS || "");
  if (!servico || !segredo) {
    if (servico) console.warn("painel: falta o segredo PAINEL_SEGREDO_PAVLVS");
    return json({ erro: "o PAVLVS não está ligado a este painel" }, 503);
  }
  const m = request.method;
  const corpo = m === "GET" || m === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
  const gh = await githubDaSessao(request, env, c.quem.email);
  const quem64 = b64urlTexto(JSON.stringify({ email: c.quem.email, nome: c.quem.nome, papel: c.quem.papel, github: gh }));
  const caminho = url.pathname + url.search;
  const headers = new Headers({
    "Atos-Painel-Quem": quem64,
    "Atos-Painel-Assinatura": await assinarPedidoDoPainel(segredo, m, caminho, corpo, quem64, Math.floor(c.agora / 1000)),
  });
  for (const h of ["content-type", "accept"]) if (request.headers.get(h)) headers.set(h, request.headers.get(h));
  try {
    const r = await servico.fetch(new Request("https://paulus.ia.br" + caminho, { method: m, headers, body: corpo }));
    return new Response(r.body, r);
  } catch {
    return json({ erro: "o PAVLVS não respondeu" }, 502);
  }
}

// --------------------------------------------------------- a tela da equipe

async function acessoDe(env, email) {
  return kv(env, K(env).acesso(email));
}

/* O ultimo acesso (a cada abertura do painel; no maximo uma escrita por hora por pessoa). */
async function anotarAcesso(env, email, agora) {
  const a = await acessoDe(env, email);
  if (a && Date.parse(a.ultimo) > agora - 3600 * 1000) return;
  try {
    await env.CONTAS.put(K(env).acesso(email), JSON.stringify({ ultimo: iso(agora) }));
  } catch {
    // Anotar e cortesia: o painel abre sem isso.
  }
}

async function telaDaEquipe(c) {
  const membros = [];
  for (const m of await listaDaEquipe(c.env)) {
    const a = await acessoDe(c.env, m.email);
    const x = { email: m.email, nome: m.nome, papel: m.papel, ultimo: a ? a.ultimo : null };
    // Incluida e ainda sem entrar: a tela mostra reenviar o aviso e cancelar.
    if (m.convidado && !a) x.convite = { criado: m.convidado.criado, vence: null, por: m.convidado.por, vencido: false };
    membros.push(x);
  }
  return {
    membros, matriz: MATRIZ.map(([acao, papeis]) => ({ acao, dono: papeis.includes("dono"), financeiro: papeis.includes("financeiro"), suporte: papeis.includes("suporte") })),
    // Sem passo a mao: a pessoa entra com a Conta Atos do e-mail incluido.
    liberacao: { ligado: true, falta: "" },
  };
}

function avisoDeEntrada(c, m) {
  const mandar = c.deps.enviarEmail || enviarEmailPadrao;
  const quem = (m.convidado && (m.convidado.por_nome || m.convidado.por)) || "A equipe da Atos";
  const primeiro = String(m.nome || "").trim().split(/\s+/)[0];
  return mandar(c.env, {
    para: m.email, assunto: "Você entrou na equipe do painel da Atos", titulo: "Você está na equipe do painel",
    pre: "Entre com a sua Conta Atos deste e-mail",
    texto: (primeiro ? "Olá, " + primeiro + ".\n\n" : "") +
      quem + " incluiu você na equipe do painel da Atos, com o papel " + (NOME_DO_PAPEL[m.papel] || m.papel) + ".\n\n" +
      "Para entrar, abra atos.dev.br/admin e entre com a Conta Atos deste e-mail (" + m.email + "). Se ainda não tem, crie a conta com este mesmo e-mail em atos.dev.br/entrar. " +
      "O painel pede um login de até 12 horas. A conta do GitHub (com escrita no repositório do PAVLVS) só é pedida para comitar e pushar ou retroagir no PAVLVS." +
      "\n\nSe não esperava por isso, ignore este e-mail e avise contato@atos.dev.br.",
  });
}

async function reenviarAviso(c, email) {
  if (c.quem.papel !== "dono") return json({ erro: "o papel " + c.quem.papel + " não convida: convites são do dono" }, 403);
  const m = (await listaDaEquipe(c.env)).find((x) => x.email === email);
  if (!m || !m.convidado || (await acessoDe(c.env, email))) return json({ erro: "não há convite pendente para " + (email || "esse e-mail") }, 404);
  const e = await avisoDeEntrada(c, m);
  if (!e.ok) return json({ erro: e.erro }, e.status || 502);
  return json(await telaDaEquipe(c));
}

// ---------------------------------------------------------------- a fila

async function lerLista(env, chave) {
  const l = await kv(env, chave);
  return Array.isArray(l) ? l : [];
}

function publicacaoParaTela(p) {
  return { id: p.id || "", quando: p.quando, commit: p.commit, resumo: p.resumo, n: p.n, por: p.por, revertida: p.revertida || null, retroagivel: Boolean(p.retrato) };
}

async function alteracoes(c) {
  const pubs = await lerLista(c.env, K(c.env).publicacoes);
  return { pendentes: await lerLista(c.env, K(c.env).pendentes(c.quem.email)), publicacoes: pubs.map(publicacaoParaTela) };
}

/* O que um equipe.membro pede faz sentido agora? "" se sim; senao, o motivo. */
async function conferirMembro(c, d) {
  const acao = String(d.acao || "");
  if (!["criar", "editar", "excluir", "cancelar_convite"].includes(acao)) return "o que fazer com essa pessoa? (criar, editar, excluir ou cancelar_convite)";
  const email = normal(d.email);
  if (!emailValido(email) || email.length > 120) return "e-mail inválido";
  const lista = await listaDaEquipe(c.env);
  const naEquipe = (e) => lista.some((x) => x.email === e);
  const comDono = (l) => l.some((x) => x.papel === "dono");
  if (acao === "criar" || acao === "editar") {
    if (limparNome(d.nome).length < 2) return "diga o nome da pessoa";
    if (!PAPEIS.includes(d.papel)) return "papel inválido";
  }
  if (acao === "criar" && naEquipe(email)) return email + " já está na equipe";
  if (acao === "editar") {
    const de = normal(d.de);
    if (!naEquipe(de)) return (de || "essa pessoa") + " não está na equipe";
    if (de !== email && naEquipe(email)) return email + " já está na equipe";
    if (!comDono([...lista.filter((x) => x.email !== de), { email, papel: d.papel }])) return "a equipe precisa de pelo menos um dono";
  }
  if (acao === "excluir") {
    if (!naEquipe(email)) return email + " não está na equipe";
    if (!comDono(lista.filter((x) => x.email !== email))) return "a equipe precisa de pelo menos um dono";
  }
  if (acao === "cancelar_convite") {
    const m = lista.find((x) => x.email === email);
    if (!m || !m.convidado || (await acessoDe(c.env, email))) return "não há convite pendente para " + email;
  }
  return "";
}

async function conferirAlteracao(c, tipo, d) {
  if (tipo === "equipe.papel") {
    if (!PAPEIS.includes(d.papel)) return "papel inválido";
    if (!(await listaDaEquipe(c.env)).some((x) => x.email === normal(d.email))) return "essa pessoa não está na equipe";
    return "";
  }
  if (tipo === "equipe.membro") return conferirMembro(c, d);
  return "";
}

async function enfileirar(c, d) {
  const tipo = String(d.tipo || "");
  if (!PODE[tipo]) return json({ erro: "alteração desconhecida: " + tipo }, 400);
  if (!PODE[tipo].includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não pode fazer isso" }, 403);
  const dados = d.dados && typeof d.dados === "object" && !Array.isArray(d.dados) ? d.dados : {};
  const erro = await conferirAlteracao(c, tipo, dados);
  if (erro) return json({ erro }, 400);
  const lista = await lerLista(c.env, K(c.env).pendentes(c.quem.email));
  lista.push({ id: novoId(), quando: iso(c.agora), tela: String(d.tela || "").slice(0, 40), tipo, alvo: String(d.alvo || "").slice(0, 120), dados,
    texto: String(d.texto || tipo).slice(0, 300) });
  await c.env.CONTAS.put(K(c.env).pendentes(c.quem.email), JSON.stringify(lista.slice(-50)));
  return json({ pendentes: lista });
}

async function tirarDaFila(c, id) {
  const lista = (await lerLista(c.env, K(c.env).pendentes(c.quem.email))).filter((x) => x.id !== id);
  await c.env.CONTAS.put(K(c.env).pendentes(c.quem.email), JSON.stringify(lista));
  return json({ pendentes: lista });
}

/* equipe.membro na publicacao. Incluida, a pessoa ja entra com a Conta Atos do e-mail; o aviso por e-mail e
   cortesia: se nao sai, ela continua na equipe e o aviso da publicacao diz. */
async function aplicarMembro(c, d) {
  const erro = await conferirMembro(c, d);
  if (erro) throw new Error(erro);
  const { env } = c;
  const email = normal(d.email);
  const nome = limparNome(d.nome);
  const lista = await listaDaEquipe(env);
  const novo = () => ({ email, nome, papel: d.papel, convidado: { criado: iso(c.agora), por: c.quem.email, por_nome: limparNome(c.quem.nome) } });
  const avisar = async (m) => {
    const e = await avisoDeEntrada(c, m);
    return e.ok ? {} : { aviso: email + " entrou na equipe, mas o e-mail de aviso não saiu (" + e.erro + "): avise a pessoa" };
  };
  if (d.acao === "criar") {
    const m = novo();
    await guardarEquipe(env, [...lista, m]);
    return avisar(m);
  }
  if (d.acao === "excluir" || d.acao === "cancelar_convite") {
    await guardarEquipe(env, lista.filter((x) => x.email !== email));
    await env.CONTAS.delete(K(env).acesso(email));
    return {};
  }
  const de = normal(d.de);
  if (de === email) {
    await guardarEquipe(env, lista.map((x) => (x.email === de ? { ...x, nome, papel: d.papel } : x)));
    return {};
  }
  // O e-mail mudou: o novo entra (e recebe o aviso) e o antigo sai.
  const m = novo();
  await guardarEquipe(env, [...lista.filter((x) => x.email !== de), m]);
  await env.CONTAS.delete(K(env).acesso(de));
  return avisar(m);
}

async function aplicar(c, alt) {
  const d = alt.dados || {};
  if (alt.tipo === "equipe.papel") {
    const lista = await listaDaEquipe(c.env);
    const m = lista.find((x) => x.email === normal(d.email));
    if (!m) throw new Error("essa pessoa não está na equipe");
    m.papel = d.papel;
    if (!lista.some((x) => x.papel === "dono")) throw new Error("a equipe precisa de pelo menos um dono");
    await guardarEquipe(c.env, lista);
    return {};
  }
  if (alt.tipo === "equipe.membro") return aplicarMembro(c, d);
  throw new Error("alteração desconhecida");
}

async function publicar(c, d) {
  if (String(d.confirmacao || "").trim().toLowerCase() !== CONFIRMACAO) return json({ erro: "digite exatamente: " + CONFIRMACAO }, 400);
  const chave = K(c.env).pendentes(c.quem.email);
  const lista = await lerLista(c.env, chave);
  if (!lista.length) return json({ erro: "nada para publicar" }, 409);
  const resultados = [];
  const retratos = [];
  for (const alt of lista) {
    if (!PODE[alt.tipo] || !PODE[alt.tipo].includes(c.quem.papel)) {
      resultados.push({ id: alt.id, ok: false, erro: "o papel " + c.quem.papel + " não pode" });
      continue;
    }
    try {
      const item = { id: alt.id, tipo: alt.tipo, texto: alt.texto };
      let r;
      if (alt.tipo === "equipe.papel") {
        const antes = await c.env.CONTAS.get(K(c.env).equipe);
        r = await aplicar(c, alt);
        item.kv = [{ chave: K(c.env).equipe, antes, depois: await c.env.CONTAS.get(K(c.env).equipe) }];
      } else {
        r = await aplicar(c, alt);
        item.nao_volta = "a equipe volta pela própria tela (incluir ou tirar a pessoa de novo)";
      }
      retratos.push(item);
      resultados.push({ id: alt.id, ok: true, ...(r && r.aviso ? { aviso: String(r.aviso).slice(0, 300) } : {}) });
    } catch (e) {
      resultados.push({ id: alt.id, ok: false, erro: String((e && e.message) || e).slice(0, 200) });
    }
  }
  const falharam = lista.filter((alt) => resultados.find((r) => r.id === alt.id && !r.ok));
  await c.env.CONTAS.put(chave, JSON.stringify(falharam));
  const feitas = lista.length - falharam.length;
  const id = novoId();
  const publicacao = {
    id, quando: iso(c.agora), commit: "kv-" + id.slice(0, 5),
    resumo: lista.filter((a) => !falharam.includes(a)).map((a) => a.texto).slice(0, 3).join(" · ") + (feitas > 3 ? " · +" + (feitas - 3) : ""),
    n: feitas, por: c.quem.email,
  };
  if (feitas) {
    await c.env.CONTAS.put(K(c.env).retrato(id), JSON.stringify({ quando: publicacao.quando, itens: retratos }), { expirationTtl: RETRATO_S });
    publicacao.retrato = true;
    const pubs = await lerLista(c.env, K(c.env).publicacoes);
    pubs.unshift(publicacao);
    await c.env.CONTAS.put(K(c.env).publicacoes, JSON.stringify(pubs.slice(0, 30)));
  }
  return json({ ok: !falharam.length, resultados, publicacao: publicacaoParaTela(publicacao) });
}

/* POST /api/admin/retroagir {publicacao | commit, confirmacao: "retroagir"} - so o dono. Tudo ou nada: volta o
   equipe.papel (se a equipe nao mudou depois); o equipe.membro nao volta por aqui. */
async function retroagir(c, d) {
  if (c.quem.papel !== "dono") return json({ erro: "só o papel dono retroage uma publicação" }, 403);
  if (String(d.confirmacao || "").trim().toLowerCase() !== "retroagir") return json({ erro: "digite exatamente: retroagir" }, 400);
  const pubs = await lerLista(c.env, K(c.env).publicacoes);
  const i = d.publicacao ? pubs.findIndex((p) => p.id === String(d.publicacao)) : pubs.findIndex((p) => d.commit && String(p.commit) === String(d.commit));
  if (i < 0) return json({ erro: "essa publicação não está no histórico" }, 404);
  const pub = pubs[i];
  if (pub.revertida) return json({ erro: "essa publicação já foi retroagida" }, 409);
  const retrato = await kv(c.env, K(c.env).retrato(pub.id));
  if (!retrato) return json({ erro: "o retrato dessa publicação venceu (vale 30 dias): não dá para retroagir; desfaça à mão" }, 409);
  const itens = retrato.itens || [];
  const motivos = [];
  const agoraNaEquipe = await c.env.CONTAS.get(K(c.env).equipe);
  for (const x of itens) {
    if (x.desfeito) continue;
    if (x.nao_volta) motivos.push("“" + x.texto + "”: " + x.nao_volta);
    else if (x.kv && agoraNaEquipe !== x.kv[0].depois) motivos.push("“" + x.texto + "”: a equipe mudou depois dessa publicação: retroaja a mais nova antes");
  }
  if (motivos.length) return json({ erro: "não dá para retroagir esta publicação: " + motivos.join("; "), itens: motivos }, 409);
  for (const x of [...itens].reverse()) {
    if (x.desfeito || !x.kv) continue;
    for (const k of x.kv) {
      // A equipe de antes era a semente: sem a chave, a semente volta a valer.
      if (k.antes === null || k.antes === undefined) await c.env.CONTAS.delete(k.chave);
      else await c.env.CONTAS.put(k.chave, k.antes);
    }
    x.desfeito = true;
    await c.env.CONTAS.put(K(c.env).retrato(pub.id), JSON.stringify(retrato), { expirationTtl: RETRATO_S });
  }
  pub.revertida = { quando: iso(c.agora), por: c.quem.email, commit: "kv-" + novoId().slice(0, 5) };
  pubs[i] = pub;
  await c.env.CONTAS.put(K(c.env).publicacoes, JSON.stringify(pubs));
  return json({ ok: true, commit: pub.revertida.commit, publicacao: publicacaoParaTela(pub), avisos: [] });
}

// ------------------------------------------------------------------ a entrada

export async function atenderAdmin(request, env, url, deps = {}) {
  const agora = deps.agora ? deps.agora() : Date.now();
  const p = url.pathname;
  const m = request.method;
  const navegacao = p === "/api/admin/github/entrar" || p === "/api/admin/github/retorno";
  const quem = await quemNoPainel(request, env, agora);
  // O GitHub e navegacao (o navegador abre a rota): sem sessao, de volta ao painel, que leva ao entrar.
  if (quem.recusa) return navegacao ? ir("/admin/") : quem.recusa;
  const c = { env, deps, quem, agora };
  if (p === "/api/admin/eu" && m === "GET") {
    await anotarAcesso(env, quem.email, agora);
    const gh = await githubDaSessao(request, env, quem.email);
    return json({ email: quem.email, nome: quem.nome, papel: quem.papel, github: gh ? gh.login : null });
  }
  if (p.startsWith(PREFIXO_PAVLVS)) return encaminharAoPavlvs(request, env, url, c);
  if (p.startsWith("/api/admin/nfse/")) {
    if (quem.papel === "suporte" && m !== "GET") return json({ erro: "o suporte só consulta as notas" }, 403);
    if (!deps.emissor) return json({ erro: "o emissor de notas ainda não está ligado" }, 503);
    return deps.emissor(request, env, url, quem);
  }
  if (p === "/api/admin/github/entrar" && m === "GET") return githubEntrar(c, url);
  if (p === "/api/admin/github/retorno" && m === "GET") return githubRetorno(c, request, url);
  if (p === "/api/admin/github/sair" && m === "POST") return githubSair(c, request);
  if (p === "/api/admin/equipe" && m === "GET") return json(await telaDaEquipe(c));
  let r = p.match(/^\/api\/admin\/equipe\/convite\/([^/]{3,200})\/reenviar$/);
  if (r && m === "POST") {
    let email = "";
    try {
      email = normal(decodeURIComponent(r[1]));
    } catch {
      email = "";
    }
    return reenviarAviso(c, email);
  }
  if (p === "/api/admin/alteracoes" && m === "GET") return json(await alteracoes(c));
  if (m === "POST" && (p === "/api/admin/alteracoes" || p === "/api/admin/publicar" || p === "/api/admin/retroagir")) {
    let d = {};
    try {
      d = (await request.json()) || {};
    } catch {
      d = {};
    }
    if (p === "/api/admin/alteracoes") return enfileirar(c, d);
    if (p === "/api/admin/publicar") return publicar(c, d);
    return retroagir(c, d);
  }
  r = p.match(/^\/api\/admin\/alteracoes\/([A-Za-z0-9_-]{4,32})$/);
  if (r && m === "DELETE") return tirarDaFila(c, r[1]);
  return json({ erro: "rota não existe" }, 404);
}
