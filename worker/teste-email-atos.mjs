// Teste do e-mail Atos (worker/email-atos.js): os nomes (formato, reservados, que lembram a Atos), o destino, as rotas da
// tela (sem sessao, sem Workspace, desligado sem o token, login recente), a unicidade (entre contas e por conta, e a
// quarentena), o destino na Cloudflare (a API falsa: criar, ja existia, verificado, apagar so o que a Atos criou), o
// codigo da Atos, ligar e desligar, o teto de destinos, o handler de e-mail com mensagens simuladas (inexistente,
// desligado, nao verificado, sem Workspace, suspenso, loop, tamanho, frequencia, automaticas, subendereco, outro
// dominio, falha no forward, encaminhado), o registro sem conteudo e a limpeza (30 dias), o painel da equipe
// (ver, suspender, reativar, remover; papeis e area) e a Cloudflare simulada do Worker de teste. Sem rede.
//   node worker/teste-email-atos.mjs
import worker from "./index.js";
import { sha256 } from "./comum.js";
import { ClienteCobranca } from "./cobranca/cliente.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { EmailAtos, LIMITES, RECUSA, RECUSA_TAMANHO, conferirAlias, conferirDestino, receberEmail } from "./email-atos.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

// ------------------------------------------------------------------ o ambiente falso

const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
  list: async ({ prefix = "" } = {}) => ({ keys: [...guardados.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
function storage() {
  const m = new Map();
  let alarme = null;
  return {
    m,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list({ prefix = "", reverse = false, limit } = {}) {
      let l = [...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (reverse) l.reverse();
      if (limit) l = l.slice(0, limit);
      return new Map(l);
    },
    async setAlarm(t) { alarme = t; }, async getAlarm() { return alarme; },
  };
}

// A API de destinos da Cloudflare, falsa: os destinos da conta, as chamadas feitas.
const CF = { enderecos: new Map(), chamadas: [], falhar: false };
function cfFetch(url, op = {}) {
  const u = new URL(url);
  CF.chamadas.push({ metodo: op.method || "GET", caminho: u.pathname + u.search, auth: (op.headers || {}).Authorization });
  if (CF.falhar) return Promise.resolve(new Response("{}", { status: 500 }));
  const base = "/client/v4/accounts/conta-cf/email/routing/addresses";
  const resp = (d, status = 200) => Promise.resolve(new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } }));
  if (!u.pathname.startsWith(base)) return resp({ success: false }, 404);
  const resto = u.pathname.slice(base.length);
  const metodo = op.method || "GET";
  if (metodo === "POST" && !resto) {
    const email = JSON.parse(op.body).email;
    if ([...CF.enderecos.values()].some((x) => x.email === email)) return resp({ success: false, errors: [{ code: 2032, message: "already exists" }] }, 409);
    const x = { id: "cf" + (CF.enderecos.size + 1) + Math.random().toString(16).slice(2, 8), email, verified: null, created: "agora" };
    CF.enderecos.set(x.id, x);
    return resp({ success: true, result: x });
  }
  if (metodo === "GET" && !resto) {
    const l = [...CF.enderecos.values()];
    const pagina = Number(u.searchParams.get("page") || 1), por = Number(u.searchParams.get("per_page") || 20);
    return resp({ success: true, result: l.slice((pagina - 1) * por, pagina * por), result_info: { total_count: l.length, page: pagina, per_page: por } });
  }
  const id = resto.slice(1);
  if (metodo === "GET") return CF.enderecos.has(id) ? resp({ success: true, result: CF.enderecos.get(id) }) : resp({ success: false }, 404);
  if (metodo === "DELETE") { const ok = CF.enderecos.delete(id); return resp({ success: ok }, ok ? 200 : 404); }
  return resp({ success: false }, 405);
}
globalThis.fetch = (u, op) => (String(u).startsWith("https://api.cloudflare.com/") ? cfFetch(u, op) : Promise.reject(new Error("fetch inesperado: " + u)));

const enviados = [];
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };

