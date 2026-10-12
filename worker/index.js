// O Worker de atos.dev.br: a pagina da Atos (pasta public/), a conta Atos
// (contas.js) e o "Entrar com Atos" (oidc.js).
//
// matheusuener.com.br e www.* voltam para https://atos.dev.br com 301.
// Toda pagina sai com cabecalhos de seguranca; as da conta (/entrar, /conta, /workspace, /admin)
// com uma CSP sem nada de fora - nelas a pessoa digita a senha e permite
// aplicativos, entao nada de outro site roda nem as emoldura.

import { EMISSOR, dentroDoLimite, json } from "./comum.js";
import { atenderConta, ehRotaDaConta, sessaoDe } from "./contas.js";
import { atenderOIDC, ehRotaDoOIDC } from "./oidc.js";
import { atenderGoogle, ehRotaDoGoogle } from "./google.js";
import { atenderCobrancaV1, ehRotaDaCobrancaV1 } from "./cobranca/api.js";
import { ehAmbienteDeTeste } from "./cobranca/eventos.js";
import { atenderEmissor, depoisPendentes } from "./nfse/api.js";
import { atenderAdmin, ehRotaDoAdmin } from "./admin.js";
import { atenderIntegracoes, ehRotaDasIntegracoes } from "./integracoes.js";
import { VOLTA_DO_WORKSPACE, atenderWorkspace, ehRotaDoWorkspace } from "./workspace.js";
import { atenderEmailAtos, ehRotaDoEmailAtos, receberEmail } from "./email-atos.js";
import { atenderSeguranca, ehRotaDaSeguranca } from "./seguranca.js";
import { atenderFormularioPublico, atenderFormularios, ehRotaDoFormularioPublico, ehRotaDosFormularios } from "./formularios.js";
import { atenderPaginaDeStatus, atenderStatus, conferirStatusAgendado, ehRotaDaPaginaDeStatus, ehRotaDoStatus } from "./status.js";

// O registro de cada cliente da Atos Cobranca (docs/COBRANCA.md): o Durable Object precisa sair do modulo principal.
export { ClienteCobranca } from "./cobranca/cliente.js";
// O emissor de NFS-e da Atos (worker/nfse/emissor.js): uma instancia so, idFromName("atos").
export { EmissorNFSe } from "./nfse/emissor.js";
// O registro do e-mail Atos (worker/email-atos.js): uma instancia so, idFromName("registro").
export { EmailAtos } from "./email-atos.js";
// A seguranca de cada Conta Atos (worker/seguranca/objeto.js): idFromName(<sub>), e "entrar" para os desafios do
// "Entrar com chave de acesso".
export { SegurancaConta } from "./seguranca/objeto.js";
// Os recursos do Atos Workspace (worker/workspace-dados.js): os formularios, os avisos, as entradas e as paginas de status.
// Um objeto "indice" e um por conta ("conta:<sub>").
export { WorkspaceDados } from "./workspace-dados.js";

const CSP_CONTA = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://viacep.com.br",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

// As paginas publicas (inicio, privacidade, termos): a contagem de visitas da Cloudflare (Web Analytics, sem
// cookies; o beacon que ela poe sozinha) roda so aqui - a conta, o entrar (CSP_CONTA) e o checkout continuam sem
// script de terceiros alem do Mercado Pago. Dito na politica de privacidade.
const CSP_SITE = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://viacep.com.br https://cloudflareinsights.com",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

// O checkout (/pavlvs/assinar e os de outros produtos): os campos seguros do Mercado Pago (o SDK, os
// iframes do cartao e a telemetria dele) e o CEP pela ViaCEP. O script da propria pagina roda pelo
// hash dele (CSP_CHECKOUT recebe os 'sha256-...'), nunca por 'unsafe-inline'. O MercadoPago.js poe
// estilos inline nos campos: so o estilo tem 'unsafe-inline'.
const MP_ORIGENS = "https://*.mercadopago.com https://*.mercadolibre.com https://*.mercadolivre.com https://*.mlstatic.com";
const CSP_CHECKOUT = (hashes) => [
  "default-src 'self'",
  `script-src 'self' https://sdk.mercadopago.com ${MP_ORIGENS} ${hashes.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  `connect-src 'self' ${MP_ORIGENS} https://viacep.com.br`,
  `frame-src ${MP_ORIGENS}`,
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

async function comCspDoCheckout(resposta) {
  const html = await resposta.text();
  const hashes = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    // O navegador troca CRLF e CR por LF antes de ler o HTML (o pre-processamento do HTML), e o hash e
    // do texto ja trocado: o arquivo salvo no Windows teria outro hash, e o script seria bloqueado.
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1].replace(/\r\n?/g, "\n")));
    hashes.push("'sha256-" + btoa(String.fromCharCode(...new Uint8Array(h))) + "'");
  }
  const r = new Response(html, resposta);
  // Sem validador de cache: o navegador nao tem como pedir o 304 desta pagina.
  r.headers.delete("etag");
  r.headers.delete("last-modified");
  r.headers.set("content-security-policy", CSP_CHECKOUT(hashes));
  r.headers.set("x-frame-options", "DENY");
  r.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  r.headers.set("cache-control", "no-store");
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("strict-transport-security", "max-age=31536000");
  return r;
}

