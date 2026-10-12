// Teste do Atos Workspace Pro (worker/workspace-plano.js e quem o aplica): a compra pelo mesmo caminho do PAVLVS (o
// checkout da Atos Cobranca, com o Mercado Pago simulado: a mensalidade no cartao e o ano no Pix), as regras antes de
// cobrar (o Workspace ativo, os termos atuais, o produto aberto), o direito estendido (plano, ate, periodo, pago_por) e o
// que a tela, a Minha conta e o painel mostram; cada limite do gratuito e do Pro (sistemas, pessoas, formularios e envios,
// avisos, entradas e CSV, status: enderecos, intervalo e e-mail, paginas de links e links); e a volta do Pro ao gratuito
// (nada apagado; o que passa fica fora do plano: so leitura, sem entregar, sem conferir, fora do ar; a guarda dos
// registros com a carencia). Sem rede.
//   node worker/teste-plano.mjs
import { A, GET, ativar, chamar, checar, contaPronta, darPro, fim, novoEnv, objeto, rede, sessao, vencerPro } from "./apoio-teste-workspace.mjs";
import { aplicarAviso } from "./cobranca/api.js";
import { idDoCliente } from "./cobranca/cliente.js";
import { PRODUTOS } from "./cobranca/catalogo.js";
import { CARENCIA_DIAS, PLANOS_WS, planoDe } from "./workspace-plano.js";
import { conferirStatusAgendado } from "./status.js";

const env = novoEnv({ MP_ACCESS_TOKEN: "segredo-mp", MP_PUBLIC_KEY: "PUBLICA", PRODUTOS_ABERTOS: "pavlvs,workspace" });
const ch = (caminho, op = {}) => chamar(caminho, { ...op, e: env });
const get = (caminho, cookie) => GET(caminho, cookie, env);
const obj = (nome) => objeto(nome, env);

// O Mercado Pago simulado (o mesmo jeito do teste da cobranca): a assinatura, as orders e a cobranca do mes.
const mp = { preapprovals: new Map(), orders: new Map(), authorized: new Map() };
const resp = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
let statusDe = {};
rede.fn = async (url, op = {}) => {
  const corpo = op.body ? JSON.parse(op.body) : null;
  if (url === "https://api.mercadopago.com/preapproval" && op.method === "POST") {
    const p = { id: "pre-" + mp.preapprovals.size, status: "authorized", external_reference: corpo.external_reference, next_payment_date: "2026-11-12T00:00:00Z", valor: corpo.auto_recurring.transaction_amount };
    mp.preapprovals.set(p.id, p);
    return resp(p, 201);
  }
  let m = /\/preapproval\/([^/?]+)$/.exec(url);
  if (m) return resp(mp.preapprovals.get(m[1]));
  if (url === "https://api.mercadopago.com/v1/orders" && op.method === "POST") {
    const pag = corpo.transactions.payments[0];
    const pix = pag.payment_method.id === "pix";
    const o = { id: "ORD" + mp.orders.size, external_reference: corpo.external_reference, total: corpo.total_amount, status: pix ? "action_required" : "processed",
      transactions: { payments: [{ payment_method: pix ? { id: "pix", type: "bank_transfer", qr_code: "000201", qr_code_base64: "iVBOR", ticket_url: "https://mp/ticket" } : pag.payment_method }] } };
    mp.orders.set(o.id, o);
    return resp(o, 201);
  }
  m = /\/v1\/orders\/([^/?]+)$/.exec(url);
  if (m) return resp(mp.orders.get(m[1]));
  m = /\/authorized_payments\/([^/?]+)$/.exec(url);
  if (m) return resp(mp.authorized.get(m[1]));
  // A pagina de status (o Cron): o que cada endereco responde.
  if (statusDe[url]) return statusDe[url]();
  return new Response("ok");
};
const PERFIL = { documento: "529.982.247-25", nome: "Dona Moura", endereco: { cep: "68380-000", logradouro: "Av. Paraná", numero: "1965", bairro: "União", cidade: "São Félix do Xingu", uf: "PA" } };
const VELHO_AV = new Date(Date.now() - 40 * 864e5).toISOString();
const direito = async (sub) => (await (await env.CLIENTES.get(await idDoCliente(sub)).fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "direito", produto: "workspace" }) })).json()).direito;

