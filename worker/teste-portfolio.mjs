// Teste do Portfolio (worker/portfolio.js): o GitHub App (o JWT conferido com a chave publica, a instalacao, os
// repositorios publicos e privados), o projeto com o login social e a venda, o catalogo dinamico (os precos, a versao
// nova de um valor mudado, abrir e fechar), o checkout generico, os eventos assinados com o segredo gerado, a home
// montada pelo Worker e quem pode o que. Sem rede.
//   node worker/teste-portfolio.mjs
import { generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import worker from "./index.js";
import { comSeguranca, ligarSegundaEtapa } from "./apoio-teste-seguranca.mjs";
import { sha256 } from "./comum.js";
import { carregarCatalogo, resolveOffer } from "./cobranca/catalogo.js";
import { entregar, segredoDoProduto, verificarEvento } from "./cobranca/eventos.js";
import { esquecerGitHubApp, jwtDoApp } from "./github-app.js";
import { registroDoKV } from "./oidc.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 600)));
  if (!ok) falhas++;
};

const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
};

// O GitHub App: a chave que o GitHub entrega e PKCS#1; a publica confere cada JWT.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PKCS1 = privateKey.export({ type: "pkcs1", format: "pem" });
const PEM_PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" });
const publica = publicKey;
function jwtValido(cab) {
  const t = String(cab || "").replace(/^Bearer /, "").split(".");
  if (t.length !== 3) return false;
  const ok = verify("RSA-SHA256", Buffer.from(t[0] + "." + t[1]), publica, Buffer.from(t[2], "base64url"));
  const corpo = JSON.parse(Buffer.from(t[1], "base64url").toString());
  return ok && corpo.iss === "4242" && corpo.exp - corpo.iat <= 600;
}
let jwts = 0;
const REPOS = [
  { full_name: "matheusuener-atos/loja-de-mapas", name: "loja-de-mapas", description: "Mapas prontos para o campo", homepage: "https://mapas.example", private: true,
    html_url: "https://github.com/matheusuener-atos/loja-de-mapas", language: "TypeScript", topics: ["mapas"], pushed_at: "2026-10-10T10:00:00Z" },
  { full_name: "matheusuener-atos/coryphaeus", name: "coryphaeus", description: "Agent OS", homepage: "", private: false,
    html_url: "https://github.com/matheusuener-atos/coryphaeus", language: "Python", topics: [], pushed_at: "2026-10-11T10:00:00Z" },
];
globalThis.fetch = async (u, op = {}) => {
  u = String(u);
  const auth = (op.headers || {}).Authorization;
  if (u === "https://api.github.com/app/installations/123") {
    if (!jwtValido(auth)) return new Response("{}", { status: 401 });
    jwts++;
    return Response.json({ id: 123, account: { login: "matheusuener-atos", type: "User" }, repository_selection: "selected" });
  }
  if (u === "https://api.github.com/app/installations/999") return new Response("{}", { status: 404 });
  if (u === "https://api.github.com/app/installations/123/access_tokens" && op.method === "POST") {
    if (!jwtValido(auth)) return new Response("{}", { status: 401 });
    jwts++;
    return Response.json({ token: "ghs_inst", expires_at: new Date(Date.now() + 3600000).toISOString() });
  }
  if (u.startsWith("https://api.github.com/installation/repositories")) {
    if (auth !== "Bearer ghs_inst") return new Response("{}", { status: 401 });
    return Response.json({ total_count: REPOS.length, repositories: REPOS });
  }
  throw new Error("fetch inesperado: " + u);
};

