// O Portfolio da Atos (atos.dev.br/admin, secao Portfolio; a tela e public/assets/admin-portfolio.js): os projetos que
// aparecem na home (atos.dev.br/#projetos), cadastrados pelo dono a partir de um repositorio do GitHub. Cada projeto
// pode ligar, na mesma tela e na hora (sem a fila):
//   - o login social: um aplicativo da Atos no "Entrar com Atos" (o registro de worker/oidc-painel.js, como os do Login
//     Atos; id = o do projeto, e um acesso publico "<id>-web" com PKCE). Mudar ou apagar depois e no Login Atos, pela
//     fila. Nao passa pelas regras do Atos Workspace (alias, limite do plano, nomes reservados): e da propria Atos.
//   - a venda: um produto no catalogo da Atos Cobranca (worker/cobranca/catalogo.js, carregarCatalogo), com o checkout
//     em atos.dev.br/<id>/assinar (a pagina generica, public/assinar/), os eventos assinados para o sistema do projeto
//     com um segredo gerado aqui (aparece uma vez; fica cifrado no KV com PORTFOLIO_CHAVE) e o "vendendo" que abre e
//     fecha a venda. Mudar o valor de um plano cria uma versao nova do preco ("...@2"): quem ja assinou continua no dele.
//     Um projeto que vende nao se apaga (quem pagou depende dele): fecha-se a venda e tira-se da home.
// Os aplicativos de terceiros (Atos Workspace > Integracoes) nao mudam em nada.
//
// Os repositorios vem do GitHub App do Portfolio (worker/github-app.js): publicos e privados, so os metadados. Um
// repositorio privado nunca vira link na home.
//
// O PAVLVS e o Atos Workspace continuam no codigo (public/index.html, os dois primeiros cartoes; o catalogo e o login
// deles tambem): o painel os mostra so para leitura. Os do Portfolio vem depois deles, na ordem do painel. Enquanto a
// chave do KV nao existe, vale a SEMENTE (os que estavam escritos na home), e e dela que a primeira mudanca parte.
//
// O KV CONTAS ("atos:portfolio:*"; "atos-teste:portfolio:*" no Worker de teste):
//   projetos        [{id, nome, descricao, plataforma, site, icone, repo: {nome, privado, url} | null, mostrar_repo,
//                     publicado, login: {app, cliente} | null, produto: {eventos, voltas, aberto, planos, precos} | null,
//                     criado, por, mudado?}]
//   github          {instalacao, conta, tipo, selecao, quando, por}
//   gh:<state>      o pedido de instalacao (10 minutos)
//   segredo:<id>    o segredo dos eventos do produto, cifrado: {iv, cifrado, quando, por}
//   registro        as ultimas 100 mudancas: [{quando, por, projeto, oque}]
//
// Rotas (atras de /api/admin; so o papel dono, area "atos"; worker/admin.js confere):
//   GET  /api/admin/portfolio                          a tela
//   GET  /api/admin/portfolio/github/repos             os repositorios liberados ao app
//   GET  /api/admin/portfolio/github/conectar          302 para instalar o app no GitHub
//   GET  /api/admin/portfolio/github/instalado         o Setup URL do app: confere e guarda a instalacao
//   POST /api/admin/portfolio/github/desconectar       esquece a instalacao (desinstalar e no GitHub)
//   POST /api/admin/portfolio/projetos                 cria {id, ...campos, login?, produto?} -> {segredo?}
//   POST /api/admin/portfolio/projetos/:id             muda os campos (login e produto podem ser ligados depois)
//   POST /api/admin/portfolio/projetos/:id/mover       {para: "cima" | "baixo"}
//   POST /api/admin/portfolio/projetos/:id/segredo     {confirmar: true} -> {segredo} (o anterior para na hora)
//   POST /api/admin/portfolio/projetos/:id/apagar      {confirmar: true}

import { aleatorio, b64url, deB64url, json, kv, lerJson, limparNome } from "./comum.js";
import { enderecoDeInstalar, githubAppConfigurado, lerInstalacao, reposDaInstalacao } from "./github-app.js";
import { listaDe, urlHttps } from "./oidc-campos.js";

const te = new TextEncoder();
const iso = (ms) => new Date(ms).toISOString();
const temChave = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

