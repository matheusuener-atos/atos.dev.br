// Teste do painel da Atos (worker/admin.js): quem entra, o login recente, os papeis, a equipe no KV (com a semente
// ATOS_EQUIPE), a fila da equipe, o GitHub e o encaminhamento ao PAVLVS (a assinatura). Sem rede.
//   node worker/teste-admin.mjs
import { atenderAdmin, equipeDaSemente, K, RECENTE_S, JANELA_PAVLVS_S, PRODUTOS, RESERVADOS } from "./admin.js";
import { sha256 } from "./comum.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
};
const agora = Date.parse("2026-10-11T12:00:00Z");
const SEGREDO = "segredo-do-painel-de-teste";
const env = {
  CONTAS, APP_URL: "https://atos.dev.br", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csec", PAINEL_SEGREDO_PAVLVS: SEGREDO,
  ATOS_EQUIPE: JSON.stringify([{ email: "Dono@Atos.dev.br", nome: "Matheus", papel: "dono" }, { email: "sup@atos.dev.br", papel: "suporte" }, { email: "x@y", papel: "rei" }]),
};

// O PAVLVS de mentira (o service binding): anota o pedido e responde o que o teste pedir.
const pavlvs = { pedidos: [], resposta: () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "x-do-pavlvs": "1" } }) };
pavlvs.fetch = async (req) => {
  const corpo = req.body ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);
  pavlvs.pedidos.push({ req, corpo });
  return pavlvs.resposta(req);
};
// O GitHub de mentira.
let permissao = "write";
const github = async (metodo, url, token, corpo) => {
  if (url.includes("/login/oauth/access_token")) return { ok: true, status: 200, dados: corpo.code === "bom" ? { access_token: "gho_segredo123" } : {} };
  if (url.endsWith("/user")) return { ok: true, status: 200, dados: { login: "matheus" } };
  if (url.includes("/collaborators/")) return { ok: true, status: 200, dados: { permission: permissao } };
  return { ok: false, status: 404, dados: null };
};
const emails = [];
let emailFalha = false;
const enviarEmail = async (e, msg) => { if (emailFalha) return { ok: false, status: 503, erro: "o envio de e-mail ainda não está ligado" }; emails.push(msg); return { ok: true }; };

