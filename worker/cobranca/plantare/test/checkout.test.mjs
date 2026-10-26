import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import worker from "../../../index.js";
import { sha256 } from "../../../comum.js";
import { verificarEvento } from "../../eventos.js";
import { ambiente, entrada, PREFIXO } from "./apoio.mjs";

const fetchOriginal = globalThis.fetch;
after(() => { globalThis.fetch = fetchOriginal; });
import { abrir, perfil } from "./apoio-checkout.mjs";

test("checkout só abre em teste e a URL usa uma origem Atos permitida", async (t) => {
  const a = await abrir(t), r = await a.nova();
  assert.equal(r.checkout_disponivel, true);
  assert.equal(r.checkout_url, "https://atos-teste.exemplo.workers.dev/plantare/assinar?compra=" + r.compra.id);
  for (const origem of ["https://golpe.example", "https://atos.dev.br", "https://atos-teste.exemplo.workers.dev@golpe.example", "https://atos-teste.exemplo.workers.dev/caminho"] ) {
    a.env.PLANTARE_CHECKOUT_ORIGEM = origem;
    assert.equal((await a.nova()).checkout_url, null);
  }
  a.env.AMBIENTE = "producao";
  assert.equal((await a.browser(r.compra.id, true)).status, 404);
  assert.equal(a.gateway.chamadas.length, 0);
});

test("página redireciona para login preservando compra e exige sessão do dono", async (t) => {
  const a = await abrir(t), { compra: c } = await a.nova();
  const pagina = "https://atos.dev.br/plantare/assinar?compra=" + c.id;
  const anonima = await worker.fetch(new Request(pagina), a.env, {});
  assert.equal(anonima.status, 302);
  assert.equal(anonima.headers.get("location"), "/entrar/?volta=" + encodeURIComponent("/plantare/assinar?compra=" + c.id));
  const errada = await worker.fetch(new Request(pagina, { headers: { cookie: "__Host-atos=sessao-beto" } }), a.env, {});
  assert.equal(errada.status, 404);
  const certa = await worker.fetch(new Request(pagina, { headers: { cookie: "__Host-atos=sessao-ana" } }), a.env, {});
  assert.equal(certa.status, 200);
  assert.match(await certa.text(), /Checkout Plantare Maps/);
  assert.match(certa.headers.get("content-security-policy"), /script-src 'self';/);
  assert.match(certa.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(certa.headers.get("x-frame-options"), "DENY");
  assert.equal(certa.headers.get("cache-control"), "no-store");
  assert.equal(certa.headers.get("referrer-policy"), "no-referrer");
});

test("navegador não autentica com Bearer, não escolhe sub/valor nem paga sem Origin", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  assert.equal((await a.browser(c.id, true, { headers: { cookie: null } })).status, 401);
  assert.equal((await a.browser(c.id, true, { headers: { cookie: "__Host-atos=sessao-beto" } })).status, 404);
  for (const origin of [null, "https://plantaremaps.com.br", "https://golpe.example"])
    assert.equal((await a.browser(c.id, true, { headers: { origin } })).status, 403);
  for (const body of [{ centavos: 1 }, { sub: "sub-beto" }, { perfil }, [], null])
    assert.equal((await a.browser(c.id, true, { body })).status, 400);
  assert.equal((await a.browser(c.id + "?sub=sub-beto")).status, 400);
  assert.equal(a.gateway.chamadas.length, 0);
});

test("perfil fiscal validado e orçamento vigente são exigidos antes do gateway", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  for (const p of [null, { ...perfil, documento: "00000000000" }, { ...perfil, endereco: {} }]) {
    a.perfil = p;
    assert.equal((await a.browser(c.id, true)).data.codigo, "sem_perfil");
  }
  a.perfil = perfil; a.avancar(900000);
  assert.equal((await a.browser(c.id, true)).status, 410);
  assert.equal(a.gateway.chamadas.length, 0);
});