export const ID_PROJETO = /^[a-z0-9][a-z0-9-]{1,30}$/;
// Os ids que nao podem ser de projeto: os produtos do codigo e os caminhos do site (atos.dev.br/<id>/assinar).
const RESERVADOS = ["pavlvs", "paulus", "workspace", "atos", "admin", "api", "assets", "assinar", "conta", "entrar", "integracao", "marca", "pacotes",
  "privacidade", "termos", "oauth", "status", "fedcm", "f", "dev", "www"];
// Os cartoes que continuam escritos na home (public/index.html): so para leitura no painel.
export const FIXOS = [
  { id: "pavlvs", nome: "PAVLVS", onde: "o código: catálogo (worker/cobranca/catalogo.js), login (worker/oidc.js) e o cartão em public/index.html" },
  { id: "workspace", nome: "Atos Workspace", onde: "o código: worker/workspace.js e o cartão em public/index.html" },
];
// Os que estavam escritos na home antes do Portfolio: valem enquanto a chave do KV nao existe.
export const SEMENTE = [
  { id: "coryphaeus", nome: "Coryphaeus", descricao: "Agent OS for orchestrating local AI agents and tools", plataforma: "Python", site: "", icone: "",
    repo: { nome: "matheusuener-atos/coryphaeus", privado: false, url: "https://github.com/matheusuener-atos/coryphaeus" }, mostrar_repo: true, publicado: true,
    login: null, produto: null, criado: "2026-10-12T00:00:00.000Z", por: "semente" },
  { id: "plantare-maps", nome: "Plantare Maps",
    descricao: "Gerador de mapas agrícola para planio/pulverização: do KMZ do talhão ao plano com bordadura, linhas, manobras e exportação em KMZ/Shapefile.",
    plataforma: "HTML", site: "", icone: "", repo: { nome: "matheusuener-atos/plantare-maps", privado: false, url: "https://github.com/matheusuener-atos/plantare-maps" },
    mostrar_repo: true, publicado: true, login: null, produto: null, criado: "2026-10-12T00:00:00.000Z", por: "semente" },
];

const ICONE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const ICONE_MAX = 40000;
const PLANOS_MAX = 6;
const CENTAVOS_MIN = 100;
const CENTAVOS_MAX = 10000000;

export function KP(env) {
  const p = env && env.AMBIENTE === "teste" ? "atos-teste:portfolio:" : "atos:portfolio:";
  return { projetos: p + "projetos", github: p + "github", estado: (s) => p + "gh:" + s, segredo: (id) => p + "segredo:" + id, registro: p + "registro" };
}
export const chaveDosProjetos = (env) => KP(env).projetos;

// ------------------------------------------------------------ ler e guardar

/* Os projetos de agora: os do KV ou, sem a chave, a semente. O KV fora: lanca (quem chama decide; a home fica com o
   HTML escrito, o catalogo com a ultima leitura boa). */
export async function lerProjetos(env) {
  const bruto = await env.CONTAS.get(KP(env).projetos);
  if (bruto === null || bruto === undefined) return SEMENTE.map((x) => ({ ...x }));
  const l = JSON.parse(bruto);
  return Array.isArray(l) ? l.filter((x) => x && typeof x === "object" && ID_PROJETO.test(String(x.id || ""))) : [];
}
async function semSemente(env) {
  return (await env.CONTAS.get(KP(env).projetos)) === null;
}
async function guardarProjetos(env, lista) {
  await env.CONTAS.put(KP(env).projetos, JSON.stringify(lista));
}
async function anotar(env, por, projeto, oque, agora) {
  try {
    const l = (await kv(env, KP(env).registro)) || [];
    l.unshift({ quando: iso(agora), por, projeto, oque });
    await env.CONTAS.put(KP(env).registro, JSON.stringify(l.slice(0, 100)));
  } catch {
    // o registro e o segundo lugar: a mudanca ja valeu
  }
}

/* Os produtos do Portfolio, no formato do catalogo (worker/cobranca/catalogo.js): {<id>: {...}}. */
export async function produtosDoPortfolio(env) {
  const r = {};
  for (const p of await lerProjetos(env)) {
    const d = p.produto;
    if (!d || !Array.isArray(d.precos)) continue;
    const site = p.site || "https://atos.dev.br/";
    r[p.id] = {
      nome: p.nome, site, voltas: [site, ...(Array.isArray(d.voltas) ? d.voltas : [])], eventos: d.eventos || "", aberto: d.aberto === true,
      precos: d.precos, planos: Array.isArray(d.planos) ? d.planos : [], icone: p.icone || "", dinamico: true,
    };
  }
  return r;
}

