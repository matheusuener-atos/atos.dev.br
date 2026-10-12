// Atos Workspace > Status (atos.dev.br/workspace/status; a tela e public/assets/workspace-status.js): a pagina de status do
// sistema do dono. Pelo plano (worker/workspace-plano.js): no gratuito, 1 endereco https conferido a cada 15 minutos; no
// Pro, ate 10 a cada minuto e o aviso por e-mail. A Atos publica, se ele quiser,
// uma pagina simples em atos.dev.br/status/<nome>: no ar / instavel / fora, o tempo de resposta e o historico de 30 ou
// 90 dias. No Pro: um aviso por e-mail ao destino do alias do dono quando um endereco cai (duas conferencias seguidas
// fora) e quando volta. A capacidade: STATUS_POR_MINUTO contas por minuto (padrao 10, ate 50); com mais contas vencidas
// do que isso, a agenda atrasa (o painel mostra), e o intervalo de 1 minuto do Pro vira "o mais cedo que a fila deixar".
//
// A conferencia: GET ao endereco, sem seguir redirecionamento (um 3xx conta como no ar), 10 s no maximo, sem ler o
// corpo, com o User-Agent "AtosStatus/1". 2xx e 3xx: no ar (acima de 3 s: lento); 4xx, 5xx, erro de conexao ou tempo
// esgotado: fora. Os enderecos passam por worker/url-externa.js (so https publico, sem IP, localhost, rede interna nem a
// propria Atos) - a Atos nao vira uma ferramenta para sondar rede de ninguem.
//
// Quem confere: o Cron de cada minuto (worker/index.js, scheduled -> conferirStatus). Ele pede ao objeto "indice" as contas
// vencidas (a agenda; no maximo STATUS_POR_MINUTO por minuto, padrao 10, as mais atrasadas primeiro) e chama o objeto de
// cada conta, que confere os enderecos dela em paralelo (5 no maximo). Um minuto sai com 1 + 10 pedidos aos objetos e os
// e-mails de aviso; os pedidos aos enderecos saem dos objetos (cada um com o proprio limite). Escalonado: cada conta volta
// a agenda 5 minutos depois da propria conferencia. Mais contas do que cabem atrasa a conferencia (o painel mostra o
// atraso), nunca estoura o limite do Cron.
//
// Os dados (worker/workspace-dados.js). No objeto da conta:
//   st:cfg                 {nome, titulo, publica, avisar, enderecos: [{id, nome, url}], criado, mudado, bloqueado}
//   st:ult:<eid>           {estado: "ok"|"lento"|"fora", desde, ultima, ms, codigo, seguidas_fora, caiu}
//   st:rec:<eid>           as ultimas 48 conferencias [{t, r, ms}] (4 horas)
//   st:dia:<eid>|<dia>     {n, ok, lento, fora, ms} por dia (90 dias)
//   st:evt|<iso>|<r>       {quando, eid, nome, oque: "caiu"|"voltou"} (90 dias)
// No objeto "indice":
//   spag:<nome>            {sub, conta, criado, bloqueado} (a pagina publica acha o dono; o painel lista)
//   sag:<sub>              {proxima, ultima} a agenda das conferencias
//
// Rotas do dono (a porta das Integracoes; mudar pede login das ultimas 12 horas):
//   GET  /api/workspace/status          a configuracao, o estado de cada endereco e os acontecimentos
//   POST /api/workspace/status          {acao: salvar {nome, titulo, publica, avisar, enderecos} | apagar {confirmar}}
// Publica:
//   GET  /status/<nome>[?dias=30|90]    a pagina (sem script; 60 s de cache)
// Painel da equipe (worker/admin-workspace.js): ver todas e o atraso da agenda; desligar e ligar de novo por abuso.

import { json, lerJson } from "./comum.js";
import { portaoDoWorkspace } from "./workspace.js";
import { destinoDoTitular } from "./email-atos.js";
import { enviarEmail as enviarPadrao } from "./email.js";
import { apagarAntigos, apagarPrefixo, daConta, doIndice, isoDe, sorteio } from "./workspace-dados.js";
import { conferirUrlExterna } from "./url-externa.js";
import { PLANOS_WS, limiteDoPlano, planoDe, vistaDoPlano } from "./workspace-plano.js";
import { workspaceDe } from "./workspace.js";

