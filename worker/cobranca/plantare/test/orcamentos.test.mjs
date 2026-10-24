import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sha256 } from "../../../comum.js";
import { ambiente, entrada, PREFIXO, TOKEN } from "./apoio.mjs";
import worker from "../../../index.js";

const fetchOriginal = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error("M1 não deve chamar serviços externos"); }; });
after(() => { globalThis.fetch = fetchOriginal; });
const cupom = (extra = {}) => ({ versao: "v1", tipo: "percentual", desconto_bps: 1000, usos_max: 1, ...extra });
const abrir = (t, cupons) => { const a = ambiente(cupons); t.after(() => a.close()); return a; };

test("integração vem fechada e não usa sessão, segredo OIDC ou de evento", async (t) => {
  const a = abrir(t);
  for (const patch of [{ PLANTARE_ORCAMENTOS_ATIVOS: "0" }, { PLANTARE_COBRANCA_TOKEN: "curto" }, { PLANTARE_ORCAMENTOS: null }])
    assert.equal((await a.post(entrada(), { e: { ...a.env, ...patch } })).status, 503);
  for (const authorization of [null, "Bearer outro-segredo", "Basic abc"])
    assert.equal((await a.post(entrada(), { headers: { authorization, cookie: "__Host-atos=sessao" } })).status, 401);
  assert.equal(a.storages.size, 0);
});

test("POST S2S funciona sem Origin e não libera CORS ou a proteção das páginas", async (t) => {
  const a = abrir(t);
  for (const origin of ["https://atos.dev.br", "https://plantaremaps.com.br", "https://golpe.example"])
    assert.equal((await a.post(entrada(), { headers: { origin } })).status, 403);
  const r = await a.post();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.equal((await a.chamar("/api/cobranca/v1/pagar", { body: {}, headers: { origin: "https://plantaremaps.com.br" } })).status, 403);
});

test("limite da integração é separado e aplicado antes do registro", async (t) => {
  const a = abrir(t);
  a.env.PLANTARE_LIMITE = { limit: async () => ({ success: false }) };
  assert.equal((await a.post()).status, 429);
  assert.equal(a.storages.size, 0);
});

test("HTTP só é aceito no desenvolvimento local", async (t) => {
  const a = abrir(t);
  const r = await worker.fetch(new Request("http://atos.dev.br" + PREFIXO + "/orcamentos", {
    method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json", "idempotency-key": "chave-teste-0001" },
    body: JSON.stringify(entrada()),
  }), a.env, {});
  assert.equal(r.status, 400);
  assert.equal((await r.json()).codigo, "https_obrigatorio");
  assert.equal(a.storages.size, 0);
});

test("schema rejeita preço injetado, identidade, área e camadas inválidas", async (t) => {
  const a = abrir(t);
  const patches = [
    { centavos: 1 }, { produto: "pavlvs" }, { schema: "outro" }, { sub: "" }, { sub: "a".repeat(201) },
    { sub: "ana\nadmin" }, { intent_id: "x" }, { area_hash: "x".repeat(64) },
    { area_cent_ha: "9350" }, { area_cent_ha: 1.5 }, { area_cent_ha: 0 }, { area_cent_ha: 5000001 },
    { camadas: [] }, { camadas: ["linhas_ab", "linhas_ab"] }, { camadas: ["inventada"] },
    { cupom: {} }, { cupom: "<script>" },
  ];
  for (const patch of patches) assert.equal((await a.post(entrada(patch))).status, 400, JSON.stringify(patch));
  for (const d of [null, [], 10]) assert.equal((await a.post(d)).status, 400);
  for (const chave of [null, "curta", "chave inválida", "a".repeat(129)])
    assert.equal((await a.post(entrada(), { headers: { "idempotency-key": chave } })).status, 400);
});