// ------------------------------------------------------------ o segredo dos eventos

async function chaveDaCifra(env) {
  const base = String(env.PORTFOLIO_CHAVE || "");
  if (base.length < 32) return null;
  const bruta = await crypto.subtle.digest("SHA-256", te.encode("atos-portfolio-segredo:" + base));
  return crypto.subtle.importKey("raw", bruta, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/* O segredo dos eventos de um produto do Portfolio (para assinar e para o produto se autenticar), ou "". */
export async function segredoDosEventos(env, produto) {
  if (!ID_PROJETO.test(String(produto || ""))) return "";
  const g = await kv(env, KP(env).segredo(produto));
  const chave = g && g.iv && g.cifrado ? await chaveDaCifra(env) : null;
  if (!chave) return "";
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64url(g.iv) }, chave, deB64url(g.cifrado)));
  } catch {
    return "";
  }
}

async function gerarSegredo(env, produto, por, agora) {
  const chave = await chaveDaCifra(env);
  if (!chave) throw new Error("falta o segredo PORTFOLIO_CHAVE no Worker (32 caracteres ou mais)");
  const segredo = "atos_ev_" + aleatorio(32);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chave, te.encode(segredo));
  await env.CONTAS.put(KP(env).segredo(produto), JSON.stringify({ iv: b64url(iv), cifrado: b64url(cifrado), quando: iso(agora), por }));
  return segredo;
}

// ------------------------------------------------------------ os campos

function erro(frase) {
  const e = new Error(frase);
  e.status = 400;
  return e;
}

/* O repositorio escolhido: so o formato (o painel o tirou da lista do app). */
function repoDado(x) {
  if (!x) return null;
  const nome = String(x.nome || "");
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(nome)) throw erro("repositório inválido");
  return { nome, privado: x.privado === true, url: "https://github.com/" + nome };
}

/* Os campos de um projeto, limpos (sem o login e o produto). */
function camposDoProjeto(d) {
  const nome = limparNome(d.nome).slice(0, 60);
  if (nome.length < 2) throw erro("diga o nome do projeto");
  const descricao = String(d.descricao || "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  if (descricao.length < 3) throw erro("diga em uma frase o que o projeto faz (aparece na home)");
  const plataforma = limparNome(d.plataforma).slice(0, 40);
  const site = d.site ? urlHttps(d.site) : "";
  if (d.site && !site) throw erro("o site precisa ser um endereço https");
  const icone = String(d.icone || "");
  if (icone && (icone.length > ICONE_MAX || !ICONE.test(icone))) throw erro("o ícone precisa ser uma imagem PNG, JPEG ou WebP de até 30 KB (ou nenhum)");
  const repo = repoDado(d.repo);
  return { nome, descricao, plataforma, site, icone, repo, mostrar_repo: Boolean(repo && !repo.privado && d.mostrar_repo !== false), publicado: d.publicado === true };
}

const centavos = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

/* Os planos pedidos: [{plano, nome, descricao, mes, ano}] (centavos; mes ou ano pode faltar). */
function planosDados(l) {
  if (!Array.isArray(l) || !l.length) throw erro("diga pelo menos um plano, com o valor por mês ou por ano");
  if (l.length > PLANOS_MAX) throw erro("no máximo " + PLANOS_MAX + " planos");
  const vistos = new Set();
  return l.map((x) => {
    const plano = String((x && x.plano) || "");
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(plano)) throw erro("o código do plano: letras minúsculas, números e hífen (ex.: basico)");
    if (vistos.has(plano)) throw erro("dois planos com o código " + plano);
    vistos.add(plano);
    const nome = limparNome(x.nome).slice(0, 40);
    if (nome.length < 2) throw erro("diga o nome do plano " + plano);
    const descricao = limparNome(x.descricao).slice(0, 120);
    const mes = centavos(x.mes), ano = centavos(x.ano);
    for (const v of [mes, ano]) {
      if (v !== null && !(Number.isInteger(v) && v >= CENTAVOS_MIN && v <= CENTAVOS_MAX)) throw erro("o valor do plano " + nome + ": de R$ 1,00 a R$ 100.000,00");
    }
    if (mes === null && ano === null) throw erro("o plano " + nome + " precisa do valor por mês, por ano ou dos dois");
    return { plano, nome, descricao, mes, ano };
  });
}

