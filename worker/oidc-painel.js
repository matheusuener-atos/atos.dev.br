// O Login Atos no painel (atos.dev.br/admin, secao "Login Atos"; a tela e public/assets/admin-oauth.js): os
// aplicativos e clientes do "Entrar com Atos" cadastrados no KV, alem dos fixos do codigo (worker/oidc.js, APPS e
// CLIENTES: os do PAVLVS, que aparecem so para leitura). So o papel dono (worker/admin.js confere).
//
// Criar, editar, ligar, desligar e apagar passam pela fila da Atos (tipos oauth.app e oauth.cliente; o retrato do
// registro antes e depois permite retroagir). Gerar ou trocar o segredo de um cliente confidencial e na hora (o
// valor aparece uma vez so, e nao poderia esperar na fila): fica so o hash, com quem e quando.
//
// Rotas (atras de /api/admin, so o dono):
//   GET  /api/admin/oauth                          {emissor, descoberta, endpoints, escopos, token_s, apps, clientes,
//                                                   terceiros}
//   POST /api/admin/oauth/clientes/:id/segredo     {confirmar: true} -> {segredo, quando} (uma vez so)
//   POST /api/admin/oauth/terceiros/:id/desligar   {motivo} um aplicativo de terceiro (Atos Workspace > Integracoes), por
//   POST /api/admin/oauth/terceiros/:id/ligar      abuso: na hora, sem a fila, com registro (worker/integracoes.js)
//   POST /api/admin/oauth/terceiros/:id/apagar     {confirmar: true, motivo?}
//
// O registro no KV ("atos:oidc:registro"; "atos-teste:oidc:registro" no Worker de teste):
//   {apps: {<id>: {nome, descricao, site, privacidade, termos, icone, acesso: "liberados"|"todos", liberados: [e-mails],
//                  criado, por, mudado?}},  (sem acesso: "liberados"; quem criou, o "por", entra sempre)
//    clientes: {<id>: {app, tipo: "publico"|"confidencial", voltas, loopback, origens, ativo, criado, por, mudado?}}}

import { aleatorio, json, kv, lerJson, sha256 } from "./comum.js";
import { APPS, CLIENTES, KO, dadosParaIntegrar, registroDoKV } from "./oidc.js";
import { camposDoApp as camposBasicos, camposDoCliente, emailsLimpos, modoDeAcesso } from "./oidc-campos.js";
import { acaoDaEquipe, terceirosParaPainel } from "./integracoes.js";

export { origemValida, voltaValida } from "./oidc-campos.js";
export const TIPOS_OAUTH = ["oauth.app", "oauth.cliente"];
export const chaveDoRegistro = (env) => KO(env).registro;

const temChave = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
const iso = (ms) => new Date(ms).toISOString();
const ID_APP = /^[a-z0-9][a-z0-9-]{1,30}$/;
const ID_CLIENTE = /^[a-z0-9][a-z0-9-]{2,62}$/;
// "u-..." e dos aplicativos cadastrados no Atos Workspace (worker/integracoes.js).
const DE_TERCEIRO = /^u-/;

/* Os campos de um aplicativo da equipe: os de todo aplicativo e quem pode entrar (sem dizer, "liberados": so quem o
   criou e a lista). */
function camposDoApp(d) {
  const f = camposBasicos(d);
  if (f.erro) return f;
  const e = emailsLimpos(d.liberados);
  if (e.erro) return { erro: e.erro };
  return { ...f, acesso: modoDeAcesso(d.acesso), liberados: e.emails };
}