// Os arquivos de public/ de verdade (a home e o checkout generico).
const ASSETS = {
  fetch: async (req) => {
    const p = new URL(req.url || req).pathname;
    const arquivo = p.endsWith("/") ? p + "index.html" : p;
    try {
      const corpo = await readFile(new URL("../public" + arquivo, import.meta.url));
      return new Response(corpo, { headers: { "content-type": arquivo.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain", etag: '"x"' } });
    } catch {
      return new Response("não encontrado", { status: 404, headers: { "content-type": "text/plain" } });
    }
  },
};
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };
const env = {
  CONTAS, ASSETS, ATOS_CHAVE: JSON.stringify(jwk), PORTFOLIO_CHAVE: "p".repeat(40),
  GITHUB_APP_ID: "4242", GITHUB_APP_SLUG: "atos-portfolio", GITHUB_APP_CHAVE: PEM_PKCS1,
  ATOS_EQUIPE: JSON.stringify([{ email: "dono@atos.dev.br", nome: "Dono", papel: "dono" }, { email: "fin@atos.dev.br", nome: "Fin", papel: "financeiro" }]),
};
comSeguranca(env);
const A = "https://atos.dev.br";

async function sessao(email) {
  const segredo = "s-" + email;
  const sub = "sub-" + email.split("@")[0];
  guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: "Nome" }));
  await ligarSegundaEtapa(env, sub);
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000), mfa: true }));
  return "__Host-atos=" + segredo;
}
async function chamar(caminho, { metodo = "POST", corpo, cookie, e = env } = {}) {
  const h = { origin: A };
  if (cookie) h.cookie = cookie;
  if (corpo !== undefined) h["content-type"] = "application/json";
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) }), e, { waitUntil() {} });
  const texto = await r.clone().text();
  let d = null;
  try { d = JSON.parse(texto); } catch { d = null; }
  return { status: r.status, d, texto, r };
}
const dono = await sessao("dono@atos.dev.br");
const fin = await sessao("fin@atos.dev.br");
const home = async () => (await chamar("/", { metodo: "GET" })).texto;

console.log("quem pode e a semente");
let r = await chamar("/api/admin/portfolio", { metodo: "GET", cookie: fin });
checar(r.status === 403, "o financeiro não abre o Portfólio", r.d);
r = await chamar("/api/admin/portfolio", { metodo: "GET" });
checar(r.status === 401, "sem sessão: 401", r.status);
r = await chamar("/api/admin/portfolio", { metodo: "GET", cookie: dono });
checar(r.status === 200 && r.d.semente === true && r.d.projetos.map((p) => p.id).join() === "coryphaeus,plantare-maps" && r.d.github.configurado && !r.d.github.conectado,
  "o dono vê a semente (os dois que estavam na home) e o GitHub configurado, sem conexão", r.d);
let h = await home();
checar(h.includes("<strong>Coryphaeus</strong>") && h.includes("<strong>Plantare Maps</strong>") && h.includes("<strong>PAVLVS</strong>") && />III<\/span>[\s\S]*Coryphaeus|Coryphaeus[\s\S]*>III</.test(h),
  "a home: os fixos e os da semente, numerados depois dos fixos");

console.log("o GitHub App");
r = await chamar("/api/admin/portfolio/github/conectar", { metodo: "GET", cookie: dono });
const ir = r.r.headers.get("location") || "";
const state = new URL(ir).searchParams.get("state");
checar(r.status === 302 && ir.startsWith("https://github.com/apps/atos-portfolio/installations/new?state=") && state, "conectar leva a instalar o app, com o state", ir);
r = await chamar("/api/admin/portfolio/github/instalado?installation_id=123&setup_action=install&state=outro", { metodo: "GET", cookie: dono });
checar(r.status === 302 && (r.r.headers.get("location") || "").includes("erro="), "um state que não começou aqui volta com erro", r.r.headers.get("location"));
r = await chamar("/api/admin/portfolio/github/instalado?installation_id=999&setup_action=install&state=" + state, { metodo: "GET", cookie: fin });
checar(r.status === 302 && (r.r.headers.get("location") || "").includes("erro="), "o financeiro não completa a instalação (volta ao painel com o motivo)", r.r.headers.get("location"));
r = await chamar("/api/admin/portfolio/github/instalado?installation_id=123&setup_action=install&state=" + state, { metodo: "GET", cookie: dono });
checar(r.status === 302 && r.r.headers.get("location") === "/admin/#portfolio", "a instalação conferida como o app (JWT RS256 da chave PKCS#1) volta ao painel", r.r.headers.get("location"));
r = await chamar("/api/admin/portfolio/github/instalado?installation_id=123&setup_action=install&state=" + state, { metodo: "GET", cookie: dono });
checar((r.r.headers.get("location") || "").includes("erro="), "o mesmo state não vale duas vezes");
r = await chamar("/api/admin/portfolio", { metodo: "GET", cookie: dono });
checar(r.d.github.conectado && r.d.github.conectado.conta === "matheusuener-atos" && r.d.github.conectado.instalacao === "123", "a conexão fica guardada com a conta", r.d.github);
r = await chamar("/api/admin/portfolio/github/repos", { metodo: "GET", cookie: dono });
checar(r.status === 200 && r.d.repos.length === 2 && r.d.repos[0].nome === "matheusuener-atos/coryphaeus" && r.d.repos[1].privado === true && r.d.repos[1].site === "https://mapas.example",
  "os repositórios, públicos e privados, do mais mexido para o menos", r.d);