function novoEnv(extra = {}) {
  const objetos = new Map();
  const env = {
    CONTAS, ATOS_CHAVE: JSON.stringify(jwk), CF_ACCOUNT_ID: "conta-cf", CF_EMAIL_TOKEN: "token-cf",
    RESEND_API_KEY: "re_teste",
    ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }, { email: "sup@atos.dev.br", nome: "Sup", papel: "suporte" },
      { email: "fin@atos.dev.br", nome: "Fin", papel: "financeiro" }]),
    ASSETS: { fetch: async (req) => new Response("<p>pagina " + new URL(req.url).pathname + "</p>", { headers: { "content-type": "text/html" } }) },
    ...extra,
  };
  const ns = (Classe) => ({ idFromName: (n) => n, get(id) {
    if (!objetos.has(Classe.name + id)) objetos.set(Classe.name + id, new Classe({ storage: storage() }, env));
    const o = objetos.get(Classe.name + id);
    return { fetch: (url, op) => o.fetch(new Request(url, op)), o };
  } });
  env.CLIENTES = ns(ClienteCobranca);
  env.EMAIL_ATOS = ns(EmailAtos);
  return env;
}
// O Resend falso: o envio do codigo passa por fetch a api.resend.com; aqui ele e capturado.
const fetchCf = globalThis.fetch;
globalThis.fetch = async (u, op) => {
  if (String(u).startsWith("https://api.resend.com/")) { enviados.push(JSON.parse(op.body)); return new Response("{}", { status: 200 }); }
  return fetchCf(u, op);
};

