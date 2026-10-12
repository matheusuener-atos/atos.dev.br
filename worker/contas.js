// A conta Atos: e-mail e senha, a sessao em atos.dev.br e as paginas /entrar e
// /conta. A conta e o proprio e-mail da pessoa (nenhum endereco @atos.dev.br e
// criado).
//
// As contas sao as mesmas que o PAVLVS criava por e-mail e senha desde
// 07/10/2026: o KV CONTAS e o mesmo namespace do KV APOIOS do Worker do PAVLVS
// (paulus.ia.br) e a chave e a mesma ("id:conta:<email>" -> {sub, sal, hash,
// iteracoes, nome, criada}). Por isso quem ja tinha conta PAVLVS por senha ja
// tem conta Atos, com o mesmo sub - e a assinatura do PAVLVS continua dela.
// Enquanto os PAULUS instalados nao atualizarem, o Worker do PAVLVS ainda
// atende /api/id/* com as mesmas chaves; o formato tem de ficar igual nos dois.
//
//   POST /api/entrar     {email, senha}          abre a sessao
//   POST /api/cadastrar  {email, senha, nome?}   manda um codigo de 6 digitos ao e-mail
//   POST /api/confirmar  {email, codigo}         cria a conta e abre a sessao
//   POST /api/esqueci    {email}                 manda um codigo para trocar a senha
//   POST /api/redefinir  {email, codigo, senha}  troca a senha e abre a sessao
//   POST /api/sair                               fecha a sessao deste navegador
//   GET  /api/eu                                 {conta: {email, nome, via, alias?} | null}
//   POST /api/nome       {nome}                  troca o nome de quem esta dentro
//
// entrar, esqueci e redefinir aceitam {workspace: true} (a tela /workspace/entrar): so o endereco Atos passa; outro
// e-mail responde 400 {codigo: "so_alias"} sem consulta nenhuma.
//
// A sessao: um segredo aleatorio no cookie __Host-atos (HttpOnly, Secure,
// SameSite=Lax), e no KV so o SHA-256 dele ("atos:sessao:<hash>"), 30 dias.
// As respostas de cadastrar e esqueci sao sempre as mesmas, exista ou nao a
// conta. Errar a senha ou o codigo conta por e-mail: depois de TENTATIVAS,
// espera BLOQUEIO_S.
//
// O endereco Atos (<alias>@atos.dev.br, worker/email-atos.js) tambem entra: e um identificador a mais da MESMA conta,
// com a mesma senha, valendo enquanto o alias existe e nao esta suspenso (nao depende do encaminhamento ligado). A
// sessao guarda por onde a pessoa entrou (via: "alias", e o nome do alias; o sub e o e-mail sao os da conta); o Atos
// Workspace usa isso (worker/workspace.js). "Esqueci a senha" pelo alias manda o codigo ao e-mail cadastrado da conta,
// nunca ao alias, e a resposta diz para onde, mascarado (p***@gmail.com). Os enderecos @atos.dev.br nao viram conta nova.
//
// O sub: se o mesmo e-mail ja entrou no PAVLVS com o Google (o indice
// "id:google:<email>", anotado pelo Worker do PAVLVS), a conta nova usa aquele
// sub - e a mesma conta. Senao, um sub novo "pv-<hex>" (o prefixo ficou do
// PAVLVS; trocar mudaria o sub de quem ja tem conta).

// A segunda etapa (worker/seguranca/etapa.js): com a verificacao em duas etapas (o aplicativo autenticador ou uma chave de
// acesso), a senha certa - e o codigo do "Esqueci a senha", e o codigo do cadastro numa conta que ja existia - nao abre
// a sessao: responde {etapa: {otp, recuperacao, chave}} com o cookie da etapa, e a pagina pede "Confirme que e voce"
// (POST /api/segunda-etapa, worker/seguranca.js). A troca de senha acontece mesmo assim (quem tem o codigo do e-mail
// troca a senha), mas entrar ainda pede a segunda etapa.
//
// A sessao guarda tambem como a pessoa entrou (como: senha, alias, google, cadastro, redefinir, chave), o amr (RFC 8176:
// vai no id_token), mfa (passou pela segunda etapa, ou entrou com a chave de acesso) e quando, e criada (ms). "Sair de
// todas as outras" (Minha conta > Seguranca) anota na conta o instante (sessoes_desde; sessoes_desde_teste no Worker de
// teste) e toda sessao criada antes cai aqui.

