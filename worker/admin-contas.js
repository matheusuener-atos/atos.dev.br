// O painel da Atos, "Contas Atos" (grupo Atos; a tela e public/assets/admin-contas.js): o atendimento. A equipe busca
// uma conta pelo e-mail ou pelo endereco Atos e ve como ela entra, o resumo da seguranca (sem segredo nenhum), os
// acessos recentes e as sessoes abertas. worker/admin.js confere a area "atos" antes de chegar aqui.
//
// As acoes sao so do dono, com motivo obrigatorio, confirmacao na pagina e registro (o registro da equipe,
// worker/workspace-indice.js; e o registro de acessos da propria conta, que ela ve em Minha conta > Seguranca):
//   - encerrar todas as sessoes da conta;
//   - desligar a verificacao em duas etapas e remover as chaves de acesso: o atendimento de quem perdeu o aplicativo,
//     os codigos e as chaves e escreveu para contato@atos.dev.br (os termos, "A verificacao em duas etapas"). A equipe
//     confere a identidade FORA do painel antes (o pedido precisa dizer que conferiu). A pessoa recebe o aviso no e-mail
//     da conta, sem link.
// Ninguem age na propria conta por aqui (Minha conta > Seguranca e o caminho, com a propria segunda etapa).
//
// Rotas:
//   GET  /api/admin/contas?q=                      ate 10 contas: o e-mail exato, o endereco Atos, e os e-mails que
//                                                  comecam com o texto
//   GET  /api/admin/contas/ver?email=              a conta
//   POST /api/admin/contas/sessoes                 {email, motivo, confirmar: true}
//   POST /api/admin/contas/segunda-etapa           {email, motivo, confirmar: true, identidade_conferida: true,
//                                                   encerrar_sessoes?: true (o padrao)}
//   GET  /api/admin/busca?q=                       a busca do painel (Ctrl K): contas, enderecos, aplicativos e
//                                                  Workspaces

import { emailValido, json, kv, lerJson, normal } from "./comum.js";
import { campoSessoesDesde } from "./contas.js";
import { DOMINIO, aliasDaConta, aliasDoTexto, conferirAlias, registro } from "./email-atos.js";
import { listaDaEquipe } from "./admin.js";
import { resumoDaSeguranca, seg } from "./seguranca/objeto.js";
import { KS, anotar, atividadeDe, guardarSessoes, sessoesDe } from "./seguranca/atividade.js";
import { avisar } from "./seguranca/avisos.js";
import { vistaDoWorkspace, workspaceDe } from "./workspace.js";
import { anotarDaEquipe, registroDaEquipe } from "./workspace-indice.js";
import { todosOsApps } from "./admin-workspace.js";

const MOTIVO_MIN = 5;
const limparMotivo = (m) => String(m || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 200);
const FORA = () => json({ erro: "não deu para ler a conta agora: tente de novo em instantes" }, 503);

export const ehRotaDasContasNoPainel = (p) => p === "/api/admin/contas" || p.startsWith("/api/admin/contas/") || p === "/api/admin/busca";

/* O alias pelo nome (existe, mesmo suspenso): o registro guardado ou null. */
async function aliasPeloNome(env, alias) {
  if (!env.EMAIL_ATOS || !alias) return null;
  const v = await registro(env).pedir("ver", { alias });
  return v && v.ok ? v.alias : null;
}

/* Ate 10 contas para o texto: o e-mail exato, o endereco Atos (com ou sem @atos.dev.br) e os e-mails que comecam assim. */
export async function buscarContas(env, q) {
  const t = normal(q);
  const achadas = new Map();
  const pegar = async (email, alias) => {
    if (achadas.has(email) || achadas.size >= 10) return;
    const c = await kv(env, "id:conta:" + email);
    if (c && c.sub) achadas.set(email, { email, nome: c.nome || "", criada: c.criada || null, sub: c.sub, alias: alias || null });
  };
  if (!t) return [];
  if (t.includes("@")) {
    if (t.endsWith("@" + DOMINIO)) {
      const r = await aliasPeloNome(env, aliasDoTexto(t));
      if (r && r.conta) await pegar(r.conta, r.alias + "@" + DOMINIO);
    }
    if (emailValido(t)) await pegar(t);
  } else if (conferirAlias(t).alias) {
    const r = await aliasPeloNome(env, t);
    if (r && r.conta) await pegar(r.conta, r.alias + "@" + DOMINIO);
  }
  if (t.length >= 3) {
    try {
      const l = await env.CONTAS.list({ prefix: "id:conta:" + t, limit: 10 });
      for (const k of l.keys || []) await pegar(k.name.slice("id:conta:".length));
    } catch {
      // a lista e um extra: o exato ja foi
    }
  }
  return [...achadas.values()];
}

async function contaPeloEmail(env, email) {
  const e = normal(email);
  if (!emailValido(e)) return null;
  const c = await kv(env, "id:conta:" + e);
  return c && c.sub ? { email: e, c } : null;
}

