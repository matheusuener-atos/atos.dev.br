import { sha256 } from "../../comum.js";
import { mpFetch, ErroMP } from "../mp.js";
import { CHAVE, falhar } from "./contrato.js";
import { COMPRA } from "./faturamento-contrato.js";
import { agendar, checkoutAtivo } from "./config.js";
import { guardarCompra } from "./eventos.js";
import { aplicar, encerrarNaConta } from "./pagamentos.js";

const ORDER = /^[A-Za-z0-9_-]{1,100}$/;
const token = (r) => sha256(JSON.stringify([r.snapshot.versao, r.fase, r.mp_id || null,
  r.lease || null, r.gateway_situacao || null]));
function exigir(o) {
  if (!checkoutAtivo(o.env)) falhar(503, "checkout_indisponivel", "revisões Plantare disponíveis apenas no checkout de teste");
}
async function ler(o, id, tx = o.ctx.storage) {
  if (typeof id !== "string" || !COMPRA.test(id)) falhar(400, "entrada_invalida", "compra inválida");
  const r = await tx.get("compra:" + id);
  if (!r) falhar(404, "compra_nao_encontrada", "compra não encontrada");
  return r;
}
async function publico(r, historico = []) {
  const tardio = ["cancelada", "expirada"].includes(r.snapshot.estado);
  return { compra: r.snapshot, email: r.email || null, fase: r.fase,
    referencia: r.referencia_gateway, order_id: r.mp_id || "", token: await token(r),
    gateway: r.gateway_situacao || null,
    orientacao: r.fase !== "revisao" ? (r.snapshot.estado === "devolvida"
      ? "Devolução confirmada. O acesso permanece bloqueado; a conferência está registrada no histórico."
      : "Ordem recuperada. O acompanhamento automático usa a mesma referência de pagamento.")
      : tardio ? "Pagamento contraditório: conferir e devolver pelo provedor; consultar novamente após a devolução integral. O acesso permanece bloqueado."
      : "Localizar a ordem no provedor pela referência e consultar seu ID. Ausência ou erro não libera a reserva.",
    historico };
}
export async function listarRevisoes(o, cursor) {
  exigir(o);
  if (cursor && !COMPRA.test(cursor)) falhar(400, "entrada_invalida", "cursor inválido");
  // Varredura limitada recupera inclusive revisões anteriores a esta entrega.
  const linhas = await o.ctx.storage.list({ prefix: "compra:", limit: 50,
    ...(cursor ? { startAfter: "compra:" + cursor } : {}) });
  const itens = [];
  for (const r of linhas.values()) if (r.fase === "revisao") itens.push(await publico(r));
  return { itens, cursor: linhas.size === 50 ? [...linhas.values()].at(-1).snapshot.id : null };
}
export async function detalheRevisao(o, id) {
  exigir(o);
  const r = await ler(o, id);
  const h = await o.ctx.storage.list({ prefix: "revisao-auditoria:" + id + ":", limit: 100, reverse: true });
  return publico(r, [...h.values()].reverse());
}
export async function consultarRevisao(o, d) {
  exigir(o);
  if (typeof d.quem !== "string" || !d.quem.includes("@") || d.quem.length > 254
      || typeof d.justificativa !== "string" || d.justificativa.trim().length < 10 || d.justificativa.length > 1000
      || typeof d.chave !== "string" || !CHAVE.test(d.chave) || typeof d.token !== "string" || !/^[a-f0-9]{64}$/.test(d.token)
      || typeof d.order_id !== "string" || !ORDER.test(d.order_id))
    falhar(400, "entrada_invalida", "informe ID da ordem, justificativa e chave de repetição válidos");
  const original = await ler(o, d.id);
  const payload = { token: d.token, order_id: d.order_id, justificativa: d.justificativa.trim(), quem: d.quem };
  const digest = await sha256(JSON.stringify(payload));
  const chave = "revisao-acao:" + d.id + ":" + await sha256(d.chave);
  function repetido(a) {
    if (a.digest !== digest) falhar(409, "idempotencia_conflitante", "chave já usada com outra conferência");
    return a.resposta;
  }
  const anterior = await o.ctx.storage.get(chave);
  if (anterior) return repetido(anterior);
  if (original.fase !== "revisao" || await token(original) !== d.token)
    falhar(409, "revisao_alterada", "a compra mudou; atualize antes de conferir");
  if (original.mp_id && original.mp_id !== d.order_id)
    falhar(409, "ordem_divergente", "a compra já está vinculada a outra ordem");
  let resposta;
  try { resposta = await mpFetch(o.env, "GET", "/v1/orders/" + encodeURIComponent(d.order_id), undefined, { buscar: o.buscar }); }
  catch (e) { if (!(e instanceof ErroMP)) throw e; }
  if (!resposta?.ok) falhar(502, "gateway_indisponivel", "ordem não confirmada pelo gateway; a revisão e a reserva foram preservadas");
  if (resposta.dados?.id !== d.order_id) falhar(503, "gateway_divergente", "ID retornado pelo gateway diverge da consulta");
  await agendar(o);
  return o.ctx.storage.transaction(async (tx) => {
    const feito = await tx.get(chave);
    if (feito) return repetido(feito);
    const r = await ler(o, d.id, tx);
    if (r.fase !== "revisao" || await token(r) !== d.token)
      falhar(409, "revisao_alterada", "a compra mudou durante a consulta; atualize");
    // Aplicar valida valor, referência, moeda, Pix, ambiente e ordem vinculada.
    await aplicar(o, tx, r, resposta.dados);
    const tardio = ["cancelada", "expirada"].includes(r.snapshot.estado);
    const devolucaoIntegral = ["refunded", "charged_back"].includes(resposta.dados.status)
      && resposta.dados.status_detail !== "partially_refunded"
      && resposta.dados.transactions.payments[0].status_detail !== "partially_refunded";
    if (tardio && devolucaoIntegral) {
      // A campanha já foi liberada. Não recriar reserva nem conceder acesso.
      // Registrar a ocorrência compensada separadamente do limite promocional.
      const histKey = "historico:" + await sha256(r.snapshot.sub);
      const hist = await tx.get(histKey) || { conferido: false, compras_pagas: 0 };
      await tx.put(histKey, { ...hist, compras_pagas: (hist.compras_pagas || 0) + 1 });
      await tx.put("compensacao:" + r.snapshot.id, { compra_id: r.snapshot.id, cupom: r.snapshot.cupom?.codigo || null,
        motivo: "pagamento_tardio_devolvido", quem: d.quem, quando: new Date(o.agora()).toISOString() });
      r.snapshot = { ...r.snapshot, versao: r.snapshot.versao + 1, estado: "devolvida",
        pago_em: new Date(o.agora()).toISOString(), direito_ativo: false };
      r.fase = "concluida";
      await encerrarNaConta(tx, r);
    } else if (!tardio && r.fase === "revisao" && r.snapshot.estado === "aguardando") {
      // Uma ordem pendente foi recuperada: retomar só GET, jamais novo POST.
      if (resposta.dados.status === "action_required" && r.gateway_situacao.detalhe === "waiting_transfer") {
        r.fase = "pix_pendente";
        r.consultar_apos = o.agora() + 10000;
        await tx.put("pagamento-pendente:" + r.snapshot.id, r.snapshot.id);
      }
    }
    r.lease = crypto.randomUUID(); r.lease_ate = 0;
    const audit = { id: crypto.randomUUID(), quando: new Date(o.agora()).toISOString(), quem: d.quem,
      justificativa: payload.justificativa, order_id: d.order_id, gateway: r.gateway_situacao,
      resultado: r.fase === "revisao" ? "mantida_em_revisao" : "recuperada", versao: r.snapshot.versao };
    await guardarCompra(o, tx, r);
    const resultado = await publico(r, [audit]);
    await tx.put("revisao-auditoria:" + d.id + ":" + audit.quando + ":" + audit.id, audit);
    await tx.put(chave, { digest, resposta: resultado });
    return resultado;
  });
}
