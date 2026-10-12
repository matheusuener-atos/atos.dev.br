// Teste do grupo Atos Workspace e das Contas Atos no painel (worker/admin-workspace.js, worker/admin-contas.js,
// worker/workspace-indice.js): o indice (ativar, desativar, a auto-indexacao ao abrir a area, a varredura das contas
// antigas), as rotas por papel e por area, suspender o Workspace (a gestao parada com o motivo, desligar os aplicativos
// e suspender o endereco junto, reativar desfazendo), os aplicativos de terceiros (suporte desliga, so o dono apaga),
// as Contas Atos (busca pelo e-mail e pelo endereco, nada secreto na tela, encerrar sessoes, desligar a verificacao em
// duas etapas: so o dono, com motivo e identidade conferida, o aviso por e-mail), o registro e a busca do painel. Sem rede.
//   node worker/teste-admin-workspace.mjs
import worker from "./index.js";
import { comSeguranca, ligarSegundaEtapa } from "./apoio-teste-seguranca.mjs";
import { sha256 } from "./comum.js";
import { ClienteCobranca, idDoCliente } from "./cobranca/cliente.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { EmailAtos } from "./email-atos.js";
import { MATRIZ } from "./admin.js";

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
  // Como o KV: as chaves em ordem, com limite e cursor.
  list: async ({ prefix = "", limit = 1000, cursor } = {}) => {
    const todas = [...guardados.keys()].filter((k) => k.startsWith(prefix)).sort();
    const ini = cursor ? Number(cursor) : 0;
    const pagina = todas.slice(ini, ini + limit);
    const fim = ini + pagina.length >= todas.length;
    return { keys: pagina.map((name) => ({ name })), list_complete: fim, ...(fim ? {} : { cursor: String(ini + pagina.length) }) };
  },
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
const enviados = [];
globalThis.fetch = async (u, op = {}) => {
  const url = String(u);
  if (url.startsWith("https://api.resend.com/")) { enviados.push(JSON.parse(op.body)); return new Response("{}", { status: 200 }); }
  if (url.startsWith("https://api.cloudflare.com/")) return new Response(JSON.stringify({ success: true, result: [], result_info: { total_count: 7 } }), { headers: { "content-type": "application/json" } });
  throw new Error("fetch inesperado: " + url);
};
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-teste" };
const objetos = new Map();
const env = {
  CONTAS, ATOS_CHAVE: JSON.stringify(jwk), CF_ACCOUNT_ID: "conta-cf", CF_EMAIL_TOKEN: "token-cf", RESEND_API_KEY: "re_teste",
  ATOS_EQUIPE: JSON.stringify([
    { email: "dono@atos.dev.br", nome: "Dono", papel: "dono" },
    { email: "sup@atos.dev.br", nome: "Sup", papel: "suporte" },
    { email: "fin@atos.dev.br", nome: "Fin", papel: "financeiro" },
    { email: "pav@atos.dev.br", nome: "Pav", papel: "suporte", areas: ["pavlvs"] },
  ]),
  ASSETS: { fetch: async (req) => new Response("<p>pagina " + new URL(req.url).pathname + "</p>", { headers: { "content-type": "text/html" } }) },
};
const ns = (Classe) => ({ idFromName: (n) => n, get(id) {
  if (!objetos.has(Classe.name + id)) objetos.set(Classe.name + id, new Classe({ storage: storage() }, env));
  const o = objetos.get(Classe.name + id);
  return { fetch: (url, op) => o.fetch(new Request(url, op)), o };
} });
env.CLIENTES = ns(ClienteCobranca);
env.EMAIL_ATOS = ns(EmailAtos);
comSeguranca(env);

