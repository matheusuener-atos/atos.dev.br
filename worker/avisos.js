// Atos Workspace > Integracoes > Avisos ao sistema (webhooks): em cada aplicativo, o dono cadastra um endereco https do
// sistema dele e recebe um segredo (mostrado uma vez). A Atos manda ali, assinado, o que mudou no acesso das pessoas:
//
//   acesso.revogado      a pessoa tirou a permissao do aplicativo em Minha conta (Aplicativos com acesso)
//                        dados: {sub}
//   liberado.adicionado  o dono liberou e-mails na lista do aplicativo
//   liberado.removido    o dono tirou um e-mail da lista
//                        dados: {pessoas: [{email, sub?}]} - o e-mail (foi o dono que o digitou) e o `sub` so de quem ja
//                        permitiu este aplicativo (o sistema ja o recebeu no login); de quem nunca entrou, so o e-mail: o
//                        aviso nao diz se o e-mail tem Conta Atos
//   aviso.teste          o botao "Mandar um aviso de teste" (dados: {})
// O minimo: o acesso.revogado leva so o `sub` (o sistema identifica a pessoa por ele; o e-mail pode nem ter sido
// permitido pelo escopo). A Atos nao tem a exclusao de conta pelo sistema (e pedida por e-mail), entao nao ha
// "conta.excluida".
//
// A entrega: POST JSON {id, tipo, criado, app, dados} ao endereco, com
//   Atos-Evento:      o id do aviso (o mesmo em toda tentativa)
//   Atos-Assinatura:  t=<segundos>,v1=<HMAC-SHA256 hex de "<t>.<corpo>" com o segredo do aviso>
// o mesmo formato dos eventos da Atos Cobranca (worker/cobranca/eventos.js). Resposta 2xx = entregue; senao, nova
// tentativa em 1 min, 5 min, 30 min, 2 h e 12 h, e esgotadas, "falhou" (o dono ve e pode mandar de novo). 10 s de
// espera, sem seguir redirecionamento. O sistema confere a assinatura e a idade (5 minutos): verificarAviso no pacote
// @atos.dev.br/entrar (0.3.0).
//
// O endereco: so https publico (worker/url-externa.js: sem IP, localhost, rede interna nem a propria Atos). O segredo
// fica guardado no objeto da conta (a Atos precisa dele para assinar; nunca volta a tela). Cada aviso guardado (o
// corpo, com o sub e os e-mails) e o resultado de cada entrega ficam 30 dias no gratuito e 90 no Pro
// (worker/workspace-plano.js; depois do Pro, a carencia) e somem (a limpeza do objeto); ate 500
// avisos por aplicativo por dia (acima disso, nao entram na fila).
//
// No objeto da conta (worker/workspace-dados.js):
//   av:<app>                {url, ativo, segredo, segredo_quando, criado, mudado, bloqueado: null|{quando, motivo, por}}
//   avq:<app>|<iso>|<r>     {evento, estado: "pendente"|"entregue"|"falhou"|"cancelado", tentativas, proxima, ultimo, entregue}
//   avisos-proxima          a hora da proxima tentativa (o alarme do objeto)
//
// Rotas (pela porta das Integracoes, worker/integracoes.js):
//   GET  /api/integracoes/apps/:id/avisos      o aviso e as ultimas entregas
//   POST /api/integracoes/apps/:id/avisos      {acao: salvar {url} | ligar | desligar | segredo | testar | reenviar {entrega} | apagar}
// O painel da equipe (worker/admin-workspace.js) ve o endereco e as falhas de cada aplicativo e desliga os avisos por
// abuso (o endereco usado para bater num terceiro): POST /api/admin/workspace/apps/:id/avisos/(desligar|ligar) {motivo}.

import { aleatorio, json, kv } from "./comum.js";
import { assinarEvento } from "./cobranca/eventos.js";
import { apagarAntigos, apagarPrefixo, daConta, isoDe, sorteio } from "./workspace-dados.js";
import { conferirUrlExterna } from "./url-externa.js";
import { PLANOS_WS } from "./workspace-plano.js";

