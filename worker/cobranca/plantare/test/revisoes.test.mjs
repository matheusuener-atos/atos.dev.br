import assert from "node:assert/strict";
import { after, test } from "node:test";
import { abrir } from "./apoio-checkout.mjs";
import { objetoPlantare } from "../config.js";
import { atenderRevisoes } from "../admin.js";
import { sha256 } from "../../../comum.js";
import { entrada } from "./apoio.mjs";
import worker from "../../../index.js";
import { comSeguranca, ligarSegundaEtapa } from "../../../apoio-teste-seguranca.mjs";
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; });
const cupom = { ULTIMO: { versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1 } };

async function iniciar(t, extra = {}) {
  const a = await abrir(t, cupom);
  a.op = async (d) => {
    const r = await objetoPlantare(a.env).fetch("https://plantare/", { method: "POST", body: JSON.stringify(d) });
    return { status: r.status, data: await r.json() };
  };
  a.detalhe = (id) => a.op({ op: "revisao", id });
  a.conferir = async (id, extra = {}) => a.op({ op: "revisao_consultar", id,
    token: (await a.detalhe(id)).data.token, order_id: "ORD1", justificativa: "Conferência manual no gateway de teste", quem: "financeiro@example.test", chave: "conferencia-0001", ...extra });
  const c = (await a.nova({ cupom: "ULTIMO" })).compra;
  a.gateway.perder = true;
  await a.browser(c.id, true);
  a.avancar(900000); await a.browser(c.id);
  a.id = c.id; a.s = [...a.storages.values()][0];
  if (extra.tardio) {
    // Recuperar primeiro a ordem pendente e confirmar sua expiração.
    await a.conferir(c.id);
    Object.assign([...a.gateway.orders.values()][0], { status: "canceled", status_detail: "expired" });
    a.avancar(); await a.browser(c.id);
    a.pagarMP(); a.avancar(); await a.browser(c.id);
  }
  return a;
}

test("lista recupera revisão antiga e detalhe não expõe pagador ou corpo do gateway", async (t) => {
  const a = await iniciar(t), r = await a.op({ op: "revisoes" });
  assert.equal(r.data.itens[0].compra.id, a.id);
  assert.equal(r.data.itens[0].order_id, "");
  assert.equal(JSON.stringify(r.data).includes("52998224725"), false);
  assert.match(r.data.itens[0].referencia, /^plantare-cmp-/);
  assert.equal((await a.op({ op: "revisoes", cursor: "arbitrario" })).status, 400);
});

test("ordem recuperada retoma GET e conserva reserva e referência sem novo POST", async (t) => {
  const a = await iniciar(t), antes = a.gateway.chamadas.length;
  const r = await a.conferir(a.id);
  assert.equal(r.status, 200); assert.equal(r.data.fase, "pix_pendente");
  assert.equal(a.gateway.chamadas.at(-1).method, "GET");
  a.pagarMP(); a.avancar();
  assert.equal((await a.browser(a.id)).data.compra.estado, "paga");
  assert.ok(a.gateway.chamadas.slice(antes).every((x) => x.method === "GET"));
  assert.equal((await a.s.get("cupom:ULTIMO")).consumos.length, 1);
  assert.equal((await a.detalhe(a.id)).data.historico[0].quem, "financeiro@example.test");
});

test("ordem já paga recupera direito e outboxes na mesma transação", async (t) => {
  const a = await iniciar(t); a.pagarMP();
  const r = await a.conferir(a.id);
  assert.equal(r.data.compra.estado, "paga"); assert.equal(r.data.compra.direito_ativo, true);
  assert.equal((await a.s.list({ prefix: "evento-pendente:" })).size, 1);
  assert.equal((await a.s.list({ prefix: "financeiro-pendente:" })).size, 1);
});

test("404, falha de rede e corpo divergente conservam revisão e reserva", async (t) => {
  for (const modo of ["404", "rede", "valor", "referencia", "live", "id", "moeda"]) {
    const a = await iniciar(t);
    if (modo === "404") a.gateway.status = 404;
    else if (modo === "rede") a.gateway.falhar = true;
    else a.gateway.transformar = (o) => {
      if (modo === "valor") o.total_amount = "1.00";
      if (modo === "referencia") o.external_reference = "outra";
      if (modo === "live") o.live_mode = true;
      if (modo === "id") o.id = "OUTRA";
      if (modo === "moeda") o.currency_id = "USD";
      return o;
    };
    assert.ok((await a.conferir(a.id)).status >= 400, modo);
    assert.equal((await a.detalhe(a.id)).data.fase, "revisao", modo);
    assert.equal((await a.s.get("cupom:ULTIMO")).reservas.length, 1);
    assert.equal((await a.detalhe(a.id)).data.historico.length, 0);
  }
});