/* O que um oauth.app ou oauth.cliente pede faz sentido agora? "" se sim; senao, o motivo. */
export async function conferirOAuth(env, tipo, d, reg) {
  reg = reg || (await registroDoKV(env));
  const acao = String(d.acao || "");
  const id = String(d.id || "");
  if (tipo === "oauth.app") {
    if (!["criar", "editar", "apagar"].includes(acao)) return "o que fazer com o aplicativo? (criar, editar ou apagar)";
    if (!ID_APP.test(id)) return "o id do aplicativo: 2 a 31 letras minúsculas, números e hífen";
    if (DE_TERCEIRO.test(id)) return "ids que começam com u- são dos aplicativos cadastrados no Atos Workspace: escolha outro";
    if (temChave(APPS, id)) return "o aplicativo " + id + " é do código: não muda por aqui";
    if (acao === "criar" && temChave(reg.apps, id)) return "já existe um aplicativo " + id;
    if (acao !== "criar" && !temChave(reg.apps, id)) return "o aplicativo " + id + " não existe";
    // Apagar o aplicativo leva os clientes dele (a tela diz quais antes de pôr na fila).
    if (acao === "apagar") return "";
    const f = camposDoApp(d);
    return f.erro || "";
  }
  if (tipo === "oauth.cliente") {
    if (!["criar", "editar", "ligar", "desligar", "apagar"].includes(acao)) return "o que fazer com o cliente? (criar, editar, ligar, desligar ou apagar)";
    if (!ID_CLIENTE.test(id)) return "o client_id: 3 a 63 letras minúsculas, números e hífen";
    if (DE_TERCEIRO.test(id)) return "client_ids que começam com u- são dos aplicativos cadastrados no Atos Workspace: escolha outro";
    if (temChave(CLIENTES, id)) return "o cliente " + id + " é do código: não muda por aqui";
    if (acao === "criar") {
      if (temChave(reg.clientes, id)) return "já existe um cliente " + id;
      const app = String(d.app || "");
      if (!temChave(APPS, app) && !temChave(reg.apps, app)) return "o aplicativo " + (app || "(nenhum)") + " não existe";
      if (!["publico", "confidencial"].includes(d.tipo)) return "o tipo do cliente: publico (página ou programa, com PKCE) ou confidencial (servidor, com segredo)";
    } else if (!temChave(reg.clientes, id)) return "o cliente " + id + " não existe";
    if (acao === "editar") {
      const antes = reg.clientes[id];
      if (d.app !== undefined && d.app !== antes.app) return "o aplicativo de um cliente não muda: crie outro cliente";
      if (d.tipo !== undefined && d.tipo !== antes.tipo) return "o tipo de um cliente não muda: crie outro cliente";
    }
    if (acao === "criar" || acao === "editar") {
      const f = camposDoCliente(d);
      return f.erro || "";
    }
    return "";
  }
  return "alteração desconhecida";
}

async function guardarRegistro(env, reg) {
  await env.CONTAS.put(chaveDoRegistro(env), JSON.stringify(reg));
}

/* Aplica na publicacao da fila (worker/admin.js). Volta {} ou {nao_volta} (o que retroagir nao desfaz). */
export async function aplicarOAuth(env, tipo, d, por, agora) {
  const reg = await registroDoKV(env);
  const erro = await conferirOAuth(env, tipo, d, reg);
  if (erro) throw new Error(erro);
  const id = String(d.id);
  const acao = d.acao;
  if (tipo === "oauth.app") {
    let r = {};
    if (acao === "apagar") {
      delete reg.apps[id];
      const semSegredo = [];
      for (const c of Object.keys(reg.clientes)) {
        if (!reg.clientes[c] || reg.clientes[c].app !== id) continue;
        if (await kv(env, KO(env).segredo(c))) semSegredo.push(c);
        delete reg.clientes[c];
        await env.CONTAS.delete(KO(env).segredo(c));
      }
      if (semSegredo.length) r = { nao_volta: "o segredo de " + semSegredo.join(", ") + " não volta: gere outro no Login Atos" };
    } else {
      const f = camposDoApp(d);
      const antes = reg.apps[id] || {};
      reg.apps[id] = acao === "criar" ? { ...f, criado: iso(agora), por } : { ...antes, ...f, mudado: iso(agora) };
    }
    await guardarRegistro(env, reg);
    return r;
  }
  let r = {};
  if (acao === "apagar") {
    const tinhaSegredo = Boolean(await kv(env, KO(env).segredo(id)));
    delete reg.clientes[id];
    await env.CONTAS.delete(KO(env).segredo(id));
    if (tinhaSegredo) r = { nao_volta: "o segredo do cliente " + id + " não volta: gere outro no Login Atos" };
  } else if (acao === "ligar" || acao === "desligar") {
    reg.clientes[id] = { ...reg.clientes[id], ativo: acao === "ligar", mudado: iso(agora) };
  } else {
    const f = camposDoCliente(d);
    reg.clientes[id] = acao === "criar"
      ? { app: String(d.app), tipo: d.tipo, ...f, ativo: true, criado: iso(agora), por }
      : { ...reg.clientes[id], ...f, mudado: iso(agora) };
  }
  await guardarRegistro(env, reg);
  return r;
}

// ------------------------------------------------------------------ as rotas

