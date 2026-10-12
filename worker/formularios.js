// Atos Workspace > Formularios (atos.dev.br/workspace/formularios; a tela e public/assets/workspace-formularios.js): o
// formulario de contato de um site estatico. O dono cadastra o formulario (o nome, os sites de onde ele pode ser
// enviado, os campos aceitos) e recebe um endereco POST https://atos.dev.br/f/<id>. O site manda o formulario (HTML puro,
// <form action method=post>, ou fetch com JSON) e a Atos ENTREGA o conteudo no e-mail Atos do dono: um e-mail da Atos
// (naoresponda@atos.dev.br, pelo Resend) ao destino que o dono confirmou no alias. Nao passa pelo encaminhamento do alias
// (worker/email-atos.js): e a Atos mandando um aviso ao titular. Responder ao e-mail vai a quem preencheu (o Reply-To e
// o e-mail digitado no campo "email", quando ha um valido; a Atos nao confere esse endereco e o aviso diz isso).
//
// O que precisa estar de pe para a mensagem sair: o formulario ligado (pelo dono) e nao desligado pela equipe, o Atos
// Workspace do dono ativo e sem suspensao, e o alias dele existindo, sem suspensao, com o destino confirmado e o
// encaminhamento ligado (destinoDoTitular). Faltando um, quem envia ve "este formulario nao esta recebendo mensagens
// agora" e o registro anota o motivo.
//
// Contra spam (o que esta ligado sempre, e o que depende da configuracao da Atos):
//   - sempre: a origem (Origin, ou o Referer quando falta) tem de ser um dos sites cadastrados - o CORS do fetch e o
//     envio do HTML; o campo-armadilha "_armadilha" (o exemplo o traz escondido; quem o preenche recebe o "obrigado"
//     e nada sai); o limite por endereco de internet da Atos (o mesmo do login, LIMITE: 10 por minuto); 5 envios por
//     hora do mesmo endereco de internet em cada formulario (contado por um resumo do endereco com um sal do dia, que
//     some com a contagem); o limite diario do formulario (o dono escolhe, ate 200); o teto diario da Atos inteira
//     (FORMULARIOS_LIMITE_DIA, padrao 500, para nao estourar o envio do Resend); 32 KB por envio e o tamanho de cada
//     campo; arquivos sao ignorados.
//   - com TURNSTILE_SECRET (segredo) e TURNSTILE_SITEKEY (var publica) no Worker: o dono pode pedir a verificacao do
//     Cloudflare Turnstile. O widget da Atos so vale nos enderecos cadastrados nele (atos.dev.br), entao a verificacao
//     acontece numa pagina da propria Atos: o envio HTML para numa tela "confirme que voce nao e um robo" com o conteudo
//     num bilhete assinado (HMAC, 10 minutos; nada guardado), e segue quando o desafio passa. O envio por fetch/JSON de
//     um formulario com a verificacao ligada e recusado (400 codigo "verificacao"): o JSON nao tem como mostrar o desafio.
//     Sem o segredo, a opcao nao aparece e a tela diz o que esta valendo.
//
// O conteudo: a Atos NAO guarda o que foi preenchido. Ele passa pela memoria do Worker (e, com a verificacao, pelo
// bilhete na pagina de quem esta preenchendo) direto para o e-mail; se o envio falhar, quem preencheu ve o erro e pode
// tentar de novo, e nada fica. O Resend guarda a copia do e-mail que entregou, pelo prazo dele (a privacidade diz).
// O registro de cada formulario (30 dias) tem so: quando, o site de origem, o resultado (entregue, recusado, falhou,
// armadilha) e o motivo, e o tamanho - nunca o conteudo, o e-mail de quem enviou nem o endereco de internet.
//
// Os dados: worker/workspace-dados.js (o Durable Object WorkspaceDados). No objeto da conta:
//   form:<id>                 {id, nome, origens, campos, livres, redirecionar, limite_dia, turnstile, ativo,
//                              bloqueado: null|{quando, motivo, por}, criado, mudado}
//   flog:<id>|<iso>|<r>       {quando, origem, resultado, motivo, tamanho} 30 dias (ate 500 por formulario por dia)
// No objeto "indice":
//   fidx:<id>                 {sub, conta, nome, criado, bloqueado} (o POST publico acha o dono; o painel lista)
//   fstat:<id>|<dia>          {entregues, recusados} por dia (30 dias; o painel)
// Os contadores (cnt:*) sao os do objeto.
//
// Rotas do dono (a porta das Integracoes: Workspace ativo, e-mail Atos confirmado e a sessao por ele; mudar pede login
// das ultimas 12 horas):
//   GET  /api/workspace/formularios                 os formularios, os limites e o que esta ligado contra spam
//   GET  /api/workspace/formularios/:id/registro    o registro (30 dias)
//   POST /api/workspace/formularios                 {nome, origens, campos, livres, redirecionar, limite_dia, turnstile}
//   POST /api/workspace/formularios/:id             {acao: editar|ligar|desligar|apagar, ...}
// A rota publica:
//   OPTIONS|POST /f/<id>                            o envio (GET mostra o que e o endereco)
// O painel da equipe (worker/admin-workspace.js): ver todos, desligar e ligar de novo por abuso (dono e suporte).

import { b64url, deB64url, emailValido, hex, iguais, json, lerJson, sha256 } from "./comum.js";
import { portaoDoWorkspace, workspaceDe } from "./workspace.js";
import { destinoDoTitular } from "./email-atos.js";
import { enviarEmail as enviarPadrao } from "./email.js";
import { apagarAntigos, apagarPrefixo, daConta, doIndice, isoDe, sorteio } from "./workspace-dados.js";
import { conferirOrigem, conferirUrlExterna } from "./url-externa.js";
import { limiteDoPlano, planoDe, vistaDoPlano } from "./workspace-plano.js";