import { aleatorio, deHex, emailValido, hex, iguais, json, kv, lerJson, limparNome, normal, sha256 } from "./comum.js";
import { enviarEmail } from "./email.js";
import { googleLigado } from "./google.js";
import { DOMINIO, aliasDoTexto, aliasParaEntrar } from "./email-atos.js";
import { AMR, exigeSegunda, iniciarEtapa, respostaDaEtapa } from "./seguranca/etapa.js";
import { anotar, indexarSessao } from "./seguranca/atividade.js";
import { avisar } from "./seguranca/avisos.js";
import { listaDaEquipe } from "./admin.js";

const ITERACOES = 30000;
const MIN_SENHA = 10;
const CODIGO_S = 15 * 60;
const TENTATIVAS = 8;
const BLOQUEIO_S = 15 * 60;
export const SESSAO_S = 30 * 24 * 3600;
export const COOKIE = "__Host-atos";

const te = new TextEncoder();

async function resumoDaSenha(senha, sal, iteracoes = ITERACOES) {
  const chave = await crypto.subtle.importKey("raw", te.encode(String(senha)), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: deHex(sal), iterations: iteracoes }, chave, 256));
}

export function conferirSenha(senha) {
  const s = String(senha || "");
  if (s.length < MIN_SENHA) return "a senha precisa ter pelo menos " + MIN_SENHA + " caracteres";
  if (s.length > 200) return "a senha pode ter no máximo 200 caracteres";
  if (!/[a-zA-ZÀ-ÿ]/.test(s) || !/[0-9]/.test(s)) return "use letras e números na senha";
  return "";
}

const codigo6 = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
const novoSub = () => "pv-" + hex(crypto.getRandomValues(new Uint8Array(12)));

// ---------------------------------------------------------------- a sessao

