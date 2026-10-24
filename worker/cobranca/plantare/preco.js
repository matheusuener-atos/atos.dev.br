import { falhar } from "./contrato.js";

// v1 conserva inclusive os meios-centavos do JS do Plantare (c18adbd).
// Trocar Math.round por decimal exato muda preços: exige outra versão.
export const TARIFA_VERSAO = "plantare-legado-js-2026-10-v1";
export const TAXAS = Object.freeze({ linhas_ab: 500, bordadura: 200, percurso: 200, manobras: 100 });
const FAIXAS = Object.freeze([[300, 0], [600, 2000], [1000, 3000], [50000, 4000]].map(Object.freeze));
const r2 = (v) => Math.round(v * 100) / 100;
const centavos = (v) => Math.round(v * 100);

export function calcularPreco(d, cupom = null) {
  const ha = d.area_cent_ha / 100;
  const soma = d.camadas.reduce((s, c) => s + TAXAS[c], 0), taxa = Math.max(600, soma);
  const partes = [];
  let inicio = 0, total = 0;
  for (const [limite, bps] of FAIXAS) {
    const fim = Math.min(ha, limite), quantidade = r2(fim - inicio);
    if (quantidade > 0) {
      const valor = r2(quantidade * (taxa / 100) * (1 - bps / 10000));
      partes.push({ de_cent_ha: centavos(inicio), ate_cent_ha: centavos(fim),
        area_cent_ha: centavos(quantidade), desconto_bps: bps, centavos: centavos(valor) });
      total += valor;
    }
    inicio = limite;
    if (ha <= limite) break;
  }
  total = r2(total);
  const subtotal = centavos(total);
  if (cupom?.tipo === "percentual") total = r2(total * (1 - cupom.desconto_bps / 10000));
  if (cupom?.tipo === "fixo") total = Math.min(total, cupom.centavos / 100);
  if (cupom?.tipo === "cortesia") total = 0;
  return { tarifa_versao: TARIFA_VERSAO, moeda: "BRL", centavos: centavos(total),
    calculo: { soma_por_ha_centavos: soma, por_ha_centavos: taxa, minimo_aplicado: soma < 600,
      subtotal_centavos: subtotal, desconto_centavos: subtotal - centavos(total), partes } };
}

export function definirCupom(env, codigo) {
  if (!codigo) return null;
  let catalogo;
  try { catalogo = JSON.parse(env.PLANTARE_CUPONS || "{}"); }
  catch { falhar(503, "cupons_indisponiveis", "configuração de cupons indisponível"); }
  if (!catalogo || typeof catalogo !== "object" || Array.isArray(catalogo))
    falhar(503, "cupons_indisponiveis", "configuração de cupons indisponível");
  const c = Object.hasOwn(catalogo, codigo) ? catalogo[codigo] : null;
  if (!c || c.ativo === false) falhar(400, "cupom_invalido", "cupom não encontrado ou inativo");
  const tipos = ["percentual", "fixo", "cortesia"];
  const permitidos = ["versao", "tipo", "ativo", "desconto_bps", "centavos", "valido_ate", "area_min_cent_ha", "usos_max", "so_primeira", "ilimitado"];
  if (typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !permitidos.includes(k))
      || typeof c.versao !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(c.versao) || !tipos.includes(c.tipo)
      || ["ativo", "so_primeira", "ilimitado"].some((k) => c[k] !== undefined && typeof c[k] !== "boolean")
      || (c.tipo === "percentual" && (!Number.isSafeInteger(c.desconto_bps) || c.desconto_bps < 1 || c.desconto_bps > 9000))
      || (c.tipo !== "percentual" && c.desconto_bps !== undefined)
      || (c.tipo === "fixo" && (!Number.isSafeInteger(c.centavos) || c.centavos < 1 || c.centavos > 50000000))
      || (c.tipo !== "fixo" && c.centavos !== undefined)
      || (c.valido_ate != null && (typeof c.valido_ate !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/.test(c.valido_ate) || !Number.isFinite(Date.parse(c.valido_ate))))
      || (c.area_min_cent_ha !== undefined && (!Number.isSafeInteger(c.area_min_cent_ha) || c.area_min_cent_ha < 0 || c.area_min_cent_ha > 5000000))
      || (c.usos_max != null && (!Number.isSafeInteger(c.usos_max) || c.usos_max < 1 || c.usos_max > 10000)))
    falhar(503, "cupons_indisponiveis", "definição de cupom inválida");
  return { codigo, versao: c.versao, tipo: c.tipo,
    ...(c.tipo === "percentual" ? { desconto_bps: c.desconto_bps } : {}),
    ...(c.tipo === "fixo" ? { centavos: c.centavos } : {}),
    valido_ate: c.valido_ate ?? null, area_min_cent_ha: c.area_min_cent_ha ?? 0,
    usos_max: c.usos_max ?? null, so_primeira: c.so_primeira ?? false, ilimitado: c.ilimitado ?? false };
}
