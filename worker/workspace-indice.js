// O indice do Atos Workspace e o registro da equipe, para o painel (atos.dev.br/admin, grupo "Atos Workspace").
//
// Por que aqui: a ativacao de cada conta mora no objeto do cliente da cobranca (cobranca/cliente.js, direito:workspace),
// um Durable Object por conta, e esses objetos nao se listam. O painel precisa de uma lista consultavel; ela fica no
// objeto unico do e-mail Atos (EmailAtos, idFromName("registro"); worker/email-atos.js), com consistencia forte (o
// que acabou de ser ativado ou suspenso ja aparece), sem migracao nova, e no mesmo lugar dos enderecos: a lista
// "Contas do Workspace" junta conta e alias num pedido so. O Worker de teste tem o proprio objeto (e o proprio indice).
// O KV foi descartado: e eventual (uma ativacao poderia sumir por ate 60 s) e a escrita de leitura-e-troca de uma
// lista perde mudancas simultaneas.
//
// Quem entra no indice: toda ativacao, desativacao, suspensao e retirada dela (worker/workspace.js e o painel); quem
// abre a area do Workspace (GET /api/workspace: a "auto-indexacao", para quem ativou antes do indice); e a varredura
// do painel (worker/admin-workspace.js), que percorre as Contas Atos do KV (id:conta:*) aos poucos, de onde parou, e
// pergunta ao objeto de cada conta. O indice copia o que o objeto da conta diz; quem decide e sempre o objeto da conta.
//
// Chaves no storage do EmailAtos:
//   ws:<sub>        {sub, email, estado: "ativo"|"desativado"|"suspenso", ativo, ativado, desativado, termos: {versao,
//                    aceito}|null, suspenso: null|{quando, motivo, por}, indexado, origem, atualizado}
//   ws-varredura    {cursor, conferidas, completa, quando} onde a varredura das contas parou
//   eq:<iso>:<r>    o registro da equipe (Atos Workspace e Contas Atos): {quando, por, tipo, sub, email, alvo, oque,
//                    motivo}; um ano (a limpeza do objeto)

import { normal } from "./comum.js";
import { DOMINIO, registro } from "./email-atos.js";

export const RETENCAO_EQUIPE_DIAS = 365;
const sorteio = () => [...crypto.getRandomValues(new Uint8Array(4))].map((x) => x.toString(16).padStart(2, "0")).join("");

/* O estado de um direito (cobranca/cliente.js) como o painel o mostra. */
export function estadoDe(d) {
  if (!d) return "nunca";
  if (d.suspenso) return "suspenso";
  return d.ativo ? "ativo" : "desativado";
}

/* A linha do indice a partir do direito. */
export function linhaDoIndice(sub, email, d) {
  return {
    sub: String(sub), email: normal(email), estado: estadoDe(d), ativo: Boolean(d && d.ativo), ativado: (d && d.ativado) || null, desativado: (d && d.desativado) || null,
    termos: d && d.termos ? { versao: String(d.termos.versao || ""), aceito: d.termos.aceito || null } : null,
    suspenso: d && d.suspenso ? { quando: d.suspenso.quando, motivo: d.suspenso.motivo || "", por: d.suspenso.por || "" } : null,
    // O plano pago (worker/workspace-plano.js): "pro" e ate quando (o painel diz "Pro ate ..." ou "Pro venceu em ...").
    plano: d && d.plano === "pro" && d.ate ? { id: "pro", ate: d.ate, periodo: d.periodo || null, pago_por: d.pago_por || null } : null,
  };
}

const CAMPOS = ["email", "estado", "ativo", "ativado", "desativado", "termos", "suspenso", "plano"];
const igual = (a, b) => CAMPOS.every((k) => JSON.stringify(a[k] === undefined ? null : a[k]) === JSON.stringify(b[k] === undefined ? null : b[k]));

/* O alias de uma conta como o indice mostra (sem o destino: o painel mascara). */
function resumoDoAlias(r) {
  if (!r) return null;
  return {
    alias: r.alias, endereco: r.alias + "@" + DOMINIO, estado: r.estado, suspenso: r.suspenso ? { quando: r.suspenso.quando, motivo: r.suspenso.motivo || "" } : null,
    confirmado: Boolean(r.destino && r.destino.codigo_ok && r.destino.cf_ok),
  };
}