// `enderecos` e o teto tecnico (o do Pro); o intervalo, quantos enderecos e o aviso por e-mail vem do plano
// (worker/workspace-plano.js: gratuito 1 endereco a cada 15 minutos, sem e-mail; Pro ate 10 a cada 1 minuto, com e-mail).
// `intervalo_min` e o padrao da agenda quando ela ainda nao sabe o plano da conta (o do gratuito).
export const LIMITES_STATUS = {
  enderecos: 10, intervalo_min: 15, tempo_ms: 10000, lento_ms: 3000, historico_dias: 90, recentes: 48, avisos_dia: 10, recente_h: 12,
};
const DIA_S = 86400;
const RECENTE_S = LIMITES_STATUS.recente_h * 3600;
export const porMinuto = (env) => Math.max(1, Math.min(50, Number(env && env.STATUS_POR_MINUTO) || 10));
const diaDe = (ms) => isoDe(ms - 3 * 3600 * 1000).slice(0, 10);
const RESERVADOS = new Set(["atos", "admin", "api", "status", "workspace", "conta", "entrar", "pavlvs", "paulus", "teste", "exemplo", "www", "suporte", "contato", "oficial"]);
const limparTexto = (t, max) => String(t == null ? "" : t).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/* A configuracao: {cfg} ou {erro} (com codigo "limite_do_plano" quando passa do plano). `antes`: a guardada (os ids dos
   enderecos que ficam). `plano`: os limites do plano (worker/workspace-plano.js); sem ele, os do Pro. Quem voltou ao
   gratuito com mais enderecos do que ele permite pode salvar sem acrescentar (os que passam ficam sem conferencia). */
export function conferirStatus(d, antes, plano) {
  const P = plano ? plano.limites : PLANOS_WS.pro;
  const nome = String(d.nome || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/.test(nome)) return { erro: "o nome da página: de 3 a 30 letras minúsculas, números e hífen (vira atos.dev.br/status/<nome>)" };
  if (RESERVADOS.has(nome) || /atos|pavlvs|paulus/.test(nome)) return { erro: "esse nome é reservado: escolha outro" };
  const titulo = limparTexto(d.titulo, 60) || nome;
  const lista = Array.isArray(d.enderecos) ? d.enderecos : [];
  if (!lista.length) return { erro: "cadastre pelo menos um endereço" };
  if (lista.length > LIMITES_STATUS.enderecos) return { erro: "no máximo " + LIMITES_STATUS.enderecos + " endereços" };
  const tinha = ((antes && antes.enderecos) || []).length;
  if (lista.length > P.status_enderecos && lista.length > tinha) {
    return { codigo: "limite_do_plano", erro: "no plano " + (P.id === "pro" ? "Pro" : "gratuito") + ", a página confere até " + P.status_enderecos + (P.status_enderecos === 1 ? " endereço" : " endereços") };
  }
  const querAvisar = d.avisar === true;
  if (querAvisar && !P.status_email && !(antes && antes.avisar)) return { codigo: "limite_do_plano", erro: "o aviso de queda por e-mail é do Atos Workspace Pro" };
  const enderecos = [];
  const velhos = new Map(((antes && antes.enderecos) || []).map((e) => [e.url, e.id]));
  for (const e of lista) {
    const u = conferirUrlExterna(e && e.url, { contexto: "o endereço" });
    if (u.erro) return { erro: u.erro };
    if (enderecos.some((x) => x.url === u.url)) return { erro: "o mesmo endereço duas vezes" };
    const n = limparTexto(e.nome, 40) || new URL(u.url).hostname;
    enderecos.push({ id: velhos.get(u.url) || "e" + sorteio(4), nome: n, url: u.url });
  }
  return { cfg: { nome, titulo, publica: d.publica !== false, avisar: d.avisar === true, enderecos } };
}

// ------------------------------------------------------------------ o objeto

/* Uma conferencia (no objeto da conta). */
async function conferirUm(e, buscar) {
  const t0 = Date.now();
  try {
    const r = await buscar(e.url, { method: "GET", redirect: "manual", headers: { "user-agent": "AtosStatus/1 (+https://atos.dev.br/integracao/#status)" }, signal: AbortSignal.timeout(LIMITES_STATUS.tempo_ms) });
    const ms = Date.now() - t0;
    try { if (r.body) await r.body.cancel(); } catch { /* sem corpo */ }
    const up = r.status >= 200 && r.status < 400;
    return { r: up ? (ms > LIMITES_STATUS.lento_ms ? "lento" : "ok") : "fora", ms, codigo: r.status };
  } catch (x) {
    return { r: "fora", ms: Date.now() - t0, codigo: 0, motivo: x && x.name === "TimeoutError" ? "tempo" : "conexao" };
  }
}