test("corpo limitado e JSON válido são exigidos mesmo sem Content-Length", async (t) => {
  const a = abrir(t);
  assert.equal((await a.post("{" )).status, 400);
  assert.equal((await a.post(" ".repeat(4097) + "{}" )).status, 413);
  assert.equal((await a.post(entrada(), { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal(a.storages.size, 0);
});

test("orçamento retorna snapshot de 15 minutos, memória e centavos", async (t) => {
  const a = abrir(t);
  const r = await a.post();
  assert.equal(r.status, 200);
  assert.equal(r.data.centavos, 93500);
  assert.equal(r.data.produto, "plantare");
  assert.match(r.data.orcamento_id, /^orc-[a-f0-9-]{36}$/);
  assert.equal(Date.parse(r.data.valido_ate) - Date.parse(r.data.criado_em), 900000);
  assert.equal(r.data.calculo.partes.length, 1);
  const q = await a.get();
  assert.equal(q.status, 200);
  assert.deepEqual(q.data.orcamento, r.data);
  assert.equal(q.data.expirado, false);
  assert.equal(q.data.compra, null);
});

test("retry concorrente e mudança de ordem dos campos/camadas não duplicam orçamento", async (t) => {
  const a = abrir(t);
  const rs = await Promise.all(Array.from({ length: 12 }, () => a.post()));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.data.orcamento_id)).size, 1);
  assert.equal([...a.storages.values()][0].contar(), 2);
  const r = await a.post(entrada({ camadas: [...entrada().camadas].reverse(), area_hash: "A".repeat(64) }));
  assert.deepEqual(r.data, rs[0].data);
});

test("chave ou intenção reaproveitada com parâmetros alterados retorna conflito", async (t) => {
  const a = abrir(t);
  assert.equal((await a.post()).status, 200);
  for (const patch of [{ intent_id: "int-outro-0001" }, { area_cent_ha: 9000 }, { area_hash: "b".repeat(64) }, { camadas: ["linhas_ab"] }])
    assert.equal((await a.post(entrada(patch))).status, 409);
  assert.equal((await a.post(entrada({ area_cent_ha: 9000 }), { headers: { "idempotency-key": "outra-chave-0001" } })).status, 409);
  assert.equal((await a.post(entrada(), { headers: { "idempotency-key": "outra-chave-0001" } })).status, 200);
});

test("idempotência e recuperação são isoladas por sub e ambiente", async (t) => {
  const a = abrir(t);
  const ana = await a.post();
  assert.equal((await a.get("sub-beto")).status, 404);
  const beto = await a.post(entrada({ sub: "sub-beto" }));
  assert.equal(beto.status, 200);
  assert.notEqual(ana.data.orcamento_id, beto.data.orcamento_id);
  const teste = await a.post(entrada(), { e: { ...a.env, AMBIENTE: "teste" } });
  assert.equal(teste.status, 200);
  assert.equal(a.storages.size, 2);
  assert.notEqual(ana.data.orcamento_id, teste.data.orcamento_id);
});

test("consulta recusa sub duplicado, parâmetros extras e intenção inválida", async (t) => {
  const a = abrir(t);
  for (const query of ["", "?sub=sub-ana&sub=sub-beto", "?sub=sub-ana&centavos=1", "?sub=x%20y"])
    assert.equal((await a.chamar(PREFIXO + "/intencoes/int-teste-0001" + query)).status, 400);
  assert.equal((await a.get("sub-ana", "../outra")).status, 404);
});

test("timeout após commit é recuperado sem novo ID, reserva ou orçamento", async (t) => {
  const a = abrir(t, { CAMPO10: cupom() });
  a.env.perderResposta = true;
  const d = entrada({ cupom: "campo10" });
  assert.equal((await a.post(d)).status, 503);
  const q = await a.get();
  assert.equal(q.status, 200);
  const novamente = await a.post(d);
  assert.deepEqual(novamente.data, q.data.orcamento);
  const s = [...a.storages.values()][0];
  assert.equal((await s.get("cupom:CAMPO10")).reservas.length, 1);
  a.objetos.clear();
  assert.equal((await a.get()).data.orcamento.orcamento_id, q.data.orcamento.orcamento_id);
});

test("orçamento vencido continua consultável e não se renova por retry", async (t) => {
  const a = abrir(t);
  const r = await a.post();
  a.relogio.agora += 900000;
  assert.equal((await a.post()).status, 410);
  assert.equal((await a.post(entrada(), { headers: { "idempotency-key": "nova-chave-0001" } })).status, 410);
  const q = await a.get();
  assert.equal(q.data.expirado, true);
  assert.deepEqual(q.data.orcamento, r.data);
});

test("mudança de catálogo não reprecifica snapshot existente", async (t) => {
  const a = abrir(t, { CAMPO10: cupom() });
  const d = entrada({ cupom: "CAMPO10" });
  const r = await a.post(d);
  a.env.PLANTARE_CUPONS = "configuração quebrada";
  assert.deepEqual((await a.post(d)).data, r.data);
  assert.deepEqual((await a.get()).data.orcamento, r.data);
});

test("cupom global com um último uso aceita só uma conta concorrente", async (t) => {
  const a = abrir(t, { CAMPO10: cupom() });
  const rs = await Promise.all([
    a.post(entrada({ cupom: "CAMPO10" })),
    a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "CAMPO10" })),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await [...a.storages.values()][0].get("cupom:CAMPO10")).reservas.length, 1);
});