console.log("o plano");
checar(PRODUTOS.workspace.precos.find((x) => x.id === "workspace.pro.mes").formas.join() === "cartao" && PRODUTOS.workspace.precos.find((x) => x.id === "workspace.pro.ano").formas.join() === "cartao,pix",
  "o mês só no cartão (assinatura); o ano no cartão ou no Pix");
checar(planoDe(null).id === "gratuito" && planoDe({ plano: "pro", ate: new Date(Date.now() + 864e5).toISOString() }).pro && planoDe({ plano: "pro", ate: new Date(Date.now() - 1000).toISOString() }).venceu,
  "sem direito: gratuito; pago até amanhã: Pro; pago até ontem: venceu");
const G = PLANOS_WS.gratuito, P = PLANOS_WS.pro;
checar(G.apps === 2 && P.apps === 10 && G.liberados === 100 && P.liberados === 5000 && G.formularios === 1 && P.formularios === 10 && G.envios_dia === 50 && P.envios_dia === 1000 &&
  G.avisos_dias === 30 && P.avisos_dias === 90 && G.entradas_dias === 7 && P.entradas_dias === 90 && !G.entradas_csv && P.entradas_csv && G.status_enderecos === 1 && P.status_enderecos === 10 &&
  G.status_intervalo_min === 15 && P.status_intervalo_min === 1 && !G.status_email && P.status_email && G.links_paginas === 1 && P.links_paginas === 3 && G.links_por_pagina === 5 && P.links_por_pagina === 50 && !G.links_cliques && P.links_cliques,
  "os limites aprovados (gratuito → Pro)");

console.log("antes de cobrar");
const ana = await sessao("ana@exemplo.com.br", { e: env });
let r = await ch("/api/cobranca/v1/cliente", { cookie: ana, corpo: PERFIL });
checar(r.status === 200, "os dados para a nota");
r = await ch("/api/cobranca/v1/assinar", { cookie: ana, corpo: { preco: "workspace.pro.mes", token: "a".repeat(32), paymentMethodId: "visa" } });
checar(r.status === 409 && r.d.codigo === "sem_ativacao", "sem o Workspace ativo: 409 (ativar é gratuito e vem antes)", r.d);
await ch("/api/workspace/ativar", { cookie: ana, corpo: { aceito: true, versao: "2026-10-12.4" } });
{
  // Quem aceitou uma versão antiga dos termos: aceita a atual antes de pagar.
  const o = env.CLIENTES.get(await idDoCliente("sub-ana"));
  await o.fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "ativar", produto: "workspace", termos: { versao: "2026-10-12.4" } }) });
  r = await ch("/api/cobranca/v1/assinar", { cookie: ana, corpo: { preco: "workspace.pro.mes", token: "a".repeat(32), paymentMethodId: "visa" } });
  checar(r.status === 409 && r.d.codigo === "termos", "com os termos antigos: 409 termos", r.d);
}
await ativar(ana, env);
r = await chamar("/api/cobranca/v1/assinar", { cookie: ana, corpo: { preco: "workspace.pro.mes", token: "a".repeat(32), paymentMethodId: "visa" }, e: { ...env, PRODUTOS_ABERTOS: "pavlvs" } });
checar(r.status === 409 && r.d.codigo === "produto_fechado", "sem o workspace em PRODUTOS_ABERTOS: não vende", r.d);
r = await ch("/api/cobranca/v1/pagar", { cookie: ana, corpo: { preco: "workspace.pro.mes", forma: "pix" } });
checar(r.status === 400, "o mês no Pix: não (só cartão, assinatura)", r.d);