export const OPS_STATUS = {
  async st_ver(o, d, agora) {
    const s = o.ctx.storage;
    const cfg = (await s.get("st:cfg")) || null;
    const estados = {};
    if (cfg) for (const e of cfg.enderecos) estados[e.id] = { ult: (await s.get("st:ult:" + e.id)) || null, recentes: (await s.get("st:rec:" + e.id)) || [] };
    const eventos = [...(await s.list({ prefix: "st:evt|", reverse: true, limit: 30 })).values()];
    return { ok: true, cfg, estados, eventos };
  },
  async st_salvar(o, d, agora) {
    const s = o.ctx.storage;
    const antes = await s.get("st:cfg");
    if (antes && antes.bloqueado) return { ok: false, status: 403, erro: "a Atos desligou esta página de status" + (antes.bloqueado.motivo ? " (" + antes.bloqueado.motivo + ")" : "") + ": escreva para contato@atos.dev.br" };
    if (!(await o.contar("stmud", 3600, agora, 30))) return { ok: false, status: 429, erro: "muitas mudanças na última hora: espere um pouco" };
    const cfg = { ...d.cfg, criado: (antes && antes.criado) || isoDe(agora), mudado: antes ? isoDe(agora) : null, bloqueado: null };
    // O historico de um endereco que saiu vai junto.
    for (const e of (antes && antes.enderecos) || []) if (!cfg.enderecos.some((x) => x.id === e.id)) await apagarEndereco(s, e.id);
    await s.put("st:cfg", cfg);
    return { ok: true, cfg, nome_antes: antes ? antes.nome : "" };
  },
  async st_apagar(o) {
    const s = o.ctx.storage;
    const cfg = await s.get("st:cfg");
    for (const e of (cfg && cfg.enderecos) || []) await apagarEndereco(s, e.id);
    await apagarPrefixo(s, "st:evt|");
    await s.delete("st:cfg");
    return { ok: true, nome: cfg ? cfg.nome : "" };
  },
  async st_bloqueio(o, d) {
    const s = o.ctx.storage;
    const cfg = await s.get("st:cfg");
    if (!cfg) return { ok: false, status: 404, erro: "essa página não existe (mais)" };
    cfg.bloqueado = d.bloqueado || null;
    await s.put("st:cfg", cfg);
    return { ok: true };
  },
  /* A conferencia de todos os enderecos da conta (o Cron). Devolve os avisos a mandar ({oque, nome, url}) quando o dono
     pediu, ate 10 por dia. */
  async st_conferir(o, d, agora) {
    const s = o.ctx.storage;
    const cfg = await s.get("st:cfg");
    if (!cfg || cfg.bloqueado) return { ok: true, conferidos: 0, avisos: [] };
    const buscar = (u, i) => fetch(u, i);
    // So os enderecos do plano (os primeiros, ate `max`); o aviso por e-mail so com `email` (o Pro).
    const lista = cfg.enderecos.slice(0, d.max === undefined ? cfg.enderecos.length : Math.max(0, Number(d.max)));
    const res = await Promise.all(lista.map((e) => conferirUm(e, buscar)));
    const avisos = [];
    const comEmail = d.email === undefined ? true : Boolean(d.email);
    for (let i = 0; i < lista.length; i++) {
      const e = lista[i], x = res[i];
      const ult = (await s.get("st:ult:" + e.id)) || { estado: null, desde: null, seguidas_fora: 0, caiu: false };
      if (ult.estado !== x.r) { ult.estado = x.r; ult.desde = isoDe(agora); }
      ult.ultima = isoDe(agora); ult.ms = x.ms; ult.codigo = x.codigo;
      ult.seguidas_fora = x.r === "fora" ? (ult.seguidas_fora || 0) + 1 : 0;
      let oque = "";
      if (x.r === "fora" && ult.seguidas_fora >= 2 && !ult.caiu) { ult.caiu = true; oque = "caiu"; }
      if (x.r !== "fora" && ult.caiu) { ult.caiu = false; oque = "voltou"; }
      await s.put("st:ult:" + e.id, ult);
      const rec = ((await s.get("st:rec:" + e.id)) || []).concat([{ t: isoDe(agora), r: x.r, ms: x.ms, c: x.codigo }]).slice(-LIMITES_STATUS.recentes);
      await s.put("st:rec:" + e.id, rec);
      const kd = "st:dia:" + e.id + "|" + diaDe(agora);
      const dia = (await s.get(kd)) || { n: 0, ok: 0, lento: 0, fora: 0, ms: 0 };
      dia.n++; dia[x.r]++; if (x.r !== "fora") dia.ms += x.ms;
      await s.put(kd, dia);
      if (oque) {
        await s.put("st:evt|" + isoDe(agora) + "|" + sorteio(), { quando: isoDe(agora), eid: e.id, nome: e.nome, oque, codigo: x.codigo });
        if (cfg.avisar && comEmail && (await o.contar("stmail:" + diaDe(agora), 2 * DIA_S, agora, LIMITES_STATUS.avisos_dia))) avisos.push({ oque, nome: e.nome, url: e.url, codigo: x.codigo });
      }
    }
    await o.marcarLimpeza(agora);
    return { ok: true, conferidos: res.length, avisos, titulo: cfg.titulo, nome: cfg.nome };
  },
  /* O que a pagina publica mostra (sem os enderecos). */
  async st_publico(o, d, agora) {
    const s = o.ctx.storage;
    const cfg = await s.get("st:cfg");
    if (!cfg || cfg.bloqueado || !cfg.publica) return { ok: true, pagina: null };
    const dias = d.dias === 90 ? 90 : 30;
    const lista = [];
    // So os enderecos do plano: os que passam dele nao sao conferidos e nao aparecem.
    for (const e of cfg.enderecos.slice(0, d.max === undefined ? cfg.enderecos.length : Math.max(0, Number(d.max)))) {
      const porDia = [];
      for (let i = dias - 1; i >= 0; i--) {
        const dd = diaDe(agora - i * DIA_S * 1000);
        porDia.push({ dia: dd, ...((await s.get("st:dia:" + e.id + "|" + dd)) || { n: 0 }) });
      }
      lista.push({ nome: e.nome, ult: (await s.get("st:ult:" + e.id)) || null, dias: porDia });
    }
    const eventos = [...(await s.list({ prefix: "st:evt|", reverse: true, limit: 10 })).values()].map((x) => ({ quando: x.quando, nome: x.nome, oque: x.oque }));
    return { ok: true, pagina: { titulo: cfg.titulo, nome: cfg.nome, enderecos: lista, eventos, dias, intervalo_min: Number(d.intervalo) || LIMITES_STATUS.intervalo_min } };
  },

  // ---- o indice
  async spag_reservar(o, d, agora) {
    const s = o.ctx.storage;
    const x = await s.get("spag:" + d.nome);
    if (x && x.sub !== d.sub) return { ok: false };
    await s.put("spag:" + d.nome, { sub: d.sub, conta: d.conta || "", criado: (x && x.criado) || isoDe(agora), bloqueado: (x && x.bloqueado) || null });
    return { ok: true };
  },
  async spag_soltar(o, d) {
    const s = o.ctx.storage;
    const x = await s.get("spag:" + d.nome);
    if (x && (!d.sub || x.sub === d.sub)) await s.delete("spag:" + d.nome);
    return { ok: true };
  },
  async spag_dono(o, d) {
    return { ok: true, dono: (await o.ctx.storage.get("spag:" + d.nome)) || null };
  },
  async spag_bloqueio(o, d) {
    const s = o.ctx.storage;
    const x = await s.get("spag:" + d.nome);
    if (!x) return { ok: false, status: 404, erro: "essa página não existe (mais)" };
    x.bloqueado = d.bloqueado || null;
    await s.put("spag:" + d.nome, x);
    return { ok: true, linha: x };
  },
  async sag_marcar(o, d, agora) {
    const s = o.ctx.storage;
    if (d.tirar) { await s.delete("sag:" + d.sub); return { ok: true }; }
    const x = (await s.get("sag:" + d.sub)) || { ultima: null };
    if (d.proxima !== undefined || !x.proxima) x.proxima = d.proxima ?? agora;
    // O intervalo do plano da conta (o Cron confere a cada `intervalo` minutos).
    if (d.intervalo) {
      const antes = x.intervalo || LIMITES_STATUS.intervalo_min;
      x.intervalo = Math.max(1, Math.min(60, Number(d.intervalo)));
      // Diminuiu (virou Pro): a proxima conferencia nao espera o intervalo antigo.
      if (x.intervalo < antes && x.ultima) x.proxima = Math.min(x.proxima, Date.parse(x.ultima) + x.intervalo * 60000);
    }
    await s.put("sag:" + d.sub, x);
    return { ok: true };
  },
  /* As contas vencidas, as mais atrasadas primeiro; ja ficam marcadas para daqui a `intervalo` minutos (o do plano de
     cada conta; se a conferencia falhar, a conta volta na vez seguinte, sem repetir no mesmo minuto). */
  async sag_vencidos(o, d, agora) {
    const s = o.ctx.storage;
    const vencidos = [];
    for (const [k, x] of await s.list({ prefix: "sag:" })) if (x.proxima <= agora) vencidos.push([k, x]);
    vencidos.sort((a, b) => a[1].proxima - b[1].proxima);
    const escolhidos = vencidos.slice(0, d.limite || 10);
    for (const [k, x] of escolhidos) {
      const intervalo = x.intervalo || LIMITES_STATUS.intervalo_min;
      await s.put(k, { proxima: agora + intervalo * 60000, ultima: isoDe(agora), atraso_s: Math.round((agora - x.proxima) / 1000), intervalo });
    }
    return { ok: true, subs: escolhidos.map(([k]) => k.slice(4)), intervalos: Object.fromEntries(escolhidos.map(([k, x]) => [k.slice(4), x.intervalo || LIMITES_STATUS.intervalo_min])), restantes: vencidos.length - escolhidos.length };
  },
  async spag_painel(o, d, agora) {
    const s = o.ctx.storage;
    const agenda = {};
    let atrasadas = 0, maior = 0;
    for (const [k, x] of await s.list({ prefix: "sag:" })) {
      agenda[k.slice(4)] = x;
      if (x.proxima < agora - 60000) { atrasadas++; maior = Math.max(maior, agora - x.proxima); }
    }
    const paginas = [];
    for (const [k, x] of await s.list({ prefix: "spag:" })) paginas.push({ nome: k.slice(5), ...x, agenda: agenda[x.sub] || null });
    return { ok: true, paginas, agenda: { contas: Object.keys(agenda).length, atrasadas, maior_atraso_s: Math.round(maior / 1000) } };
  },
};