test("cupom reservado para pessoa ou talhão não pode ser reservado novamente", async (t) => {
  const a = abrir(t, { CAMPO10: cupom({ usos_max: 5 }) });
  assert.equal((await a.post(entrada({ cupom: "CAMPO10" }))).status, 200);
  const options = { headers: { "idempotency-key": "nova-chave-0001" } };
  assert.equal((await a.post(entrada({ intent_id: "int-outro-0001", area_hash: "b".repeat(64), cupom: "CAMPO10" }), options)).status, 409);
  assert.equal((await a.post(entrada({ sub: "sub-beto", cupom: "CAMPO10" }), options)).status, 409);
});

test("reserva expira, mas histórico do orçamento e idempotência permanecem", async (t) => {
  const a = abrir(t, { CAMPO10: cupom() });
  const r = await a.post(entrada({ cupom: "CAMPO10" }));
  a.relogio.agora += 900001;
  assert.equal((await a.post(entrada({ cupom: "CAMPO10" }))).status, 410);
  const beto = await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "CAMPO10" }));
  assert.equal(beto.status, 200);
  assert.deepEqual((await a.get()).data.orcamento, r.data);
});

test("falha de escrita reverte reserva, intenção e chave na mesma transação", async (t) => {
  const a = abrir(t, { CAMPO10: cupom() });
  const s = a.env.PLANTARE_ORCAMENTOS.get("producao:plantare:orcamentos:v1");
  assert.ok(s);
  const store = [...a.storages.values()][0];
  store.falharEm = 3; // depois de gravar a reserva e a intenção
  assert.equal((await a.post(entrada({ cupom: "CAMPO10" }))).status, 503);
  assert.equal(store.contar(), 0);
  assert.equal((await a.get()).status, 404);
  assert.equal((await a.post(entrada({ cupom: "CAMPO10" }))).status, 200);
});

test("cupons de percentual, fixo e cortesia guardam memória do valor", async (t) => {
  for (const [def, esperado] of [
    [cupom(), 84150],
    [{ versao: "v1", tipo: "fixo", centavos: 200 }, 200],
    [{ versao: "v1", tipo: "fixo", centavos: 999999 }, 93500],
    [{ versao: "v1", tipo: "cortesia" }, 0],
  ]) {
    const a = abrir(t, { CAMPO10: def });
    const r = await a.post(entrada({ cupom: "CAMPO10" }));
    assert.equal(r.status, 200);
    assert.equal(r.data.centavos, esperado);
    assert.equal(r.data.calculo.desconto_centavos, 93500 - esperado);
    assert.equal(r.data.cupom.versao, "v1");
  }
});

test("cupom inválido, vencido, de área mínima ou configuração quebrada não grava", async (t) => {
  const casos = [
    [{}, 400],
    [{ CAMPO10: cupom({ ativo: false }) }, 400],
    [{ CAMPO10: cupom({ valido_ate: "2026-01-01T00:00:00Z" }) }, 400],
    [{ CAMPO10: cupom({ area_min_cent_ha: 50000 }) }, 400],
    [{ CAMPO10: cupom({ desconto_bps: 9001 }) }, 503],
    [{ CAMPO10: cupom({ usos_max: 0 }) }, 503],
    [{ CAMPO10: cupom({ gratis: true }) }, 503],
  ];
  for (const [config, status] of casos) {
    const a = abrir(t, config);
    assert.equal((await a.post(entrada({ cupom: "CAMPO10" }))).status, status);
    assert.equal([...a.storages.values()][0].contar(), 0);
  }
});