async function verConta(env, c, email) {
  const x = await contaPeloEmail(env, email);
  if (!x) return json({ erro: "não há Conta Atos com esse e-mail" }, 404);
  const { c: conta } = x;
  const sub = conta.sub;
  let s;
  try { s = await resumoDaSeguranca(env, sub, c.agora); } catch { return FORA(); }
  let alias = null, workspace = null;
  try { alias = await aliasDaConta(env, sub); } catch { alias = "?"; }
  try { workspace = env.CLIENTES ? await workspaceDe(env, sub) : null; } catch { workspace = "?"; }
  const sessoes = await sessoesDe(env, sub, c.agora);
  const equipe = (await listaDaEquipe(env)).find((m) => m.email === x.email);
  return json({
    conta: { email: x.email, nome: conta.nome || "", sub, criada: conta.criada || null, senha_trocada: conta.trocada || null, na_equipe: equipe ? equipe.papel : null, propria: x.email === c.quem.email },
    entra: {
      senha: Boolean(conta.hash), google: Boolean(await kv(env, "id:google:" + x.email)),
      alias: alias === "?" ? "?" : alias ? { endereco: alias.endereco, suspenso: alias.suspenso } : null,
    },
    // So o resumo: se esta ligada, desde quando, quantos codigos restam, os nomes das chaves. Nada que sirva para entrar.
    seguranca: {
      ativa: s.ativa, bloqueado: s.bloqueado, totp: s.totp ? { desde: s.totp.desde } : null, recuperacao: s.recuperacao ? { restantes: s.recuperacao.restantes, gerados: s.recuperacao.gerados } : null,
      chaves: (s.chaves || []).map((k) => ({ nome: k.nome, criada: k.criada, ultimo_uso: k.ultimo_uso, sincronizada: k.sincronizada, alerta: Boolean(k.alerta) })),
    },
    atividade: await atividadeDe(env, sub, c.agora),
    sessoes: sessoes.map((y) => ({ id: y.id, criada: y.criada, como: y.como || "", segunda: y.segunda || "", onde: y.onde || "", navegador: y.navegador || "" })),
    workspace: workspace === "?" ? "?" : workspace ? vistaDoWorkspace(workspace) : null,
    registro: env.EMAIL_ATOS ? await registroDaEquipe(env, { email: x.email, limite: 30 }) : [],
  });
}

/* Encerra todas as sessoes da conta neste Worker: a conta anota o instante (toda sessao criada antes cai) e as da lista
   saem do KV na hora. Devolve quantas estavam na lista. */
async function encerrarSessoes(env, email, sub, agora) {
  const conta = await kv(env, "id:conta:" + email);
  if (!conta || conta.sub !== sub) return 0;
  await env.CONTAS.put("id:conta:" + email, JSON.stringify({ ...conta, [campoSessoesDesde(env)]: agora }));
  const lista = await sessoesDe(env, sub, agora);
  for (const y of lista) await env.CONTAS.delete("atos:sessao:" + y.h);
  await guardarSessoes(env, sub, []);
  return lista.length;
}

/* O que toda acao pede: o dono, o motivo, a confirmacao, uma conta que existe e nao e a de quem pede. */
async function preparar(env, c, d) {
  if (c.quem.papel !== "dono") return { recusa: json({ erro: "só o dono mexe na segurança de uma Conta Atos" }, 403) };
  const motivo = limparMotivo(d.motivo);
  if (motivo.length < MOTIVO_MIN) return { recusa: json({ erro: "diga o motivo (fica no registro da equipe)" }, 400) };
  if (d.confirmar !== true) return { recusa: json({ erro: "confirme na página" }, 400) };
  const x = await contaPeloEmail(env, d.email);
  if (!x) return { recusa: json({ erro: "não há Conta Atos com esse e-mail" }, 404) };
  if (x.email === c.quem.email) return { recusa: json({ erro: "a sua própria conta não muda por aqui: use Minha conta › Segurança" }, 400) };
  // O registro da equipe tem de estar respondendo antes: a acao nao acontece sem ficar anotada.
  const r = await registro(env).pedir("eq_listar", { limite: 1 }).catch(() => null);
  if (!r || !r.ok) return { recusa: json({ erro: "o registro da equipe não respondeu: a ação não foi feita. Tente de novo em instantes" }, 503) };
  return { email: x.email, sub: x.c.sub, motivo };
}

async function acaoSessoes(env, c, d) {
  const p = await preparar(env, c, d);
  if (p.recusa) return p.recusa;
  const n = await encerrarSessoes(env, p.email, p.sub, c.agora);
  await anotar(env, p.sub, { tipo: "mudanca", evento: "equipe-sessoes-encerradas" }, c.agora);
  await avisar(env, c.deps, p.email, "equipe-sessoes-encerradas", { agora: c.agora });
  await anotarDaEquipe(env, { por: c.quem.email, tipo: "conta.sessoes", sub: p.sub, email: p.email, alvo: p.email, motivo: p.motivo,
    oque: "encerrou todas as sessões da conta (" + n + (n === 1 ? " na lista" : " na lista") + ")" });
  return json({ ok: true, encerradas: n });
}