const A = "https://atos.dev.br";
const subDe = (email) => "sub-" + email.split("@")[0].replace(/[^a-z0-9]/g, "");
async function sessao(email, { alias = "", nome = "" } = {}) {
  const segredo = "s-" + email + "-" + alias + "-" + Math.random();
  const sub = subDe(email);
  if (!guardados.has("id:conta:" + email)) guardados.set("id:conta:" + email, JSON.stringify({ sub, nome: nome || "Nome " + email.split("@")[0], criada: "2026-10-01T10:00:00.000Z", sal: "00", hash: "ab", iteracoes: 1 }));
  await ligarSegundaEtapa(env, sub);
  const h = await sha256(segredo);
  guardados.set("atos:sessao:" + h, JSON.stringify({ sub, email, auth_time: Math.floor(Date.now() / 1000), criada: Date.now(), mfa: true, ...(alias ? { via: "alias", alias } : {}) }));
  return "__Host-atos=" + segredo;
}
async function chamar(caminho, { metodo = "POST", corpo, cookie } = {}) {
  const h = { origin: A };
  if (cookie) h.cookie = cookie;
  let body;
  if (corpo !== undefined) { body = JSON.stringify(corpo); h["content-type"] = "application/json"; }
  const r = await worker.fetch(new Request(A + caminho, { method: metodo, headers: h, body }), env);
  let d = null;
  try { d = await r.clone().json(); } catch { d = null; }
  return { status: r.status, d };
}
const GET = (c, k) => chamar(c, { metodo: "GET", cookie: k });
const reg = (op, d = {}) => env.EMAIL_ATOS.get("registro").fetch("https://email-atos/", { method: "POST", body: JSON.stringify({ op, ...d }) }).then((r) => r.json());
const VERSAO = PRODUTOS.workspace.termos.versao;

const dono = await sessao("dono@atos.dev.br");
const sup = await sessao("sup@atos.dev.br");
const fin = await sessao("fin@atos.dev.br");
const pav = await sessao("pav@atos.dev.br");
const maria = await sessao("maria@provedor.com.br");
const SUB_MARIA = subDe("maria@provedor.com.br");

// A Maria: o endereco Atos confirmado e um aplicativo com dois acessos.
await reg("reservar", { sub: SUB_MARIA, conta: "maria@provedor.com.br", alias: "maria.loja" });
await reg("destino_pedir", { sub: SUB_MARIA, destino: "maria@destino.example", hash: "h" });
await reg("codigo_conferir", { sub: SUB_MARIA, hash: "h" });
await reg("destino_cf", { sub: SUB_MARIA, email: "maria@destino.example", cf_id: "cf1", criado: true, verificado: true });
await reg("ligar", { sub: SUB_MARIA });
const APP = "u-abcdefghij";
guardados.set("atos:oidc:app:" + APP, JSON.stringify({ id: APP, nome: "Loja da Maria", descricao: "bolos", site: "https://loja.exemplo.test", privacidade: "https://loja.exemplo.test/p", termos: "https://loja.exemplo.test/t",
  criado: "2026-10-05T10:00:00.000Z", dono: { sub: SUB_MARIA, email: "maria@provedor.com.br" }, acesso: "liberados", liberados: ["joao@provedor.com.br", "ana@exemplo.test"], bloqueado: null,
  clientes: { [APP + "-web001"]: { tipo: "publico", voltas: ["https://loja.exemplo.test/volta"], origens: [], ativo: true }, [APP + "-srv001"]: { tipo: "confidencial", voltas: ["https://loja.exemplo.test/v2"], origens: [], ativo: false } } }));
guardados.set("atos:oidc:dono:" + SUB_MARIA, JSON.stringify([APP]));
guardados.set("atos:oidc:terceiros", JSON.stringify({ [APP]: { nome: "Loja da Maria", email: "maria@provedor.com.br", origens: [], bloqueado: false } }));

console.log("o índice: ativar e desativar");
let r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { aceito: true, versao: VERSAO } });
checar(r.status === 200 && r.d.ativo, "a Maria ativa o Workspace", r.d);
let l = await reg("ws_listar");
let linha = l.contas.find((x) => x.sub === SUB_MARIA);
checar(linha && linha.estado === "ativo" && linha.email === "maria@provedor.com.br" && linha.termos.versao === VERSAO && linha.origem === "ativacao" && linha.ativado,
  "ativar anota a conta no índice (sub, e-mail, ativado, versão dos termos, estado)", linha);
const joao = await sessao("joao@provedor.com.br");
await chamar("/api/workspace/ativar", { cookie: joao, corpo: { aceito: true, versao: VERSAO } });
await chamar("/api/workspace/desativar", { cookie: joao, corpo: { confirmar: true } });
linha = (await reg("ws_listar")).contas.find((x) => x.sub === subDe("joao@provedor.com.br"));
checar(linha && linha.estado === "desativado" && linha.desativado, "desativar muda o estado no índice", linha);