/* Os precos do catalogo a partir dos planos: o preco igual fica; o valor mudado vira uma versao nova ("...@2") e a
   antiga sai da venda (ativo: false), mas continua resolvendo o nome para quem ja assinou. */
export function precosDosPlanos(produto, produtoNome, planos, antigos = []) {
  const precos = antigos.map((x) => ({ ...x }));
  for (const x of precos) {
    const pl = planos.find((y) => y.plano === (x.metadados || {}).plano);
    if (!pl || pl[x.periodo] === null) x.ativo = false;
  }
  for (const pl of planos) {
    for (const periodo of ["mes", "ano"]) {
      const valor = pl[periodo];
      if (valor === null) continue;
      const nome = produtoNome + " " + pl.nome + (periodo === "ano" ? " · anual" : "");
      const mesmos = precos.filter((x) => (x.metadados || {}).plano === pl.plano && x.periodo === periodo);
      const atual = mesmos.find((x) => x.ativo !== false && x.centavos === valor);
      if (atual) {
        atual.nome = nome;
        continue;
      }
      for (const x of mesmos) x.ativo = false;
      const base = produto + "." + pl.plano + "." + periodo;
      const id = mesmos.length ? base + "@" + (mesmos.length + 1) : base;
      precos.push({ id, nome, periodo, centavos: valor, formas: ["cartao", "pix"], metadados: { plano: pl.plano }, ativo: true });
    }
  }
  return precos;
}

/* O produto pedido (a venda), limpo. `antes`: o produto que ja existia (os precos e o "vendendo" partem dele). */
function produtoDado(id, nome, d, antes) {
  const eventos = urlHttps(d.eventos);
  if (!eventos) throw erro("o endereço que recebe os eventos da Atos Cobrança precisa ser https (é por ele que o sistema sabe quem pagou)");
  const voltas = [];
  for (const v of listaDe(d.voltas)) {
    const ok = urlHttps(v);
    if (!ok) throw erro("endereço de volta inválido: " + String(v).slice(0, 80));
    if (!voltas.includes(ok)) voltas.push(ok);
  }
  if (voltas.length > 10) throw erro("no máximo 10 endereços de volta");
  const planos = planosDados(d.planos);
  return {
    eventos, voltas, aberto: d.aberto === true, planos: planos.map((x) => ({ plano: x.plano, nome: x.nome, descricao: x.descricao })),
    precos: precosDosPlanos(id, nome, planos, antes ? antes.precos : []),
  };
}

// ------------------------------------------------------------ o login social

/* Confere e cria o aplicativo e o acesso no registro do "Entrar com Atos" (sem a fila: o dono pediu aqui). Primeiro
   confere tudo, depois grava: nada fica pela metade. */
async function criarLogin(env, projeto, d, por, agora) {
  const { conferirOAuth, aplicarOAuth } = await import("./oidc-painel.js");
  const { camposDoCliente } = await import("./oidc-campos.js");
  if (!projeto.site) throw erro("o login precisa do site do projeto (https): é o que aparece para quem entra");
  const app = {
    acao: "criar", id: projeto.id, nome: projeto.nome, descricao: projeto.descricao.slice(0, 140), site: projeto.site,
    privacidade: d.privacidade, termos: d.termos, icone: projeto.icone, acesso: d.acesso === "liberados" ? "liberados" : "todos", liberados: [],
  };
  const e1 = await conferirOAuth(env, "oauth.app", app);
  if (e1) throw erro("login: " + e1);
  const cliente = { acao: "criar", id: projeto.id + "-web", app: projeto.id, tipo: "publico", voltas: d.voltas, origens: d.origens };
  const f = camposDoCliente(cliente);
  if (f.erro) throw erro("login: " + f.erro);
  return async () => {
    await aplicarOAuth(env, "oauth.app", app, por, agora);
    await aplicarOAuth(env, "oauth.cliente", cliente, por, agora);
    return { app: projeto.id, cliente: cliente.id };
  };
}

// ------------------------------------------------------------ as mudancas