async function tela(env) {
  const doKV = await registroDoKV(env);
  const apps = [
    ...Object.entries(APPS).map(([id, a]) => ({ id, nome: a.nome, descricao: a.descricao, site: a.site, privacidade: a.privacidade, termos: a.termos, icone: a.icone, codigo: true,
      acesso: modoDeAcesso(a.acesso), liberados: [] })),
    ...Object.entries(doKV.apps).filter(([id]) => !temChave(APPS, id)).map(([id, a]) => ({
      id, nome: a.nome, descricao: a.descricao, site: a.site, privacidade: a.privacidade, termos: a.termos, icone: a.icone || "", criado: a.criado || null, por: a.por || "", mudado: a.mudado || null, codigo: false,
      acesso: modoDeAcesso(a.acesso), liberados: Array.isArray(a.liberados) ? a.liberados : [],
    })),
  ];
  const clientes = Object.entries(CLIENTES).map(([id, c]) => ({
    id, app: c.app, tipo: "publico", voltas: c.voltas || [], loopback: Boolean(c.loopback), padrao: c.padraoTexto || "", origens: c.origens || [], ativo: true, codigo: true, segredo: null,
  }));
  for (const [id, c] of Object.entries(doKV.clientes)) {
    if (temChave(CLIENTES, id) || !c) continue;
    const s = c.tipo === "confidencial" ? await kv(env, KO(env).segredo(id)) : null;
    clientes.push({
      id, app: c.app, tipo: c.tipo, voltas: c.voltas || [], loopback: Boolean(c.loopback), padrao: "", origens: c.origens || [], ativo: c.ativo !== false,
      criado: c.criado || null, por: c.por || "", mudado: c.mudado || null, codigo: false, segredo: s ? { quando: s.quando, por: s.por } : null,
    });
  }
  // Os de terceiros (Atos Workspace > Integracoes), com o dono de cada um e o Workspace dele: a equipe desliga ou apaga por abuso.
  return { ...dadosParaIntegrar(env), apps, clientes, terceiros: await terceirosParaPainel(env) };
}

/* Gera (ou troca) o segredo de um cliente confidencial do KV: o valor volta uma vez so; fica o hash. */
async function gerarSegredo(env, id, d, c) {
  if (d.confirmar !== true) return json({ erro: "confirme na página: o segredo anterior (se houver) para de valer na hora" }, 400);
  if (temChave(CLIENTES, id)) return json({ erro: "os clientes do código são públicos: não têm segredo" }, 400);
  const reg = await registroDoKV(env);
  const cli = temChave(reg.clientes, id) ? reg.clientes[id] : null;
  if (!cli) return json({ erro: "o cliente " + id + " não existe (se acabou de criar, confirme a fila antes)" }, 404);
  if (cli.tipo !== "confidencial") return json({ erro: "este cliente é público: usa PKCE, sem segredo" }, 400);
  const antes = await kv(env, KO(env).segredo(id));
  const segredo = "atos_cs_" + aleatorio(32);
  const quando = iso(c.agora);
  await env.CONTAS.put(KO(env).segredo(id), JSON.stringify({ hash: await sha256(segredo), quando, por: c.quem.email }));
  // O registro de quem gerou e quando (os ultimos 100), sem o valor.
  const log = (await kv(env, KO(env).log)) || [];
  log.unshift({ quando, por: c.quem.email, cliente: id, acao: antes ? "trocou o segredo" : "gerou o segredo" });
  await env.CONTAS.put(KO(env).log, JSON.stringify(log.slice(0, 100)));
  return json({ segredo, quando, trocado: Boolean(antes) });
}

export async function atenderOAuthPainel(request, env, url, c) {
  const p = url.pathname;
  const m = request.method;
  if (p === "/api/admin/oauth" && m === "GET") return json(await tela(env));
  if (p === "/api/admin/oauth/log" && m === "GET") return json({ log: (await kv(env, KO(env).log)) || [] });
  const r = p.match(/^\/api\/admin\/oauth\/clientes\/([a-z0-9-]{3,63})\/segredo$/);
  if (r && m === "POST") return gerarSegredo(env, r[1], (await lerJson(request)) || {}, c);
  const t = p.match(/^\/api\/admin\/oauth\/terceiros\/(u-[a-z0-9]{10})\/(desligar|ligar|apagar)$/);
  if (t && m === "POST") return acaoDaEquipe(env, t[1], t[2], (await lerJson(request)) || {}, c.quem, c.agora);
  return json({ erro: "rota não existe" }, 404);
}
