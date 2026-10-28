import {test} from "node:test";
import assert from "node:assert/strict";
import {storage,entrada} from "./apoio.mjs";
import {importarLegado} from "../legado.js";
import {PlantareOrcamentos} from "../objeto.js";
import {sha256} from "../../../comum.js";
const config={versao:"legado-v1",tipo:"percentual",ativo:true,desconto_bps:1000,usos_max:2,so_primeira:false,ilimitado:false};
const manifesto=()=>({schema:"plantare-legado/v1",anterior:null,
  contas:[{sub:"sub-ana",compras_pagas:["CORT-antiga"]},{sub:"sub-bia",compras_pagas:[]}],
  campanhas:[{codigo:"ANTIGO",config:{...config},usos:[{compra_id:"CORT-antiga",sub:"sub-ana",area_hash:"a".repeat(64)}]}]});
function abrir(t){const s=storage();t.after(()=>s.close());return {ctx:{storage:s},env:{AMBIENTE:"teste",PLANTARE_LEGADO_IMPORTAR:"1"}};}
test("legado: produção e falta de flag não escrevem; simulação também não",async t=>{
  const o=abrir(t);
  for (const env of [{AMBIENTE:"producao",PLANTARE_LEGADO_IMPORTAR:"1"},{AMBIENTE:"teste"}])
    await assert.rejects(importarLegado({...o,env},manifesto(),{aplicar:true}),e=>e.codigo==="legado_desabilitado");
  assert.equal((await importarLegado(o,manifesto())).aplicado,false);
  assert.equal(o.ctx.storage.contar(),0);
});
test("legado: repetição concorrente, delta e compras centrais preservadas",async t=>{
  const o=abrir(t),m=manifesto(),s=o.ctx.storage,k="historico:"+await sha256("sub-ana");
  await s.put(k,{conferido:false,compras_pagas:2});
  const resultados=await Promise.all([importarLegado(o,m,{aplicar:true}),importarLegado(o,m,{aplicar:true})]);
  assert.equal(resultados.filter(r=>r.repetido).length,1);
  assert.equal((await s.get(k)).compras_pagas,3);
  const delta=structuredClone(m);delta.anterior=resultados[0].digest;delta.contas[0].compras_pagas.push("PIX-tardio");
  await importarLegado(o,delta,{aplicar:true});
  assert.equal((await s.get(k)).compras_pagas,4);
  await assert.rejects(importarLegado(o,m,{aplicar:true}),e=>e.codigo==="legado_conflitante");
  for(const prefix of ["compra:","evento:","faturamento:","pagamento-pendente:"])
    assert.equal((await s.list({prefix})).size,0);
});
test("legado: atomicidade em falha e conflito de delta, dono ou campanha",async t=>{
  const o=abrir(t),s=o.ctx.storage,m=manifesto();s.falharEm=2;
  await assert.rejects(importarLegado(o,m,{aplicar:true}));assert.equal(s.contar(),0);
  const r=await importarLegado(o,m,{aplicar:true});
  const antes=JSON.stringify([...await s.list()]);
  for (const mudar of [d=>d.contas.pop(),d=>d.contas[0].compras_pagas=[],d=>d.campanhas[0].config.desconto_bps=2000,
    d=>d.campanhas[0].usos[0].sub="sub-bia",d=>d.campanhas=[],d=>d.contas.push(d.contas[0])]) {
    const d=structuredClone(m);d.anterior=r.digest;mudar(d);
    await assert.rejects(importarLegado(o,d,{aplicar:true}));
    assert.equal(JSON.stringify([...await s.list()]),antes);
  }
});
test("legado: consumo importado bloqueia pessoa e talhão; reserva central ocupa capacidade",async t=>{
  const o=abrir(t),m=manifesto();await importarLegado(o,m,{aplicar:true});
  o.env.PLANTARE_CUPONS=JSON.stringify({ANTIGO:config});
  const obj=new PlantareOrcamentos(o.ctx,o.env);
  await assert.rejects(obj.criar(entrada({cupom:"ANTIGO"}),"chave-00001"),e=>e.codigo==="cupom_reservado");
  await assert.rejects(obj.criar(entrada({cupom:"ANTIGO",sub:"sub-bia"}),"chave-00002"),e=>e.codigo==="cupom_reservado");
  await obj.criar(entrada({cupom:"ANTIGO",sub:"sub-bia",area_hash:"b".repeat(64)}),"chave-00003");
  const d=structuredClone(m);d.anterior=(await o.ctx.storage.get("legado:marco")).digest;
  d.contas.push({sub:"sub-caio",compras_pagas:["PIX-caio"]});
  d.campanhas[0].usos.push({compra_id:"PIX-caio",sub:"sub-caio",area_hash:"c".repeat(64)});
  await assert.rejects(importarLegado(o,d,{aplicar:true}),e=>e.codigo==="legado_conflitante");
});
test("legado: histórico pré-conferido sem marco e perda do histórico exigem revisão",async t=>{
  const o=abrir(t),m=manifesto(),s=o.ctx.storage,k="historico:"+await sha256("sub-ana");
  await s.put(k,{conferido:true,compras_pagas:1});
  await assert.rejects(importarLegado(o,m,{aplicar:true}));
  await s.delete(k);const r=await importarLegado(o,m,{aplicar:true});
  await s.delete(k);const d=structuredClone(m);d.anterior=r.digest;
  await assert.rejects(importarLegado(o,d,{aplicar:true}));
});
