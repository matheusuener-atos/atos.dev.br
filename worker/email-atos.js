// O e-mail Atos (Atos Workspace > E-mail Atos; a tela e public/assets/workspace-email.js): um endereco
// <alias>@atos.dev.br por conta, que ENCAMINHA o que chega para um endereco externo que o titular confirmou. Nao e caixa
// postal: a Atos nao guarda as mensagens, nao envia nem responde pelo alias, e nao garante a entrega.
//
// Como a mensagem chega aqui: o dominio atos.dev.br recebe pela Cloudflare Email Routing. As regras especificas do dono
// (contato@, master@, pagamentos@, naoresponda@, matheusuener@) continuam indo direto ao Gmail dele; o catch-all
// (configurado pelo dono: "Send to a Worker" -> atos) traz o resto para o handler email() deste Worker (receberEmail).
// Ele so encaminha (message.forward) para um destino VERIFICADO na conta Cloudflare: a Cloudflare exige isso, e a
// verificacao e dela (um e-mail da Cloudflare com o botao "Verify email address"). A Atos cria o destino pela API
// (POST /accounts/:conta/email/routing/addresses) com o token CF_EMAIL_TOKEN (segredo; permissao de conta "Email
// Routing Addresses: Edit") e consulta o "verified" depois. Sem o token (e sem CF_ACCOUNT_ID), o recurso nao esta ligado:
// as rotas respondem 503 dizendo isso. No Worker de teste (AMBIENTE "teste") com EMAIL_CF_SIMULADA "1", a Cloudflare e
// simulada (os destinos ficam no proprio objeto; "verificado" ao conferir; o codigo volta na resposta e nao sai e-mail).
//
// Alem da verificacao da Cloudflare, a Atos manda um codigo de 6 digitos ao destino (pelo Resend) e so liga com ele
// digitado: um endereco ja verificado na conta (o Gmail do dono, o destino de outra pessoa) nao vira destino de alguem
// que nao o controla.
//
// Os dados: um Durable Object so (EmailAtos, idFromName("registro"); o Worker de teste tem o seu), com consistencia
// forte. E ele que garante a unicidade (um pedido de cada vez: o alias e a conta sao conferidos e gravados no mesmo
// pedido), o limite de destinos, os contadores de frequencia e o registro. O KV nao entra: o handler nao tem sessao e
// pergunta ao objeto pelo alias (um pedido), e o Workspace ativo ao objeto do cliente (cobranca/cliente.js).
//
// Chaves no storage do objeto:
//   alias:<alias>     {alias, sub, conta (e-mail), criado, estado: "ligado"|"desligado", destino: null|{email, pedido,
//                      codigo_ok, cf_id, cf_ok, cf_pedido}, suspenso: null|{quando, motivo, por}, historico: [{quando, oque}]}
//   conta:<sub>       o alias da conta (um por conta)
//   destino:<email>   {cf_id, criado_pela_atos, aliases: [..]} (um destino pode servir a mais de um alias)
//   codigo:<alias>    {hash, destino, expira, tentativas}
//   quarentena:<alias> {sub, ate} um alias removido fica 30 dias sem poder ser de outra conta
//   cnt:<nome>        {n, ate} os contadores de frequencia
//   log:<iso>:<r>     {quando, alias, resultado, motivo, tamanho, de (so o dominio do remetente)} 30 dias
//   mud:<iso>:<r>     {quando, alias, oque, por} as mudancas (da pessoa e da equipe), 1 ano
//   sim:<email>       {id, verified} a Cloudflare simulada (so no teste)
//   ws:<sub>, ws-varredura, eq:<iso>:<r>   o indice do Atos Workspace e o registro da equipe (worker/workspace-indice.js)
//
// Rotas da tela (sessao da Conta Atos; mudar pede o Workspace ativo e login das ultimas 12 horas):
//   GET  /api/workspace/email                      o estado (alias, destino, passos, limites, vagas, disponivel)
//   GET  /api/workspace/email/disponivel?alias=    o nome vale e esta livre?
//   POST /api/workspace/email/alias                {alias} reserva o alias desta conta
//   POST /api/workspace/email/destino              {destino} pede o destino: o codigo da Atos e o e-mail da Cloudflare
//   POST /api/workspace/email/codigo               {codigo}
//   POST /api/workspace/email/conferir             consulta a Cloudflare (o destino ja foi verificado?)
//   POST /api/workspace/email/reenviar             {qual: "codigo"|"cloudflare"}
//   POST /api/workspace/email/ligar | /desligar
//   POST /api/workspace/email/remover              {confirmar: true}
// Painel da equipe (worker/admin.js; area "atos"; ver: todos; suspender, reativar e remover: dono e suporte):
//   GET  /api/admin/email                          os aliases, as vagas, os contadores
//   GET  /api/admin/email/registro?alias=          as entregas (30 dias) e as mudancas
//   POST /api/admin/email/:alias/suspender         {motivo}  | /reativar | /remover {confirmar: true, motivo?}

import { emailValido, json, lerJson, normal, sha256 } from "./comum.js";
import { sessaoDe } from "./contas.js";
import { enviarEmail as enviarPadrao, enderecoDeTeste } from "./email.js";
import { cliente, idDoCliente } from "./cobranca/cliente.js";
import { RETENCAO_EQUIPE_DIAS, ehOpDoIndice, fazerNoIndice } from "./workspace-indice.js";

export const DOMINIO = "atos.dev.br";
const RECENTE_H = 12;
export const LIMITES = {
  tamanho: 20 * 1024 * 1024, // bytes; a Cloudflare aceita ate 25 MiB na entrada
  por_hora: 60, // mensagens encaminhadas por alias, por hora
  por_dia: 300, // e por dia
  por_remetente_hora: 10, // do mesmo remetente para o mesmo alias, por hora
  auto_por_hora: 5, // automaticas (Auto-Submitted) por alias, por hora
  recebidos: 30, // cabecalhos Received acima disso: loop
  codigos_hora: 5, // codigos mandados por conta, por hora
  tentativas: 5, // tentativas de cada codigo
  codigo_min: 15,
  mudancas_hora: 30, // mudancas da pessoa por hora
};
const RETENCAO_LOG_DIAS = 30;
const RETENCAO_MUD_DIAS = 365;
const QUARENTENA_DIAS = 30;
const HISTORICO = 50;
// O teto de destinos da conta Cloudflare e 200 (contando os do dono). EMAIL_LIMITE_DESTINOS diz ate quantos a Atos
// enche (o padrao deixa 10 para o dono); acima disso o pedido de destino novo responde que as vagas acabaram.
export const TETO_CF = 200;
export const limiteDeDestinos = (env) => Math.max(0, Math.min(TETO_CF, Number(env.EMAIL_LIMITE_DESTINOS) || 190));

// A recusa e sempre a mesma (sem dizer se o alias existe, de quem e, nem para onde vai). So o tamanho, conferido antes
// de olhar o alias, tem texto proprio.
export const RECUSA = "Este endereço não recebe mensagens.";
export const RECUSA_TAMANHO = "Mensagem maior que o limite deste endereço (20 MB).";

// ------------------------------------------------------------------ nomes