test("Pix usa payload persistido e uma referência para pedidos concorrentes", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  const rs = await Promise.all(Array.from({ length: 12 }, () => a.browser(c.id, true)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(a.gateway.orders.size, 1);
  assert.equal(a.gateway.chamadas.filter((r) => r.method === "POST").length, 1);
  const req = a.gateway.chamadas[0], body = JSON.parse(req.body);
  assert.equal(body.total_amount, "935.00");
  assert.equal(body.payer.email, a.env.MP_PAGADOR_TESTE);
  assert.equal(body.transactions.payments[0].expiration_time, "P1D");
  const r = await a.browser(c.id);
  assert.equal(r.data.pix.qr_code, "000201-Pix-teste");
  assert.equal(r.data.compra.direito_ativo, false);
  assert.equal("mp_id" in r.data, false);
});

test("gateway criou e perdeu resposta: reinício/alarme recupera a mesma order e corpo", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  a.gateway.perder = true;
  assert.equal((await a.browser(c.id, true)).data.processando, true);
  const primeira = a.gateway.chamadas[0];
  a.perfil = { ...perfil, documento: "11144477735" };
  a.env.MP_PAGADOR_TESTE = "outro@testuser.com";
  a.objetos.clear(); a.avancar(60001);
  assert.equal((await a.browser(c.id)).status, 200); // recria o objeto com storage antigo
  assert.equal(a.gateway.orders.size, 1);
  assert.equal(a.gateway.chamadas[1].body, primeira.body);
  assert.equal(a.gateway.chamadas[1].headers["X-Idempotency-Key"], primeira.headers["X-Idempotency-Key"]);
  assert.equal((await a.browser(c.id)).data.pix.qr_code, "000201-Pix-teste");
});

test("falha antes de persistir fase/reserva impede chamar gateway", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  const s = [...a.storages.values()][0]; s.falharEm = 1;
  assert.equal((await a.browser(c.id, true)).status, 503);
  assert.equal(a.gateway.chamadas.length, 0);
  assert.equal((await s.get("compra:" + c.id)).fase, "rascunho");
  assert.equal((await a.browser(c.id, true)).status, 200);
});

test("falha ao salvar resposta do gateway recupera por mesma chave após o lease", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  const s = [...a.storages.values()][0];
  a.gateway.transformar = (d) => { s.falharEm = 1; a.gateway.transformar = null; return d; };
  assert.equal((await a.browser(c.id, true)).status, 503);
  assert.equal(a.gateway.orders.size, 1);
  a.avancar(30001);
  assert.equal((await a.browser(c.id)).status, 200);
  assert.equal(a.gateway.orders.size, 1);
});

test("reserva promovida não vence enquanto o Pix está pendente", async (t) => {
  const a = await abrir(t, { ULTIMO: { versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1 } });
  const c = (await a.nova({ cupom: "ULTIMO" })).compra;
  assert.equal((await a.browser(c.id, true)).status, 200);
  a.avancar(900001);
  assert.equal((await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "ULTIMO" }))).data.codigo, "cupom_esgotado");
  const r = (await [...a.storages.values()][0].get("cupom:ULTIMO")).reservas;
  assert.equal(r[0].compra_id, c.id);
});

test("timeout prolongado exige revisão sem liberar reserva ou criar nova referência", async (t) => {
  const a = await abrir(t, { ULTIMO: { versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1 } });
  const c = (await a.nova({ cupom: "ULTIMO" })).compra;
  a.gateway.falhar = true;
  assert.equal((await a.browser(c.id, true)).data.processando, true);
  a.avancar(900000); a.gateway.falhar = false;
  const r = await a.browser(c.id);
  assert.equal(r.data.revisao, true);
  assert.equal(a.gateway.chamadas.length, 1);
  assert.equal((await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "ULTIMO" }))).data.codigo, "cupom_esgotado");
});

test("confirmação consome cupom/histórico uma vez e fixa prazo do direito", async (t) => {
  const a = await abrir(t, { ULTIMO: { versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1 } });
  const c = (await a.nova({ cupom: "ULTIMO" })).compra;
  await a.browser(c.id, true); a.pagarMP(); a.avancar();
  const paga = (await a.browser(c.id)).data.compra;
  assert.equal(paga.estado, "paga");
  assert.equal(paga.direito_ativo, true);
  assert.equal(paga.versao, 2);
  assert.equal(Date.parse(paga.baixar_ate) - Date.parse(paga.pago_em), 365 * 86400000);
  a.avancar();
  assert.deepEqual((await a.browser(c.id)).data.compra, paga);
  const s = [...a.storages.values()][0], usos = await s.get("cupom:ULTIMO");
  assert.equal(usos.reservas.length, 0);
  assert.equal(usos.consumos.length, 1);
  assert.equal((await s.get("historico:" + await sha256(c.sub))).compras_pagas, 1);
  assert.equal((await a.get()).data.compra.estado, "paga");
});

