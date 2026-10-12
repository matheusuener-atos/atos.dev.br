// Teste dos avisos ao sistema (webhooks) do Atos Workspace (worker/avisos.js): cadastrar (o endereco conferido, o segredo
// uma vez), os eventos (acesso.revogado, liberado.adicionado, liberado.removido, aviso.teste; o sub so de quem ja
// permitiu), a assinatura (conferida pelo verificarAviso do pacote), as novas tentativas ate "falhou", tentar de novo,
// redirecionamento e erro de rede, desligar, trocar o segredo, o limite do dia, a limpeza (30 dias), apagar o
// aplicativo, e o painel da equipe (ver sem o segredo; desligar por abuso). Sem rede.
//   node worker/teste-avisos.mjs
import { GET, chamar, checar, contaPronta, env, fim, guardados, objeto, rede, sessao } from "./apoio-teste-workspace.mjs";
import { entregarAvisos, REENTREGAS_AVISO_S } from "./avisos.js";
import { verificarAviso } from "../pacotes/entrar/index.js";

const SITE = { nome: "Horta Viva", descricao: "controle de canteiros", site: "https://horta.com.br", privacidade: "https://horta.com.br/privacidade", termos: "https://horta.com.br/termos" };
const URL_AVISO = "https://horta.com.br/atos/avisos";
const maria = await contaPronta("maria");
let r = await chamar("/api/integracoes/apps", { cookie: maria.cookie, corpo: SITE });
const APP = r.d.app.id;
checar(/^u-/.test(APP), "o aplicativo existe", r.d);
const conta = () => objeto("conta:" + maria.sub);
const fila = async () => [...(await conta().ctx.storage.list({ prefix: "avq:" + APP + "|" })).values()];
const av = (corpo, cookie = maria.cookie) => chamar("/api/integracoes/apps/" + APP + "/avisos", { cookie, corpo });

// Os sistemas que recebem: guardam o que chegou e respondem o que o teste mandar.
let recebidos = [];
let resposta = () => new Response("ok", { status: 200 });
rede.fn = async (url, op) => {
  recebidos.push({ url, corpo: op.body, cab: op.headers, redirect: op.redirect });
  return resposta(url, op);
};
const rodar = async (agora = Date.now()) => entregarAvisos(conta(), agora, globalThis.fetch);

console.log("cadastrar");
r = await GET("/api/integracoes/apps/" + APP + "/avisos", maria.cookie);
checar(r.status === 200 && r.d.aviso === null && r.d.tipos.includes("acesso.revogado") && !r.d.tipos.includes("conta.excluida"), "sem aviso; os tipos (sem conta.excluida)", r.d);
for (const u of ["http://horta.com.br/x", "https://127.0.0.1/x", "https://localhost/x", "https://atos.dev.br/x", "https://intranet/x", "https://horta.com.br:8443/x"]) {
  r = await av({ acao: "salvar", url: u });
  checar(r.status === 400, "recusa " + u, r.d);
}
r = await av({ acao: "salvar", url: URL_AVISO });
const SEGREDO = r.d.segredo;
checar(r.status === 200 && /^atos_av_/.test(SEGREDO || "") && r.d.aviso.url === URL_AVISO && r.d.aviso.ativo, "cadastra e mostra o segredo uma vez", r.d);
r = await GET("/api/integracoes/apps/" + APP + "/avisos", maria.cookie);
checar(!JSON.stringify(r.d).includes(SEGREDO), "o GET não traz o segredo");
r = await GET("/api/integracoes", maria.cookie);
checar(r.d.apps[0].avisos && r.d.apps[0].avisos.url === URL_AVISO && !JSON.stringify(r.d).includes(SEGREDO), "a lista das Integrações traz o resumo, sem o segredo");
checar(r.d.apps[0].registro.some((x) => /cadastrou o aviso/.test(x.oque)), "fica no registro do aplicativo");
r = await av({ acao: "salvar", url: URL_AVISO }, await sessao(maria.email, { alias: maria.alias, idade: 13 * 3600 }));
checar(r.status === 401 && r.d.reentrar, "mudar pede login recente");
const joao = await contaPronta("joao");
r = await chamar("/api/integracoes/apps/" + APP + "/avisos", { cookie: joao.cookie, metodo: "GET" });
checar(r.status === 404, "outra conta: 404");

console.log("o teste e a assinatura");
r = await av({ acao: "testar" });
checar(r.status === 200 && /^av_/.test(r.d.testado), "manda um aviso de teste (vai para a fila)", r.d);
checar(typeof conta().ctx.storage.alarme === "number", "o alarme do objeto fica marcado");
await conta().alarm();
let x = recebidos.at(-1);
checar(x && x.url === URL_AVISO && x.redirect === "manual" && x.cab["Atos-Evento"] === r.d.testado, "o alarme entrega: POST ao endereço, sem seguir redirecionamento, com o Atos-Evento");
let aviso = await verificarAviso(x.corpo, x.cab["Atos-Assinatura"], SEGREDO);
checar(aviso.tipo === "aviso.teste" && aviso.app === APP, "o verificarAviso do pacote confere a assinatura", aviso);
checar((await fila()).some((y) => y.estado === "entregue"), "a entrega fica como entregue");

