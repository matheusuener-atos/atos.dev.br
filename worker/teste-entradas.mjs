// Teste do registro de entradas por aplicativo (worker/entradas.js): o login de verdade (/api/pedido e /api/autorizar)
// anota quem entrou com so o que o aplicativo recebe (o sub; o e-mail e o nome so com os escopos), as recusas por nao
// estar liberado sem dizer quem, o lugar e o navegador; o filtro (periodo, resultado, busca), o CSV (e a injecao de
// formula), o limite do dia, a limpeza (90 dias), outra conta nao ve, apagar o aplicativo leva junto, e o painel so com
// as contagens. Sem rede.
//   node worker/teste-entradas.mjs
import { A, GET, chamar, checar, contaPronta, env, fim, objeto, sessao } from "./apoio-teste-workspace.mjs";
import { anotarEntrada } from "./entradas.js";

const SITE = { nome: "Horta Viva", descricao: "controle de canteiros", site: "https://horta.com.br", privacidade: "https://horta.com.br/privacidade", termos: "https://horta.com.br/termos" };
const VOLTA = "https://horta.com.br/volta";
const maria = await contaPronta("maria");
let r = await chamar("/api/integracoes/apps", { cookie: maria.cookie, corpo: SITE });
const APP = r.d.app.id;
r = await chamar("/api/integracoes/apps/" + APP + "/acessos", { cookie: maria.cookie, corpo: { tipo: "publico", voltas: [VOLTA] } });
const CLI = r.d.acesso;
await chamar("/api/integracoes/apps/" + APP, { cookie: maria.cookie, corpo: { acao: "liberar", emails: "bia@cliente.com.br" } });
const b64url = (b) => Buffer.from(b).toString("base64url");
const desafio = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v".repeat(43))));
const consulta = (escopo) => new URLSearchParams({ client_id: CLI, redirect_uri: VOLTA, response_type: "code", scope: escopo, state: "st", nonce: "nn", code_challenge_method: "S256", code_challenge: desafio }).toString();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const login = (cookie, escopo, caminho = "/api/autorizar") => chamar(caminho, { cookie, corpo: { consulta: consulta(escopo), permitir: true }, cabecalhos: { "user-agent": UA } });
const linhas = async () => [...(await objeto("conta:" + maria.sub).ctx.storage.list({ prefix: "lg:" + APP + "|" })).values()];

console.log("o login anota");
const bia = await sessao("bia@cliente.com.br");
r = await login(bia, "openid");
checar(r.status === 200 && /code=/.test(r.d.ir), "a Bia entra (só openid)", r.d);
let l = await linhas();
checar(l.length === 1 && l[0].resultado === "entrou" && l[0].sub === "sub-bia" && !l[0].email && !l[0].nome && l[0].navegador === "Chrome no Windows",
  "entrou: o sub e o navegador; sem e-mail nem nome (não pediu os escopos)", l[0]);