test("cortesia concede uma vez sem tocar no gateway, mesmo com duas abas", async (t) => {
  const a = await abrir(t, { LIVRE: { versao: "v1", tipo: "cortesia", usos_max: 1 } });
  const c = (await a.nova({ cupom: "LIVRE" })).compra;
  const rs = await Promise.all([a.browser(c.id, true), a.browser(c.id, true)]);
  assert.ok(rs.every((r) => r.data.compra.estado === "concedida"));
  assert.equal(rs[0].data.compra.versao, 2);
  assert.equal(a.gateway.chamadas.length, 0);
  assert.equal((await [...a.storages.values()][0].get("cupom:LIVRE")).consumos.length, 1);
});

test("devolução, parcial e contestação revogam sem devolver cupom ou ressuscitar", async (t) => {
  for (const status of ["refunded", "partially_refunded", "charged_back"]) {
    const a = await abrir(t, { ULTIMO: { versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1 } });
    const c = (await a.nova({ cupom: "ULTIMO" })).compra;
    await a.browser(c.id, true); const order = a.pagarMP(); a.avancar();
    await a.browser(c.id);
    if (status === "partially_refunded") order.status_detail = status;
    else order.status = status;
    a.avancar();
    const r = await a.browser(c.id);
    assert.equal(r.data.compra.estado, "devolvida");
    assert.equal(r.data.compra.direito_ativo, false);
    assert.equal(r.data.compra.versao, 3);
    a.pagarMP(); a.avancar();
    assert.deepEqual((await a.browser(c.id)).data.compra, r.data.compra);
    assert.equal((await [...a.storages.values()][0].get("cupom:ULTIMO")).consumos.length, 1);
  }
});

test("expiração confirmada libera reserva; pagamento contraditório exige revisão", async (t) => {
  const a = await abrir(t, { ULTIMO: { versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1 } });
  const c = (await a.nova({ cupom: "ULTIMO" })).compra;
  await a.browser(c.id, true);
  Object.assign([...a.gateway.orders.values()][0], { status: "canceled", status_detail: "expired" }); a.avancar();
  assert.equal((await a.browser(c.id)).data.compra.estado, "expirada");
  assert.equal((await [...a.storages.values()][0].get("cupom:ULTIMO")).reservas.length, 0);
  assert.equal((await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "ULTIMO" }))).status, 200);
  a.pagarMP(); a.avancar();
  const r = await a.browser(c.id);
  assert.equal(r.data.revisao, true);
  assert.equal(r.data.compra.direito_ativo, false);
});

test("resposta com valor, referência, moeda ou dono do gateway divergente nunca concede", async (t) => {
  for (const alterar of [
    (d) => { d.total_amount = "1.00"; }, (d) => { d.external_reference = "outra"; },
    (d) => { d.currency_id = "USD"; }, (d) => { d.live_mode = true; },
    (d) => { d.transactions.payments[0].payment_method.id = "visa"; },
    (d) => { d.transactions.payments.push(d.transactions.payments[0]); },
  ]) {
    const a = await abrir(t), c = (await a.nova()).compra;
    a.gateway.transformar = (d) => { alterar(d); return d; };
    const r = await a.browser(c.id, true);
    assert.equal(r.status, 503);
    assert.equal((await a.get()).data.compra.direito_ativo, false);
  }
});

test("valor pago menor que o orçamento não concede direito", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  await a.browser(c.id, true); const o = a.pagarMP(); o.total_paid_amount = "1.00"; a.avancar();
  assert.equal((await a.browser(c.id)).status, 503);
  assert.equal((await a.get()).data.compra.direito_ativo, false);
});

test("alarme recupera pagamento sem depender da janela continuar aberta", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  await a.browser(c.id, true); a.pagarMP(); a.avancar(60001);
  const s = [...a.storages.values()][0]; s.alarme = null;
  await [...a.objetos.values()][0].alarm();
  assert.equal((await a.get()).data.compra.estado, "paga");
  assert.equal((await s.list({ prefix: "pagamento-pendente:" })).size, 0);
});