// Os enderecos da propria Atos e os nomes de servico (RFC 2142 e os de costume), alem dos produtos.
export const RESERVADOS = new Set([
  "master", "contato", "pagamentos", "naoresponda", "matheusuener", "matheus", "admin", "administrador", "administracao",
  "suporte", "financeiro", "postmaster", "abuse", "noreply", "no-reply", "nao-responda", "hostmaster", "webmaster",
  "root", "security", "seguranca", "privacidade", "privacy", "dpo", "encarregado", "juridico", "legal", "cobranca",
  "vendas", "comercial", "atendimento", "ajuda", "help", "info", "informacoes", "mail", "email", "e-mail", "www", "ftp",
  "smtp", "imap", "pop", "pop3", "mx", "ns", "dns", "dmarc", "dkim", "spf", "bounce", "bounces", "mailer-daemon",
  "nobody", "ninguem", "workspace", "conta", "contas", "login", "entrar", "oauth", "api", "nfse", "notas", "nota",
  "fiscal", "equipe", "time", "staff", "teste", "test", "exemplo", "example", "sistema", "system", "sac", "ouvidoria",
  "imprensa", "rh", "marketing", "newsletter", "billing", "sales", "support", "team", "owner", "dono", "ceo",
  "contabilidade", "faturamento", "assinaturas", "alertas", "avisos", "status", "list", "lista", "listserv", "majordomo",
  "usenet", "news", "uucp", "operador", "operacoes", "ops", "devops", "dev", "desenvolvimento", "oficial", "atos",
]);
// Pedacos que nao podem aparecer em nenhum lugar do nome (se passar pela Atos, por um produto ou por um servico).
const PROIBIDOS_DENTRO = ["atos", "pavlvs", "paulus", "admin", "suporte", "oficial", "postmaster", "abuse", "naoresponda",
  "noreply", "cloudflare", "google", "gmail", "mercadopago", "mercadolivre", "microsoft", "outlook", "apple", "anthropic", "claude"];

/* O nome do alias: {alias} ou {erro}. 3 a 30 letras minusculas, numeros, ponto e hifen, sem comecar nem terminar
   com ponto ou hifen e sem dois seguidos. */
export function conferirAlias(bruto) {
  const a = String(bruto == null ? "" : bruto).trim().toLowerCase();
  if (!a) return { erro: "escolha um nome para o endereço" };
  if (a.length < 3 || a.length > 30) return { erro: "o nome precisa ter de 3 a 30 caracteres" };
  if (!/^[a-z0-9](?:[a-z0-9]|[.-](?=[a-z0-9])){2,29}$/.test(a)) {
    return { erro: "use só letras minúsculas sem acento, números, ponto e hífen (sem começar nem terminar com ponto ou hífen, nem dois seguidos)" };
  }
  const junto = a.replace(/[.-]/g, "");
  if (RESERVADOS.has(a) || RESERVADOS.has(junto)) return { erro: "esse nome é reservado: escolha outro" };
  if (PROIBIDOS_DENTRO.some((p) => junto.includes(p))) return { erro: "esse nome lembra a Atos, um produto dela ou outro serviço: escolha outro" };
  if (/^\d+$/.test(junto)) return { erro: "use pelo menos uma letra" };
  return { alias: a };
}

/* O destino: {destino} ou {erro}. */
export function conferirDestino(bruto, env) {
  const d = normal(bruto);
  if (!d) return { erro: "informe o endereço para onde encaminhar" };
  if (d.length > 90 || !emailValido(d)) return { erro: "esse endereço de e-mail não parece válido" };
  const dominio = d.split("@").pop();
  if (dominio === DOMINIO || dominio.endsWith("." + DOMINIO)) return { erro: "o destino precisa ser um endereço fora da Atos (o seu Gmail, Outlook, o e-mail do seu domínio)" };
  if (enderecoDeTeste(d) && !simulada(env)) return { erro: "esse domínio é reservado para testes" };
  return { destino: d };
}

// ------------------------------------------------------------------ a Cloudflare

export function simulada(env) {
  return Boolean(env && env.AMBIENTE === "teste" && String(env.EMAIL_CF_SIMULADA || "") === "1");
}
/* O recurso esta ligado neste Worker? (o token e a conta, ou a simulada do teste) */
export function emailAtosLigado(env) {
  return Boolean(env && env.EMAIL_ATOS && (simulada(env) || (env.CF_EMAIL_TOKEN && env.CF_ACCOUNT_ID)));
}

/* A API de destinos da Cloudflare (ou a simulada). Cada metodo devolve {ok, ...} e nunca lanca. */
function cloudflare(env, deps) {
  if (simulada(env)) {
    const pedir = (op, dados) => registro(env).pedir(op, dados);
    return {
      criar: (email) => pedir("sim_criar", { email }),
      ler: (id) => pedir("sim_ler", { id }),
      apagar: (id) => pedir("sim_apagar", { id }),
      total: () => pedir("sim_total", {}),
    };
  }
  const buscar = deps.fetch || fetch;
  const base = "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(env.CF_ACCOUNT_ID) + "/email/routing/addresses";
  async function chamar(metodo, caminho, corpo) {
    try {
      const r = await buscar(base + caminho, {
        method: metodo, headers: { Authorization: "Bearer " + env.CF_EMAIL_TOKEN, "content-type": "application/json" },
        ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      });
      const d = await r.json().catch(() => null);
      return { status: r.status, ok: r.ok && Boolean(d && d.success), d: d || {} };
    } catch {
      return { status: 0, ok: false, d: {} };
    }
  }
  const vista = (x) => ({ id: String(x.id || x.tag || ""), email: normal(x.email), verificado: x.verified || null });
  async function achar(email) {
    for (let pagina = 1; pagina <= 10; pagina++) {
      const r = await chamar("GET", "?per_page=50&page=" + pagina);
      if (!r.ok) return { ok: false };
      const l = Array.isArray(r.d.result) ? r.d.result : [];
      const x = l.find((y) => normal(y.email) === email);
      if (x) return { ok: true, ...vista(x) };
      if (l.length < 50) return { ok: true, id: "" };
    }
    return { ok: true, id: "" };
  }
  return {
    async criar(email) {
      const r = await chamar("POST", "", { email });
      if (r.ok && r.d.result) return { ok: true, criado: true, ...vista(r.d.result) };
      // Ja existe na conta (de outra pessoa, ou do dono): usa o que esta la, sem criar outro.
      const x = await achar(email);
      if (x.ok && x.id) return { ok: true, criado: false, id: x.id, verificado: x.verificado };
      return { ok: false, status: r.status };
    },
    async ler(id) {
      const r = await chamar("GET", "/" + encodeURIComponent(id));
      if (r.ok && r.d.result) return { ok: true, ...vista(r.d.result) };
      return { ok: false, status: r.status, sumiu: r.status === 404 };
    },
    async apagar(id) {
      const r = await chamar("DELETE", "/" + encodeURIComponent(id));
      return { ok: r.ok || r.status === 404 };
    },
    async total() {
      const r = await chamar("GET", "?per_page=50&page=1");
      if (!r.ok) return { ok: false };
      const info = r.d.result_info || {};
      const n = Number(info.total_count);
      return { ok: true, total: Number.isFinite(n) ? n : (Array.isArray(r.d.result) ? r.d.result.length : 0) };
    },
  };
}

// ------------------------------------------------------------------ o objeto

export function registro(env) {
  const stub = env.EMAIL_ATOS.get(env.EMAIL_ATOS.idFromName("registro"));
  return {
    async pedir(op, dados = {}) {
      const r = await stub.fetch("https://email-atos/", { method: "POST", body: JSON.stringify({ op, ...dados }) });
      return r.json();
    },
  };
}

const sorteio = () => [...crypto.getRandomValues(new Uint8Array(4))].map((x) => x.toString(16).padStart(2, "0")).join("");
const ate = (agora, s) => new Date(agora + s * 1000).toISOString();

