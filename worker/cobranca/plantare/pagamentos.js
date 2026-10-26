import { sha256 } from "../../comum.js";
import { ErroMP, mpFetch } from "../mp.js";
import { consultarCompra } from "./compras.js";
import { checkoutAtivo } from "./config.js";
import { falhar } from "./contrato.js";
import { agendar, guardarCompra } from "./eventos.js";

const LEASE_MS = 30000, CONSULTA_MS = 10000, RETENTATIVA_MS = 60000;
const RECUPERACAO_MS = 15 * 60 * 1000;
const DIAS_DOWNLOAD = 365;
const PENDENTES = ["criando_pix", "pix_pendente"];
const moeda = (c) => (c / 100).toFixed(2);

function exigirAtivo(o) {
  if (!checkoutAtivo(o.env)) falhar(503, "checkout_indisponivel", "checkout Plantare indisponível");
}

async function registro(o, sub, id, tx) {
  await consultarCompra(o, sub, id, tx);
  return (tx || o.ctx.storage).get("compra:" + id);
}

function publico(r) {
  return { compra: r.snapshot, pix: r.snapshot.estado === "aguardando" ? r.pix || null : null,
    processando: r.fase === "criando_pix" || (r.fase === "pix_pendente" && !r.pix), revisao: r.fase === "revisao",
    orcamento_valido_ate: r.orcamento_valido_ate };
}

async function cupom(o, tx, r, acao) {
  const c = r.snapshot.cupom;
  if (!c || c.ilimitado) return;
  const estado = await tx.get("cupom:" + c.codigo);
  const reserva = estado?.reservas.find((x) => x.orcamento_id === r.snapshot.orcamento_id);
  if (acao === "promover") {
    if (!reserva || Date.parse(reserva.expira) <= o.agora())
      falhar(409, "reserva_indisponivel", "a reserva do cupom venceu; crie outra intenção");
    if (c.so_primeira) {
      const hist = await tx.get("historico:" + await sha256(r.snapshot.sub));
      if (!hist?.conferido || !Number.isSafeInteger(hist.compras_pagas) || hist.compras_pagas < 0)
        falhar(503, "historico_indisponivel", "histórico ainda não conferido");
      if (hist.compras_pagas > 0) falhar(409, "cupom_primeira", "cupom válido apenas para a primeira compra");
    }
    reserva.compra_id = r.snapshot.id; // Mantém a reserva mesmo vencendo o orçamento.
  } else if (acao === "consumir") {
    if (!estado) falhar(503, "registro_inconsistente", "registro do cupom indisponível");
    if (!estado.consumos.some((x) => x.compra_id === r.snapshot.id)) {
      if (!reserva || reserva.compra_id !== r.snapshot.id)
        falhar(503, "registro_inconsistente", "reserva da compra indisponível");
      estado.consumos.push({ compra_id: r.snapshot.id, sub: r.snapshot.sub,
        area_hash: r.snapshot.area_hash, orcamento_id: r.snapshot.orcamento_id });
    }
    estado.reservas = estado.reservas.filter((x) => x.orcamento_id !== r.snapshot.orcamento_id);
  } else if (estado) {
    estado.reservas = estado.reservas.filter((x) => x.orcamento_id !== r.snapshot.orcamento_id);
  }
  if (estado) await tx.put("cupom:" + c.codigo, estado);
}

async function conceder(o, tx, r, estado) {
  await cupom(o, tx, r, "consumir");
  const k = "historico:" + await sha256(r.snapshot.sub);
  const hist = await tx.get(k) || { conferido: false, compras_pagas: 0 };
  await tx.put(k, { ...hist, compras_pagas: (hist.compras_pagas || 0) + 1 });
  const agora = o.agora();
  r.snapshot = { ...r.snapshot, versao: r.snapshot.versao + 1, estado,
    pago_em: new Date(agora).toISOString(), baixar_ate: new Date(agora + DIAS_DOWNLOAD * 86400000).toISOString(), direito_ativo: true };
  r.fase = "concluida";
  await encerrarNaConta(tx, r);
}