r = await login(bia, "openid email profile");
l = await linhas();
const ultima = l.at(-1);
checar(ultima.email === "bia@cliente.com.br" && ultima.nome === "Nome bia", "com email e profile: o e-mail e o nome", ultima);
r = await login(bia, "openid email", "/api/pedido");
const caio = await sessao("caio@cliente.com.br");
r = await login(caio, "openid email profile", "/api/pedido");
checar(r.status === 200 && r.d.negado, "o Caio não está liberado");
r = await login(caio, "openid email profile");
checar(r.status === 403, "e o autorizar recusa");
l = await linhas();
const recusas = l.filter((x) => x.resultado === "recusado");
checar(recusas.length === 2 && recusas.every((x) => !x.sub && !x.email && !x.nome) && !JSON.stringify(l).includes("caio"), "recusado: sem sub, e-mail ou nome (nada diz quem tentou)", recusas);
r = await chamar("/api/autorizar", { cookie: bia, corpo: { consulta: consulta("openid"), permitir: false } });
checar((await linhas()).length === l.length, "“não permitiu” não entra no registro");
{
  const app = { terceiro: true, dono: { sub: maria.sub } };
  const req = { cf: { city: "São Félix do Xingu", regionCode: "PA", country: "BR" }, headers: new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" }) };
  await anotarEntrada(env, APP, app, req, { resultado: "entrou", sessao: { sub: "sub-dani", email: "dani@x.com.br", nome: "Dani" }, escopos: ["openid"] });
  const x = (await linhas()).at(-1);
  checar(x.onde === "São Félix do Xingu, PA, BR" && x.navegador === "Safari no iPhone" && !x.email, "o lugar aproximado (cidade, estado, país) e o navegador resumido", x);
}

console.log("a tela: filtro e CSV");
r = await GET("/api/integracoes/apps/" + APP + "/entradas", maria.cookie);
checar(r.status === 200 && r.d.total === 5 && r.d.linhas[0].sub === "sub-dani" && r.d.dias === 30, "lista as mais novas primeiro", r.d && r.d.total);
r = await GET("/api/integracoes/apps/" + APP + "/entradas?resultado=recusado", maria.cookie);
checar(r.d.total === 2 && r.d.linhas.every((x) => x.resultado === "recusado"), "filtra por resultado");
r = await GET("/api/integracoes/apps/" + APP + "/entradas?q=bia%40cliente", maria.cookie);
checar(r.d.total === 1, "busca pelo e-mail (só a entrada com o escopo email o tem)", r.d.total);
r = await GET("/api/integracoes/apps/" + APP + "/entradas?q=xingu", maria.cookie);
checar(r.d.total === 1, "busca pelo lugar");
await anotarEntrada(env, APP, { terceiro: true, dono: { sub: maria.sub } }, { headers: new Headers() }, { resultado: "entrou", sessao: { sub: "=HYPERLINK(\"x\")", email: "", nome: "" }, escopos: [] });
r = await GET("/api/integracoes/apps/" + APP + "/entradas.csv?dias=90", maria.cookie);
const csv = await r.r.text();
checar(r.status === 200 && /text\/csv/.test(r.r.headers.get("content-type")) && /attachment; filename="entradas-u-/.test(r.r.headers.get("content-disposition")), "o CSV sai como arquivo");
checar(csv.split("\r\n")[0].endsWith("quando,resultado,sub,email,nome,onde,navegador") && /sub-bia,bia@cliente\.com\.br,Nome bia/.test(csv), "o CSV tem as colunas e as linhas", csv.slice(0, 200));
checar(/"'=HYPERLINK\(""x""\)"/.test(csv), "a fórmula vira texto (injeção no CSV)", csv.split("\r\n")[1]);
const joao = await contaPronta("joao");
r = await GET("/api/integracoes/apps/" + APP + "/entradas", joao.cookie);
checar(r.status === 404, "outra conta: 404");
r = await GET("/api/integracoes/apps/" + APP + "/entradas", maria.pessoal);
checar(r.status === 403, "pelo e-mail pessoal: 403 (a porta das Integrações)");

console.log("limites e limpeza");
{
  const o = objeto("conta:" + maria.sub);
  let x;
  for (let i = 0; i < 2001; i++) x = await o.fazer({ op: "lg_anotar", app: APP, item: { resultado: "recusado" } }, Date.now());
  checar(x.contado === true, "mais de 2000 no dia: só conta");
  r = await GET("/api/integracoes/apps/" + APP + "/entradas", maria.cookie);
  checar(r.d.nao_registradas_hoje >= 1 && r.d.linhas.length === 500 && r.d.total > 500, "a tela diz quantas ficaram de fora e mostra até 500", { n: r.d.nao_registradas_hoje, l: r.d.linhas.length });
  const velho = Date.now() - 91 * 864e5;
  await o.fazer({ op: "lg_anotar", app: APP, item: { resultado: "entrou", sub: "sub-velho" } }, velho);
  r = await GET("/api/integracoes/apps/" + APP + "/entradas?dias=90&q=sub-velho", maria.cookie);
  checar(r.d.total === 0, "o período de 90 dias não traz o de 91");
  await o.limpar(Date.now());
  checar(!(await linhas()).some((y) => y.sub === "sub-velho"), "a limpeza tira o que passou de 90 dias");
}

console.log("o painel");
const fin = await sessao("fin@atos.dev.br");
r = await GET("/api/admin/workspace/apps", fin);
const linha = r.d.apps.find((y) => y.id === APP);
checar(linha.entradas_24h && linha.entradas_24h.entrou >= 4 && !JSON.stringify(r.d).includes("sub-bia"), "a equipe vê só as contagens das 24 h", linha.entradas_24h);

console.log("apagar o aplicativo");
await chamar("/api/integracoes/apps/" + APP, { cookie: maria.cookie, corpo: { acao: "apagar", confirmar: true } });
checar(!(await linhas()).length, "o registro sai junto");
void A;
fim();