// `formularios` e `dia_max` sao os tetos do Pro; a conta recebe os do plano dela (worker/workspace-plano.js: gratuito 1
// formulario e 50 envios por dia; Pro 10 e 1.000 por dia, somando os formularios da conta). O teto da Atos inteira
// (FORMULARIOS_LIMITE_DIA) vale por cima de tudo.
export const LIMITES_FORM = {
  formularios: 10, origens: 5, livres: 5, corpo_kb: 32, por_ip_hora: 5, dia_padrao: 50, dia_max: 1000, mudancas_hora: 60,
  registro_dias: 30, registro_dia: 500, recente_h: 12,
};
export const CAMPOS_PADRAO = ["nome", "email", "assunto", "mensagem"];
const TAMANHO = { nome: 120, email: 254, assunto: 200, mensagem: 5000 };
const TAMANHO_LIVRE = 1000;
const NOMES_CAMPO = { nome: "Nome", email: "E-mail", assunto: "Assunto", mensagem: "Mensagem" };
const ID = /^f-[a-z0-9]{12}$/;
const ARMADILHA = "_armadilha";
const BILHETE = "_atos_bilhete";
const TURNSTILE_CAMPO = "cf-turnstile-response";
const BILHETE_S = 600;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RECENTE_S = LIMITES_FORM.recente_h * 3600;
const ALFA = "abcdefghijklmnopqrstuvwxyz0123456789";
const novoId = () => "f-" + [...crypto.getRandomValues(new Uint8Array(12))].map((x) => ALFA[x % 36]).join("");
/* O dia em Brasilia (UTC-3, sem horario de verao) - os limites diarios viram a meia-noite daqui. */
const diaDe = (ms) => isoDe(ms - 3 * 3600 * 1000).slice(0, 10);

export const limiteGlobal = (env) => Math.max(1, Number(env && env.FORMULARIOS_LIMITE_DIA) || 500);
/* A verificacao do Turnstile pode ser pedida neste Worker? (o segredo e a chave publica do widget da Atos) */
export const turnstileLigado = (env) => Boolean(env && env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY);

// ------------------------------------------------------------------ a configuracao

const limparTexto = (t, max) => String(t == null ? "" : t).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/* A configuracao que o dono mandou: {cfg} ou {erro}. `diaMax`: o limite por dia do plano (worker/workspace-plano.js). */
export function conferirFormulario(d, env, diaMax = LIMITES_FORM.dia_max) {
  const nome = limparTexto(d.nome, 60);
  if (nome.length < 2) return { erro: "dê um nome ao formulário (ex.: Contato do site)" };
  const brutas = Array.isArray(d.origens) ? d.origens : String(d.origens || "").split(/[\s,]+/);
  const origens = [];
  for (const o of brutas.map((x) => String(x || "").trim()).filter(Boolean)) {
    const c = conferirOrigem(o);
    if (c.erro) return { erro: c.erro };
    if (!origens.includes(c.origem)) origens.push(c.origem);
  }
  if (!origens.length) return { erro: "informe pelo menos um site de onde o formulário é enviado (ex.: https://exemplo.com.br)" };
  if (origens.length > LIMITES_FORM.origens) return { erro: "no máximo " + LIMITES_FORM.origens + " sites por formulário" };
  const campos = CAMPOS_PADRAO.filter((c) => Array.isArray(d.campos) && d.campos.includes(c));
  const livres = [];
  for (const l of (Array.isArray(d.livres) ? d.livres : String(d.livres || "").split(/[\s,]+/)).map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)) {
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(l)) return { erro: "o campo livre “" + l.slice(0, 40) + "”: use letras minúsculas sem acento, números e _ (até 30, começando com letra)" };
    if (CAMPOS_PADRAO.includes(l)) return { erro: "“" + l + "” já é um campo padrão: marque-o em vez de criar um livre" };
    if (!livres.includes(l)) livres.push(l);
  }
  if (livres.length > LIMITES_FORM.livres) return { erro: "no máximo " + LIMITES_FORM.livres + " campos livres" };
  if (!campos.length && !livres.length) return { erro: "escolha pelo menos um campo" };
  let redirecionar = "";
  if (String(d.redirecionar || "").trim()) {
    const r = conferirUrlExterna(d.redirecionar, { contexto: "o endereço de “obrigado”" });
    if (r.erro) return { erro: r.erro };
    // Para onde a Atos manda quem enviou: so para um dos sites do proprio formulario (a Atos nao vira redirecionador).
    if (!origens.includes(new URL(r.url).origin)) return { erro: "o endereço de “obrigado” precisa ser de um dos sites do formulário" };
    redirecionar = r.url;
  }
  const limite = Math.round(Number(d.limite_dia === undefined || d.limite_dia === "" ? LIMITES_FORM.dia_padrao : d.limite_dia));
  if (!Number.isFinite(limite) || limite < 1 || limite > diaMax) return { erro: "o limite por dia vai de 1 a " + diaMax.toLocaleString("pt-BR") + (diaMax < LIMITES_FORM.dia_max ? " no plano gratuito (no Pro, até " + LIMITES_FORM.dia_max.toLocaleString("pt-BR") + ")" : ""), codigo: diaMax < LIMITES_FORM.dia_max && limite > diaMax ? "limite_do_plano" : undefined };
  return { cfg: { nome, origens, campos, livres, redirecionar, limite_dia: limite, turnstile: d.turnstile === true && turnstileLigado(env) } };
}

/* Os campos que chegaram, limpos e conferidos com o que o formulario aceita: {campos, ignorados} ou {erro}. */
export function limparCampos(cfg, bruto) {
  const campos = {};
  for (const k of [...cfg.campos, ...cfg.livres]) {
    const v = String(bruto[k] == null ? "" : bruto[k]).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    const max = TAMANHO[k] || TAMANHO_LIVRE;
    if (v.length > max) return { erro: "o campo “" + (NOMES_CAMPO[k] || k) + "” passa de " + max + " caracteres" };
    if (k === "email" && v && !emailValido(v)) return { erro: "o e-mail digitado não parece válido" };
    if (k !== "mensagem" && v.includes("\n") && !cfg.livres.includes(k)) campos[k] = v.replace(/\n+/g, " ");
    else if (v) campos[k] = v;
  }
  if (!Object.keys(campos).length) return { erro: "o formulário chegou vazio" };
  const aceitos = new Set([...cfg.campos, ...cfg.livres, ARMADILHA, BILHETE, TURNSTILE_CAMPO]);
  const ignorados = Object.keys(bruto).filter((k) => !aceitos.has(k)).length;
  return { campos, ignorados };
}