export async function encerrarNaConta(tx, r) {
  const conta = await sha256(r.snapshot.sub), id = r.snapshot.id;
  const k = "conta-pagamentos:" + conta;
  await tx.put(k, (await tx.get(k) || []).filter((x) => x !== id));
  const primeira = "primeira-pagamento:" + conta;
  if (await tx.get(primeira) === id) await tx.delete(primeira);
}

export async function pagarCompra(o, sub, id, perfil, email) {
  exigirAtivo(o);
  // Armar o alarme antes de persistir trabalho: se a resposta/processo cair,
  // o runtime retoma pelo índice durável. Nenhuma chamada externa em transação.
  await agendar(o);
  const preparado = await o.ctx.storage.transaction(async (tx) => {
    const r = await registro(o, sub, id, tx);
    if (r.fase !== "rascunho") return r;
    if (Date.parse(r.orcamento_valido_ate) <= o.agora()) falhar(410, "orcamento_vencido", "crie outra intenção para obter um orçamento válido");
    if (!perfil || !["pf", "pj"].includes(perfil.tipo) || !/^\d{11}(?:\d{3})?$/.test(perfil.documento || "")
        || typeof email !== "string" || !email.includes("@")) falhar(409, "sem_perfil", "preencha os dados fiscais na sua conta Atos");
    if (r.snapshot.centavos > 0 && !o.env.MP_ACCESS_TOKEN) falhar(503, "mp_desligado", "pagamento indisponível");
    const conta = await sha256(sub), primeira = "primeira-pagamento:" + conta;
    const trava = await tx.get(primeira), pendentes = await tx.get("conta-pagamentos:" + conta) || [];
    if ((trava && trava !== id) || (r.snapshot.cupom?.so_primeira && !r.snapshot.cupom.ilimitado && pendentes.length))
      falhar(409, "primeira_pendente", "conclua o pagamento em andamento antes de usar a primeira compra");
    await cupom(o, tx, r, "promover");
    if (r.snapshot.cupom?.so_primeira && !r.snapshot.cupom.ilimitado) await tx.put(primeira, id);
    await tx.put("conta-pagamentos:" + conta, [...pendentes, id]);
    r.email = email;
    // O pagador e todo o corpo ficam congelados antes do primeiro efeito.
    // Não trocar payload/chave se os dados fiscais mudarem durante um retry.
    if (r.snapshot.centavos === 0) {
      await conceder(o, tx, r, "concedida");
    } else {
      r.fase = "criando_pix";
      r.iniciado_em = o.agora();
      r.corpo_gateway = { type: "online", processing_mode: "automatic", total_amount: moeda(r.snapshot.centavos),
        external_reference: r.referencia_gateway,
        payer: { email: o.env.MP_PAGADOR_TESTE || email, identification: { type: perfil.tipo === "pj" ? "CNPJ" : "CPF", number: perfil.documento } },
        transactions: { payments: [{ amount: moeda(r.snapshot.centavos), payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: "P1D" }] } };
      await tx.put("pagamento-pendente:" + id, id);
    }
    await guardarCompra(o, tx, r);
    return r;
  });
  if (preparado.fase === "criando_pix") await reconciliar(o, sub, id);
  return publico(await registro(o, sub, id));
}

export async function consultarPagamento(o, sub, id) {
  exigirAtivo(o);
  const r = await registro(o, sub, id);
  if (r.mp_id || r.fase === "criando_pix") await reconciliar(o, sub, id);
  return publico(await registro(o, sub, id));
}

