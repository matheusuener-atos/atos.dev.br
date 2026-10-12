// O painel da Atos, grupo "Atos Workspace" (atos.dev.br/admin; as telas sao public/assets/admin-workspace.js,
// admin-apps.js e admin-email.js): a equipe ve as contas que ativaram o Workspace, os enderecos do e-mail Atos e os
// aplicativos que as pessoas cadastram, e age por abuso. worker/admin.js confere a area "atos" antes de chegar aqui.
//
// Papeis (a MATRIZ de worker/admin.js):
//   ver tudo: dono, financeiro e suporte
//   suspender e reativar um Workspace; desligar e ligar de novo um aplicativo de terceiro: dono e suporte
//   apagar um aplicativo de terceiro: so o dono
// (suspender, reativar e remover um endereco: as rotas do e-mail Atos, /api/admin/email/*, dono e suporte)
//
// Rotas:
//   GET  /api/admin/workspace                       a visao geral: os numeros, o que precisa de atencao, o indice e a
//                                                   varredura, o registro recente da equipe
//   GET  /api/admin/workspace/contas?q=             as contas do indice (worker/workspace-indice.js), com o alias e
//                                                   quantos aplicativos
//   GET  /api/admin/workspace/contas/:sub           tudo da conta no Workspace
//   POST /api/admin/workspace/contas/:sub/suspender {motivo, desligar_apps?, suspender_alias?}
//   POST /api/admin/workspace/contas/:sub/reativar  {ligar_apps?, reativar_alias?}
//   GET  /api/admin/workspace/apps                  os aplicativos de terceiros (worker/integracoes.js)
//   POST /api/admin/workspace/apps/:id/(desligar|ligar|apagar)   {motivo, confirmar?}
//
// A suspensao do Workspace fica no direito da conta (cobranca/cliente.js, direito:workspace.suspenso): consistencia
// forte, e e o mesmo lugar que as Integracoes e o e-mail Atos ja consultam a cada pedido. Com ela, a gestao para
// (403 workspace_suspenso; a pessoa ve o motivo na area dela). Na hora de suspender, a equipe escolhe se tambem desliga
// os aplicativos da conta (os que ainda estao ligados) e se suspende o endereco Atos; o que a suspensao levou fica
// anotado nela, e o reativar oferece desfazer exatamente isso. Tudo vai ao registro da equipe (quem, quando, o motivo)
// e ao historico do direito; os aplicativos e o endereco tambem ganham a linha no registro deles.

import { json, kv, lerJson, normal } from "./comum.js";
import { mascarar } from "./contas.js";
import { DOMINIO, TETO_CF, destinosNaCloudflare, emailAtosLigado, limiteDeDestinos, registro, simulada } from "./email-atos.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { cliente, idDoCliente } from "./cobranca/cliente.js";
import { ID_APP_TERCEIRO, KO, appTerceiro, indiceDeTerceiros } from "./oidc.js";
import { modoDeAcesso } from "./oidc-campos.js";
import { acaoDaEquipe, terceirosParaPainel } from "./integracoes.js";
import { WORKSPACE, workspaceDe } from "./workspace.js";
import { anotarDaEquipe, anotarNoIndice, estadoDe, registroDaEquipe } from "./workspace-indice.js";
import { bloqueioDoFormulario, formulariosParaPainel } from "./formularios.js";

const SUB = /^[A-Za-z0-9_.:@-]{3,120}$/;
const POR_VARREDURA = 25;
const FORA = () => json({ erro: "não deu para falar com o registro do Atos Workspace agora: tente de novo em instantes" }, 503);
const PODE_AGIR = ["dono", "suporte"];
const limparMotivo = (m) => String(m || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 200);

export const ehRotaDoWorkspaceNoPainel = (p) => p === "/api/admin/workspace" || p.startsWith("/api/admin/workspace/");