console.log("o índice: quem ativou antes dele");
// A Bia ativou antes do índice: o direito existe no objeto dela, o índice não sabe.
const bia = await sessao("bia@exemplo.test");
await env.CLIENTES.get(await idDoCliente(subDe("bia@exemplo.test"))).fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "ativar", produto: "workspace", termos: { versao: "2026-10-11.2" } }) });
checar(!(await reg("ws_listar")).contas.some((x) => x.sub === subDe("bia@exemplo.test")), "antes: a Bia não está no índice");
r = await GET("/api/workspace", bia);
linha = (await reg("ws_listar")).contas.find((x) => x.sub === subDe("bia@exemplo.test"));
checar(r.status === 200 && linha && linha.origem === "visita" && linha.estado === "ativo" && linha.termos.versao === "2026-10-11.2", "abrir a área do Workspace a põe no índice (auto-indexação), com os termos antigos", linha);
// O Caio ativou antes e nunca mais abriu: a varredura do painel o acha pelas Contas Atos do KV.
guardados.set("id:conta:caio@exemplo.test", JSON.stringify({ sub: "sub-caio", nome: "Caio", criada: "2026-09-01T10:00:00.000Z" }));
await env.CLIENTES.get(await idDoCliente("sub-caio")).fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "ativar", produto: "workspace", termos: { versao: "2026-10-11" } }) });
r = await GET("/api/admin/workspace", dono);
checar(r.status === 200 && r.d.indice.varredura && r.d.indice.varredura.conferidas > 0, "a visão geral faz a varredura das Contas Atos", r.d && r.d.indice);
for (let i = 0; i < 5 && !r.d.indice.varredura.completa; i++) r = await GET("/api/admin/workspace", dono);
linha = (await reg("ws_listar")).contas.find((x) => x.sub === "sub-caio");
checar(r.d.indice.varredura.completa && linha && linha.origem === "varredura" && linha.email === "caio@exemplo.test", "a varredura completa acha o Caio (ativou antes e nunca voltou)", linha);
checar(!(await reg("ws_listar")).contas.some((x) => x.sub === subDe("fin@atos.dev.br")), "quem nunca ativou não entra no índice");

console.log("a visão geral");
const N = r.d.numeros;
checar(N.workspaces.ativos === 3 && N.workspaces.desativados === 1 && N.workspaces.termos_antigos === 2 && N.enderecos.total === 1 && N.enderecos.encaminhando === 1 &&
  N.apps.total === 1 && N.apps.acessos === 2 && N.apps.acessos_ligados === 1 && N.vagas.na_cf === 7 && N.vagas.teto_cf === 200, "os números: Workspaces, endereços, aplicativos e acessos, vagas da Cloudflare", N);
checar(r.d.atencao.denuncias === null && !r.d.atencao.apps.length, "nada a ver ainda; denúncias: o painel diz que chegam por e-mail");

console.log("papéis e área");
r = await GET("/api/admin/workspace", pav);
checar(r.status === 403, "sem a área Atos: não vê o Workspace", r);
r = await GET("/api/admin/contas?q=maria", pav);
checar(r.status === 403, "nem as Contas Atos");
r = await GET("/api/admin/busca?q=maria", pav);
checar(r.status === 403, "nem a busca da Atos");
r = await GET("/api/admin/workspace/contas", fin);
checar(r.status === 200 && r.d.contas.length === 4 && r.d.contas.find((x) => x.sub === SUB_MARIA).alias.endereco === "maria.loja@atos.dev.br" && r.d.contas.find((x) => x.sub === SUB_MARIA).apps === 1,
  "o financeiro vê as contas do Workspace (com o endereço e os aplicativos)", r.d);
r = await GET("/api/admin/workspace/contas?q=maria.loja", fin);
checar(r.d.contas.length === 1 && r.d.contas[0].sub === SUB_MARIA, "a busca da lista acha pelo endereço Atos");
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/suspender", { cookie: fin, corpo: { motivo: "spam" } });
checar(r.status === 403, "o financeiro não suspende", r.d);
r = await chamar("/api/admin/workspace/apps/" + APP + "/desligar", { cookie: fin, corpo: { motivo: "spam" } });
checar(r.status === 403, "nem desliga aplicativo");
r = await chamar("/api/admin/contas/sessoes", { cookie: sup, corpo: { email: "maria@provedor.com.br", motivo: "pedido da pessoa", confirmar: true } });
checar(r.status === 403, "o suporte não encerra sessões de uma conta (só o dono)", r.d);
checar(MATRIZ.some(([t, p]) => t.includes("Suspender e reativar o Atos Workspace") && p.join() === "dono,suporte") && MATRIZ.some(([t, p]) => t.includes("Apagar um aplicativo de terceiro") && p.join() === "dono") &&
  MATRIZ.some(([t, p]) => t.includes("desligar a verificação em duas etapas") && p.join() === "dono"), "a matriz de papéis diz isso");