/* Cria ou muda um projeto. {projeto, segredo?} */
async function salvar(env, c, id, d, criar) {
  const lista = await lerProjetos(env);
  const i = lista.findIndex((x) => x.id === id);
  if (criar) {
    if (!ID_PROJETO.test(id)) throw erro("o id do projeto: 2 a 31 letras minúsculas, números e hífen (vira o endereço atos.dev.br/<id>/assinar)");
    if (RESERVADOS.includes(id)) throw erro("o id " + id + " é reservado: escolha outro");
    if (i >= 0) throw erro("já existe um projeto " + id);
  } else if (i < 0) {
    const e = erro("o projeto " + id + " não existe");
    e.status = 404;
    throw e;
  }
  const antes = criar ? null : lista[i];
  const campos = camposDoProjeto(d);
  const projeto = criar
    ? { id, ...campos, login: null, produto: null, criado: iso(c.agora), por: c.quem.email }
    : { ...antes, ...campos, mudado: iso(c.agora) };

  // O login: so liga (uma vez); o resto e no Login Atos.
  let ligarLogin = null;
  if (d.login && d.login.criar === true && !projeto.login) ligarLogin = await criarLogin(env, projeto, d.login, c.quem.email, c.agora);

  // A venda: liga, muda os planos, abre e fecha. Desligar de vez, nao (quem pagou depende do produto).
  let novoProduto = false;
  if (d.produto === null && antes && antes.produto) throw erro("um projeto que vende pela Atos não deixa de vender: feche a venda (desmarque “vendendo”)");
  if (d.produto) {
    projeto.produto = produtoDado(id, projeto.nome, d.produto, antes && antes.produto);
    novoProduto = !(antes && antes.produto);
    if (novoProduto && !(await chaveDaCifra(env))) throw erro("para vender, falta o segredo PORTFOLIO_CHAVE no Worker (32 caracteres ou mais)");
    if (projeto.produto.aberto && !novoProduto && !(await segredoDosEventos(env, id))) throw erro("gere o segredo dos eventos antes de abrir a venda");
  }

  if (ligarLogin) projeto.login = await ligarLogin();
  let segredo = "";
  if (novoProduto) segredo = await gerarSegredo(env, id, c.quem.email, c.agora);
  if (criar) lista.push(projeto);
  else lista[i] = projeto;
  await guardarProjetos(env, lista);
  const oque = [criar ? "criou" : "mudou", ligarLogin ? "ligou o login" : "", novoProduto ? "ligou a venda" : "",
    antes && antes.produto && projeto.produto && antes.produto.aberto !== projeto.produto.aberto ? (projeto.produto.aberto ? "abriu a venda" : "fechou a venda") : "",
    antes && antes.publicado !== projeto.publicado ? (projeto.publicado ? "pôs na home" : "tirou da home") : ""].filter(Boolean).join(", ");
  await anotar(env, c.quem.email, id, oque, c.agora);
  return { projeto, segredo };
}

async function mover(env, c, id, para) {
  const lista = await lerProjetos(env);
  const i = lista.findIndex((x) => x.id === id);
  if (i < 0) return json({ erro: "o projeto " + id + " não existe" }, 404);
  const j = para === "cima" ? i - 1 : para === "baixo" ? i + 1 : -1;
  if (j < 0 || j >= lista.length) return json({ erro: "não dá para mover para lá" }, 400);
  [lista[i], lista[j]] = [lista[j], lista[i]];
  await guardarProjetos(env, lista);
  return json(await tela(env));
}

async function apagar(env, c, id, d) {
  if (d.confirmar !== true) return json({ erro: "confirme na página" }, 400);
  const lista = await lerProjetos(env);
  const p = lista.find((x) => x.id === id);
  if (!p) return json({ erro: "o projeto " + id + " não existe" }, 404);
  if (p.produto) return json({ erro: "este projeto vende pela Atos: quem pagou depende dele. Feche a venda e tire da home em vez de apagar." }, 409);
  await guardarProjetos(env, lista.filter((x) => x.id !== id));
  await anotar(env, c.quem.email, id, "apagou" + (p.login ? " (o login " + p.login.app + " continua no Login Atos)" : ""), c.agora);
  return json(await tela(env));
}

// ------------------------------------------------------------ o GitHub

async function conectar(env, c) {
  if (!githubAppConfigurado(env)) return json({ erro: "falta o GitHub App do Portfolio no Worker (GITHUB_APP_ID, GITHUB_APP_SLUG e GITHUB_APP_CHAVE)" }, 503);
  const state = aleatorio(16);
  await env.CONTAS.put(KP(env).estado(state), JSON.stringify({ email: c.quem.email }), { expirationTtl: 600 });
  return new Response(null, { status: 302, headers: { location: enderecoDeInstalar(env, state), "cache-control": "no-store" } });
}