/* Todos os aplicativos de terceiros (o indice do Login Atos e cada um). */
export async function todosOsApps(env) {
  const l = [];
  for (const id of Object.keys(await indiceDeTerceiros(env))) {
    const a = await appTerceiro(env, id);
    if (a) l.push(a);
  }
  return l;
}

/* Os ids dos aplicativos de uma conta. */
async function appsDaConta(env, sub) {
  const l = await kv(env, KO(env).dono(sub));
  const ids = Array.isArray(l) ? l.filter((x) => ID_APP_TERCEIRO.test(String(x))) : [];
  const apps = [];
  for (const id of ids) {
    const a = await appTerceiro(env, id);
    if (a && a.dono.sub === sub) apps.push(a);
  }
  return apps;
}

/* O aplicativo como a conta no painel o mostra: quem entra (o modo e quantos na lista, nunca a lista inteira). */
function appResumido(a) {
  const acessos = Object.entries(a.clientes || {}).map(([id, c]) => ({ id, tipo: c.tipo === "confidencial" ? "confidencial" : "publico", ativo: c.ativo !== false }));
  return {
    id: a.id, nome: a.nome, descricao: a.descricao, site: a.site, criado: a.criado || null, acesso: modoDeAcesso(a.acesso), liberados: (a.liberados || []).length,
    bloqueado: a.bloqueado ? { quando: a.bloqueado.quando, motivo: a.bloqueado.motivo || "", por: a.bloqueado.por || "" } : null, acessos,
  };
}

/* O endereco Atos como o painel mostra uma conta: o destino mascarado (p***@gmail.com). */
function aliasDoPainel(r) {
  if (!r) return null;
  const d = r.destino;
  return {
    alias: r.alias, endereco: r.alias + "@" + DOMINIO, criado: r.criado || null, estado: r.estado, atualizado: r.atualizado || null,
    suspenso: r.suspenso ? { quando: r.suspenso.quando, motivo: r.suspenso.motivo || "", por: r.suspenso.por || "" } : null,
    destino: d ? { mascarado: mascarar(d.email), codigo_ok: d.codigo_ok || null, cf_ok: d.cf_ok || null } : null,
    historico: (r.historico || []).slice(-10).reverse(),
  };
}

/* A varredura: percorre as Contas Atos do KV (id:conta:*) de onde parou, POR_VARREDURA por vez, e anota no indice quem
   tem o direito ao Workspace. Os donos de endereco que o indice ainda nao tem entram tambem. Falhou o objeto de uma
   conta: para ali (a proxima abertura continua do mesmo ponto). */
async function varrer(env, semIndice) {
  const reg = registro(env);
  const v = await reg.pedir("ws_varredura", {});
  const st = (v && v.estado) || { cursor: null, conferidas: 0, completa: false };
  for (const x of (semIndice || []).slice(0, POR_VARREDURA)) {
    try {
      const d = await workspaceDe(env, x.sub);
      if (d) await anotarNoIndice(env, x.sub, x.conta, d, "varredura");
    } catch {
      break;
    }
  }
  if (st.completa) return st;
  let l;
  try {
    l = await env.CONTAS.list({ prefix: "id:conta:", limit: POR_VARREDURA, ...(st.cursor ? { cursor: st.cursor } : {}) });
  } catch {
    return st;
  }
  for (const k of l.keys || []) {
    const conta = await kv(env, k.name);
    if (!conta || !conta.sub) continue;
    try {
      const d = await workspaceDe(env, conta.sub);
      if (d) await anotarNoIndice(env, conta.sub, k.name.slice("id:conta:".length), d, "varredura");
    } catch {
      return st;
    }
  }
  const novo = { cursor: l.list_complete ? null : l.cursor || null, conferidas: (st.conferidas || 0) + (l.keys || []).length, completa: Boolean(l.list_complete) };
  const r = await reg.pedir("ws_varredura", { estado: novo });
  return (r && r.estado) || novo;
}