console.log("a conta no Workspace");
r = await GET("/api/admin/workspace/contas/" + SUB_MARIA, sup);
const vista = JSON.stringify(r.d);
checar(r.status === 200 && r.d.conta.email === "maria@provedor.com.br" && r.d.alias.endereco === "maria.loja@atos.dev.br" && r.d.alias.destino.mascarado === "m***@destino.example" &&
  r.d.apps[0].liberados === 2 && r.d.apps[0].acesso === "liberados" && r.d.apps[0].acessos.length === 2, "tudo da conta: o alias, o destino mascarado, os aplicativos (o modo e o tamanho da lista)", r.d);
checar(!vista.includes("maria@destino.example") && !vista.includes("joao@provedor.com.br") && !vista.includes("cf1"), "sem o destino inteiro, sem a lista de liberados, sem o id da Cloudflare");

console.log("suspender o Workspace");
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/suspender", { cookie: sup, corpo: { motivo: "" } });
checar(r.status === 400 && r.d.erro.includes("motivo"), "suspender pede o motivo");
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/suspender", { cookie: sup, corpo: { motivo: "golpe com o nome de um banco", desligar_apps: true, suspender_alias: true } });
checar(r.status === 200 && r.d.workspace.estado === "suspenso" && r.d.desligados.join() === APP && r.d.alias_suspenso === "maria.loja", "o suporte suspende, desligando o aplicativo e o endereço junto", r.d);
const appDepois = JSON.parse(guardados.get("atos:oidc:app:" + APP));
checar(appDepois.bloqueado && appDepois.bloqueado.motivo.includes("golpe"), "o aplicativo fica desligado pela Atos, com o motivo", appDepois.bloqueado);
checar((await reg("ver", { alias: "maria.loja" })).alias.suspenso, "o endereço fica suspenso");
r = await GET("/api/integracoes", maria);
checar(r.status === 403 && r.d.codigo === "workspace_suspenso" && r.d.erro.includes("golpe com o nome de um banco") && r.d.suspenso.motivo === "golpe com o nome de um banco", "as Integrações param, com o motivo", r.d);
r = await chamar("/api/workspace/email/desligar", { cookie: maria, corpo: {} });
checar(r.status === 403 && r.d.codigo === "workspace_suspenso", "e a gestão do e-mail Atos também", r.d);
r = await GET("/api/workspace", maria);
checar(r.status === 200 && r.d.suspenso && r.d.suspenso.motivo === "golpe com o nome de um banco" && r.d.ativo, "a área do Workspace mostra a suspensão e o motivo", r.d.suspenso);
r = await chamar("/api/workspace/ativar", { cookie: maria, corpo: { aceito: true, versao: VERSAO } });
r = await GET("/api/integracoes", maria);
checar(r.status === 403 && r.d.codigo === "workspace_suspenso", "aceitar os termos de novo não tira a suspensão");
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/suspender", { cookie: dono, corpo: { motivo: "de novo" } });
checar(r.status === 409, "suspender duas vezes: 409");
linha = (await reg("ws_listar")).contas.find((x) => x.sub === SUB_MARIA);
checar(linha.estado === "suspenso" && linha.suspenso.motivo === "golpe com o nome de um banco" && linha.suspenso.por === "sup@atos.dev.br", "o índice mostra suspenso (quem e o motivo)", linha);
r = await GET("/api/admin/workspace", fin);
checar(r.d.atencao.workspaces.length === 1 && r.d.atencao.enderecos.length === 1 && r.d.atencao.apps.length === 1, "a visão geral põe os três em atenção", r.d.atencao);