checar(jwts === 2, "o token da instalação vem de um JWT conferido (um para a instalação, um para o token)", jwts);
r = await chamar("/api/admin/portfolio/github/instalado?installation_id=123&setup_action=update", { metodo: "GET", cookie: dono });
checar(r.r.headers.get("location") === "/admin/#portfolio", "a volta de uma mudança no GitHub (sem o state) atualiza a instalação já conectada", r.r.headers.get("location"));
r = await chamar("/api/admin/portfolio/github/instalado?installation_id=999&setup_action=update", { metodo: "GET", cookie: dono });
checar((r.r.headers.get("location") || "").includes("erro="), "outra instalação sem o state: recusa", r.r.headers.get("location"));
r = await chamar("/api/admin/portfolio/github/instalado?installation_id=123&setup_action=update", { metodo: "GET", cookie: fin });
checar((r.r.headers.get("location") || "").includes("erro="), "o financeiro também não atualiza", r.r.headers.get("location"));
esquecerGitHubApp();
const jwt8 = await jwtDoApp({ ...env, GITHUB_APP_CHAVE: PEM_PKCS8 });
checar(jwtValido("Bearer " + jwt8), "a chave PKCS#8 também assina");

console.log("criar com login e venda");
const PLANOS = [{ plano: "basico", nome: "Básico", descricao: "1 talhão", mes: 2990, ano: 29900 }, { plano: "pro", nome: "Pro", descricao: "talhões sem fim", mes: 9900, ano: null }];
const LOJA = {
  id: "loja", nome: "Loja de Mapas", descricao: "Mapas prontos <b>para</b> o campo", plataforma: "Web", site: "https://mapas.example",
  repo: { nome: "matheusuener-atos/loja-de-mapas", privado: true }, mostrar_repo: true, publicado: true,
  login: { criar: true, voltas: "https://mapas.example/entrar/volta", origens: "", privacidade: "https://atos.dev.br/privacidade/", termos: "https://atos.dev.br/termos/", acesso: "todos" },
  produto: { eventos: "https://mapas.example/api/atos/eventos", voltas: "https://mapas.example/conta", aberto: false, planos: PLANOS },
};
r = await chamar("/api/admin/portfolio/projetos", { cookie: dono, corpo: { ...LOJA, id: "admin" } });
checar(r.status === 400 && /reservado/.test(r.d.erro), "um id de caminho do site é reservado", r.d);
r = await chamar("/api/admin/portfolio/projetos", { cookie: dono, corpo: { ...LOJA, id: "coryphaeus" } });
checar(r.status === 400 && /já existe/.test(r.d.erro), "o id repetido é recusado", r.d);
r = await chamar("/api/admin/portfolio/projetos", { cookie: dono, corpo: LOJA });
checar(r.status === 200 && r.d.salvo === "loja" && /^atos_ev_/.test(r.d.segredo || ""), "criar: o segredo dos eventos aparece uma vez, na resposta", r.d && { erro: r.d.erro, salvo: r.d.salvo });
const segredoDaCriacao = r.d && r.d.segredo;
r = await chamar("/api/admin/portfolio/projetos", { cookie: dono, corpo: { ...LOJA, id: "loja2", login: { ...LOJA.login, voltas: "http://mapas.example/x" } }, e: env });
checar(r.status === 400 && /login/.test(r.d.erro), "um login com volta inválida não cria nada", r.d);
const doKV = await registroDoKV(env);
checar(doKV.apps.loja && doKV.apps.loja.acesso === "todos" && doKV.clientes["loja-web"] && doKV.clientes["loja-web"].voltas[0] === "https://mapas.example/entrar/volta" && !doKV.apps.loja2,
  "o login: o aplicativo loja (qualquer Conta Atos) e o acesso público loja-web, sem a fila; o pedido inválido não deixou nada", doKV);
r = await chamar("/api/admin/portfolio", { metodo: "GET", cookie: dono });
const loja = r.d.projetos.find((p) => p.id === "loja");
checar(loja && loja.login.app === "loja" && loja.login.cliente === "loja-web" && loja.produto.segredo && loja.produto.precos.length === 3 && !/[<>]/.test(loja.descricao),
  "o projeto guardado: login, venda com 3 preços e a descrição sem < >", loja);
checar(r.d.semente === false, "depois da primeira mudança, a semente não vale mais");
// o segredo apareceu uma vez, na resposta da criacao: aqui so o quando
checar(!JSON.stringify(r.d).includes("atos_ev_"), "a tela nunca devolve o segredo");
const segredo1 = await segredoDoProduto(env, "loja");
checar(segredo1 === segredoDaCriacao, "o segredo dos eventos fica cifrado e o Worker o lê");
checar(!String(guardados.get("atos:portfolio:segredo:loja")).includes(segredo1), "no KV, só o segredo cifrado");