async function reconciliar(o, sub, id) {
  const trabalho = await o.ctx.storage.transaction(async (tx) => {
    const r = await registro(o, sub, id, tx), agora = o.agora();
    if (r.fase === "revisao" || r.snapshot.estado === "devolvida" || r.snapshot.estado === "concedida") return null;
    if ((r.lease_ate || 0) > agora || (r.consultar_apos || 0) > agora) return null;
    if (!r.mp_id && r.fase !== "criando_pix") return null;
    // Não pressupor retenção eterna de idempotência no provedor. Depois da
    // janela curta, manter reserva e exigir reconciliação, nunca outro Pix.
    if (!r.mp_id && agora - r.iniciado_em >= RECUPERACAO_MS) {
      r.fase = "revisao";
      await tx.put("compra:" + id, r);
      await tx.delete("pagamento-pendente:" + id);
      return null;
    }
    r.lease = crypto.randomUUID(); r.lease_ate = agora + LEASE_MS;
    await tx.put("compra:" + id, r);
    return r;
  });
  if (!trabalho) return;
  let resposta;
  try {
    resposta = await mpFetch(o.env, trabalho.mp_id ? "GET" : "POST",
      trabalho.mp_id ? "/v1/orders/" + encodeURIComponent(trabalho.mp_id) : "/v1/orders",
      trabalho.mp_id ? undefined : trabalho.corpo_gateway,
      { idempotencia: trabalho.mp_id ? undefined : trabalho.referencia_gateway, buscar: o.buscar });
  } catch (e) {
    if (!(e instanceof ErroMP)) throw e;
  }
  await o.ctx.storage.transaction(async (tx) => {
    const r = await registro(o, sub, id, tx);
    if (r.lease !== trabalho.lease) return; // Resposta de lease antiga não altera estado.
    r.lease_ate = 0;
    r.consultar_apos = o.agora() + (resposta?.ok ? CONSULTA_MS : RETENTATIVA_MS);
    if (resposta?.ok) await aplicar(o, tx, r, resposta.dados);
    // Qualquer falha HTTP/timeout é ambígua. Nunca apagar a chave ou liberar
    // cupom só por erro de rede/400/409; a mesma referência será recuperada.
    await guardarCompra(o, tx, r);
  });
}

export async function receberOrder(o, order) {
  exigirAtivo(o);
  const ref = String(order?.external_reference || "");
  const id = ref.startsWith("plantare-") ? ref.slice("plantare-".length) : "";
  const atual = await o.ctx.storage.get("compra:" + id);
  if (!atual) falhar(404, "compra_nao_encontrada", "compra não encontrada");
  if (atual.fase === "rascunho") falhar(409, "pagamento_nao_iniciado", "pagamento não iniciado na Atos");
  await agendar(o);
  return o.ctx.storage.transaction(async (tx) => {
    const r = await registro(o, atual.snapshot.sub, id, tx);
    // A consulta autenticada ao gateway supera uma resposta ainda em voo.
    r.lease = crypto.randomUUID(); r.lease_ate = 0;
    if (r.snapshot.estado !== "devolvida" && r.snapshot.estado !== "concedida") await aplicar(o, tx, r, order);
    await guardarCompra(o, tx, r);
    return r.snapshot;
  });
}

function centavos(valor) {
  if (typeof valor !== "string" || !/^\d{1,10}\.\d{2}$/.test(valor)) return null;
  const [reais, cent] = valor.split(".");
  return Number(reais) * 100 + Number(cent);
}