export class EmailAtos {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    let d;
    try {
      d = await request.json();
    } catch {
      return Response.json({ ok: false, erro: "pedido inválido" }, { status: 400 });
    }
    try {
      return Response.json(await this.fazer(d, typeof d.agora === "number" ? d.agora : Date.now()));
    } catch (e) {
      return Response.json({ ok: false, erro: String((e && e.message) || e) }, { status: 500 });
    }
  }

  async contar(nome, janelaS, agora, limite) {
    const s = this.ctx.storage;
    const k = "cnt:" + nome;
    let c = await s.get(k);
    if (!c || Date.parse(c.ate) <= agora) c = { n: 0, ate: ate(agora, janelaS) };
    if (c.n >= limite) return false;
    c.n++;
    await s.put(k, c);
    return true;
  }

  async log(item, agora) {
    await this.ctx.storage.put("log:" + new Date(agora).toISOString() + ":" + sorteio(), { quando: new Date(agora).toISOString(), ...item });
    await this.limpezaMarcada(agora);
  }
  async mudanca(alias, oque, por, agora) {
    await this.ctx.storage.put("mud:" + new Date(agora).toISOString() + ":" + sorteio(), { quando: new Date(agora).toISOString(), alias, oque, por });
    await this.limpezaMarcada(agora);
  }
  async limpezaMarcada(agora) {
    const s = this.ctx.storage;
    if (typeof s.getAlarm === "function" && !(await s.getAlarm())) await s.setAlarm(agora + 6 * 3600 * 1000);
  }

  /* A limpeza: o registro de entregas (30 dias), as mudancas (1 ano), os contadores e a quarentena vencidos. */
  async alarm() {
    const s = this.ctx.storage;
    const agora = Date.now();
    await this.limpar(agora);
    const resta = (await s.list({ prefix: "log:", limit: 1 })).size + (await s.list({ prefix: "mud:", limit: 1 })).size + (await s.list({ prefix: "cnt:", limit: 1 })).size +
      (await s.list({ prefix: "eq:", limit: 1 })).size;
    if (resta) await s.setAlarm(agora + 6 * 3600 * 1000);
  }
  async limpar(agora) {
    const s = this.ctx.storage;
    const corte = (dias) => new Date(agora - dias * 864e5).toISOString();
    const apagar = [];
    for (const [k] of await s.list({ prefix: "log:" })) if (k.slice(4, 28) < corte(RETENCAO_LOG_DIAS)) apagar.push(k);
    for (const [k] of await s.list({ prefix: "mud:" })) if (k.slice(4, 28) < corte(RETENCAO_MUD_DIAS)) apagar.push(k);
    for (const [k] of await s.list({ prefix: "eq:" })) if (k.slice(3, 27) < corte(RETENCAO_EQUIPE_DIAS)) apagar.push(k);
    for (const [k, v] of await s.list({ prefix: "cnt:" })) if (!v || Date.parse(v.ate) <= agora) apagar.push(k);
    for (const [k, v] of await s.list({ prefix: "quarentena:" })) if (!v || Date.parse(v.ate) <= agora) apagar.push(k);
    for (const [k, v] of await s.list({ prefix: "codigo:" })) if (!v || Date.parse(v.expira) <= agora) apagar.push(k);
    for (let i = 0; i < apagar.length; i += 128) await s.delete(apagar.slice(i, i + 128));
    return apagar.length;
  }

  async doAlias(alias) { return (await this.ctx.storage.get("alias:" + alias)) || null; }
  async daConta(sub) {
    const a = await this.ctx.storage.get("conta:" + sub);
    return a ? this.doAlias(a) : null;
  }
  async guardar(r, oque, por, agora) {
    const quando = new Date(agora).toISOString();
    r.historico = [...(r.historico || []), { quando, oque }].slice(-HISTORICO);
    r.atualizado = quando;
    await this.ctx.storage.put("alias:" + r.alias, r);
    await this.mudanca(r.alias, oque, por, agora);
    return r;
  }
  /* Tira um alias de um destino; devolve o id da Cloudflare para apagar se ninguem mais usa e foi a Atos que criou. */
  async soltarDestino(alias, email) {
    const s = this.ctx.storage;
    if (!email) return null;
    const d = await s.get("destino:" + email);
    if (!d) return null;
    d.aliases = (d.aliases || []).filter((x) => x !== alias);
    if (d.aliases.length) { await s.put("destino:" + email, d); return null; }
    await s.delete("destino:" + email);
    return d.criado_pela_atos && d.cf_id ? d.cf_id : null;
  }
  async vagas() {
    let usadas = 0;
    for (const [, d] of await this.ctx.storage.list({ prefix: "destino:" })) if (d && d.criado_pela_atos) usadas++;
    return usadas;
  }

  async fazer(d, agora) {
    const s = this.ctx.storage;
    const quando = new Date(agora).toISOString();
    const alias = String(d.alias || "");
    switch (d.op) {
      case "ver": {
        const r = d.sub ? await this.daConta(d.sub) : await this.doAlias(alias);
        return { ok: true, alias: r, vagas: { usadas: await this.vagas() } };
      }
      case "livre": {
        const r = await this.doAlias(alias);
        const q = await s.get("quarentena:" + alias);
        const livre = (!r || r.sub === d.sub) && (!q || q.sub === d.sub || Date.parse(q.ate) <= agora);
        return { ok: true, livre };
      }
      case "reservar": {
        if (!(await this.contar("mud:" + d.sub, 3600, agora, LIMITES.mudancas_hora))) return { ok: false, erro: "muitas mudanças seguidas: espere um pouco", status: 429 };
        const meu = await this.daConta(d.sub);
        if (meu && meu.alias === alias) return { ok: true, alias: meu, repetido: true };
        if (meu) return { ok: false, erro: "esta conta já tem o endereço " + meu.alias + "@" + DOMINIO + ": remova-o para escolher outro", status: 409 };
        const outro = await this.doAlias(alias);
        const q = await s.get("quarentena:" + alias);
        if (outro || (q && q.sub !== d.sub && Date.parse(q.ate) > agora)) return { ok: false, erro: "esse endereço não está disponível: escolha outro", status: 409 };
        const r = { alias, sub: d.sub, conta: d.conta || "", criado: quando, estado: "desligado", destino: null, suspenso: null, historico: [] };
        await s.put("conta:" + d.sub, alias);
        await s.delete("quarentena:" + alias);
        return { ok: true, alias: await this.guardar(r, "reservou " + alias + "@" + DOMINIO, d.conta || "", agora) };
      }
      case "destino_pedir": {
        // O destino novo (ou o mesmo de novo): desliga o encaminhamento ate o codigo e a Cloudflare confirmarem.
        const r = await this.daConta(d.sub);
        if (!r) return { ok: false, erro: "escolha o endereço primeiro", status: 409 };
        if (r.suspenso) return { ok: false, erro: "a Atos suspendeu este endereço" + (r.suspenso.motivo ? " (" + r.suspenso.motivo + ")" : "") + ": escreva para contato@atos.dev.br", status: 403 };
        if (!(await this.contar("codigo:" + d.sub, 3600, agora, LIMITES.codigos_hora))) return { ok: false, erro: "muitos códigos pedidos nesta hora: espere um pouco", status: 429 };
        const email = String(d.destino || "");
        const antes = r.destino && r.destino.email;
        const conhecido = await s.get("destino:" + email);
        // Destino que a Atos ainda nao usa e que vai virar um destino novo na Cloudflare: o teto de vagas.
        if (!conhecido && d.limite !== undefined && (await this.vagas()) >= d.limite) {
          return { ok: false, erro: "as vagas do e-mail Atos acabaram por enquanto (a Cloudflare limita os destinos de cada conta). O seu endereço continua reservado.", status: 409, esgotado: true };
        }
        let soltar = null;
        if (antes && antes !== email) soltar = await this.soltarDestino(r.alias, antes);
        r.estado = "desligado";
        r.destino = { email, pedido: quando, codigo_ok: null, cf_id: conhecido ? conhecido.cf_id : null, cf_ok: null, cf_pedido: null };
        await s.put("codigo:" + r.alias, { hash: d.hash, destino: email, expira: ate(agora, LIMITES.codigo_min * 60), tentativas: 0 });
        return { ok: true, alias: await this.guardar(r, (antes && antes !== email ? "trocou o destino" : "pediu o destino") + " (encaminhamento desligado até confirmar)", r.conta, agora), soltar };
      }
      case "codigo_novo": {
        const r = await this.daConta(d.sub);
        if (!r || !r.destino || r.destino.codigo_ok) return { ok: false, erro: "não há código para mandar agora", status: 409 };
        if (!(await this.contar("codigo:" + d.sub, 3600, agora, LIMITES.codigos_hora))) return { ok: false, erro: "muitos códigos pedidos nesta hora: espere um pouco", status: 429 };
        await s.put("codigo:" + r.alias, { hash: d.hash, destino: r.destino.email, expira: ate(agora, LIMITES.codigo_min * 60), tentativas: 0 });
        return { ok: true, alias: r };
      }
      case "codigo_conferir": {
        const r = await this.daConta(d.sub);
        const c = r ? await s.get("codigo:" + r.alias) : null;
        if (!r || !r.destino || !c || c.destino !== r.destino.email) return { ok: false, erro: "peça um código novo", status: 409 };
        if (Date.parse(c.expira) <= agora) { await s.delete("codigo:" + r.alias); return { ok: false, erro: "o código venceu: peça outro", status: 410 }; }
        if (c.tentativas >= LIMITES.tentativas) { await s.delete("codigo:" + r.alias); return { ok: false, erro: "tentativas demais: peça outro código", status: 429 }; }
        if (c.hash !== d.hash) { c.tentativas++; await s.put("codigo:" + r.alias, c); return { ok: false, erro: "código errado", status: 400 }; }
        await s.delete("codigo:" + r.alias);
        r.destino.codigo_ok = quando;
        return { ok: true, alias: await this.guardar(r, "confirmou o código do destino", r.conta, agora) };
      }
      case "destino_cf": {
        // O que a Cloudflare disse do destino (criado agora, ja existia, verificado ou nao).
        const r = await this.daConta(d.sub);
        if (!r || !r.destino || r.destino.email !== d.email) return { ok: false, erro: "o destino mudou: confira de novo", status: 409 };
        const k = "destino:" + d.email;
        const dest = (await s.get(k)) || { cf_id: d.cf_id || null, criado_pela_atos: Boolean(d.criado), aliases: [] };
        if (d.cf_id) dest.cf_id = d.cf_id;
        // Apagado na Cloudflare (por fora): sem id, e sem a verificacao.
        if (d.sumiu) dest.cf_id = null;
        if (d.criado) dest.criado_pela_atos = true;
        if (!dest.aliases.includes(r.alias)) dest.aliases.push(r.alias);
        await s.put(k, dest);
        const antes = Boolean(r.destino.cf_ok);
        r.destino.cf_id = dest.cf_id || null;
        if (d.pedido) r.destino.cf_pedido = quando;
        r.destino.cf_ok = d.verificado ? r.destino.cf_ok || quando : null;
        if (!r.destino.cf_ok && r.estado === "ligado") r.estado = "desligado";
        if (!antes && r.destino.cf_ok) return { ok: true, alias: await this.guardar(r, "a Cloudflare confirmou o destino", r.conta, agora) };
        r.atualizado = quando;
        await s.put("alias:" + r.alias, r);
        return { ok: true, alias: r };
      }
      case "ligar":
      case "desligar": {
        const r = await this.daConta(d.sub);
        if (!r) return { ok: false, erro: "esta conta não tem endereço", status: 404 };
        if (d.op === "ligar") {
          if (r.suspenso) return { ok: false, erro: "a Atos suspendeu este endereço" + (r.suspenso.motivo ? " (" + r.suspenso.motivo + ")" : "") + ": escreva para contato@atos.dev.br", status: 403 };
          if (!r.destino || !r.destino.codigo_ok || !r.destino.cf_ok) return { ok: false, erro: "confirme o destino antes de ligar (o código da Atos e o e-mail da Cloudflare)", status: 409 };
        }
        const novo = d.op === "ligar" ? "ligado" : "desligado";
        if (r.estado === novo) return { ok: true, alias: r, repetido: true };
        r.estado = novo;
        return { ok: true, alias: await this.guardar(r, d.op === "ligar" ? "ligou o encaminhamento" : "desligou o encaminhamento", r.conta, agora) };
      }
      case "remover": {
        // Pela pessoa (sub) ou pela equipe (alias). O alias fica em quarentena (30 dias) para nao ir a outra conta.
        const r = d.sub ? await this.daConta(d.sub) : await this.doAlias(alias);
        if (!r) return { ok: true, repetido: true, soltar: null };
        const soltar = await this.soltarDestino(r.alias, r.destino && r.destino.email);
        await s.delete("alias:" + r.alias);
        await s.delete("conta:" + r.sub);
        await s.delete("codigo:" + r.alias);
        await s.put("quarentena:" + r.alias, { sub: r.sub, ate: ate(agora, QUARENTENA_DIAS * 86400) });
        await this.mudanca(r.alias, d.por ? "a equipe removeu o endereço" + (d.motivo ? " (" + d.motivo + ")" : "") : "removeu o endereço", d.por || r.conta, agora);
        return { ok: true, removido: r.alias, soltar };
      }
      case "suspender":
      case "reativar": {
        const r = await this.doAlias(alias);
        if (!r) return { ok: false, erro: "esse endereço não existe", status: 404 };
        if (d.op === "suspender") {
          r.suspenso = { quando, motivo: String(d.motivo || "").slice(0, 200), por: d.por || "" };
          r.estado = "desligado";
          return { ok: true, alias: await this.guardar(r, "a Atos suspendeu o endereço" + (r.suspenso.motivo ? " (" + r.suspenso.motivo + ")" : ""), d.por || "", agora) };
        }
        if (!r.suspenso) return { ok: true, alias: r, repetido: true };
        r.suspenso = null;
        return { ok: true, alias: await this.guardar(r, "a Atos tirou a suspensão (o encaminhamento continua desligado até a pessoa ligar)", d.por || "", agora) };
      }
      case "entrega": {
        // A mensagem que chegou: encaminhar (o destino e o sub, para o Worker conferir o Workspace) ou recusar.
        // Conta e registra aqui; o Worker registra o resultado do Workspace e do forward (op "registrar").
        const base = { alias: alias || "?", tamanho: Number(d.tamanho) || 0, de: String(d.dominio || "").slice(0, 100) };
        const recusar = async (motivo) => { await this.log({ ...base, resultado: "recusado", motivo }, agora); return { ok: true, acao: "recusar", motivo }; };
        const r = alias ? await this.doAlias(alias) : null;
        if (!r) {
          // Endereco que nao existe: so um contador por dia (o spam a nomes inventados nao enche o registro).
          await this.contar("inexistente:" + quando.slice(0, 10), 86400 * 2, agora, Number.MAX_SAFE_INTEGER);
          return { ok: true, acao: "recusar", motivo: "inexistente" };
        }
        if (d.loop) return recusar("loop");
        if (r.suspenso) return recusar("suspenso");
        if (r.estado !== "ligado") return recusar("desligado");
        if (!r.destino || !r.destino.codigo_ok || !r.destino.cf_ok) return recusar("destino_nao_verificado");
        if (d.auto && !(await this.contar("auto:" + alias, 3600, agora, LIMITES.auto_por_hora))) return recusar("limite_automaticas");
        if (d.remetente && !(await this.contar("rem:" + alias + ":" + d.remetente, 3600, agora, LIMITES.por_remetente_hora))) return recusar("limite_remetente");
        if (!(await this.contar("hora:" + alias, 3600, agora, LIMITES.por_hora))) return recusar("limite_hora");
        if (!(await this.contar("dia:" + alias, 86400, agora, LIMITES.por_dia))) return recusar("limite_dia");
        return { ok: true, acao: "encaminhar", destino: r.destino.email, sub: r.sub };
      }
      case "destino_ler": {
        const x = await s.get("destino:" + normal(d.email));
        return x ? { ok: true, cf_id: x.cf_id || null, criado_pela_atos: Boolean(x.criado_pela_atos), aliases: x.aliases || [] } : { ok: true, cf_id: null, aliases: [] };
      }
      case "registrar":
        await this.log({ alias: alias || "?", tamanho: Number(d.tamanho) || 0, de: String(d.dominio || "").slice(0, 100), resultado: String(d.resultado || ""), motivo: String(d.motivo || "") }, agora);
        return { ok: true };
      case "painel": {
        const aliases = [...(await s.list({ prefix: "alias:" })).values()].map((r) => ({ ...r, historico: undefined, ultimas: (r.historico || []).slice(-5) }));
        const contadores = {};
        for (const [k, v] of await s.list({ prefix: "cnt:inexistente:" })) contadores[k.slice(16)] = v.n;
        return { ok: true, aliases, vagas: { usadas: await this.vagas() }, inexistentes: contadores };
      }
      case "painel_log": {
        const l = [];
        for (const [, v] of await s.list({ prefix: "log:", reverse: true, limit: alias ? 2000 : 300 })) if (!alias || v.alias === alias) l.push(v);
        const m = [];
        for (const [, v] of await s.list({ prefix: "mud:", reverse: true, limit: alias ? 2000 : 300 })) if (!alias || v.alias === alias) m.push(v);
        return { ok: true, entregas: l.slice(0, 300), mudancas: m.slice(0, 300) };
      }
      case "limpar":
        return { ok: true, apagados: await this.limpar(agora) };
      // A Cloudflare simulada (so no Worker de teste): os destinos ficam aqui; "verificado" na primeira consulta.
      case "sim_criar": {
        const k = "sim:" + normal(d.email);
        const x = await s.get(k);
        if (x) return { ok: true, criado: false, id: x.id, verificado: x.verified };
        const novo = { id: "sim" + sorteio() + sorteio(), email: normal(d.email), verified: null };
        await s.put(k, novo);
        await s.put("simid:" + novo.id, novo.email);
        return { ok: true, criado: true, id: novo.id, verificado: null };
      }
      case "sim_ler": {
        const email = await s.get("simid:" + d.id);
        const x = email ? await s.get("sim:" + email) : null;
        if (!x) return { ok: false, sumiu: true };
        if (!x.verified) { x.verified = quando; await s.put("sim:" + email, x); }
        return { ok: true, id: x.id, verificado: x.verified };
      }
      case "sim_apagar": {
        const email = await s.get("simid:" + d.id);
        if (email) { await s.delete("sim:" + email); await s.delete("simid:" + d.id); }
        return { ok: true };
      }
      case "sim_total":
        return { ok: true, total: (await s.list({ prefix: "sim:" })).size };
      default:
        // O indice do Atos Workspace e o registro da equipe (worker/workspace-indice.js) moram neste mesmo objeto.
        if (ehOpDoIndice(d.op)) return fazerNoIndice(this, d, agora);
        return { ok: false, erro: "op desconhecida" };
    }
  }
}