test("primeira compra exige histórico conferido e não confunde ausência com zero", async (t) => {
  const a = abrir(t, { CAMPO10: cupom({ so_primeira: true }) });
  const d = entrada({ cupom: "CAMPO10" });
  assert.equal((await a.post(d)).data.codigo, "historico_indisponivel");
  const s = [...a.storages.values()][0], k = "historico:" + await sha256(d.sub);
  await s.put(k, { conferido: true, compras_pagas: 2 });
  assert.equal((await a.post(d)).data.codigo, "cupom_primeira");
  await s.put(k, { conferido: true, compras_pagas: 0 });
  assert.equal((await a.post(d)).status, 200);
});

test("consumo legado importado impede novo uso e conta para o limite", async (t) => {
  const a = abrir(t, { CAMPO10: cupom() });
  a.env.PLANTARE_ORCAMENTOS.get("producao:plantare:orcamentos:v1");
  const s = [...a.storages.values()][0];
  await s.put("cupom:CAMPO10", { reservas: [], consumos: [{ sub: "sub-anterior", area_hash: "c".repeat(64) }] });
  assert.equal((await a.post(entrada({ cupom: "CAMPO10" }))).data.codigo, "cupom_esgotado");
});

test("ilimitado conserva exceção do legado, mas não ignora validade e versão", async (t) => {
  const a = abrir(t, { CAMPO10: cupom({ ilimitado: true, so_primeira: true }) });
  const d = entrada({ cupom: "CAMPO10" });
  assert.equal((await a.post(d)).status, 200);
  const segundo = entrada({ ...d, intent_id: "int-outro-0001" });
  assert.equal((await a.post(segundo, { headers: { "idempotency-key": "chave-outra-0001" } })).status, 200);
  a.env.PLANTARE_CUPONS = JSON.stringify({ CAMPO10: cupom({ ilimitado: true, so_primeira: true, desconto_bps: 2000 }) });
  const terceiro = entrada({ ...d, intent_id: "int-outro-0002" });
  assert.equal((await a.post(terceiro, { headers: { "idempotency-key": "chave-outra-0002" } })).data.codigo, "cupom_versao");
});

test("mudança de versão do cupom não apaga reservas existentes", async (t) => {
  const a = abrir(t, { CAMPO10: cupom() });
  assert.equal((await a.post(entrada({ cupom: "CAMPO10" }))).status, 200);
  a.env.PLANTARE_CUPONS = JSON.stringify({ CAMPO10: cupom({ versao: "v2", desconto_bps: 2000 }) });
  assert.equal((await a.post(entrada({ sub: "sub-beto", area_hash: "b".repeat(64), cupom: "CAMPO10" }))).data.codigo, "cupom_esgotado");
});

test("saturação operacional não é confundida com cupom sem usos e não grava intenção", async (t) => {
  const a = abrir(t, { CAMPO10: cupom({ usos_max: null }) });
  a.env.PLANTARE_ORCAMENTOS.get("producao:plantare:orcamentos:v1");
  const s = [...a.storages.values()][0];
  const reservas = Array.from({ length: 128 }, (_, i) => ({ sub: "sub-" + i,
    area_hash: String(i).padStart(64, "0"), expira: new Date(a.relogio.agora + 900000).toISOString() }));
  await s.put("cupom:CAMPO10", { reservas, consumos: [] });
  const r = await a.post(entrada({ cupom: "CAMPO10" }));
  assert.equal(r.status, 503);
  assert.equal(r.data.codigo, "reservas_ocupadas");
  assert.equal(s.contar(), 1);
  assert.equal((await a.get()).status, 404);
});

test("valor mínimo do Pix não é arredondado para cima; cortesia continua zero", async (t) => {
  const a = abrir(t, { CAMPO10: { versao: "v1", tipo: "cortesia" } });
  assert.equal((await a.post(entrada({ area_cent_ha: 1 }))).data.codigo, "abaixo_minimo");
  assert.equal((await a.post(entrada({ area_cent_ha: 1, cupom: "CAMPO10" }))).data.centavos, 0);
});

test("operações de checkout e compra não são implementadas por M1", async (t) => {
  const a = abrir(t);
  for (const route of ["/checkouts", "/compras", "/qualquer"])
    assert.equal((await a.chamar(PREFIXO + route, { body: {} })).status, 404);
  assert.equal(a.storages.size, 0);
  assert.equal(TOKEN.length >= 32, true);
});
