// "Continuar como <nome>": a Atos como provedora FedCM (Federated Credential Management, W3C; o navegador mostra a
// Conta Atos que esta aberta e a pessoa escolhe, sem sair do site). Seguindo a especificacao e a documentacao do
// Chrome (developer.chrome.com/docs/identity/fedcm/implement/identity-provider), lidas em 12/10/2026:
//
//   GET  /.well-known/web-identity   {provider_urls, accounts_endpoint, login_url} (o navegador confere a configuracao)
//   GET  /fedcm/config.json          a configuracao (os enderecos abaixo, o login_url e a marca)
//   GET  /fedcm/contas               a conta aberta neste navegador (Sec-Fetch-Dest: webidentity; o cookie FedCM)
//   GET  /fedcm/cliente?client_id=   a politica de privacidade e os termos do aplicativo (sem cookie)
//   POST /fedcm/afirmar              o codigo de autorizacao para o site (Sec-Fetch-Dest, Origin, a sessao, o acesso)
//   POST /fedcm/desconectar          tira a permissao do aplicativo (IdentityCredential.disconnect)
//   POST /api/fedcm/continuar        a tela de permissao da Atos (o continue_on, na janela da Atos)
//   POST /api/fedcm/ligar            poe o cookie FedCM numa sessao aberta antes dele (a janela do login_url)
//
// O cookie. O navegador manda nas chamadas do FedCM so os cookies SameSite=None; a sessao da Atos (__Host-atos) e Lax
// e continua Lax. Toda sessao aberta ganha um segundo cookie, __Host-atos-fedcm (HttpOnly, Secure, SameSite=None), com
// OUTRO segredo: no KV, "atos:fedcm:sessao:<sha256>" aponta para o hash da sessao. So /fedcm/contas, /fedcm/afirmar e
// /fedcm/desconectar o leem, e so com Sec-Fetch-Dest: webidentity (um cabecalho que pagina nenhuma consegue mandar).
// Vazado, ele nao abre a conta em lugar nenhum. A sessao e a mesma: sair, trocar a senha, "Sair de todas as outras" e
// o vencimento valem para ele (sessaoPorHash faz as mesmas conferencias).
//
// O que o site recebe: um CODIGO DE AUTORIZACAO (2 minutos, uma vez), nunca o id_token. O site troca o codigo no
// /oauth/token como no login de sempre: com o code_verifier do PKCE (o code_challenge vai em params) e, no cliente
// confidencial, com o client_secret; sem redirect_uri (o codigo do FedCM e preso a origem do site, nao a uma volta).
// Assim o FedCM nao abre um caminho mais fraco: o segredo do cliente confidencial continua obrigatorio, o PKCE
// tambem, e a troca confere de novo a conta, a permissao e quem pode entrar.
//
// Quem pode entrar: o modo de acesso e a lista do aplicativo sao conferidos em /fedcm/afirmar (e de novo no
// /oauth/token): fora da lista, o navegador recebe o erro "access_denied" e o site nao recebe nada. A permissao: se a
// pessoa ainda nao permitiu o aplicativo, /fedcm/afirmar responde continue_on, e o navegador abre a tela de permissao
// da propria Atos (a mesma do login de sempre, com quem cadastrou o aplicativo); o aviso do navegador nao conta como
// permissao. A verificacao em duas etapas: so ha sessao depois dela (contas.js e seguranca.js), entao /fedcm/contas so
// lista a conta de quem ja passou por ela.
//
// Privacidade: /fedcm/contas nao recebe o client_id nem a origem do site (o navegador nao manda), e o que ele devolve
// fica com o navegador. O site so recebe o codigo depois que a pessoa escolhe a conta. O Login Status API
// (Set-Login: logged-in / logged-out, nas respostas que abrem e fecham a sessao) diz ao navegador so se ha alguem
// dentro da Atos, sem quem.