// ------------------------------------------------------------------ o objeto (worker/workspace-dados.js)

const DIA_S = 86400;
const corte = (agora, dias) => isoDe(agora - dias * DIA_S * 1000);

/* Os ids dos formularios que cabem no plano: os mais antigos (pela criacao), ate `max`. */
async function formulariosNoPlano(s, max) {
  const l = [...(await s.list({ prefix: "form:" })).values()].sort((a, b) => String(a.criado).localeCompare(String(b.criado)) || String(a.id).localeCompare(String(b.id)));
  return new Set(l.slice(0, Math.max(0, max)).map((f) => f.id));
}

/* As ops dos formularios: as da conta (form_*) e as do indice (fidx_*). `o` e o objeto. */
export const OPS_FORMULARIOS = {
  async form_lista(o, d) {
    const s = o.ctx.storage;
    const cabem = d && d.max !== undefined ? await formulariosNoPlano(s, Number(d.max)) : null;
    return { ok: true, formularios: [...(await s.list({ prefix: "form:" })).values()].map((f) => (cabem ? { ...f, fora_do_plano: !cabem.has(f.id) } : f)) };
  },
  async form_ver(o, d) {
    return { ok: true, form: (await o.ctx.storage.get("form:" + d.id)) || null };
  },
  async form_criar(o, d, agora) {
    const s = o.ctx.storage;
    const max = Number(d.max) || LIMITES_FORM.formularios;
    if ((await s.list({ prefix: "form:" })).size >= max) return { ok: false, status: 409, codigo: "limite_do_plano", erro: "no seu plano, cada conta tem até " + max + (max === 1 ? " formulário" : " formulários") + ": apague um para criar outro" };
    if (!(await o.contar("fmud", 3600, agora, LIMITES_FORM.mudancas_hora))) return { ok: false, status: 429, erro: "muitas mudanças na última hora: espere um pouco" };
    const form = { id: d.id, ...d.cfg, ativo: true, bloqueado: null, criado: isoDe(agora), mudado: null };
    await s.put("form:" + d.id, form);
    return { ok: true, form };
  },
  async form_mudar(o, d, agora) {
    const s = o.ctx.storage;
    const f = await s.get("form:" + d.id);
    if (!f) return { ok: false, status: 404, erro: "esse formulário não existe nesta conta" };
    if (!(await o.contar("fmud", 3600, agora, LIMITES_FORM.mudancas_hora))) return { ok: false, status: 429, erro: "muitas mudanças na última hora: espere um pouco" };
    if (d.acao === "apagar") {
      await s.delete("form:" + d.id);
      await apagarPrefixo(s, "flog:" + d.id + "|");
      return { ok: true, apagado: d.id };
    }
    if (d.acao === "ligar" && f.bloqueado) return { ok: false, status: 403, erro: "a Atos desligou este formulário" + (f.bloqueado.motivo ? " (" + f.bloqueado.motivo + ")" : "") + ": escreva para contato@atos.dev.br" };
    if (d.acao === "ligar" && d.max !== undefined && !(await formulariosNoPlano(s, Number(d.max))).has(d.id)) {
      return { ok: false, status: 409, codigo: "limite_do_plano", erro: "este formulário está fora do plano (" + d.max + (Number(d.max) === 1 ? " formulário" : " formulários") + "): apague outro ou volte ao Pro para ele entregar de novo" };
    }
    if (d.acao === "ligar" || d.acao === "desligar") f.ativo = d.acao === "ligar";
    else if (d.acao === "editar") Object.assign(f, d.cfg);
    else return { ok: false, status: 400, erro: "o que fazer com o formulário? (editar, ligar, desligar ou apagar)" };
    f.mudado = isoDe(agora);
    await s.put("form:" + d.id, f);
    return { ok: true, form: f };
  },
  /* A equipe desliga (bloqueado: {quando, motivo, por}) ou liga de novo (null). */
  async form_bloqueio(o, d) {
    const s = o.ctx.storage;
    const f = await s.get("form:" + d.id);
    if (!f) return { ok: false, status: 404, erro: "esse formulário não existe (mais)" };
    f.bloqueado = d.bloqueado || null;
    await s.put("form:" + d.id, f);
    return { ok: true, form: f };
  },
  /* Os limites de um envio que vai sair: o formulario dentro do plano (os mais antigos, ate `max`), 5 por hora do mesmo
     endereco (o resumo), o limite diario do formulario (no maximo o do plano) e o da conta no dia (`envios_dia`). */
  async form_contar(o, d, agora) {
    const s = o.ctx.storage;
    const f = await s.get("form:" + d.id);
    if (!f) return { ok: false, motivo: "inexistente" };
    if (d.max !== undefined && !(await formulariosNoPlano(s, Number(d.max))).has(d.id)) return { ok: false, motivo: "fora_do_plano" };
    if (!(await o.contar("fip:" + d.id + ":" + d.ip, 3600, agora, LIMITES_FORM.por_ip_hora))) return { ok: false, motivo: "limite_ip" };
    const doPlano = Number(d.envios_dia) || LIMITES_FORM.dia_max;
    if (!(await o.contar("fdia:" + d.id + ":" + diaDe(agora), 2 * DIA_S, agora, Math.min(f.limite_dia || LIMITES_FORM.dia_padrao, doPlano)))) return { ok: false, motivo: "limite_dia" };
    if (!(await o.contar("fconta:" + diaDe(agora), 2 * DIA_S, agora, doPlano))) return { ok: false, motivo: "limite_dia" };
    return { ok: true };
  },
  async form_registrar(o, d, agora) {
    const s = o.ctx.storage;
    if (!(await s.get("form:" + d.id))) return { ok: true };
    // Ate 500 linhas por formulario por dia (um ataque nao enche o registro); passando disso, so conta.
    if (!(await o.contar("flogdia:" + d.id + ":" + diaDe(agora), 2 * DIA_S, agora, LIMITES_FORM.registro_dia))) {
      await o.contar("flogfora:" + d.id + ":" + diaDe(agora), 2 * DIA_S, agora, Number.MAX_SAFE_INTEGER);
      return { ok: true, contado: true };
    }
    const quando = isoDe(agora);
    await s.put("flog:" + d.id + "|" + quando + "|" + sorteio(), {
      quando, origem: String(d.origem || "").slice(0, 120), resultado: String(d.resultado || ""), motivo: String(d.motivo || "").slice(0, 60), tamanho: Number(d.tamanho) || 0,
    });
    return { ok: true };
  },
  async form_registro(o, d, agora) {
    const s = o.ctx.storage;
    const linhas = [...(await s.list({ prefix: "flog:" + d.id + "|", reverse: true, limit: 300 })).values()];
    const fora = await o.contagem("flogfora:" + d.id + ":" + diaDe(agora), agora);
    return { ok: true, registro: linhas, hoje: await o.contagem("fdia:" + d.id + ":" + diaDe(agora), agora), nao_registrados_hoje: fora };
  },

  // ---- o indice
  async fidx_reservar(o, d, agora) {
    const s = o.ctx.storage;
    if (await s.get("fidx:" + d.id)) return { ok: false };
    await s.put("fidx:" + d.id, { sub: d.sub, conta: d.conta || "", nome: d.nome || "", criado: isoDe(agora), bloqueado: null });
    return { ok: true };
  },
  async fidx_soltar(o, d) {
    await o.ctx.storage.delete("fidx:" + d.id);
    return { ok: true };
  },
  async fidx_nome(o, d) {
    const s = o.ctx.storage;
    const x = await s.get("fidx:" + d.id);
    if (x) { x.nome = d.nome || x.nome; if (d.conta) x.conta = d.conta; await s.put("fidx:" + d.id, x); }
    return { ok: true };
  },
  async fidx_dono(o, d) {
    return { ok: true, dono: (await o.ctx.storage.get("fidx:" + d.id)) || null };
  },
  async fidx_bloqueio(o, d) {
    const s = o.ctx.storage;
    const x = await s.get("fidx:" + d.id);
    if (!x) return { ok: false, status: 404, erro: "esse formulário não existe (mais)" };
    x.bloqueado = d.bloqueado || null;
    await s.put("fidx:" + d.id, x);
    return { ok: true, linha: x };
  },
  /* O teto diario da Atos inteira (o Resend) e a estatistica do dia do formulario. */
  async fidx_saida(o, d, agora) {
    const dia = diaDe(agora);
    if (!(await o.contar("form-global:" + dia, 2 * DIA_S, agora, d.limite))) return { ok: false, motivo: "limite_atos" };
    await o.contar("form-global-ok:" + dia, 2 * DIA_S, agora, Number.MAX_SAFE_INTEGER);
    return { ok: true };
  },
  async fidx_estatistica(o, d, agora) {
    const s = o.ctx.storage;
    const k = "fstat:" + d.id + "|" + diaDe(agora);
    const x = (await s.get(k)) || { entregues: 0, recusados: 0 };
    if (d.entregue) x.entregues++;
    else x.recusados++;
    await s.put(k, x);
    await o.marcarLimpeza(agora);
    return { ok: true };
  },
  async fidx_painel(o, d, agora) {
    const s = o.ctx.storage;
    const dia = diaDe(agora);
    const semana = new Set(Array.from({ length: 7 }, (_, i) => diaDe(agora - i * DIA_S * 1000)));
    const stats = {};
    for (const [k, v] of await s.list({ prefix: "fstat:" })) {
      const [id, dd] = k.slice(6).split("|");
      const x = stats[id] || (stats[id] = { hoje: { entregues: 0, recusados: 0 }, semana: { entregues: 0, recusados: 0 } });
      if (dd === dia) { x.hoje.entregues += v.entregues; x.hoje.recusados += v.recusados; }
      if (semana.has(dd)) { x.semana.entregues += v.entregues; x.semana.recusados += v.recusados; }
    }
    const formularios = [];
    for (const [k, v] of await s.list({ prefix: "fidx:" })) formularios.push({ id: k.slice(5), ...v, numeros: stats[k.slice(5)] || null });
    return { ok: true, formularios, global: { hoje: await o.contagem("form-global:" + dia, agora), entregues_hoje: await o.contagem("form-global-ok:" + dia, agora) } };
  },
};