async function apagarEndereco(s, eid) {
  await s.delete("st:ult:" + eid);
  await s.delete("st:rec:" + eid);
  await apagarPrefixo(s, "st:dia:" + eid + "|");
}

export async function limparStatus(o, agora) {
  const s = o.ctx.storage;
  const cfg = await s.get("st:cfg");
  let n = 0;
  const dia = diaDe(agora - LIMITES_STATUS.historico_dias * DIA_S * 1000);
  for (const e of (cfg && cfg.enderecos) || []) n += await apagarAntigos(s, "st:dia:" + e.id + "|", dia);
  n += await apagarAntigos(s, "st:evt|", isoDe(agora - LIMITES_STATUS.historico_dias * DIA_S * 1000));
  return n;
}

// ------------------------------------------------------------------ o Cron

/* Um minuto do Cron: as contas vencidas da agenda, a conferencia de cada uma e os avisos por e-mail. */
export async function conferirStatusAgendado(env, deps = {}) {
  if (!env.WS_DADOS) return { contas: 0 };
  const agora = (deps.agora || Date.now)();
  const enviar = deps.enviarEmail || enviarPadrao;
  const v = await doIndice(env).pedir("sag_vencidos", { agora, limite: porMinuto(env) });
  if (!v || !v.ok) return { contas: 0 };
  let emails = 0;
  await Promise.all(v.subs.map(async (sub) => {
    // O plano da conta (worker/workspace-plano.js): quantos enderecos, o aviso por e-mail e o intervalo. Sem o registro do
    // cliente agora, vale o gratuito nesta vez.
    let P = PLANOS_WS.gratuito;
    try { P = planoDe(await workspaceDe(env, sub), agora).limites; } catch { /* o gratuito */ }
    const antes = (v.intervalos && v.intervalos[sub]) || LIMITES_STATUS.intervalo_min;
    if (antes !== P.status_intervalo_min) {
      try { await doIndice(env).pedir("sag_marcar", { agora, sub, intervalo: P.status_intervalo_min, ...(P.status_intervalo_min > antes ? { proxima: agora + P.status_intervalo_min * 60000 } : {}) }); } catch { /* na proxima vez */ }
    }
    let r;
    try { r = await daConta(env, sub).pedir("st_conferir", { agora, max: P.status_enderecos, email: P.status_email }); } catch { return; }
    if (!r || !r.ok || !r.avisos || !r.avisos.length) return;
    let destino;
    try { destino = await destinoDoTitular(env, sub); } catch { return; }
    if (!destino.pronto) return;
    for (const a of r.avisos) {
      const caiu = a.oque === "caiu";
      const x = await enviar(env, {
        para: destino.destino,
        assunto: (caiu ? "Fora do ar: " : "De volta: ") + a.nome + " (" + r.titulo + ")",
        titulo: caiu ? a.nome + " está fora do ar" : a.nome + " voltou",
        texto: (caiu ? "A Atos conferiu " + a.url + " duas vezes seguidas e não teve resposta boa (" + (a.codigo ? "o servidor respondeu " + a.codigo : "sem resposta em 10 segundos ou erro de conexão") + ")."
          : "A Atos conferiu " + a.url + " de novo e ele respondeu.") +
          "\n\nA página de status: https://atos.dev.br/status/" + r.nome + "\n\nVocê recebe este aviso porque o ligou em Atos Workspace › Status (" + destino.endereco + "). No máximo " + LIMITES_STATUS.avisos_dia + " avisos por dia.",
      });
      if (x && x.ok) emails++;
    }
  }));
  return { contas: v.subs.length, restantes: v.restantes, emails };
}

