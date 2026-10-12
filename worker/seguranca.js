// A seguranca da Conta Atos: a guia Seguranca da Minha conta (/conta/seguranca; public/assets/conta-seguranca.js), a
// segunda etapa do login e o "Entrar com chave de acesso".
//
//   GET  /api/seguranca                       o estado: a etapa (aplicativo, codigos, chaves), os acessos e as sessoes
//   POST /api/seguranca/totp/iniciar          um segredo novo (10 min para confirmar): {chave, uri, qr (SVG)}
//   POST /api/seguranca/totp/ligar            {codigo}: confere o codigo e liga; na primeira vez, os 10 codigos de recuperacao
//   POST /api/seguranca/totp/desligar         {codigo | recuperacao}
//   POST /api/seguranca/recuperacao/gerar     10 codigos novos (os antigos deixam de valer)
//   POST /api/seguranca/chaves/opcoes         as opcoes do navigator.credentials.create
//   POST /api/seguranca/chaves/registrar      {nome, credencial}
//   POST /api/seguranca/chaves/remover        {id}
//   POST /api/seguranca/sessoes/sair          {id}: sai daquela sessao
//   POST /api/seguranca/sessoes/sair-outras   sai de todas as outras (esta continua)
//   POST /api/segunda-etapa/opcoes            a etapa em andamento (cookie __Host-atos-etapa): os metodos e as opcoes da chave
//   POST /api/segunda-etapa                   {codigo | recuperacao | credencial}: abre a sessao
//   POST /api/chave/opcoes                    as opcoes do navigator.credentials.get (entrar sem senha)
//   POST /api/chave/entrar                    {credencial}: abre a sessao
//
// As mudancas pedem um login da ultima hora (RECENTE_S). Com a segunda etapa ja ligada, pedem tambem que esta sessao
// tenha passado por ela (mfa) - quem so tem a senha nao troca o aplicativo nem poe uma chave sua. Desligar o aplicativo
// pede ainda um codigo (do aplicativo ou de recuperacao). Ligar o aplicativo ou cadastrar uma chave marca a sessao como
// mfa (a pessoa acabou de provar que tem o segundo fator): e assim que quem esta na equipe liga a etapa e volta ao painel.
//
// Perdeu tudo (o aplicativo, os codigos e as chaves)? Nao ha desligamento automatico: a pessoa escreve para
// contato@atos.dev.br (as telas e os termos dizem isso); a equipe confere a identidade fora do painel e o dono desliga
// pelo painel (Contas Atos; worker/admin-contas.js, op "equipe-zerar" do objeto), com motivo, registro e o aviso por e-mail.

import { b64urlTexto, deB64url, json, kv, lerJson } from "./comum.js";
import { COOKIE, SESSAO_S, abrirSessao, campoSessoesDesde, sessaoDe } from "./contas.js";
import { matrizQr } from "./nfse/qr.js";
import { seg, resumoDaSeguranca } from "./seguranca/objeto.js";
import { chaveMestra, uriTotp } from "./seguranca/totp.js";
import { desafioDe } from "./seguranca/webauthn.js";
import { amrComSegunda, amrDaChave, cookieEtapaApagado, lerCookieEtapa, rpDe } from "./seguranca/etapa.js";
import { KS, anotar, atividadeDe, guardarSessoes, idDaSessao, sessoesDe } from "./seguranca/atividade.js";
import { avisar } from "./seguranca/avisos.js";

export const RECENTE_S = 3600;
const TIMEOUT_MS = 120000;

const ROTAS = new Set([
  "/api/seguranca", "/api/seguranca/totp/iniciar", "/api/seguranca/totp/ligar", "/api/seguranca/totp/desligar", "/api/seguranca/recuperacao/gerar",
  "/api/seguranca/chaves/opcoes", "/api/seguranca/chaves/registrar", "/api/seguranca/chaves/remover", "/api/seguranca/sessoes/sair",
  "/api/seguranca/sessoes/sair-outras", "/api/segunda-etapa/opcoes", "/api/segunda-etapa", "/api/chave/opcoes", "/api/chave/entrar",
]);
export const ehRotaDaSeguranca = (url) => ROTAS.has(url.pathname);

