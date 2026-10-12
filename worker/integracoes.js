// Atos Workspace > Integracoes (atos.dev.br/workspace/integracoes; a tela e public/assets/workspace-integracoes.js): quem
// tem o Atos Workspace ativo (worker/workspace.js) e o e-mail Atos com o destino confirmado, e entrou pelo endereco
// Atos (estadoDoAlias; 403 com codigo sem_alias, alias_nao_confirmado ou entrar_pelo_alias), cadastra os proprios sistemas no "Entrar com Atos" (o Login Atos) e
// diz quem pode entrar neles. Sem o Workspace ativo, toda rota daqui responde 403 (workspace: false); os aplicativos ja
// cadastrados continuam funcionando para quem entra (worker/oidc.js nao olha o Workspace), so a gestao fica parada. O aplicativo pertence a
// conta que o criou (dono: sub e e-mail). As mudancas do dono valem na hora (sem a fila da equipe), e cada uma fica
// no registro do aplicativo (quem, quando, o que).
//
// O modelo, no KV CONTAS (prefixo "atos:oidc:"; "atos-teste:oidc:" no Worker de teste; worker/oidc.js, KO):
//   app:<id>       {id, nome, descricao, site, privacidade, termos, icone, criado, mudado, dono: {sub, email},
//                   acesso: "liberados"|"todos", liberados: [e-mails], bloqueado: null|{por, quando, motivo},
//                   clientes: {<client_id>: {tipo: "publico"|"confidencial", voltas, loopback, origens, ativo, criado, mudado}}}
//   applog:<id>    [{quando, por, quem: "dono"|"equipe", oque}] (os ultimos 200; fica um ano depois de apagar)
//   dono:<sub>     [ids] os aplicativos da conta
//   terceiros      {<id>: {nome, email, origens, bloqueado}} todos (o painel da equipe e o CORS do /oauth/*)
//   segredo:<cid>  {hash, quando, por} o do cliente confidencial (o mesmo lugar dos da equipe)
//   ritmo:<sub>    {n} as mudancas da conta na ultima hora
// Os ids: o aplicativo "u-" + 10 letras e numeros; o cliente (o "acesso", na tela) "<id do aplicativo>-" + 6.
// Nenhum id da equipe comeca com "u-" (worker/oidc-painel.js recusa).
//
// Limites: 5 aplicativos por conta, 5 acessos por aplicativo, 500 pessoas liberadas por aplicativo; nomes reservados
// recusados (Atos, PAVLVS/Paulus, Google, Gmail, Mercado Pago/Livre, sem diferenciar maiusculas, acentos e trocas
// como 0 por o); mudar pede login de ate 12 horas (como o painel); ate 60 mudancas por hora por conta; criar e gerar
// segredo tambem passam pelo limite por endereco de internet.
//
// Rotas (so a propria pagina; a sessao da Conta Atos):
//   GET  /api/integracoes                          {conta, recente, limites, emissor..., apps: [...]}
//   POST /api/integracoes/apps                     {nome, descricao, site, privacidade, termos, icone?} cria
//   POST /api/integracoes/apps/:id                 {acao: editar|acesso|liberar|tirar|apagar, ...}
//   POST /api/integracoes/apps/:id/acessos         {tipo, voltas, loopback, origens} cria um acesso (cliente)
//   POST /api/integracoes/acessos/:cid             {acao: editar|ligar|desligar|apagar|segredo, ...}
//
// A equipe (painel, Atos Workspace > Aplicativos de terceiros; worker/admin-workspace.js) ve todos e pode desligar (por abuso, com motivo), ligar de
// novo ou apagar qualquer um, na hora, com registro: terceirosParaPainel e acaoDaEquipe, abaixo. Desligado pela
// equipe, o dono ve o motivo e nao consegue religar.

import { aleatorio, json, kv, lerJson, sha256 } from "./comum.js";
import { sessaoDe } from "./contas.js";
import { SEM_WORKSPACE, WORKSPACE_FORA, WORKSPACE_SUSPENSO, estadoDoAlias, recusaDoAlias, vistaDoWorkspace, workspaceDe } from "./workspace.js";
import { aliasDaConta, emailAtosLigado } from "./email-atos.js";
import { ID_APP_TERCEIRO, KO, appDoCliente, appTerceiro, dadosParaIntegrar, indiceDeTerceiros } from "./oidc.js";
import { LIBERADOS_MAX, camposDoApp, camposDoCliente, emailsLimpos, modoDeAcesso } from "./oidc-campos.js";