console.log("o catálogo e o checkout");
r = await chamar("/api/cobranca/v1/catalogo/loja", { metodo: "GET" });
checar(r.status === 200 && r.d.nome === "Loja de Mapas" && r.d.aberto === false && r.d.precos.map((x) => x.id).join() === "loja.basico.mes,loja.basico.ano,loja.pro.mes" &&
  r.d.planos.length === 2 && r.d.precos[0].formas.join() === "cartao,pix", "o catálogo público do produto (fechado)", r.d);
r = await chamar("/api/cobranca/v1/catalogo/loja?volta=" + encodeURIComponent("https://mapas.example/conta"), { metodo: "GET" });
checar(r.d.volta === "https://mapas.example/conta", "a volta pedida, se é do produto", r.d.volta);
r = await chamar("/api/cobranca/v1/catalogo/loja?volta=" + encodeURIComponent("https://outro.example/"), { metodo: "GET" });
checar(r.d.volta === "https://mapas.example/", "outra volta vira o site do produto", r.d.volta);
r = await chamar("/loja/assinar/", { metodo: "GET" });
checar(r.status === 200 && r.texto.includes('id="ck-titulo"') && /script-src[^;]*'sha256-/.test(r.r.headers.get("content-security-policy") || ""), "atos.dev.br/loja/assinar: a página genérica, com o hash do script na CSP",
  r.r.headers.get("content-security-policy"));
r = await chamar("/pavlvs/assinar/", { metodo: "GET" });
checar(r.status === 200 && r.texto.includes("Assinar o PAVLVS"), "o checkout do PAVLVS continua o dele");
r = await chamar("/nenhum/assinar/", { metodo: "GET" });
checar(r.status === 404, "um produto que não existe: 404", r.status);
r = await chamar("/assinar/", { metodo: "GET" });
checar(r.status === 404, "a página genérica sozinha não abre", r.status);
r = await chamar("/api/cobranca/v1/pagar", { metodo: "POST", corpo: { preco: "loja.basico.ano", forma: "pix" } });
checar(r.status === 401, "pagar continua pedindo a sessão", r.status);

console.log("a home");
h = await home();
checar(h.includes("<strong>Loja de Mapas</strong>") && !h.includes("loja-de-mapas") && !h.includes("/loja/assinar/") && h.includes("https://mapas.example"),
  "o cartão do projeto: sem o link do repositório privado e sem Assinar (a venda fechada)");
checar(!h.includes("<b>para</b>"), "nada de HTML vindo do cadastro");

console.log("mudar a venda");
const novos = [{ ...PLANOS[0], mes: 3490 }, PLANOS[1]];
r = await chamar("/api/admin/portfolio/projetos/loja", { cookie: dono, corpo: { ...LOJA, login: undefined, produto: { ...LOJA.produto, planos: novos } } });
checar(r.status === 200, "mudar o valor do Básico", r.d);
await carregarCatalogo(env, { forcar: true });
r = await chamar("/api/cobranca/v1/catalogo/loja", { metodo: "GET" });
checar(r.d.precos.map((x) => x.id + "=" + x.centavos).join() === "loja.basico.ano=29900,loja.pro.mes=9900,loja.basico.mes@2=3490", "o valor novo é outra versão do preço; a antiga sai da vitrine", r.d.precos);
checar(resolveOffer("loja.basico.mes") && resolveOffer("loja.basico.mes").centavos === 2990 && resolveOffer("loja.basico.mes", { paraCobrar: true }) === null,
  "a versão antiga ainda resolve o nome (quem assinou), mas não cobra de novo");
r = await chamar("/api/admin/portfolio/projetos/loja", { cookie: dono, corpo: { ...LOJA, login: undefined, produto: null } });
checar(r.status === 400 && /não deixa de vender/.test(r.d.erro), "um projeto que vende não deixa de vender", r.d);
r = await chamar("/api/admin/portfolio/projetos/loja", { cookie: dono, corpo: { ...LOJA, login: undefined, repo: { nome: "matheusuener-atos/coryphaeus", privado: false }, produto: { ...LOJA.produto, planos: novos, aberto: true } } });
checar(r.status === 200 && r.d.projetos.find((p) => p.id === "loja").produto.aberto === true, "abrir a venda", r.d);
r = await chamar("/api/cobranca/v1/catalogo/loja", { metodo: "GET" });
checar(r.d.aberto === true, "o catálogo diz aberto", r.d.aberto);
h = await home();
checar(h.includes('href="/loja/assinar/"') && h.includes('href="https://github.com/matheusuener-atos/coryphaeus"'), "a home mostra Assinar e o GitHub público");
r = await chamar("/api/admin/portfolio/projetos/loja/apagar", { cookie: dono, corpo: { confirmar: true } });
checar(r.status === 409, "um projeto que vende não se apaga", r.d);

