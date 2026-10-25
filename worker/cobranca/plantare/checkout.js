import { json } from "../../comum.js";
import { sessaoDe } from "../../contas.js";
import { cliente, idDoCliente } from "../cliente.js";
import { conferirPerfil } from "../api.js";
import { corpoLimitado } from "./api.js";
import { checkoutAtivo, objetoPlantare } from "./config.js";
import { COMPRA_ID } from "./compras.js";
import { ErroPlantare, falhar } from "./contrato.js";

const API = "/api/plantare-checkout/";
const PAGINA = /^\/plantare\/assinar(?:\/|\/index\.html)?$/;
export function ehCheckoutPlantare(url) {
  return PAGINA.test(url.pathname) || url.pathname.startsWith(API);
}

export async function atenderCheckoutPlantare(request, env, url) {
  try {
    if (!checkoutAtivo(env) || !env.PLANTARE_ORCAMENTOS) return json({ erro: "checkout indisponível" }, 404);
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname))
      falhar(400, "https_obrigatorio", "use HTTPS");
    const pagina = PAGINA.test(url.pathname);
    const m = new RegExp("^" + API + "([^/]+)(/pagar)?$").exec(url.pathname);
    if (!pagina && !m) return json({ erro: "rota não encontrada" }, 404);
    if ((pagina && request.method !== "GET") || (!pagina && request.method !== (m[2] ? "POST" : "GET")))
      return json({ erro: "método não permitido" }, 405);
    const id = pagina ? url.searchParams.get("compra") : m[1];
    if (!COMPRA_ID.test(id || "") || (pagina && (url.searchParams.getAll("compra").length !== 1
        || [...url.searchParams.keys()].some((k) => k !== "compra"))) || (!pagina && url.search))
      falhar(400, "entrada_invalida", "informe somente uma compra válida");
    if (request.method === "POST" && request.headers.get("origin") !== url.origin)
      falhar(403, "origem_invalida", "origem não permitida");
    const s = await sessaoDe(request, env);
    if (!s) {
      if (!pagina) return json({ erro: "entre na sua conta Atos", codigo: "sem_sessao" }, 401);
      return new Response(null, { status: 302, headers: { location: "/entrar/?volta="
        + encodeURIComponent("/plantare/assinar?compra=" + id), "cache-control": "no-store" } });
    }
    if (env.PLANTARE_LIMITE && !(await env.PLANTARE_LIMITE.limit({ key: "checkout:" + s.sub })).success)
      falhar(429, "limite", "aguarde antes de consultar novamente");
    const stub = objetoPlantare(env);
    const pedir = (op, extra = {}) => stub.fetch("https://plantare-orcamentos/", {
      method: "POST", body: JSON.stringify({ op, id, sub: s.sub, ...extra }),
    });
    // Conferir o dono antes de retornar página, perfil ou iniciar qualquer efeito.
    const compra = await pedir("compra");
    if (!compra.ok) return compra;
    if (pagina) {
      const asset = await env.ASSETS.fetch(new Request(new URL("/plantare/assinar/", url), { method: "GET" }));
      return new Response(asset.body, { status: asset.status, headers: {
        "content-type": asset.headers.get("content-type") || "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (m[2]) {
      const d = await corpoLimitado(request);
      if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).length !== 0)
        falhar(400, "entrada_invalida", "o pagamento não aceita parâmetros do navegador");
      if (!env.CLIENTES) falhar(503, "perfil_indisponivel", "dados fiscais indisponíveis");
      const p = await cliente(env, await idDoCliente(s.sub), { sub: s.sub, email: s.email }).pedir("perfil_ler");
      const perfil = p.ok && p.perfil ? conferirPerfil(p.perfil, s.email) : null;
      return pedir("pagar", { perfil: perfil && !perfil.erro ? perfil : null, email: s.email });
    }
    return pedir("pagamento");
  } catch (e) {
    if (e instanceof ErroPlantare) return json({ erro: e.message, codigo: e.codigo }, e.status);
    return json({ erro: "checkout temporariamente indisponível", codigo: "checkout_indisponivel" }, 503);
  }
}