// ------------------------------------------------------------------ as rotas do dono

export function ehRotaDoStatus(url) {
  return url.pathname === "/api/workspace/status";
}

export async function atenderStatus(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  if (!env.WS_DADOS) return json({ erro: "a página de status ainda não está ligada neste Worker" }, 503);
  const porta = await portaoDoWorkspace(request, env);
  if (porta.resposta) return porta.resposta;
  const { sessao, alias, plano } = porta;
  const P = plano.limites;
  const conta = daConta(env, sessao.sub);
  const indice = doIndice(env);
  const recente = agora / 1000 - sessao.auth_time < RECENTE_S;
  const tela = async (extra = {}) => {
    const r = await conta.pedir("st_ver", { agora });
    if (!r || !r.ok) return json({ erro: "não deu agora" }, 503);
    // Os enderecos fora do plano (os que passam de P.status_enderecos): guardados, sem conferencia.
    const fora = r.cfg ? r.cfg.enderecos.slice(P.status_enderecos).map((e) => e.id) : [];
    return json({
      ...r, ok: undefined, limites: { ...LIMITES_STATUS, enderecos: P.status_enderecos, intervalo_min: P.status_intervalo_min, email: P.status_email },
      plano: vistaDoPlano(plano), fora_do_plano: fora, recente, email_atos: alias.alias.endereco, base: url.origin + "/status/", ...extra,
    });
  };
  try {
    if (request.method === "GET") return await tela();
    if (request.method !== "POST") return json({ erro: "use POST" }, 405);
    if (!recente) return json({ erro: "para mudar a página de status, entre de novo (o login precisa ser das últimas " + LIMITES_STATUS.recente_h + " horas)", reentrar: true }, 401);
    const d = await lerJson(request);
    if (!d || typeof d !== "object" || Array.isArray(d)) return json({ erro: "pedido inválido" }, 400);
    if (d.acao === "apagar") {
      if (d.confirmar !== true) return json({ erro: "confirme na página: a página sai do ar e o histórico é apagado" }, 400);
      const r = await conta.pedir("st_apagar", {});
      if (r && r.nome) await indice.pedir("spag_soltar", { nome: r.nome, sub: sessao.sub });
      await indice.pedir("sag_marcar", { sub: sessao.sub, tirar: true });
      return await tela();
    }
    if (d.acao !== "salvar") return json({ erro: "o que fazer? (salvar ou apagar)" }, 400);
    const atual = await conta.pedir("st_ver", { agora });
    const c = conferirStatus(d, atual && atual.cfg, plano);
    if (c.erro) return c.codigo ? limiteDoPlano(c.erro, plano) : json({ erro: c.erro }, 400);
    if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
    const res = await indice.pedir("spag_reservar", { agora, nome: c.cfg.nome, sub: sessao.sub, conta: sessao.email });
    if (!res || !res.ok) return json({ erro: "esse nome já é de outra página: escolha outro" }, 409);
    const r = await conta.pedir("st_salvar", { agora, cfg: c.cfg });
    if (!r || !r.ok) {
      if (!(atual && atual.cfg && atual.cfg.nome === c.cfg.nome)) await indice.pedir("spag_soltar", { nome: c.cfg.nome, sub: sessao.sub });
      return json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
    }
    if (r.nome_antes && r.nome_antes !== c.cfg.nome) await indice.pedir("spag_soltar", { nome: r.nome_antes, sub: sessao.sub });
    // A primeira conferencia no proximo minuto do Cron, e depois no intervalo do plano.
    await indice.pedir("sag_marcar", { agora, sub: sessao.sub, proxima: agora, intervalo: P.status_intervalo_min });
    return await tela({ salvo: true });
  } catch {
    return json({ erro: "não deu para falar com o registro do Workspace agora: tente de novo em instantes" }, 503);
  }
}