console.log("os eventos");
let saiu = null;
const ev = { id: "ev1", tipo: "direito.atualizado", produto: "loja", sub: "sub-x", versao: 1 };
const rt = await entregar(env, ev, { buscar: async (url, init) => { saiu = { url, init }; return new Response("{}"); } });
checar(rt.ok && saiu.url === "https://mapas.example/api/atos/eventos" && (await verificarEvento(segredo1, saiu.init.body, saiu.init.headers["Atos-Assinatura"])),
  "o evento vai ao endereço do projeto, assinado com o segredo gerado", rt);
r = await chamar("/api/admin/portfolio/projetos/loja/segredo", { cookie: dono, corpo: {} });
checar(r.status === 400, "outro segredo pede confirmação", r.d);
r = await chamar("/api/admin/portfolio/projetos/loja/segredo", { cookie: dono, corpo: { confirmar: true } });
const segredo2 = r.d && r.d.segredo;
checar(/^atos_ev_/.test(segredo2) && segredo2 !== segredo1 && (await segredoDoProduto(env, "loja")) === segredo2, "outro segredo: o anterior para na hora");
r = await chamar("/api/cobranca/v1/direitos?produto=loja&sub=sub-x", { metodo: "GET" });
checar(r.status === 401, "os direitos sem o segredo: 401", r.status);

console.log("ordem, apagar e o resto");
r = await chamar("/api/admin/portfolio/projetos/loja/mover", { cookie: dono, corpo: { para: "cima" } });
checar(r.status === 200 && r.d.projetos.map((p) => p.id).join() === "coryphaeus,loja,plantare-maps", "subir um projeto", r.d.projetos.map((p) => p.id));
r = await chamar("/api/admin/portfolio/projetos/coryphaeus/mover", { cookie: dono, corpo: { para: "cima" } });
checar(r.status === 400, "o primeiro não sobe mais", r.d);
r = await chamar("/api/admin/portfolio/projetos/plantare-maps/apagar", { cookie: dono, corpo: { confirmar: true } });
checar(r.status === 200 && !r.d.projetos.some((p) => p.id === "plantare-maps"), "apagar um projeto sem venda", r.d);
h = await home();
checar(!h.includes("Plantare Maps") && h.indexOf("Coryphaeus") < h.indexOf("Loja de Mapas"), "a home segue a ordem do painel e não mostra o apagado");
r = await chamar("/api/admin/portfolio/projetos", { cookie: dono, corpo: { id: "rascunho", nome: "Rascunho", descricao: "ainda não", publicado: false } });
checar(r.status === 200 && !(await home()).includes("Rascunho"), "fora da home: não aparece", r.d);
r = await chamar("/api/admin/portfolio/projetos/rascunho", { cookie: dono, corpo: { nome: "Rascunho", descricao: "ainda não", produto: { eventos: "https://x.example/e", planos: PLANOS } }, e: { ...env, PORTFOLIO_CHAVE: "" } });
checar(r.status === 400 && /PORTFOLIO_CHAVE/.test(r.d.erro), "vender sem PORTFOLIO_CHAVE: recusa, dizendo o que falta", r.d);
r = await chamar("/api/admin/portfolio/github/desconectar", { cookie: dono, corpo: {} });
checar(r.status === 200 && !r.d.github.conectado, "desconectar esquece a instalação");
r = await chamar("/api/admin/portfolio/github/repos", { metodo: "GET", cookie: dono });
checar(r.status === 409, "sem conexão, sem repositórios", r.d);

console.log("o Worker de teste");
const envT = { ...env, AMBIENTE: "teste", ATOS_EQUIPE: env.ATOS_EQUIPE };
r = await chamar("/api/admin/portfolio", { metodo: "GET", cookie: dono, e: envT });
checar(r.status === 200 && r.d.semente === true && !r.d.projetos.some((p) => p.id === "loja"), "o Worker de teste tem o próprio Portfólio", r.d && r.d.projetos);

console.log(falhas ? `\n${falhas} FALHA(S)` : "\ntudo certo");
process.exit(falhas ? 1 : 0);
