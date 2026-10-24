import { iguais, json } from "../../comum.js";
import { CHAVE, ErroPlantare, falhar } from "./contrato.js";

const PREFIXO = "/api/cobranca/v1/plantare";
const MAX_BYTES = 4096;
export const ehRotaPlantare = (url) => url.pathname === PREFIXO || url.pathname.startsWith(PREFIXO + "/");

async function corpoLimitado(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || ""))
    falhar(415, "tipo_invalido", "envie application/json");
  if (!request.body) falhar(400, "entrada_invalida", "corpo JSON obrigatório");
  const reader = request.body.getReader();
  const partes = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); falhar(413, "corpo_grande", "corpo acima de 4096 bytes"); }
      partes.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const p of partes) { bytes.set(p, offset); offset += p.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { falhar(400, "entrada_invalida", "JSON inválido"); }
}

export async function atenderPlantare(request, env, url) {
  try {
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname))
      falhar(400, "https_obrigatorio", "a integração exige HTTPS");
    // Não é a sessão do cliente, o client_secret OIDC ou o segredo de avisos.
    const token = env.PLANTARE_COBRANCA_TOKEN;
    if (env.PLANTARE_ORCAMENTOS_ATIVOS !== "1" || typeof token !== "string" || token.length < 32 || !env.PLANTARE_ORCAMENTOS)
      falhar(503, "plantare_indisponivel", "orçamentos do Plantare indisponíveis");
    const auth = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") || "");
    if (!auth || !iguais(auth[1], token)) falhar(401, "produto_nao_autenticado", "produto não autenticado");
    if (request.headers.has("origin")) falhar(403, "somente_servidor", "esta integração é exclusiva de servidor");
    if (env.PLANTARE_LIMITE && !(await env.PLANTARE_LIMITE.limit({ key: "plantare-orcamentos" })).success)
      falhar(429, "limite", "limite de orçamentos atingido; tente novamente depois");
    let dados;
    if (url.pathname === PREFIXO + "/orcamentos" && request.method === "POST") {
      const chave = request.headers.get("idempotency-key");
      if (!CHAVE.test(chave || "")) falhar(400, "idempotencia_invalida", "Idempotency-Key obrigatório");
      dados = { op: "criar", chave, dados: await corpoLimitado(request) };
    } else if (url.pathname.startsWith(PREFIXO + "/intencoes/") && request.method === "GET") {
      if ([...url.searchParams.keys()].some((k) => k !== "sub") || url.searchParams.getAll("sub").length !== 1)
        falhar(400, "entrada_invalida", "informe somente um sub");
      dados = { op: "intencao", id: url.pathname.slice((PREFIXO + "/intencoes/").length), sub: url.searchParams.get("sub") };
    } else return json({ erro: "rota não encontrada", codigo: "rota_inexistente" }, 404);
    const stub = env.PLANTARE_ORCAMENTOS.get(env.PLANTARE_ORCAMENTOS.idFromName(
      (env.AMBIENTE === "teste" ? "teste:" : "producao:") + "plantare:orcamentos:v1"));
    const r = await stub.fetch("https://plantare-orcamentos/", { method: "POST", body: JSON.stringify(dados) });
    return new Response(r.body, { status: r.status, headers: {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof ErroPlantare) return json({ erro: e.message, codigo: e.codigo }, e.status);
    return json({ erro: "registro de orçamentos indisponível", codigo: "registro_indisponivel" }, 503);
  }
}
