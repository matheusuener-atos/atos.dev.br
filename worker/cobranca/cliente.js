// O cliente da Atos Cobranca: um Durable Object por Conta Atos (o id vem do `sub`). Guarda os dados
// fiscais (uma vez, para todos os produtos), as assinaturas, as compras e o direito a cada produto. E o
// registro do dinheiro: um objeto atende um pedido de cada vez, entao duas abas pagando ao mesmo tempo
// nao se atropelam - o KV, eventualmente consistente, nao serve para isso.
//
// Chaves no storage do objeto:
//   dono                {sub, email} da Conta Atos (os eventos dizem de quem e)
//   perfil              {tipo: "pf"|"pj", documento, nome, email, endereco{...}, atualizado}
//   assinatura:<ref>    uma assinatura (a mensalidade no cartao) - ref e o external_reference; ou a concedida pela
//                       equipe (`concedida: {por, quando, motivo}`, forma "concedida", centavos 0, sem mp_id): ops
//                       conceder e encerrar_concedida; renova pelo alarme (renovarConcedidas), sem cobrar
//   compra:<ref>        uma compra (o ano, o mes no Pix, a recarga)
//   cobranca:<ref>      uma cobranca mensal da assinatura (o authorized_payment), para o Faturamento
//   direito:<produto>   ate quando o produto esta pago, o plano, o periodo que pagou, os creditos e a `versao`;
//                       num produto gratuito (o Atos Workspace; catalogo.js, gratuito), a ativacao: {ativo, ativado,
//                       desativado, termos: {versao, aceito}, suspenso: null|{quando, motivo, por, apps, alias},
//                       historico: [{quando, oque, termos?, por?}]} (ops ativar e desativar; suspender,
//                       suspensao_anotar e tirar_suspensao, da equipe; o mesmo direito que um plano pago, depois, estende)
//   evento:<seq>       a fila de saida para o produto (eventos.js), entregue pelo alarme deste objeto
//
// Pedidos: POST com {op, ...}; a resposta e JSON. Quem chama e so o Worker (api.js e o aviso).

import { entregar, REENTREGAS_S } from "./eventos.js";
import { PRODUTOS } from "./catalogo.js";

const PREFIXOS = { assinatura: "assinatura:", compra: "compra:", cobranca: "cobranca:" };
const VIVAS = ["authorized", "pending", "paused"];
// A assinatura concedida renova um dia antes do vencimento: o produto nunca ve o direito vencido entre um mes e outro.
const RENOVA_ANTES_MS = 24 * 3600 * 1000;

/* Um mes depois, no mesmo dia, ou no ultimo do mes se ele nao tiver o dia (31/01 -> 28/02), e um mes de
   cada vez (o ano sao doze): a mesma conta do produto (o PAVLVS abre os ciclos assim), para o "pago ate"
   da Atos e o fim do ciclo do produto cairem no mesmo dia. */
export function maisUmMes(ms) {
  const d = new Date(ms);
  const dia = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() < dia) d.setUTCDate(0);
  return d.getTime();
}