export const TIPOS_AVISO = ["acesso.revogado", "liberado.adicionado", "liberado.removido", "aviso.teste"];
export const REENTREGAS_AVISO_S = [60, 300, 1800, 7200, 43200];
export const LIMITES_AVISO = { retencao_dias: 30, por_dia: 500, por_alarme: 25, tempo_ms: 10000, mostrar: 30 };
const DIA_S = 86400;

// ------------------------------------------------------------------ o objeto

const vistaDoAviso = (a) => a ? {
  url: a.url, ativo: a.ativo !== false, criado: a.criado || null, mudado: a.mudado || null, segredo_quando: a.segredo_quando || null,
  bloqueado: a.bloqueado ? { quando: a.bloqueado.quando, motivo: a.bloqueado.motivo || "", por: a.bloqueado.por || "" } : null,
} : null;
const vistaDaEntrega = (k, x) => ({
  chave: k, id: x.evento.id, tipo: x.evento.tipo, criado: x.evento.criado, estado: x.estado, tentativas: x.tentativas, proxima: x.estado === "pendente" ? isoDe(x.proxima) : null,
  ultimo: x.ultimo || null, entregue: x.entregue || null,
});

/* As ultimas `n` entregas de um aplicativo; com `desde` (iso), so as criadas depois (o historico do plano). */
async function entregasDe(s, app, n, desde) {
  const l = [];
  for (const [k, x] of await s.list({ prefix: "avq:" + app + "|", reverse: true, limit: n })) {
    if (desde && k.slice(4 + app.length + 1).split("|")[0] < desde) break;
    l.push(vistaDaEntrega(k, x));
  }
  return l;
}
const BLOQUEADO = (a) => ({ ok: false, status: 403, erro: "a Atos desligou os avisos deste aplicativo" + (a.bloqueado.motivo ? " (" + a.bloqueado.motivo + ")" : "") + ": escreva para contato@atos.dev.br" });