// ------------------------------------------------------------------ o alias como login e como requisito

/* O alias de uma conta como o login, o Workspace e a tela de permissao o veem: null ou {alias, endereco, sub, conta,
   suspenso, confirmado (o codigo da Atos e a Cloudflare)}. */
function resumoDoAlias(r) {
  if (!r || !r.alias || !r.sub) return null;
  return {
    alias: r.alias, endereco: r.alias + "@" + DOMINIO, sub: r.sub, conta: r.conta || "", suspenso: Boolean(r.suspenso),
    confirmado: Boolean(r.destino && r.destino.codigo_ok && r.destino.cf_ok),
  };
}

/* O alias da conta `sub` (removido nao existe mais: null). Sem o registro (EMAIL_ATOS) neste Worker: null. Lanca se o
   objeto nao responde (quem chama responde 503, nunca "sem alias" por engano). */
export async function aliasDaConta(env, sub) {
  if (!env || !env.EMAIL_ATOS || !sub) return null;
  const v = await registro(env).pedir("ver", { sub });
  if (!v || !v.ok) throw new Error("o registro do e-mail Atos não respondeu");
  return resumoDoAlias(v.alias);
}

/* Para onde a Atos manda os avisos do Workspace ao titular (os formularios, worker/formularios.js; a pagina de status,
   worker/status.js): o destino confirmado do alias da conta. {pronto: true, endereco, destino} so com o alias existindo,
   sem suspensao, com o destino confirmado (o codigo e a Cloudflare) e o encaminhamento ligado; senao {pronto: false,
   motivo: "sem_alias"|"alias_suspenso"|"alias_nao_confirmado"|"alias_desligado"}. Lanca se o objeto nao responde. */