import { aleatorio, emissorDe, json, kv, lerJson, sha256 } from "./comum.js";
import { COOKIE, SESSAO_S, lerCookie, sessaoDe, sessaoPorHash } from "./contas.js";
import {
  ESCOPOS, ID_APP_TERCEIRO, appDoCliente, appTerceiro, appsDe, clienteAtivo, comCadastrador, comTerceiro, jaPermitiu, permissaoVale, podeEntrar,
  publicoDoApp, registro,
} from "./oidc.js";
import { anotarEntrada } from "./entradas.js";
import { avisar } from "./avisos.js";

export const COOKIE_FEDCM = "__Host-atos-fedcm";
const CODIGO_S = 120;
const PEDIDO_S = 600;
const cookieFedcm = (v) => COOKIE_FEDCM + "=" + v + "; Path=/; Max-Age=" + SESSAO_S + "; HttpOnly; Secure; SameSite=None";
const cookieFedcmApagado = COOKIE_FEDCM + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None";
const chaveSessao = async (v) => "atos:fedcm:sessao:" + (await sha256(v));
const chavePedido = async (id) => "atos:fedcm:pedido:" + (await sha256(id));

export function ehRotaDoFedCM(url) {
  return url.pathname === "/.well-known/web-identity" || url.pathname.startsWith("/fedcm/") || url.pathname === "/api/fedcm/continuar" || url.pathname === "/api/fedcm/ligar";
}

/* Os enderecos (o well-known e a configuracao dizem os mesmos). */
export function enderecosFedCM(env) {
  const E = emissorDe(env);
  return {
    config: E + "/fedcm/config.json", contas: E + "/fedcm/contas", cliente: E + "/fedcm/cliente", afirmar: E + "/fedcm/afirmar",
    desconectar: E + "/fedcm/desconectar", login: E + "/entrar/?fedcm=entrar", icone: E + "/marca/atos-marca-fedcm.png",
  };
}

// ------------------------------------------------------------------ o cookie e o Login Status

/* Liga o FedCM a sessao `h` (o hash do segredo de __Host-atos): o valor do cookie novo. */
async function ligarSessao(env, h) {
  const v = aleatorio(32);
  await env.CONTAS.put(await chaveSessao(v), JSON.stringify({ h }), { expirationTtl: SESSAO_S });
  return v;
}

/* Depois de uma resposta da conta (entrar, a segunda etapa, o Google, sair): quem abriu a sessao ganha o cookie FedCM e
   Set-Login: logged-in; quem a fechou perde o cookie e ganha Set-Login: logged-out. O resto passa como veio. */
export async function comLoginStatus(resposta, env, request) {
  const lista = typeof resposta.headers.getSetCookie === "function" ? resposta.headers.getSetCookie() : [];
  const da = lista.find((c) => c.startsWith(COOKIE + "="));
  if (!da) return resposta;
  const valor = da.slice(COOKIE.length + 1).split(";")[0].trim();
  const r = new Response(resposta.body, resposta);
  if (valor && !/Max-Age=0\b/i.test(da)) {
    r.headers.append("set-cookie", cookieFedcm(await ligarSessao(env, await sha256(valor))));
    r.headers.set("set-login", "logged-in");
  } else {
    const antigo = lerCookie(request, COOKIE_FEDCM);
    if (antigo && antigo.length <= 100) await env.CONTAS.delete(await chaveSessao(antigo));
    r.headers.append("set-cookie", cookieFedcmApagado);
    r.headers.set("set-login", "logged-out");
  }
  return r;
}

/* A sessao pelo cookie FedCM, ou null. */
async function sessaoFedCM(request, env) {
  const v = lerCookie(request, COOKIE_FEDCM);
  if (!v || v.length > 100) return null;
  const x = await kv(env, await chaveSessao(v));
  return x && x.h ? sessaoPorHash(env, x.h) : null;
}

// ------------------------------------------------------------------ as respostas