export async function limparFormularios(o, agora) {
  const s = o.ctx.storage;
  let n = 0;
  for (const [k] of await s.list({ prefix: "form:" })) n += await apagarAntigos(s, "flog:" + k.slice(5) + "|", corte(agora, LIMITES_FORM.registro_dias));
  const dia = diaDe(agora - LIMITES_FORM.registro_dias * DIA_S * 1000);
  const velhas = [];
  for (const [k] of await s.list({ prefix: "fstat:" })) if (k.split("|")[1] < dia) velhas.push(k);
  for (let i = 0; i < velhas.length; i += 128) await s.delete(velhas.slice(i, i + 128));
  return n + velhas.length;
}

// ------------------------------------------------------------------ as rotas do dono

export function ehRotaDosFormularios(url) {
  return url.pathname === "/api/workspace/formularios" || url.pathname.startsWith("/api/workspace/formularios/");
}

/* O formulario como a tela o ve. */
function vista(f) {
  return {
    id: f.id, nome: f.nome, origens: f.origens || [], campos: f.campos || [], livres: f.livres || [], redirecionar: f.redirecionar || "", limite_dia: f.limite_dia,
    turnstile: Boolean(f.turnstile), ativo: f.ativo !== false, bloqueado: f.bloqueado ? { quando: f.bloqueado.quando, motivo: f.bloqueado.motivo || "" } : null,
    criado: f.criado || null, mudado: f.mudado || null, fora_do_plano: Boolean(f.fora_do_plano), pagina: f.pagina || "",
  };
}