async function listaDoIndice(env) {
  const r = await registro(env).pedir("ws_listar", {});
  if (!r || !r.ok) throw new Error("o indice não respondeu");
  return r;
}

// ------------------------------------------------------------------ a visao geral

async function visaoGeral(env, c) {
  let ind = await listaDoIndice(env);
  const varredura = await varrer(env, ind.sem_indice);
  ind = await listaDoIndice(env);
  const contas = ind.contas;
  const painel = await registro(env).pedir("painel", { agora: c.agora });
  if (!painel || !painel.ok) throw new Error("o registro do e-mail Atos não respondeu");
  const aliases = painel.aliases || [];
  const apps = await todosOsApps(env);
  const acessos = apps.reduce((n, a) => n + Object.keys(a.clientes || {}).length, 0);
  const ligados = apps.reduce((n, a) => n + Object.values(a.clientes || {}).filter((x) => x && x.ativo !== false).length, 0);
  const conta = (sub) => contas.find((x) => x.sub === sub);
  return {
    disponivel: emailAtosLigado(env), simulada: simulada(env), termos_atuais: PRODUTOS[WORKSPACE].termos.versao,
    numeros: {
      workspaces: { total: contas.length, ativos: contas.filter((x) => x.estado === "ativo").length, suspensos: contas.filter((x) => x.estado === "suspenso").length,
        desativados: contas.filter((x) => x.estado === "desativado").length, termos_antigos: contas.filter((x) => x.ativo && x.termos && x.termos.versao !== PRODUTOS[WORKSPACE].termos.versao).length },
      enderecos: { total: aliases.length, encaminhando: aliases.filter((x) => !x.suspenso && x.estado === "ligado").length,
        desligados: aliases.filter((x) => !x.suspenso && x.estado !== "ligado").length, suspensos: aliases.filter((x) => x.suspenso).length,
        sem_destino: aliases.filter((x) => !(x.destino && x.destino.codigo_ok && x.destino.cf_ok)).length },
      apps: { total: apps.length, donos: new Set(apps.map((a) => a.dono.sub)).size, acessos, acessos_ligados: ligados, desligados: apps.filter((a) => a.bloqueado).length },
      vagas: { usadas: (painel.vagas || {}).usadas || 0, limite: limiteDeDestinos(env), teto_cf: TETO_CF, na_cf: await destinosNaCloudflare(env, c.deps || {}) },
    },
    atencao: {
      workspaces: contas.filter((x) => x.estado === "suspenso").map((x) => ({ sub: x.sub, email: x.email, suspenso: x.suspenso })),
      enderecos: aliases.filter((x) => x.suspenso).map((x) => ({ alias: x.alias, endereco: x.alias + "@" + DOMINIO, conta: x.conta, sub: x.sub, suspenso: { quando: x.suspenso.quando, motivo: x.suspenso.motivo || "", por: x.suspenso.por || "" } })),
      apps: apps.filter((a) => a.bloqueado).map((a) => ({ id: a.id, nome: a.nome, dono: a.dono.email, sub: a.dono.sub, no_indice: Boolean(conta(a.dono.sub)), bloqueado: { quando: a.bloqueado.quando, motivo: a.bloqueado.motivo || "", por: a.bloqueado.por || "" } })),
      // Denuncias: a Atos ainda nao recebe denuncia pelo sistema; elas chegam por contato@atos.dev.br (os termos dizem).
      denuncias: null,
    },
    indice: { contas: contas.length, varredura, sem_indice: (ind.sem_indice || []).length },
    registro: await registroDaEquipe(env, { prefixo: "workspace", limite: 15 }),
  };
}

// ------------------------------------------------------------------ as contas

