import assert from "node:assert/strict";
import {after,test} from "node:test";
import {abrir} from "./apoio-checkout.mjs";
const original=globalThis.fetch;after(()=>{globalThis.fetch=original});
test("Pix APRO é explícito no teste e payload permanece congelado no retry",async t=>{
  const a=await abrir(t);a.env.MP_PIX_TESTE_APRO="1";
  const c=(await a.nova()).compra;a.gateway.perder=true;await a.browser(c.id,true);
  assert.equal(JSON.parse(a.gateway.chamadas[0].body).payer.first_name,"APRO");
  a.env.MP_PIX_TESTE_APRO="0";a.avancar(61000);await a.browser(c.id);
  assert.equal(a.gateway.chamadas[1].body,a.gateway.chamadas[0].body);
});
test("sem opção APRO o pagador normal é preservado; produção não inicia checkout",async t=>{
  const a=await abrir(t),c=(await a.nova()).compra;await a.browser(c.id,true);
  assert.equal(JSON.parse(a.gateway.chamadas[0].body).payer.first_name,undefined);
  a.env.AMBIENTE="producao";a.env.MP_PIX_TESTE_APRO="1";
  const n=a.gateway.chamadas.length;assert.equal((await a.browser(c.id,true)).status,404);assert.equal(a.gateway.chamadas.length,n);
});