export const OPS_AVISOS = {
  async av_ver(o, d, agora) {
    const s = o.ctx.storage;
    // O historico do plano (worker/workspace-plano.js): quantas entregas e de quantos dias (o gratuito, 30; o Pro, 90).
    const n = Math.min(Number(d.mostrar) || LIMITES_AVISO.mostrar, 200);
    const desde = Number(d.dias) > 0 ? isoDe(agora - Number(d.dias) * DIA_S * 1000) : "";
    return { ok: true, aviso: vistaDoAviso(await s.get("av:" + d.app)), entregas: await entregasDe(s, d.app, n, desde) };
  },
  /* O resumo de varios aplicativos (a tela das Integracoes e o painel): o aviso e as falhas recentes. */
  async av_resumo(o, d) {
    const s = o.ctx.storage;
    const r = {};
    for (const app of d.apps || []) {
      const a = await s.get("av:" + app);
      if (!a) continue;
      const ult = await entregasDe(s, app, 20);
      r[app] = { ...vistaDoAviso(a), falhas: ult.filter((x) => x.estado === "falhou").length, pendentes: ult.filter((x) => x.estado === "pendente").length, ultima: ult[0] || null };
    }
    return { ok: true, avisos: r };
  },
  async av_salvar(o, d, agora) {
    const s = o.ctx.storage;
    const a = await s.get("av:" + d.app);
    if (a && a.bloqueado) return BLOQUEADO(a);
    if (a) {
      a.url = d.url; a.mudado = isoDe(agora);
      await s.put("av:" + d.app, a);
      return { ok: true, aviso: vistaDoAviso(a) };
    }
    const novo = { url: d.url, ativo: true, segredo: d.segredo, segredo_quando: isoDe(agora), criado: isoDe(agora), mudado: null, bloqueado: null };
    await s.put("av:" + d.app, novo);
    return { ok: true, aviso: vistaDoAviso(novo), novo: true };
  },
  async av_segredo(o, d, agora) {
    const s = o.ctx.storage;
    const a = await s.get("av:" + d.app);
    if (!a) return { ok: false, status: 404, erro: "cadastre o endereço primeiro" };
    if (a.bloqueado) return BLOQUEADO(a);
    a.segredo = d.segredo; a.segredo_quando = isoDe(agora);
    await s.put("av:" + d.app, a);
    return { ok: true, aviso: vistaDoAviso(a) };
  },
  async av_estado(o, d, agora) {
    const s = o.ctx.storage;
    const a = await s.get("av:" + d.app);
    if (!a) return { ok: false, status: 404, erro: "cadastre o endereço primeiro" };
    if (d.ativo && a.bloqueado) return BLOQUEADO(a);
    a.ativo = Boolean(d.ativo); a.mudado = isoDe(agora);
    await s.put("av:" + d.app, a);
    return { ok: true, aviso: vistaDoAviso(a) };
  },
  async av_bloqueio(o, d) {
    const s = o.ctx.storage;
    const a = await s.get("av:" + d.app);
    if (!a) return { ok: false, status: 404, erro: "esse aplicativo não tem avisos" };
    a.bloqueado = d.bloqueado || null;
    await s.put("av:" + d.app, a);
    return { ok: true, aviso: vistaDoAviso(a) };
  },
  async av_apagar(o, d) {
    const s = o.ctx.storage;
    await s.delete("av:" + d.app);
    await apagarPrefixo(s, "avq:" + d.app + "|");
    return { ok: true };
  },
  /* Um aviso novo para a fila (so com o endereco cadastrado, ligado e sem bloqueio). */
  async av_evento(o, d, agora) {
    const s = o.ctx.storage;
    const a = await s.get("av:" + d.app);
    if (!a || a.ativo === false || a.bloqueado) return { ok: true, enfileirado: false };
    if (!TIPOS_AVISO.includes(d.tipo)) return { ok: false, erro: "tipo desconhecido" };
    if (!(await o.contar("avdia:" + d.app + ":" + isoDe(agora).slice(0, 10), 2 * DIA_S, agora, LIMITES_AVISO.por_dia))) return { ok: true, enfileirado: false, limite: true };
    const evento = { id: "av_" + sorteio(8), tipo: d.tipo, criado: isoDe(agora), app: d.app, dados: d.dados || {} };
    await s.put("avq:" + d.app + "|" + isoDe(agora) + "|" + sorteio(), { evento, estado: "pendente", tentativas: 0, proxima: agora });
    await marcarProxima(o, agora);
    return { ok: true, enfileirado: true, id: evento.id };
  },
  async av_reenviar(o, d, agora) {
    const s = o.ctx.storage;
    const k = String(d.chave || "");
    const x = k.startsWith("avq:" + d.app + "|") ? await s.get(k) : null;
    if (!x) return { ok: false, status: 404, erro: "essa entrega não existe (mais)" };
    if (x.estado === "pendente") return { ok: true };
    const a = await s.get("av:" + d.app);
    if (!a || a.ativo === false || a.bloqueado) return { ok: false, status: 409, erro: "ligue os avisos antes de mandar de novo" };
    Object.assign(x, { estado: "pendente", tentativas: 0, proxima: agora });
    await s.put(k, x);
    await marcarProxima(o, agora);
    return { ok: true };
  },
};

async function marcarProxima(o, quando) {
  const s = o.ctx.storage;
  const atual = await s.get("avisos-proxima");
  if (!atual || atual > quando) await s.put("avisos-proxima", quando);
  await o.reagendar();
}

/* O alarme: entrega a fila vencida (ate por_alarme por vez) e marca a proxima tentativa. */
export async function entregarAvisos(o, agora, buscar = (u, i) => fetch(u, i)) {
  const s = o.ctx.storage;
  if (!(await s.get("avisos-proxima"))) return 0;
  await s.delete("avisos-proxima");
  let proxima = null, n = 0;
  const cfg = new Map();
  for (const [k, x] of await s.list({ prefix: "avq:" })) {
    if (x.estado !== "pendente") continue;
    if (x.proxima > agora || n >= LIMITES_AVISO.por_alarme) { proxima = Math.min(proxima ?? Infinity, Math.max(x.proxima, agora + 1000)); continue; }
    const app = k.slice(4).split("|")[0];
    if (!cfg.has(app)) cfg.set(app, await s.get("av:" + app));
    const a = cfg.get(app);
    if (!a || a.ativo === false || a.bloqueado) { await s.put(k, { ...x, estado: "cancelado", ultimo: { quando: isoDe(agora), status: 0, motivo: "os avisos foram desligados" } }); continue; }
    n++;
    const r = await entregarUm(a, x.evento, buscar);
    const tentativas = x.tentativas + 1;
    const ultimo = { quando: isoDe(agora), status: r.status, motivo: r.motivo || "" };
    if (r.ok) { await s.put(k, { ...x, estado: "entregue", tentativas, ultimo, entregue: isoDe(agora) }); continue; }
    const espera = REENTREGAS_AVISO_S[tentativas - 1];
    const novo = { ...x, tentativas, ultimo };
    if (espera === undefined) novo.estado = "falhou";
    else { novo.proxima = agora + espera * 1000; proxima = Math.min(proxima ?? Infinity, novo.proxima); }
    await s.put(k, novo);
  }
  if (proxima !== null) await s.put("avisos-proxima", proxima);
  await o.marcarLimpeza(agora);
  return n;
}

