// Atos Workspace > Integracoes > Entradas: o registro dos logins em cada aplicativo de terceiro, para o dono ver, com
// filtro (o periodo, o resultado, a busca). Pelo plano (worker/workspace-plano.js): o gratuito guarda e mostra 7 dias; o
// Pro, 90 dias e exportar em CSV (depois do Pro, o que ja estava guardado fica a carencia e segue a guarda do gratuito).
//
// O que fica (so o que o aplicativo ja recebe, decisao de 12/10/2026):
//   "entrou"    a Atos emitiu o codigo de volta ao aplicativo (a pessoa entrou e permitiu): quando, o `sub` (o aplicativo
//               sempre o recebe, escopo openid), o e-mail so se o escopo email foi pedido e permitido, o nome so com o
//               profile; o lugar aproximado (cidade, estado e pais que a Cloudflare deduz do endereco de internet na hora;
//               o endereco em si nao fica) e o navegador resumido ("Chrome no Windows") - o aplicativo ve o mesmo
//               navegador chegando na volta.
//   "recusado"  a conta nao esta liberada no aplicativo (a Atos recusa antes de qualquer codigo): quando, o lugar e o
//               navegador, SEM o sub, o e-mail ou o nome - o aplicativo nao recebe nada de quem foi recusado, e o
//               registro nao diz quem tentou.
// "A pessoa nao permitiu" nao entra (o aplicativo ja recebe access_denied na volta).
//
// No objeto da conta do dono (worker/workspace-dados.js):
//   lg:<app>|<iso>|<r>   {quando, resultado, sub?, email?, nome?, onde, navegador}
//   lg-apps              [ids] os aplicativos com registro (a limpeza)
// Ate 2000 linhas por aplicativo por dia; passando disso, so a contagem do dia (a tela diz).
//
// Rotas (pela porta das Integracoes, worker/integracoes.js):
//   GET /api/integracoes/apps/:id/entradas?dias=7|30|90&resultado=entrou|recusado&q=      ate 500 linhas
//   GET /api/integracoes/apps/:id/entradas.csv?...                                         ate 20000 linhas
// O painel da equipe ve so as contagens das ultimas 24 horas de cada aplicativo (para notar um aplicativo de phishing
// enchendo de logins), nunca as linhas.

import { json } from "./comum.js";
import { ondeDe, navegadorDe } from "./seguranca/atividade.js";
import { apagarAntigos, apagarPrefixo, daConta, isoDe, sorteio } from "./workspace-dados.js";
import { PLANOS_WS, limiteDoPlano } from "./workspace-plano.js";

export const LIMITES_ENTRADAS = { retencao_dias: 90, por_dia: 2000, tela: 500, csv: 20000 };
const DIA_S = 86400;

export const OPS_ENTRADAS = {
  async lg_anotar(o, d, agora) {
    const s = o.ctx.storage;
    const dia = isoDe(agora).slice(0, 10);
    if (!(await o.contar("lgdia:" + d.app + ":" + dia, 2 * DIA_S, agora, LIMITES_ENTRADAS.por_dia))) {
      await o.contar("lgfora:" + d.app + ":" + dia, 2 * DIA_S, agora, Number.MAX_SAFE_INTEGER);
      return { ok: true, contado: true };
    }
    const apps = (await s.get("lg-apps")) || [];
    if (!apps.includes(d.app)) { apps.push(d.app); await s.put("lg-apps", apps); }
    const quando = isoDe(agora);
    const i = d.item || {};
    const linha = { quando, resultado: i.resultado === "entrou" ? "entrou" : "recusado", onde: String(i.onde || "").slice(0, 120), navegador: String(i.navegador || "").slice(0, 60) };
    if (linha.resultado === "entrou") {
      linha.sub = String(i.sub || "").slice(0, 120);
      if (i.email) linha.email = String(i.email).slice(0, 254);
      if (i.nome) linha.nome = String(i.nome).slice(0, 80);
    }
    await s.put("lg:" + d.app + "|" + quando + "|" + sorteio(), linha);
    return { ok: true };
  },
  async lg_listar(o, d, agora) {
    const s = o.ctx.storage;
    const dias = [7, 30, 90].includes(Number(d.dias)) ? Number(d.dias) : 30;
    const desde = isoDe(agora - dias * DIA_S * 1000);
    const q = String(d.q || "").trim().toLowerCase().slice(0, 120);
    const limite = Math.min(Number(d.limite) || LIMITES_ENTRADAS.tela, LIMITES_ENTRADAS.csv);
    const linhas = [];
    let total = 0;
    for (const [k, x] of await s.list({ prefix: "lg:" + d.app + "|", start: "lg:" + d.app + "|" + desde, reverse: true })) {
      if (k.slice(4 + d.app.length).split("|")[0] < desde) break;
      if (d.resultado && x.resultado !== d.resultado) continue;
      if (q && ![x.sub, x.email, x.nome, x.onde, x.navegador].some((v) => String(v || "").toLowerCase().includes(q))) continue;
      total++;
      if (linhas.length < limite) linhas.push(x);
    }
    const hoje = isoDe(agora).slice(0, 10);
    return { ok: true, linhas, total, dias, nao_registradas_hoje: await o.contagem("lgfora:" + d.app + ":" + hoje, agora) };
  },
  /* As contagens das ultimas 24 horas (o painel). */
  async lg_resumo(o, d, agora) {
    const s = o.ctx.storage;
    const desde = isoDe(agora - DIA_S * 1000);
    const r = {};
    for (const app of d.apps || []) {
      const c = { entrou: 0, recusado: 0 };
      for (const [k, x] of await s.list({ prefix: "lg:" + app + "|", start: "lg:" + app + "|" + desde, reverse: true })) {
        if (k.slice(4 + app.length).split("|")[0] < desde) break;
        c[x.resultado === "entrou" ? "entrou" : "recusado"]++;
      }
      r[app] = c;
    }
    return { ok: true, resumo: r };
  },
  async lg_apagar(o, d) {
    const s = o.ctx.storage;
    await apagarPrefixo(s, "lg:" + d.app + "|");
    const apps = ((await s.get("lg-apps")) || []).filter((x) => x !== d.app);
    await s.put("lg-apps", apps);
    return { ok: true };
  },
};

