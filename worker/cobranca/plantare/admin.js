import { json } from "../../comum.js";
import { corpoLimitado } from "./api.js";
import { checkoutAtivo, objetoPlantare } from "./config.js";
import { COMPRA } from "./faturamento-contrato.js";
import { CHAVE, ErroPlantare, falhar } from "./contrato.js";

export async function atenderRevisoes(request, env, url, quem) {
  try {
    if (!quem?.areas?.includes("atos")) falhar(403, "sem_area", "você não atua na Atos");
    if (!["dono", "financeiro", "suporte"].includes(quem.papel)) falhar(403, "sem_papel", "papel indisponível");
    if (request.method !== "GET" && !["dono", "financeiro"].includes(quem.papel))
      falhar(403, "somente_consulta", "suporte apenas consulta os pagamentos");
    if (!checkoutAtivo(env)) falhar(503, "checkout_indisponivel", "revisões Plantare disponíveis apenas no checkout de teste");
    const base = "/api/admin/plantare-pagamentos";
    const resto = url.pathname.slice(base.length);
    let dados;
    if (!resto && request.method === "GET") {
      if ([...url.searchParams.keys()].some((k) => k !== "cursor") || url.searchParams.getAll("cursor").length > 1)
        falhar(400, "entrada_invalida", "parâmetros inválidos");
      dados = { op: "revisoes", cursor: url.searchParams.get("cursor") };
    } else {
      if (url.search) falhar(400, "entrada_invalida", "consulta não aceita parâmetros");
      const m = /^\/(cmp-[a-f0-9-]+)(\/consultar)?$/.exec(resto);
      if (!m || !COMPRA.test(m[1])) return json({ erro: "rota não encontrada" }, 404);
      if (!m[2] && request.method === "GET") dados = { op: "revisao", id: m[1] };
      else if (m[2] && request.method === "POST") {
        if (request.headers.get("origin") !== url.origin) falhar(403, "origem_invalida", "origem inválida");
        const chave = request.headers.get("idempotency-key");
        if (!CHAVE.test(chave || "")) falhar(400, "idempotencia_invalida", "Idempotency-Key obrigatório");
        const d = await corpoLimitado(request);
        dados = { op: "revisao_consultar", id: m[1], token: d?.token, order_id: d?.order_id,
          justificativa: d?.justificativa, chave, quem: quem.email };
      } else return json({ erro: "método não permitido" }, 405);
    }
    const r = await objetoPlantare(env).fetch("https://plantare-orcamentos/", { method: "POST", body: JSON.stringify(dados) });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof ErroPlantare) return json({ erro: e.message, codigo: e.codigo }, e.status);
    return json({ erro: "revisões indisponíveis", codigo: "registro_indisponivel" }, 503);
  }
}