export const LIMITES = { apps: 5, acessos: 5, liberados: LIBERADOS_MAX, ritmo_hora: 60, recente_h: 12 };
const RECENTE_S = LIMITES.recente_h * 3600;
const LOG_MAX = 200;
const LOG_DEPOIS_S = 365 * 24 * 3600;
const iso = (ms) => new Date(ms).toISOString();

// ------------------------------------------------------------ os nomes reservados

// Ja com a troca de v por u (a mesma que o nome sofre ao ser conferido).
const RESERVADOS = ["atos", "paulus", "google", "gmail", "mercadopago", "mercadolivre", "mercadolibre"].map((r) => r.replace(/v/g, "u"));

/* O nome lembra a Atos, um produto dela ou um servico conhecido? Sem acento, minusculo, com as trocas comuns (0 por o,
   1 por i ou l, 3 por e, 4 e @ por a, 5 e $ por s, 7 por t, v por u: "PAVLVS" vira "paulus"); confere a partir do
   comeco de cada palavra, com as palavras seguintes juntas ("Mercado Pago", "Login Google", "Atos-ID"). Uma palavra
   que so termina assim ("Contatos") passa. */
export function nomeReservado(nome) {
  const base = String(nome || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/0/g, "o").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/v/g, "u");
  for (const t of [base.replace(/[1!|]/g, "i"), base.replace(/[1!|]/g, "l")]) {
    const palavras = t.split(/[^a-z]+/).filter(Boolean);
    for (let i = 0; i < palavras.length; i++) {
      const resto = palavras.slice(i).join("");
      if (RESERVADOS.some((r) => resto.startsWith(r))) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------ guardar

const ALFA = "abcdefghijklmnopqrstuvwxyz0123456789";
const sorteio = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => ALFA[x % 36]).join("");

async function guardarApp(env, a) {
  await env.CONTAS.put(KO(env).app(a.id), JSON.stringify(a));
  await atualizarIndice(env, a);
}

/* O indice de todos: o nome, o dono e as origens dos acessos ligados (o CORS do /oauth/* le daqui). */
async function atualizarIndice(env, a) {
  const i = await indiceDeTerceiros(env);
  const origens = [];
  for (const c of Object.values(a.clientes || {})) if (c && c.ativo !== false) for (const o of c.origens || []) if (!origens.includes(o)) origens.push(o);
  i[a.id] = { nome: a.nome, email: a.dono.email, origens, bloqueado: Boolean(a.bloqueado) };
  await env.CONTAS.put(KO(env).terceiros, JSON.stringify(i));
}

async function idsDoDono(env, sub) {
  const l = await kv(env, KO(env).dono(sub));
  return Array.isArray(l) ? l.filter((x) => ID_APP_TERCEIRO.test(String(x))) : [];
}

/* O registro do aplicativo: quem, quando, o que (os ultimos LOG_MAX). */
export async function registrar(env, id, por, quem, oque, agora, ttl) {
  const k = KO(env).appLog(id);
  const l = (await kv(env, k)) || [];
  l.unshift({ quando: iso(agora), por, quem, oque: String(oque).slice(0, 400) });
  await env.CONTAS.put(k, JSON.stringify(l.slice(0, LOG_MAX)), ttl ? { expirationTtl: ttl } : undefined);
}

/* Apaga o aplicativo: os segredos, o aplicativo, a conta do dono e o indice. O registro fica um ano. */
async function apagarApp(env, a, por, quem, agora, motivo) {
  for (const cid of Object.keys(a.clientes || {})) await env.CONTAS.delete(KO(env).segredo(cid));
  await env.CONTAS.delete(KO(env).app(a.id));
  const ids = (await idsDoDono(env, a.dono.sub)).filter((x) => x !== a.id);
  await env.CONTAS.put(KO(env).dono(a.dono.sub), JSON.stringify(ids));
  const i = await indiceDeTerceiros(env);
  delete i[a.id];
  await env.CONTAS.put(KO(env).terceiros, JSON.stringify(i));
  await registrar(env, a.id, por, quem, (quem === "equipe" ? "a Atos apagou o aplicativo" : "apagou o aplicativo") + (motivo ? ": " + motivo : ""), agora, LOG_DEPOIS_S);
}

// ------------------------------------------------------------ o que a tela ve

async function vista(env, a, comLog = 30) {
  const acessos = [];
  for (const [id, c] of Object.entries(a.clientes || {})) {
    const s = c.tipo === "confidencial" ? await kv(env, KO(env).segredo(id)) : null;
    acessos.push({
      id, tipo: c.tipo === "confidencial" ? "confidencial" : "publico", voltas: c.voltas || [], loopback: Boolean(c.loopback), origens: c.origens || [],
      ativo: c.ativo !== false, criado: c.criado || null, mudado: c.mudado || null, segredo: s ? { quando: s.quando, por: s.por } : null,
    });
  }
  return {
    id: a.id, nome: a.nome, descricao: a.descricao, site: a.site, privacidade: a.privacidade, termos: a.termos, icone: a.icone || "",
    criado: a.criado || null, mudado: a.mudado || null, dono: a.dono.email, acesso: modoDeAcesso(a.acesso), liberados: a.liberados || [],
    bloqueado: a.bloqueado ? { quando: a.bloqueado.quando, motivo: a.bloqueado.motivo || "" } : null, acessos,
    registro: comLog ? ((await kv(env, KO(env).appLog(a.id))) || []).slice(0, comLog) : undefined,
  };
}

async function telaDoDono(env, sessao, agora) {
  const apps = [];
  for (const id of await idsDoDono(env, sessao.sub)) {
    const a = await appTerceiro(env, id);
    if (a && a.dono.sub === sessao.sub) apps.push(await vista(env, a));
  }
  return { conta: { email: sessao.email }, recente: agora / 1000 - sessao.auth_time < RECENTE_S, limites: LIMITES, ...dadosParaIntegrar(env), apps };
}

// ------------------------------------------------------------ as rotas do dono

export function ehRotaDasIntegracoes(url) {
  return url.pathname === "/api/integracoes" || url.pathname.startsWith("/api/integracoes/");
}

async function noRitmo(env, sub) {
  const k = KO(env).ritmo(sub);
  const r = (await kv(env, k)) || { n: 0 };
  if (r.n >= LIMITES.ritmo_hora) return false;
  await env.CONTAS.put(k, JSON.stringify({ n: r.n + 1 }), { expirationTtl: 3600 });
  return true;
}

const listaCurta = (l) => l.slice(0, 5).join(", ") + (l.length > 5 ? " e mais " + (l.length - 5) : "");
const NAO_E_SEU = () => json({ erro: "esse aplicativo não existe nesta conta" }, 404);
const BLOQUEADO = (a) => "a Atos desligou este aplicativo" + (a.bloqueado.motivo ? " (" + a.bloqueado.motivo + ")" : "") + ": escreva para contato@atos.dev.br";

export async function atenderIntegracoes(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  const sessao = await sessaoDe(request, env);
  if (!sessao) return json({ erro: "entre na sua conta", entrar: true }, 401);
  // O Atos Workspace ativo, antes de tudo (ver e mudar): o registro forte do cliente, nao o KV.
  let w;
  try { w = await workspaceDe(env, sessao.sub); } catch { return WORKSPACE_FORA(); }
  if (!w || !w.ativo) return SEM_WORKSPACE();
  // Suspenso pela equipe (worker/admin-workspace.js): ver e mudar param; os aplicativos seguem como estao (a equipe
  // escolhe, na hora de suspender, se tambem os desliga).
  if (w.suspenso) return WORKSPACE_SUSPENSO(w.suspenso);
  // O e-mail Atos (worker/workspace.js, estadoDoAlias): o alias ativo, com o destino confirmado, e a sessao aberta por
  // ele. Faltando um, 403 com o codigo (sem_alias, alias_nao_confirmado, entrar_pelo_alias); os aplicativos ja
  // cadastrados continuam funcionando para quem entra neles, so a gestao para.
  let alias;
  try { alias = await estadoDoAlias(env, sessao); } catch { return WORKSPACE_FORA(); }
  if (alias.pendencia) return recusaDoAlias(alias, emailAtosLigado(env));
  const p = url.pathname;
  // email_atos: o endereco que quem entra ve como "Cadastrado por" (a tela diz isso).
  if (p === "/api/integracoes" && request.method === "GET") return json({ ...(await telaDoDono(env, sessao, agora)), email_atos: alias.alias.endereco });
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);
  if (!(agora / 1000 - sessao.auth_time < RECENTE_S)) return json({ erro: "para mudar as integrações, entre de novo (o login precisa ser das últimas 12 horas)", reentrar: true }, 401);
  const d = await lerJson(request);
  if (!d || typeof d !== "object" || Array.isArray(d)) return json({ erro: "pedido inválido" }, 400);
  const porIp = async () => !deps.dentroDoLimite || (await deps.dentroDoLimite(request, env));
  const log = (id, oque) => registrar(env, id, sessao.email, "dono", oque, agora);
  const responder = async (a, extra = {}) => json({ ok: true, app: await vista(env, a), ...extra });

  // Criar um aplicativo.
  if (p === "/api/integracoes/apps") {
    const ids = await idsDoDono(env, sessao.sub);
    if (ids.length >= LIMITES.apps) return json({ erro: "cada conta cadastra no máximo " + LIMITES.apps + " aplicativos: apague um para criar outro" }, 409);
    const f = camposDoApp(d);
    if (f.erro) return json({ erro: f.erro }, 400);
    if (nomeReservado(f.nome)) return json({ erro: "esse nome é reservado (lembra a Atos, um produto dela ou outro serviço conhecido): escolha outro" }, 400);
    if (!(await porIp()) || !(await noRitmo(env, sessao.sub))) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
    let id = "";
    for (let i = 0; i < 5 && !id; i++) {
      const tentativa = "u-" + sorteio(10);
      if (!(await kv(env, KO(env).app(tentativa)))) id = tentativa;
    }
    if (!id) return json({ erro: "não deu para criar agora: tente de novo" }, 503);
    const a = { id, ...f, criado: iso(agora), dono: { sub: sessao.sub, email: sessao.email }, acesso: "liberados", liberados: [], bloqueado: null, clientes: {} };
    await guardarApp(env, a);
    await env.CONTAS.put(KO(env).dono(sessao.sub), JSON.stringify([...ids, id]));
    await log(id, "criou o aplicativo " + f.nome + " (quem pode entrar: só as pessoas liberadas)");
    return responder(a);
  }

  let r = p.match(/^\/api\/integracoes\/apps\/(u-[a-z0-9]{10})(\/acessos)?$/);
  let a, cid = "";
  if (r) a = await appTerceiro(env, r[1]);
  else {
    const rc = p.match(/^\/api\/integracoes\/acessos\/(u-[a-z0-9]{10}-[a-z0-9]{6})$/);
    if (!rc) return json({ erro: "rota não existe" }, 404);
    cid = rc[1];
    a = await appTerceiro(env, appDoCliente(cid));
    if (a && !(a.clientes && Object.prototype.hasOwnProperty.call(a.clientes, cid))) a = null;
  }
  if (!a || a.dono.sub !== sessao.sub) return NAO_E_SEU();
  if (!(await noRitmo(env, sessao.sub))) return json({ erro: "muitas mudanças nesta conta na última hora: espere um pouco" }, 429);
  const acao = String(d.acao || "");

  // Criar um acesso (cliente).
  if (r && r[2]) {
    if (a.bloqueado) return json({ erro: BLOQUEADO(a) }, 403);
    if (Object.keys(a.clientes || {}).length >= LIMITES.acessos) return json({ erro: "cada aplicativo tem no máximo " + LIMITES.acessos + " acessos" }, 409);
    if (!["publico", "confidencial"].includes(d.tipo)) return json({ erro: "o tipo do acesso: público (página ou programa, com PKCE) ou confidencial (servidor, com segredo)" }, 400);
    const f = camposDoCliente(d);
    if (f.erro) return json({ erro: f.erro }, 400);
    if (!(await porIp())) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
    let novo = "";
    for (let i = 0; i < 5 && !novo; i++) { const t = a.id + "-" + sorteio(6); if (!a.clientes[t]) novo = t; }
    a.clientes[novo] = { tipo: d.tipo, ...f, ativo: true, criado: iso(agora) };
    a.mudado = iso(agora);
    await guardarApp(env, a);
    await log(a.id, "criou o acesso " + novo + " (" + (d.tipo === "confidencial" ? "confidencial" : "público") + ")");
    return responder(a, { acesso: novo });
  }

  // O aplicativo.
  if (r) {
    if (acao === "editar") {
      const f = camposDoApp(d);
      if (f.erro) return json({ erro: f.erro }, 400);
      if (nomeReservado(f.nome)) return json({ erro: "esse nome é reservado (lembra a Atos, um produto dela ou outro serviço conhecido): escolha outro" }, 400);
      const mudou = ["nome", "descricao", "site", "privacidade", "termos", "icone"].filter((k) => (a[k] || "") !== f[k]);
      if (!mudou.length) return responder(a);
      Object.assign(a, f, { mudado: iso(agora) });
      await guardarApp(env, a);
      const NOMES = { nome: "o nome", descricao: "a descrição", site: "o site", privacidade: "a política de privacidade", termos: "os termos", icone: "o ícone" };
      await log(a.id, "editou " + mudou.map((k) => NOMES[k]).join(", "));
      return responder(a);
    }
    if (acao === "acesso") {
      if (!["liberados", "todos"].includes(d.acesso)) return json({ erro: "quem pode entrar: liberados (só as pessoas da lista) ou todos (qualquer Conta Atos)" }, 400);
      if (modoDeAcesso(a.acesso) === d.acesso) return responder(a);
      a.acesso = d.acesso;
      a.mudado = iso(agora);
      await guardarApp(env, a);
      await log(a.id, "mudou quem pode entrar para: " + (d.acesso === "todos" ? "qualquer Conta Atos" : "só as pessoas liberadas"));
      return responder(a);
    }
    if (acao === "liberar") {
      const e = emailsLimpos(d.emails);
      if (e.erro) return json({ erro: e.erro }, 400);
      const novos = e.emails.filter((x) => !(a.liberados || []).includes(x));
      if (!novos.length) return json({ erro: e.emails.length ? "esses e-mails já estão na lista" : "diga pelo menos um e-mail" }, 400);
      if ((a.liberados || []).length + novos.length > LIMITES.liberados) return json({ erro: "no máximo " + LIMITES.liberados + " pessoas liberadas por aplicativo" }, 409);
      a.liberados = [...(a.liberados || []), ...novos];
      a.mudado = iso(agora);
      await guardarApp(env, a);
      await log(a.id, "liberou " + listaCurta(novos));
      return responder(a);
    }
    if (acao === "tirar") {
      const email = String(d.email || "").trim().toLowerCase();
      if (!(a.liberados || []).includes(email)) return json({ erro: "esse e-mail não está na lista" }, 404);
      a.liberados = a.liberados.filter((x) => x !== email);
      a.mudado = iso(agora);
      await guardarApp(env, a);
      await log(a.id, "tirou " + email + " da lista");
      return responder(a);
    }
    if (acao === "apagar") {
      if (d.confirmar !== true) return json({ erro: "confirme na página: apagar não tem volta" }, 400);
      await apagarApp(env, a, sessao.email, "dono", agora, "");
      return json({ ok: true, apagado: a.id });
    }
    return json({ erro: "o que fazer com o aplicativo? (editar, acesso, liberar, tirar ou apagar)" }, 400);
  }

  // Um acesso (cliente).
  const c = a.clientes[cid];
  if (acao === "editar") {
    if (d.tipo !== undefined && d.tipo !== c.tipo) return json({ erro: "o tipo de um acesso não muda: crie outro acesso" }, 400);
    const f = camposDoCliente(d);
    if (f.erro) return json({ erro: f.erro }, 400);
    a.clientes[cid] = { ...c, ...f, mudado: iso(agora) };
    a.mudado = iso(agora);
    await guardarApp(env, a);
    await log(a.id, "editou o acesso " + cid);
    return responder(a);
  }
  if (acao === "ligar" || acao === "desligar") {
    if (acao === "ligar" && a.bloqueado) return json({ erro: BLOQUEADO(a) }, 403);
    if ((c.ativo !== false) === (acao === "ligar")) return responder(a);
    a.clientes[cid] = { ...c, ativo: acao === "ligar", mudado: iso(agora) };
    a.mudado = iso(agora);
    await guardarApp(env, a);
    await log(a.id, (acao === "ligar" ? "ligou" : "desligou") + " o acesso " + cid);
    return responder(a);
  }
  if (acao === "apagar") {
    if (d.confirmar !== true) return json({ erro: "confirme na página: apagar não tem volta" }, 400);
    delete a.clientes[cid];
    a.mudado = iso(agora);
    await env.CONTAS.delete(KO(env).segredo(cid));
    await guardarApp(env, a);
    await log(a.id, "apagou o acesso " + cid);
    return responder(a);
  }
  if (acao === "segredo") {
    if (d.confirmar !== true) return json({ erro: "confirme na página: o segredo anterior (se houver) para de valer na hora" }, 400);
    if (c.tipo !== "confidencial") return json({ erro: "este acesso é público: usa PKCE, sem segredo" }, 400);
    if (a.bloqueado) return json({ erro: BLOQUEADO(a) }, 403);
    if (!(await porIp())) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
    const antes = await kv(env, KO(env).segredo(cid));
    const segredo = "atos_cs_" + aleatorio(32);
    await env.CONTAS.put(KO(env).segredo(cid), JSON.stringify({ hash: await sha256(segredo), quando: iso(agora), por: sessao.email }));
    await log(a.id, (antes ? "trocou" : "gerou") + " o segredo do acesso " + cid);
    return responder(a, { segredo, trocado: Boolean(antes) });
  }
  return json({ erro: "o que fazer com o acesso? (editar, ligar, desligar, apagar ou segredo)" }, 400);
}

