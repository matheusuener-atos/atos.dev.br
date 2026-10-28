// Entry point exclusivo do ensaio. Não é importado pelo Worker de produção.
import worker from "../worker/index.js";
import { iguais, sha256 } from "../worker/comum.js";
import { cliente, idDoCliente } from "../worker/cobranca/cliente.js";
import { objetoPlantare } from "../worker/cobranca/plantare/config.js";
import { assinarEvento } from "../worker/cobranca/eventos.js";
export * from "../worker/index.js";
const resposta = (d, status = 200) => Response.json(d, {status, headers:{"cache-control":"no-store"}});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function mp(env, caminho, op = {}) {
  const r = await fetch("https://api.mercadopago.com" + caminho, {...op, redirect:"manual",
    headers:{authorization:"Bearer " + env.MP_ACCESS_TOKEN, "content-type":"application/json", ...op.headers},signal:AbortSignal.timeout(20000)});
  return {status:r.status, ok:r.ok, dados:await r.json().catch(()=>null)};
}
export default {async fetch(req, env, ctx) {
  if (new URL(req.url).pathname !== "/__homologacao") return worker.fetch(req, env, ctx);
  if (env.AMBIENTE !== "teste" || env.PLANTARE_HOMOLOG_ATIVO !== "1") return resposta({erro:"indisponível"},404);
  const segredo = env.PLANTARE_HOMOLOG_TOKEN;
  if (typeof segredo !== "string" || segredo.length < 32 || !iguais(req.headers.get("authorization") || "", "Bearer " + segredo)) return resposta({erro:"não autenticado"},401);
  if (req.method !== "POST" || req.headers.has("origin")) return resposta({erro:"somente servidor"},403);
  const corpo = await req.text(); if (corpo.length > 2048) return resposta({erro:"corpo grande"},413);
  let d; try {d=JSON.parse(corpo)} catch {return resposta({erro:"JSON inválido"},400)}
  if (!d || typeof d !== "object" || Array.isArray(d) || !UUID.test(d.run || "")) return resposta({erro:"run inválido"},400);
  const sub="hmg-"+d.run, email="hmg+"+d.run+"@example.test";
  const pedir = async dados => {
    const r=await objetoPlantare(env).fetch("https://plantare/",{method:"POST",body:JSON.stringify(dados)});
    if(!r.ok) throw new Error("coordenador respondeu "+r.status); return r.json();
  };
  try {
    if(d.op==="diagnostico") {
      const r=await mp(env,"/users/me");
      return resposta({gateway_status:r.status,credencial_prefixo_teste:String(env.MP_ACCESS_TOKEN || "").startsWith("TEST-"),
        vendedor_teste:Array.isArray(r.dados?.tags)&&r.dados.tags.includes("test_user"),
        kv_isolado:env.PLANTARE_HOMOLOG_ISOLADO==="1"});
    }
    if(d.op==="preparar") {
      if(env.PLANTARE_HOMOLOG_ISOLADO!=="1") return resposta({erro:"KV isolado obrigatório"},409);
      const token=crypto.randomUUID()+crypto.randomUUID();
      await env.CONTAS.put("id:conta:"+email,JSON.stringify({sub,nome:"Pessoa de homologação"}));
      await env.CONTAS.put("atos:sessao:"+await sha256(token),JSON.stringify({sub,email,auth_time:Math.floor(Date.now()/1000)}),{expirationTtl:86400});
      const perfil={nome:"Pessoa Homologação",tipo:"pf",documento:"52998224725",email,
        endereco:{cep:"66010000",logradouro:"Rua de Teste",numero:"1",bairro:"Centro",cidade:"Belém",uf:"PA",ibge:"1501402"}};
      await cliente(env,await idDoCliente(sub),{sub,email}).pedir("perfil_salvar",{perfil});
      return resposta({sub,email,sessao:token});
    }
    if (!/^cmp-[a-f0-9-]{36}$/.test(d.id || "")) return resposta({erro:"compra inválida"},400);
    const compra=await pedir({op:"compra",sub,id:d.id});
    if(d.op==="repetir_evento") {
      const e=await pedir({op:"homologacao_evento",run:d.run,id:d.id,versao:d.versao});
      const body=JSON.stringify(e);
      const r=await env.PLANTARE_EVENTOS_TESTE.fetch("https://plantare.test/api/atos/eventos",{method:"POST",
        headers:{"content-type":"application/json","Atos-Evento":e.id,"Atos-Assinatura":await assinarEvento(env.EVENTOS_SEGREDO_PLANTARE,body)},body});
      return resposta({evento:e.id,receptor_status:r.status},r.ok?200:502);
    }
    if(d.op==="fatura") {
      const c=await cliente(env,await idDoCliente(sub),{sub,email}).pedir("listar");
      return resposta({compra,fatura:c.compra?.find(x=>x.ref===d.id) || null});
    }
    const detalhe=await pedir({op:"revisao",id:d.id});
    if(!detalhe.order_id) return resposta({erro:"ordem ainda não registrada"},409);
    const r=await mp(env,"/v1/orders/"+encodeURIComponent(detalhe.order_id));
    if(!r.ok) return resposta({erro:"consulta ao gateway falhou",gateway_status:r.status},502);
    const order=r.dados;
    if(order.external_reference!=="plantare-"+compra.id || Math.round(Number(order.total_amount)*100)!==compra.centavos) return resposta({erro:"ordem divergente"},409);
    if(d.op==="gateway") return resposta({id:order.id,status:order.status,detalhe:order.status_detail,live_mode:order.live_mode ?? null,
      total:order.total_amount,pago:order.total_paid_amount,pagamentos:order.transactions?.payments?.map(p=>({id:p.id,status:p.status,detalhe:p.status_detail,valor:p.amount,pago:p.paid_amount})),
      corpo_erro:order.errors?.map(e=>({code:e.code,message:e.message}))});
    if(d.op==="reembolsar") {
      const vendedor=await mp(env,"/users/me");
      const teste=String(env.MP_ACCESS_TOKEN||"").startsWith("TEST-") || (Array.isArray(vendedor.dados?.tags) && vendedor.dados.tags.includes("test_user"));
      if(!teste || order.live_mode===true || compra.sub!==sub || compra.centavos>50000) return resposta({erro:"reembolso permitido só para fixture de teste de até R$ 500"},409);
      const parcial=d.centavos!==undefined;
      if(parcial && (!Number.isSafeInteger(d.centavos)||d.centavos<1||d.centavos>=compra.centavos)) return resposta({erro:"valor parcial inválido"},400);
      const body=parcial?JSON.stringify({transactions:[{id:order.transactions.payments[0].id,amount:(d.centavos/100).toFixed(2)}]}):"{}";
      const devolucao=await mp(env,"/v1/orders/"+encodeURIComponent(order.id)+"/refund",{method:"POST",body,
        headers:{"X-Idempotency-Key":"hmg-refund-"+order.id+(parcial?"-parcial-"+d.centavos:"-total")}});
      return resposta({gateway_status:devolucao.status,resultado:devolucao.dados},devolucao.ok?200:502);
    }
    return resposta({erro:"operação desconhecida"},404);
  }catch{return resposta({erro:"homologação indisponível; nenhum estado foi forjado"},503)}
}};