console.log("reativar");
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/reativar", { cookie: fin, corpo: {} });
checar(r.status === 403, "o financeiro não reativa");
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/reativar", { cookie: sup, corpo: { ligar_apps: true, reativar_alias: true, motivo: "contestação aceita" } });
checar(r.status === 200 && r.d.workspace.estado === "ativo" && r.d.ligados.join() === APP && r.d.alias_reativado === "maria.loja", "o suporte tira a suspensão e desfaz o que ela levou", r.d);
checar(!JSON.parse(guardados.get("atos:oidc:app:" + APP)).bloqueado && !(await reg("ver", { alias: "maria.loja" })).alias.suspenso, "o aplicativo e o endereço voltam");
r = await GET("/api/integracoes", maria);
checar(r.status !== 403 || r.d.codigo !== "workspace_suspenso", "as Integrações não respondem mais workspace_suspenso", r.d);
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/reativar", { cookie: sup, corpo: {} });
checar(r.status === 409, "reativar o que não está suspenso: 409");
const hist = (await GET("/api/admin/workspace/contas/" + SUB_MARIA, dono)).d;
checar(hist.workspace.historico.some((x) => x.oque.includes("a Atos suspendeu") && x.por === "sup@atos.dev.br") && hist.workspace.historico.some((x) => x.oque.includes("tirou a suspensão")),
  "o histórico do Workspace guarda as duas", hist.workspace.historico);
checar(hist.registro.some((x) => x.tipo === "workspace.suspender" && x.por === "sup@atos.dev.br" && x.motivo === "golpe com o nome de um banco" && x.oque.includes(APP) && x.oque.includes("maria.loja")) &&
  hist.registro.some((x) => x.tipo === "workspace.reativar"), "o registro da equipe: quem, quando, o motivo e o que foi junto", hist.registro);
// Suspender sem as opções: o aplicativo e o endereço continuam.
r = await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/suspender", { cookie: dono, corpo: { motivo: "só a gestão" } });
checar(r.status === 200 && !r.d.desligados.length && !r.d.alias_suspenso && !JSON.parse(guardados.get("atos:oidc:app:" + APP)).bloqueado && !(await reg("ver", { alias: "maria.loja" })).alias.suspenso,
  "sem as opções, só a gestão para", r.d);
await chamar("/api/admin/workspace/contas/" + SUB_MARIA + "/reativar", { cookie: dono, corpo: {} });

console.log("aplicativos de terceiros");
r = await GET("/api/admin/workspace/apps", fin);
checar(r.status === 200 && r.d.apps.length === 1 && r.d.apps[0].dono_sub === SUB_MARIA, "todos veem a lista");
r = await chamar("/api/admin/workspace/apps/" + APP + "/desligar", { cookie: sup, corpo: { motivo: "phishing" } });
checar(r.status === 200 && JSON.parse(guardados.get("atos:oidc:app:" + APP)).bloqueado.motivo === "phishing", "o suporte desliga um aplicativo", r.d);
r = await chamar("/api/admin/workspace/apps/" + APP + "/apagar", { cookie: sup, corpo: { confirmar: true } });
checar(r.status === 403 && guardados.has("atos:oidc:app:" + APP), "o suporte não apaga", r.d);
r = await chamar("/api/admin/workspace/apps/" + APP + "/ligar", { cookie: sup, corpo: {} });
checar(r.status === 200 && !JSON.parse(guardados.get("atos:oidc:app:" + APP)).bloqueado, "e liga de novo");
r = await chamar("/api/admin/oauth", { metodo: "GET", cookie: sup });
checar(r.status === 403, "o Login Atos (os aplicativos da Atos) continua só do dono");

console.log("Contas Atos: a busca");
r = await GET("/api/admin/contas?q=maria@provedor.com.br", fin);
checar(r.status === 200 && r.d.contas.length === 1 && r.d.contas[0].email === "maria@provedor.com.br", "pelo e-mail exato", r.d);
r = await GET("/api/admin/contas?q=maria.loja@atos.dev.br", fin);
checar(r.d.contas.length === 1 && r.d.contas[0].email === "maria@provedor.com.br" && r.d.contas[0].alias === "maria.loja@atos.dev.br", "pelo endereço Atos", r.d);
r = await GET("/api/admin/contas?q=maria.loja", fin);
checar(r.d.contas.length === 1 && r.d.contas[0].email === "maria@provedor.com.br", "pelo endereço sem o domínio", r.d);
r = await GET("/api/admin/contas?q=jo", fin);
checar(r.d.contas.length === 0, "2 letras: só o exato (nada)");
r = await GET("/api/admin/contas?q=joa", fin);
checar(r.d.contas.length === 1 && r.d.contas[0].email === "joao@provedor.com.br", "3 letras ou mais: os e-mails que começam assim", r.d);

