import { json, sha256 } from "../../comum.js";
import { CHAVE, ID, SUB, VALIDADE_MS, ErroPlantare, falhar, validarOrcamento } from "./contrato.js";
import { calcularPreco, definirCupom } from "./preco.js";

// Um único objeto para o produto: os limites de campanha cruzam contas.
// Transações locais incluem intenção, orçamento, idempotência e reserva.
// Não há gateway, evento financeiro, consumo de cupom ou checkout em M1.
export class PlantareOrcamentos {
  constructor(ctx, env, deps = {}) { this.ctx = ctx; this.env = env; this.agora = deps.agora || Date.now; }

  async fetch(request) {
    try {
      const d = await request.json();
      if (d.op === "criar") return json(await this.criar(d.dados, d.chave), 200);
      if (d.op === "intencao") return json(await this.intencao(d.sub, d.id));
      return json({ erro: "operação não encontrada" }, 404);
    } catch (e) {
      if (e instanceof ErroPlantare) return json({ erro: e.message, codigo: e.codigo }, e.status);
      return json({ erro: "registro de orçamentos indisponível", codigo: "registro_indisponivel" }, 503);
    }
  }

  async chaveIntencao(sub, id) { return "intencao:" + await sha256(JSON.stringify([sub, id])); }

  async criar(entrada, chave) {
    const dados = validarOrcamento(entrada);
    if (typeof chave !== "string" || !CHAVE.test(chave)) falhar(400, "idempotencia_invalida", "informe Idempotency-Key de 8 a 128 caracteres");
    const digest = await sha256(JSON.stringify(dados));
    const ik = await this.chaveIntencao(dados.sub, dados.intent_id);
    const idem = "idempotencia:" + await sha256(JSON.stringify(["plantare", dados.sub, "orcamentos", chave]));
    return this.ctx.storage.transaction(async (tx) => {
      const agora = this.agora();
      const anterior = await tx.get(idem), intencao = await tx.get(ik);
      if ((anterior && anterior.digest !== digest) || (intencao && intencao.digest !== digest))
        falhar(409, "idempotencia_conflitante", "a chave ou intenção já foi usada com outros parâmetros");
      if (anterior && (!intencao || anterior.intencao !== ik))
        falhar(503, "registro_inconsistente", "registro de intenção precisa de recuperação");
      if (intencao) {
        if (Date.parse(intencao.orcamento.valido_ate) <= agora)
          falhar(410, "orcamento_vencido", "orçamento vencido; consulte a intenção e crie outra explicitamente");
        if (!anterior) await tx.put(idem, { digest, intencao: ik });
        return intencao.orcamento;
      }

      const cupom = definirCupom(this.env, dados.cupom);
      const valor = calcularPreco(dados, cupom);
      if (valor.centavos > 0 && valor.centavos < 100) falhar(400, "abaixo_minimo", "valor abaixo do mínimo de R$ 1,00");
      const orcamento = { ...dados, ...valor, produto: "plantare", orcamento_id: "orc-" + crypto.randomUUID(),
        cupom, criado_em: new Date(agora).toISOString(), valido_ate: new Date(agora + VALIDADE_MS).toISOString() };
      if (cupom) await this.reservar(tx, dados, orcamento, agora);
      await tx.put(ik, { digest, orcamento });
      await tx.put(idem, { digest, intencao: ik });
      return orcamento;
    });
  }

  async reservar(tx, d, orcamento, agora) {
    const c = orcamento.cupom;
    if (c.valido_ate && Date.parse(c.valido_ate) <= agora) falhar(400, "cupom_vencido", "cupom vencido");
    if (d.area_cent_ha < c.area_min_cent_ha) falhar(400, "cupom_area", "cupom não vale para esta área");

    const ck = "cupom:" + c.codigo;
    const estado = await tx.get(ck) || { reservas: [], consumos: [] };
    const definicao = await sha256(JSON.stringify(c));
    if (estado.versao === c.versao && estado.definicao !== definicao)
      falhar(503, "cupom_versao", "alteração de cupom exige nova versão");
    if (c.ilimitado) {
      await tx.put(ck, { ...estado, versao: c.versao, definicao });
      return;
    }

    // O histórico legado ainda será importado. Ausência não significa zero.
    if (c.so_primeira) {
      const hist = await tx.get("historico:" + await sha256(d.sub));
      if (!hist?.conferido || !Number.isSafeInteger(hist.compras_pagas) || hist.compras_pagas < 0)
        falhar(503, "historico_indisponivel", "histórico de primeira compra ainda não conferido");
      if (hist.compras_pagas > 0) falhar(409, "cupom_primeira", "cupom válido apenas para a primeira compra");
    }

    const reservas = estado.reservas.filter((r) => Date.parse(r.expira) > agora);
    const pessoas = [...estado.consumos, ...reservas];
    if (pessoas.some((p) => p.sub === d.sub || p.area_hash === d.area_hash))
      falhar(409, "cupom_reservado", "cupom já usado ou reservado para esta pessoa ou talhão");
    if (c.usos_max != null && pessoas.length >= c.usos_max)
      falhar(409, "cupom_esgotado", "usos do cupom esgotados ou reservados");
    if (reservas.length >= 128) falhar(503, "reservas_ocupadas", "capacidade de reservas temporariamente ocupada");
    reservas.push({ orcamento_id: orcamento.orcamento_id, intent_id: d.intent_id,
      sub: d.sub, area_hash: d.area_hash, expira: orcamento.valido_ate });
    await tx.put(ck, { ...estado, versao: c.versao, definicao, reservas });
  }

  async intencao(sub, id) {
    if (typeof sub !== "string" || !SUB.test(sub) || typeof id !== "string" || !ID.test(id))
      falhar(400, "entrada_invalida", "identidade ou intenção inválida");
    const intencao = await this.ctx.storage.get(await this.chaveIntencao(sub, id));
    if (!intencao) falhar(404, "intencao_nao_encontrada", "intenção não encontrada nesta conta");
    return { produto: "plantare", intent_id: id, sub, orcamento: intencao.orcamento,
      expirado: Date.parse(intencao.orcamento.valido_ate) <= this.agora(), compra: null };
  }
}
