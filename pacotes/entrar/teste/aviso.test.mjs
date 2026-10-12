// O verificarAviso do @atos.dev.br/entrar contra a assinatura que a Atos faz (worker/cobranca/eventos.js, a mesma dos
// avisos ao sistema em worker/avisos.js): certa, errada, de outro segredo, corpo mexido, velha, fora do formato. Sem rede.
//   node --test teste/aviso.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { verificarAviso, ErroAtos } from "../index.js";
import { assinarEvento } from "../../../worker/cobranca/eventos.js";

const SEGREDO = "atos_av_segredo-de-teste";
const corpo = JSON.stringify({ id: "av_1", tipo: "acesso.revogado", criado: "2026-10-12T00:00:00.000Z", app: "u-abcdefghij", dados: { sub: "sub-ana" } });

test("a assinatura da Atos confere e devolve o aviso", async () => {
  const cab = await assinarEvento(SEGREDO, corpo);
  const a = await verificarAviso(corpo, cab, SEGREDO);
  assert.equal(a.tipo, "acesso.revogado");
  assert.equal(a.dados.sub, "sub-ana");
});

test("recusa outro segredo, o corpo mexido e a assinatura trocada", async () => {
  const cab = await assinarEvento(SEGREDO, corpo);
  await assert.rejects(verificarAviso(corpo, cab, "outro"), ErroAtos);
  await assert.rejects(verificarAviso(corpo.replace("sub-ana", "sub-bia"), cab, SEGREDO), (e) => e.codigo === "aviso");
  await assert.rejects(verificarAviso(corpo, cab.replace(/v1=(.)/, (m, c) => "v1=" + (c === "0" ? "1" : "0")), SEGREDO), ErroAtos);
});

test("recusa o aviso de mais de 5 minutos e o cabecalho fora do formato", async () => {
  const velho = Math.floor(Date.now() / 1000) - 400;
  await assert.rejects(verificarAviso(corpo, await assinarEvento(SEGREDO, corpo, velho), SEGREDO), /5 minutos/);
  const futuro = Math.floor(Date.now() / 1000) + 400;
  await assert.rejects(verificarAviso(corpo, await assinarEvento(SEGREDO, corpo, futuro), SEGREDO), /5 minutos/);
  await assert.rejects(verificarAviso(corpo, "", SEGREDO), /formato/);
  await assert.rejects(verificarAviso(corpo, "t=1,v1=xyz", SEGREDO), /formato/);
  await assert.rejects(verificarAviso(JSON.parse(corpo), await assinarEvento(SEGREDO, corpo), SEGREDO), /texto cru/);
  await assert.rejects(verificarAviso(corpo, await assinarEvento(SEGREDO, corpo), ""), /segredo/);
});

test("aceita a idade dentro do relogio dado", async () => {
  const t = 1760000000;
  const cab = await assinarEvento(SEGREDO, corpo, t);
  const a = await verificarAviso(corpo, cab, SEGREDO, { agora: (t + 120) * 1000 });
  assert.equal(a.id, "av_1");
});