export async function destinoDoTitular(env, sub) {
  if (!env || !env.EMAIL_ATOS || !sub) return { pronto: false, motivo: "sem_alias" };
  const v = await registro(env).pedir("ver", { sub });
  if (!v || !v.ok) throw new Error("o registro do e-mail Atos não respondeu");
  const r = v.alias;
  if (!r || r.sub !== sub) return { pronto: false, motivo: "sem_alias" };
  const endereco = r.alias + "@" + DOMINIO;
  if (r.suspenso) return { pronto: false, motivo: "alias_suspenso", endereco };
  if (!(r.destino && r.destino.codigo_ok && r.destino.cf_ok)) return { pronto: false, motivo: "alias_nao_confirmado", endereco };
  if (r.estado !== "ligado") return { pronto: false, motivo: "alias_desligado", endereco };
  return { pronto: true, endereco, destino: r.destino.email };
}

/* O nome e o de uma pagina de links (atos.dev.br/@<nome>; worker/links.js) de outra conta? Pergunta ao indice do
   Workspace (WorkspaceDados "indice", op lpag_dono). Sem o objeto ou sem resposta: false (o nome com ponto nunca e de
   pagina). */
async function paginaDeLinksDeOutro(env, nome, sub) {
  if (!env || !env.WS_DADOS || !/^[a-z0-9-]{3,30}$/.test(nome)) return false;
  try {
    const r = await env.WS_DADOS.get(env.WS_DADOS.idFromName("indice")).fetch("https://ws-dados/", { method: "POST", body: JSON.stringify({ op: "lpag_dono", nome }) });
    const d = await r.json();
    return Boolean(d && d.ok && d.dono && d.dono.sub !== sub);
  } catch {
    return false;
  }
}