console.log("os eventos");
const permitiu = await sessao("bia@cliente.com.br");
guardados.set("atos:apps:sub-bia", JSON.stringify({ [APP]: { escopos: ["openid", "email"], quando: new Date().toISOString() } }));
await sessao("caio@cliente.com.br");
recebidos = [];
r = await chamar("/api/integracoes/apps/" + APP, { cookie: maria.cookie, corpo: { acao: "liberar", emails: "bia@cliente.com.br, caio@cliente.com.br, novo@semconta.com.br" } });
await conta().alarm();
aviso = await verificarAviso(recebidos.at(-1).corpo, recebidos.at(-1).cab["Atos-Assinatura"], SEGREDO);
checar(aviso.tipo === "liberado.adicionado" && aviso.dados.pessoas.length === 3, "liberar: liberado.adicionado com as três pessoas", aviso);
const p = Object.fromEntries(aviso.dados.pessoas.map((y) => [y.email, y]));
checar(p["bia@cliente.com.br"].sub === "sub-bia" && !p["caio@cliente.com.br"].sub && !p["novo@semconta.com.br"].sub, "o sub só de quem já permitiu o aplicativo (Caio tem conta e não permitiu: só o e-mail)", aviso.dados);
r = await chamar("/api/integracoes/apps/" + APP, { cookie: maria.cookie, corpo: { acao: "tirar", email: "bia@cliente.com.br" } });
await conta().alarm();
aviso = await verificarAviso(recebidos.at(-1).corpo, recebidos.at(-1).cab["Atos-Assinatura"], SEGREDO);
checar(aviso.tipo === "liberado.removido" && aviso.dados.pessoas[0].email === "bia@cliente.com.br" && aviso.dados.pessoas[0].sub === "sub-bia", "tirar: liberado.removido", aviso);
r = await chamar("/api/apps/revogar", { cookie: permitiu, corpo: { app: APP } });
await conta().alarm();
aviso = await verificarAviso(recebidos.at(-1).corpo, recebidos.at(-1).cab["Atos-Assinatura"], SEGREDO);
checar(r.status === 200 && aviso.tipo === "acesso.revogado" && aviso.dados.sub === "sub-bia" && Object.keys(aviso.dados).length === 1, "revogar em Minha conta: acesso.revogado só com o sub", aviso);
const n0 = recebidos.length;
await chamar("/api/apps/revogar", { cookie: await sessao("caio@cliente.com.br"), corpo: { app: APP } });
await conta().alarm();
checar(recebidos.length === n0, "quem nunca permitiu revogar não gera aviso");

console.log("as novas tentativas");
recebidos = [];
resposta = () => new Response("erro", { status: 500 });
await av({ acao: "testar" });
let agora = Date.now();
await rodar(agora);
let item = (await fila()).find((y) => y.estado === "pendente");
checar(item && item.tentativas === 1 && item.ultimo.status === 500 && item.proxima === agora + REENTREGAS_AVISO_S[0] * 1000, "500: fica pendente para daqui a 1 minuto", item);
checar(await rodar(agora + 30000) === 0, "antes da hora, não tenta");
for (const s of REENTREGAS_AVISO_S) { agora += s * 1000; await rodar(agora); }
item = (await fila()).find((y) => y.evento.id === item.evento.id);
checar(item.estado === "falhou" && item.tentativas === 6 && recebidos.length === 6, "depois de 6 tentativas: falhou", { estado: item.estado, t: item.tentativas, n: recebidos.length });
r = await GET("/api/integracoes/apps/" + APP + "/avisos", maria.cookie);
const ent = r.d.entregas.find((y) => y.id === item.evento.id);
checar(ent && ent.estado === "falhou" && ent.ultimo.motivo === "o sistema respondeu 500", "a tela mostra a falha e a última resposta", ent);
resposta = () => new Response("ok");
r = await av({ acao: "reenviar", entrega: ent.chave });
await conta().alarm();
checar(r.status === 200 && (await fila()).find((y) => y.evento.id === item.evento.id).estado === "entregue", "tentar de novo: entrega");
resposta = () => new Response(null, { status: 301, headers: { location: "https://169.254.169.254/" } });
await av({ acao: "testar" });
await conta().alarm();
item = (await fila()).filter((y) => y.estado === "pendente").at(-1);
checar(item && /redirecionamento/.test(item.ultimo.motivo) && recebidos.every((y) => !/169\.254/.test(y.url)), "301: não segue e conta como falha", item && item.ultimo);
resposta = () => { throw new TypeError("rede"); };
await rodar(Date.now() + 120000);
item = (await fila()).find((y) => y.evento.id === item.evento.id);
checar(item.ultimo.motivo === "não deu para conectar", "erro de rede: não deu para conectar", item.ultimo);
resposta = () => new Response("ok");