export async function limparEntradas(o, agora) {
  const s = o.ctx.storage;
  // A guarda segue o plano (worker/workspace-plano.js): 90 dias no Pro (e na carencia depois dele), 7 no gratuito.
  const dias = (await o.guardaDoPro(agora)) ? PLANOS_WS.pro.entradas_dias : PLANOS_WS.gratuito.entradas_dias;
  const corte = isoDe(agora - dias * DIA_S * 1000);
  let n = 0;
  for (const app of (await s.get("lg-apps")) || []) n += await apagarAntigos(s, "lg:" + app + "|", corte);
  return n;
}

// ------------------------------------------------------------------ o gancho (o login, worker/oidc.js)

/* Anota uma entrada num aplicativo de terceiro (`app`: o do registro do fluxo, com terceiro e dono). Nunca lanca: o
   login nao espera o registro dar certo. */
export async function anotarEntrada(env, appId, app, request, { resultado, sessao, escopos = [] }, agora = Date.now()) {
  if (!env.WS_DADOS || !app || !app.terceiro || !app.dono || !app.dono.sub) return;
  const item = { resultado, onde: ondeDe(request), navegador: navegadorDe(request.headers.get("user-agent")) };
  if (resultado === "entrou" && sessao) {
    item.sub = sessao.sub;
    if (escopos.includes("email")) item.email = sessao.email;
    if (escopos.includes("profile") && sessao.nome) item.nome = sessao.nome;
  }
  try {
    await daConta(env, app.dono.sub).pedir("lg_anotar", { agora, app: appId, item });
  } catch {
    // o registro e o segundo lugar
  }
}

// ------------------------------------------------------------------ as rotas do dono

const celula = (v) => {
  let t = String(v == null ? "" : v);
  // Contra a injecao de formula ao abrir o CSV numa planilha.
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

export async function atenderEntradas(request, env, a, url, agora, plano) {
  if (!env.WS_DADOS) return json({ erro: "o registro de entradas ainda não está ligado neste Worker" }, 503);
  const csv = url.pathname.endsWith(".csv");
  // O plano (worker/workspace-plano.js): o gratuito ve os ultimos 7 dias, o Pro ate 90; exportar CSV e do Pro.
  const P = plano ? plano.limites : PLANOS_WS.pro;
  if (csv && !P.entradas_csv) return limiteDoPlano("exportar o registro de entradas em CSV é do Atos Workspace Pro", plano);
  const pedidos = Number(url.searchParams.get("dias")) || 30;
  const dias = Math.min([7, 30, 90].includes(pedidos) ? pedidos : 30, P.entradas_dias);
  const resultado = ["entrou", "recusado"].includes(url.searchParams.get("resultado")) ? url.searchParams.get("resultado") : "";
  const r = await daConta(env, a.dono.sub).pedir("lg_listar", {
    agora, app: a.id, dias, resultado, q: url.searchParams.get("q") || "", limite: csv ? LIMITES_ENTRADAS.csv : LIMITES_ENTRADAS.tela,
  });
  if (!r || !r.ok) return json({ erro: "não deu para ler as entradas agora" }, 503);
  if (!csv) return json({ linhas: r.linhas, total: r.total, dias: r.dias, nao_registradas_hoje: r.nao_registradas_hoje, limites: { ...LIMITES_ENTRADAS, dias_max: P.entradas_dias, csv_permitido: P.entradas_csv } });
  const linhas = [["quando", "resultado", "sub", "email", "nome", "onde", "navegador"].join(",")];
  for (const x of r.linhas) linhas.push([x.quando, x.resultado, x.sub, x.email, x.nome, x.onde, x.navegador].map(celula).join(","));
  return new Response("﻿" + linhas.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
      "content-disposition": 'attachment; filename="entradas-' + a.id + "-" + isoDe(agora).slice(0, 10) + '.csv"',
    },
  });
}

/* Para o painel: as contagens das ultimas 24 horas dos aplicativos de um dono. */
export async function entradasDoDono(env, sub, apps) {
  if (!env.WS_DADOS || !apps.length) return {};
  try {
    const r = await daConta(env, sub).pedir("lg_resumo", { apps });
    return r && r.ok ? r.resumo : {};
  } catch {
    return {};
  }
}