const INDISPONIVEL = () => json({ erro: "não deu para falar com a segurança da conta agora: tente de novo em instantes" }, 503);
const ERROS = {
  codigo: [400, "o código não confere"],
  bloqueado: [429, "muitas tentativas erradas: espere 15 minutos e tente de novo"],
  sem_chave: [503, "o código do aplicativo não pode ser conferido agora: use um código de recuperação ou uma chave de acesso, ou escreva para contato@atos.dev.br"],
  vazio: [400, "digite o código"],
  vencido: [400, "o tempo para confirmar acabou: comece de novo"],
  desafio: [400, "o pedido da chave de acesso venceu: tente de novo"],
  chave: [400, "a chave de acesso não confirmou: tente de novo"],
  chave_desconhecida: [400, "esta chave de acesso não está cadastrada nesta conta"],
  invalida: [400, "a chave de acesso não foi aceita: tente de novo"],
  repetida: [409, "esta chave de acesso já está cadastrada"],
  muitas: [409, "esta conta já tem chaves de acesso demais: remova uma antes"],
  ja_ligada: [409, "o aplicativo autenticador já está ligado"],
  sem_totp: [409, "o aplicativo autenticador não está ligado"],
  inativa: [409, "a verificação em duas etapas não está ligada"],
  nao_existe: [404, "essa chave de acesso não existe mais"],
  indisponivel: [503, "o aplicativo autenticador ainda não está disponível na Atos"],
};
function recusa(r) {
  const [status, erro] = ERROS[r.erro] || [400, "não deu certo: tente de novo"];
  return json({ erro, codigo: r.erro || "erro" }, status);
}

/* O QR code do endereco otpauth como SVG (sem script; preto no branco, com a margem que os leitores pedem). */
export function qrSvg(texto) {
  const { n, modulos } = matrizQr(texto);
  const m = 4, t = n + 2 * m;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (modulos[y * n + x]) d += "M" + (x + m) + " " + (y + m) + "h1v1h-1z";
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + t + " " + t + '" width="200" height="200" shape-rendering="crispEdges" role="img" aria-label="QR code para o aplicativo autenticador">' +
    '<rect width="' + t + '" height="' + t + '" fill="#ffffff"/><path fill="#000000" d="' + d + '"/></svg>';
}

const recente = (s, agora) => agora / 1000 - Number(s.auth_time || 0) < RECENTE_S;

/* Marca esta sessao como mfa (acabou de provar o segundo fator). */
async function marcarMfa(env, s, agora) {
  const k = "atos:sessao:" + s.h;
  const x = await kv(env, k);
  if (!x) return;
  const resta = Math.max(60, Math.floor((x.auth_time * 1000 + SESSAO_S * 1000 - agora) / 1000));
  await env.CONTAS.put(k, JSON.stringify({ ...x, mfa: true, mfa_em: agora }), { expirationTtl: resta });
}

/* As opcoes do navigator.credentials.get (o navegador as converte: assets/chave-de-acesso.js). */
function opcoesGet(rp, desafio, chaves) {
  return { challenge: desafio, rpId: rp.rpId, userVerification: "required", timeout: TIMEOUT_MS,
    allowCredentials: (chaves || []).map((c) => ({ type: "public-key", id: c.id, ...(c.transportes && c.transportes.length ? { transports: c.transportes } : {}) })) };
}

function sessaoComEtapaApagada(dados, cookieSessao) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  h.append("set-cookie", cookieSessao);
  h.append("set-cookie", cookieEtapaApagado);
  return new Response(JSON.stringify(dados), { status: 200, headers: h });
}