async function entregarUm(a, evento, buscar) {
  const corpo = JSON.stringify(evento);
  try {
    const r = await buscar(a.url, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", "user-agent": "Atos-Avisos/1 (+https://atos.dev.br/integracao/#avisos)", "Atos-Evento": evento.id, "Atos-Assinatura": await assinarEvento(a.segredo, corpo) },
      body: corpo, signal: AbortSignal.timeout(LIMITES_AVISO.tempo_ms),
    });
    try { if (r.body) await r.body.cancel(); } catch { /* sem corpo */ }
    if (r.status >= 300 && r.status < 400) return { ok: false, status: r.status, motivo: "redirecionamento (a Atos não segue)" };
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, motivo: ok ? "" : "o sistema respondeu " + r.status };
  } catch (e) {
    return { ok: false, status: 0, motivo: e && e.name === "TimeoutError" ? "passou de 10 s sem resposta" : "não deu para conectar" };
  }
}

export async function limparAvisos(o, agora) {
  const s = o.ctx.storage;
  // A guarda segue o plano (worker/workspace-plano.js): 90 dias no Pro (e na carencia depois dele), 30 no gratuito.
  const dias = (await o.guardaDoPro(agora)) ? PLANOS_WS.pro.avisos_dias : PLANOS_WS.gratuito.avisos_dias;
  const corte = isoDe(agora - dias * DIA_S * 1000);
  const apps = new Set();
  for (const [k] of await s.list({ prefix: "avq:" })) apps.add(k.slice(4).split("|")[0]);
  let n = 0;
  for (const app of apps) n += await apagarAntigos(s, "avq:" + app + "|", corte);
  return n;
}

// ------------------------------------------------------------------ os ganchos (quem muda o acesso chama)

/* Um aviso ao sistema do aplicativo `app` ({id, dono: {sub}}). Nunca lanca: o aviso e o segundo lugar (a mudanca ja
   valeu). */
export async function avisar(env, app, tipo, dados, agora = Date.now()) {
  try {
    const c = app && app.dono && daConta(env, app.dono.sub);
    if (!c) return null;
    return await c.pedir("av_evento", { agora, app: app.id, tipo, dados });
  } catch {
    return null;
  }
}

/* O `sub` de quem tem o e-mail, so se essa pessoa ja permitiu o aplicativo (o sistema ja recebeu o sub). Senao, "". */
export async function subSeJaPermitiu(env, app, email) {
  const c = await kv(env, "id:conta:" + email);
  if (!c || !c.sub) return "";
  const apps = (await kv(env, "atos:apps:" + c.sub)) || {};
  const p = Object.prototype.hasOwnProperty.call(apps, app.id) ? apps[app.id] : null;
  if (!p || (app.criado && p.quando && p.quando < app.criado)) return "";
  return c.sub;
}

export async function avisarLista(env, app, tipo, emails, agora) {
  if (!env.WS_DADOS || !emails.length) return;
  const pessoas = [];
  for (const email of emails) {
    const sub = await subSeJaPermitiu(env, app, email).catch(() => "");
    pessoas.push(sub ? { email, sub } : { email });
  }
  await avisar(env, app, tipo, { pessoas }, agora);
}

// ------------------------------------------------------------------ as rotas do dono

