import { ID, SUB } from "./contrato.js";

export const COMPRA = /^cmp-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ESTADOS = ["aguardando", "paga", "concedida", "cancelada", "expirada", "devolvida"];
const data = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(s) && Number.isFinite(Date.parse(s));
export class ErroFaturamento extends Error {
  constructor(mensagem, status = 400) { super(mensagem); this.status = status; }
}

export function conferirLancamento(p) {
  if (!p || typeof p !== "object" || Array.isArray(p) || p.schema !== "plantare-faturamento/v1"
      || typeof p.id !== "string" || !COMPRA.test(p.id) || typeof p.sub !== "string" || !SUB.test(p.sub)
      || typeof p.cliente !== "string" || !/^[a-f0-9]{32}$/.test(p.cliente)
      || typeof p.email !== "string" || p.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)
      || !Number.isSafeInteger(p.versao) || p.versao < 1 || !ESTADOS.includes(p.estado)
      || !Number.isSafeInteger(p.centavos) || p.centavos < 0 || p.centavos > 50000000
      || !Number.isSafeInteger(p.area_cent_ha) || p.area_cent_ha < 1 || p.area_cent_ha > 5000000
      || typeof p.intent_id !== "string" || !ID.test(p.intent_id)
      || typeof p.tarifa_versao !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(p.tarifa_versao)
      || !data(p.criado_em) || (p.pago_em !== null && !data(p.pago_em))
      || (["paga", "concedida", "devolvida"].includes(p.estado) && !p.pago_em)
      || (p.estado === "concedida" && p.centavos !== 0) || (p.estado === "paga" && p.centavos === 0))
    throw new ErroFaturamento("lançamento Plantare inválido");
  // Normalizar ordem e selecionar campos: nunca propagar preço/descrição livre.
  return { schema: p.schema, id: p.id, cliente: p.cliente, sub: p.sub, email: p.email,
    intent_id: p.intent_id, versao: p.versao, estado: p.estado, centavos: p.centavos,
    area_cent_ha: p.area_cent_ha, tarifa_versao: p.tarifa_versao, criado_em: p.criado_em, pago_em: p.pago_em };
}

export function compararLancamento(antes, novo) {
  if (!antes) return "novo";
  const fixos = ["id", "cliente", "sub", "email", "intent_id", "centavos", "area_cent_ha", "tarifa_versao", "criado_em"];
  if (fixos.some((k) => antes[k] !== novo[k]))
    throw new ErroFaturamento("compra diverge do lançamento original", 409);
  if (novo.versao < antes.versao) return "antigo";
  if (antes.pago_em && novo.pago_em !== antes.pago_em) throw new ErroFaturamento("data do pagamento divergente", 409);
  if (novo.versao === antes.versao) {
    if (JSON.stringify(antes) !== JSON.stringify(novo)) throw new ErroFaturamento("mesma versão com conteúdo divergente", 409);
    return "repetido";
  }
  if ((antes.estado === "devolvida" && novo.estado !== "devolvida")
      || (antes.estado === "concedida" && novo.estado !== "concedida")
      || (antes.estado === "paga" && !["paga", "devolvida"].includes(novo.estado)))
    throw new ErroFaturamento("transição financeira regressiva", 409);
  return "novo";
}

export function descricaoPlantare(p) {
  return "Plantare Maps · planejamento de " + (p.area_cent_ha / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ha";
}