/* Uma sessao aberta para o e-mail, com o login de `horas` atras: o cookie. */
async function sessao(email, horas) {
  const segredo = "s-" + email + "-" + horas;
  guardados.set("id:conta:" + email, JSON.stringify({ sub: "sub-" + email, nome: "Nome" }));
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub: "sub-" + email, email, auth_time: Math.floor(agora / 1000 - horas * 3600) }));
  return "__Host-atos=" + segredo;
}
async function pedir(metodo, caminho, cookie, { deps = {}, envUsado = env, corpo, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (corpo !== undefined) h["content-type"] = "application/json";
  const req = new Request("https://atos.dev.br" + caminho, { method: metodo, headers: h, body: corpo === undefined ? undefined : typeof corpo === "string" ? corpo : JSON.stringify(corpo) });
  const r = await atenderAdmin(req, envUsado, new URL(req.url), { agora: () => agora, github, enviarEmail, pavlvs, ...deps });
  const tipo = r.headers.get("content-type") || "";
  return { status: r.status, r, d: tipo.includes("json") ? await r.json() : null };
}

console.log("a equipe: a semente");
checar(equipeDaSemente(env).length === 2 && equipeDaSemente(env)[0].email === "dono@atos.dev.br", "a semente: o e-mail em minúsculas e só papel que existe", equipeDaSemente(env));
checar(equipeDaSemente({ ATOS_EQUIPE: "isto não é json" }).length === 0 && equipeDaSemente({}).length === 0, "sem a semente (ou com ela quebrada), ninguém entra");
checar(K(env).equipe === "atos:admin:equipe" && K({ AMBIENTE: "teste" }).equipe === "atos-teste:admin:equipe", "o Worker de teste tem as chaves dele (o KV é o mesmo)");

console.log("quem entra");
let r = await pedir("GET", "/api/admin/eu");
checar(r.status === 401 && r.d.entrar, "sem sessão: 401, entrar", r.d);
r = await pedir("GET", "/api/admin/eu", await sessao("fora@x.br", 1));
checar(r.status === 403 && !JSON.stringify(r.d).includes("ATOS_EQUIPE"), "Conta Atos fora da equipe: 403, sem detalhe de configuração", r.d);
r = await pedir("GET", "/api/admin/eu", await sessao("dono@atos.dev.br", RECENTE_S / 3600 + 1));
checar(r.status === 401 && r.d.reentrar, "login de mais de 12 horas: 401, entrar de novo", r);
const dono = await sessao("dono@atos.dev.br", 1);
r = await pedir("GET", "/api/admin/eu", dono);
checar(r.status === 200 && r.d.email === "dono@atos.dev.br" && r.d.papel === "dono" && r.d.nome === "Matheus" && r.d.github === null, "o dono entra pela semente (sem GitHub ainda)", r.d);
checar(guardados.has("atos:admin:acesso:dono@atos.dev.br"), "o acesso fica anotado (o último, na tela Equipe)");

console.log("as notas");
const chamadas = [];
const emissor = async (req, e, url, quem) => { chamadas.push({ metodo: req.method, caminho: url.pathname, quem }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
r = await pedir("GET", "/api/admin/nfse/situacao", dono);
checar(r.status === 503, "sem o emissor ligado: 503", r);
r = await pedir("POST", "/api/admin/nfse/notas", dono, { deps: { emissor } });
checar(r.status === 200 && chamadas.at(-1).quem.papel === "dono" && chamadas.at(-1).caminho === "/api/admin/nfse/notas", "o dono emite: o emissor recebe quem pediu", chamadas.at(-1));
const sup = await sessao("sup@atos.dev.br", 1);
r = await pedir("GET", "/api/admin/nfse/notas", sup, { deps: { emissor } });
checar(r.status === 200, "o suporte consulta", r.status);
const antes = chamadas.length;
r = await pedir("POST", "/api/admin/nfse/notas/1/cancelar", sup, { deps: { emissor } });
checar(r.status === 403 && chamadas.length === antes, "o suporte não cancela nem emite: 403, e o emissor nem é chamado", r);
r = await pedir("GET", "/api/admin/outra", dono, { deps: { emissor } });
checar(r.status === 404, "rota que não existe: 404");

// ------------------------------------------------------------ o PAVLVS
console.log("o painel do PAVLVS (encaminhado)");
const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function conferir(pedido) {
  const { req, corpo } = pedido;
  const quem64 = req.headers.get("atos-painel-quem");
  const p = Object.fromEntries(req.headers.get("atos-painel-assinatura").split(",").map((x) => x.split("=")));
  const u = new URL(req.url);
  const k = await crypto.subtle.importKey("raw", te.encode(SEGREDO), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const texto = [p.t, req.method, u.pathname + u.search, hex(await crypto.subtle.digest("SHA-256", corpo)), quem64].join(".");
  const esperado = hex(await crypto.subtle.sign("HMAC", k, te.encode(texto)));
  return { ok: esperado === p.v1, t: Number(p.t), quem: JSON.parse(Buffer.from(quem64, "base64url").toString("utf8")) };
}
r = await pedir("GET", "/api/admin/pavlvs/tokens?visao=conta&periodo=mes", dono, { headers: { "Atos-Painel-Quem": "forjado", "Atos-Painel-Assinatura": "t=1,v1=00" } });
let ped = pavlvs.pedidos.at(-1);
let conf = await conferir(ped);
checar(r.status === 200 && r.r.headers.get("x-do-pavlvs") === "1" && r.d.ok, "o pedido chega ao PAVLVS e a resposta volta como veio", r.d);
checar(new URL(ped.req.url).pathname === "/api/admin/pavlvs/tokens" && new URL(ped.req.url).search === "?visao=conta&periodo=mes", "o mesmo caminho e a mesma query", ped.req.url);
checar(conf.ok && conf.t === Math.floor(agora / 1000) && conf.quem.email === "dono@atos.dev.br" && conf.quem.papel === "dono" && conf.quem.nome === "Matheus" && conf.quem.github === null,
  "assinado (HMAC do método, caminho, corpo, t e quem) com quem pede e o papel; os cabeçalhos que o navegador mandou não passam", conf);
const corpoPost = JSON.stringify({ tipo: "conta.creditar", dados: { id: "a".repeat(24), tokens: 5 }, texto: "Creditei" });
r = await pedir("POST", "/api/admin/pavlvs/alteracoes", sup, { corpo: corpoPost });
ped = pavlvs.pedidos.at(-1);
conf = await conferir(ped);
checar(conf.ok && new TextDecoder().decode(ped.corpo) === corpoPost && ped.req.method === "POST" && ped.req.headers.get("content-type") === "application/json" && conf.quem.papel === "suporte",
  "POST do suporte: o corpo vai intacto e o PAVLVS decide o que o suporte pode (a Atos não barra)", conf.quem);
pavlvs.resposta = () => new Response(JSON.stringify({ erro: "o papel suporte não pode fazer isso" }), { status: 403, headers: { "content-type": "application/json" } });
r = await pedir("POST", "/api/admin/pavlvs/alteracoes", sup, { corpo: corpoPost });
checar(r.status === 403 && r.d.erro.includes("suporte"), "a recusa do PAVLVS volta como veio", r.d);
pavlvs.resposta = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
const n = pavlvs.pedidos.length;
r = await pedir("GET", "/api/admin/pavlvs/visao", await sessao("fora@x.br", 1));
checar(r.status === 403 && pavlvs.pedidos.length === n, "fora da equipe: 403, e nada vai ao PAVLVS");
r = await pedir("GET", "/api/admin/pavlvs/visao", await sessao("dono@atos.dev.br", 13));
checar(r.status === 401 && pavlvs.pedidos.length === n, "login velho: 401, e nada vai ao PAVLVS");
r = await pedir("GET", "/api/admin/pavlvs/visao", dono, { deps: { pavlvs: null } });
checar(r.status === 503 && r.d.erro === "o PAVLVS não está ligado a este painel", "sem o binding PAVLVS (o Worker de teste): 503", r.d);
r = await pedir("GET", "/api/admin/pavlvs/visao", dono, { envUsado: { ...env, PAINEL_SEGREDO_PAVLVS: "" } });
checar(r.status === 503 && pavlvs.pedidos.length === n, "sem o segredo: 503, e nada vai ao PAVLVS");
r = await pedir("GET", "/api/admin/pavlvs/visao", dono, { deps: { pavlvs: { fetch: async () => { throw new Error("caiu"); } } } });
checar(r.status === 502, "o PAVLVS não respondeu: 502");
checar(JANELA_PAVLVS_S === 60, "a janela da assinatura é de 60 s");

// ------------------------------------------------------------ o GitHub
console.log("o GitHub");
r = await pedir("GET", "/api/admin/github/entrar?volta=alteracoes", dono);
const loc = new URL(r.r.headers.get("location"));
const state = loc.searchParams.get("state");
checar(r.status === 302 && loc.hostname === "github.com" && loc.searchParams.get("scope") === "public_repo read:user" && loc.searchParams.get("redirect_uri") === "https://atos.dev.br/api/admin/github/retorno",
  "entrar com o GitHub: 302, com o escopo e a volta em atos.dev.br", loc.href);
r = await pedir("GET", "/api/admin/github/entrar", dono, { envUsado: { ...env, GITHUB_CLIENT_SECRET: "" } });
checar(r.status === 503 && r.d.erro.includes("GITHUB_CLIENT_SECRET"), "sem o OAuth App: 503 dizendo o que falta (só para a equipe)");
r = await pedir("GET", "/api/admin/github/entrar", "");
checar(r.status === 302 && r.r.headers.get("location") === "/admin/", "sem sessão, o entrar volta ao painel (que leva ao entrar da Conta Atos)");
r = await pedir("GET", "/api/admin/github/retorno?code=bom&state=errado-errado-errado", dono);
checar(r.status === 302 && r.r.headers.get("location").includes("erro="), "state errado volta com erro");
r = await pedir("GET", "/api/admin/github/retorno?code=bom&state=" + state, sup);
checar(r.r.headers.get("location").includes("erro="), "o state de uma pessoa não serve para outra");
r = await pedir("GET", "/api/admin/github/entrar?volta=alteracoes", dono);
let st = new URL(r.r.headers.get("location")).searchParams.get("state");
permissao = "read";
r = await pedir("GET", "/api/admin/github/retorno?code=bom&state=" + st, dono);
checar(r.r.headers.get("location").includes("escrita"), "conta sem escrita no repositório não liga", r.r.headers.get("location"));
permissao = "write";
r = await pedir("GET", "/api/admin/github/entrar?volta=alteracoes", dono);
st = new URL(r.r.headers.get("location")).searchParams.get("state");
r = await pedir("GET", "/api/admin/github/retorno?code=bom&state=" + st, dono);
checar(r.status === 302 && r.r.headers.get("location") === "/admin/?github=1#alteracoes", "login completo: volta à tela pedida", r.r.headers.get("location"));
const chaveGh = [...guardados.keys()].find((k) => k.startsWith("atos:admin:github:"));
checar(chaveGh && !guardados.get(chaveGh).includes("gho_segredo123") && JSON.parse(guardados.get(chaveGh)).login === "matheus", "o token fica cifrado no KV (o texto dele não aparece)");
r = await pedir("GET", "/api/admin/eu", dono);
checar(r.d.github === "matheus", "o /eu diz o GitHub ligado", r.d);
guardados.set("atos:sessao:" + (await sha256("outro-navegador")), JSON.stringify({ sub: "sub-dono@atos.dev.br", email: "dono@atos.dev.br", auth_time: Math.floor(agora / 1000) }));
checar((await pedir("GET", "/api/admin/eu", "__Host-atos=outro-navegador")).d.github === null, "em outra sessão (outro navegador), o GitHub não está ligado");
await pedir("POST", "/api/admin/pavlvs/publicar", dono, { corpo: { confirmacao: "comitar e pushar" } });
conf = await conferir(pavlvs.pedidos.at(-1));
checar(conf.ok && conf.quem.github && conf.quem.github.login === "matheus" && conf.quem.github.token === "gho_segredo123", "o PAVLVS recebe o token do GitHub da sessão, dentro da assinatura", conf.quem.github && conf.quem.github.login);
r = await pedir("POST", "/api/admin/github/sair", dono);
checar(r.d.ok && !guardados.has(chaveGh) && (await pedir("GET", "/api/admin/eu", dono)).d.github === null, "sair do GitHub esquece o token");

// ------------------------------------------------------------ a equipe
console.log("a equipe e a fila");
let eq = (await pedir("GET", "/api/admin/equipe", sup)).d;
checar(eq.membros.length === 2 && eq.matriz.length >= 3 && eq.liberacao.ligado, "a tela Equipe: os membros (da semente) e a matriz", eq);
const pedirFila = (cookie, tipo, dados, texto = tipo) => pedir("POST", "/api/admin/alteracoes", cookie, { corpo: { tela: "equipe", tipo, alvo: dados.email || "", dados, texto } });
const publicar = (cookie = dono, confirmacao = "comitar e pushar") => pedir("POST", "/api/admin/publicar", cookie, { corpo: { confirmacao } });
// So se libera o painel a uma Conta Atos que ja existe.
r = await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Sem Conta", email: "semconta@atos.dev.br", papel: "suporte", areas: ["atos"] });
checar(r.status === 400 && /ainda não tem Conta Atos/.test(r.d.erro), "e-mail sem Conta Atos: recusado, dizendo para criar a conta primeiro", r);
for (const e of ["bia@atos.dev.br", "caio@atos.dev.br", "beatriz@atos.dev.br", "duda@atos.dev.br", "eva@atos.dev.br", "x@atos.dev.br"]) {
  if (!guardados.has("id:conta:" + e)) guardados.set("id:conta:" + e, JSON.stringify({ sub: "sub-" + e, nome: "Nome" }));
}
r = await pedirFila(sup, "equipe.membro", { acao: "criar", nome: "Xavier", email: "x@atos.dev.br", papel: "dono" });
checar(r.status === 403, "o suporte não mexe na equipe");
r = await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Ana", email: "sup@atos.dev.br", papel: "suporte", areas: ["atos"] });
checar(r.status === 400, "incluir quem já está: recusado");
r = await pedirFila(dono, "coisa.estranha", {});
checar(r.status === 400, "tipo desconhecido: recusado");
r = await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Bia Souza", email: "Bia@atos.dev.br", papel: "financeiro", areas: ["atos", "pavlvs"] }, "Incluí a Bia");
checar(r.status === 200 && r.d.pendentes.length === 1 && !guardados.has("atos:admin:equipe"), "entra na fila; a equipe não muda antes de publicar");
r = await publicar(dono, "publicar");
checar(r.status === 400, "a frase errada não publica");
r = await publicar();
checar(r.d.ok && r.d.publicacao.n === 1 && JSON.parse(guardados.get("atos:admin:equipe")).some((x) => x.email === "bia@atos.dev.br" && x.papel === "financeiro"),
  "publicado: a equipe vai para o KV (partindo da semente) com a Bia", r.d);
checar(emails.length === 1 && emails[0].para === "bia@atos.dev.br" && emails[0].texto.includes("Financeiro") && emails[0].texto.includes("atos.dev.br/admin"), "a Bia recebe o aviso de como entrar", emails[0]);
eq = (await pedir("GET", "/api/admin/equipe", dono)).d;
const mBia = eq.membros.find((x) => x.email === "bia@atos.dev.br");
checar(mBia && mBia.convite && mBia.convite.por === "dono@atos.dev.br", "enquanto não entra, a tela mostra o convite", mBia);
checar((await pedir("GET", "/api/admin/eu", dono, { envUsado: { ...env, ATOS_EQUIPE: "[]" } })).status === 200, "com a equipe no KV, a semente já não importa");
const bia = await sessao("bia@atos.dev.br", 1);
r = await pedir("GET", "/api/admin/eu", bia);
checar(r.status === 200 && r.d.papel === "financeiro", "a Bia entra com a Conta Atos do e-mail, sem Access nem aceite", r.d);
eq = (await pedir("GET", "/api/admin/equipe", dono)).d;
checar(!eq.membros.find((x) => x.email === "bia@atos.dev.br").convite, "e o convite some da tela");
r = await pedir("POST", "/api/admin/equipe/convite/" + encodeURIComponent("bia@atos.dev.br") + "/reenviar", dono);
checar(r.status === 404, "reenviar para quem já entrou: 404");

emailFalha = true;
await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Caio", email: "caio@atos.dev.br", papel: "suporte", areas: ["atos"] }, "Incluí o Caio");
r = await publicar();
checar(r.d.ok && String(r.d.resultados[0].aviso).includes("avise a pessoa"), "sem o e-mail, o Caio entra e o aviso da publicação diz", r.d.resultados);
emailFalha = false;
r = await pedir("POST", "/api/admin/equipe/convite/" + encodeURIComponent("caio@atos.dev.br") + "/reenviar", sup);
checar(r.status === 403, "o suporte não reenvia");
emails.length = 0;
r = await pedir("POST", "/api/admin/equipe/convite/" + encodeURIComponent("caio@atos.dev.br") + "/reenviar", dono);
checar(r.status === 200 && emails.length === 1 && emails[0].para === "caio@atos.dev.br", "o dono reenvia o aviso");
await pedirFila(dono, "equipe.membro", { acao: "cancelar_convite", email: "caio@atos.dev.br" }, "Cancelei o Caio");
r = await publicar();
checar(r.d.ok && !JSON.parse(guardados.get("atos:admin:equipe")).some((x) => x.email === "caio@atos.dev.br"), "cancelar o convite tira o Caio");
r = await pedirFila(dono, "equipe.membro", { acao: "cancelar_convite", email: "bia@atos.dev.br" });
checar(r.status === 400, "cancelar o convite de quem já entrou: recusado (é excluir)");

r = await pedirFila(dono, "equipe.membro", { acao: "excluir", email: "dono@atos.dev.br" });
checar(r.status === 400 && r.d.erro.includes("pelo menos um dono"), "a equipe não fica sem dono (excluir)");
await pedirFila(dono, "equipe.papel", { email: "dono@atos.dev.br", papel: "suporte" }, "Rebaixei o dono");
r = await publicar();
checar(!r.d.ok && r.d.resultados[0].erro.includes("pelo menos um dono"), "nem mudando o papel", r.d);
await pedir("DELETE", "/api/admin/alteracoes/" + (await pedir("GET", "/api/admin/alteracoes", dono)).d.pendentes[0].id, dono);
checar(!(await pedir("GET", "/api/admin/alteracoes", dono)).d.pendentes.length, "tirar da fila");

const equipeAntes = guardados.get("atos:admin:equipe");
await pedirFila(dono, "equipe.papel", { email: "bia@atos.dev.br", papel: "suporte" }, "Bia para suporte");
const pubPapel = (await publicar()).d.publicacao;
checar(JSON.parse(guardados.get("atos:admin:equipe")).find((x) => x.email === "bia@atos.dev.br").papel === "suporte" && pubPapel.retroagivel, "mudar o papel");
checar((await pedir("GET", "/api/admin/eu", bia)).d.papel === "suporte", "e vale na hora (também no que a Atos assina ao PAVLVS)");
r = await pedir("POST", "/api/admin/retroagir", bia, { corpo: { publicacao: pubPapel.id, confirmacao: "retroagir" } });
checar(r.status === 403, "só o dono retroage");
r = await pedir("POST", "/api/admin/retroagir", dono, { corpo: { commit: pubPapel.commit, confirmacao: "retroagir" } });
checar(r.status === 200 && guardados.get("atos:admin:equipe") === equipeAntes, "retroagir o papel: a equipe volta ao que era", r.d);
r = await pedir("POST", "/api/admin/retroagir", dono, { corpo: { publicacao: pubPapel.id, confirmacao: "retroagir" } });
checar(r.status === 409, "de novo: já foi retroagida");
const pubBia = (await pedir("GET", "/api/admin/alteracoes", dono)).d.publicacoes.find((x) => x.resumo === "Incluí a Bia");
r = await pedir("POST", "/api/admin/retroagir", dono, { corpo: { publicacao: pubBia.id, confirmacao: "retroagir" } });
checar(r.status === 409 && r.d.erro.includes("própria tela"), "incluir alguém não volta por retroagir (volta pela tela)", r.d);

await pedirFila(dono, "equipe.membro", { acao: "editar", de: "bia@atos.dev.br", email: "beatriz@atos.dev.br", nome: "Beatriz Souza", papel: "financeiro" }, "Troquei o e-mail da Bia");
r = await publicar();
const eqKV = JSON.parse(guardados.get("atos:admin:equipe"));
checar(r.d.ok && eqKV.some((x) => x.email === "beatriz@atos.dev.br") && !eqKV.some((x) => x.email === "bia@atos.dev.br") && (await pedir("GET", "/api/admin/eu", bia)).status === 403,
  "trocar o e-mail: o novo entra, o antigo sai (e não entra mais)");
await pedirFila(dono, "equipe.membro", { acao: "excluir", email: "beatriz@atos.dev.br" }, "Tirei a Beatriz");
r = await publicar();
checar(r.d.ok && !JSON.parse(guardados.get("atos:admin:equipe")).some((x) => x.email === "beatriz@atos.dev.br"), "excluir");

// ------------------------------------------------------------ as areas
console.log("as áreas (onde cada um atua)");
checar(Object.keys(PRODUTOS).every((id) => !RESERVADOS.includes(id) && /^[a-z0-9-]{1,30}$/.test(id)), "nenhum produto tem id de rota do painel");
r = await pedir("GET", "/api/admin/eu", dono);
checar(r.d.areas.join() === "atos,pavlvs" && r.d.produtos.length === 1 && r.d.produtos[0].id === "pavlvs" && r.d.produtos[0].nome === "PAVLVS" && r.d.produtos[0].github === true && r.d.areas_do_painel[0].id === "atos",
  "o /eu traz as áreas da pessoa e o registro de produtos (id, nome e github)", r.d);
checar(Object.keys(r.d.produtos[0]).sort().join() === "github,id,nome" && !/binding|segredo|origem|PAINEL_SEGREDO|paulus\.ia\.br/.test(JSON.stringify(r.d.produtos)),
  "o /eu não expõe o binding, o segredo nem a origem do produto", r.d.produtos);
r = await pedir("GET", "/api/admin/eu", sup);
checar(r.d.areas.join() === "atos,pavlvs", "membro antigo, sem a lista: todas as áreas", r.d.areas);
chamadas.length = 0;
const nPv = pavlvs.pedidos.length;
r = await pedir("POST", "/api/admin/nfse/notas/1/cancelar", sup, { deps: { emissor } });
checar(r.status === 403 && chamadas.length === 0, "(o papel continua valendo: o suporte com a área Atos não cancela)");
checar((await pedir("GET", "/api/admin/nfse/notas", sup, { deps: { emissor } })).status === 200 && (await pedir("GET", "/api/admin/pavlvs/visao", sup)).status === 200,
  "membro antigo chega à Atos e ao PAVLVS");
r = await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Duda", email: "duda@atos.dev.br", papel: "financeiro" });
checar(r.status === 400 && r.d.erro.includes("área"), "convidar quem não é dono sem marcar área: recusado", r.d);
r = await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Duda", email: "duda@atos.dev.br", papel: "financeiro", areas: ["plantare"] });
checar(r.status === 400 && r.d.erro.includes("desconhecida"), "área que não existe: recusada", r.d);
await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Duda", email: "duda@atos.dev.br", papel: "financeiro", areas: ["pavlvs"] }, "Incluí a Duda (PAVLVS)");
await pedirFila(dono, "equipe.membro", { acao: "criar", nome: "Eva", email: "eva@atos.dev.br", papel: "financeiro", areas: ["atos"] }, "Incluí a Eva (Atos)");
emails.length = 0;
r = await publicar();
checar(r.d.ok && emails.some((e) => e.para === "duda@atos.dev.br" && e.texto.includes("Você atua em: PAVLVS")), "publicado; o aviso diz onde a pessoa atua", emails.map((e) => e.texto));
const duda = await sessao("duda@atos.dev.br", 1);
const eva = await sessao("eva@atos.dev.br", 1);
checar((await pedir("GET", "/api/admin/eu", duda)).d.areas.join() === "pavlvs", "a Duda atua só no PAVLVS");
chamadas.length = 0;
r = await pedir("GET", "/api/admin/nfse/notas", duda, { deps: { emissor } });
checar(r.status === 403 && chamadas.length === 0 && r.d.erro.includes("Atos"), "só com o PAVLVS: as notas da Atos dão 403, e o emissor nem é chamado", r.d);
r = await pedir("POST", "/api/admin/nfse/notas", duda, { deps: { emissor } });
checar(r.status === 403 && chamadas.length === 0, "nem para emitir");
r = await pedir("GET", "/api/admin/nfse/municipios?q=sao", duda, { deps: { emissor } });
checar(r.status === 200 && chamadas.length === 1, "a tabela de municípios (consulta, usada no cadastro do PAVLVS) serve a ela");
r = await pedir("GET", "/api/admin/pavlvs/visao", duda);
checar(r.status === 200 && pavlvs.pedidos.length === nPv + 2 && (await conferir(pavlvs.pedidos.at(-1))).quem.email === "duda@atos.dev.br", "e chega ao PAVLVS");
r = await pedir("GET", "/api/admin/pavlvs/visao", eva);
checar(r.status === 403 && pavlvs.pedidos.length === nPv + 2 && r.d.erro.includes("PAVLVS"), "só com a Atos: o PAVLVS dá 403, e o binding nem é chamado", r.d);
r = await pedir("POST", "/api/admin/pavlvs/alteracoes", eva, { corpo: corpoPost });
checar(r.status === 403 && pavlvs.pedidos.length === nPv + 2, "nem um POST");
checar((await pedir("POST", "/api/admin/nfse/notas", eva, { deps: { emissor } })).status === 200, "e a Eva (financeiro, Atos) emite");
eq = (await pedir("GET", "/api/admin/equipe", eva)).d;
const mDuda = eq.membros.find((x) => x.email === "duda@atos.dev.br"), mDono = eq.membros.find((x) => x.email === "dono@atos.dev.br");
checar(mDuda.areas.join() === "pavlvs" && !mDuda.todas && mDono.todas && mDono.areas.length === 2 && eq.areas_do_painel.map((a) => a.nome).join() === "Atos,PAVLVS",
  "a tela Equipe: as áreas de cada um e as do painel", eq);

console.log("a fila das áreas");
r = await pedirFila(eva, "equipe.areas", { email: "duda@atos.dev.br", areas: ["atos"] });
checar(r.status === 403, "só o dono muda as áreas");
r = await pedirFila(dono, "equipe.areas", { email: "dono@atos.dev.br", areas: ["atos"] });
checar(r.status === 400 && r.d.erro.includes("todas"), "o dono atua em todas: não tem lista", r.d);
r = await pedirFila(dono, "equipe.areas", { email: "duda@atos.dev.br", areas: [] });
checar(r.status === 400, "sem nenhuma área: recusado");
r = await pedirFila(dono, "equipe.areas", { email: "ninguem@atos.dev.br", areas: ["atos"] });
checar(r.status === 400, "quem não está na equipe: recusado");
const eqAntesAreas = guardados.get("atos:admin:equipe");
await pedirFila(dono, "equipe.areas", { email: "duda@atos.dev.br", areas: ["atos", "pavlvs"] }, "Duda nas duas");
r = await pedir("GET", "/api/admin/nfse/notas", duda, { deps: { emissor } });
checar(r.status === 403, "na fila, ainda não vale");
await pedirFila(dono, "equipe.areas", { email: "duda@atos.dev.br", areas: ["atos"] }, "Duda só na Atos");
const pubAreas = (await publicar()).d.publicacao;
checar(pubAreas.n === 2 && pubAreas.retroagivel, "publicado (duas mudanças da mesma pessoa numa publicação)", pubAreas);
checar((await pedir("GET", "/api/admin/nfse/notas", duda, { deps: { emissor } })).status === 200 && (await pedir("GET", "/api/admin/pavlvs/visao", duda)).status === 403,
  "vale na hora: a Duda vai para a Atos e sai do PAVLVS");
r = await pedir("POST", "/api/admin/retroagir", dono, { corpo: { publicacao: pubAreas.id, confirmacao: "retroagir" } });
checar(r.status === 200 && guardados.get("atos:admin:equipe") === eqAntesAreas && (await pedir("GET", "/api/admin/eu", duda)).d.areas.join() === "pavlvs",
  "retroagir as áreas (as duas de uma vez): a Duda volta só ao PAVLVS", r.d);
await pedirFila(dono, "equipe.papel", { email: "duda@atos.dev.br", papel: "suporte" }, "Duda suporte");
await publicar();
checar((await pedir("GET", "/api/admin/eu", duda)).d.areas.join() === "pavlvs", "mudar o papel não mexe nas áreas");
await pedirFila(dono, "equipe.membro", { acao: "editar", de: "duda@atos.dev.br", email: "duda@atos.dev.br", nome: "Duda Lima", papel: "suporte" }, "Nome da Duda");
await publicar();
checar((await pedir("GET", "/api/admin/eu", duda)).d.areas.join() === "pavlvs", "editar sem mandar áreas mantém as de antes");

console.log("um produto novo (uma linha no registro)");
PRODUTOS.plantare = { nome: "Plantare Maps", binding: "PLANTARE", segredo: "PAINEL_SEGREDO_PLANTARE", origem: "https://plantare.example" };
const plantare = { pedidos: [], fetch: async (req) => { plantare.pedidos.push(req); return new Response(JSON.stringify({ ok: "plantare" }), { headers: { "content-type": "application/json" } }); } };
const envPl = { ...env, PAINEL_SEGREDO_PLANTARE: "outro-segredo" };
r = await pedir("GET", "/api/admin/eu", dono, { envUsado: envPl });
checar(r.d.produtos.map((x) => x.id).join() === "pavlvs,plantare" && r.d.areas.includes("plantare"), "o /eu já mostra o produto, e o dono já atua nele", r.d);
r = await pedir("GET", "/api/admin/github/entrar?volta=alteracoes", dono);
await pedir("GET", "/api/admin/github/retorno?code=bom&state=" + new URL(r.r.headers.get("location")).searchParams.get("state"), dono);
checar((await pedir("GET", "/api/admin/eu", dono)).d.github === "matheus", "(o GitHub ligado de novo nesta sessão)");
r = await pedir("GET", "/api/admin/plantare/mapas?x=1", dono, { envUsado: envPl, deps: { plantare } });
checar(r.status === 200 && r.d.ok === "plantare" && new URL(plantare.pedidos[0].url).href === "https://plantare.example/api/admin/plantare/mapas?x=1", "o encaminhamento é o mesmo, com o binding e o segredo dele", r.d);
const qPl = JSON.parse(Buffer.from(plantare.pedidos[0].headers.get("atos-painel-quem"), "base64url").toString("utf8"));
checar(qPl.github === null, "o token do GitHub (do repositório do PAVLVS) não vai a outro produto");
r = await pedir("GET", "/api/admin/plantare/mapas", duda, { envUsado: envPl, deps: { plantare } });
checar(r.status === 403 && plantare.pedidos.length === 1, "a Duda (só PAVLVS) não chega a ele");
r = await pedir("GET", "/api/admin/plantare/mapas", dono, { deps: { plantare } });
checar(r.status === 503 && r.d.erro === "o Plantare Maps não está ligado a este painel", "sem o segredo dele: 503", r.d);
delete PRODUTOS.plantare;
await pedir("POST", "/api/admin/github/sair", dono);

console.log("o Worker de teste");
const envTeste = { ...env, AMBIENTE: "teste", ATOS_EQUIPE: JSON.stringify([{ email: "teste@atos.dev.br", nome: "T", papel: "dono" }]) };
const t1 = await sessao("teste@atos.dev.br", 1);
checar((await pedir("GET", "/api/admin/eu", t1, { envUsado: envTeste })).status === 200 && (await pedir("GET", "/api/admin/eu", t1)).status === 403,
  "o teste usa a semente dele mesmo com a equipe da produção no mesmo KV, e a de teste não entra na produção");
checar((await pedir("GET", "/api/admin/pavlvs/visao", t1, { envUsado: envTeste, deps: { pavlvs: null } })).status === 503, "e lá o PAVLVS responde 503");

const chavesFora = [...guardados.keys()].filter((k) => !k.startsWith("atos:admin:") && !k.startsWith("atos-teste:admin:") && !k.startsWith("atos:sessao:") && !k.startsWith("id:conta:"));
checar(!chavesFora.length, "o painel só grava chaves atos:admin: (atos-teste:admin: no teste)", chavesFora);

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
