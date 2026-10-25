import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ambiente, entrada, PREFIXO } from "./apoio.mjs";

const fetchOriginal = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error("rascunho não deve chamar gateway"); }; });
after(() => { globalThis.fetch = fetchOriginal; });
const abrir = (t, cupons) => {
  const a = ambiente(cupons); a.env.PLANTARE_COMPRAS_ATIVAS = "1";
  t.after(() => a.close()); return a;
};
const dados = (q, extra = {}) => ({ schema: "plantare-checkout/v1", sub: q.sub,
  intent_id: q.intent_id, orcamento_id: q.orcamento_id, ...extra });
const criar = (a, d, options = {}) => a.chamar(PREFIXO + "/checkouts", { ...options, body: d });
const ler = (a, id, sub = "sub-ana") => a.chamar(PREFIXO + "/compras/" + id + "?sub=" + sub);
const listar = (a, query = "sub=sub-ana") => a.chamar(PREFIXO + "/compras?" + query);

test("rascunho vem desligado e usa autenticação S2S, nunca cookies ou Origin", async (t) => {
  const a = abrir(t), q = (await a.post()).data;
  a.env.PLANTARE_COMPRAS_ATIVAS = "0";
  assert.equal((await criar(a, dados(q))).status, 404);
  assert.equal((await listar(a)).status, 404);
  a.env.PLANTARE_COMPRAS_ATIVAS = "1";
  assert.equal((await criar(a, dados(q), { headers: { authorization: null, cookie: "__Host-atos=sessao" } })).status, 401);
  assert.equal((await criar(a, dados(q), { headers: { origin: "https://atos.dev.br" } })).status, 403);
  assert.equal((await listar(a, "sub=sub-ana")).headers.get("access-control-allow-origin"), null);
});

test("compra copia preço e escopo do orçamento e não libera cortesia nem download", async (t) => {
  for (const cupom of [null, "LIVRE"]) {
    const a = abrir(t, { LIVRE: { versao: "v1", tipo: "cortesia" } });
    const q = (await a.post(entrada({ cupom }))).data;
    const r = await criar(a, dados(q));
    assert.equal(r.status, 200);
    assert.equal(r.data.checkout_disponivel, false);
    assert.equal(r.data.checkout_url, null);
    const c = r.data.compra;
    assert.match(c.id, /^cmp-[a-f0-9-]{36}$/);
    for (const campo of ["sub", "intent_id", "orcamento_id", "area_hash", "area_cent_ha", "camadas", "centavos", "moeda", "tarifa_versao", "cupom"])
      assert.deepEqual(c[campo], q[campo], campo);
    assert.equal(c.schema, "plantare-compra/v1");
    assert.equal(c.versao, 1);
    assert.equal(c.estado, "aguardando");
    assert.equal(c.direito_ativo, false);
    assert.equal(c.pago_em, null);
    assert.equal(c.baixar_ate, null);
    assert.equal((await ler(a, c.id)).headers.get("cache-control"), "no-store");
    assert.deepEqual((await ler(a, c.id)).data, c);
    assert.deepEqual((await a.get()).data.compra, c);
    assert.equal("referencia_gateway" in c, false);
    const registro = await [...a.storages.values()][0].get("compra:" + c.id);
    assert.equal(registro.referencia_gateway, "plantare-" + c.id);
    assert.equal(registro.fase, "rascunho");
  }
});

test("preço, direito, identidade e referência não podem ser injetados no pedido", async (t) => {
  const a = abrir(t), q = (await a.post()).data;
  for (const patch of [{ centavos: 1 }, { direito_ativo: true }, { referencia_gateway: "outra" },
    { schema: "outro" }, { sub: "x y" }, { intent_id: "x" }, { orcamento_id: "invalido" }])
    assert.equal((await criar(a, dados(q, patch))).status, 400, JSON.stringify(patch));
  for (const d of [null, [], 12, {}]) assert.equal((await criar(a, d)).status, 400);
  assert.equal((await criar(a, dados(q), { headers: { "idempotency-key": null } })).status, 400);
  assert.equal((await criar(a, " ".repeat(4097))).status, 413);
  assert.equal((await a.chamar(PREFIXO + "/checkouts?centavos=1", { body: dados(q) })).status, 400);
  assert.deepEqual((await listar(a)).data.compras, []);
});

test("orçamento precisa pertencer à intenção e à conta autenticada pelo produto", async (t) => {
  const a = abrir(t), q = (await a.post()).data;
  assert.equal((await criar(a, dados(q, { sub: "sub-beto" }))).status, 404);
  assert.equal((await criar(a, dados(q, { intent_id: "int-inexistente" }))).status, 404);
  assert.equal((await criar(a, dados(q, { orcamento_id: "orc-" + crypto.randomUUID() }))).status, 409);
  const c = (await criar(a, dados(q))).data.compra;
  assert.equal((await ler(a, c.id, "sub-beto")).status, 404);
  assert.deepEqual((await listar(a, "sub=sub-beto")).data.compras, []);
});

test("concorrência, outra chave e reinício recuperam uma única compra", async (t) => {
  const a = abrir(t), q = (await a.post()).data;
  const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => criar(a, dados(q), {
    headers: { "idempotency-key": "checkout-chave-" + i },
  })));
  assert.ok(rs.every((r) => r.status === 200));
  const c = rs[0].data;
  assert.equal(new Set(rs.map((r) => r.data.compra.id)).size, 1);
  a.objetos.clear();
  a.env.PLANTARE_CUPONS = "configuração alterada";
  a.relogio.agora += 900001;
  assert.deepEqual((await criar(a, dados(q))).data, c);
  assert.deepEqual((await a.get()).data.compra, c.compra);
  assert.equal((await a.get()).data.expirado, true);
  assert.equal((await listar(a)).data.compras.length, 1);
});