/* O endereco e um <alias>@atos.dev.br bem formado? Devolve o alias ou "". */
export function aliasDoTexto(endereco) {
  const e = normal(endereco);
  const at = e.lastIndexOf("@");
  if (at < 1 || e.slice(at + 1) !== DOMINIO) return "";
  return conferirAlias(e.slice(0, at)).alias || "";
}

/* O login pelo endereco Atos: o alias que existe e nao esta suspenso ({alias, endereco, sub, conta, ...}); senao null
   (inexistente, removido, suspenso ou fora do formato: o login responde o mesmo que a senha errada). Lanca se o objeto
   nao responde. */
export async function aliasParaEntrar(env, endereco) {
  const alias = aliasDoTexto(endereco);
  if (!alias || !env || !env.EMAIL_ATOS) return null;
  const v = await registro(env).pedir("ver", { alias });
  if (!v || !v.ok) throw new Error("o registro do e-mail Atos não respondeu");
  const r = resumoDoAlias(v.alias);
  return r && !r.suspenso && r.alias === alias ? r : null;
}

// ------------------------------------------------------------------ o handler de e-mail

/* O remetente do envelope e um hash curto (para o limite por remetente sem guardar o endereco). */
async function remetente(from) {
  const e = normal(from);
  const dominio = e.includes("@") ? e.split("@").pop() : "";
  return { dominio, hash: e ? (await sha256("rem:" + e)).slice(0, 16) : "" };
}

/* Chegou uma mensagem a <alias>@atos.dev.br (o catch-all da Cloudflare -> este Worker). Nunca responde: encaminha ao
   destino confirmado ou recusa na entrega (setReject: erro SMTP permanente, sem mensagem de volta da Atos). */
export async function receberEmail(message, env, ctx, deps = {}) {
  const tamanho = Number(message.rawSize) || 0;
  const recusar = (texto = RECUSA) => message.setReject(texto);
  if (!env.EMAIL_ATOS) return recusar();
  if (tamanho > LIMITES.tamanho) return recusar(RECUSA_TAMANHO);
  const para = normal(message.to);
  const at = para.lastIndexOf("@");
  if (at < 1 || para.slice(at + 1) !== DOMINIO) return recusar();
  // O "+qualquer" (subendereco) vai para o mesmo alias.
  const alias = para.slice(0, at).split("+")[0];
  if (!conferirAlias(alias).alias) {
    // Nome fora do formato (ou reservado sem regra propria): nem pergunta ao objeto.
    return recusar();
  }
  const h = message.headers;
  // Os Received chegam juntos num get() (separados por virgula; o getAll dos Workers so aceita Set-Cookie): cada um
  // comeca com "from" ou "by".
  const todos = String(h.get("received") || "");
  const recebidos = todos ? todos.split(/,\s*(?=(?:from|by)\s)/i).length : 0;
  const de = await remetente(message.from);
  const loop = Boolean(h.get("x-atos-encaminhado")) || recebidos > LIMITES.recebidos || normal(message.from) === para;
  const auto = (h.get("auto-submitted") || "no").trim().toLowerCase() !== "no";
  const reg = registro(env);
  const anotar = (resultado, motivo) => reg.pedir("registrar", { alias, tamanho, dominio: de.dominio, resultado, motivo }).catch(() => null);
  let r;
  try {
    r = await reg.pedir("entrega", { alias, tamanho, dominio: de.dominio, remetente: de.hash, loop, auto });
  } catch {
    return recusar();
  }
  if (!r || r.acao !== "encaminhar") return recusar();
  // O Workspace ativo, no registro forte do cliente (desativado: o e-mail Atos para de encaminhar).
  let ativo = false;
  try {
    const c = await cliente(env, await idDoCliente(r.sub)).pedir("direito", { produto: "workspace" });
    ativo = Boolean(c && c.ok && c.direito && c.direito.ativo);
  } catch {
    await anotar("falha", "workspace_fora");
    return recusar();
  }
  if (!ativo) { await anotar("recusado", "sem_workspace"); return recusar(); }
  try {
    await message.forward(r.destino, new Headers({ "X-Atos-Encaminhado": alias + "@" + DOMINIO }));
  } catch {
    await anotar("falha", "forward");
    return recusar();
  }
  await anotar("encaminhado", "");
}

// ------------------------------------------------------------------ as rotas da tela

export function ehRotaDoEmailAtos(url) {
  return url.pathname === "/api/workspace/email" || url.pathname.startsWith("/api/workspace/email/");
}

const DESLIGADO = () => json({ erro: "o e-mail Atos ainda não está ligado na Atos", disponivel: false }, 503);
const FORA = () => json({ erro: "não deu para falar com o registro do e-mail Atos agora: tente de novo em instantes" }, 503);
const codigoAleatorio = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
const hashDoCodigo = (alias, codigo) => sha256("email-atos:" + alias + ":" + codigo);

/* O Workspace da conta: {ativo, suspenso: null|{quando, motivo}} (a suspensao e da equipe: worker/admin-workspace.js). */
async function workspaceDaConta(env, sub) {
  const r = await cliente(env, await idDoCliente(sub)).pedir("direito", { produto: "workspace" });
  if (!r || !r.ok) throw new Error("registro do cliente fora");
  const d = r.direito;
  return { ativo: Boolean(d && d.ativo), suspenso: d && d.suspenso ? { quando: d.suspenso.quando, motivo: d.suspenso.motivo || "" } : null };
}

/* O que a tela ve do alias: sem o cf_id e sem o historico inteiro. */
function vistaDoAlias(r) {
  if (!r) return null;
  const d = r.destino;
  return {
    alias: r.alias, endereco: r.alias + "@" + DOMINIO, criado: r.criado, estado: r.estado,
    destino: d ? { email: d.email, pedido: d.pedido, codigo_ok: d.codigo_ok, cf_ok: d.cf_ok, cf_pedido: d.cf_pedido || null, na_cf: Boolean(d.cf_id) } : null,
    suspenso: r.suspenso ? { quando: r.suspenso.quando, motivo: r.suspenso.motivo } : null,
    historico: (r.historico || []).slice(-10).reverse(),
  };
}