test("evento e snapshot são atômicos; reentrega conserva ID/corpo e renova assinatura", async (t) => {
  const a = await abrir(t, { LIVRE: { versao: "v1", tipo: "cortesia" } });
  const c = (await a.nova({ cupom: "LIVRE" })).compra;
  a.env.EVENTOS_SEGREDO_PLANTARE = "segredo-plantare-de-evento-apenas-para-testes";
  const recebidos = [];
  a.env.PLANTARE_EVENTOS_TESTE = { async fetch(url, init) {
    assert.equal(url, "https://plantare.test/api/atos/eventos");
    assert.equal(await verificarEvento(a.env.EVENTOS_SEGREDO_PLANTARE, init.body, init.headers["Atos-Assinatura"], a.relogio.agora), true);
    recebidos.push(init);
    return new Response(null, { status: recebidos.length === 1 ? 503 : 204 });
  } };
  await a.browser(c.id, true);
  const s = [...a.storages.values()][0], o = [...a.objetos.values()][0];
  assert.equal((await s.list({ prefix: "evento-pendente:" })).size, 1);
  await o.alarm();
  a.objetos.clear(); a.avancar(60001); await a.get(); // reinício lógico
  await [...a.objetos.values()][0].alarm();
  assert.equal(recebidos.length, 2);
  assert.equal(recebidos[0].body, recebidos[1].body);
  assert.equal(recebidos[0].headers["Atos-Evento"], recebidos[1].headers["Atos-Evento"]);
  assert.notEqual(recebidos[0].headers["Atos-Assinatura"], recebidos[1].headers["Atos-Assinatura"]);
  assert.equal(JSON.parse(recebidos[1].body).dados.estado, "concedida");
  assert.equal((await s.list({ prefix: "evento-pendente:" })).size, 0);
});

test("falha ao gravar outbox reverte direito, consumo e histórico", async (t) => {
  const a = await abrir(t, { LIVRE: { versao: "v1", tipo: "cortesia" } });
  const c = (await a.nova({ cupom: "LIVRE" })).compra;
  const s = [...a.storages.values()][0], put = s.put;
  s.put = async (k, v) => { if (k.startsWith("evento-pendente:")) throw new Error("outbox fora"); return put(k, v); };
  assert.equal((await a.browser(c.id, true)).status, 503);
  assert.equal((await a.get()).data.compra.direito_ativo, false);
  assert.equal((await s.get("cupom:LIVRE")).consumos.length, 0);
  assert.equal(await s.get("historico:" + await sha256(c.sub)), undefined);
  s.put = put;
  assert.equal((await a.browser(c.id, true)).data.compra.estado, "concedida");
});

test("webhook consulta gateway, exige assinatura e só confirma após commit", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  await a.browser(c.id, true); const order = a.pagarMP();
  assert.equal((await a.aviso(order, { "x-signature": "ts=1,v1=forjada" })).status, 401);
  assert.equal((await a.get()).data.compra.estado, "aguardando");
  const s = [...a.storages.values()][0]; s.falharEm = 1;
  assert.equal((await a.aviso(order)).status, 503);
  assert.equal((await a.get()).data.compra.estado, "aguardando");
  assert.equal((await a.aviso(order)).status, 200);
  assert.equal((await a.get()).data.compra.estado, "paga"); // body dizia refunded: foi ignorado
  assert.equal((await a.aviso(order)).status, 200);
  assert.equal((await a.get()).data.compra.versao, 2);
  order.status = "refunded";
  assert.equal((await a.aviso(order)).status, 200);
  assert.equal((await a.get()).data.compra.estado, "devolvida");
  assert.equal((await s.list({ prefix: "evento-pendente:" })).size, 2);
});

test("revogação vence resposta antiga da criação ainda em voo", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  let liberar, iniciou;
  const pronto = new Promise((resolve) => { iniciou = resolve; });
  a.gateway.travar = new Promise((resolve) => { liberar = resolve; });
  a.gateway.transformar = (d) => d;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { if (args[1].method === "POST") iniciou(); return original(...args); };
  const pagamento = a.browser(c.id, true);
  await pronto;
  // Deixar a chamada criar a order antes de consultar o webhook.
  while (!a.gateway.orders.size) await new Promise((resolve) => setImmediate(resolve));
  const order = a.pagarMP(); order.status = "refunded";
  assert.equal((await a.aviso(order)).status, 200);
  liberar();
  await pagamento;
  assert.equal((await a.get()).data.compra.estado, "devolvida");
});

