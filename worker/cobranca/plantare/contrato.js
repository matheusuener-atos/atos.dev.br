// Contrato de servidor: o Plantare autentica a pessoa e mede o polígono.
// A Atos aceita apenas o escopo medido, nunca valor/dono vindo do navegador.
export const SCHEMA = "plantare-orcamento/v1";
export const VALIDADE_MS = 15 * 60 * 1000;
export const CAMADAS = Object.freeze(["linhas_ab", "bordadura", "percurso", "manobras"]);
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
export const SUB = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const CHAVE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export class ErroPlantare extends Error {
  constructor(status, codigo, mensagem) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

export function falhar(status, codigo, mensagem) {
  throw new ErroPlantare(status, codigo, mensagem);
}

export function validarOrcamento(d) {
  const campos = ["schema", "intent_id", "sub", "area_hash", "area_cent_ha", "camadas", "cupom"];
  if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).some((k) => !campos.includes(k)))
    falhar(400, "entrada_invalida", "campos do orçamento inválidos");
  if (d.schema !== SCHEMA || typeof d.intent_id !== "string" || !ID.test(d.intent_id)
      || typeof d.sub !== "string" || !SUB.test(d.sub)
      || typeof d.area_hash !== "string" || !/^[a-f0-9]{64}$/i.test(d.area_hash)
      || !Number.isSafeInteger(d.area_cent_ha) || d.area_cent_ha < 1 || d.area_cent_ha > 5000000)
    falhar(400, "entrada_invalida", "schema, identidade, intenção, hash ou área inválidos");
  if (!Array.isArray(d.camadas) || !d.camadas.length || d.camadas.length > 4
      || d.camadas.some((c) => !CAMADAS.includes(c)) || new Set(d.camadas).size !== d.camadas.length)
    falhar(400, "camadas_invalidas", "escolha camadas válidas, sem duplicatas");
  if (d.cupom != null && (typeof d.cupom !== "string" || !/^[A-Z0-9_-]{3,32}$/i.test(d.cupom)))
    falhar(400, "cupom_invalido", "código de cupom inválido");
  return {
    schema: SCHEMA, intent_id: d.intent_id, sub: d.sub, area_hash: d.area_hash.toLowerCase(),
    area_cent_ha: d.area_cent_ha, camadas: CAMADAS.filter((c) => d.camadas.includes(c)),
    cupom: d.cupom == null ? null : d.cupom.toUpperCase(),
  };
}