async function acaoSegundaEtapa(env, c, d) {
  const p = await preparar(env, c, d);
  if (p.recusa) return p.recusa;
  if (d.identidade_conferida !== true) return json({ erro: "confira a identidade da pessoa fora do painel antes (o pedido do e-mail da conta) e marque que conferiu" }, 400);
  let v;
  try { v = await seg(env, p.sub)("equipe-zerar", { agora: c.agora }); } catch { return FORA(); }
  if (!v || !v.ok) return json({ erro: "a verificação em duas etapas já está desligada nesta conta" }, 409);
  // O indice do "Entrar com chave de acesso": as chaves removidas deixam de achar a conta.
  for (const k of v.tinha.chaves) {
    const i = await kv(env, KS(env).chave(k.id));
    if (i && i.sub === p.sub) await env.CONTAS.delete(KS(env).chave(k.id));
  }
  const encerrar = d.encerrar_sessoes !== false;
  const n = encerrar ? await encerrarSessoes(env, p.email, p.sub, c.agora) : 0;
  const partes = [v.tinha.totp ? "o aplicativo autenticador" : "", v.tinha.codigos ? v.tinha.codigos + " código(s) de recuperação" : "",
    v.tinha.chaves.length ? v.tinha.chaves.length + (v.tinha.chaves.length === 1 ? " chave de acesso" : " chaves de acesso") : ""].filter(Boolean);
  await anotar(env, p.sub, { tipo: "mudanca", evento: "equipe-2fa-desligada" }, c.agora);
  await avisar(env, c.deps, p.email, "equipe-2fa-desligada", { agora: c.agora, detalhe: encerrar ? "As sessões que estavam abertas também foram encerradas." : "" });
  await anotarDaEquipe(env, { por: c.quem.email, tipo: "conta.segunda-etapa", sub: p.sub, email: p.email, alvo: p.email, motivo: p.motivo,
    oque: "desligou a verificação em duas etapas (removeu " + (partes.join(", ") || "nada") + ")" + (encerrar ? " e encerrou as sessões (" + n + ")" : "") });
  return json({ ok: true, removido: { totp: v.tinha.totp, codigos: v.tinha.codigos, chaves: v.tinha.chaves.length }, encerradas: n });
}

/* A busca do painel (Ctrl K): ate 8 de cada. */
async function busca(env, q) {
  const t = normal(q);
  if (t.length < 2) return { contas: [], enderecos: [], apps: [], workspaces: [] };
  const contas = await buscarContas(env, t);
  let enderecos = [], workspaces = [];
  if (env.EMAIL_ATOS) {
    const p = await registro(env).pedir("painel", {});
    const nome = t.replace("@" + DOMINIO, "");
    enderecos = ((p && p.aliases) || []).filter((x) => x.alias.includes(nome) || String(x.conta || "").includes(t)).slice(0, 8)
      .map((x) => ({ alias: x.alias, endereco: x.alias + "@" + DOMINIO, conta: x.conta, sub: x.sub, suspenso: Boolean(x.suspenso), estado: x.estado }));
    const w = await registro(env).pedir("ws_listar", {});
    workspaces = ((w && w.contas) || []).filter((x) => x.email.includes(t) || (x.alias && x.alias.endereco.includes(t))).slice(0, 8)
      .map((x) => ({ sub: x.sub, email: x.email, estado: x.estado }));
  }
  const apps = (await todosOsApps(env)).filter((a) => a.id.includes(t) || String(a.nome || "").toLowerCase().includes(t) || a.dono.email.includes(t)).slice(0, 8)
    .map((a) => ({ id: a.id, nome: a.nome, dono: a.dono.email, sub: a.dono.sub, bloqueado: Boolean(a.bloqueado) }));
  return { contas: contas.map((x) => ({ email: x.email, nome: x.nome, alias: x.alias })), enderecos, apps, workspaces };
}

export async function atenderContasNoPainel(request, env, url, c) {
  const p = url.pathname;
  const m = request.method;
  try {
    if (p === "/api/admin/busca" && m === "GET") return json(await busca(env, String(url.searchParams.get("q") || "").slice(0, 120)));
    if (p === "/api/admin/contas" && m === "GET") return json({ contas: await buscarContas(env, String(url.searchParams.get("q") || "").slice(0, 120)) });
    if (p === "/api/admin/contas/ver" && m === "GET") return await verConta(env, c, String(url.searchParams.get("email") || ""));
    if (m === "POST" && (p === "/api/admin/contas/sessoes" || p === "/api/admin/contas/segunda-etapa")) {
      if (!env.EMAIL_ATOS) return json({ erro: "o registro da equipe não está neste Worker: sem ele, a Atos não faz a ação" }, 503);
      const d = (await lerJson(request)) || {};
      return p.endsWith("/sessoes") ? await acaoSessoes(env, c, d) : await acaoSegundaEtapa(env, c, d);
    }
  } catch (e) {
    console.warn("painel, contas: " + String((e && e.message) || e));
    return FORA();
  }
  return json({ erro: "rota não existe" }, 404);
}