// ------------------------------------------------------------ a equipe (painel, Atos Workspace > Aplicativos de terceiros)

/* Todos os aplicativos de terceiros, com o dono de cada um (o painel: o e-mail e o sub reais), se ele tem o Atos
   Workspace ativo (dono_workspace: {ativo, ativado, desativado} ou null quando nao deu para conferir) e o e-mail Atos
   dele (dono_alias: {endereco, suspenso, confirmado} ou null; dono_alias_lido false quando nao deu para ver). */
export async function terceirosParaPainel(env) {
  const l = [];
  const doDono = new Map();
  for (const id of Object.keys(await indiceDeTerceiros(env))) {
    const a = await appTerceiro(env, id);
    if (!a) continue;
    if (!doDono.has(a.dono.sub)) {
      doDono.set(a.dono.sub, {
        w: await workspaceDe(env, a.dono.sub).then(vistaDoWorkspace, () => null),
        // O e-mail Atos do dono (o que quem entra ve como "Cadastrado por"); null sem alias, "?" se nao deu para ver.
        alias: await aliasDaConta(env, a.dono.sub).then((x) => x ? { endereco: x.endereco, suspenso: x.suspenso, confirmado: x.confirmado } : null, () => "?"),
      });
    }
    const { w, alias } = doDono.get(a.dono.sub);
    l.push({ ...(await vista(env, a, 10)), dono_sub: a.dono.sub, dono_workspace: w ? { ativo: w.ativo, ativado: w.ativado, desativado: w.desativado } : null,
      dono_alias: alias === "?" ? null : alias, dono_alias_lido: alias !== "?" });
  }
  return l.sort((x, y) => String(y.criado || "").localeCompare(String(x.criado || "")));
}