console.log("a mensalidade no cartão");
r = await ch("/api/cobranca/v1/assinar", { cookie: ana, corpo: { preco: "workspace.pro.mes", token: "a".repeat(32), paymentMethodId: "visa" } });
checar(r.status === 200 && r.d.status === "authorized" && r.d.produto === "workspace", "a assinatura: autorizada", r.d);
checar([...mp.preapprovals.values()][0].valor === 29, "R$ 29 por mês no Mercado Pago");
const pre = [...mp.preapprovals.values()][0];
checar(!(await direito("sub-ana")).ate, "autorizar o cartão ainda não estende (espera a cobrança do mês)");
mp.authorized.set("ap-1", { id: "ap-1", preapproval_id: pre.id, payment: { status: "approved" }, transaction_amount: 29, debit_date: new Date().toISOString() });
await aplicarAviso(env, "subscription_authorized_payment", "ap-1", {});
let d = await direito("sub-ana");
checar(d.plano === "pro" && Date.parse(d.ate) > Date.now() + 27 * 864e5 && d.periodo === "mes" && d.pago_por === "assinatura" && d.ativo === true && d.termos.versao === PRODUTOS.workspace.termos.versao,
  "a cobrança do mês: o mesmo direito ganha plano pro, até quando, o período e quem pagou (a ativação continua)", d);
await aplicarAviso(env, "subscription_authorized_payment", "ap-1", {});
checar((await direito("sub-ana")).ate === d.ate, "o mesmo aviso de novo não estende duas vezes");
checar((await obj("conta:sub-ana").ctx.storage.get("ws:plano")).ate === d.ate, "o registro dos dados da conta fica sabendo até quando (a guarda dos registros)");
r = await get("/api/workspace", ana);
checar(r.d.plano.id === "pro" && r.d.plano.ate === d.ate && r.d.plano.pago_por === "assinatura" && r.d.plano.limites.apps === 10 && r.d.precos.length === 2, "a tela do Workspace: Pro, até quando, os limites", r.d.plano);
r = await get("/api/cobranca/v1/conta", ana);
const ws = r.d.produtos.find((x) => x.produto === "workspace");
checar(ws && ws.plano === "pro" && ws.plano_nome === "Pro" && ws.assinatura && ws.assinatura.status === "authorized" && ws.endereco === "/workspace/" && r.d.gratuitos[0].pago.pro === true,
  "a Minha conta: a assinatura do Workspace Pro (para cancelar) e o Workspace ativo", { ws, g: r.d.gratuitos[0] });
checar(r.d.faturas.some((x) => x.produto === "workspace" && x.centavos === 2900), "a fatura do mês", r.d.faturas);
r = await ch("/api/cobranca/v1/assinar", { cookie: ana, corpo: { preco: "workspace.pro.mes", token: "a".repeat(32), paymentMethodId: "visa" } });
checar(r.status === 409 && r.d.codigo === "ja_assina", "assinar de novo: 409 (seria em dobro)", r.d);
{
  const eventos = await (await env.CLIENTES.get(await idDoCliente("sub-ana")).fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op: "eventos" }) })).json();
  checar(eventos.eventos.length === 0, "o Workspace não tem para onde mandar eventos: nada fica na fila", eventos.eventos.length);
}

console.log("o ano no Pix");
const bia = await sessao("bia@exemplo.com.br", { e: env });
await ativar(bia, env);
await ch("/api/cobranca/v1/cliente", { cookie: bia, corpo: PERFIL });
r = await ch("/api/cobranca/v1/pagar", { cookie: bia, corpo: { preco: "workspace.pro.ano", forma: "pix" } });
checar(r.status === 200 && r.d.status === "aguardando" && r.d.pix && r.d.pix.qr_code, "o Pix do ano: o código", r.d);
checar([...mp.orders.values()].at(-1).total === "290.00", "R$ 290 no Mercado Pago");
mp.orders.get([...mp.orders.keys()].at(-1)).status = "processed";
r = await get("/api/cobranca/v1/compras/" + r.d.id, bia);
checar(r.d.status === "paga", "pago: a tela vê", r.d);
d = await direito("sub-bia");
checar(d.plano === "pro" && Date.parse(d.ate) > Date.now() + 360 * 864e5 && d.periodo === "ano" && d.pago_por === "compra", "o ano: Pro por doze meses", d);