async function instalado(env, c, url) {
  const voltar = (frase) => new Response(null, { status: 302, headers: { location: "/admin/" + (frase ? "?erro=" + encodeURIComponent(frase) : "") + "#portfolio", "cache-control": "no-store" } });
  const state = String(url.searchParams.get("state") || "");
  const id = String(url.searchParams.get("installation_id") || "");
  const guardado = /^[A-Za-z0-9_-]{10,40}$/.test(state) ? await kv(env, KP(env).estado(state)) : null;
  // A volta de uma mudanca feita no GitHub ("Redirect on update", sem o state): so a instalacao ja conectada, e so
  // para ler de novo o que ela libera (conferido como o app). Outra instalacao sem o state: recusa.
  const atual = await kv(env, KP(env).github);
  const atualizacao = !guardado && url.searchParams.get("setup_action") === "update" && Boolean(atual) && atual.instalacao === id;
  if (!atualizacao && (!guardado || guardado.email !== c.quem.email)) return voltar("a conexão com o GitHub venceu ou não começou aqui; tente de novo");
  if (guardado) await env.CONTAS.delete(KP(env).estado(state));
  if (!githubAppConfigurado(env)) return voltar("falta o GitHub App do Portfolio no Worker");
  const inst = await lerInstalacao(env, id, { buscar: c.deps.fetch || fetch, agora: c.agora });
  if (!inst) return voltar("o GitHub não confirmou a instalação do app");
  await env.CONTAS.put(KP(env).github, JSON.stringify({ instalacao: inst.id, conta: inst.conta, tipo: inst.tipo, selecao: inst.selecao, quando: iso(c.agora), por: c.quem.email }));
  await anotar(env, c.quem.email, "", (atualizacao ? "atualizou o acesso do GitHub (" : "conectou o GitHub (") + inst.conta + ")", c.agora);
  return voltar("");
}

// ------------------------------------------------------------ a tela

async function tela(env) {
  const projetos = [];
  for (const p of await lerProjetos(env)) {
    const x = { ...p };
    if (p.produto) {
      const s = await kv(env, KP(env).segredo(p.id));
      x.produto = { ...p.produto, segredo: s ? { quando: s.quando, por: s.por } : null, checkout: "/" + p.id + "/assinar/" };
    }
    projetos.push(x);
  }
  const gh = await kv(env, KP(env).github);
  return {
    projetos, fixos: FIXOS, semente: await semSemente(env), venda_ligada: Boolean(await chaveDaCifra(env)),
    github: { configurado: githubAppConfigurado(env), conectado: gh && gh.instalacao ? gh : null },
    registro: (await kv(env, KP(env).registro)) || [],
  };
}

export function ehRotaDoPortfolio(p) {
  return p === "/api/admin/portfolio" || p.startsWith("/api/admin/portfolio/");
}
export const ehNavegacaoDoPortfolio = (p) => p === "/api/admin/portfolio/github/conectar" || p === "/api/admin/portfolio/github/instalado";

/* c = {env, deps, quem, agora}; quem ja e o dono (worker/admin.js). */
export async function atenderPortfolio(request, env, url, c) {
  const p = url.pathname;
  const m = request.method;
  try {
    if (p === "/api/admin/portfolio" && m === "GET") return json(await tela(env));
    if (p === "/api/admin/portfolio/github/conectar" && m === "GET") return conectar(env, c);
    if (p === "/api/admin/portfolio/github/instalado" && m === "GET") return instalado(env, c, url);
    if (p === "/api/admin/portfolio/github/desconectar" && m === "POST") {
      await env.CONTAS.delete(KP(env).github);
      await anotar(env, c.quem.email, "", "desconectou o GitHub", c.agora);
      return json(await tela(env));
    }
    if (p === "/api/admin/portfolio/github/repos" && m === "GET") {
      const gh = await kv(env, KP(env).github);
      if (!gh || !gh.instalacao) return json({ erro: "conecte o GitHub primeiro" }, 409);
      if (!githubAppConfigurado(env)) return json({ erro: "falta o GitHub App do Portfolio no Worker" }, 503);
      return json({ conta: gh.conta, repos: await reposDaInstalacao(env, gh.instalacao, { buscar: c.deps.fetch || fetch, agora: c.agora }) });
    }
    if (m !== "POST") return json({ erro: "rota não existe" }, 404);
    const d = (await lerJson(request)) || {};
    if (p === "/api/admin/portfolio/projetos") return depoisDeSalvar(env, await salvar(env, c, String(d.id || ""), d, true));
    const r = p.match(/^\/api\/admin\/portfolio\/projetos\/([a-z0-9-]{2,31})(?:\/(mover|segredo|apagar))?$/);
    if (!r) return json({ erro: "rota não existe" }, 404);
    if (!r[2]) return depoisDeSalvar(env, await salvar(env, c, r[1], d, false));
    if (r[2] === "mover") return mover(env, c, r[1], d.para);
    if (r[2] === "apagar") return apagar(env, c, r[1], d);
    // o segredo: de novo, so de um projeto que vende
    if (d.confirmar !== true) return json({ erro: "confirme na página: o segredo anterior para de valer na hora" }, 400);
    const proj = (await lerProjetos(env)).find((x) => x.id === r[1]);
    if (!proj || !proj.produto) return json({ erro: "o projeto " + r[1] + " não vende pela Atos" }, 404);
    const segredo = await gerarSegredo(env, r[1], c.quem.email, c.agora);
    await anotar(env, c.quem.email, r[1], "gerou outro segredo dos eventos", c.agora);
    return json({ segredo });
  } catch (e) {
    return json({ erro: String((e && e.message) || e).slice(0, 300) }, (e && e.status) || 500);
  }
}

