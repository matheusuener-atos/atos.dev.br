import assert from "node:assert/strict";
import {test} from "node:test";
import ensaio from "../homologacao/worker.js";
import {PlantareOrcamentos} from "./cobranca/plantare/objeto.js";
import "../homologacao/validar-config.mjs";
const segredo="token-ficticio-longo-exclusivo-do-teste-12345";
const run=crypto.randomUUID();
test("controlador de homologação exige ambiente, flag, token e chamada de servidor",async()=>{
  const req=(headers={})=>new Request("https://atos-teste.exemplo.workers.dev/__homologacao",{method:"POST",headers:{authorization:"Bearer "+segredo,...headers},body:JSON.stringify({run,op:"preparar"})});
  assert.equal((await ensaio.fetch(req(),{AMBIENTE:"producao",PLANTARE_HOMOLOG_ATIVO:"1"})).status,404);
  assert.equal((await ensaio.fetch(req(),{AMBIENTE:"teste"})).status,404);
  const env={AMBIENTE:"teste",PLANTARE_HOMOLOG_ATIVO:"1",PLANTARE_HOMOLOG_TOKEN:segredo};
  assert.equal((await ensaio.fetch(req({authorization:"Bearer errado"}),env)).status,401);
  assert.equal((await ensaio.fetch(req({origin:"https://outro.test"}),env)).status,403);
  assert.equal((await ensaio.fetch(req(),env)).status,409);
});
test("replay interno é exclusivo da fixture e não existe em produção",async()=>{
  const id="cmp-"+crypto.randomUUID(),evento={id:"plantare:"+id+":v2"};
  const storage={async get(k){return k==="compra:"+id?{snapshot:{id,sub:"hmg-"+run}}:k==="evento:plantare:"+id+":v2"?{evento}:null}};
  const req=(r=run)=>new Request("https://objeto/",{method:"POST",body:JSON.stringify({op:"homologacao_evento",id,run:r,versao:2})});
  const prod=new PlantareOrcamentos({storage},{AMBIENTE:"producao",PLANTARE_HOMOLOG_ATIVO:"1"});
  assert.equal((await prod.fetch(req())).status,404);
  const teste=new PlantareOrcamentos({storage},{AMBIENTE:"teste",PLANTARE_HOMOLOG_ATIVO:"1"});
  assert.deepEqual(await (await teste.fetch(req())).json(),evento);
  assert.equal((await teste.fetch(req(crypto.randomUUID()))).status,404);
});