export async function aplicar(o, tx, r, order) {
  const pagamento = order?.transactions?.payments?.[0];
  const pm = pagamento?.payment_method;
  if (!order || typeof order.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(order.id)
      || order.external_reference !== r.referencia_gateway || centavos(order.total_amount) !== r.snapshot.centavos
      || order.transactions?.payments?.length !== 1 || centavos(pagamento?.amount) !== r.snapshot.centavos
      || pm?.id !== "pix" || pm?.type !== "bank_transfer" || (r.mp_id && r.mp_id !== order.id)
      || order.live_mode === true || (order.currency_id && order.currency_id !== "BRL")
      || (order.country_code && order.country_code !== "BRA"))
    falhar(503, "gateway_divergente", "resposta do pagamento exige conferência");
  r.mp_id = order.id;
  r.gateway_situacao = { estado: order.status || "", detalhe: order.status_detail || pagamento.status_detail || "" };
  r.fase = r.fase === "criando_pix" ? "pix_pendente" : r.fase;
  r.pix = typeof pm.qr_code === "string" && pm.qr_code.length > 0 && pm.qr_code.length <= 10000 ? { qr_code: pm.qr_code,
    qr_code_base64: typeof pm.qr_code_base64 === "string" && pm.qr_code_base64.length < 1000000
      && /^[A-Za-z0-9+/]*={0,2}$/.test(pm.qr_code_base64) ? pm.qr_code_base64 : "" } : null;
  const detalhe = order.status_detail || pagamento.status_detail;
  const devolvida = ["refunded", "charged_back"].includes(order.status) || detalhe === "partially_refunded";
  const paga = order.status === "processed" && detalhe === "accredited" && pagamento.status === "processed";
  if (paga && (centavos(order.total_paid_amount) !== r.snapshot.centavos || centavos(pagamento.paid_amount) !== r.snapshot.centavos))
    falhar(503, "gateway_divergente", "valor pago exige conferência");
  const cancelada = ["canceled", "cancelled", "failed", "expired"].includes(order.status);
  if (devolvida && r.snapshot.estado !== "devolvida") {
    // Devolução anterior à observação do pagamento também deve consumir uso;
    // não devolvemos limite de campanha nem marcamos a conta como primeira.
    if (!r.snapshot.pago_em && ["cancelada", "expirada"].includes(r.snapshot.estado)) {
      r.fase = "revisao";
      return;
    }
    if (!r.snapshot.pago_em) await conceder(o, tx, r, "paga");
    r.snapshot = { ...r.snapshot, versao: r.snapshot.versao + 1, estado: "devolvida", direito_ativo: false };
    r.fase = "concluida";
  } else if (paga && r.snapshot.estado !== "paga" && r.snapshot.estado !== "devolvida") {
    if (["cancelada", "expirada"].includes(r.snapshot.estado)) {
      // Pagamento contraditório/tardio depois de liberar campanha: revisão,
      // sem recriar reserva ou exceder o limite silenciosamente.
      r.fase = "revisao";
    } else await conceder(o, tx, r, "paga");
  } else if (cancelada && r.snapshot.estado === "aguardando") {
    await cupom(o, tx, r, "liberar");
    await encerrarNaConta(tx, r);
    r.snapshot = { ...r.snapshot, versao: r.snapshot.versao + 1,
      estado: order.status === "expired" || detalhe === "expired" ? "expirada" : "cancelada", direito_ativo: false };
    r.fase = "concluida";
  }
  if (!PENDENTES.includes(r.fase)) await tx.delete("pagamento-pendente:" + r.snapshot.id);
}

export async function retomarPagamentos(o) {
  if (!checkoutAtivo(o.env)) return;
  const prefix = "pagamento-pendente:";
  const cursor = await o.ctx.storage.get("pagamentos-cursor");
  let pendentes = await o.ctx.storage.list({ prefix, ...(cursor ? { startAfter: cursor } : {}), limit: 16 });
  if (!pendentes.size && cursor) pendentes = await o.ctx.storage.list({ prefix, limit: 16 });
  if (!pendentes.size) return;
  // O próximo alarme já existe antes de qualquer chamada de rede ou falha.
  await o.ctx.storage.setAlarm(o.agora() + RETENTATIVA_MS);
  for (const [key, id] of pendentes) {
    const r = await o.ctx.storage.get("compra:" + id);
    if (!r) continue;
    try { await reconciliar(o, r.snapshot.sub, id); }
    catch { /* mantém o índice: a próxima tentativa é recuperável */ }
    await o.ctx.storage.put("pagamentos-cursor", key);
  }
}