console.log("Contas Atos: a conta");
// A Maria tem uma chave de acesso, dois códigos de recuperação e o índice da chave; e duas sessões na lista.
{
  const o = env.SEGURANCA.get(SUB_MARIA).o;
  const g = await o.ctx.storage.get("reg");
  g.rec = { hashes: ["h1", "h2"], gerados: "2026-10-10T10:00:00.000Z" };
  await o.ctx.storage.put("reg", g);
  guardados.set("atos:seg:chave:chave-de-teste", JSON.stringify({ sub: SUB_MARIA, email: "maria@provedor.com.br" }));
}
const mariaSegredo = "sess-maria-1";
const mariaH = await sha256(mariaSegredo);
guardados.set("atos:sessao:" + mariaH, JSON.stringify({ sub: SUB_MARIA, email: "maria@provedor.com.br", auth_time: Math.floor(Date.now() / 1000) - 60, criada: Date.now() - 60000 }));
guardados.set("atos:seg:sessoes:" + SUB_MARIA, JSON.stringify([{ id: "abc", h: mariaH, criada: new Date().toISOString(), como: "senha", onde: "São Paulo, SP, BR", navegador: "Chrome no Windows" }]));
r = await GET("/api/admin/contas/ver?email=maria@provedor.com.br", fin);
const txt = JSON.stringify(r.d);
checar(r.status === 200 && r.d.seguranca.ativa && r.d.seguranca.recuperacao.restantes === 2 && r.d.seguranca.chaves.length === 1 && r.d.seguranca.chaves[0].nome === "Chave de teste" &&
  r.d.entra.senha && r.d.entra.alias.endereco === "maria.loja@atos.dev.br" && r.d.sessoes.length === 1 && r.d.sessoes[0].navegador === "Chrome no Windows" && r.d.workspace.ativo,
  "como entra, o resumo da segurança, as sessões e o Workspace", r.d);
checar(!txt.includes(mariaH) && !txt.includes("\"h1\"") && !txt.includes("jwk") && !txt.includes("chave-de-teste") && !txt.includes("\"hash\""), "nada secreto: nem a chave da sessão, nem os códigos, nem a chave de acesso");
r = await GET("/api/admin/contas/ver?email=ninguem@exemplo.test", fin);
checar(r.status === 404, "conta que não existe: 404");

console.log("Contas Atos: desligar a verificação em duas etapas");
const corpo2fa = { email: "maria@provedor.com.br", motivo: "perdeu o celular; conferido por e-mail", confirmar: true, identidade_conferida: true };
r = await chamar("/api/admin/contas/segunda-etapa", { cookie: sup, corpo: corpo2fa });
checar(r.status === 403, "o suporte não desliga", r.d);
r = await chamar("/api/admin/contas/segunda-etapa", { cookie: dono, corpo: { ...corpo2fa, motivo: "" } });
checar(r.status === 400 && r.d.erro.includes("motivo"), "o dono, sem motivo: recusado");
r = await chamar("/api/admin/contas/segunda-etapa", { cookie: dono, corpo: { ...corpo2fa, confirmar: false } });
checar(r.status === 400, "sem confirmar: recusado");
r = await chamar("/api/admin/contas/segunda-etapa", { cookie: dono, corpo: { ...corpo2fa, identidade_conferida: false } });
checar(r.status === 400 && r.d.erro.includes("identidade"), "sem conferir a identidade: recusado", r.d);
r = await chamar("/api/admin/contas/segunda-etapa", { cookie: dono, corpo: { ...corpo2fa, email: "dono@atos.dev.br" } });
checar(r.status === 400 && r.d.erro.includes("própria"), "na própria conta: recusado", r.d);
const antes = enviados.length;
r = await chamar("/api/admin/contas/segunda-etapa", { cookie: dono, corpo: corpo2fa });
checar(r.status === 200 && r.d.removido.chaves === 1 && r.d.removido.codigos === 2 && r.d.encerradas === 1, "o dono desliga: a chave, os códigos e as sessões", r.d);
const resumo = (await GET("/api/admin/contas/ver?email=maria@provedor.com.br", dono)).d;
checar(!resumo.seguranca.ativa && !resumo.seguranca.chaves.length && !resumo.seguranca.recuperacao && !guardados.has("atos:seg:chave:chave-de-teste"),
  "a conta fica sem segunda etapa, e a chave sai do índice do “Entrar com chave de acesso”", resumo.seguranca);