/* Depois de salvar: o catalogo deste isolate le de novo na hora (os outros, em ate 30 s). */
async function depoisDeSalvar(env, r) {
  const { carregarCatalogo } = await import("./cobranca/catalogo.js");
  await carregarCatalogo(env, { forcar: true });
  return json({ ...(await tela(env)), salvo: r.projeto.id, ...(r.segredo ? { segredo: r.segredo } : {}) });
}

// ------------------------------------------------------------ a home

const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const ROMANOS = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
export function romano(n) {
  let s = "";
  for (const [v, r] of ROMANOS) while (n >= v) { s += r; n -= v; }
  return s;
}

/* O cartao de um projeto, como os escritos na home. */
export function cartao(p, n) {
  const icone = p.icone ? '<img class="inicial" src="' + escHtml(p.icone) + '" alt="" width="32" height="32">'
    : '<span class="inicial" aria-hidden="true">' + escHtml(String(p.nome || "?").trim().charAt(0).toUpperCase()) + "</span>";
  const acoes = [];
  if (p.produto && p.produto.aberto) acoes.push('<a class="btn p" href="/' + escHtml(p.id) + '/assinar/">Assinar<span aria-hidden="true">→</span></a>');
  if (p.site) acoes.push('<a class="btn p" href="' + escHtml(p.site) + '" target="_blank" rel="noopener">Site<span aria-hidden="true">↗</span></a>');
  if (p.repo && !p.repo.privado && p.mostrar_repo) acoes.push('<a class="btn p" href="' + escHtml(p.repo.url) + '" target="_blank" rel="noopener">GitHub<span aria-hidden="true">↗</span></a>');
  return '<article class="projeto">\n          <div class="cab">' + icone + '<span class="nome"><strong>' + escHtml(p.nome) + "</strong>" +
    (p.plataforma ? "<small>" + escHtml(p.plataforma) + "</small>" : "") + '</span><span class="romano" aria-hidden="true">' + romano(n) + "</span></div>\n" +
    "          <p>" + escHtml(p.descricao) + "</p>\n" +
    (acoes.length ? '          <div class="acoes">\n            ' + acoes.join("\n            ") + "\n          </div>\n" : "") + "        </article>";
}

const INICIO = "<!-- portfolio:inicio -->";
const FIM = "<!-- portfolio:fim -->";

/* A home com os projetos publicados do Portfolio no lugar do trecho marcado em public/index.html. Sem o KV, fica o
   HTML escrito (os da semente). */
export async function homeComPortfolio(html, env) {
  const i = html.indexOf(INICIO), f = html.indexOf(FIM);
  if (i < 0 || f < i) return html;
  let projetos;
  try {
    projetos = (await lerProjetos(env)).filter((x) => x.publicado);
  } catch {
    return html;
  }
  const antes = (html.slice(0, i).match(/<article class="projeto">/g) || []).length;
  const cartoes = projetos.map((p, k) => "        " + cartao(p, antes + k + 1)).join("\n");
  return html.slice(0, i + INICIO.length) + "\n" + cartoes + "\n        " + html.slice(f);
}