const JSON_H = { "content-type": "application/json; charset=utf-8" };
const publico = (dados) => new Response(JSON.stringify(dados), { headers: { ...JSON_H, "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
const daWebidentity = (request) => request.headers.get("sec-fetch-dest") === "webidentity";
/* CORS com credencial, so para a origem permitida (nunca "*"). */
const corsCom = (origem) => (origem ? { "access-control-allow-origin": origem, "access-control-allow-credentials": "true", vary: "origin" } : {});
/* Um erro do FedCM ({error: {code}}): o navegador mostra; o site recebe um IdentityCredentialError com o codigo. */
const erroFedCM = (code, status, origem) => json({ error: { code } }, status, corsCom(origem));

/* As origens de onde um acesso pode pedir pelo FedCM: as origens cadastradas e as dos enderecos de volta. Um acesso de
   programa (loopback) ou com volta por padrao (o PAVLVS de cada escritorio) so com origem cadastrada. */
export function origensDoCliente(cliente) {
  const s = new Set(Array.isArray(cliente.origens) ? cliente.origens : []);
  for (const v of cliente.voltas || []) {
    try {
      const u = new URL(v);
      if (u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]"))) s.add(u.origin);
    } catch { /* volta invalida: fica de fora */ }
  }
  return [...s];
}

/* O params do FedCM (texto JSON, ate 4 KB): {nonce, code_challenge, code_challenge_method, scope}. */
function lerParams(texto) {
  if (!texto) return {};
  if (texto.length > 4096) return null;
  try {
    const p = JSON.parse(texto);
    return p && typeof p === "object" && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

async function emitirCodigo(env, ped, sessao) {
  const codigo = aleatorio(32);
  await env.CONTAS.put("atos:codigo:" + (await sha256(codigo)), JSON.stringify({
    // Sem volta: o /oauth/token so aceita este codigo sem redirect_uri (e um codigo de volta nunca sem).
    clienteId: ped.clienteId, volta: "", fedcm: ped.origem, desafio: ped.desafio, nonce: ped.nonce, escopos: ped.escopos,
    sub: sessao.sub, email: sessao.email, auth_time: sessao.auth_time,
    ...(Array.isArray(sessao.amr) && sessao.amr.length ? { amr: sessao.amr } : {}),
  }), { expirationTtl: CODIGO_S });
  return codigo;
}

// ------------------------------------------------------------------ as rotas

export async function atenderFedCM(request, env, url, deps = {}) {
  const p = url.pathname;
  const agora = (deps.agora || Date.now)();
  const E = enderecosFedCM(env);

  if (p === "/.well-known/web-identity") {
    return publico({ provider_urls: [E.config], accounts_endpoint: E.contas, login_url: E.login });
  }
  if (p === "/fedcm/config.json") {
    return publico({
      accounts_endpoint: E.contas, client_metadata_endpoint: E.cliente, id_assertion_endpoint: E.afirmar, disconnect_endpoint: E.desconectar,
      login_url: E.login,
      branding: { background_color: "#131312", color: "#ffffff", icons: [{ url: E.icone, size: 128 }] },
    });
  }

  const reg = await registro(env);

  if (p === "/fedcm/cliente") {
    const id = (url.searchParams.get("client_id") || "").slice(0, 100);
    await comTerceiro(env, reg, appDoCliente(id));
    const c = clienteAtivo(reg, id);
    const app = c ? reg.apps[c.app] : null;
    if (!app) return json({ erro: "aplicativo desconhecido ou desligado" }, 404);
    return json({ privacy_policy_url: app.privacidade || "", terms_of_service_url: app.termos || "" }, 200, { "access-control-allow-origin": "*" });
  }

  if (p === "/fedcm/contas") {
    if (!daWebidentity(request)) return json({ erro: "só o navegador, pelo FedCM (Sec-Fetch-Dest: webidentity)" }, 400);
    const s = await sessaoFedCM(request, env);
    if (!s) return json({ erro: "ninguém dentro da Atos neste navegador" }, 401);
    // Os acessos dos aplicativos que a pessoa ja permitiu: o navegador mostra "Continuar como" sem o aviso de novo.
    const apps = await appsDe(env, s.sub);
    for (const id of Object.keys(apps)) if (ID_APP_TERCEIRO.test(id)) await comTerceiro(env, reg, id);
    const aprovados = Object.entries(reg.clientes)
      .filter(([id, c]) => clienteAtivo(reg, id) && Object.prototype.hasOwnProperty.call(apps, c.app) && permissaoVale(apps[c.app], reg.apps[c.app]))
      .map(([id]) => id);
    const nome = s.nome || s.email;
    return json({
      accounts: [{ id: s.sub, name: nome, given_name: nome.split(/\s+/)[0], email: s.email, approved_clients: aprovados, login_hints: [s.email] }],
    });
  }

  if (p === "/fedcm/afirmar" || p === "/fedcm/desconectar") {
    if (request.method !== "POST") return json({ erro: "use POST" }, 405);
    if (!daWebidentity(request)) return json({ erro: "só o navegador, pelo FedCM (Sec-Fetch-Dest: webidentity)" }, 400);
    if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return erroFedCM("temporarily_unavailable", 429, "");
    const origem = request.headers.get("origin") || "";
    let f;
    try {
      f = new URLSearchParams(await request.text());
    } catch {
      return erroFedCM("invalid_request", 400, "");
    }
    const clienteId = (f.get("client_id") || "").slice(0, 100);
    await comTerceiro(env, reg, appDoCliente(clienteId));
    const cliente = clienteAtivo(reg, clienteId);
    // A origem de quem pede tem de ser do acesso: senao, sem CORS (o site nao le nem o erro).
    if (!cliente || !origem || !origensDoCliente(cliente).includes(origem)) return erroFedCM(cliente ? "invalid_request" : "invalid_client", 400, "");
    const sessao = await sessaoFedCM(request, env);
    if (!sessao) return erroFedCM("login_required", 401, origem);
    const app = reg.apps[cliente.app];

    if (p === "/fedcm/desconectar") {
      // account_hint: o id (sub) ou o e-mail; outro valor ("*") desconecta a conta que esta dentro, que e a unica.
      const apps = await appsDe(env, sessao.sub);
      const tinha = Object.prototype.hasOwnProperty.call(apps, cliente.app) ? apps[cliente.app] : null;
      if (tinha) {
        delete apps[cliente.app];
        await env.CONTAS.put("atos:apps:" + sessao.sub, JSON.stringify(apps));
        if (ID_APP_TERCEIRO.test(cliente.app)) {
          const a = await appTerceiro(env, cliente.app);
          if (a && !(a.criado && tinha.quando && tinha.quando < a.criado)) await avisar(env, a, "acesso.revogado", { sub: sessao.sub }, agora);
        }
      }
      return json({ account_id: sessao.sub }, 200, corsCom(origem));
    }

    if ((f.get("account_id") || "") !== sessao.sub) return erroFedCM("invalid_request", 400, origem);
    const params = lerParams(f.get("params") || "");
    if (!params) return erroFedCM("invalid_request", 400, origem);
    // O nonce: em params (o jeito de agora) ou no campo nonce (o Chrome de antes do params); os dois, iguais.
    const nonceCampo = f.get("nonce") || "";
    const nonceParams = typeof params.nonce === "string" ? params.nonce : "";
    if (nonceCampo && nonceParams && nonceCampo !== nonceParams) return erroFedCM("invalid_request", 400, origem);
    const nonce = (nonceParams || nonceCampo).slice(0, 200);
    const desafio = typeof params.code_challenge === "string" ? params.code_challenge : "";
    if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(desafio)) return erroFedCM("invalid_request", 400, origem);
    const pedidos = typeof params.scope === "string" ? params.scope.split(/\s+/).filter(Boolean) : ["openid", "email", "profile"];
    const escopos = [...new Set(pedidos.filter((s) => ESCOPOS[s]))];
    if (!escopos.includes("openid")) return erroFedCM("invalid_scope", 400, origem);
    const ped = { clienteId, app: cliente.app, origem, escopos, nonce, desafio };
    const entrada = (resultado) => anotarEntrada(env, cliente.app, app, request, { resultado, sessao, escopos }, agora);

    // Quem pode entrar (o modo de acesso e a lista): fora, o site nao recebe nada.
    if (!podeEntrar(app, sessao)) {
      await entrada("recusado");
      return erroFedCM("access_denied", 403, origem);
    }
    const apps = await appsDe(env, sessao.sub);
    if (!jaPermitiu(apps, ped, reg)) {
      // A permissao e da Atos: a janela da Atos (continue_on) com a mesma tela do login de sempre.
      const id = aleatorio(24);
      await env.CONTAS.put(await chavePedido(id), JSON.stringify({ ...ped, sub: sessao.sub }), { expirationTtl: PEDIDO_S });
      return json({ continue_on: emissorDe(env) + "/entrar/?fedcm_pedido=" + id }, 200, corsCom(origem));
    }
    await entrada("entrou");
    return json({ token: await emitirCodigo(env, ped, sessao) }, 200, corsCom(origem));
  }

  // ------------------------------------------- as da pagina /entrar (a janela da Atos), so da propria origem
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);
  const sessao = await sessaoDe(request, env);
  if (!sessao) return json({ erro: "entre na sua conta" }, 401);

  if (p === "/api/fedcm/ligar") {
    // A janela do login_url com a sessao ja aberta (de antes do FedCM): o cookie dela e o logged-in.
    const h = await sha256(lerCookie(request, COOKIE));
    const r = json({ ok: true }, 200);
    r.headers.append("set-cookie", cookieFedcm(await ligarSessao(env, h)));
    r.headers.set("set-login", "logged-in");
    return r;
  }

  // /api/fedcm/continuar {pedido, permitir?}
  const d = (await lerJson(request)) || {};
  const id = String(d.pedido || "");
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) return json({ erro: "pedido inválido" }, 400);
  const chave = await chavePedido(id);
  const ped = await kv(env, chave);
  if (!ped) return json({ erro: "o pedido venceu: volte ao site e tente de novo" }, 400);
  if (ped.sub !== sessao.sub) return json({ erro: "a conta aberta na Atos não é a que foi escolhida: volte ao site e tente de novo" }, 409);
  await comTerceiro(env, reg, appDoCliente(ped.clienteId));
  const cliente = clienteAtivo(reg, ped.clienteId);
  if (!cliente || cliente.app !== ped.app) { await env.CONTAS.delete(chave); return json({ erro: "este aplicativo está desligado na Atos" }, 400); }
  const app = reg.apps[ped.app];
  const entrada = (resultado) => anotarEntrada(env, ped.app, app, request, { resultado, sessao, escopos: ped.escopos }, agora);
  const tela = {
    app: await comCadastrador(env, publicoDoApp(ped.app, reg), reg), origem: ped.origem,
    escopos: ped.escopos.map((s) => ({ id: s, texto: ESCOPOS[s] })), conta: { email: sessao.email, nome: sessao.nome },
  };
  // Tirada da lista entre a escolha da conta e a permissao: nada de codigo.
  if (!podeEntrar(app, sessao)) { await env.CONTAS.delete(chave); await entrada("recusado"); return json({ erro: "a sua Conta Atos não tem acesso a este aplicativo", negado: true, ...tela }, 403); }
  if (d.permitir === undefined) return json(tela);
  await env.CONTAS.delete(chave);
  if (d.permitir !== true) return json({ ok: true, negado: true });
  const apps = await appsDe(env, sessao.sub);
  const guardada = Object.prototype.hasOwnProperty.call(apps, ped.app) ? apps[ped.app] : null;
  const antes = permissaoVale(guardada, app) ? guardada : {};
  apps[ped.app] = { ...antes, escopos: [...new Set([...(antes.escopos || []), ...ped.escopos])], quando: new Date(agora).toISOString() };
  await env.CONTAS.put("atos:apps:" + sessao.sub, JSON.stringify(apps));
  await entrada("entrou");
  return json({ token: await emitirCodigo(env, ped, sessao) });
}
