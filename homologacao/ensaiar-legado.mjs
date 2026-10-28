// Opera só SQLite local privado. Não acessa Cloudflare, gateway ou produção.
// node homologacao/ensaiar-legado.mjs manifesto.json estado.sqlite [--aplicar]
import {DatabaseSync} from "node:sqlite";
import {readFileSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import {importarLegado} from "../worker/cobranca/plantare/legado.js";
const [entrada,arquivo,modo]=process.argv.slice(2);
if (!entrada || !arquivo || realpathSync(entrada)===resolve(arquivo) || modo && modo!=="--aplicar")
  throw new Error("Informe manifesto privado, SQLite privado distinto e opcional --aplicar");
const db=new DatabaseSync(arquivo);
db.exec("create table if not exists legado_ensaio(chave text primary key,valor text not null)");
const s={
  async get(k){const r=db.prepare("select valor from legado_ensaio where chave=?").get(k);return r?JSON.parse(r.valor):undefined;},
  async put(k,v){db.prepare("insert into legado_ensaio values (?,?) on conflict(chave) do update set valor=excluded.valor").run(k,JSON.stringify(v));},
  async transaction(fn){db.exec("begin immediate");try{const r=await fn(s);db.exec("commit");return r;}catch(e){db.exec("rollback");throw e;}}
};
try {
  const m=JSON.parse(readFileSync(entrada,"utf8"));
  const r=await importarLegado({ctx:{storage:s},env:{AMBIENTE:"teste",PLANTARE_LEGADO_IMPORTAR:"1"}},m,{aplicar:modo==="--aplicar"});
  console.log(JSON.stringify(r));
} finally {db.close();}