/* Os limites dos formularios no plano da conta (worker/workspace-plano.js). */
function limitesDoPlano(plano) {
  return { ...LIMITES_FORM, formularios: plano.limites.formularios, dia_max: plano.limites.envios_dia, conta_dia: plano.limites.envios_dia, dia_padrao: Math.min(LIMITES_FORM.dia_padrao, plano.limites.envios_dia) };
}

const FORA = () => json({ erro: "não deu para falar com o registro do Workspace agora: tente de novo em instantes" }, 503);

export async function atenderFormularios(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  if (!env.WS_DADOS) return json({ erro: "os formulários ainda não estão ligados neste Worker" }, 503);
  const porta = await portaoDoWorkspace(request, env);
  if (porta.resposta) return porta.resposta;
  const { sessao, alias, plano } = porta;
  const conta = daConta(env, sessao.sub);
  const indice = doIndice(env);
  const recente = agora / 1000 - sessao.auth_time < RECENTE_S;
  const p = url.pathname;
  const L = limitesDoPlano(plano);
  const tela = async (extra = {}) => {
    const r = await conta.pedir("form_lista", { agora, max: L.formularios });
    if (!r || !r.ok) return FORA();
    return json({
      formularios: r.formularios.map(vista).sort((a, b) => String(a.criado).localeCompare(String(b.criado))), limites: L, plano: vistaDoPlano(plano), campos_padrao: CAMPOS_PADRAO,
      turnstile: { disponivel: turnstileLigado(env) }, limite_atos_dia: limiteGlobal(env), email_atos: alias.alias.endereco, recente, ...extra,
    });
  };
  const recusa = (r, padrao) => (r && r.codigo === "limite_do_plano" ? limiteDoPlano(r.erro, plano) : json({ erro: (r && r.erro) || padrao }, (r && r.status) || 503));
  try {
    if (p === "/api/workspace/formularios" && request.method === "GET") return await tela();
    const mr = p.match(/^\/api\/workspace\/formularios\/(f-[a-z0-9]{12})\/registro$/);
    if (mr && request.method === "GET") {
      const r = await conta.pedir("form_registro", { agora, id: mr[1] });
      if (!r || !r.ok) return FORA();
      return json({ registro: r.registro, hoje: r.hoje, nao_registrados_hoje: r.nao_registrados_hoje, retencao_dias: LIMITES_FORM.registro_dias });
    }
    if (request.method !== "POST") return json({ erro: "use POST" }, 405);
    if (!recente) return json({ erro: "para mudar os formulários, entre de novo (o login precisa ser das últimas " + LIMITES_FORM.recente_h + " horas)", reentrar: true }, 401);
    const d = await lerJson(request);
    if (!d || typeof d !== "object" || Array.isArray(d)) return json({ erro: "pedido inválido" }, 400);

    if (p === "/api/workspace/formularios") {
      const c = conferirFormulario(d, env, L.dia_max);
      if (c.erro) return c.codigo ? limiteDoPlano(c.erro, plano) : json({ erro: c.erro }, 400);
      // O limite de formularios do plano, antes de reservar o id.
      const ja = await conta.pedir("form_lista", { agora });
      if (ja && ja.ok && ja.formularios.length >= L.formularios) return limiteDoPlano("no plano " + (plano.pro ? "Pro" : "gratuito") + ", cada conta tem até " + L.formularios + (L.formularios === 1 ? " formulário" : " formulários") + ": apague um para criar outro", plano);
      if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
      let id = "";
      for (let i = 0; i < 5 && !id; i++) {
        const t = novoId();
        const r = await indice.pedir("fidx_reservar", { agora, id: t, sub: sessao.sub, conta: sessao.email, nome: c.cfg.nome });
        if (r && r.ok) id = t;
      }
      if (!id) return json({ erro: "não deu para criar agora: tente de novo" }, 503);
      const r = await conta.pedir("form_criar", { agora, id, cfg: c.cfg, max: L.formularios });
      if (!r || !r.ok) {
        await indice.pedir("fidx_soltar", { id });
        return recusa(r, "não deu para criar agora");
      }
      return await tela({ criado: id });
    }
    const m = p.match(/^\/api\/workspace\/formularios\/(f-[a-z0-9]{12})$/);
    if (!m) return json({ erro: "rota não existe" }, 404);
    const acao = String(d.acao || "");
    let cfg;
    if (acao === "editar") {
      const c = conferirFormulario(d, env, L.dia_max);
      if (c.erro) return c.codigo ? limiteDoPlano(c.erro, plano) : json({ erro: c.erro }, 400);
      cfg = c.cfg;
    }
    if (acao === "apagar" && d.confirmar !== true) return json({ erro: "confirme na página: o endereço para de receber na hora e o registro é apagado" }, 400);
    const r = await conta.pedir("form_mudar", { agora, id: m[1], acao, cfg, max: L.formularios });
    if (!r || !r.ok) return recusa(r, "não deu agora");
    if (acao === "apagar") await indice.pedir("fidx_soltar", { id: m[1] });
    if (acao === "editar") await indice.pedir("fidx_nome", { id: m[1], nome: cfg.nome, conta: sessao.email });
    return await tela();
  } catch {
    return FORA();
  }
}

// ------------------------------------------------------------------ o envio (a rota publica)

export function ehRotaDoFormularioPublico(url) {
  return /^\/f\/[^/]+\/?$/.test(url.pathname);
}

/* A origem de quem envia: o Origin, ou a do Referer quando o navegador nao manda Origin. "" sem nenhum. */
function origemDoPedido(request) {
  const o = request.headers.get("origin");
  if (o && o !== "null") return o;
  try { return new URL(request.headers.get("referer") || "").origin; } catch { return ""; }
}