export async function atenderEmailAtos(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  const sessao = await sessaoDe(request, env);
  if (!sessao) return json({ erro: "entre na sua conta", entrar: true }, 401);
  if (!env.EMAIL_ATOS || !env.CLIENTES) return FORA();
  const reg = registro(env);
  const pedir = (op, dados = {}) => reg.pedir(op, { agora, sub: sessao.sub, conta: sessao.email, ...dados });
  const recente = agora / 1000 - sessao.auth_time < RECENTE_H * 3600;
  const ligado = emailAtosLigado(env);
  const cf = cloudflare(env, deps);
  const enviar = deps.enviarEmail || enviarPadrao;
  const p = url.pathname;
  let ativo, suspenso;
  try { ({ ativo, suspenso } = await workspaceDaConta(env, sessao.sub)); } catch { return FORA(); }

  const tela = async (r, extra = {}) => {
    if (r === undefined) {
      const v = await pedir("ver");
      if (!v || !v.ok) return FORA();
      r = v.alias;
      extra = { vagas: v.vagas, ...extra };
    }
    return json({
      // entrou_pelo_alias: a sessao foi aberta por este alias (o Workspace pede isso para as Integracoes).
      entrou_pelo_alias: Boolean(r && sessao.via === "alias" && sessao.alias === r.alias),
      disponivel: ligado, simulada: simulada(env), workspace: ativo, workspace_suspenso: suspenso, recente, limites: { recente_h: RECENTE_H, tamanho_mb: LIMITES.tamanho / 1048576, por_hora: LIMITES.por_hora,
        por_dia: LIMITES.por_dia, por_remetente_hora: LIMITES.por_remetente_hora, codigo_min: LIMITES.codigo_min }, dominio: DOMINIO, ...extra, alias: vistaDoAlias(r),
    });
  };

  if (p === "/api/workspace/email" && request.method === "GET") return tela();
  if (p === "/api/workspace/email/disponivel" && request.method === "GET") {
    if (!(await (deps.dentroDoLimite ? deps.dentroDoLimite(request, env) : true))) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
    const c = conferirAlias(url.searchParams.get("alias"));
    if (c.erro) return json({ ok: false, erro: c.erro });
    const v = await pedir("livre", { alias: c.alias });
    if (!v || !v.ok) return FORA();
    const deOutro = v.livre ? await paginaDeLinksDeOutro(env, c.alias, sessao.sub) : false;
    return json(v.livre && !deOutro ? { ok: true, alias: c.alias } : { ok: false, erro: "esse endereço não está disponível: escolha outro" });
  }
  if (request.method !== "POST") return json({ erro: "use POST" }, 405);
  if (!ligado) return DESLIGADO();
  if (!ativo) return json({ erro: "ative o Atos Workspace para usar o e-mail Atos (atos.dev.br/workspace)", workspace: false }, 403);
  // O Workspace suspenso pela equipe: a gestao do e-mail Atos para (o encaminhamento segue, salvo se o endereco tambem
  // foi suspenso). A pessoa ve o motivo.
  if (suspenso) {
    return json({ erro: "a Atos suspendeu o seu Atos Workspace" + (suspenso.motivo ? " (" + suspenso.motivo + ")" : "") + ": enquanto durar, você não muda o e-mail Atos. Escreva para contato@atos.dev.br",
      codigo: "workspace_suspenso", suspenso }, 403);
  }
  if (!recente) return json({ erro: "para mudar o e-mail Atos, entre de novo (o login precisa ser das últimas " + RECENTE_H + " horas)", reentrar: true }, 401);
  const corpo = await lerJson(request);
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return json({ erro: "pedido inválido" }, 400);
  const falhou = (r) => json({ erro: (r && r.erro) || "não deu agora: tente de novo", ...(r && r.esgotado ? { esgotado: true } : {}) }, (r && r.status) || 503);
  const apagarNaCf = async (id) => { if (id) await cf.apagar(id); };

  if (p === "/api/workspace/email/alias") {
    if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
    const c = conferirAlias(corpo.alias);
    if (c.erro) return json({ erro: c.erro }, 400);
    // O nome da pagina de links de outra pessoa (atos.dev.br/@<nome>; worker/links.js) nao vira o e-mail Atos de ninguem.
    if (await paginaDeLinksDeOutro(env, c.alias, sessao.sub)) return json({ erro: "esse endereço não está disponível: escolha outro" }, 409);
    const r = await pedir("reservar", { alias: c.alias });
    if (!r || !r.ok) return falhou(r);
    return tela(r.alias);
  }

  if (p === "/api/workspace/email/destino") {
    const c = conferirDestino(corpo.destino, env);
    if (c.erro) return json({ erro: c.erro }, 400);
    const v = await pedir("ver");
    if (!v || !v.ok) return FORA();
    if (!v.alias) return json({ erro: "escolha o endereço primeiro" }, 409);
    // O teto de destinos da conta Cloudflare: conferido na propria Cloudflare (conta os do dono tambem).
    const total = await cf.total();
    if (!total.ok) return json({ erro: "não deu para falar com a Cloudflare agora: tente de novo em instantes" }, 502);
    const codigo = codigoAleatorio();
    const r = await pedir("destino_pedir", { destino: c.destino, hash: await hashDoCodigo(v.alias.alias, codigo), limite: Math.max(0, limiteDeDestinos(env) - (total.total - v.vagas.usadas)) });
    if (r && r.soltar) await apagarNaCf(r.soltar);
    if (!r || !r.ok) return falhou(r);
    // A Cloudflare: cria o destino (ela manda o e-mail de verificacao) ou acha o que ja existe.
    const x = await cf.criar(c.destino);
    if (x.ok) await pedir("destino_cf", { email: c.destino, cf_id: x.id, criado: x.criado, verificado: x.verificado, pedido: x.criado });
    const mandou = await mandarCodigo(env, enviar, c.destino, v.alias.alias, codigo);
    const extra = { codigo_enviado: mandou.ok, ...(mandou.ok ? {} : { aviso: mandou.erro }), ...(x.ok ? {} : { aviso_cf: "a Cloudflare não respondeu: use “Conferir” daqui a pouco" }),
      ...(simulada(env) ? { codigo_teste: codigo } : {}) };
    return tela(undefined, extra);
  }

  if (p === "/api/workspace/email/codigo") {
    const v = await pedir("ver");
    if (!v || !v.ok || !v.alias) return json({ erro: "escolha o endereço primeiro" }, 409);
    const codigo = String(corpo.codigo || "").replace(/\D/g, "");
    if (codigo.length !== 6) return json({ erro: "o código tem 6 números" }, 400);
    const r = await pedir("codigo_conferir", { hash: await hashDoCodigo(v.alias.alias, codigo) });
    if (!r || !r.ok) return falhou(r);
    return tela(r.alias);
  }

  if (p === "/api/workspace/email/conferir" || p === "/api/workspace/email/reenviar") {
    const v = await pedir("ver");
    if (!v || !v.ok || !v.alias || !v.alias.destino) return json({ erro: "informe o destino primeiro" }, 409);
    const dest = v.alias.destino;
    if (p === "/api/workspace/email/reenviar" && corpo.qual === "codigo") {
      const codigo = codigoAleatorio();
      const r = await pedir("codigo_novo", { hash: await hashDoCodigo(v.alias.alias, codigo) });
      if (!r || !r.ok) return falhou(r);
      const mandou = await mandarCodigo(env, enviar, dest.email, v.alias.alias, codigo);
      if (!mandou.ok) return json({ erro: mandou.erro }, mandou.status || 502);
      return tela(undefined, { codigo_enviado: true, ...(simulada(env) ? { codigo_teste: codigo } : {}) });
    }
    if (p === "/api/workspace/email/reenviar") {
      // O e-mail da Cloudflare de novo: a API nao tem "reenviar"; so a Atos apaga e cria de novo o destino que ela
      // mesma criou e que ainda nao foi verificado (o de outra pessoa ou do dono nunca e apagado).
      if (dest.cf_ok) return json({ erro: "a Cloudflare já confirmou este destino" }, 409);
      const info = await reg.pedir("destino_ler", { agora, email: dest.email });
      if (info && info.ok && info.cf_id) {
        const so = info.criado_pela_atos && info.aliases.length === 1 && info.aliases[0] === v.alias.alias;
        if (!so) return json({ erro: "este destino já estava na conta de entrega da Atos antes do seu pedido: procure o e-mail da Cloudflare que chegou a ele, ou use outro destino" }, 409);
        await cf.apagar(info.cf_id);
      }
      const x = await cf.criar(dest.email);
      if (!x.ok) return json({ erro: "não deu para falar com a Cloudflare agora: tente de novo em instantes" }, 502);
      await pedir("destino_cf", { email: dest.email, cf_id: x.id, criado: x.criado, verificado: x.verificado, pedido: true });
      return tela(undefined, { cf_reenviado: x.criado });
    }
    // Conferir: pergunta a Cloudflare pelo destino (e cria, se a criacao tinha falhado).
    let x;
    const atual = await cfIdDe(reg, agora, dest.email);
    if (atual) {
      x = await cf.ler(atual);
      if (!x.ok && x.sumiu) x = await cf.criar(dest.email);
    } else x = await cf.criar(dest.email);
    if (!x.ok) return json({ erro: "não deu para falar com a Cloudflare agora: tente de novo em instantes" }, 502);
    const r = await pedir("destino_cf", { email: dest.email, cf_id: x.id, criado: x.criado, verificado: x.verificado, pedido: Boolean(x.criado) });
    if (!r || !r.ok) return falhou(r);
    return tela(r.alias);
  }

  if (p === "/api/workspace/email/ligar" || p === "/api/workspace/email/desligar") {
    const op = p.endsWith("/ligar") ? "ligar" : "desligar";
    if (op === "ligar") {
      // Antes de ligar, a Cloudflare de novo: o destino pode ter sido apagado la.
      const v = await pedir("ver");
      const dest = v && v.alias && v.alias.destino;
      const id = dest ? await cfIdDe(reg, agora, dest.email) : null;
      if (id) {
        const x = await cf.ler(id);
        if (x.ok || x.sumiu) await pedir("destino_cf", { email: dest.email, cf_id: x.ok ? id : null, sumiu: Boolean(x.sumiu), verificado: Boolean(x.ok && x.verificado) });
      }
    }
    const r = await pedir(op);
    if (!r || !r.ok) return falhou(r);
    return tela(r.alias);
  }

  if (p === "/api/workspace/email/remover") {
    if (corpo.confirmar !== true) return json({ erro: "confirme na página: o endereço para de receber na hora e fica 30 dias sem poder ser de outra conta" }, 400);
    const r = await pedir("remover");
    if (!r || !r.ok) return falhou(r);
    if (r.soltar) await apagarNaCf(r.soltar);
    return tela(null, { vagas: undefined, removido: r.removido || null });
  }
  return json({ erro: "rota não existe" }, 404);
}

