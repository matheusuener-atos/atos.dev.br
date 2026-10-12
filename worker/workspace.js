// O Atos Workspace (atos.dev.br/workspace; a tela e public/assets/workspace.js): o produto da Atos para quem constroi
// sistemas com a Conta Atos. A Conta Atos e a identidade e a carteira da pessoa (entrar, assinar, pagar); o Workspace e
// o que ela ativa para construir. Hoje ele inclui o Login Atos para os sistemas dela (Integracoes; worker/integracoes.js)
// e o e-mail Atos (um endereco @atos.dev.br que encaminha; worker/email-atos.js, quando ligado na Atos).
//
// O produto esta no catalogo da Atos Cobranca (cobranca/catalogo.js, "workspace": gratuito, com a versao dos termos).
// Ativar nao passa pelo Mercado Pago: e a pessoa, com login recente, aceitando os termos do Workspace. A ativacao e o
// direito ao produto no objeto do cliente (cobranca/cliente.js, direito:workspace, ops ativar e desativar), o mesmo
// registro dos produtos pagos: consistencia forte (desativar vale no proximo pedido, sem a demora do KV), um
// Durable Object por Worker (o de teste tem os seus), e um plano pago, depois, estende esse mesmo direito.
//
// Desativar: os aplicativos que a pessoa cadastrou continuam funcionando para quem entra neles (quem usa o sistema
// dela nao e pego de surpresa), mas ela nao ve nem muda mais nenhum deles ate ativar de novo (as rotas
// /api/integracoes* respondem 403). Para ninguem mais entrar, ela desliga os acessos ou apaga os aplicativos antes.
// A tela diz isso antes do "Desativar". A equipe da Atos continua podendo desligar ou apagar qualquer um.
//
// Rotas (so a propria pagina; a sessao da Conta Atos):
//   GET  /api/workspace              {conta, recente, limites, produto, termos (os atuais), ativo, ativado, desativado,
//                                     aceito: {versao, quando}|null, suspenso: null|{quando, motivo}, apps (quantos a conta cadastrou), email: {disponivel},
//                                     alias: null|{endereco, suspenso, confirmado}, via_alias, pendencia (estadoDoAlias)}
// A ativacao, os termos e o desativar abrem com qualquer login (o e-mail pessoal ou o alias); o resto da area (as
// Integracoes) pede o que estadoDoAlias diz.
//   POST /api/workspace/ativar       {aceito: true, versao} a versao dos termos que a pessoa leu (tem de ser a atual)
//   POST /api/workspace/desativar    {confirmar: true}
// Mudar pede login das ultimas 12 horas (o mesmo das Integracoes e do painel).
//
// O indice da equipe (worker/workspace-indice.js): ativar, desativar e abrir a area anotam a conta no indice que o
// painel lista (Atos Workspace > Contas do Workspace).
//
// A suspensao (da equipe, por abuso; worker/admin-workspace.js): fica no mesmo direito (suspenso: {quando, motivo,
// por}); com ela, as Integracoes e as mudancas no e-mail Atos respondem 403 {codigo: "workspace_suspenso"} e a area
// mostra o motivo. Ativar, desativar e aceitar termos novos continuam abrindo, e nao tiram a suspensao.

import { json, kv, lerJson } from "./comum.js";
import { sessaoDe } from "./contas.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { cliente, idDoCliente } from "./cobranca/cliente.js";
import { ID_APP_TERCEIRO, KO } from "./oidc.js";
import { aliasDaConta, emailAtosLigado } from "./email-atos.js";
import { anotarNoIndice } from "./workspace-indice.js";

export const WORKSPACE = "workspace";
/* Para onde a tela /workspace/entrar volta: so um caminho de /workspace/ (sem consulta), nunca a propria tela de entrar.
   O mesmo em public/assets/workspace-entrar.js. */
export const VOLTA_DO_WORKSPACE = /^\/workspace(?:\/(?!entrar(?:\/|$))[a-z0-9-]+)*\/?$/;
const RECENTE_H = 12;
const RECENTE_S = RECENTE_H * 3600;

export function termosDoWorkspace() {
  return { ...PRODUTOS[WORKSPACE].termos };
}

