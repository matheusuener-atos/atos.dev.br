import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMADAS } from "../contrato.js";
import { calcularPreco, TAXAS, TARIFA_VERSAO } from "../preco.js";
import { calcularPreco as legado } from "./fixtures/preco-legado.js";

test("tarifa preserva exemplos publicados e fixa a versão e os centavos", () => {
  for (const [area, esperado] of [[9350, 93500], [57500, 520000], [120000, 940000]]) {
    const r = calcularPreco({ area_cent_ha: area, camadas: CAMADAS });
    assert.equal(r.centavos, esperado);
    assert.equal(r.tarifa_versao, TARIFA_VERSAO);
    assert.equal(r.moeda, "BRL");
    assert.equal(r.calculo.partes.reduce((s, p) => s + p.centavos, 0), r.calculo.subtotal_centavos);
  }
  assert.equal(calcularPreco({ area_cent_ha: 1870, camadas: ["linhas_ab"] }).centavos, 11220);
  assert.ok(Object.isFrozen(TAXAS));
});

test("paridade com o Plantare em camadas, limites, centavos e cupons", () => {
  const areas = new Set([1, 15, 50, 85, 211, 1870, 9350, 57500, 120000, 5000000]);
  for (const limite of [30000, 60000, 100000]) for (let d = -100; d <= 100; d++) areas.add(limite + d);
  // Distribuição determinística além dos limites, sem depender de aleatoriedade.
  for (let i = 1; i <= 300; i++) areas.add((i * 7919) % 5000000 + 1);
  const cupons = [
    [null, undefined],
    ...[100, 500, 1000, 3333, 5000, 9000].map((bps) => [{ tipo: "percentual", desconto_bps: bps }, bps / 10000]),
    [{ tipo: "fixo", centavos: 200 }, { fixo: 2 }],
    [{ tipo: "fixo", centavos: 500000 }, { fixo: 5000 }],
    [{ tipo: "cortesia" }, { gratis: true }],
  ];
  let comparacoes = 0;
  for (let mask = 1; mask < 16; mask++) {
    const camadas = CAMADAS.filter((_, i) => mask & (1 << i));
    for (const area of areas) for (const [cupom, anterior] of cupons) {
      const r = calcularPreco({ area_cent_ha: area, camadas }, cupom);
      const esperado = Math.round(legado(area / 100, camadas, anterior).total * 100);
      assert.equal(r.centavos, esperado, JSON.stringify({ area, camadas, cupom }));
      assert.ok(Number.isSafeInteger(r.centavos));
      comparacoes++;
    }
  }
  assert.ok(comparacoes > 100000);
});

test("meio-centavo conserva o comportamento JS legado, sem mudar o preço em silêncio", () => {
  assert.equal(calcularPreco({ area_cent_ha: 60025, camadas: ["linhas_ab", "bordadura"] }).centavos, 378122);
  assert.equal(calcularPreco({ area_cent_ha: 211, camadas: ["linhas_ab", "bordadura", "percurso"] },
    { tipo: "percentual", desconto_bps: 5000 }).centavos, 949);
});