console.log("o painel mostra o plano");
{
  const fin = await sessao("fin@atos.dev.br", { e: env });
  await get("/api/workspace", bia); // a visita anota no índice
  r = await get("/api/admin/workspace/contas", fin);
  const linha = r.d.contas.find((x) => x.sub === "sub-bia");
  checar(linha && linha.plano.id === "pro" && linha.plano.ate === d.ate, "a lista de contas: Pro e até quando", linha);
  r = await get("/api/admin/workspace/contas/sub-ana", fin);
  checar(r.d.workspace.plano.id === "pro" && r.d.workspace.plano.pago_por === "assinatura", "a conta: o plano", r.d.workspace.plano);
  r = await get("/api/admin/workspace", fin);
  checar(r.d.numeros.workspaces.pro === 2, "a visão geral conta os Pro", r.d.numeros.workspaces);
}

// ------------------------------------------------------------------ os limites do gratuito
console.log("os limites do gratuito");
const SITE = { nome: "Horta Viva", descricao: "controle de canteiros", site: "https://horta.com.br", privacidade: "https://horta.com.br/p", termos: "https://horta.com.br/t" };
const caio = await contaPronta("caio", { e: env });
r = await ch("/api/integracoes/apps", { cookie: caio.cookie, corpo: SITE });
const APP1 = r.d.app.id;
await ch("/api/integracoes/apps", { cookie: caio.cookie, corpo: { ...SITE, nome: "Horta 2" } });
r = await ch("/api/integracoes/apps", { cookie: caio.cookie, corpo: { ...SITE, nome: "Horta 3" } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano" && /até 2 aplicativos/.test(r.d.erro) && /Pro/.test(r.d.erro) && r.d.pro === "/workspace/plano", "sistemas: o terceiro é recusado, dizendo o Pro", r.d);
r = await ch("/api/integracoes/apps/" + APP1, { cookie: caio.cookie, corpo: { acao: "liberar", emails: Array.from({ length: 101 }, (_, i) => "p" + i + "@x.com.br") } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano" && /100 pessoas/.test(r.d.erro), "pessoas: 101 recusadas", r.d);
r = await ch("/api/integracoes/apps/" + APP1, { cookie: caio.cookie, corpo: { acao: "liberar", emails: Array.from({ length: 100 }, (_, i) => "p" + i + "@x.com.br") } });
checar(r.status === 200 && r.d.app.liberados.length === 100, "100 cabem");
const BASEF = { nome: "Contato", origens: ["https://horta.com.br"], campos: ["nome", "email", "mensagem"] };
r = await ch("/api/workspace/formularios", { cookie: caio.cookie, corpo: BASEF });
const F1 = r.d.criado;
checar(r.status === 200 && r.d.limites.formularios === 1 && r.d.limites.dia_max === 50, "formulários: o primeiro, com os limites do gratuito", r.d.limites);
r = await ch("/api/workspace/formularios", { cookie: caio.cookie, corpo: { ...BASEF, nome: "Outro" } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano", "o segundo formulário: 409", r.d);
r = await ch("/api/workspace/formularios/" + F1, { cookie: caio.cookie, corpo: { ...BASEF, acao: "editar", limite_dia: 51 } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano", "mais de 50 por dia: 409", r.d);
{
  // O limite da conta no dia (somando os formulários), pelo objeto: 2 por dia no teste.
  const o = obj("conta:" + caio.sub);
  const a = await o.fazer({ op: "form_contar", id: F1, ip: "a", max: 1, envios_dia: 2 }, Date.now());
  const b = await o.fazer({ op: "form_contar", id: F1, ip: "b", max: 1, envios_dia: 2 }, Date.now());
  const c = await o.fazer({ op: "form_contar", id: F1, ip: "c", max: 1, envios_dia: 2 }, Date.now());
  checar(a.ok && b.ok && !c.ok && c.motivo === "limite_dia", "os envios do dia da conta", [a, b, c]);
}
r = await get("/api/integracoes/apps/" + APP1 + "/entradas?dias=90", caio.cookie);
checar(r.status === 200 && r.d.dias === 7 && r.d.limites.dias_max === 7 && r.d.limites.csv_permitido === false, "entradas: só 7 dias", r.d);
r = await get("/api/integracoes/apps/" + APP1 + "/entradas.csv", caio.cookie);
checar(r.status === 409 && r.d.codigo === "limite_do_plano", "o CSV é do Pro", r.d);
r = await get("/api/integracoes/apps/" + APP1 + "/avisos", caio.cookie);
checar(r.d.limites.retencao_dias === 30, "avisos: 30 dias", r.d.limites);
const E = (url, nome = "") => ({ nome, url });
const ST = { acao: "salvar", nome: "horta-caio", titulo: "Horta", publica: true, avisar: false, enderecos: [E("https://horta.com.br/", "Site")] };
r = await ch("/api/workspace/status", { cookie: caio.cookie, corpo: { ...ST, enderecos: [E("https://horta.com.br/"), E("https://api.horta.com.br/")] } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano" && /1 endereço/.test(r.d.erro), "status: dois endereços no gratuito, 409", r.d);
r = await ch("/api/workspace/status", { cookie: caio.cookie, corpo: { ...ST, avisar: true } });
checar(r.status === 409 && /e-mail é do Atos Workspace Pro/.test(r.d.erro), "o aviso por e-mail é do Pro", r.d);
r = await ch("/api/workspace/status", { cookie: caio.cookie, corpo: ST });
checar(r.status === 200 && r.d.limites.enderecos === 1 && r.d.limites.intervalo_min === 15 && r.d.limites.email === false, "um endereço a cada 15 minutos", r.d.limites);
checar((await obj("indice").ctx.storage.get("sag:" + caio.sub)).intervalo === 15, "a agenda: 15 minutos");
const LK = { acao: "salvar", nome: "horta-do-caio", exibicao: "Horta do Caio", links: [1, 2, 3, 4, 5].map((i) => ({ titulo: "L" + i, url: "https://horta.com.br/" + i })) };
r = await ch("/api/workspace/links", { cookie: caio.cookie, corpo: LK });
checar(r.status === 200 && r.d.limites.paginas === 1 && r.d.limites.links === 5, "links: uma página com 5 links", r.d.limites);

console.log("o Pro abre os limites");
await darPro(caio.sub, { e: env });
for (let i = 3; i <= 4; i++) checar((await ch("/api/integracoes/apps", { cookie: caio.cookie, corpo: { ...SITE, nome: "Horta " + i } })).status === 200, "sistema " + i);
r = await ch("/api/integracoes/apps/" + APP1, { cookie: caio.cookie, corpo: { acao: "liberar", emails: Array.from({ length: 50 }, (_, i) => "q" + i + "@x.com.br") } });
checar(r.status === 200 && r.d.app.liberados.length === 150, "mais pessoas");
r = await ch("/api/workspace/formularios", { cookie: caio.cookie, corpo: { ...BASEF, nome: "Segundo", limite_dia: 1000 } });
const F2 = r.d.criado;
checar(r.status === 200 && r.d.formularios.length === 2 && r.d.limites.dia_max === 1000, "o segundo formulário, com até 1.000 por dia", r.d.limites);
r = await get("/api/integracoes/apps/" + APP1 + "/entradas.csv", caio.cookie);
checar(r.status === 200 && /text\/csv/.test(r.r.headers.get("content-type")), "o CSV");
r = await get("/api/integracoes/apps/" + APP1 + "/entradas?dias=90", caio.cookie);
checar(r.d.dias === 90, "90 dias");
r = await ch("/api/workspace/status", { cookie: caio.cookie, corpo: { ...ST, avisar: true, enderecos: [1, 2, 3].map((i) => E("https://s" + i + ".horta.com.br/", "S" + i)) } });
checar(r.status === 200 && r.d.limites.intervalo_min === 1 && r.d.limites.email === true, "três endereços, a cada minuto, com o e-mail", r.d.limites);
checar((await obj("indice").ctx.storage.get("sag:" + caio.sub)).intervalo === 1, "a agenda: 1 minuto");
r = await ch("/api/workspace/status", { cookie: caio.cookie, corpo: { ...ST, enderecos: Array.from({ length: 11 }, (_, i) => E("https://s" + i + ".horta.com.br/")) } });
checar(r.status === 400 && /no máximo 10/.test(r.d.erro), "11 endereços: 400 (o teto do Pro)", r.d);
r = await ch("/api/workspace/links", { cookie: caio.cookie, corpo: { ...LK, links: [...r.d ? [] : [], ...Array.from({ length: 8 }, (_, i) => ({ titulo: "L" + i, url: "https://horta.com.br/" + i }))] } });
checar(r.status === 200 && r.d.paginas[0].links.length === 8, "oito links");
r = await ch("/api/workspace/links", { cookie: caio.cookie, corpo: { ...LK, nome: "horta-dois" } });
checar(r.status === 200 && r.d.paginas.length === 2, "a segunda página");
{
  // O aviso ao sistema com 40 dias: o Pro vê; a limpeza com o Pro guarda.
  const o = obj("conta:" + caio.sub);
  const velho = VELHO_AV;
  await o.ctx.storage.put("avq:" + APP1 + "|" + velho + "|aa", { evento: { id: "e1", tipo: "aviso.teste", criado: velho }, estado: "entregue", tentativas: 1, proxima: 0 });
  await o.fazer({ op: "lg_anotar", app: APP1, item: { resultado: "entrou", sub: "sub-x" } }, Date.now() - 20 * 864e5);
  r = await get("/api/integracoes/apps/" + APP1 + "/avisos", caio.cookie);
  checar(r.d.entregas.some((x) => x.id === "e1") && r.d.limites.retencao_dias === 90, "o Pro vê o aviso de 40 dias (90 dias de histórico)", r.d.limites);
  await o.limpar(Date.now());
  checar(Boolean(await o.ctx.storage.get("avq:" + APP1 + "|" + velho + "|aa")), "a limpeza do Pro guarda os 40 dias");
}

// ------------------------------------------------------------------ a volta ao gratuito
console.log("o Pro venceu: nada é apagado; o que passa fica fora do plano");
const antesDeVencer = obj("conta:" + caio.sub).ctx.storage.m.size;
await vencerPro(caio.sub, { e: env, diasAtras: 1 });
r = await get("/api/workspace", caio.cookie);
checar(r.d.plano.id === "gratuito" && r.d.plano.venceu, "a tela: gratuito, o Pro venceu em ...", r.d.plano);
r = await get("/api/integracoes", caio.cookie);
checar(r.d.apps.length === 4 && r.d.apps.filter((a) => a.fora_do_plano).length === 2 && !r.d.apps.find((a) => a.id === APP1).fora_do_plano, "sistemas: os 4 continuam; os 2 mais novos, fora do plano", r.d.apps.map((a) => [a.nome, a.fora_do_plano]));
const fora = r.d.apps.find((a) => a.fora_do_plano);
r = await ch("/api/integracoes/apps/" + fora.id, { cookie: caio.cookie, corpo: { ...SITE, acao: "editar", nome: "Mudou" } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano" && /só leitura|só dá para/.test(r.d.erro), "o fora do plano não edita", r.d);
r = await ch("/api/integracoes/apps/" + fora.id + "/acessos", { cookie: caio.cookie, corpo: { tipo: "publico", loopback: true } });
checar(r.status === 409, "nem cria acesso");
r = await ch("/api/integracoes/apps", { cookie: caio.cookie, corpo: { ...SITE, nome: "Horta 5" } });
checar(r.status === 409, "nem um sistema novo");
r = await ch("/api/integracoes/apps/" + APP1, { cookie: caio.cookie, corpo: { acao: "liberar", emails: "nova@x.com.br" } });
checar(r.status === 409 && /este tem 150/.test(r.d.erro), "acima de 100 pessoas, não libera mais ninguém", r.d);
r = await ch("/api/integracoes/apps/" + APP1, { cookie: caio.cookie, corpo: { acao: "tirar", email: "q0@x.com.br" } });
checar(r.status === 200 && r.d.app.liberados.length === 149, "mas tira (reduzir sempre pode)");
r = await ch("/api/integracoes/apps/" + fora.id, { cookie: caio.cookie, corpo: { acao: "apagar", confirmar: true } });
checar(r.status === 200, "e o fora do plano pode ser apagado");
r = await get("/api/workspace/formularios", caio.cookie);
checar(r.d.formularios.length === 2 && r.d.formularios.find((f) => f.id === F2).fora_do_plano && !r.d.formularios.find((f) => f.id === F1).fora_do_plano, "formulários: os dois ficam; o mais novo, fora do plano", r.d.formularios);
r = await ch("/f/" + F2, { corpo: { mensagem: "oi" }, origem: "https://horta.com.br", cabecalhos: { accept: "application/json", "cf-connecting-ip": "203.0.113.90" } });
checar(r.status === 503 && r.d.codigo === "parado", "o fora do plano não entrega (quem envia vê “não está recebendo”)", r.d);
checar([...obj("conta:" + caio.sub).ctx.storage.m.entries()].some(([k, v]) => k.startsWith("flog:" + F2) && v.motivo === "fora_do_plano"), "e o registro diz por quê");
r = await ch("/f/" + F1, { corpo: { mensagem: "oi" }, origem: "https://horta.com.br", cabecalhos: { accept: "application/json", "cf-connecting-ip": "203.0.113.91" } });
checar(r.status === 200, "o mais antigo continua entregando");
r = await ch("/api/workspace/formularios/" + F2, { cookie: caio.cookie, corpo: { acao: "desligar" } });
r = await ch("/api/workspace/formularios/" + F2, { cookie: caio.cookie, corpo: { acao: "ligar" } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano", "ligar o fora do plano: 409", r.d);
r = await get("/api/integracoes/apps/" + APP1 + "/entradas.csv", caio.cookie);
checar(r.status === 409, "o CSV volta a ser do Pro");
r = await get("/api/integracoes/apps/" + APP1 + "/entradas?dias=90", caio.cookie);
checar(r.d.dias === 7 && r.d.total === 0, "entradas: 7 dias (a de 20 dias não aparece)", r.d);
checar([...obj("conta:" + caio.sub).ctx.storage.m.keys()].some((k) => k.startsWith("lg:" + APP1)), "mas continua guardada (a carência)");
r = await get("/api/integracoes/apps/" + APP1 + "/avisos", caio.cookie);
checar(!r.d.entregas.some((x) => x.id === "e1") && r.d.limites.retencao_dias === 30, "avisos: 30 dias na tela", r.d.entregas);
r = await get("/api/workspace/status", caio.cookie);
checar(r.d.cfg.enderecos.length === 3 && r.d.fora_do_plano.length === 2 && r.d.limites.intervalo_min === 15, "status: os 3 endereços ficam; 2 fora do plano", r.d.fora_do_plano);
{
  const agora = Date.now() + 120000;
  await obj("indice").fazer({ op: "sag_marcar", sub: caio.sub, proxima: 0 }, agora);
  rede.chamadas.length = 0;
  const enviados = [];
  statusDe["https://s1.horta.com.br/"] = () => new Response("", { status: 500 });
  await conferirStatusAgendado(env, { agora: () => agora, enviarEmail: async (e, m) => { enviados.push(m); return { ok: true }; } });
  await obj("indice").fazer({ op: "sag_marcar", sub: caio.sub, proxima: 0 }, agora + 1);
  await conferirStatusAgendado(env, { agora: () => agora + 60000, enviarEmail: async (e, m) => { enviados.push(m); return { ok: true }; } });
  const urls = rede.chamadas.map((c) => c.url).filter((u) => /horta\.com\.br/.test(u));
  checar(urls.length === 2 && urls.every((u) => u === "https://s1.horta.com.br/"), "o Cron confere só o primeiro endereço", urls);
  checar(enviados.length === 0, "caiu duas vezes, mas o aviso por e-mail é do Pro: nada sai", enviados);
  checar((await obj("indice").ctx.storage.get("sag:" + caio.sub)).intervalo === 15, "a agenda volta a 15 minutos");
  delete statusDe["https://s1.horta.com.br/"];
  r = await GET("/status/horta-caio", undefined, env);
  const html = await r.r.text();
  checar((html.match(/<div class="st-barras/g) || []).length === 1 && /a cada 15 minutos/.test(html), "a página pública: só o endereço do plano, e o intervalo certo");
}
r = await ch("/api/workspace/status", { cookie: caio.cookie, corpo: { ...ST, avisar: true, enderecos: [1, 2, 3].map((i) => E("https://s" + i + ".horta.com.br/", "S" + i)) } });
checar(r.status === 200, "salvar sem acrescentar continua possível (o aviso que já estava ligado fica guardado)");
r = await ch("/api/workspace/status", { cookie: caio.cookie, corpo: { ...ST, enderecos: [1, 2, 3, 4].map((i) => E("https://s" + i + ".horta.com.br/", "S" + i)) } });
checar(r.status === 409, "acrescentar: 409");
r = await GET("/@horta-dois", undefined, env);
checar(r.status === 404 && /não está no ar agora/.test(await r.r.text()), "links: a página mais nova sai do ar");
r = await GET("/@horta-do-caio", undefined, env);
let html = await r.r.text();
checar(r.status === 200 && (html.match(/class="lk-link"/g) || []).length === 5 && !/\/ir\//.test(html), "a mais antiga fica, com 5 links e sem o redirecionamento contado");
r = await get("/api/workspace/links", caio.cookie);
checar(r.d.paginas.length === 2 && r.d.paginas.find((p) => p.nome === "horta-dois").fora_do_plano && r.d.paginas[0].links.length === 8 && !r.d.paginas[0].cliques, "a tela: as duas páginas e os 8 links continuam guardados", r.d.paginas.map((p) => [p.nome, p.fora_do_plano, p.links.length]));
r = await ch("/api/workspace/links", { cookie: caio.cookie, corpo: { ...LK, nome: "horta-dois" } });
checar(r.status === 409 && /fora do plano/.test(r.d.erro), "a página fora do plano não muda", r.d);
const oito = (await get("/api/workspace/links", caio.cookie)).d.paginas[0].links;
r = await ch("/api/workspace/links", { cookie: caio.cookie, corpo: { ...LK, links: [...oito, { titulo: "Nono", url: "https://horta.com.br/9" }] } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano", "um nono link: 409", r.d);
r = await ch("/api/workspace/links", { cookie: caio.cookie, corpo: { ...LK, exibicao: "Horta do Caio!", links: oito } });
checar(r.status === 200, "mudar sem acrescentar: pode");
checar(obj("conta:" + caio.sub).ctx.storage.m.size >= antesDeVencer - 1, "nada foi apagado ao vencer (só o que a pessoa apagou)", { antes: antesDeVencer, depois: obj("conta:" + caio.sub).ctx.storage.m.size });

console.log("a guarda dos registros depois do Pro");
{
  const o = obj("conta:" + caio.sub);
  const velho = VELHO_AV;
  await o.limpar(Date.now());
  checar(Boolean(await o.ctx.storage.get("avq:" + APP1 + "|" + velho + "|aa")) && [...o.ctx.storage.m.keys()].some((k) => k.startsWith("lg:" + APP1)), "na carência (" + CARENCIA_DIAS + " dias), a limpeza guarda o que o Pro guardava",
    { plano: await o.ctx.storage.get("ws:plano"), chaves: [...o.ctx.storage.m.keys()].filter((k) => /^(avq|lg):/.test(k)) });
  await vencerPro(caio.sub, { e: env, diasAtras: CARENCIA_DIAS + 1 });
  await get("/api/workspace", caio.cookie); // a área anota a data no objeto dos dados
  await o.limpar(Date.now());
  checar(!(await o.ctx.storage.get("avq:" + APP1 + "|" + velho + "|aa")) && ![...o.ctx.storage.m.keys()].some((k) => k.startsWith("lg:" + APP1)), "depois da carência, a guarda do gratuito (30 e 7 dias)");
}

console.log("voltar ao Pro devolve tudo");
await darPro(caio.sub, { e: env });
r = await get("/api/integracoes", caio.cookie);
checar(r.d.apps.every((a) => !a.fora_do_plano), "os sistemas voltam");
r = await ch("/api/workspace/formularios/" + F2, { cookie: caio.cookie, corpo: { acao: "ligar" } });
checar(r.status === 200, "o formulário liga");
checar((await GET("/@horta-dois", undefined, env)).status === 200, "a página volta ao ar");

console.log("as telas");
r = await GET("/workspace/plano", caio.cookie, env);
checar(r.status === 200, "/workspace/plano abre a área");
r = await GET("/workspace/plano", undefined, env);
checar(r.status === 302, "sem sessão: a tela de entrar");
void A;
rede.fn = null;
fim();