/* O direito ao Workspace de uma conta (o registro do objeto do cliente), ou null se ela nunca ativou. Sem o objeto
   (sem o binding CLIENTES), lanca: quem chama responde 503, nunca "ativo" nem "inativo" por engano. */
export async function workspaceDe(env, sub) {
  if (!env.CLIENTES) throw new Error("sem o registro dos clientes (CLIENTES)");
  const r = await cliente(env, await idDoCliente(sub)).pedir("direito", { produto: WORKSPACE });
  if (!r || !r.ok) throw new Error((r && r.erro) || "o registro do cliente não respondeu");
  return r.direito || null;
}

export async function workspaceAtivo(env, sub) {
  const d = await workspaceDe(env, sub);
  return Boolean(d && d.ativo);
}

/* O que a tela e as rotas mostram da ativacao (sem o historico inteiro). */
export function vistaDoWorkspace(d) {
  return {
    ativo: Boolean(d && d.ativo), ativado: (d && d.ativo && d.ativado) || null, desativado: (d && !d.ativo && d.desativado) || null,
    aceito: d && d.termos ? { versao: d.termos.versao, quando: d.termos.aceito } : null,
    // Suspenso pela equipe da Atos (worker/admin-workspace.js): a gestao para; a pessoa ve quando e o motivo.
    suspenso: d && d.suspenso ? { quando: d.suspenso.quando, motivo: d.suspenso.motivo || "" } : null,
  };
}

/* O 403 de quem esta com o Workspace suspenso pela equipe. */
export const WORKSPACE_SUSPENSO = (s) => json({
  erro: "a Atos suspendeu o seu Atos Workspace" + (s && s.motivo ? " (" + s.motivo + ")" : "") + ": enquanto durar, você não cadastra nem muda sistemas nem o e-mail Atos. Escreva para contato@atos.dev.br",
  codigo: "workspace_suspenso", suspenso: s ? { quando: s.quando, motivo: s.motivo || "" } : null,
}, 403);

export const SEM_WORKSPACE = () => json({ erro: "ative o Atos Workspace para cadastrar e mudar os seus sistemas (atos.dev.br/workspace)", workspace: false, codigo: "workspace" }, 403);

/* O e-mail Atos de quem esta com a sessao, como o Workspace o exige (decisoes de 11/10/2026):
     - quem tem o alias (existe e nao esta suspenso) usa o Workspace so tendo ENTRADO PELO ALIAS (a sessao com via
       "alias" e o mesmo nome); a ativacao, os termos e a guia E-mail Atos abrem com qualquer login;
     - cadastrar e gerir sistemas (as Integracoes) pede o alias com o destino confirmado (o codigo da Atos e a
       verificacao da Cloudflare) e a sessao pelo alias.
   {alias: null|{endereco, suspenso, confirmado}, via_alias, pendencia: null|"sem_alias"|"alias_nao_confirmado"|
   "entrar_pelo_alias"}. Lanca se o registro do e-mail Atos nao responde. */
export async function estadoDoAlias(env, sessao) {
  const a = await aliasDaConta(env, sessao.sub);
  const via = Boolean(a && sessao.via === "alias" && sessao.alias === a.alias);
  let pendencia = null;
  if (!a || a.suspenso) pendencia = "sem_alias";
  else if (!a.confirmado) pendencia = "alias_nao_confirmado";
  else if (!via) pendencia = "entrar_pelo_alias";
  return { alias: a ? { endereco: a.endereco, suspenso: a.suspenso, confirmado: a.confirmado } : null, via_alias: via, pendencia };
}

/* O 403 das Integracoes para cada pendencia do e-mail Atos (o codigo diz qual; a mensagem, o passo seguinte). */
export function recusaDoAlias(e, ligado) {
  const a = e.alias;
  if (e.pendencia === "sem_alias") {
    if (a && a.suspenso) return json({ erro: "a Atos suspendeu o seu e-mail Atos (" + a.endereco + "): sem ele, as Integrações ficam paradas. Escreva para contato@atos.dev.br", codigo: "sem_alias", suspenso: true }, 403);
    return json({ erro: ligado ? "crie o seu e-mail Atos para cadastrar sistemas (atos.dev.br/workspace/email)" : "o cadastro de sistemas pede o e-mail Atos, que ainda está em preparação na Atos", codigo: "sem_alias", disponivel: ligado }, 403);
  }
  if (e.pendencia === "alias_nao_confirmado") return json({ erro: "confirme o destino do seu e-mail Atos (" + a.endereco + ": o código da Atos e o e-mail da Cloudflare) para cadastrar sistemas", codigo: "alias_nao_confirmado", alias: a.endereco }, 403);
  return json({ erro: "entre com " + a.endereco + " para usar o Workspace (você entrou com o e-mail pessoal)", codigo: "entrar_pelo_alias", alias: a.endereco }, 403);
}
export const WORKSPACE_FORA = () => json({ erro: "não deu para conferir o Atos Workspace agora: tente de novo em instantes" }, 503);