/* Desligar (por abuso, com o motivo), ligar de novo ou apagar um aplicativo de terceiro: na hora, com registro no
   aplicativo e no registro do Login Atos. */
export async function acaoDaEquipe(env, id, acao, d, quem, agora) {
  const a = await appTerceiro(env, id);
  if (!a) return json({ erro: "esse aplicativo não existe (mais)" }, 404);
  const motivo = String(d.motivo || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 200);
  const anotar = async (oque) => {
    const k = KO(env).log;
    const l = (await kv(env, k)) || [];
    l.unshift({ quando: iso(agora), por: quem.email, app: id, acao: oque });
    await env.CONTAS.put(k, JSON.stringify(l.slice(0, 100)));
  };
  if (acao === "desligar") {
    if (motivo.length < 3) return json({ erro: "diga o motivo (o dono do aplicativo vê)" }, 400);
    a.bloqueado = { por: quem.email, quando: iso(agora), motivo };
    await guardarApp(env, a);
    await registrar(env, id, quem.email, "equipe", "a Atos desligou o aplicativo: " + motivo, agora);
    await anotar("desligou o aplicativo de " + a.dono.email + ": " + motivo);
    return json({ ok: true });
  }
  if (acao === "ligar") {
    if (!a.bloqueado) return json({ ok: true });
    a.bloqueado = null;
    await guardarApp(env, a);
    await registrar(env, id, quem.email, "equipe", "a Atos ligou o aplicativo de novo", agora);
    await anotar("ligou de novo o aplicativo de " + a.dono.email);
    return json({ ok: true });
  }
  if (acao === "apagar") {
    if (d.confirmar !== true) return json({ erro: "confirme na página: apagar não tem volta" }, 400);
    await apagarApp(env, a, quem.email, "equipe", agora, motivo);
    await anotar("apagou o aplicativo de " + a.dono.email + (motivo ? ": " + motivo : ""));
    return json({ ok: true });
  }
  return json({ erro: "o que fazer? (desligar, ligar ou apagar)" }, 400);
}