test("expiração confirmada libera reserva apenas com ordem validada", async (t) => {
  const a = await iniciar(t);
  Object.assign([...a.gateway.orders.values()][0], { status: "canceled", status_detail: "expired" });
  const r = await a.conferir(a.id);
  assert.equal(r.data.compra.estado, "expirada");
  assert.equal((await a.s.get("cupom:ULTIMO")).reservas.length, 0);
});

test("pagamento tardio fica em revisão sem recriar campanha ou conceder direito", async (t) => {
  const a = await iniciar(t, { tardio: true });
  assert.equal((await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "ULTIMO" }))).status, 200);
  const r = await a.conferir(a.id, { chave: "conferencia-tardia" });
  assert.equal(r.data.fase, "revisao"); assert.equal(r.data.compra.direito_ativo, false);
  assert.equal((await a.s.get("cupom:ULTIMO")).reservas.length, 1);
  assert.equal((await a.s.get("cupom:ULTIMO")).consumos.length, 0);
});

test("devolução integral tardia registra compensação sem consumir reserva de outra compra", async (t) => {
  const a = await iniciar(t, { tardio: true });
  await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "ULTIMO" }));
  const order = [...a.gateway.orders.values()][0]; order.status = "refunded"; order.status_detail = "refunded";
  const r = await a.conferir(a.id, { chave: "conferencia-devolvida" });
  assert.equal(r.data.compra.estado, "devolvida"); assert.equal(r.data.compra.direito_ativo, false);
  assert.equal(r.data.fase, "concluida");
  assert.equal((await a.s.get("cupom:ULTIMO")).reservas.length, 1);
  assert.equal((await a.s.get("cupom:ULTIMO")).consumos.length, 0);
  assert.equal((await a.s.get("compensacao:" + a.id)).motivo, "pagamento_tardio_devolvido");
  assert.equal((await a.s.get("historico:" + await sha256("sub-ana"))).compras_pagas, 1);
  assert.ok((await a.s.get("financeiro-pendente:" + a.id)).versao >= 3);
});

test("devolução parcial tardia permanece em revisão", async (t) => {
  const a = await iniciar(t, { tardio: true });
  Object.assign([...a.gateway.orders.values()][0], { status: "refunded", status_detail: "partially_refunded" });
  const r = await a.conferir(a.id, { chave: "parcial-revisao" });
  assert.equal(r.data.fase, "revisao"); assert.equal(r.data.compra.direito_ativo, false);
  assert.equal(await a.s.get("compensacao:" + a.id), undefined);
  const order = [...a.gateway.orders.values()][0];
  order.status_detail = "refunded"; order.transactions.payments[0].status_detail = "partially_refunded";
  assert.equal((await a.conferir(a.id, { chave: "parcial-transacao" })).data.fase, "revisao");
});

test("resposta perdida repete resultado e auditoria sem outra consulta externa", async (t) => {
  const a = await iniciar(t); a.pagarMP();
  const token = (await a.detalhe(a.id)).data.token;
  const r = await a.conferir(a.id, { token }); const n = a.gateway.chamadas.length;
  assert.deepEqual(await a.conferir(a.id, { token }), r);
  assert.equal(a.gateway.chamadas.length, n);
  assert.equal((await a.detalhe(a.id)).data.historico.length, 1);
  assert.equal((await a.conferir(a.id, { token, justificativa: "Outra justificativa de conferência" })).status, 409);
});

test("webhook concorrente invalida ação e impede aplicar resposta antiga", async (t) => {
  const a = await iniciar(t), ordem = [...a.gateway.orders.values()][0];
  let soltar; const espera = new Promise((resolve) => { soltar = resolve; });
  let iniciou; const inicio = new Promise((resolve) => { iniciou = resolve; });
  const buscar = globalThis.fetch;
  globalThis.fetch = async (...args) => { const r = await buscar(...args); iniciou(); await espera; return r; };
  const operacao = a.conferir(a.id); await inicio;
  a.pagarMP();
  assert.equal((await a.op({ op: "order", order: ordem })).status, 200);
  soltar(); assert.equal((await operacao).status, 409);
  assert.equal((await a.detalhe(a.id)).data.compra.estado, "paga");
  assert.equal((await a.detalhe(a.id)).data.historico.length, 0);
});

test("falha de gravação reverte compra, uso, auditoria e permite repetir", async (t) => {
  const a = await iniciar(t); a.pagarMP();
  a.s.falharEm = 4;
  assert.equal((await a.conferir(a.id)).status, 503);
  assert.equal((await a.detalhe(a.id)).data.fase, "revisao");
  assert.equal((await a.s.get("cupom:ULTIMO")).consumos.length, 0);
  assert.equal((await a.detalhe(a.id)).data.historico.length, 0);
  assert.equal((await a.conferir(a.id)).data.compra.estado, "paga");
});