async function listaDeContas(env, q) {
  const ind = await listaDoIndice(env);
  const apps = await todosOsApps(env);
  const porDono = new Map();
  for (const a of apps) porDono.set(a.dono.sub, (porDono.get(a.dono.sub) || 0) + 1);
  const t = normal(q);
  const l = ind.contas.filter((x) => !t || x.email.includes(t) || x.sub === q || (x.alias && x.alias.endereco.includes(t)))
    .map((x) => ({ sub: x.sub, email: x.email, estado: x.estado, ativado: x.ativado, desativado: x.desativado, termos: x.termos, suspenso: x.suspenso, alias: x.alias, apps: porDono.get(x.sub) || 0, atualizado: x.atualizado }))
    .sort((a, b) => String(b.ativado || "").localeCompare(String(a.ativado || "")));
  return { contas: l, total: ind.contas.length, termos_atuais: PRODUTOS[WORKSPACE].termos.versao, varredura: ind.varredura };
}

async function contaNoWorkspace(env, sub) {
  const v = await registro(env).pedir("ws_ver", { sub });
  if (!v || !v.ok) throw new Error("o indice não respondeu");
  const d = await workspaceDe(env, sub);
  if (!d) return null;
  // O e-mail: o do indice, ou o dono anotado no objeto do cliente.
  let email = v.linha ? v.linha.email : "";
  if (!email && v.alias) email = v.alias.conta || "";
  const linha = await anotarNoIndice(env, sub, email, d, "painel");
  const apps = await appsDaConta(env, sub);
  let mudancas = [];
  if (v.alias) {
    const m = await registro(env).pedir("painel_log", { alias: v.alias.alias });
    mudancas = m && m.ok ? (m.mudancas || []).slice(0, 15) : [];
  }
  return {
    conta: { sub, email: (linha && linha.email) || email },
    workspace: {
      estado: estadoDe(d), ativo: Boolean(d.ativo), ativado: d.ativado || null, desativado: d.desativado || null,
      termos: d.termos ? { versao: d.termos.versao, aceito: d.termos.aceito } : null, termos_atuais: PRODUTOS[WORKSPACE].termos.versao,
      suspenso: d.suspenso ? { quando: d.suspenso.quando, motivo: d.suspenso.motivo || "", por: d.suspenso.por || "", apps: d.suspenso.apps || [], alias: d.suspenso.alias || "" } : null,
      historico: (d.historico || []).slice(-20).reverse(),
    },
    alias: aliasDoPainel(v.alias), alias_mudancas: mudancas,
    apps: apps.map(appResumido),
    registro: await registroDaEquipe(env, { sub, limite: 30 }),
  };
}