/* As ops do indice e do registro da equipe, dentro do EmailAtos (`o`: o objeto, para ler os aliases). */
export async function fazerNoIndice(o, d, agora) {
  const s = o.ctx.storage;
  const quando = new Date(agora).toISOString();
  switch (d.op) {
    case "ws_anotar": {
      const l = d.linha;
      if (!l || !l.sub) return { ok: false, erro: "sem a conta" };
      const k = "ws:" + l.sub;
      const antes = await s.get(k);
      if (antes && igual(antes, l)) return { ok: true, mudou: false, linha: antes };
      const nova = { ...l, indexado: (antes && antes.indexado) || quando, origem: (antes && antes.origem) || String(d.origem || ""), atualizado: quando };
      await s.put(k, nova);
      return { ok: true, mudou: true, linha: nova };
    }
    case "ws_ver": {
      const linha = (await s.get("ws:" + String(d.sub || ""))) || null;
      return { ok: true, linha, alias: await o.daConta(String(d.sub || "")) };
    }
    case "ws_listar": {
      const contas = [...(await s.list({ prefix: "ws:" })).values()];
      const aliases = new Map();
      for (const [, r] of await s.list({ prefix: "alias:" })) if (r && r.sub) aliases.set(r.sub, r);
      const noIndice = new Set(contas.map((c) => c.sub));
      return {
        ok: true, contas: contas.map((c) => ({ ...c, alias: resumoDoAlias(aliases.get(c.sub)) })),
        // Donos de endereco que o indice ainda nao tem (a varredura do painel confere).
        sem_indice: [...aliases.values()].filter((r) => !noIndice.has(r.sub)).map((r) => ({ sub: r.sub, conta: r.conta || "" })),
        varredura: (await s.get("ws-varredura")) || null,
      };
    }
    case "ws_varredura": {
      if (d.estado && typeof d.estado === "object") await s.put("ws-varredura", { ...d.estado, quando });
      return { ok: true, estado: (await s.get("ws-varredura")) || null };
    }
    case "eq_anotar": {
      const x = d.item || {};
      await s.put("eq:" + quando + ":" + sorteio(), {
        quando, por: String(x.por || ""), tipo: String(x.tipo || ""), sub: String(x.sub || ""), email: normal(x.email), alvo: String(x.alvo || "").slice(0, 120),
        oque: String(x.oque || "").slice(0, 400), motivo: String(x.motivo || "").slice(0, 200),
      });
      await o.limpezaMarcada(agora);
      return { ok: true };
    }
    case "eq_listar": {
      const sub = String(d.sub || ""), email = normal(d.email), tipo = String(d.prefixo || "");
      const l = [];
      for (const [, v] of await s.list({ prefix: "eq:", reverse: true, limit: 2000 })) {
        if (sub && v.sub !== sub) continue;
        if (email && v.email !== email) continue;
        if (tipo && !String(v.tipo).startsWith(tipo)) continue;
        l.push(v);
        if (l.length >= (Number(d.limite) || 50)) break;
      }
      return { ok: true, itens: l };
    }
    default:
      return { ok: false, erro: "op desconhecida" };
  }
}

export const ehOpDoIndice = (op) => /^(ws|eq)_/.test(String(op || ""));

// ------------------------------------------------------------------ quem usa (o Worker)

/* Anota (ou atualiza) a conta no indice a partir do direito. Nunca lanca: o indice e para a equipe ver; a area da
   pessoa funciona sem ele. Sem o direito (nunca ativou), nada. */
export async function anotarNoIndice(env, sub, email, direito, origem) {
  if (!env || !env.EMAIL_ATOS || !sub || !direito) return null;
  try {
    const r = await registro(env).pedir("ws_anotar", { linha: linhaDoIndice(sub, email, direito), origem });
    return r && r.ok ? r.linha : null;
  } catch {
    return null;
  }
}

/* O registro da equipe: quem, quando, o que, o motivo. Lanca se o objeto nao responde (quem chama decide). */
export async function anotarDaEquipe(env, item) {
  const r = await registro(env).pedir("eq_anotar", { item });
  if (!r || !r.ok) throw new Error("o registro da equipe não respondeu");
}

export async function registroDaEquipe(env, filtro = {}) {
  const r = await registro(env).pedir("eq_listar", filtro);
  return r && r.ok ? r.itens : [];
}