export function ehRotaDoWorkspace(url) {
  return url.pathname === "/api/workspace" || url.pathname.startsWith("/api/workspace/");
}

async function quantosApps(env, sub) {
  const l = await kv(env, KO(env).dono(sub));
  return Array.isArray(l) ? l.filter((x) => ID_APP_TERCEIRO.test(String(x))).length : 0;
}

export async function atenderWorkspace(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  const sessao = await sessaoDe(request, env);
  if (!sessao) return json({ erro: "entre na sua conta", entrar: true }, 401);
  const recente = agora / 1000 - sessao.auth_time < RECENTE_S;
  const termos = termosDoWorkspace();
  const meu = () => idDoCliente(sessao.sub).then((id) => cliente(env, id, { sub: sessao.sub, email: sessao.email }));
  const tela = async (d) => json({
    conta: { email: sessao.email }, recente, limites: { recente_h: RECENTE_H }, produto: { id: WORKSPACE, nome: PRODUTOS[WORKSPACE].nome, gratuito: true },
    termos, ...vistaDoWorkspace(d), apps: await quantosApps(env, sessao.sub),
    // O e-mail Atos (worker/email-atos.js): ligado neste Worker? (a guia diz "em preparacao" sem ele) E o alias da conta,
    // por onde a sessao entrou e o que falta para as Integracoes (estadoDoAlias).
    email: { disponivel: emailAtosLigado(env) }, ...(await estadoDoAlias(env, sessao)),
  });
  if (!env.CLIENTES) return WORKSPACE_FORA();
  const p = url.pathname;

  if (p === "/api/workspace" && request.method === "GET") {
    let d;
    try { d = await workspaceDe(env, sessao.sub); } catch { return WORKSPACE_FORA(); }
    // A auto-indexacao (worker/workspace-indice.js): quem ativou antes do indice entra nele ao abrir a area.
    await anotarNoIndice(env, sessao.sub, sessao.email, d, "visita");
    try { return await tela(d); } catch { return WORKSPACE_FORA(); }
  }
  if (p !== "/api/workspace/ativar" && p !== "/api/workspace/desativar") return json({ erro: "rota não existe" }, 404);
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);
  if (!recente) return json({ erro: "para ativar ou desativar o Atos Workspace, entre de novo (o login precisa ser das últimas " + RECENTE_H + " horas)", reentrar: true }, 401);
  const corpo = await lerJson(request);
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return json({ erro: "pedido inválido" }, 400);

  if (p === "/api/workspace/ativar") {
    if (corpo.aceito !== true) return json({ erro: "para ativar, aceite os termos do Atos Workspace" }, 400);
    if (corpo.versao !== termos.versao) return json({ erro: "os termos do Atos Workspace mudaram: leia a versão atual e aceite de novo", termos }, 409);
    const r = await (await meu()).pedir("ativar", { produto: WORKSPACE, termos: { versao: termos.versao } });
    if (!r || !r.ok) return WORKSPACE_FORA();
    await anotarNoIndice(env, sessao.sub, sessao.email, r.direito, "ativacao");
    try { return await tela(r.direito); } catch { return WORKSPACE_FORA(); }
  }
  if (corpo.confirmar !== true) return json({ erro: "confirme na página: os aplicativos continuam funcionando, mas você só volta a mudá-los ativando de novo" }, 400);
  const r = await (await meu()).pedir("desativar", { produto: WORKSPACE });
  if (!r || !r.ok) return WORKSPACE_FORA();
  await anotarNoIndice(env, sessao.sub, sessao.email, r.direito, "ativacao");
  try { return await tela(r.direito); } catch { return WORKSPACE_FORA(); }
}