test("API confere papel, área, origem e identidade confiável", async (t) => {
  const a = await iniciar(t);
  async function pedir(papel, areas = ["atos"], origin = "https://atos.dev.br", body = {}) {
    const req = new Request("https://atos.dev.br/api/admin/plantare-pagamentos/" + a.id + "/consultar", {
      method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": "api-conferencia-1" },
      body: JSON.stringify({ token: (await a.detalhe(a.id)).data.token, order_id: "ORD1", justificativa: "Conferência manual pelo painel", quem: "falso@example.test", ...body }) });
    const r = await atenderRevisoes(req, a.env, new URL(req.url), { papel, areas, email: "real@example.test" });
    return { status: r.status, data: await r.json() };
  }
  assert.equal((await pedir("suporte")).status, 403);
  assert.equal((await pedir("financeiro", [])).status, 403);
  assert.equal((await pedir("financeiro", ["atos"], "https://outro.test")).status, 403);
  assert.equal((await pedir("dono")).data.historico[0].quem, "real@example.test");
  a.env.AMBIENTE = "producao";
  assert.equal((await a.detalhe(a.id)).status, 503);
});

test("rota real do painel exige sessão recente, equipe e segunda etapa", async (t) => {
  const a = await iniciar(t), kv = new Map();
  a.env.CONTAS = {
    async get(k, tipo) { const v = kv.get(k); return v === undefined ? null : tipo === "json" ? JSON.parse(v) : v; },
    async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); }
  };
  comSeguranca(a.env);
  const email = "dono@example.test", sub = "sub-dono";
  a.env.ATOS_EQUIPE = JSON.stringify([{ email, papel: "dono" }]);
  kv.set("id:conta:" + email, JSON.stringify({ sub }));
  await ligarSegundaEtapa(a.env, sub);
  const key = "atos:sessao:" + await sha256("sessao-painel");
  async function req(sessao, cookie = "__Host-atos=sessao-painel") {
    if (sessao) kv.set(key, JSON.stringify({ email, sub, ...sessao }));
    return worker.fetch(new Request("https://atos.dev.br/api/admin/plantare-pagamentos", { headers: { cookie } }), a.env, { waitUntil() {} });
  }
  assert.equal((await req(null, "")).status, 401);
  assert.equal((await req({ auth_time: Math.floor(Date.now() / 1000) })).status, 401);
  assert.equal((await req({ auth_time: Math.floor(Date.now() / 1000) - 13 * 3600, mfa: true })).status, 401);
  const ok = await req({ auth_time: Math.floor(Date.now() / 1000), mfa: true });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal((await ok.json()).itens[0].compra.id, a.id);
});

test("varredura paginada encontra revisão depois de 50 compras e mostra auditoria recente", async (t) => {
  const a = await iniciar(t), modelo = await a.s.get("compra:" + a.id);
  for (let n = 0; n < 51; n++) {
    const id = "cmp-00000000-0000-0000-0000-" + String(n).padStart(12, "0");
    await a.s.put("compra:" + id, { ...modelo, fase: n === 50 ? "revisao" : "concluida", snapshot: { ...modelo.snapshot, id } });
  }
  const p1 = await a.op({ op: "revisoes" }); assert.equal(p1.data.itens.length, 0); assert.ok(p1.data.cursor);
  const p2 = await a.op({ op: "revisoes", cursor: p1.data.cursor });
  assert.ok(p2.data.itens.some((d) => d.compra.id.endsWith("000000000050")));
  for (let n = 0; n < 101; n++) await a.s.put("revisao-auditoria:" + a.id + ":" + String(n).padStart(3, "0"), { n });
  const d = await a.detalhe(a.id);
  assert.equal(d.data.historico.length, 100); assert.equal(d.data.historico[0].n, 1); assert.equal(d.data.historico.at(-1).n, 100);
});

test("compensação confirmada é idempotente e não duplica histórico financeiro", async (t) => {
  const a = await iniciar(t, { tardio: true });
  Object.assign([...a.gateway.orders.values()][0], { status: "refunded", status_detail: "refunded" });
  const token = (await a.detalhe(a.id)).data.token;
  const r = await a.conferir(a.id, { token, chave: "compensacao-retry" });
  assert.deepEqual(await a.conferir(a.id, { token, chave: "compensacao-retry" }), r);
  assert.equal((await a.s.get("historico:" + await sha256("sub-ana"))).compras_pagas, 1);
  assert.equal((await a.s.list({ prefix: "compensacao:" })).size, 1);
});

test("ações concorrentes não registram duas conferências ou vinculam outra ordem", async (t) => {
  const a = await iniciar(t), token = (await a.detalhe(a.id)).data.token;
  const rs = await Promise.all([a.conferir(a.id, { token, chave: "concorrente-0001" }), a.conferir(a.id, { token, chave: "concorrente-0002" })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await a.detalhe(a.id)).data.historico.length, 1);
  const r = await a.s.get("compra:" + a.id); r.fase = "revisao"; await a.s.put("compra:" + a.id, r);
  assert.equal((await a.conferir(a.id, { order_id: "ORD2", chave: "ordem-diferente" })).status, 409);
});