let env = novoEnv();
const A = "https://atos.dev.br";
async function sessao(email, { idade = 0 } = {}) {
  const segredo = "s-" + email + "-" + idade;
  const sub = "sub-" + email.split("@")[0];
  guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: "Nome " + email.split("@")[0] }));
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000) - idade }));
  return "__Host-atos=" + segredo;
}
async function chamar(caminho, { metodo = "POST", corpo, cookie, origem = A, e = env } = {}) {
  const h = {};
  if (origem) h.origin = origem;
  if (cookie) h.cookie = cookie;
  let body;
  if (corpo !== undefined) { body = JSON.stringify(corpo); h["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body }), e);
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d, r };
}
const GET = (caminho, cookie, e = env) => chamar(caminho, { metodo: "GET", cookie, e });
const ativar = (cookie, e = env) => chamar("/api/workspace/ativar", { cookie, corpo: { aceito: true, versao: PRODUTOS.workspace.termos.versao }, e });
const ultimoCodigo = () => { const t = enviados[enviados.length - 1]; const m = t && /\b(\d{6})\b/.exec(t.subject); return m ? m[1] : ""; };

/* Uma mensagem como a Cloudflare entrega ao handler (ForwardableEmailMessage). */
function mensagem({ de = "fulano@exemplo.com.br", para, tamanho = 2000, cabecalhos = {}, forwardFalha = false } = {}) {
  const h = new Headers({ subject: "Assunto secreto", ...cabecalhos });
  const m = {
    from: de, to: para, headers: h, rawSize: tamanho, raw: null, canBeForwarded: true,
    rejeitado: null, encaminhado: null,
    setReject(t) { m.rejeitado = t; },
    async forward(destino, extra) {
      if (forwardFalha) throw new Error("destino nao verificado");
      m.encaminhado = { destino, cabecalhos: Object.fromEntries(extra ? [...extra] : []) };
      return { messageId: "x" };
    },
    async reply() { throw new Error("o handler nao pode responder"); },
  };
  return m;
}
const entregar = async (opts, e = env) => { const m = mensagem(opts); await worker.email(m, e, { waitUntil() {} }); return m; };
const registroDo = (e = env) => e.EMAIL_ATOS.get("registro").o.ctx.storage;

// ------------------------------------------------------------------ os nomes

console.log("os nomes do alias");
checar(conferirAlias("maria.silva").alias === "maria.silva", "maria.silva vale");
checar(conferirAlias("Joao-2").alias === "joao-2", "maiúsculas viram minúsculas");
for (const n of ["contato", "master", "pagamentos", "naoresponda", "matheusuener", "postmaster", "abuse", "admin", "suporte", "financeiro", "noreply", "no-reply", "mailer-daemon", "workspace"]) {
  checar(Boolean(conferirAlias(n).erro), n + " é reservado");
}
for (const n of ["meuatos", "pavlvs-loja", "paulus", "gmail.bob", "sup.ort.e"]) checar(Boolean(conferirAlias(n).erro), n + " lembra a Atos, um produto ou um serviço");
for (const n of ["ab", "a".repeat(31), ".maria", "maria.", "ma..ria", "maria+x", "maria_silva", "maría", "12345"]) checar(Boolean(conferirAlias(n).erro), JSON.stringify(n) + " fora do formato");
checar(Boolean(conferirDestino("eu@atos.dev.br", env).erro), "o destino não pode ser @atos.dev.br");
checar(Boolean(conferirDestino("eu@sub.atos.dev.br", env).erro), "nem um subdomínio dela");
checar(Boolean(conferirDestino("nao-e-email", env).erro), "nem algo que não é e-mail");
checar(Boolean(conferirDestino("x@exemplo.test", env).erro), "nem um domínio de teste (em produção)");
checar(conferirDestino(" Maria@Gmail.com ", env).destino === "maria@gmail.com", "o destino é normalizado");

// ------------------------------------------------------------------ as rotas

console.log("as rotas: sessão, Workspace, ligado");
const maria = await sessao("maria@gmail.com");
let r = await GET("/api/workspace/email");
checar(r.status === 401 && r.d.entrar, "sem sessão: 401", r);
r = await GET("/api/workspace/email", maria);
checar(r.status === 200 && r.d.disponivel === true && r.d.workspace === false && r.d.alias === null, "GET sem Workspace: o estado, workspace false", r.d);
r = await chamar("/api/workspace/email/alias", { cookie: maria, corpo: { alias: "maria" } });
checar(r.status === 403 && r.d.workspace === false, "reservar sem Workspace: 403", r);
r = await chamar("/api/workspace/email/alias", { cookie: maria, corpo: { alias: "maria" }, origem: "https://outro.site" });
checar(r.status === 403, "POST de outra origem: 403");
await ativar(maria);
{
  const semToken = novoEnv({ CF_EMAIL_TOKEN: "" });
  const m2 = await sessao("maria@gmail.com");
  await ativar(m2, semToken);
  const g = await GET("/api/workspace/email", m2, semToken);
  checar(g.status === 200 && g.d.disponivel === false, "sem o token: GET diz disponivel false", g.d);
  const p = await chamar("/api/workspace/email/alias", { cookie: m2, corpo: { alias: "maria" }, e: semToken });
  checar(p.status === 503 && p.d.disponivel === false, "sem o token: mudar responde 503 (ainda não está ligado)", p);
}
const velha = await sessao("maria@gmail.com", { idade: 13 * 3600 });
r = await chamar("/api/workspace/email/alias", { cookie: velha, corpo: { alias: "maria" } });
checar(r.status === 401 && r.d.reentrar, "login de mais de 12 horas: 401 reentrar", r);

console.log("o alias: reservar e unicidade");
r = await chamar("/api/workspace/email/alias", { cookie: maria, corpo: { alias: "contato" } });
checar(r.status === 400, "reservado: 400", r);
r = await GET("/api/workspace/email/disponivel?alias=maria", maria);
checar(r.d.ok === true, "maria está disponível", r.d);
r = await chamar("/api/workspace/email/alias", { cookie: maria, corpo: { alias: "Maria" } });
checar(r.status === 200 && r.d.alias.endereco === "maria@atos.dev.br" && r.d.alias.estado === "desligado" && !r.d.alias.destino, "reservou maria@atos.dev.br, desligado e sem destino", r.d);
r = await chamar("/api/workspace/email/alias", { cookie: maria, corpo: { alias: "maria" } });
checar(r.status === 200, "reservar o mesmo de novo: nada muda");
r = await chamar("/api/workspace/email/alias", { cookie: maria, corpo: { alias: "maria2" } });
checar(r.status === 409, "um alias por conta: 409", r);
const joao = await sessao("joao@outlook.com");
await ativar(joao);
r = await GET("/api/workspace/email/disponivel?alias=maria", joao);
checar(r.d.ok === false, "para outra conta, maria não está disponível");
r = await chamar("/api/workspace/email/alias", { cookie: joao, corpo: { alias: "maria" } });
checar(r.status === 409 && !/gmail/.test(JSON.stringify(r.d)), "outra conta não reserva maria (e não fica sabendo de quem é)", r);
{
  // Dois pedidos ao mesmo tempo: o objeto atende um de cada vez, so um fica com o alias.
  const ana = await sessao("ana@x.com"), bia = await sessao("bia@x.com");
  await ativar(ana); await ativar(bia);
  const [a1, b1] = await Promise.all([
    chamar("/api/workspace/email/alias", { cookie: ana, corpo: { alias: "disputado" } }),
    chamar("/api/workspace/email/alias", { cookie: bia, corpo: { alias: "disputado" } }),
  ]);
  checar([a1.status, b1.status].sort().join() === "200,409", "dois pedidos juntos pelo mesmo alias: um 200, um 409", [a1.status, b1.status]);
}

console.log("o destino: o código da Atos e a Cloudflare");
r = await chamar("/api/workspace/email/ligar", { cookie: maria, corpo: {} });
checar(r.status === 409, "ligar sem destino: 409", r);
r = await chamar("/api/workspace/email/destino", { cookie: maria, corpo: { destino: "maria@atos.dev.br" } });
checar(r.status === 400, "destino @atos.dev.br: 400");
CF.chamadas.length = 0;
r = await chamar("/api/workspace/email/destino", { cookie: maria, corpo: { destino: "Maria.Real@gmail.com" } });
checar(r.status === 200 && r.d.alias.destino.email === "maria.real@gmail.com" && !r.d.alias.destino.codigo_ok && !r.d.alias.destino.cf_ok && r.d.codigo_enviado === true,
  "pediu o destino: código mandado, nada confirmado ainda", r.d);
checar(CF.chamadas.some((c) => c.metodo === "POST" && c.auth === "Bearer token-cf"), "criou o destino na Cloudflare com o token", CF.chamadas);
checar(!("codigo_teste" in r.d), "em produção o código não volta na resposta");
const codigoMaria = ultimoCodigo();
checar(/^\d{6}$/.test(codigoMaria) && enviados[enviados.length - 1].to[0] === "maria.real@gmail.com", "o código foi ao destino pelo Resend", enviados[enviados.length - 1]);
checar(/Cloudflare/.test(enviados[enviados.length - 1].text), "o e-mail avisa do e-mail da Cloudflare");
r = await chamar("/api/workspace/email/ligar", { cookie: maria, corpo: {} });
checar(r.status === 409, "ligar antes de confirmar: 409", r);
r = await chamar("/api/workspace/email/codigo", { cookie: maria, corpo: { codigo: codigoMaria === "000000" ? "111111" : "000000" } });
checar(r.status === 400, "código errado: 400");
r = await chamar("/api/workspace/email/codigo", { cookie: maria, corpo: { codigo: codigoMaria } });
checar(r.status === 200 && r.d.alias.destino.codigo_ok, "código certo: confirmado", r.d);
r = await chamar("/api/workspace/email/conferir", { cookie: maria, corpo: {} });
checar(r.status === 200 && !r.d.alias.destino.cf_ok, "conferir: a Cloudflare ainda não verificou", r.d);
r = await chamar("/api/workspace/email/ligar", { cookie: maria, corpo: {} });
checar(r.status === 409, "ligar com a Cloudflare sem verificar: 409");

// Antes de verificar: a mensagem para maria e recusada (destino nao verificado).
let m = await entregar({ para: "maria@atos.dev.br" });
checar(m.rejeitado === RECUSA && !m.encaminhado, "mensagem com o alias desligado: recusada com o texto genérico", m.rejeitado);

CF.chamadas.length = 0;
r = await chamar("/api/workspace/email/reenviar", { cookie: maria, corpo: { qual: "cloudflare" } });
checar(r.status === 200 && CF.chamadas.some((c) => c.metodo === "DELETE") && CF.chamadas.some((c) => c.metodo === "POST") && r.d.alias.destino.codigo_ok,
  "o e-mail da Cloudflare de novo: apaga e cria o destino (só o que a Atos criou), o código continua confirmado", { c: CF.chamadas, d: r.d });
checar([...CF.enderecos.values()].filter((x) => x.email === "maria.real@gmail.com").length === 1, "um destino só na conta");
r = await chamar("/api/workspace/email/reenviar", { cookie: maria, corpo: { qual: "codigo" } });
checar(r.status === 409, "o código já confirmado não é mandado de novo", r);
for (const x of CF.enderecos.values()) if (x.email === "maria.real@gmail.com") x.verified = "2026-10-11T12:00:00Z";
r = await chamar("/api/workspace/email/conferir", { cookie: maria, corpo: {} });
checar(r.status === 200 && r.d.alias.destino.cf_ok, "a pessoa clicou no e-mail da Cloudflare: conferir mostra verificado", r.d);
r = await chamar("/api/workspace/email/ligar", { cookie: maria, corpo: {} });
checar(r.status === 200 && r.d.alias.estado === "ligado", "ligou", r.d);

console.log("o handler de e-mail");
m = await entregar({ para: "maria@atos.dev.br" });
checar(m.encaminhado && m.encaminhado.destino === "maria.real@gmail.com" && !m.rejeitado, "encaminhada ao destino", m);
checar(m.encaminhado && m.encaminhado.cabecalhos["x-atos-encaminhado"] === "maria@atos.dev.br", "com o X-Atos-Encaminhado (só cabeçalho X-)", m.encaminhado);
m = await entregar({ para: "MARIA+loja@atos.dev.br" });
checar(m.encaminhado && m.encaminhado.destino === "maria.real@gmail.com", "o subendereço (+loja) vai para o mesmo alias");
m = await entregar({ para: "ninguem-aqui@atos.dev.br" });
checar(m.rejeitado === RECUSA, "alias que não existe: a mesma recusa");
m = await entregar({ para: "contato@atos.dev.br" });
checar(m.rejeitado === RECUSA, "nome reservado que caiu no catch-all: recusa");
m = await entregar({ para: "maria@outro.com.br" });
checar(m.rejeitado === RECUSA, "outro domínio: recusa");
m = await entregar({ para: "maria@atos.dev.br", tamanho: LIMITES.tamanho + 1 });
checar(m.rejeitado === RECUSA_TAMANHO && !m.encaminhado, "maior que o limite: recusa pelo tamanho", m.rejeitado);
m = await entregar({ para: "maria@atos.dev.br", cabecalhos: { "X-Atos-Encaminhado": "maria@atos.dev.br" } });
checar(m.rejeitado === RECUSA, "já passou pela Atos (loop): recusa");
{
  const h = new Headers();
  for (let i = 0; i < LIMITES.recebidos + 1; i++) h.append("received", "from x" + i + " by y");
  const mm = mensagem({ para: "maria@atos.dev.br" });
  for (const [k, v] of h) mm.headers.append(k, v);
  await worker.email(mm, env, {});
  checar(mm.rejeitado === RECUSA, "Received demais (loop): recusa");
}
m = await entregar({ para: "maria@atos.dev.br", de: "maria@atos.dev.br" });
checar(m.rejeitado === RECUSA, "do próprio alias para ele mesmo: recusa");
let auto = 0;
for (let i = 0; i < LIMITES.auto_por_hora + 2; i++) {
  const x = await entregar({ para: "maria@atos.dev.br", de: "robo" + i + "@x.com", cabecalhos: { "Auto-Submitted": "auto-replied" } });
  if (x.encaminhado) auto++;
}
checar(auto === LIMITES.auto_por_hora, "automáticas: só " + LIMITES.auto_por_hora + " por hora", auto);
let doMesmo = 0;
for (let i = 0; i < LIMITES.por_remetente_hora + 3; i++) if ((await entregar({ para: "maria@atos.dev.br", de: "insistente@spam.com" })).encaminhado) doMesmo++;
checar(doMesmo === LIMITES.por_remetente_hora, "do mesmo remetente: só " + LIMITES.por_remetente_hora + " por hora", doMesmo);
{
  let n = 0;
  for (let i = 0; i < LIMITES.por_hora + 5; i++) if ((await entregar({ para: "maria@atos.dev.br", de: "p" + i + "@muitos.com" })).encaminhado) n++;
  const total = await registroDo().get("cnt:hora:maria");
  checar(total && total.n === LIMITES.por_hora, "por alias: no máximo " + LIMITES.por_hora + " por hora", total);
}
{
  // O forward falhou (ex.: a Cloudflare tirou o destino): recusa e anota a falha.
  const outra = novoEnv();
  const s = await sessao("lia@x.com");
  await ativar(s, outra);
  await chamar("/api/workspace/email/alias", { cookie: s, corpo: { alias: "lia" }, e: outra });
  await chamar("/api/workspace/email/destino", { cookie: s, corpo: { destino: "lia@hotmail.com" }, e: outra });
  await chamar("/api/workspace/email/codigo", { cookie: s, corpo: { codigo: ultimoCodigo() }, e: outra });
  for (const x of CF.enderecos.values()) if (x.email === "lia@hotmail.com") x.verified = "2026-10-11T12:00:00Z";
  await chamar("/api/workspace/email/conferir", { cookie: s, corpo: {}, e: outra });
  const lig = await chamar("/api/workspace/email/ligar", { cookie: s, corpo: {}, e: outra });
  checar(lig.d.alias && lig.d.alias.estado === "ligado", "lia ligada (outro registro)", lig.d);
  const f = await entregar({ para: "lia@atos.dev.br", forwardFalha: true }, outra);
  checar(f.rejeitado === RECUSA, "forward falhou: recusa");
  const log = [...(await registroDo(outra).list({ prefix: "log:" })).values()];
  checar(log.some((x) => x.resultado === "falha" && x.motivo === "forward"), "e a falha fica no registro", log);
  // Workspace desativado: para de encaminhar.
  await chamar("/api/workspace/desativar", { cookie: s, corpo: { confirmar: true }, e: outra });
  const w = await entregar({ para: "lia@atos.dev.br" }, outra);
  checar(w.rejeitado === RECUSA && !w.encaminhado, "Workspace desativado: recusa");
  const log2 = [...(await registroDo(outra).list({ prefix: "log:" })).values()];
  checar(log2.some((x) => x.motivo === "sem_workspace"), "registrado como sem_workspace");
  const g = await GET("/api/workspace/email", s, outra);
  checar(g.status === 200 && g.d.workspace === false && g.d.alias.alias === "lia", "a tela mostra o alias e o Workspace inativo", g.d);
  const tentar = await chamar("/api/workspace/email/desligar", { cookie: s, corpo: {}, e: outra });
  checar(tentar.status === 403, "sem Workspace não muda nada", tentar);
}

console.log("o registro: sem conteúdo e com prazo");
{
  const logs = [...(await registroDo().list({ prefix: "log:" })).values()];
  const texto = JSON.stringify(logs);
  checar(logs.length > 0 && !/Assunto secreto/.test(texto) && !/fulano@/.test(texto) && !/insistente@/.test(texto), "nem assunto nem remetente completo no registro", logs.slice(0, 2));
  checar(logs.some((x) => x.de === "exemplo.com.br"), "do remetente, só o domínio");
  checar(logs.some((x) => x.motivo === "loop") && logs.some((x) => x.motivo === "limite_remetente") && logs.some((x) => x.motivo === "limite_automaticas"), "os motivos ficam");
  checar(!logs.some((x) => x.alias === "ninguem-aqui"), "o alias que não existe não vai ao registro (só a contagem do dia)");
  const cnt = [...(await registroDo().list({ prefix: "cnt:inexistente:" })).values()];
  checar(cnt.length === 1 && cnt[0].n >= 1, "a contagem do dia dos inexistentes", cnt);
  const st = registroDo();
  checar(Boolean(await st.getAlarm()), "a limpeza fica marcada (alarme)");
  const o = env.EMAIL_ATOS.get("registro").o;
  const antes = (await st.list({ prefix: "log:" })).size;
  const x = await o.fazer({ op: "limpar" }, Date.now() + 31 * 864e5);
  const depois = (await st.list({ prefix: "log:" })).size;
  checar(antes > 0 && depois === 0 && x.apagados >= antes, "depois de 30 dias, o registro de entregas sai", { antes, depois });
  checar((await st.list({ prefix: "mud:" })).size > 0, "as mudanças ficam (1 ano)");
  await o.fazer({ op: "limpar" }, Date.now() + 366 * 864e5);
  checar((await st.list({ prefix: "mud:" })).size === 0, "depois de 1 ano, as mudanças saem");
}

console.log("trocar o destino, um destino que já existia, remover");
CF.chamadas.length = 0;
// O Gmail do dono ja esta verificado na conta: a Atos nao o cria, e o codigo continua exigido.
CF.enderecos.set("cf-dono", { id: "cf-dono", email: "dono.atos@gmail.com", verified: "2026-01-01T00:00:00Z" });
r = await chamar("/api/workspace/email/destino", { cookie: maria, corpo: { destino: "dono.atos@gmail.com" } });
checar(r.status === 200 && r.d.alias.estado === "desligado" && r.d.alias.destino.cf_ok && !r.d.alias.destino.codigo_ok, "trocar o destino desliga; um já verificado na Cloudflare ainda pede o código", r.d);
checar(CF.chamadas.some((c) => c.metodo === "DELETE"), "o destino antigo (só dela, criado pela Atos) sai da Cloudflare", CF.chamadas);
checar([...CF.enderecos.values()].every((x) => x.email !== "maria.real@gmail.com"), "e não está mais na conta");
r = await chamar("/api/workspace/email/ligar", { cookie: maria, corpo: {} });
checar(r.status === 409, "sem o código, não liga num destino que ela não provou ter");
m = await entregar({ para: "maria@atos.dev.br" });
checar(m.rejeitado === RECUSA, "e as mensagens são recusadas");
await chamar("/api/workspace/email/codigo", { cookie: maria, corpo: { codigo: ultimoCodigo() } });
r = await chamar("/api/workspace/email/reenviar", { cookie: maria, corpo: { qual: "cloudflare" } });
checar(r.status === 409, "não manda de novo o e-mail da Cloudflare de um destino já verificado", r);
CF.chamadas.length = 0;
r = await chamar("/api/workspace/email/remover", { cookie: maria, corpo: {} });
checar(r.status === 400, "remover pede confirmação");
r = await chamar("/api/workspace/email/remover", { cookie: maria, corpo: { confirmar: true } });
checar(r.status === 200 && r.d.alias === null, "removido", r.d);
checar(!CF.chamadas.some((c) => c.metodo === "DELETE") && CF.enderecos.has("cf-dono"), "o destino que já existia (do dono) continua na Cloudflare", CF.chamadas);
r = await chamar("/api/workspace/email/alias", { cookie: joao, corpo: { alias: "maria" } });
checar(r.status === 409, "quarentena: outra conta não pega maria por 30 dias", r);
r = await chamar("/api/workspace/email/alias", { cookie: maria, corpo: { alias: "maria" } });
checar(r.status === 200, "a mesma conta pega de volta");

console.log("o teto de destinos");
{
  const cheio = novoEnv({ EMAIL_LIMITE_DESTINOS: String(CF.enderecos.size) });
  const s = await sessao("cheio@x.com");
  await ativar(s, cheio);
  await chamar("/api/workspace/email/alias", { cookie: s, corpo: { alias: "cheio" }, e: cheio });
  const t = await chamar("/api/workspace/email/destino", { cookie: s, corpo: { destino: "cheio@yahoo.com" }, e: cheio });
  checar(t.status === 409 && t.d.esgotado === true, "vagas acabaram: 409 esgotado", t);
  checar(![...CF.enderecos.values()].some((x) => x.email === "cheio@yahoo.com"), "e nada foi criado na Cloudflare");
}

console.log("o painel da equipe");
{
  const dono = await sessao("dono@atos.dev.br"), sup = await sessao("sup@atos.dev.br"), fin = await sessao("fin@atos.dev.br");
  r = await GET("/api/admin/email", fin);
  checar(r.status === 200 && r.d.aliases.some((a) => a.alias === "maria") && r.d.vagas.teto_cf === 200, "o financeiro vê os endereços e as vagas", r.d);
  r = await chamar("/api/admin/email/maria/suspender", { cookie: fin, corpo: { motivo: "spam" } });
  checar(r.status === 403, "o financeiro não suspende");
  r = await chamar("/api/admin/email/maria/suspender", { cookie: sup, corpo: {} });
  checar(r.status === 400, "suspender pede o motivo");
  r = await chamar("/api/admin/email/maria/suspender", { cookie: sup, corpo: { motivo: "denúncia de spam" } });
  checar(r.status === 200 && r.d.alias.suspenso.motivo === "denúncia de spam", "o suporte suspende", r.d);
  const g = await GET("/api/workspace/email", maria);
  checar(g.d.alias.suspenso && g.d.alias.suspenso.motivo === "denúncia de spam" && !("por" in g.d.alias.suspenso), "a pessoa vê a suspensão e o motivo (não quem)", g.d.alias);
  r = await chamar("/api/workspace/email/ligar", { cookie: maria, corpo: {} });
  checar(r.status === 403, "suspenso: a pessoa não liga", r);
  r = await chamar("/api/workspace/email/destino", { cookie: maria, corpo: { destino: "outra@gmail.com" } });
  checar(r.status === 403, "nem troca o destino");
  r = await GET("/api/admin/email/registro?alias=maria", dono);
  checar(r.status === 200 && r.d.mudancas.some((x) => /suspendeu/.test(x.oque) && x.por === "sup@atos.dev.br"), "o registro mostra quem suspendeu", r.d.mudancas);
  r = await chamar("/api/admin/email/maria/reativar", { cookie: dono, corpo: {} });
  checar(r.status === 200 && !r.d.alias.suspenso && r.d.alias.estado === "desligado", "reativar tira a suspensão; continua desligado", r.d);
  r = await chamar("/api/admin/email/maria/remover", { cookie: dono, corpo: { confirmar: true, motivo: "abuso" } });
  checar(r.status === 200 && r.d.removido === "maria", "a equipe remove", r.d);
  r = await GET("/api/admin/email", await sessao("joao@outlook.com"));
  checar(r.status === 403, "fora da equipe: 403");
}

console.log("a Cloudflare simulada do Worker de teste");
{
  const t = novoEnv({ AMBIENTE: "teste", EMAIL_CF_SIMULADA: "1", CF_EMAIL_TOKEN: "", CF_ACCOUNT_ID: "", RESEND_API_KEY: "" });
  const s = await sessao("teste@exemplo.test");
  await ativar(s, t);
  const enviadosAntes = enviados.length, cfAntes = CF.chamadas.length;
  let g = await GET("/api/workspace/email", s, t);
  checar(g.d.disponivel === true && g.d.simulada === true, "ligado e marcado como simulado", g.d);
  await chamar("/api/workspace/email/alias", { cookie: s, corpo: { alias: "teste-sim" }, e: t });
  const d = await chamar("/api/workspace/email/destino", { cookie: s, corpo: { destino: "destino@exemplo.test" }, e: t });
  checar(d.status === 200 && /^\d{6}$/.test(d.d.codigo_teste || ""), "o código volta na resposta (só no teste)", d.d);
  await chamar("/api/workspace/email/codigo", { cookie: s, corpo: { codigo: d.d.codigo_teste }, e: t });
  g = await chamar("/api/workspace/email/conferir", { cookie: s, corpo: {}, e: t });
  checar(g.d.alias.destino.cf_ok, "conferir marca verificado na simulada", g.d);
  g = await chamar("/api/workspace/email/ligar", { cookie: s, corpo: {}, e: t });
  checar(g.d.alias.estado === "ligado", "liga", g.d);
  checar(enviados.length === enviadosAntes && CF.chamadas.length === cfAntes, "nenhum e-mail saiu e a Cloudflare de verdade não foi chamada");
  const sem = novoEnv({ CF_EMAIL_TOKEN: "", EMAIL_CF_SIMULADA: "1" });
  checar((await GET("/api/workspace/email", await sessao("p@x.com"), sem)).d.disponivel === false, "a simulada só vale com AMBIENTE teste");
}

console.log("as páginas");
r = await GET("/workspace/email");
checar(r.status === 200 && /pagina \/workspace\/</.test(await r.r.text()) && /script-src 'self'/.test(r.r.headers.get("content-security-policy")), "/workspace/email serve a página do Workspace com a CSP da conta");

console.log(falhas ? "\n" + falhas + " FALHA(S)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