test("timeout depois do commit não cria outra compra ou referência", async (t) => {
  const a = abrir(t), q = (await a.post()).data;
  a.env.perderResposta = true;
  assert.equal((await criar(a, dados(q))).status, 503);
  const c = (await a.get()).data.compra;
  assert.ok(c.id);
  assert.deepEqual((await criar(a, dados(q))).data.compra, c);
  assert.equal((await listar(a)).data.compras.length, 1);
});

test("cada falha de escrita reverte compra, intenção, idempotência e índice", async (t) => {
  for (let n = 1; n <= 5; n++) {
    const a = abrir(t), q = (await a.post()).data;
    const s = [...a.storages.values()][0], antes = s.contar();
    s.falharEm = n;
    assert.equal((await criar(a, dados(q))).status, 503, "escrita " + n);
    assert.equal(s.contar(), antes);
    assert.equal((await a.get()).data.compra, null);
    assert.deepEqual((await listar(a)).data.compras, []);
    assert.equal((await criar(a, dados(q))).status, 200);
    assert.equal((await listar(a)).data.compras.length, 1);
  }
});

test("uma chave de checkout não pode apontar para outra intenção", async (t) => {
  const a = abrir(t), q1 = (await a.post()).data;
  const q2 = (await a.post(entrada({ intent_id: "int-segundo-0001" }), { headers: { "idempotency-key": "orcamento-chave-2" } })).data;
  assert.equal((await criar(a, dados(q1))).status, 200);
  assert.equal((await criar(a, dados(q2))).status, 409);
  assert.equal((await criar(a, dados(q2), { headers: { "idempotency-key": "checkout-chave-2" } })).status, 200);
  // A chave pode coincidir com a de orçamento; operações têm namespaces próprios.
  assert.equal((await listar(a)).data.compras.length, 2);
});

test("orçamento vencido não inicia compra nem prolonga reserva de cupom", async (t) => {
  const a = abrir(t, { CAMPO10: { versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1 } });
  const q = (await a.post(entrada({ cupom: "CAMPO10" }))).data;
  assert.equal((await criar(a, dados(q))).status, 200);
  const reserva = (await [...a.storages.values()][0].get("cupom:CAMPO10")).reservas;
  assert.equal(reserva[0].expira, q.valido_ate);
  a.relogio.agora += 900000;
  const q2 = (await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "CAMPO10" }))).data;
  a.relogio.agora += 900000;
  assert.equal((await criar(a, dados(q2))).status, 410);
  // Retry do rascunho já persistido apenas recupera o registro; não cobra.
  assert.equal((await criar(a, dados(q))).status, 200);
  assert.equal((await listar(a)).data.compras.length, 1);
});

test("paginação limita leitura por conta e exclui inserções posteriores ao início", async (t) => {
  const a = abrir(t), ids = [];
  async function adicionar(i, sub = "sub-ana") {
    const q = (await a.post(entrada({ intent_id: "int-pagina-" + i, sub }), {
      headers: { "idempotency-key": "orcamento-chave-" + i },
    })).data;
    const r = await criar(a, dados(q), { headers: { "idempotency-key": "checkout-chave-" + i } });
    assert.equal(r.status, 200);
    return r.data.compra.id;
  }
  for (let i = 0; i < 5; i++) ids.push(await adicionar(i));
  await adicionar(8, "sub-beto");
  const primeira = await listar(a, "sub=sub-ana&limite=2");
  assert.equal(primeira.status, 200);
  assert.deepEqual(primeira.data.compras.map((c) => c.id), ids.slice(0, 2));
  await adicionar(9);
  let cursor = primeira.data.proximo_cursor, vistos = [...primeira.data.compras];
  while (cursor) {
    const r = await listar(a, "sub=sub-ana&limite=2&cursor=" + cursor);
    assert.equal(r.status, 200);
    vistos.push(...r.data.compras); cursor = r.data.proximo_cursor;
  }
  assert.deepEqual(vistos.map((c) => c.id), ids);
  assert.equal((await listar(a)).data.compras.length, 6);
  assert.equal((await listar(a, "sub=sub-beto&cursor=" + primeira.data.proximo_cursor)).status, 400);
});

test("consultas rejeitam duplicação, parâmetros extras, cursor e limite inválidos", async (t) => {
  const a = abrir(t);
  for (const query of ["", "sub=sub-ana&sub=sub-beto", "sub=sub-ana&limite=0", "sub=sub-ana&limite=101",
    "sub=sub-ana&limite=1.5", "sub=sub-ana&limite=01", "sub=sub-ana&cursor=", "sub=sub-ana&cursor=inventado",
    "sub=sub-ana&limite=2&limite=3", "sub=sub-ana&preco=1", "sub=x%20y"])
    assert.equal((await listar(a, query)).status, 400, query);
  assert.equal((await ler(a, "invalido")).status, 400);
  assert.equal((await ler(a, "cmp-" + crypto.randomUUID())).status, 404);
});

test("índice e idempotência são separados por conta e ambiente", async (t) => {
  const a = abrir(t);
  const q = (await a.post()).data, c = (await criar(a, dados(q))).data.compra;
  const qB = (await a.post(entrada({ sub: "sub-beto" }))).data;
  const cB = (await criar(a, dados(qB))).data.compra;
  assert.notEqual(c.id, cB.id);
  assert.equal((await listar(a)).data.compras.length, 1);
  const e = { ...a.env, AMBIENTE: "teste" };
  const qt = (await a.post(entrada(), { e })).data;
  const ct = (await criar(a, dados(qt), { e })).data.compra;
  assert.notEqual(ct.id, c.id);
  assert.equal((await ler(a, ct.id)).status, 404);
});