/* O id da Cloudflare do destino (do registro do objeto). */
async function cfIdDe(reg, agora, email) {
  const v = await reg.pedir("destino_ler", { agora, email });
  return v && v.ok ? v.cf_id || null : null;
}

async function mandarCodigo(env, enviar, destino, alias, codigo) {
  if (simulada(env)) return { ok: true };
  const r = await enviar(env, {
    para: destino,
    assunto: codigo + " é o código do seu e-mail Atos",
    titulo: "Confirme o destino do seu e-mail Atos",
    pre: "Código " + codigo + " para encaminhar " + alias + "@" + DOMINIO + " a este endereço.",
    texto: "Alguém com uma Conta Atos pediu para encaminhar as mensagens de " + alias + "@" + DOMINIO + " para este endereço. " +
      "Se foi você, digite este código no Atos Workspace (vale " + LIMITES.codigo_min + " minutos):\n\n" + codigo + "\n\n" +
      "Você também vai receber um e-mail da Cloudflare (o serviço que entrega as mensagens da Atos) pedindo para verificar este endereço. As duas confirmações são necessárias.\n\n" +
      "Se não foi você, ignore este e-mail: sem o código, nada é encaminhado para cá.",
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, erro: "não deu para mandar o código agora (" + (r.erro || "e-mail") + "): use “Mandar o código de novo” daqui a pouco" };
}

// ------------------------------------------------------------------ o painel da equipe

/* Quantos destinos a conta Cloudflare tem (null sem o recurso ligado ou sem resposta). */
export async function destinosNaCloudflare(env, deps = {}) {
  if (!emailAtosLigado(env)) return null;
  const t = await cloudflare(env, deps).total();
  return t.ok ? t.total : null;
}

export function ehRotaDoEmailNoPainel(p) {
  return p === "/api/admin/email" || p.startsWith("/api/admin/email/");
}

export async function atenderEmailPainel(request, env, url, c) {
  if (!env.EMAIL_ATOS) return json({ erro: "o registro do e-mail Atos não está neste Worker" }, 503);
  const reg = registro(env);
  const p = url.pathname;
  const m = request.method;
  if (p === "/api/admin/email" && m === "GET") {
    const r = await reg.pedir("painel", { agora: c.agora });
    if (!r || !r.ok) return json({ erro: "o registro do e-mail Atos não respondeu" }, 503);
    let total = null;
    if (emailAtosLigado(env)) { const t = await cloudflare(env, c.deps || {}).total(); total = t.ok ? t.total : null; }
    return json({
      disponivel: emailAtosLigado(env), simulada: simulada(env), limites: LIMITES, retencao_dias: RETENCAO_LOG_DIAS,
      vagas: { usadas: r.vagas.usadas, limite: limiteDeDestinos(env), teto_cf: TETO_CF, na_cf: total },
      inexistentes: r.inexistentes,
      aliases: r.aliases.map((a) => ({ alias: a.alias, endereco: a.alias + "@" + DOMINIO, conta: a.conta, sub: a.sub, criado: a.criado, estado: a.estado, suspenso: a.suspenso,
        destino: a.destino ? { email: a.destino.email, codigo_ok: a.destino.codigo_ok, cf_ok: a.destino.cf_ok } : null, ultimas: a.ultimas, atualizado: a.atualizado || null }))
        .sort((x, y) => String(y.atualizado || "").localeCompare(String(x.atualizado || ""))),
    });
  }
  if (p === "/api/admin/email/registro" && m === "GET") {
    const alias = String(url.searchParams.get("alias") || "").toLowerCase();
    if (alias && !/^[a-z0-9.-]{1,30}$/.test(alias)) return json({ erro: "alias inválido" }, 400);
    const r = await reg.pedir("painel_log", { agora: c.agora, alias });
    if (!r || !r.ok) return json({ erro: "o registro do e-mail Atos não respondeu" }, 503);
    return json({ entregas: r.entregas, mudancas: r.mudancas, retencao_dias: RETENCAO_LOG_DIAS });
  }
  const r = p.match(/^\/api\/admin\/email\/([a-z0-9.-]{3,30})\/(suspender|reativar|remover)$/);
  if (r && m === "POST") {
    if (!["dono", "suporte"].includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não suspende nem remove endereços" }, 403);
    const d = (await lerJson(request)) || {};
    const motivo = String(d.motivo || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
    if (r[2] === "suspender" && !motivo) return json({ erro: "diga o motivo (a pessoa vê)" }, 400);
    if (r[2] === "remover" && d.confirmar !== true) return json({ erro: "confirme na página: o endereço sai na hora" }, 400);
    const x = await reg.pedir(r[2], { agora: c.agora, alias: r[1], motivo, por: c.quem.email });
    if (!x || !x.ok) return json({ erro: (x && x.erro) || "não deu agora" }, (x && x.status) || 503);
    if (r[2] === "remover" && x.soltar && emailAtosLigado(env)) await cloudflare(env, c.deps || {}).apagar(x.soltar);
    return json({ ok: true, alias: x.alias || null, removido: x.removido || null });
  }
  return json({ erro: "rota não existe" }, 404);
}