function comCabecalhos(resposta, conta) {
  const r = new Response(resposta.body, resposta);
  if ((r.headers.get("content-type") || "").includes("text/html")) {
    r.headers.set("content-security-policy", conta ? CSP_CONTA : CSP_SITE);
    r.headers.set("x-frame-options", "DENY");
    r.headers.set("referrer-policy", conta ? "no-referrer" : "strict-origin-when-cross-origin");
    if (conta) r.headers.set("cache-control", "no-store");
  }
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("strict-transport-security", "max-age=31536000");
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // O Worker de teste (wrangler --env teste: atos-teste.<conta>.workers.dev) atende no proprio endereco.
    const doTeste = ehAmbienteDeTeste(env) && /^atos-teste\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname);
    if (url.hostname !== "atos.dev.br" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && !doTeste) {
      return Response.redirect(EMISSOR + url.pathname + url.search, 301);
    }
    try {
      // O envio de um formulario do Workspace (/f/<id>; worker/formularios.js): vem do site do dono (outra origem; o
      // formulario confere a origem cadastrada) e responde com os proprios cabecalhos (as paginas tem CSP propria).
      if (ehRotaDoFormularioPublico(url)) return await atenderFormularioPublico(request, env, url, { dentroDoLimite });
      // A pagina de status publica (/status/<nome>; worker/status.js): gerada aqui, com a CSP propria e 60 s de cache.
      if (ehRotaDaPaginaDeStatus(url)) return await atenderPaginaDeStatus(request, env, url);
      // A Atos Cobranca: o aviso do Mercado Pago chega de fora (sem Origin; quem garante e a assinatura
      // HMAC); o resto e da propria pagina.
      if (ehRotaDaCobrancaV1(url)) {
        if (url.pathname !== "/api/mp/aviso" && !mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderCobrancaV1(request, env, url, { ctx }));
      }
      if (ehRotaDoGoogle(url)) return comCabecalhos(await atenderGoogle(request, env, url));
      if (ehRotaDoOIDC(url)) {
        if (url.pathname.startsWith("/api/") && !mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderOIDC(request, env, url, { dentroDoLimite }));
      }
      // O painel da Atos (worker/admin.js): a equipe, pela Conta Atos com login recente; as notas no emissor; o
      // painel do PAVLVS (/api/admin/pavlvs/*), encaminhado ao Worker dele pelo binding PAVLVS.
      if (ehRotaDoAdmin(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        const emissor = (req, e, u, quem) => atenderEmissor(req, e, u, quem, { ctx });
        return comCabecalhos(await atenderAdmin(request, env, url, { emissor }), true);
      }
      // O Atos Workspace (worker/workspace.js): ativar e desativar; e as Integracoes dele, os sistemas que a pessoa
      // cadastra no Entrar com Atos (worker/integracoes.js; so com o Workspace ativo).
      // O e-mail Atos do Workspace (worker/email-atos.js): o alias, o destino e o encaminhamento.
      if (ehRotaDoEmailAtos(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderEmailAtos(request, env, url, { dentroDoLimite }));
      }
      // Os formularios do Workspace (worker/formularios.js): as rotas do dono, antes das do Workspace (o mesmo prefixo).
      if (ehRotaDosFormularios(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderFormularios(request, env, url, { dentroDoLimite }));
      }
      // A pagina de status do Workspace (worker/status.js): as rotas do dono.
      if (ehRotaDoStatus(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderStatus(request, env, url, { dentroDoLimite }));
      }
      if (ehRotaDoWorkspace(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderWorkspace(request, env, url));
      }
      if (ehRotaDasIntegracoes(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderIntegracoes(request, env, url, { dentroDoLimite }));
      }
      // A seguranca da conta (worker/seguranca.js): a guia Seguranca, a segunda etapa do login e a chave de acesso.
      if (ehRotaDaSeguranca(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderSeguranca(request, env, url, { dentroDoLimite }));
      }
      if (ehRotaDaConta(url)) {
        if (!mesmaOrigem(request, url)) return json({ erro: "origem não permitida" }, 403);
        return comCabecalhos(await atenderConta(request, env, url, { dentroDoLimite }));
      }
    } catch (erro) {
      return json({ erro: "falha no servidor da conta" }, 500);
    }
    if (url.pathname.startsWith("/api/")) return json({ erro: "rota não existe" }, 404);
    // O checkout de cada produto (public/<produto>/assinar/).
    if (/^\/[a-z0-9-]+\/assinar\/?$/.test(url.pathname)) {
      // Sempre a pagina inteira, nunca o 304: a CSP leva o hash do script que vai junto, e um 304 (sem corpo)
      // sairia sem hash nenhum, e o navegador bloquearia o script da copia que ja tinha.
      const semCondicao = new Headers(request.headers);
      for (const h of ["if-none-match", "if-modified-since", "if-match", "if-range"]) semCondicao.delete(h);
      const r = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: semCondicao }));
      return (r.headers.get("content-type") || "").includes("text/html") ? comCspDoCheckout(r) : comCabecalhos(r);
    }
    // O painel (/admin) e o Workspace tem a CSP da conta: so scripts da propria Atos.
    const conta = /^\/(entrar|conta|admin|workspace)(\/|$)/.test(url.pathname);
    // As Integracoes sairam da Minha conta para o Atos Workspace: o endereco antigo leva ao novo.
    if (/^\/conta\/integracoes\/?$/.test(url.pathname)) return Response.redirect(new URL("/workspace/integracoes" + url.search, url).toString(), 301);
    // Cada secao da Minha conta tem o proprio endereco; a pagina e uma so. O mesmo no Workspace.
    if (/^\/conta\/(dados|seguranca|assinaturas|faturamento|carteira)\/?$/.test(url.pathname)) {
      return comCabecalhos(await env.ASSETS.fetch(new Request(new URL("/conta/", url), request)), true);
    }
    // A tela de entrar do Workspace (/workspace/entrar; public/assets/workspace-entrar.js): so o endereco Atos. Quem ja
    // esta com a sessao pelo alias vai direto (ao ?volta=, so um caminho de /workspace/), menos com ?modo=entrar (o
    // "Entrar de novo" de quem precisa de um login recente).
    if (/^\/workspace\/entrar\/?$/.test(url.pathname) && request.method === "GET") {
      const s = await sessaoDe(request, env);
      if (s && s.via === "alias" && url.searchParams.get("modo") !== "entrar") return irPara(url, voltaDoWorkspace(url));
    }
    // A area do Workspace sem sessao: a tela de entrar do Workspace (que tem o caminho da Conta Atos para quem nao tem o
    // alias), voltando a esta guia.
    if (/^\/workspace(\/(integracoes|email|formularios|status))?\/?$/.test(url.pathname) && request.method === "GET" && !(await sessaoDe(request, env))) {
      return irPara(url, "/workspace/entrar/?volta=" + encodeURIComponent(url.pathname));
    }
    if (/^\/workspace\/(integracoes|email|formularios|status)\/?$/.test(url.pathname)) {
      return comCabecalhos(await env.ASSETS.fetch(new Request(new URL("/workspace/", url), request)), true);
    }
    return comCabecalhos(await env.ASSETS.fetch(request), conta);
  },

  // O Cron de cada minuto (wrangler.jsonc, triggers): o PDF (e o e-mail) de uma NFS-e emitida que ainda nao tem
  // (worker/nfse/api.js, depoisPendentes; sem nota esperando, uma leitura do KV), e as conferencias das paginas de status.
  // O e-mail que chega a <alias>@atos.dev.br pelo catch-all da Cloudflare Email Routing (worker/email-atos.js): encaminha
  // ao destino confirmado ou recusa na entrega. As regras especificas do dominio (contato@, master@...) nao passam aqui.
  async email(message, env, ctx) {
    await receberEmail(message, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(depoisPendentes(env).catch(() => null));
    // As paginas de status do Workspace (worker/status.js): as contas vencidas da agenda, no maximo STATUS_POR_MINUTO.
    ctx.waitUntil(conferirStatusAgendado(env).catch(() => null));
  },
};

/* O ?volta= da tela do Workspace: so um caminho de /workspace/ (nunca a propria tela de entrar); senao, /workspace/. */
function voltaDoWorkspace(url) {
  const v = url.searchParams.get("volta") || "";
  return VOLTA_DO_WORKSPACE.test(v) ? v : "/workspace/";
}

/* Um redirecionamento sem cache (depende da sessao), com os cabecalhos de sempre. */
function irPara(url, caminho) {
  const r = new Response(null, { status: 302, headers: { location: new URL(caminho, url).toString(), "cache-control": "no-store" } });
  r.headers.set("x-content-type-options", "nosniff");
  r.headers.set("strict-transport-security", "max-age=31536000");
  return r;
}

/* POST so da propria pagina (o navegador sempre manda Origin num POST de fetch). */
function mesmaOrigem(request, url) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  return request.headers.get("origin") === url.origin;
}