checar(!guardados.has("atos:sessao:" + mariaH) && JSON.parse(guardados.get("id:conta:maria@provedor.com.br")).sessoes_desde, "as sessões caem");
r = await GET("/api/workspace", maria);
checar(r.status === 401, "e a sessão da Maria aberta antes também (o instante na conta)");
const aviso = enviados.slice(antes).find((e) => e.to === "maria@provedor.com.br" || (Array.isArray(e.to) && e.to.includes("maria@provedor.com.br")));
const textoAviso = aviso ? JSON.stringify(aviso) : "";
checar(aviso && aviso.subject.includes("A equipe da Atos desligou a verificação em duas etapas") && !/https?:\/\//.test(String(aviso.text || "")) && !textoAviso.includes("perdeu o celular"),
  "a pessoa recebe o aviso por e-mail, sem link (e sem o motivo interno)", aviso);
checar(resumo.atividade.some((x) => x.evento === "equipe-2fa-desligada"), "e a ação aparece nos últimos acessos dela");
checar(resumo.registro.some((x) => x.tipo === "conta.segunda-etapa" && x.por === "dono@atos.dev.br" && x.motivo.includes("perdeu o celular")), "o registro da equipe guarda quem e o motivo", resumo.registro);
r = await chamar("/api/admin/contas/segunda-etapa", { cookie: dono, corpo: corpo2fa });
checar(r.status === 409, "desligar de novo: 409 (já está desligada)");

console.log("Contas Atos: encerrar as sessões");
const joaoSessao = "sess-joao-1";
const joaoH = await sha256(joaoSessao);
guardados.set("atos:sessao:" + joaoH, JSON.stringify({ sub: subDe("joao@provedor.com.br"), email: "joao@provedor.com.br", auth_time: Math.floor(Date.now() / 1000) - 60, criada: Date.now() - 60000 }));
guardados.set("atos:seg:sessoes:" + subDe("joao@provedor.com.br"), JSON.stringify([{ id: "j1", h: joaoH, criada: new Date().toISOString(), como: "senha" }]));
r = await chamar("/api/admin/contas/sessoes", { cookie: dono, corpo: { email: "joao@provedor.com.br", motivo: "x", confirmar: true } });
checar(r.status === 400, "motivo curto demais: recusado");
const antes2 = enviados.length;
r = await chamar("/api/admin/contas/sessoes", { cookie: dono, corpo: { email: "joao@provedor.com.br", motivo: "avisou que alguém entrou", confirmar: true } });
checar(r.status === 200 && r.d.encerradas === 1 && !guardados.has("atos:sessao:" + joaoH), "o dono encerra as sessões", r.d);
r = await GET("/api/workspace", joao);
checar(r.status === 401, "a sessão do João cai");
checar(enviados.slice(antes2).some((e) => String(e.subject).includes("encerrou as sessões")), "e ele recebe o aviso");

console.log("a busca do painel");
r = await GET("/api/admin/busca?q=maria", fin);
checar(r.status === 200 && r.d.contas.some((x) => x.email === "maria@provedor.com.br") && r.d.enderecos.some((x) => x.alias === "maria.loja") && r.d.apps.some((x) => x.id === APP) &&
  r.d.workspaces.some((x) => x.sub === SUB_MARIA), "contas, endereços, aplicativos e Workspaces", r.d);
r = await GET("/api/admin/busca?q=loja da", fin);
checar(r.d.apps.some((x) => x.id === APP), "o aplicativo pelo nome");

console.log("o registro");
r = await GET("/api/admin/workspace", dono);
checar(r.d.registro.some((x) => x.tipo === "workspace.app.desligar" && x.por === "sup@atos.dev.br" && x.motivo === "phishing"), "a visão geral mostra o registro recente da equipe", r.d.registro);
const eq = (await reg("eq_listar", { limite: 100 })).itens;
checar(eq.length >= 7 && eq.every((x) => x.quando && x.por && x.oque), "cada ação está no registro (quem, quando, o quê)", eq.length);

console.log("");
console.log(falhas ? falhas + " falha(s)" : "tudo certo");
process.exit(falhas ? 1 : 0);