/* Os campos que chegaram (so textos; arquivos e o que nao for texto ficam de fora). */
async function lerCampos(request, buf) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  const campos = {};
  if (ct.includes("application/json")) {
    let d;
    try { d = JSON.parse(new TextDecoder().decode(buf)); } catch { return null; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    for (const [k, v] of Object.entries(d)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") campos[String(k).slice(0, 40)] = String(v);
    return campos;
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data") || ct.includes("text/plain")) {
    let f;
    try {
      if (ct.includes("text/plain")) {
        // <form enctype="text/plain">: nome=valor por linha.
        for (const linha of new TextDecoder().decode(buf).split(/\r?\n/)) { const i = linha.indexOf("="); if (i > 0) campos[linha.slice(0, i).slice(0, 40)] = linha.slice(i + 1); }
        return campos;
      }
      f = await new Response(buf, { headers: { "content-type": request.headers.get("content-type") } }).formData();
    } catch { return null; }
    for (const [k, v] of f) if (typeof v === "string" && !(String(k).slice(0, 40) in campos)) campos[String(k).slice(0, 40)] = v;
    return campos;
  }
  return null;
}

/* O bilhete da verificacao: o conteudo ja conferido, assinado (HMAC com uma chave tirada do segredo do Turnstile). */
async function chaveDoBilhete(env) {
  const bruto = new TextEncoder().encode(await sha256("atos-formulario-bilhete:" + env.TURNSTILE_SECRET));
  return crypto.subtle.importKey("raw", bruto, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function assinarBilhete(env, dados) {
  const corpo = b64url(new TextEncoder().encode(JSON.stringify(dados)));
  const ass = hex(await crypto.subtle.sign("HMAC", await chaveDoBilhete(env), new TextEncoder().encode(corpo)));
  return corpo + "." + ass;
}
async function lerBilhete(env, texto, agora) {
  const [corpo, ass] = String(texto || "").split(".");
  if (!corpo || !ass || corpo.length > 60000) return null;
  const certo = hex(await crypto.subtle.sign("HMAC", await chaveDoBilhete(env), new TextEncoder().encode(corpo)));
  if (!iguais(certo, ass)) return null;
  let d;
  try { d = JSON.parse(new TextDecoder().decode(deB64url(corpo))); } catch { return null; }
  if (!d || typeof d !== "object" || !(d.e > agora / 1000)) return null;
  return d;
}
async function turnstileValido(env, token, hostname, ip, buscar) {
  const t = String(token || "");
  if (!t || t.length > 2048 || !env.TURNSTILE_SECRET) return false;
  const corpo = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: t });
  if (ip) corpo.set("remoteip", ip);
  try {
    const r = await buscar(SITEVERIFY, { method: "POST", body: corpo });
    const d = await r.json();
    return Boolean(d && d.success === true && String(d.hostname || "").toLowerCase() === hostname);
  } catch {
    return false;
  }
}

// As paginas que quem envia pelo HTML ve (na Atos). Sem script da Atos; a da verificacao carrega so o do Turnstile.
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CSP_PAGINA = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const CSP_VERIFICAR = "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; " +
  "style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function pagina({ titulo, texto, voltar, status = 200, corpo = "", cabeca = "", csp = CSP_PAGINA }) {
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>' + esc(titulo) + ' · Atos</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">' +
    '<link rel="stylesheet" href="/assets/conta.css"><link rel="stylesheet" href="/assets/publico.css">' + cabeca + "</head><body>" +
    '<main class="pub"><p class="pub-marca">Atos</p><h1>' + esc(titulo) + "</h1>" + (texto ? '<p class="pub-texto">' + esc(texto) + "</p>" : "") + corpo +
    (voltar ? '<p><a class="btn" href="' + esc(voltar) + '">Voltar ao site</a></p>' : "") +
    '<p class="nota pub-pe">Formulário entregue pela Atos (atos.dev.br) ao e-mail de quem o cadastrou. A Atos não guarda o conteúdo. <a href="/privacidade/">Privacidade</a></p>' +
    "</main></body></html>";
  return new Response(html, { status, headers: cabecalhosPagina(csp) });
}
function cabecalhosPagina(csp) {
  return {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": csp, "x-frame-options": "DENY",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=31536000",
  };
}

const MENSAGENS = {
  inexistente: [404, "Formulário não encontrado", "Este endereço não é de um formulário ativo na Atos."],
  origem: [403, "Envio não aceito", "Este formulário não aceita envios deste site."],
  desligado: [403, "Formulário desligado", "Este formulário não está recebendo mensagens agora."],
  invalido: [400, "Não deu para enviar", ""],
  limite_ip: [429, "Muitos envios seguidos", "Espere um pouco antes de enviar de novo."],
  limite_dia: [429, "Limite do dia", "Este formulário chegou ao limite de mensagens de hoje. Tente de novo amanhã."],
  limite_atos: [503, "Não deu para enviar agora", "A Atos chegou ao limite de envios de hoje. Tente de novo mais tarde."],
  limite_atos_ip: [429, "Muitos pedidos seguidos", "Espere um minuto antes de enviar de novo."],
  parado: [503, "Formulário parado", "Este formulário não está recebendo mensagens agora."],
  falha: [502, "Não deu para enviar agora", "A mensagem não saiu. Tente de novo em instantes."],
  verificacao: [400, "Verificação contra robôs", "A verificação não passou ou venceu. Volte ao site e envie de novo."],
  tamanho: [413, "Grande demais", "O envio passa de 32 KB."],
};