export function lerCookie(request, nome) {
  for (const parte of (request.headers.get("cookie") || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return "";
}

/* {sub, email, nome, auth_time, via, alias} de quem esta com a sessao aberta neste navegador; ou null. `email` e sempre
   o e-mail da conta (o principal); `via` diz por qual identificador a pessoa entrou: "alias" (o endereco Atos, e
   `alias` e o nome dele) ou "email" (o e-mail da conta, o Google, o cadastro). */
export async function sessaoDe(request, env) {
  const segredo = lerCookie(request, COOKIE);
  if (!segredo || segredo.length > 100) return null;
  return sessaoPorHash(env, await sha256(segredo));
}

/* A sessao pelo hash do segredo (o FedCM chega por outro cookie, worker/fedcm.js), com as mesmas conferencias. */
export async function sessaoPorHash(env, h) {
  if (!/^[0-9a-f]{64}$/.test(String(h || ""))) return null;
  const s = await kv(env, "atos:sessao:" + h);
  if (!s || !s.sub || !s.email) return null;
  // A conta pode ter trocado de nome; o sub e o e-mail nao mudam.
  const c = await kv(env, "id:conta:" + s.email);
  if (!c || c.sub !== s.sub) return null;
  // Senha trocada depois de a sessao abrir: a sessao cai (a troca fecha as outras).
  if (c.trocada && s.auth_time * 1000 < Date.parse(c.trocada) - 1000) return null;
  // "Sair de todas as outras": as sessoes criadas antes do instante anotado caem.
  const desde = Number(c[campoSessoesDesde(env)]) || 0;
  const criada = Number(s.criada) || s.auth_time * 1000;
  if (desde && criada < desde) return null;
  const peloAlias = s.via === "alias" && typeof s.alias === "string" && s.alias;
  return {
    sub: s.sub, email: s.email, nome: c.nome || "", auth_time: s.auth_time, via: peloAlias ? "alias" : "email", alias: peloAlias ? s.alias : "",
    como: s.como || "", amr: Array.isArray(s.amr) ? s.amr : null, mfa: s.mfa === true, mfa_em: s.mfa_em || 0, criada, h,
  };
}

/* O campo da conta com o instante do "Sair de todas as outras": um por Worker (as sessoes do teste nao derrubam as da
   producao, e vice-versa; o KV e o mesmo). */
export const campoSessoesDesde = (env) => (env && env.AMBIENTE === "teste" ? "sessoes_desde_teste" : "sessoes_desde");

/* Abre a sessao de `conta` ({sub, email: o principal, alias?: quando entrou pelo endereco Atos}). `info`: {como, amr,
   mfa, segunda (o metodo da segunda etapa), request (o lugar e o navegador do registro de acessos)}. */
export async function abrirSessao(env, conta, agora, info = {}) {
  // O Worker de teste usa as mesmas contas da producao, sem a segunda etapa dela: so a equipe entra la (qualquer
  // caminho - senha, alias, Google, chave de acesso, redefinir - passa por aqui).
  if (!(await equipeNoTeste(env, conta.email))) throw new Error("o ambiente de teste aceita só a equipe da Atos");
  const segredo = aleatorio(32);
  const auth_time = Math.floor(agora / 1000);
  const como = info.como || (conta.alias ? "alias" : "senha");
  const s = {
    sub: conta.sub, email: conta.email, auth_time, criada: agora, como, amr: info.amr || AMR[como] || [],
    ...(info.mfa ? { mfa: true, mfa_em: agora } : {}), ...(conta.alias ? { via: "alias", alias: conta.alias } : {}),
  };
  const h = await sha256(segredo);
  await env.CONTAS.put("atos:sessao:" + h, JSON.stringify(s), { expirationTtl: SESSAO_S });
  await indexarSessao(env, conta.sub, h, { como, segunda: info.segunda || "" }, agora, info.request);
  await anotar(env, conta.sub, { tipo: "entrada", como, ...(info.segunda ? { segunda: info.segunda } : {}) }, agora, info.request);
  return COOKIE + "=" + segredo + "; Path=/; Max-Age=" + SESSAO_S + "; HttpOnly; Secure; SameSite=Lax";
}

/* No Worker de teste (AMBIENTE "teste"), so a equipe dele (worker/admin.js, listaDaEquipe: atos-teste:admin:equipe ou a
   semente ATOS_EQUIPE do env.teste). Fora do teste, sempre true. */
export async function equipeNoTeste(env, email) {
  if (!env || env.AMBIENTE !== "teste") return true;
  const e = normal(email);
  return (await listaDaEquipe(env)).some((x) => x.email === e);
}
const SO_EQUIPE = () => json({ erro: "o ambiente de teste da Atos aceita só a equipe", codigo: "so_equipe" }, 403);

/* Entra (abre a sessao) ou, se a conta tem a segunda etapa, comeca a etapa. `corpo`: a resposta de quem entrou. */
async function entrarOuEtapa(env, request, agora, conta, como, corpo) {
  if (await exigeSegunda(env, conta.sub, agora)) {
    const { ok, ...resto } = corpo;
    return respostaDaEtapa(await iniciarEtapa(env, conta, como, agora), resto);
  }
  return comSessao(corpo, await abrirSessao(env, conta, agora, { como, request }));
}

/* "pedro@gmail.com" -> "p***@gmail.com": o e-mail cadastrado, mascarado (a tela do "Esqueci a senha" pelo alias). */
export function mascarar(email) {
  const e = normal(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return "";
  return e.charAt(0) + "***" + e.slice(at);
}

const cookieApagado = COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

function comSessao(dados, cookie) {
  return json(dados, 200, { "set-cookie": cookie });
}

// ---------------------------------------------------------- as tentativas

// A chave das tentativas: o e-mail da conta ("id:erros:<email>", a mesma do PAVLVS), ou, para quem digitou um endereco
// Atos (<alias>@atos.dev.br que nao e o e-mail de nenhuma conta), uma chave do alias neste Worker ("atos:erros-alias:"
// ou "atos-teste:erros-alias:" - o Worker de teste tem os proprios aliases). Contar o alias a parte (e nao no e-mail
// da conta dele) e o que impede descobrir, pelo bloqueio, de qual e-mail e um alias.
const chaveDeErros = (env, email, alias) => alias ? (env.AMBIENTE === "teste" ? "atos-teste:" : "atos:") + "erros-alias:" + alias : "id:erros:" + email;
async function bloqueado(env, email, alias) {
  const e = await kv(env, chaveDeErros(env, email, alias));
  return Boolean(e && e.n >= TENTATIVAS);
}
async function errou(env, email, alias) {
  const k = chaveDeErros(env, email, alias);
  const e = (await kv(env, k)) || { n: 0 };
  await env.CONTAS.put(k, JSON.stringify({ n: e.n + 1 }), { expirationTtl: BLOQUEIO_S });
}
const BLOQUEADO = "muitas tentativas erradas com este e-mail: espere 15 minutos e tente de novo";
export const SO_ALIAS = "no Workspace você entra com o seu endereço @" + DOMINIO;
const SEM_REGISTRO = () => json({ erro: "não deu para conferir agora: tente de novo em instantes" }, 503);

/* Quem digitou `email`: a conta com esse e-mail, ou - quando nenhuma conta tem esse e-mail e ele e um endereco Atos -
   o alias (que existe e nao esta suspenso) e a conta dele. {conta (o registro guardado ou null), email (o da conta),
   alias ("" ou o nome do alias digitado), peloAlias (o endereco tem forma de alias e nenhuma conta o tem)}. Lanca se o
   registro do e-mail Atos nao responde. `soAlias` (a tela do Workspace): o e-mail de uma conta nao conta, so o alias. */
async function quemDigitou(env, email, soAlias = false) {
  const direta = soAlias ? null : await kv(env, "id:conta:" + email);
  const alias = direta ? "" : aliasDoTexto(email);
  // Pela tela do Workspace, um @atos.dev.br fora do formato de alias (ou reservado) responde como alias inexistente.
  if (!alias) return { conta: direta, email, alias: "", peloAlias: soAlias };
  const a = await aliasParaEntrar(env, email);
  const c = a && a.conta ? await kv(env, "id:conta:" + a.conta) : null;
  if (!c || c.sub !== a.sub) return { conta: null, email, alias, peloAlias: true };
  return { conta: c, email: a.conta, alias, peloAlias: true };
}

// ---------------------------------------------------------------- as rotas

export function ehRotaDaConta(url) {
  return ["/api/entrar", "/api/cadastrar", "/api/confirmar", "/api/esqueci", "/api/redefinir", "/api/sair", "/api/eu", "/api/nome"].includes(url.pathname);
}

export async function atenderConta(request, env, url, deps = {}) {
  const p = url.pathname;
  const agora = (deps.agora || Date.now)();
  const mandar = deps.enviarEmail || enviarEmail;

  if (p === "/api/eu") {
    const s = await sessaoDe(request, env);
    return json({ conta: s ? { email: s.email, nome: s.nome, via: s.via, ...(s.alias ? { alias: s.alias + "@" + DOMINIO } : {}) } : null, google: googleLigado(env) });
  }
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);

  if (p === "/api/sair") {
    const segredo = lerCookie(request, COOKIE);
    if (segredo) await env.CONTAS.delete("atos:sessao:" + (await sha256(segredo)));
    return json({ ok: true }, 200, { "set-cookie": cookieApagado });
  }

  if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitas tentativas seguidas - espere um minuto" }, 429);
  const d = await lerJson(request);
  if (!d) return json({ erro: "pedido inválido" }, 400);
  // O Worker de teste: entrar, criar conta e trocar a senha so para a equipe, antes de olhar senha ou conta (a mesma
  // resposta para qualquer e-mail de fora - nada se aprende sobre as contas por aqui). O alias (@atos.dev.br de alguem)
  // nao entra no teste: a equipe usa o e-mail da conta.
  // O alias (@atos.dev.br de alguem) so se sabe de quem e depois de procurar: em entrar, esqueci e redefinir, a
  // conferencia e logo depois de achar a conta (antes da senha ou do codigo).
  const ehDominioAtos = normal(d.email).endsWith("@" + DOMINIO);
  if (["/api/entrar", "/api/cadastrar", "/api/confirmar", "/api/esqueci", "/api/redefinir"].includes(p) && !(await equipeNoTeste(env, d.email))
    && !(["/api/entrar", "/api/esqueci", "/api/redefinir"].includes(p) && ehDominioAtos)) {
    return SO_EQUIPE();
  }

  // O nome da conta (Minha conta > Resumo > Editar): so o de quem esta dentro.
  if (p === "/api/nome") {
    const s = await sessaoDe(request, env);
    if (!s) return json({ erro: "entre na sua conta" }, 401);
    const nome = limparNome(d.nome);
    if (nome.length < 2) return json({ erro: "diga o seu nome" }, 400);
    const c = await kv(env, "id:conta:" + s.email);
    if (!c || c.sub !== s.sub) return json({ erro: "entre na sua conta" }, 401);
    await env.CONTAS.put("id:conta:" + s.email, JSON.stringify({ ...c, nome }));
    return json({ ok: true, conta: { email: s.email, nome } });
  }

  const email = normal(d.email);
  if (!emailValido(email)) return json({ erro: "confira o e-mail" }, 400);

  // A tela do Atos Workspace (/workspace/entrar; public/assets/workspace-entrar.js) manda {workspace: true}: ali so entra o
  // endereco Atos. Outro e-mail e recusado antes de qualquer consulta (sem conferir a senha nem contar tentativa: a
  // resposta so depende do texto digitado, nao entrega se a conta existe). Um @atos.dev.br que nao e alias (uma conta
  // cujo e-mail e @atos.dev.br) segue como alias inexistente: a mesma resposta da senha errada.
  const soAlias = d.workspace === true && (p === "/api/entrar" || p === "/api/esqueci" || p === "/api/redefinir");
  if (soAlias && !email.endsWith("@" + DOMINIO)) return json({ erro: SO_ALIAS, codigo: "so_alias" }, 400);

  if (p === "/api/entrar") {
    // O e-mail da conta ou o endereco Atos dela (<alias>@atos.dev.br, a mesma senha). Alias inexistente, removido ou
    // suspenso responde o mesmo que a senha errada, com o mesmo limite de tentativas.
    let q;
    try { q = await quemDigitou(env, email, soAlias); } catch { return SEM_REGISTRO(); }
    // O Worker de teste: o alias de quem nao e da equipe recebe a mesma recusa, antes de conferir a senha.
    if (!(await equipeNoTeste(env, q.email || email))) return SO_EQUIPE();
    if (await bloqueado(env, email, q.peloAlias && q.alias)) return json({ erro: BLOQUEADO }, 429);
    // Conta so com o Google (sem senha) nao entra por senha: "Esqueci a senha" cria uma.
    const c = q.conta && q.conta.hash ? q.conta : null;
    // Sem conta, o mesmo trabalho de conferir (o tempo nao entrega quem existe).
    const resumo = await resumoDaSenha(String(d.senha || ""), c ? c.sal : "00".repeat(16), c ? c.iteracoes : ITERACOES);
    if (!c || !iguais(resumo, c.hash)) {
      await errou(env, email, q.peloAlias && q.alias);
      return json({ erro: "e-mail ou senha não conferem" }, 401);
    }
    await env.CONTAS.delete(chaveDeErros(env, email, q.peloAlias && q.alias));
    // A sessao lembra que entrou pelo alias (o sub e o e-mail continuam os da conta). Com a segunda etapa, ainda nao.
    try {
      return await entrarOuEtapa(env, request, agora, { sub: c.sub, email: q.email, alias: q.peloAlias ? q.alias : "" }, q.peloAlias ? "alias" : "senha",
        { ok: true, conta: { email: q.email, nome: c.nome || "" }, via: q.peloAlias ? "alias" : "email" });
    } catch {
      return SEM_REGISTRO();
    }
  }

  // Os enderecos @atos.dev.br sao do e-mail Atos (o alias de alguem, que entra na conta dele): nao viram conta nova.
  // Sem isso, quem recebe as mensagens de um alias criaria uma conta com ele (e o proximo dono do alias, depois da
  // quarentena, receberia o "Esqueci a senha" dela).
  if ((p === "/api/cadastrar" || p === "/api/confirmar") && email.endsWith("@" + DOMINIO)) {
    return json({ erro: "os endereços @" + DOMINIO + " são do e-mail Atos: crie a conta com o seu e-mail" }, 400);
  }

  if (p === "/api/cadastrar") {
    const falha = conferirSenha(d.senha);
    if (falha) return json({ erro: falha }, 400);
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const nome = limparNome(d.nome);
    if (await kv(env, "id:conta:" + email)) {
      // Ja tem conta: avisa no e-mail (so o dono do e-mail le), e a resposta e a mesma.
      await mandar(env, { para: email, assunto: "Você já tem conta Atos", titulo: "Você já tem conta",
        texto: "Alguém tentou criar uma conta Atos com este e-mail, que já tem conta. Se foi você, entre com a sua senha ou use \"Esqueci a senha\" em atos.dev.br/entrar. Se não foi, ignore este e-mail: nada mudou." });
      return json({ ok: true, enviado: true });
    }
    const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
    const cod = codigo6();
    await env.CONTAS.put("id:pend:" + email, JSON.stringify({ sal, hash: await resumoDaSenha(d.senha, sal), iteracoes: ITERACOES, nome,
      codigo: await sha256("cod:" + email + ":" + cod), criado: new Date(agora).toISOString() }), { expirationTtl: CODIGO_S });
    const e = await mandar(env, { para: email, assunto: "Seu código da Atos: " + cod, titulo: "Confirme o seu e-mail",
      texto: "O seu código para criar a conta Atos é " + cod + ". Ele vale 15 minutos.\n\nSe você não pediu, ignore este e-mail.", pre: "Código " + cod });
    if (e && e.ok === false) return json({ erro: e.erro || "o e-mail não saiu" }, 502);
    return json({ ok: true, enviado: true });
  }

  if (p === "/api/confirmar") {
    if (await bloqueado(env, email)) return json({ erro: BLOQUEADO }, 429);
    const pend = await kv(env, "id:pend:" + email);
    if (!pend || !iguais(await sha256("cod:" + email + ":" + String(d.codigo || "").trim()), pend.codigo)) {
      await errou(env, email);
      return json({ erro: pend ? "o código não confere" : "o código venceu: peça outro" }, 400);
    }
    // Criada por outro caminho enquanto o codigo andava (o PAVLVS antigo): entra nela.
    const ja = await kv(env, "id:conta:" + email);
    const google = ja ? null : await kv(env, "id:google:" + email);
    const conta = ja || { sub: google && google.sub ? String(google.sub) : novoSub(), sal: pend.sal, hash: pend.hash, iteracoes: pend.iteracoes, nome: pend.nome, criada: new Date(agora).toISOString() };
    if (!ja) await env.CONTAS.put("id:conta:" + email, JSON.stringify(conta));
    await env.CONTAS.delete("id:pend:" + email);
    await env.CONTAS.delete("id:erros:" + email);
    // A conta que ja existia pode ter a segunda etapa: o codigo do e-mail sozinho nao entra nela.
    try {
      return await entrarOuEtapa(env, request, agora, { sub: conta.sub, email }, "cadastro", { ok: true, conta: { email, nome: conta.nome || "" } });
    } catch {
      return SEM_REGISTRO();
    }
  }

  if (p === "/api/esqueci") {
    // Pelo endereco Atos, o codigo vai SEMPRE ao e-mail cadastrado da conta, nunca ao alias (que so encaminha, e pode
    // estar desligado ou apontando para outro lugar); a resposta diz para onde, mascarado.
    let q;
    try { q = await quemDigitou(env, email, soAlias); } catch { return SEM_REGISTRO(); }
    if (!(await equipeNoTeste(env, q.email || email))) return SO_EQUIPE();
    const destino = q.email;
    const c = q.conta;
    const google = c || q.peloAlias ? null : await kv(env, "id:google:" + destino);
    if (c || google) {
      const cod = codigo6();
      await env.CONTAS.put("id:rec:" + destino, JSON.stringify({ codigo: await sha256("rec:" + destino + ":" + cod) }), { expirationTtl: CODIGO_S });
      await mandar(env, { para: destino, assunto: "Código para " + (c ? "trocar a senha" : "criar a senha") + " da conta Atos: " + cod, titulo: c ? "Trocar a senha" : "Criar uma senha",
        texto: "O seu código para " + (c ? "trocar a senha" : "criar uma senha para") + " da conta Atos é " + cod + ". Ele vale 15 minutos." +
          (q.peloAlias ? "\n\nO pedido foi feito com o endereço " + q.alias + "@" + DOMINIO + ": o código vem sempre para o e-mail cadastrado da conta." : "") +
          "\n\nSe você não pediu, ignore este e-mail: a senha atual continua valendo.",
        pre: "Código " + cod });
    }
    if (q.peloAlias) return json({ ok: true, enviado: true, alias: true, ...(c ? { para: mascarar(destino) } : {}) });
    return json({ ok: true, enviado: true });
  }

  if (p === "/api/redefinir") {
    const falha = conferirSenha(d.senha);
    if (falha) return json({ erro: falha }, 400);
    let q;
    try { q = await quemDigitou(env, email, soAlias); } catch { return SEM_REGISTRO(); }
    if (!(await equipeNoTeste(env, q.email || email))) return SO_EQUIPE();
    const alvo = q.email;
    const k = q.peloAlias && q.alias;
    if (await bloqueado(env, email, k)) return json({ erro: BLOQUEADO }, 429);
    const rec = q.peloAlias && !q.conta ? null : await kv(env, "id:rec:" + alvo);
    if (!rec || !iguais(await sha256("rec:" + alvo + ":" + String(d.codigo || "").trim()), rec.codigo)) {
      await errou(env, email, k);
      return json({ erro: rec ? "o código não confere" : "o código venceu: peça outro" }, 400);
    }
    const antes = await kv(env, "id:conta:" + alvo);
    const google = antes ? null : await kv(env, "id:google:" + alvo);
    const sub = antes ? antes.sub : google && google.sub ? String(google.sub) : novoSub();
    const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
    const conta = { ...(antes || { criada: new Date(agora).toISOString(), nome: "" }), sub, sal, hash: await resumoDaSenha(d.senha, sal), iteracoes: ITERACOES, trocada: new Date(agora).toISOString() };
    await env.CONTAS.put("id:conta:" + alvo, JSON.stringify(conta));
    await env.CONTAS.delete("id:rec:" + alvo);
    await env.CONTAS.delete(chaveDeErros(env, email, k));
    await anotar(env, sub, { tipo: "mudanca", evento: "senha-trocada" }, agora, request);
    if (antes) await avisar(env, deps, alvo, "senha-trocada", { agora, request });
    // A troca fecha as outras sessoes (sessaoDe confere "trocada"); esta abre agora (pelo alias, se foi por ele). Com a
    // segunda etapa ligada, o "Esqueci a senha" nao a pula: a senha ja mudou, mas entrar ainda pede o codigo ou a chave.
    try {
      return await entrarOuEtapa(env, request, agora, { sub, email: alvo, alias: q.peloAlias ? q.alias : "" }, "redefinir",
        { ok: true, conta: { email: alvo, nome: conta.nome || "" }, via: q.peloAlias ? "alias" : "email" });
    } catch {
      return SEM_REGISTRO();
    }
  }

  return json({ erro: "rota não existe" }, 404);
}