// ------------------------------------------------------------------ a pagina publica

export function ehRotaDaPaginaDeStatus(url) {
  return /^\/status\/[^/]+\/?$/.test(url.pathname);
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CSP_STATUS = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const quando = (iso) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const ROTULO = { ok: "No ar", lento: "Instável (lento)", fora: "Fora do ar" };

function classeDoDia(x) {
  if (!x.n) return "";
  const bons = (x.ok || 0) + (x.lento || 0);
  if (x.fora === 0 && x.lento <= x.n * 0.1) return "e-ok";
  return bons / x.n >= 0.9 ? "e-instavel" : "e-fora";
}

function paginaHtml(p, agora, status = 200) {
  const atual = (u) => (!u || !u.ultima || agora - Date.parse(u.ultima) > ((p.intervalo_min || LIMITES_STATUS.intervalo_min) * 2 + 5) * 60000 ? "" : u.estado);
  const estados = p.enderecos.map((e) => atual(e.ult));
  // As classes com "e-": a .ok de conta.css esconde o que esta vazio.
  const geral = estados.every((x) => !x) ? ["", "Sem conferência recente"]
    : estados.every((x) => x === "ok") ? ["e-ok", "Tudo no ar"] : estados.every((x) => x === "fora") ? ["e-fora", "Fora do ar"] : ["e-instavel", "Instável"];
  const itens = p.enderecos.map((e, i) => {
    const est = estados[i];
    const conferidos = e.dias.reduce((s, d) => s + (d.n || 0), 0);
    const bons = e.dias.reduce((s, d) => s + (d.ok || 0) + (d.lento || 0), 0);
    const pct = conferidos ? (Math.floor((bons / conferidos) * 10000) / 100).toLocaleString("pt-BR") + "% no ar em " + p.dias + " dias" : "sem histórico ainda";
    const barras = e.dias.map((d) => {
      const c = classeDoDia(d);
      const t = d.dia.split("-").reverse().join("/") + (d.n ? ": " + Math.round((((d.ok || 0) + (d.lento || 0)) / d.n) * 100) + "% no ar" : ": sem conferência");
      return '<span class="' + c + '" title="' + esc(t) + '"></span>';
    }).join("");
    return '<div class="st-item"><div class="st-topo"><span><span class="st-ponto ' + (est === "ok" ? "e-ok" : est === "lento" ? "e-instavel" : est === "fora" ? "e-fora" : "") + '"></span> ' + esc(e.nome) + "</span>" +
      "<small>" + (est ? esc(ROTULO[est]) + (e.ult.ms && est !== "fora" ? " · " + e.ult.ms + " ms" : "") + " · conferido " + esc(quando(e.ult.ultima)) : "sem conferência recente") + "</small></div>" +
      '<div class="st-barras' + (p.dias === 90 ? " st-90" : "") + '" role="img" aria-label="' + esc(pct) + '">' + barras + "</div>" +
      '<div class="st-legenda"><span>' + p.dias + " dias atrás</span><span>" + esc(pct) + "</span><span>hoje</span></div></div>";
  }).join("");
  const eventos = p.eventos.length ? '<h2 class="titulo-secao">Acontecimentos</h2><div class="card"><ul class="st-eventos">' +
    p.eventos.map((x) => "<li>" + esc(quando(x.quando)) + " · " + esc(x.nome) + (x.oque === "caiu" ? " ficou fora do ar" : " voltou") + "</li>").join("") + "</ul></div>" : "";
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + esc(p.titulo) + " · Status</title><link rel=\"icon\" href=\"/assets/favicon.svg\" type=\"image/svg+xml\">" +
    '<link rel="stylesheet" href="/assets/conta.css"><link rel="stylesheet" href="/assets/publico.css"></head><body>' +
    '<main class="pub"><p class="pub-marca">' + esc(p.titulo) + "</p><h1>Status</h1>" +
    '<div class="card st-geral"><span class="st-ponto ' + geral[0] + '"></span> ' + esc(geral[1]) + "</div>" +
    '<nav class="st-periodo" aria-label="Período"><a href="?dias=30"' + (p.dias === 30 ? ' aria-current="page"' : "") + '>30 dias</a><a href="?dias=90"' + (p.dias === 90 ? ' aria-current="page"' : "") + ">90 dias</a></nav>" +
    '<div class="card">' + itens + "</div>" + eventos +
    '<p class="nota pub-pe">A Atos confere cada endereço a cada ' + (p.intervalo_min === 1 ? "minuto" : p.intervalo_min + " minutos") + ' (no ar: respondeu em até 10 segundos, sem erro; lento: acima de 3 segundos). Página mantida por quem cuida deste sistema, no Atos Workspace. <a href="/integracao/#status">O que é</a> · <a href="/privacidade/">Privacidade</a></p>' +
    "</main></body></html>";
  return new Response(html, {
    status, headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "content-security-policy": CSP_STATUS, "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=31536000",
    },
  });
}