test("primeira compra não pode ser paga em duas campanhas simultaneamente", async (t) => {
  const campanha = { versao: "v1", tipo: "percentual", desconto_bps: 1000, so_primeira: true };
  const a = await abrir(t, { PRIMEIRA: campanha, OUTRA: campanha });
  // Histórico conferido é preparado somente no teste; importador pertence a M3.
  a.env.PLANTARE_ORCAMENTOS.get("teste:plantare:orcamentos:v1");
  const s = [...a.storages.values()][0];
  await s.put("historico:" + await sha256("sub-ana"), { conferido: true, compras_pagas: 0 });
  const c1 = (await a.nova({ cupom: "PRIMEIRA" })).compra;
  const c2 = (await a.nova({ cupom: "OUTRA", intent_id: "int-segunda-0001", area_hash: "b".repeat(64) }, "segunda-chave")).compra;
  assert.equal((await a.browser(c1.id, true)).status, 200);
  assert.equal((await a.browser(c2.id, true)).data.codigo, "primeira_pendente");
  a.pagarMP(); a.avancar(); await a.browser(c1.id);
  assert.equal((await a.browser(c2.id, true)).data.codigo, "cupom_primeira");
  assert.equal(a.gateway.orders.size, 1);
});

test("prazo absoluto vence o direito sem alterar data de pagamento ou conceder de novo", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  await a.browser(c.id, true); a.pagarMP(); a.avancar();
  const paga = (await a.browser(c.id)).data.compra;
  a.avancar(365 * 86400000);
  const r = await a.get();
  assert.equal(r.data.compra.direito_ativo, false);
  assert.equal(r.data.compra.versao, 3);
  assert.equal(r.data.compra.pago_em, paga.pago_em);
  assert.equal((await a.browser(c.id)).data.compra.direito_ativo, false);
});

test("criação assíncrona sem QR continua em processamento e consulta a mesma order", async (t) => {
  const a = await abrir(t), c = (await a.nova()).compra;
  a.gateway.transformar = (d) => { d.status = "processing"; delete d.transactions.payments[0].payment_method.qr_code; return d; };
  const inicial = await a.browser(c.id, true);
  assert.equal(inicial.data.processando, true);
  assert.equal(inicial.data.pix, null);
  a.gateway.transformar = null; a.avancar();
  const pronto = await a.browser(c.id);
  assert.equal(pronto.data.processando, false);
  assert.ok(pronto.data.pix.qr_code);
  assert.equal(a.gateway.orders.size, 1);
});

test("HTTP 409 ou 400 não apagam referência nem liberam reserva por suposição", async (t) => {
  for (const status of [409, 400]) {
    const a = await abrir(t), c = (await a.nova()).compra;
    a.gateway.status = status;
    assert.equal((await a.browser(c.id, true)).data.processando, true);
    const req = a.gateway.chamadas[0];
    a.gateway.status = 200; a.avancar(60001);
    assert.equal((await a.browser(c.id)).status, 200);
    assert.equal(a.gateway.chamadas[1].body, req.body);
    assert.equal(a.gateway.orders.size, 1);
  }
});

test("alarmes percorrem mais de 16 pagamentos sem deixar os últimos sem consulta", async (t) => {
  const a = await abrir(t);
  for (let i = 0; i < 17; i++) {
    const c = (await a.nova({ intent_id: "int-rodizio-" + i }, "chave-rodizio-" + i)).compra;
    await a.browser(c.id, true);
  }
  const o = [...a.objetos.values()][0];
  a.avancar(60001); await o.alarm();
  a.avancar(60001); await o.alarm();
  const consultadas = new Set(a.gateway.chamadas.filter((r) => r.method === "GET").map((r) => r.url.split("/").at(-1)));
  assert.equal(consultadas.size, 17);
});

test("outbox percorre mais de 16 eventos com trabalho limitado por alarme", async (t) => {
  const a = await abrir(t, { LIVRE: { versao: "v1", tipo: "cortesia", ilimitado: true } });
  const entregues = new Set();
  a.env.EVENTOS_SEGREDO_PLANTARE = "segredo-plantare-de-evento-apenas-para-testes";
  a.env.PLANTARE_EVENTOS_TESTE = { async fetch(url, init) { entregues.add(init.headers["Atos-Evento"]); return new Response(null, { status: 204 }); } };
  for (let i = 0; i < 17; i++) {
    const c = (await a.nova({ intent_id: "int-evento-" + i, cupom: "LIVRE" }, "chave-evento-" + i)).compra;
    await a.browser(c.id, true);
  }
  const o = [...a.objetos.values()][0];
  await o.alarm(); assert.equal(entregues.size, 16);
  await o.alarm(); assert.equal(entregues.size, 17);
});