export async function atenderSeguranca(request, env, url, deps = {}) {
  const p = url.pathname;
  const agora = (deps.agora || Date.now)();
  if (!env.SEGURANCA) return json({ erro: "a segurança da conta ainda não está ligada neste servidor" }, 503);
  const rp = rpDe(url, env);

  if (p !== "/api/seguranca" && request.method !== "POST") return json({ erro: "use POST" }, 405);
  if (request.method === "POST" && deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
  const d = request.method === "POST" ? (await lerJson(request)) || {} : {};

  try {
    // ---------------------------------------------------------- a segunda etapa do login
    if (p === "/api/segunda-etapa/opcoes" || p === "/api/segunda-etapa") return await segundaEtapa(request, env, p, d, rp, agora, deps);

    // ---------------------------------------------------------- entrar com a chave de acesso (sem senha)
    if (p === "/api/chave/opcoes") {
      if (!rp) return json({ erro: "as chaves de acesso não funcionam neste endereço" }, 400);
      const r = await seg(env, "entrar")("desafio", { fim: "entrar", agora });
      return json({ publicKey: opcoesGet(rp, r.desafio, []) });
    }
    if (p === "/api/chave/entrar") return await entrarComChave(request, env, d, rp, agora);

    // ---------------------------------------------------------- a guia Seguranca (com sessao)
    const s = await sessaoDe(request, env);
    if (!s) return json({ erro: "entre na sua conta", entrar: true }, 401);
    const doSub = seg(env, s.sub);
    const r = await resumoDaSeguranca(env, s.sub, agora);

    if (p === "/api/seguranca") return json(await estado(env, s, r, rp, agora, request));

    // Sair de uma sessao (ou de todas as outras) protege a conta: nao pede login recente.
    if (p === "/api/seguranca/sessoes/sair") return await sairDeUma(env, s, String(d.id || ""), request, agora);
    if (p === "/api/seguranca/sessoes/sair-outras") return await sairDasOutras(env, s, request, agora);

    if (!recente(s, agora)) return json({ erro: "para mudar a segurança da conta, entre de novo (o login precisa ser da última hora)", reentrar: true }, 401);
    const exigeMfa = () => (r.ativa && !s.mfa ? json({ erro: "para mudar a segurança da conta, entre de novo passando pela verificação em duas etapas", reentrar: true }, 401) : null);

    if (p === "/api/seguranca/totp/iniciar") {
      if (!(await chaveMestra(env))) return recusa({ erro: "indisponivel" });
      const x = exigeMfa(); if (x) return x;
      const v = await doSub("totp-iniciar", { sub: s.sub, agora });
      if (!v.ok) return recusa(v);
      const uri = uriTotp(v.segredo, s.email);
      return json({ ok: true, chave: v.segredo.match(/.{1,4}/g).join(" "), uri, qr: qrSvg(uri) });
    }
    if (p === "/api/seguranca/totp/ligar") {
      const x = exigeMfa(); if (x) return x;
      const v = await doSub("totp-ligar", { sub: s.sub, codigo: String(d.codigo || "").slice(0, 12), agora });
      if (!v.ok) return recusa(v);
      await marcarMfa(env, s, agora);
      await anotar(env, s.sub, { tipo: "mudanca", evento: "totp-ligada" }, agora, request);
      await avisar(env, deps, s.email, "totp-ligada", { agora, request });
      return json({ ok: true, codigos: v.codigos || null });
    }
    if (p === "/api/seguranca/totp/desligar") {
      const v = await doSub("totp-desligar", { sub: s.sub, codigo: d.codigo ? String(d.codigo).slice(0, 12) : "", recuperacao: d.recuperacao ? String(d.recuperacao).slice(0, 40) : "", agora });
      if (!v.ok) return recusa(v);
      await anotar(env, s.sub, { tipo: "mudanca", evento: "totp-desligada" }, agora, request);
      await avisar(env, deps, s.email, v.resumo.ativa ? "totp-desligada" : "segunda-desligada", { agora, request });
      return json({ ok: true, ativa: v.resumo.ativa });
    }
    if (p === "/api/seguranca/recuperacao/gerar") {
      if (!r.ativa) return recusa({ erro: "inativa" });
      const x = exigeMfa(); if (x) return x;
      const v = await doSub("rec-gerar", { sub: s.sub, agora });
      if (!v.ok) return recusa(v);
      await anotar(env, s.sub, { tipo: "mudanca", evento: "codigos-gerados" }, agora, request);
      await avisar(env, deps, s.email, "codigos-gerados", { agora, request });
      return json({ ok: true, codigos: v.codigos });
    }
    if (p === "/api/seguranca/chaves/opcoes") {
      if (!rp) return json({ erro: "as chaves de acesso não funcionam neste endereço" }, 400);
      const x = exigeMfa(); if (x) return x;
      const v = await doSub("desafio", { fim: "registro", agora });
      return json({
        publicKey: {
          challenge: v.desafio, rp: { id: rp.rpId, name: "Atos" },
          user: { id: b64urlTexto(s.sub), name: s.email, displayName: s.nome || s.email },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          timeout: TIMEOUT_MS, attestation: "none",
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
          excludeCredentials: r.chaves.filter((c) => c.rp === rp.rpId).map((c) => ({ type: "public-key", id: c.id })),
        },
      });
    }
    if (p === "/api/seguranca/chaves/registrar") {
      if (!rp) return json({ erro: "as chaves de acesso não funcionam neste endereço" }, 400);
      const x = exigeMfa(); if (x) return x;
      const nome = String(d.nome || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60) || "Chave de acesso";
      const cred = d.credencial;
      if (!cred || typeof cred !== "object" || typeof cred.id !== "string" || cred.id.length > 1400) return json({ erro: "a chave de acesso não foi aceita: tente de novo" }, 400);
      // Uma credencial so pode ser de uma conta (o indice do "Entrar com chave de acesso").
      if (await kv(env, KS(env).chave(cred.id))) return recusa({ erro: "repetida" });
      const v = await doSub("chave-registrar", { sub: s.sub, credencial: cred, nome, rp: rp.rpId, origem: rp.origem, agora });
      if (!v.ok) return recusa(v);
      await env.CONTAS.put(KS(env).chave(v.chave.id), JSON.stringify({ sub: s.sub, email: s.email }));
      await marcarMfa(env, s, agora);
      await anotar(env, s.sub, { tipo: "mudanca", evento: "chave-cadastrada", detalhe: v.chave.nome }, agora, request);
      await avisar(env, deps, s.email, "chave-cadastrada", { agora, request, detalhe: "Nome da chave: " + v.chave.nome + "." });
      return json({ ok: true, chave: v.chave, codigos: v.codigos || null });
    }
    if (p === "/api/seguranca/chaves/remover") {
      if (!s.mfa) return json({ erro: "para remover uma chave de acesso, entre de novo passando pela verificação em duas etapas", reentrar: true }, 401);
      const id = String(d.id || "").slice(0, 1400);
      const v = await doSub("chave-remover", { sub: s.sub, id, agora });
      if (!v.ok) return recusa(v);
      const indice = await kv(env, KS(env).chave(id));
      if (indice && indice.sub === s.sub) await env.CONTAS.delete(KS(env).chave(id));
      await anotar(env, s.sub, { tipo: "mudanca", evento: "chave-removida", detalhe: v.nome }, agora, request);
      await avisar(env, deps, s.email, v.resumo.ativa ? "chave-removida" : "segunda-desligada", { agora, request, detalhe: "Nome da chave: " + v.nome + "." });
      return json({ ok: true, ativa: v.resumo.ativa });
    }
  } catch (e) {
    console.warn("seguranca: " + String((e && e.message) || e));
    return INDISPONIVEL();
  }
  return json({ erro: "rota não existe" }, 404);
}

// ------------------------------------------------------------------ o estado da guia

async function estado(env, s, r, rp, agora, request) {
  const atual = await idDaSessao(s.h);
  const sessoes = await sessoesDe(env, s.sub, agora);
  const lista = await Promise.all(sessoes.map(async (x) => ({ id: x.id, atual: x.id === atual, criada: x.criada, como: x.como, segunda: x.segunda || "", onde: x.onde, navegador: x.navegador })));
  // A sessao de agora pode ser de antes da lista (aberta antes desta versao): aparece mesmo assim.
  if (!lista.some((x) => x.atual)) lista.unshift({ id: atual, atual: true, criada: new Date(s.criada).toISOString(), como: s.como || "", segunda: "", onde: "", navegador: "" });
  const disponivelTotp = Boolean(await chaveMestra(env));
  return {
    disponivel: { totp: disponivelTotp, chaves: Boolean(rp) },
    recente: recente(s, agora), mfa: s.mfa, recente_s: RECENTE_S,
    ativa: r.ativa, bloqueado: r.bloqueado, totp: r.totp, recuperacao: r.recuperacao,
    chaves: r.chaves.map((c) => ({ id: c.id, nome: c.nome, criada: c.criada, ultimo_uso: c.ultimo_uso, sincronizada: c.sincronizada, alerta: c.alerta, aqui: Boolean(rp && c.rp === rp.rpId) })),
    atividade: await atividadeDe(env, s.sub, agora),
    sessoes: lista,
  };
}

// ------------------------------------------------------------------ as sessoes

async function sairDeUma(env, s, id, request, agora) {
  const lista = await sessoesDe(env, s.sub, agora);
  const alvo = lista.find((x) => x.id === id);
  if (!alvo) return json({ erro: "essa sessão já não está aberta" }, 404);
  await env.CONTAS.delete("atos:sessao:" + alvo.h);
  await guardarSessoes(env, s.sub, lista.filter((x) => x.id !== id));
  const estaMesma = alvo.h === s.h;
  return json({ ok: true, saiu_desta: estaMesma }, 200, estaMesma ? { "set-cookie": COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" } : {});
}

async function sairDasOutras(env, s, request, agora) {
  // 1) a conta anota o instante: toda sessao criada antes cai (tambem as de antes da lista);
  const c = await kv(env, "id:conta:" + s.email);
  if (!c || c.sub !== s.sub) return json({ erro: "entre na sua conta" }, 401);
  await env.CONTAS.put("id:conta:" + s.email, JSON.stringify({ ...c, [campoSessoesDesde(env)]: agora }));
  // 2) esta sessao passa a ter sido criada agora (continua aberta);
  const k = "atos:sessao:" + s.h;
  const x = await kv(env, k);
  if (x) {
    const resta = Math.max(60, Math.floor((x.auth_time * 1000 + SESSAO_S * 1000 - agora) / 1000));
    await env.CONTAS.put(k, JSON.stringify({ ...x, criada: agora }), { expirationTtl: resta });
  }
  // 3) as outras da lista saem do KV na hora.
  const lista = await sessoesDe(env, s.sub, agora);
  let n = 0;
  for (const y of lista) if (y.h !== s.h) { await env.CONTAS.delete("atos:sessao:" + y.h); n++; }
  await guardarSessoes(env, s.sub, lista.filter((y) => y.h === s.h));
  await anotar(env, s.sub, { tipo: "mudanca", evento: "sair-outras" }, agora, request);
  return json({ ok: true, encerradas: n });
}

// ------------------------------------------------------------------ a segunda etapa

async function segundaEtapa(request, env, p, d, rp, agora, deps) {
  const ck = lerCookieEtapa(request);
  const vencida = () => json({ erro: "a confirmação venceu: entre de novo", recomecar: true }, 400, { "set-cookie": cookieEtapaApagado });
  if (!ck) return vencida();
  const doSub = seg(env, ck.sub);
  if (p === "/api/segunda-etapa/opcoes") {
    const v = await doSub("etapa-ver", { token: ck.token, rp: rp ? rp.rpId : "", agora });
    if (!v.ok) return vencida();
    return json({
      metodos: v.metodos, email: v.dados && v.dados.email ? mascarar(v.dados.email) : "",
      ...(v.publicKey && rp ? { publicKey: opcoesGet(rp, v.publicKey.desafio, v.publicKey.chaves.map((c) => ({ id: c.id, transportes: c.transportes }))) } : {}),
    });
  }
  const dados = { sub: ck.sub, token: ck.token, agora, rp: rp ? rp.rpId : "", origem: rp ? rp.origem : "" };
  if (d.credencial && typeof d.credencial === "object") {
    if (!rp) return json({ erro: "as chaves de acesso não funcionam neste endereço" }, 400);
    dados.credencial = d.credencial;
  } else if (d.recuperacao) dados.recuperacao = String(d.recuperacao).slice(0, 40);
  else dados.codigo = String(d.codigo || "").slice(0, 12);
  const v = await doSub("etapa-concluir", dados);
  if (!v.ok) {
    if (v.erro === "vencida") return vencida();
    const [status, erro] = ERROS[v.erro] || [400, "não confirmou: tente de novo"];
    if (v.morta) return json({ erro: v.erro === "bloqueado" ? erro : "muitas tentativas: entre de novo", recomecar: true, codigo: v.erro }, v.erro === "bloqueado" ? 429 : 400, { "set-cookie": cookieEtapaApagado });
    return json({ erro, codigo: v.erro }, status);
  }
  const e = v.dados || {};
  // A conta ainda e a mesma (nao foi apagada nem trocou de dono no meio).
  const c = await kv(env, "id:conta:" + e.email);
  if (!c || c.sub !== e.sub || e.sub !== ck.sub) return vencida();
  const amr = amrComSegunda(e.amr, v.metodo, v.chave && v.chave.sincronizada);
  const cookie = await abrirSessao(env, { sub: e.sub, email: e.email, alias: e.alias || "" }, agora, { como: e.como, amr, mfa: true, segunda: v.metodo, request });
  if (v.metodo === "recuperacao") {
    await avisar(env, deps, e.email, "codigo-usado", { agora, request, detalhe: "Restam " + v.restantes + " código(s) de recuperação." + (v.restantes <= 3 ? " Gere códigos novos em Minha conta › Segurança." : "") });
  }
  if (v.regrediu) await anotar(env, e.sub, { tipo: "mudanca", evento: "chave-contador", detalhe: v.chave && v.chave.nome }, agora, request);
  return sessaoComEtapaApagada({ ok: true, conta: { email: e.email, nome: c.nome || "" }, via: e.alias ? "alias" : "email" }, cookie);
}

function mascarar(email) {
  const e = String(email || "");
  const at = e.lastIndexOf("@");
  return at < 1 ? "" : e.charAt(0) + "***" + e.slice(at);
}

// ------------------------------------------------------------------ entrar com a chave de acesso

async function entrarComChave(request, env, d, rp, agora) {
  if (!rp) return json({ erro: "as chaves de acesso não funcionam neste endereço" }, 400);
  const cred = d.credencial;
  if (!cred || typeof cred !== "object" || typeof cred.id !== "string" || cred.id.length > 1400) return json({ erro: "a chave de acesso não foi aceita: tente de novo" }, 400);
  // O desafio sai do servidor primeiro (uso unico), mesmo que o resto falhe.
  const desafio = desafioDe(cred);
  const t = desafio ? await seg(env, "entrar")("desafio-tomar", { desafio, fim: "entrar", agora }) : { ok: false };
  if (!t.ok) return json({ erro: "o pedido da chave de acesso venceu: tente de novo", codigo: "desafio" }, 400);
  const dono = await kv(env, KS(env).chave(cred.id));
  const nenhuma = () => json({ erro: "esta chave de acesso não é de nenhuma Conta Atos (ou foi removida)", codigo: "chave_desconhecida" }, 400);
  if (!dono || !dono.sub || !dono.email) return nenhuma();
  const c = await kv(env, "id:conta:" + dono.email);
  if (!c || c.sub !== dono.sub) return nenhuma();
  // O userHandle (o id da pessoa que a Atos deu a chave no cadastro), quando vem, tem de ser o desta conta.
  if (cred.response && cred.response.userHandle) {
    let uh = "";
    try { uh = new TextDecoder().decode(deB64url(String(cred.response.userHandle))); } catch { uh = ""; }
    if (uh !== dono.sub) return nenhuma();
  }
  const v = await seg(env, dono.sub)("chave-conferir", { sub: dono.sub, credencial: cred, rp: rp.rpId, origem: rp.origem, desafio, agora });
  if (!v.ok) {
    if (v.erro === "chave_desconhecida") return nenhuma();
    return recusa(v);
  }
  const cookie = await abrirSessao(env, { sub: dono.sub, email: dono.email }, agora, { como: "chave", amr: amrDaChave(v.chave.sincronizada), mfa: true, request });
  if (v.regrediu) await anotar(env, dono.sub, { tipo: "mudanca", evento: "chave-contador", detalhe: v.chave.nome }, agora, request);
  // Uma etapa que tivesse ficado aberta neste navegador nao serve mais.
  return sessaoComEtapaApagada({ ok: true, conta: { email: dono.email, nome: c.nome || "" }, via: "email" }, cookie);
}