function naoEncontrada() {
  return new Response('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Página de status não encontrada · Atos</title>' +
    '<link rel="stylesheet" href="/assets/conta.css"><link rel="stylesheet" href="/assets/publico.css"></head><body><main class="pub"><p class="pub-marca">Atos</p><h1>Página de status não encontrada</h1>' +
    '<p class="pub-texto">Não há uma página de status pública com este endereço.</p></main></body></html>', {
    status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "content-security-policy": CSP_STATUS, "x-content-type-options": "nosniff", "x-frame-options": "DENY" },
  });
}

export async function atenderPaginaDeStatus(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const nome = url.pathname.split("/")[2].toLowerCase();
  if (!/^[a-z0-9-]{3,30}$/.test(nome) || !env.WS_DADOS) return naoEncontrada();
  const dias = url.searchParams.get("dias") === "90" ? 90 : 30;
  // 60 s no cache da Cloudflare (a mesma pagina para todos): o objeto nao e consultado a cada visita.
  const cache = deps.cache === undefined ? (typeof caches !== "undefined" ? caches.default : null) : deps.cache;
  const chave = new Request(url.origin + "/status/" + nome + "?dias=" + dias);
  if (cache) { const c = await cache.match(chave); if (c) return c; }
  const x = await doIndice(env).pedir("spag_dono", { nome });
  if (!x || !x.ok || !x.dono || x.dono.bloqueado) return naoEncontrada();
  // Os enderecos e o intervalo do plano do dono (worker/workspace-plano.js); sem o registro do cliente agora, o gratuito.
  let P = PLANOS_WS.gratuito;
  try { P = planoDe(await workspaceDe(env, x.dono.sub), agora).limites; } catch { /* o gratuito */ }
  const r = await daConta(env, x.dono.sub).pedir("st_publico", { agora, dias, max: P.status_enderecos, intervalo: P.status_intervalo_min });
  if (!r || !r.ok || !r.pagina) return naoEncontrada();
  const resp = paginaHtml(r.pagina, agora);
  if (cache) await cache.put(chave, resp.clone());
  return resp;
}

// ------------------------------------------------------------------ o painel

export async function statusParaPainel(env, agora) {
  const r = await doIndice(env).pedir("spag_painel", { agora });
  if (!r || !r.ok) throw new Error("o indice não respondeu");
  return { paginas: r.paginas, agenda: r.agenda, por_minuto: porMinuto(env), limites: LIMITES_STATUS };
}

export async function bloqueioDaPagina(env, nome, acao, motivo, quem, agora) {
  const x = await doIndice(env).pedir("spag_dono", { nome });
  if (!x || !x.ok || !x.dono) return { status: 404, erro: "essa página não existe (mais)" };
  const bloqueado = acao === "desligar" ? { quando: isoDe(agora), motivo, por: quem.email } : null;
  const r = await daConta(env, x.dono.sub).pedir("st_bloqueio", { bloqueado });
  if (!r || !r.ok) return { status: (r && r.status) || 503, erro: (r && r.erro) || "não deu agora" };
  await doIndice(env).pedir("spag_bloqueio", { nome, bloqueado });
  return { status: 200, dono: x.dono };
}