export async function idDoCliente(sub) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cliente:" + sub));
  return [...new Uint8Array(h)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* O external_reference de uma cobranca: diz de que cliente ela e sem consultar nada. */
export function novaRef(clienteId, tipo) {
  const r = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `atos-${clienteId}-${tipo}-${r}`;
}

export function clienteDaRef(ref) {
  const m = /^atos-([0-9a-f]{32})-(assinatura|compra)-[0-9a-f]{16}$/.exec(String(ref || ""));
  return m ? { clienteId: m[1], tipo: m[2] } : null;
}

/* O objeto do cliente, para pedir: await cliente(env, id).pedir("perfil_ler"). `dono` ({sub, email}, da
   sessao) vai em todo pedido e fica anotado no primeiro: e de quem os eventos dizem que e. */
export function cliente(env, clienteId, dono) {
  const stub = env.CLIENTES.get(env.CLIENTES.idFromName(clienteId));
  return {
    async pedir(op, dados = {}) {
      const r = await stub.fetch("https://cliente/", { method: "POST", body: JSON.stringify({ op, ...dados, ...(dono ? { dono } : {}) }) });
      return r.json();
    },
  };
}

export class ClienteCobranca {
  constructor(ctx, env, deps = {}) {
    this.ctx = ctx;
    this.env = env;
    this.deps = deps;
  }

  async fetch(request) {
    let d;
    try {
      d = await request.json();
    } catch {
      return Response.json({ ok: false, erro: "pedido inválido" }, { status: 400 });
    }
    try {
      return Response.json(await this.fazer(d));
    } catch (e) {
      return Response.json({ ok: false, erro: String((e && e.message) || e) }, { status: 500 });
    }
  }

  async fazer(d) {
    const s = this.ctx.storage;
    const agora = new Date().toISOString();
    // Quem e o dono (o sub e o e-mail da Conta Atos): anotado no primeiro pedido que o traz.
    if (d.dono && d.dono.sub && !(await s.get("dono"))) await s.put("dono", { sub: d.dono.sub, email: d.dono.email || "" });
    switch (d.op) {
      case "perfil_ler":
        return { ok: true, perfil: (await s.get("perfil")) || null };
      case "perfil_salvar": {
        const perfil = { ...d.perfil, atualizado: agora };
        await s.put("perfil", perfil);
        return { ok: true, perfil };
      }
      case "registrar": {
        // Uma cobranca nova, antes de ir ao Mercado Pago: se a chamada cair no meio, o registro existe
        // e o aviso que chegar depois encontra onde aplicar.
        const chave = PREFIXOS[d.tipo] + d.registro.ref;
        if (!PREFIXOS[d.tipo] || (await s.get(chave))) return { ok: false, erro: "registro inválido ou repetido" };
        const r = { ...d.registro, criada: agora, atualizada: agora };
        await s.put(chave, r);
        return { ok: true, registro: r };
      }
      case "atualizar": {
        const chave = PREFIXOS[d.tipo] + d.ref;
        const antes = PREFIXOS[d.tipo] ? await s.get(chave) : null;
        if (!antes) return { ok: false, erro: "não existe" };
        const r = { ...antes, ...d.campos, atualizada: agora };
        // A assinatura mudou o que o produto ve (autorizou, pausou, cancelou, a proxima cobranca): ele fica
        // sabendo. A tentativa recusada nao muda o retrato, e nao vira evento.
        const retratoAntes = d.tipo === "assinatura" ? JSON.stringify(await this.retrato(antes.produto)) : "";
        await s.put(chave, r);
        if (d.tipo === "assinatura" && JSON.stringify(await this.retrato(r.produto)) !== retratoAntes) await this.publicarDireito(r.produto);
        return { ok: true, registro: r, antes };
      }
      case "cobranca_salvar": {
        // A cobranca do mes, pelo id do Mercado Pago: o aviso pode chegar mais de uma vez, e a situacao muda.
        const chave = PREFIXOS.cobranca + d.registro.ref;
        const guardado = (await s.get(chave)) || null;
        const antes = guardado || { criada: agora };
        const r = { ...antes, ...d.registro, atualizada: agora };
        await s.put(chave, r);
        // `antes`: como estava (null se e nova) - quem chama ve se ela acabou de ficar paga (a NFS-e, uma vez so).
        return { ok: true, registro: r, antes: guardado };
      }
      case "ler": {
        const r = PREFIXOS[d.tipo] ? await s.get(PREFIXOS[d.tipo] + d.ref) : null;
        return r ? { ok: true, registro: r } : { ok: false, erro: "não existe" };
      }
      case "listar": {
        const out = {};
        for (const [tipo, prefixo] of Object.entries(PREFIXOS)) out[tipo] = [...(await s.list({ prefix: prefixo })).values()];
        return { ok: true, ...out };
      }
      case "estender": {
        // Um pagamento aprovado estende o direito ao produto (estenderDireito, abaixo). A recarga nao estende: soma
        // creditos ao direito.
        if (!d.origem) return { ok: false, erro: "falta a origem do pagamento" };
        const r = await this.estenderDireito(d, agora);
        if (r.repetido) return { ok: true, direito: r.direito, repetido: true };
        if (d.credito) await this.enfileirar("credito.adicionado", d.produto, { origem: d.origem, ...d.credito });
        if (d.meses) await this.publicarDireito(d.produto);
        return { ok: true, direito: await s.get("direito:" + d.produto) };
      }
      case "conceder":
        return this.conceder(d, agora);
      case "encerrar_concedida":
        return this.encerrarConcedida(d, agora);
      case "direitos":
        return { ok: true, direitos: [...(await s.list({ prefix: "direito:" })).values()] };
      case "direito":
        return { ok: true, direito: (await s.get("direito:" + d.produto)) || null };
      case "ativar": {
        // Um produto gratuito (o Atos Workspace): a pessoa aceitou os termos (a versao vai junto). Quem chama
        // (worker/workspace.js) confere que o produto e gratuito e que o login e recente. Sem evento: o produto e
        // da propria Atos. Ativo com a mesma versao: nada muda.
        const chave = "direito:" + d.produto;
        const versao = String((d.termos && d.termos.versao) || "");
        if (!d.produto || !versao) return { ok: false, erro: "falta o produto ou a versão dos termos" };
        const antes = (await s.get(chave)) || { produto: d.produto, versao: 0 };
        if (antes.ativo && antes.termos && antes.termos.versao === versao) return { ok: true, direito: antes, repetido: true };
        const r = { ...antes, produto: d.produto, gratuito: true, ativo: true, ativado: antes.ativo ? antes.ativado : agora, desativado: null,
          termos: { versao, aceito: agora }, historico: [...(antes.historico || []), { quando: agora, oque: antes.ativo ? "aceitou os termos" : "ativou", termos: versao }].slice(-50),
          atualizado: agora };
        await s.put(chave, r);
        return { ok: true, direito: r };
      }
      case "desativar": {
        const chave = "direito:" + d.produto;
        const antes = await s.get(chave);
        if (!antes || !antes.ativo) return { ok: true, direito: antes || null, repetido: true };
        const r = { ...antes, ativo: false, desativado: agora, historico: [...(antes.historico || []), { quando: agora, oque: "desativou" }].slice(-50), atualizado: agora };
        await s.put(chave, r);
        return { ok: true, direito: r };
      }
      case "suspender": {
        // A equipe da Atos suspende o produto gratuito (o Atos Workspace) por abuso: a pessoa continua com ele ativo,
        // mas a gestao para (worker/workspace.js, o 403 workspace_suspenso) e ela ve o motivo. Ativar de novo ou
        // aceitar termos novos nao tira a suspensao (o "ativar" acima preserva o campo); so "tirar_suspensao".
        const chave = "direito:" + d.produto;
        const antes = await s.get(chave);
        if (!antes) return { ok: false, erro: "esta conta nunca ativou o produto", status: 404 };
        if (antes.suspenso) return { ok: false, erro: "já está suspenso", status: 409, direito: antes };
        const motivo = String(d.motivo || "").slice(0, 200);
        const r = { ...antes, suspenso: { quando: agora, motivo, por: String(d.por || ""), apps: [], alias: "" },
          historico: [...(antes.historico || []), { quando: agora, oque: "a Atos suspendeu" + (motivo ? " (" + motivo + ")" : ""), por: String(d.por || "") }].slice(-50), atualizado: agora };
        await s.put(chave, r);
        return { ok: true, direito: r };
      }
      case "suspensao_anotar": {
        // O que a suspensao levou junto (os aplicativos desligados, o endereco suspenso): o reativar oferece desfazer.
        const chave = "direito:" + d.produto;
        const antes = await s.get(chave);
        if (!antes || !antes.suspenso) return { ok: false, erro: "não está suspenso", status: 409 };
        const r = { ...antes, suspenso: { ...antes.suspenso, apps: Array.isArray(d.apps) ? d.apps.map(String).slice(0, 50) : antes.suspenso.apps || [],
          alias: typeof d.alias === "string" ? d.alias.slice(0, 40) : antes.suspenso.alias || "" } };
        await s.put(chave, r);
        return { ok: true, direito: r };
      }
      case "tirar_suspensao": {
        const chave = "direito:" + d.produto;
        const antes = await s.get(chave);
        if (!antes || !antes.suspenso) return { ok: false, erro: "não está suspenso", status: 409, direito: antes || null };
        const r = { ...antes, suspenso: null, historico: [...(antes.historico || []), { quando: agora, oque: "a Atos tirou a suspensão", por: String(d.por || "") }].slice(-50), atualizado: agora };
        await s.put(chave, r);
        return { ok: true, direito: r };
      }
      case "retrato":
        return { ok: true, retrato: await this.retrato(d.produto) };
      case "eventos":
        return { ok: true, eventos: [...(await s.list({ prefix: "evento:" })).values()] };
      default:
        return { ok: false, erro: "op desconhecida" };
    }
  }

  /* Estende o direito ao produto por um pagamento (ou por um mes concedido): a partir do fim do que ja estava pago
     (ou de agora, se ja venceu), `meses` a mais; ou soma o `credito`. Uma vez por `origem`. Grava; nao publica (quem
     chama publica). {direito, repetido} */
  async estenderDireito(d, agora) {
    const s = this.ctx.storage;
    const chave = "direito:" + d.produto;
    const antes = (await s.get(chave)) || { produto: d.produto, ate: null, plano: null, creditos: [], aplicados: [], versao: 0 };
    // O mesmo pagamento (o aviso e a consulta da tela podem chegar os dois) estende uma vez so.
    if ((antes.aplicados || []).includes(d.origem)) return { direito: antes, repetido: true };
    const r = { ...antes, aplicados: [...(antes.aplicados || []), d.origem].slice(-200), plano: d.plano || antes.plano,
      metadados: d.metadados || antes.metadados || null, atualizado: agora };
    if (d.meses) {
      let ate = antes.ate && Date.parse(antes.ate) > Date.now() ? Date.parse(antes.ate) : Date.now();
      for (let i = 0; i < d.meses; i++) ate = maisUmMes(ate);
      r.ate = new Date(ate).toISOString();
      // O que pagou o direito de agora: o ano, ou um mes (a assinatura no cartao, o mes no Pix ou o mes concedido).
      r.periodo = d.meses === 12 ? "ano" : "mes";
      // Quem pagou: a cobranca da assinatura (ap:), o mes concedido pela equipe (concedida:, sem cobranca) ou uma
      // compra a parte (order:, o ano ou o mes no Pix).
      const o = String(d.origem);
      r.pago_por = o.startsWith("ap:") ? "assinatura" : o.startsWith("concedida:") ? "concedida" : "compra";
    }
    if (d.credito) r.creditos = [...(antes.creditos || []), { ...d.credito, origem: d.origem, quando: agora }].slice(-50);
    await s.put(chave, r);
    return { direito: r, repetido: false };
  }

  /* A assinatura concedida pela equipe da Atos (worker/admin-contas.js): R$ 0,00 por mes, sem Mercado Pago, sem cartao e
     sem fatura. Nasce "authorized", estende o direito um mes (a origem "concedida:<ref>:1") e renova sozinha pelo alarme
     (renovarConcedidas), um mes de cada vez, ate ser cancelada. Nunca por cima de outra assinatura viva do produto (paga
     ou concedida), nem com um periodo pago em outro plano: seria a mesma ambiguidade que o checkout recusa. */
  async conceder(d, agora) {
    const s = this.ctx.storage;
    if (!d.produto || !d.plano || !d.preco || !d.ref) return { ok: false, status: 400, erro: "falta o produto, o plano ou a ref" };
    if (await s.get(PREFIXOS.assinatura + d.ref)) return { ok: false, status: 409, erro: "registro repetido" };
    const viva = [...(await s.list({ prefix: PREFIXOS.assinatura })).values()].find((a) => a.produto === d.produto && [...VIVAS, "criando"].includes(a.status));
    if (viva) {
      return viva.concedida
        ? { ok: false, status: 409, codigo: "ja_concedida", erro: "esta conta já tem uma assinatura concedida neste produto (plano " + (viva.plano || "?") + "): encerre-a antes de conceder outra" }
        : { ok: false, status: 409, codigo: "ja_assina", erro: "esta conta já tem uma assinatura paga viva neste produto (plano " + (viva.plano || "?") + ", " + viva.status + "): conceder outra seria assinar duas vezes. Se for o caso, a pessoa cancela a paga antes" };
    }
    const dir = await s.get("direito:" + d.produto);
    if (dir && dir.ate && Date.parse(dir.ate) > Date.now() && dir.plano && dir.plano !== d.plano) {
      return { ok: false, status: 409, codigo: "troca_de_plano", erro: "esta conta tem o produto pago até " + dir.ate.slice(0, 10) + " no plano " + dir.plano + ": conceda o mesmo plano ou espere o vencimento" };
    }
    const registro = { ref: d.ref, produto: d.produto, preco: d.preco, plano: d.plano, centavos: 0, forma: "concedida", bandeira: "", status: "authorized",
      concedida: { por: String(d.por || ""), quando: agora, motivo: String(d.motivo || "").slice(0, 200) }, renovacoes: 1, criada: agora, atualizada: agora };
    await s.put(PREFIXOS.assinatura + d.ref, registro);
    const e = await this.estenderDireito({ produto: d.produto, plano: d.plano, metadados: d.metadados || null, meses: 1, origem: "concedida:" + d.ref + ":1" }, agora);
    registro.proxima = e.direito.ate;
    await s.put(PREFIXOS.assinatura + d.ref, registro);
    await this.publicarDireito(d.produto);
    await this.agendar();
    return { ok: true, registro, direito: await s.get("direito:" + d.produto) };
  }

  /* Encerra (cancela) a assinatura concedida: para de renovar; o mes ja concedido vale ate o fim, como o mes pago de uma
     assinatura cancelada. Pela equipe (o painel) ou pela propria pessoa (Minha conta > Assinaturas). */
  async encerrarConcedida(d, agora) {
    const s = this.ctx.storage;
    const antes = await s.get(PREFIXOS.assinatura + d.ref);
    if (!antes || !antes.concedida) return { ok: false, status: 404, erro: "assinatura concedida não encontrada" };
    if (antes.status === "canceled") return { ok: true, registro: antes, repetido: true };
    const r = { ...antes, status: "canceled", proxima: null, encerrada: { por: String(d.por || ""), quando: agora, motivo: String(d.motivo || "").slice(0, 200) }, atualizada: agora };
    await s.put(PREFIXOS.assinatura + d.ref, r);
    await this.publicarDireito(r.produto);
    return { ok: true, registro: r };
  }

  /* As concedidas vivas renovam um dia antes de vencer (o direito nao fica um instante sem plano): mais um mes, uma vez
     por renovacao (a origem "concedida:<ref>:<n>"), e o produto fica sabendo. Se o alarme atrasou (mais de um mes),
     renova quantos meses faltarem. */
  async renovarConcedidas(agora = Date.now()) {
    const s = this.ctx.storage;
    for (const a of (await s.list({ prefix: PREFIXOS.assinatura })).values()) {
      if (!a.concedida || a.status !== "authorized" || !a.proxima) continue;
      let r = a;
      let mudou = false;
      for (let i = 0; i < 24 && Date.parse(r.proxima) - RENOVA_ANTES_MS <= agora; i++) {
        const n = (r.renovacoes || 1) + 1;
        const e = await this.estenderDireito({ produto: r.produto, plano: r.plano, meses: 1, origem: "concedida:" + r.ref + ":" + n }, new Date(agora).toISOString());
        r = { ...r, renovacoes: n, proxima: e.direito.ate, atualizada: new Date(agora).toISOString() };
        mudou = true;
      }
      if (!mudou) continue;
      await s.put(PREFIXOS.assinatura + r.ref, r);
      await this.publicarDireito(r.produto);
    }
  }

  /* A proxima renovacao de uma concedida (ms), ou null. */
  async proximaRenovacao() {
    let t = null;
    for (const a of (await this.ctx.storage.list({ prefix: PREFIXOS.assinatura })).values()) {
      if (!a.concedida || a.status !== "authorized" || !a.proxima) continue;
      const x = Date.parse(a.proxima) - RENOVA_ANTES_MS;
      t = t === null ? x : Math.min(t, x);
    }
    return t;
  }

  /* Marca o alarme para a proxima renovacao, se nao houver um antes. */
  async agendar() {
    const s = this.ctx.storage;
    const t = await this.proximaRenovacao();
    if (t === null) return;
    const atual = typeof s.getAlarm === "function" ? await s.getAlarm() : null;
    if (!atual || atual > t) await s.setAlarm(Math.max(t, Date.now()));
  }

  /* O que o produto precisa saber do direito, agora: o plano, ate quando, a assinatura viva e a versao. */
  async retrato(produto) {
    const s = this.ctx.storage;
    const dir = (await s.get("direito:" + produto)) || {};
    const vivas = [...(await s.list({ prefix: PREFIXOS.assinatura })).values()]
      .filter((a) => a.produto === produto && a.status !== "criando" && a.status !== "recusada")
      .sort((a, b) => String(b.criada).localeCompare(String(a.criada)));
    const a = vivas.find((x) => VIVAS.includes(x.status)) || vivas[0] || null;
    return {
      versao: dir.versao || 0, plano: dir.plano || (a && a.plano) || null, metadados: dir.metadados || null, ate: dir.ate || null,
      periodo: dir.periodo || null, pago_por: dir.pago_por || null,
      // `concedida` (a assinatura de R$ 0,00 concedida pela equipe): o produto mostra o valor 0, sem cobranca.
      assinatura: a ? { id: a.ref, status: a.status, proxima: a.proxima || null, preco: a.preco, ...(a.concedida ? { concedida: true, centavos: 0 } : {}) } : null,
    };
  }

  /* Uma versao nova do direito vai para a fila do produto. O produto da propria Atos (sem `eventos` no catalogo: o Atos
     Workspace) nao tem para onde mandar: o Worker le o direito daqui mesmo; so a data ate quando o Pro foi pago vai ao
     objeto dos dados do Workspace da conta (worker/workspace-dados.js, "ws:plano"), que guarda os registros pelo plano. */
  async publicarDireito(produto) {
    const s = this.ctx.storage;
    const chave = "direito:" + produto;
    const dir = (await s.get(chave)) || { produto, ate: null, plano: null, creditos: [], aplicados: [], versao: 0 };
    dir.versao = (dir.versao || 0) + 1;
    await s.put(chave, dir);
    if (PRODUTOS[produto] && !PRODUTOS[produto].eventos) {
      const dono = (await s.get("dono")) || {};
      if (produto === "workspace" && dono.sub && this.env && this.env.WS_DADOS) {
        try {
          const stub = this.env.WS_DADOS.get(this.env.WS_DADOS.idFromName("conta:" + dono.sub));
          await stub.fetch("https://ws-dados/", { method: "POST", body: JSON.stringify({ op: "plano_anotar", plano_ate: dir.plano === "pro" ? dir.ate || null : null }) });
        } catch {
          // a guarda dos registros e o segundo lugar: o objeto anota de novo no proximo pedido da area
        }
      }
      return;
    }
    await this.enfileirar("direito.atualizado", produto, await this.retrato(produto));
  }

  async enfileirar(tipo, produto, dados) {
    const s = this.ctx.storage;
    const dono = (await s.get("dono")) || {};
    const seq = ((await s.get("evento_seq")) || 0) + 1;
    await s.put("evento_seq", seq);
    const evento = { id: crypto.randomUUID(), tipo, produto, criado: new Date().toISOString(), conta: { sub: dono.sub || "", email: dono.email || "" }, dados };
    await s.put("evento:" + String(seq).padStart(10, "0"), { evento, estado: "pendente", tentativas: 0, proxima: Date.now() });
    // A entrega e do alarme: a resposta ao pagamento nao espera o produto.
    await s.setAlarm(Date.now());
  }

  /* O alarme entrega a fila em ordem; o que o produto recusar volta em REENTREGAS_S, e esgotado vira "falhou". */
  async alarm() {
    const s = this.ctx.storage;
    const agora = Date.now();
    // As concedidas que vencem renovam antes (e o evento delas entra na fila que vem abaixo).
    await this.renovarConcedidas(agora);
    let proxima = await this.proximaRenovacao();
    for (const [chave, item] of await s.list({ prefix: "evento:" })) {
      if (item.estado !== "pendente") continue;
      if (item.proxima > agora) { proxima = Math.min(proxima ?? Infinity, item.proxima); continue; }
      const r = await entregar(this.env, item.evento, { buscar: this.deps.fetch });
      if (r.ok) {
        await s.put(chave, { ...item, estado: "entregue", tentativas: item.tentativas + 1, entregue: new Date().toISOString() });
        continue;
      }
      const tentativas = item.tentativas + 1;
      const espera = REENTREGAS_S[tentativas - 1];
      const novo = { ...item, tentativas, ultimo: { status: r.status, motivo: r.motivo || "", quando: new Date().toISOString() } };
      if (espera === undefined) novo.estado = "falhou";
      else { novo.proxima = agora + espera * 1000; proxima = Math.min(proxima ?? Infinity, novo.proxima); }
      await s.put(chave, novo);
    }
    if (proxima !== null) await s.setAlarm(proxima);
  }
}