console.log("desligar, segredo, limite");
r = await av({ acao: "desligar" });
checar(r.d.aviso.ativo === false, "desliga");
await rodar(Date.now() + 10 * 60000);
checar((await fila()).find((y) => y.evento.id === item.evento.id).estado === "cancelado", "o que esperava é cancelado");
r = await chamar("/api/integracoes/apps/" + APP, { cookie: maria.cookie, corpo: { acao: "liberar", emails: "outro@cliente.com.br" } });
checar(!(await fila()).some((y) => y.evento.tipo === "liberado.adicionado" && y.evento.dados.pessoas[0].email === "outro@cliente.com.br"), "desligado: os eventos não entram na fila");
r = await av({ acao: "testar" });
checar(r.status === 409, "testar desligado: 409");
await av({ acao: "ligar" });
r = await av({ acao: "segredo" });
checar(r.status === 400, "trocar o segredo pede confirmar");
r = await av({ acao: "segredo", confirmar: true });
const NOVO = r.d.segredo;
checar(/^atos_av_/.test(NOVO) && NOVO !== SEGREDO, "troca o segredo (aparece uma vez)");
recebidos = [];
await av({ acao: "testar" });
await conta().alarm();
let falhou = false;
try { await verificarAviso(recebidos.at(-1).corpo, recebidos.at(-1).cab["Atos-Assinatura"], SEGREDO); } catch { falhou = true; }
checar(falhou && (await verificarAviso(recebidos.at(-1).corpo, recebidos.at(-1).cab["Atos-Assinatura"], NOVO)).tipo === "aviso.teste", "o segredo antigo para de conferir; o novo confere");
{
  const o = conta();
  let ultimo;
  for (let i = 0; i < 505; i++) ultimo = await o.fazer({ op: "av_evento", app: APP, tipo: "aviso.teste" }, Date.now());
  checar(ultimo.enfileirado === false && ultimo.limite === true, "mais de 500 avisos no dia: não entram", ultimo);
}

console.log("a limpeza");
{
  const s = conta().ctx.storage;
  const velho = new Date(Date.now() - 31 * 864e5).toISOString();
  await s.put("avq:" + APP + "|" + velho + "|abcd", { evento: { id: "av_velho", tipo: "aviso.teste", criado: velho, app: APP, dados: {} }, estado: "entregue", tentativas: 1, proxima: 0 });
  await conta().limpar(Date.now());
  checar(!(await s.get("avq:" + APP + "|" + velho + "|abcd")), "o aviso de mais de 30 dias some");
}

console.log("o painel da equipe");
const sup = await sessao("sup@atos.dev.br");
const fin = await sessao("fin@atos.dev.br");
r = await GET("/api/admin/workspace/apps", fin);
const linha = r.d.apps.find((y) => y.id === APP);
checar(linha.avisos && linha.avisos.url === URL_AVISO && !JSON.stringify(r.d).includes(NOVO) && !JSON.stringify(r.d).includes("atos_av_"), "a equipe vê o endereço, sem o segredo", linha.avisos);
r = await chamar("/api/admin/workspace/apps/" + APP + "/avisos/desligar", { cookie: fin, corpo: { motivo: "abuso" } });
checar(r.status === 403, "o financeiro não desliga");
r = await chamar("/api/admin/workspace/apps/" + APP + "/avisos/desligar", { cookie: sup, corpo: { motivo: "o endereço ataca um terceiro" } });
checar(r.status === 200, "o suporte desliga os avisos com o motivo", r.d);
r = await av({ acao: "ligar" });
checar(r.status === 403 && /desligou os avisos/.test(r.d.erro), "o dono não religa", r.d);
r = await av({ acao: "salvar", url: "https://outro.example.com/x" });
checar(r.status === 403, "nem troca o endereço");
r = await GET("/api/integracoes/apps/" + APP + "/avisos", maria.cookie);
checar(r.d.aviso.bloqueado.motivo === "o endereço ataca um terceiro", "o dono vê o motivo");
r = await chamar("/api/admin/workspace/apps/" + APP + "/avisos/ligar", { cookie: sup, corpo: {} });
checar(r.status === 200 && (await av({ acao: "ligar" })).status === 200, "a Atos liga de novo e o dono volta a mudar");

console.log("apagar o aplicativo");
r = await chamar("/api/integracoes/apps/" + APP, { cookie: maria.cookie, corpo: { acao: "apagar", confirmar: true } });
checar(r.status === 200 && !(await conta().ctx.storage.get("av:" + APP)) && !(await fila()).length, "o aviso, o segredo e a fila saem junto");

fim();
