// Referência congelada: plantare-maps c18adbd, pix-worker/src/preco.js.
// Só para paridade; o código de produção não importa esta fixture.
/* Tabela de preço do Plantare — a MESMA conta roda no app (para mostrar) e no Worker (para cobrar).
   Se mudar algo aqui, copie para o bloco "preco" do plantare.html. */
export const PRECO = {
  // R$/ha por camada; cada camada leva todos os formatos (KML, KMZ, SHP UTM/WGS84, CSV, GeoJSON)
  camadas: { linhas_ab: 5.00, bordadura: 2.00, percurso: 2.00, manobras: 1.00 },
  minimoHa: 6.00,                       // nenhuma compra fica abaixo de R$ 6,00/ha
  // desconto só na parte da área acima de cada faixa: [até ha, desconto]
  faixas: [[300, 0], [600, 0.20], [1000, 0.30], [Infinity, 0.40]],
  areaMaxHa: 50000
};
export const NOMES_CAMADAS = { linhas_ab: 'Linhas AB', bordadura: 'Bordadura', percurso: 'Percurso contínuo', manobras: 'Manobras' };

const r2 = v => Math.round(v * 100) / 100;

/* área geodésica (m²) de polígonos [{outer:[[lon,lat]...], holes:[...]}], fórmula de anel esférico (como a do turf) */
export function areaPoligonos(polys) {
  const R = 6378137, rad = Math.PI / 180;
  const anel = pts => {
    let s = 0; const n = pts.length; if (n < 3) return 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      s += (b[0] - a[0]) * rad * (2 + Math.sin(a[1] * rad) + Math.sin(b[1] * rad));
    }
    return Math.abs(s * R * R / 2);
  };
  let t = 0;
  for (const p of polys || []) { t += anel(p.outer || []); for (const h of p.holes || []) t -= anel(h); }
  return Math.max(0, t);
}

/* preço de uma compra: área em ha (2 casas) e lista de camadas.
   cupom = desconto extra em fração (0..0,9), {fixo: R$} — preço fixo da compra (nunca acima do preço normal) —
   ou {gratis: true} — compra sem custo (cupom de cortesia) */
export function calcularPreco(areaHa, camadas, cupom) {
  const ha = r2(Math.max(0, +areaHa || 0));
  const lista = [...new Set((camadas || []).filter(c => PRECO.camadas[c] != null))];
  const somaHa = r2(lista.reduce((s, c) => s + PRECO.camadas[c], 0));
  if (!lista.length || ha <= 0) return { ha, camadas: lista, somaHa, porHa: 0, minimoAplicado: false, partes: [], semDesconto: 0, total: 0, cupom: 0 };
  const porHa = Math.max(PRECO.minimoHa, somaHa);
  const partes = []; let ini = 0, total = 0;
  for (const [lim, desc] of PRECO.faixas) {
    const fim = Math.min(ha, lim), q = r2(fim - ini);
    if (q > 0) { const valor = r2(q * porHa * (1 - desc)); partes.push({ de: ini, ate: fim, ha: q, desconto: desc, porHa: r2(porHa * (1 - desc)), valor }); total += valor; }
    ini = lim; if (ha <= lim) break;
  }
  total = r2(total);
  const semDesconto = r2(ha * porHa);
  const gratis = !!(cupom && typeof cupom === 'object' && cupom.gratis === true);
  const fixo = !gratis && cupom && typeof cupom === 'object' && +cupom.fixo > 0 ? r2(+cupom.fixo) : 0;
  const c = gratis || fixo ? 0 : Math.max(0, Math.min(0.9, +cupom || 0));
  const comCupom = gratis ? 0 : fixo ? Math.min(total, fixo) : c ? r2(total * (1 - c)) : total;
  return { ha, camadas: lista, somaHa, porHa, minimoAplicado: somaHa < PRECO.minimoHa, partes, semDesconto, subtotal: total, cupom: c, fixo, gratis, total: comCupom };
}