/* `a`: o aplicativo do dono (ja conferido); `d`: o corpo (POST); deps.log(oque): o registro do aplicativo. */
export async function atenderAvisos(request, env, a, d, agora, deps = {}) {
  if (!env.WS_DADOS) return json({ erro: "os avisos ainda não estão ligados neste Worker" }, 503);
  const c = daConta(env, a.dono.sub);
  const log = deps.log || (async () => {});
  const P = deps.plano ? deps.plano.limites : PLANOS_WS.pro;
  const ver = async (extra = {}) => {
    const r = await c.pedir("av_ver", { agora, app: a.id, mostrar: P.avisos_mostrar, dias: P.avisos_dias });
    if (!r || !r.ok) return json({ erro: "não deu agora" }, 503);
    return json({ aviso: r.aviso, entregas: r.entregas, tipos: TIPOS_AVISO, limites: { ...LIMITES_AVISO, retencao_dias: P.avisos_dias, mostrar: P.avisos_mostrar }, reentregas_s: REENTREGAS_AVISO_S, ...extra });
  };
  if (request.method === "GET") return ver();
  const acao = String(d.acao || "");
  const falhou = (r) => json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
  if (acao === "salvar") {
    const u = conferirUrlExterna(d.url, { contexto: "o endereço do aviso" });
    if (u.erro) return json({ erro: u.erro }, 400);
    const segredo = "atos_av_" + aleatorio(32);
    const r = await c.pedir("av_salvar", { agora, app: a.id, url: u.url, segredo });
    if (!r || !r.ok) return falhou(r);
    await log(r.novo ? "cadastrou o aviso ao sistema em " + u.url : "trocou o endereço do aviso para " + u.url);
    return ver(r.novo ? { segredo } : {});
  }
  if (acao === "segredo") {
    if (d.confirmar !== true) return json({ erro: "confirme na página: o segredo anterior para de valer na hora" }, 400);
    const segredo = "atos_av_" + aleatorio(32);
    const r = await c.pedir("av_segredo", { agora, app: a.id, segredo });
    if (!r || !r.ok) return falhou(r);
    await log("trocou o segredo do aviso ao sistema");
    return ver({ segredo });
  }
  if (acao === "ligar" || acao === "desligar") {
    const r = await c.pedir("av_estado", { agora, app: a.id, ativo: acao === "ligar" });
    if (!r || !r.ok) return falhou(r);
    await log((acao === "ligar" ? "ligou" : "desligou") + " o aviso ao sistema");
    return ver();
  }
  if (acao === "apagar") {
    if (d.confirmar !== true) return json({ erro: "confirme na página: o endereço, o segredo e o registro das entregas são apagados" }, 400);
    await c.pedir("av_apagar", { app: a.id });
    await log("apagou o aviso ao sistema");
    return ver();
  }
  if (acao === "testar") {
    const r = await c.pedir("av_evento", { agora, app: a.id, tipo: "aviso.teste", dados: {} });
    if (!r || !r.ok) return falhou(r);
    if (!r.enfileirado) return json({ erro: r.limite ? "passou do limite de avisos de hoje" : "ligue o aviso (com o endereço cadastrado) para testar" }, 409);
    return ver({ testado: r.id });
  }
  if (acao === "reenviar") {
    const r = await c.pedir("av_reenviar", { agora, app: a.id, chave: d.entrega });
    if (!r || !r.ok) return falhou(r);
    return ver();
  }
  return json({ erro: "o que fazer com o aviso? (salvar, ligar, desligar, segredo, testar, reenviar ou apagar)" }, 400);
}

/* Para o painel e a tela: o resumo dos avisos dos aplicativos de um dono. */
export async function avisosDoDono(env, sub, apps) {
  if (!env.WS_DADOS || !apps.length) return {};
  try {
    const r = await daConta(env, sub).pedir("av_resumo", { apps });
    return r && r.ok ? r.avisos : {};
  } catch {
    return {};
  }
}

/* A equipe desliga os avisos de um aplicativo por abuso (com o motivo) ou liga de novo. */
export async function bloqueioDosAvisos(env, app, acao, motivo, quem, agora) {
  if (!env.WS_DADOS) return { status: 503, erro: "os avisos não estão neste Worker" };
  const bloqueado = acao === "desligar" ? { quando: isoDe(agora), motivo, por: quem.email } : null;
  const r = await daConta(env, app.dono.sub).pedir("av_bloqueio", { app: app.id, bloqueado });
  if (!r || !r.ok) return { status: (r && r.status) || 503, erro: (r && r.erro) || "não deu agora" };
  return { status: 200 };
}
