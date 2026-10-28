import { sha256 } from "../../comum.js";
import { SUB, falhar } from "./contrato.js";
import { definirCupom } from "./preco.js";

const erro = () => falhar(409, "legado_conflitante", "snapshot legado inválido ou conflitante; nenhuma alteração aplicada");
const id = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(v);
const lista = (v, chave) => {
  if (!Array.isArray(v) || v.length > 10000) erro();
  const chaves = v.map(chave);
  if (new Set(chaves).size !== chaves.length) erro();
};
export function validarLegado(m) {
  if (new TextEncoder().encode(JSON.stringify(m) || "").length>100000) erro();
  if (!m || m.schema !== "plantare-legado/v1" || ![null, undefined].includes(m.anterior) && !/^[a-f0-9]{64}$/.test(m.anterior)) erro();
  if (Object.keys(m).sort().join() !== "anterior,campanhas,contas,schema") erro();
  lista(m.contas, c => c.sub); lista(m.campanhas, c => c.codigo);
  const pagos = new Map();
  for (const c of m.contas) {
    if (!c || typeof c.sub !== "string" || !SUB.test(c.sub) || Object.keys(c).sort().join() !== "compras_pagas,sub") erro();
    lista(c.compras_pagas, x => x);
    for (const p of c.compras_pagas) { if (!id(p) || pagos.has(p)) erro(); pagos.set(p,c.sub); }
  }
  for (const c of m.campanhas) {
    if (!c || !/^[A-Z0-9_-]{3,32}$/.test(c.codigo) || Object.keys(c).sort().join() !== "codigo,config,usos") erro();
    if (!c.config || typeof c.config.ativo !== "boolean") erro();
    definirCupom({PLANTARE_CUPONS:JSON.stringify({[c.codigo]:{...c.config,ativo:true}})}, c.codigo);
    lista(c.usos, u => u.compra_id);
    for (const u of c.usos) {
      if (!u || Object.keys(u).sort().join() !== "area_hash,compra_id,sub" || pagos.get(u.compra_id) !== u.sub || !/^[a-f0-9]{64}$/.test(u.area_hash)) erro();
    }
    if (c.config.ilimitado && c.usos.length) erro();
  }
  return m;
}

// Função de operador, sem rota HTTP e sem chamadas de pagamento/fatura/evento.
// Ainda bloqueada em produção. O manifesto completo é privado, não um grant.
export async function importarLegado(o, manifesto, { aplicar = false } = {}) {
  if (o.env.AMBIENTE !== "teste" || o.env.PLANTARE_LEGADO_IMPORTAR !== "1")
    falhar(503,"legado_desabilitado","importação disponível apenas no ensaio isolado");
  const m = validarLegado(manifesto), digest = await sha256(JSON.stringify(m));
  return o.ctx.storage.transaction(async tx => {
    const atual = await tx.get("legado:marco");
    if (atual?.digest === digest) return {...atual.resumo,repetido:true};
    if ((atual?.digest || null) !== m.anterior) erro();
    const antes = atual ? await tx.get("legado:snapshot") : {contas:[],campanhas:[]};
    if (!antes) erro();
    for (const a of antes.contas) {
      const c=m.contas.find(x=>x.sub===a.sub);
      if (!c || a.compras_pagas.some(p=>!c.compras_pagas.includes(p))) erro();
    }
    for (const a of antes.campanhas) {
      const c=m.campanhas.find(x=>x.codigo===a.codigo);
      // Alterações de regra exigem outro procedimento; delta aqui só acrescenta usos.
      if (!c || JSON.stringify(c.config)!==JSON.stringify(a.config) || a.usos.some(u=>!c.usos.some(v=>JSON.stringify(v)===JSON.stringify(u)))) erro();
    }
    const escritas=[];
    for (const c of m.contas) {
      const chave="historico:"+await sha256(c.sub), h=await tx.get(chave);
      const anterior=antes.contas.find(x=>x.sub===c.sub), base=anterior?.compras_pagas.length || 0;
      if (anterior && (!h || h.conferido!==true)) erro();
      if (h && (!Number.isSafeInteger(h.compras_pagas) || h.compras_pagas<base || (!atual && h.conferido))) erro();
      // Só o incremento legado: não sobrescreve compras centrais posteriores.
      escritas.push([chave,{...h,conferido:true,compras_pagas:(h?.compras_pagas || 0)+c.compras_pagas.length-base}]);
    }
    for (const c of m.campanhas) {
      const config={...c.config,ativo:true};
      const definicao=await sha256(JSON.stringify(definirCupom({PLANTARE_CUPONS:JSON.stringify({[c.codigo]:config})},c.codigo)));
      const chave="cupom:"+c.codigo, e=await tx.get(chave) || {reservas:[],consumos:[]};
      if (e.versao && (e.versao!==config.versao || e.definicao!==definicao)) erro();
      const consumos=[...e.consumos];
      for (const u of c.usos) {
        const p={...u,compra_id:"legado:"+u.compra_id};
        const anterior=consumos.find(x=>x.compra_id===p.compra_id);
        if (anterior && JSON.stringify(anterior)!==JSON.stringify(p)) erro();
        if (!anterior) {
          if (!config.ilimitado && [...consumos,...e.reservas].some(x=>x.sub===p.sub || x.area_hash===p.area_hash)) erro();
          consumos.push(p);
        }
      }
      // Reservas em andamento também ocupam a capacidade, sem removê-las.
      if (!config.ilimitado && config.usos_max != null && consumos.length+e.reservas.length>config.usos_max) erro();
      escritas.push([chave,{...e,versao:config.versao,definicao,consumos}]);
    }
    const resumo={digest,contas:m.contas.length,campanhas:m.campanhas.length,
      compras_pagas:m.contas.reduce((n,c)=>n+c.compras_pagas.length,0),aplicado:aplicar};
    if (aplicar) {
      for (const [k,v] of escritas) await tx.put(k,v);
      await tx.put("legado:snapshot",m);
      await tx.put("legado:marco",{digest,resumo});
    }
    return resumo;
  });
}