export async function atenderFormularioPublico(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  const buscar = deps.fetch || fetch;
  const enviar = deps.enviarEmail || enviarPadrao;
  const m = url.pathname.match(/^\/f\/([^/]+)\/?$/);
  const id = m && ID.test(m[1]) ? m[1] : "";
  const origem = origemDoPedido(request);
  const aceita = (request.headers.get("accept") || "").toLowerCase();
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  const emJson = ct.includes("application/json") || (aceita.includes("application/json") && !aceita.includes("text/html"));
  let cors = {};
  const sair = (codigo, texto, extra = {}) => {
    const [status, titulo, padrao] = MENSAGENS[codigo];
    if (emJson) return json({ ok: false, erro: texto || padrao, codigo, ...extra }, status, cors);
    return pagina({ titulo, texto: texto || padrao, voltar: extra.voltar, status });
  };

  if (!env.WS_DADOS) return sair("parado");
  const indice = doIndice(env);
  let dono = null, cfg = null;
  const achar = async () => {
    if (!id) return;
    const x = await indice.pedir("fidx_dono", { id });
    dono = x && x.ok ? x.dono : null;
    if (!dono) return;
    const f = await daConta(env, dono.sub).pedir("form_ver", { id });
    cfg = f && f.ok ? f.form : null;
  };

  if (request.method === "OPTIONS") {
    try { await achar(); } catch { /* sem CORS */ }
    const h = { "access-control-max-age": "600", vary: "origin", "x-content-type-options": "nosniff" };
    if (cfg && cfg.origens.includes(request.headers.get("origin") || "")) {
      Object.assign(h, { "access-control-allow-origin": request.headers.get("origin"), "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type, accept" });
    }
    return new Response(null, { status: 204, headers: h });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return pagina({ titulo: "Endereço de formulário", texto: "Este é o endereço para onde um site manda o formulário de contato (método POST). Ele não abre como página: volte ao site e use o formulário de lá." });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST, OPTIONS" } });

  if (Number(request.headers.get("content-length") || 0) > LIMITES_FORM.corpo_kb * 1024) return sair("tamanho");
  if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return sair("limite_atos_ip");
  try { await achar(); } catch { return sair("parado"); }
  if (!cfg) return sair("inexistente");
  // A pagina de links do dono (worker/links.js) pode ter este formulario como botao: o envio sai da pagina de contato da
  // Atos (atos.dev.br/@<nome>/contato), entao a propria Atos vale como origem dele, e a volta e a pagina de links.
  const origemAceita = (o) => cfg.origens.includes(o) || Boolean(cfg.pagina && o === url.origin);
  const voltaDe = (o) => (cfg.pagina && o === url.origin ? url.origin + "/@" + cfg.pagina : o);
  if (cfg.origens.includes(origem)) cors = { "access-control-allow-origin": origem, vary: "origin" };
  const conta = daConta(env, dono.sub);
  const anotar = async (resultado, motivo, tamanho = 0, o = origem) => {
    try {
      await conta.pedir("form_registrar", { agora, id, resultado, motivo, origem: o, tamanho });
      if (resultado === "entregue" || resultado === "recusado") await indice.pedir("fidx_estatistica", { agora, id, entregue: resultado === "entregue" });
    } catch { /* o registro e o segundo lugar */ }
  };

  const buf = await request.arrayBuffer();
  if (buf.byteLength > LIMITES_FORM.corpo_kb * 1024) { await anotar("recusado", "tamanho", buf.byteLength); return sair("tamanho"); }
  const bruto = await lerCampos(request, buf);
  if (!bruto) { await anotar("recusado", "formato", buf.byteLength); return sair("invalido", "o envio não veio como formulário (application/x-www-form-urlencoded, multipart/form-data ou JSON)"); }

  // O segundo passo da verificacao: veio da pagina da Atos, com o bilhete.
  let deOrigem = origem, campos, bilhete = null;
  if (bruto[BILHETE]) {
    bilhete = turnstileLigado(env) && (!request.headers.get("origin") || request.headers.get("origin") === url.origin) ? await lerBilhete(env, bruto[BILHETE], agora) : null;
    if (!bilhete || bilhete.f !== id || !origemAceita(bilhete.o)) { await anotar("recusado", "bilhete", buf.byteLength); return sair("verificacao"); }
    deOrigem = bilhete.o;
    const ip = request.headers.get("cf-connecting-ip") || "";
    if (!(await turnstileValido(env, bruto[TURNSTILE_CAMPO], url.hostname, ip, buscar))) {
      await anotar("recusado", "verificacao", buf.byteLength, deOrigem);
      return pagina({ titulo: "Verificação contra robôs", texto: "A verificação não passou ou venceu. Volte ao site e envie de novo.", voltar: voltaDe(deOrigem), status: 400 });
    }
    campos = bilhete.c;
  } else {
    if (!origemAceita(origem)) { await anotar("recusado", "origem", buf.byteLength); return sair("origem"); }
    // O campo-armadilha: quem o preenche recebe a resposta de sempre e nada sai.
    if (String(bruto[ARMADILHA] || "").trim()) { await anotar("armadilha", "", buf.byteLength); return sucesso(); }
  }
  if (cfg.bloqueado || cfg.ativo === false) { await anotar("recusado", cfg.bloqueado ? "desligado_pela_atos" : "desligado", buf.byteLength, deOrigem); return sair("desligado", "", { voltar: emJson ? undefined : voltaDe(deOrigem) }); }
  if (!bilhete) {
    const c = limparCampos(cfg, bruto);
    if (c.erro) { await anotar("recusado", "campos", buf.byteLength); return sair("invalido", c.erro, { voltar: voltaDe(deOrigem) }); }
    campos = c.campos;
    if (cfg.turnstile && turnstileLigado(env)) {
      if (emJson) { await anotar("recusado", "verificacao_json", buf.byteLength); return json({ ok: false, codigo: "verificacao", erro: "este formulário pede a verificação contra robôs: envie pelo formulário HTML (method=post), que passa pela página de confirmação da Atos" }, 400, cors); }
      return paginaDeVerificacao(env, id, cfg, await assinarBilhete(env, { f: id, o: origem, c: campos, e: Math.floor(agora / 1000) + BILHETE_S }));
    }
  }

  // O dono: o Workspace ativo e sem suspensao, e o plano dele (worker/workspace-plano.js: quantos formularios entregam e
  // quantos envios por dia).
  let w;
  try { w = await workspaceDe(env, dono.sub); } catch { await anotar("falhou", "workspace_fora", buf.byteLength, deOrigem); return sair("parado"); }
  if (!w || !w.ativo || w.suspenso) { await anotar("recusado", w && w.suspenso ? "workspace_suspenso" : "sem_workspace", buf.byteLength, deOrigem); return sair("parado"); }
  const P = planoDe(w, agora).limites;

  // Os limites deste envio (o formulario dentro do plano; por endereco de internet, pelo resumo com o sal do dia; o do dia
  // do formulario e o da conta).
  const ip = (await sha256("form-ip:" + diaDe(agora) + ":" + (request.headers.get("cf-connecting-ip") || "sem-ip"))).slice(0, 16);
  let lim;
  try { lim = await conta.pedir("form_contar", { agora, id, ip, max: P.formularios, envios_dia: P.envios_dia }); } catch { return sair("parado"); }
  if (!lim || !lim.ok) {
    await anotar("recusado", (lim && lim.motivo) || "limite", buf.byteLength, deOrigem);
    if (lim && lim.motivo === "fora_do_plano") return sair("parado", "", { voltar: emJson ? undefined : voltaDe(deOrigem) });
    return sair(lim && lim.motivo === "limite_dia" ? "limite_dia" : "limite_ip");
  }

  // O alias pronto (o destino confirmado e o encaminhamento ligado).
  let destino;
  try {
    destino = await destinoDoTitular(env, dono.sub);
  } catch { await anotar("falhou", "workspace_fora", buf.byteLength, deOrigem); return sair("parado"); }
  if (!destino.pronto) { await anotar("recusado", destino.motivo, buf.byteLength, deOrigem); return sair("parado"); }
  let saida;
  try { saida = await indice.pedir("fidx_saida", { agora, id, limite: limiteGlobal(env) }); } catch { return sair("parado"); }
  if (!saida || !saida.ok) { await anotar("recusado", "limite_atos", buf.byteLength, deOrigem); return sair("limite_atos"); }

  const r = await enviar(env, mensagemDoFormulario(cfg, campos, deOrigem, destino, agora));
  if (!r || !r.ok) { await anotar("falhou", "envio", buf.byteLength, deOrigem); return sair("falha"); }
  await anotar("entregue", "", buf.byteLength, deOrigem);
  return sucesso();

  function sucesso() {
    if (emJson) return json({ ok: true }, 200, cors);
    if (cfg.redirecionar) return new Response(null, { status: 303, headers: { location: cfg.redirecionar, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    return pagina({ titulo: "Mensagem enviada", texto: "Obrigado. A mensagem foi entregue a quem cuida deste site.", voltar: voltaDe(deOrigem) });
  }
}

/* A pagina "confirme que voce nao e um robo" (o widget do Turnstile da Atos, que so vale em atos.dev.br). */
function paginaDeVerificacao(env, id, cfg, bilhete) {
  const corpo = '<form class="pub-form" method="post" action="/f/' + esc(id) + '">' +
    '<input type="hidden" name="' + BILHETE + '" value="' + esc(bilhete) + '">' +
    '<div class="cf-turnstile" data-sitekey="' + esc(env.TURNSTILE_SITEKEY) + '" data-language="pt-br"></div>' +
    '<button type="submit" class="btn primario">Enviar a mensagem</button>' +
    '<p class="dica">A confirmação vale por 10 minutos. O que você escreveu está só nesta página até você enviar.</p></form>';
  return pagina({
    titulo: "Confirme o envio", texto: "Antes de entregar a mensagem do formulário “" + cfg.nome + "”, confirme que você não é um robô.", corpo,
    cabeca: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>', csp: CSP_VERIFICAR,
  });
}

/* O e-mail ao dono: os campos, de onde veio e o aviso sobre o Responder. */
export function mensagemDoFormulario(cfg, campos, origem, destino, agora) {
  const linhas = [...cfg.campos, ...cfg.livres].filter((k) => campos[k]).map((k) => (NOMES_CAMPO[k] || k) + ":\n" + campos[k]);
  const responder = campos.email && emailValido(campos.email) ? campos.email : "";
  const quando = new Date(agora).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return {
    para: destino.destino,
    responder: responder || undefined,
    assunto: "[" + cfg.nome + "] " + (campos.assunto || (campos.nome ? "Mensagem de " + campos.nome : "Nova mensagem")),
    titulo: "Mensagem do formulário " + cfg.nome,
    pre: (campos.nome ? campos.nome + ": " : "") + String(campos.mensagem || campos.assunto || "").slice(0, 90),
    texto: linhas.join("\n\n") + "\n\n" +
      "Enviado de " + origem + " em " + quando + "." +
      (responder ? " Responder a este e-mail vai para " + responder + ", o endereço que a pessoa digitou (a Atos não confere se é dela)." : " A pessoa não deixou um e-mail válido: responder não chega a ela.") +
      "\n\nVocê recebe porque cadastrou este formulário no Atos Workspace (" + destino.endereco + "). A Atos não guarda o conteúdo dos formulários.",
  };
}

// ------------------------------------------------------------------ o painel da equipe

export async function formulariosParaPainel(env, agora) {
  const r = await doIndice(env).pedir("fidx_painel", { agora });
  if (!r || !r.ok) throw new Error("o indice não respondeu");
  return { formularios: r.formularios.sort((a, b) => String(b.criado || "").localeCompare(String(a.criado || ""))), global: { ...r.global, limite: limiteGlobal(env) },
    turnstile: turnstileLigado(env), limites: LIMITES_FORM };
}

/* Desligar (com o motivo, que o dono ve) ou ligar de novo um formulario. */
export async function bloqueioDoFormulario(env, id, acao, motivo, quem, agora) {
  const x = await doIndice(env).pedir("fidx_dono", { id });
  if (!x || !x.ok || !x.dono) return { status: 404, erro: "esse formulário não existe (mais)" };
  const bloqueado = acao === "desligar" ? { quando: isoDe(agora), motivo, por: quem.email } : null;
  const r = await daConta(env, x.dono.sub).pedir("form_bloqueio", { id, bloqueado });
  if (!r || !r.ok) return { status: (r && r.status) || 503, erro: (r && r.erro) || "não deu agora" };
  await doIndice(env).pedir("fidx_bloqueio", { id, bloqueado });
  return { status: 200, dono: x.dono, form: r.form };
}