async function suspender(env, c, sub, d) {
  if (!PODE_AGIR.includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não suspende o Atos Workspace" }, 403);
  const motivo = limparMotivo(d.motivo);
  if (motivo.length < 3) return json({ erro: "diga o motivo (a pessoa vê na área dela)" }, 400);
  const antes = await workspaceDe(env, sub);
  if (!antes) return json({ erro: "essa conta nunca ativou o Atos Workspace" }, 404);
  if (antes.suspenso) return json({ erro: "esse Atos Workspace já está suspenso" }, 409);
  const v = await registro(env).pedir("ws_ver", { sub });
  const email = (v && v.linha && v.linha.email) || (v && v.alias && v.alias.conta) || "";
  const obj = cliente(env, await idDoCliente(sub));
  // Primeiro a suspensao (o que para a gestao); depois o que a equipe escolheu levar junto.
  const r = await obj.pedir("suspender", { produto: WORKSPACE, motivo, por: c.quem.email });
  if (!r || !r.ok) return json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
  const desligados = [];
  if (d.desligar_apps === true) {
    for (const a of await appsDaConta(env, sub)) {
      if (a.bloqueado) continue;
      const x = await acaoDaEquipe(env, a.id, "desligar", { motivo: "Atos Workspace suspenso: " + motivo }, c.quem, c.agora);
      if (x.status === 200) desligados.push(a.id);
    }
  }
  let alias = "";
  if (d.suspender_alias === true && v && v.alias && !v.alias.suspenso) {
    const x = await registro(env).pedir("suspender", { agora: c.agora, alias: v.alias.alias, motivo: "Atos Workspace suspenso: " + motivo, por: c.quem.email });
    if (x && x.ok) alias = v.alias.alias;
  }
  const fim = await obj.pedir("suspensao_anotar", { produto: WORKSPACE, apps: desligados, alias });
  await anotarNoIndice(env, sub, email, (fim && fim.direito) || r.direito, "equipe");
  await anotarDaEquipe(env, {
    por: c.quem.email, tipo: "workspace.suspender", sub, email, alvo: email || sub, motivo,
    oque: "suspendeu o Atos Workspace" + (desligados.length ? "; desligou " + desligados.length + (desligados.length === 1 ? " aplicativo" : " aplicativos") + " (" + desligados.join(", ") + ")" : "") +
      (alias ? "; suspendeu o endereço " + alias + "@" + DOMINIO : ""),
  });
  return json({ ok: true, desligados, alias_suspenso: alias || null, ...(await contaNoWorkspace(env, sub)) });
}

async function reativar(env, c, sub, d) {
  if (!PODE_AGIR.includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não reativa o Atos Workspace" }, 403);
  const antes = await workspaceDe(env, sub);
  if (!antes) return json({ erro: "essa conta nunca ativou o Atos Workspace" }, 404);
  if (!antes.suspenso) return json({ erro: "esse Atos Workspace não está suspenso" }, 409);
  const v = await registro(env).pedir("ws_ver", { sub });
  const email = (v && v.linha && v.linha.email) || (v && v.alias && v.alias.conta) || "";
  const ligados = [];
  if (d.ligar_apps === true) {
    for (const id of antes.suspenso.apps || []) {
      const a = await appTerceiro(env, id);
      if (!a || !a.bloqueado) continue;
      const x = await acaoDaEquipe(env, id, "ligar", {}, c.quem, c.agora);
      if (x.status === 200) ligados.push(id);
    }
  }
  let alias = "";
  if (d.reativar_alias === true && antes.suspenso.alias) {
    const x = await registro(env).pedir("reativar", { agora: c.agora, alias: antes.suspenso.alias, por: c.quem.email });
    if (x && x.ok && !x.repetido) alias = antes.suspenso.alias;
  }
  const r = await cliente(env, await idDoCliente(sub)).pedir("tirar_suspensao", { produto: WORKSPACE, por: c.quem.email });
  if (!r || !r.ok) return json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
  await anotarNoIndice(env, sub, email, r.direito, "equipe");
  await anotarDaEquipe(env, {
    por: c.quem.email, tipo: "workspace.reativar", sub, email, alvo: email || sub, motivo: limparMotivo(d.motivo),
    oque: "tirou a suspensão do Atos Workspace" + (ligados.length ? "; ligou de novo " + ligados.join(", ") : "") + (alias ? "; tirou a suspensão de " + alias + "@" + DOMINIO : ""),
  });
  return json({ ok: true, ligados, alias_reativado: alias || null, ...(await contaNoWorkspace(env, sub)) });
}

// ------------------------------------------------------------------ os aplicativos de terceiros

async function acaoNoApp(env, c, id, acao, d) {
  if (acao === "apagar" && c.quem.papel !== "dono") return json({ erro: "só o dono apaga um aplicativo de terceiro" }, 403);
  if (!PODE_AGIR.includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não desliga aplicativos" }, 403);
  const a = await appTerceiro(env, id);
  const r = await acaoDaEquipe(env, id, acao, d, c.quem, c.agora);
  if (r.status === 200 && a) {
    const NOMES = { desligar: "desligou o aplicativo ", ligar: "ligou de novo o aplicativo ", apagar: "apagou o aplicativo " };
    try {
      await anotarDaEquipe(env, { por: c.quem.email, tipo: "workspace.app." + acao, sub: a.dono.sub, email: a.dono.email, alvo: id, motivo: limparMotivo(d.motivo), oque: NOMES[acao] + a.nome + " (" + id + ")" });
    } catch {
      // a acao ja valeu e esta no registro do aplicativo; o da equipe e o segundo lugar
    }
  }
  return r;
}

// ------------------------------------------------------------------ os formularios (worker/formularios.js)

/* Desligar por abuso (com o motivo, que o dono ve) ou ligar de novo um formulario: dono e suporte. */
async function acaoNoFormulario(env, c, id, acao, d) {
  if (!PODE_AGIR.includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não desliga formulários" }, 403);
  const motivo = limparMotivo(d.motivo);
  if (acao === "desligar" && motivo.length < 3) return json({ erro: "diga o motivo (o dono vê)" }, 400);
  const r = await bloqueioDoFormulario(env, id, acao, motivo, c.quem, c.agora);
  if (r.status !== 200) return json({ erro: r.erro }, r.status);
  try {
    await anotarDaEquipe(env, { por: c.quem.email, tipo: "workspace.formulario." + acao, sub: r.dono.sub, email: r.dono.conta, alvo: id, motivo,
      oque: (acao === "desligar" ? "desligou o formulário " : "ligou de novo o formulário ") + r.form.nome + " (" + id + ")" });
  } catch {
    // a acao ja valeu; o registro da equipe e o segundo lugar
  }
  return json({ ok: true });
}

// ------------------------------------------------------------------ a entrada

export async function atenderWorkspaceNoPainel(request, env, url, c) {
  if (!env.EMAIL_ATOS || !env.CLIENTES) return FORA();
  const p = url.pathname;
  const m = request.method;
  try {
    if (p === "/api/admin/workspace" && m === "GET") return json(await visaoGeral(env, c));
    if (p === "/api/admin/workspace/contas" && m === "GET") return json(await listaDeContas(env, String(url.searchParams.get("q") || "").trim().slice(0, 120)));
    if (p === "/api/admin/workspace/apps" && m === "GET") return json({ apps: await terceirosParaPainel(env) });
    let r = p.match(/^\/api\/admin\/workspace\/contas\/([^/]+)(?:\/(suspender|reativar))?$/);
    if (r) {
      let sub = "";
      try { sub = decodeURIComponent(r[1]); } catch { sub = ""; }
      if (!SUB.test(sub)) return json({ erro: "conta inválida" }, 400);
      if (!r[2] && m === "GET") {
        const x = await contaNoWorkspace(env, sub);
        return x ? json(x) : json({ erro: "essa conta nunca ativou o Atos Workspace" }, 404);
      }
      if (r[2] && m === "POST") {
        const d = (await lerJson(request)) || {};
        return r[2] === "suspender" ? await suspender(env, c, sub, d) : await reativar(env, c, sub, d);
      }
      return json({ erro: "use GET para ver e POST para mudar" }, 405);
    }
    if (p === "/api/admin/workspace/formularios" && m === "GET") {
      if (!env.WS_DADOS) return json({ erro: "os formulários não estão neste Worker" }, 503);
      return json(await formulariosParaPainel(env, c.agora));
    }
    r = p.match(/^\/api\/admin\/workspace\/formularios\/(f-[a-z0-9]{12})\/(desligar|ligar)$/);
    if (r && m === "POST") return env.WS_DADOS ? await acaoNoFormulario(env, c, r[1], r[2], (await lerJson(request)) || {}) : FORA();
    r = p.match(/^\/api\/admin\/workspace\/apps\/(u-[a-z0-9]{10})\/(desligar|ligar|apagar)$/);
    if (r && m === "POST") return await acaoNoApp(env, c, r[1], r[2], (await lerJson(request)) || {});
  } catch (e) {
    console.warn("painel, workspace: " + String((e && e.message) || e));
    return FORA();
  }
  return json({ erro: "rota não existe" }, 404);
}
