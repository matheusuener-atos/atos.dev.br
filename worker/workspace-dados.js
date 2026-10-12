// Os dados dos recursos do Atos Workspace que nao cabem no KV: os formularios de contato (worker/formularios.js), os
// avisos ao sistema (webhooks; worker/avisos.js), o registro de entradas de cada aplicativo (worker/entradas.js), as
// paginas de status (worker/status.js) e as paginas de links (worker/links.js). No objeto da conta, "ws:plano" ({ate})
// diz ate quando o Pro foi pago (worker/workspace-plano.js), para a guarda dos registros. Um Durable Object (WorkspaceDados, migracao v5; binding WS_DADOS), com
// consistencia forte, um pedido de cada vez e o alarme para as entregas e a limpeza.
//
// As instancias:
//   "indice"          o que precisa ser achado sem saber de quem e: o formulario pelo id (o POST publico), a pagina de
//                     status pelo nome (atos.dev.br/status/<nome>) e a agenda das conferencias (o Cron); e os
//                     contadores da Atos inteira (o teto diario de e-mails dos formularios)
//   "conta:<sub>"     tudo de uma conta: os formularios e o registro deles, os avisos de cada aplicativo (o endereco, o
//                     segredo, a fila e o registro das entregas), as entradas de cada aplicativo e a pagina de status
//                     (os enderecos, o historico)
// O Worker de teste tem os proprios objetos (como os outros Durable Objects).
//
// Pedidos: POST {op, agora?, ...}; a resposta e JSON {ok, ...}. Cada modulo diz as proprias ops (OPS_*), e a limpeza
// e o alarme chamam o que cada um precisa.

import { OPS_FORMULARIOS, limparFormularios } from "./formularios.js";
import { OPS_AVISOS, entregarAvisos, limparAvisos } from "./avisos.js";
import { OPS_ENTRADAS, limparEntradas } from "./entradas.js";
import { OPS_STATUS, limparStatus } from "./status.js";
import { OPS_LINKS, limparLinks } from "./links.js";
import { guardaDoPro } from "./workspace-plano.js";

const LIMPEZA_H = 6;

/* O objeto `nome` ("indice" ou "conta:<sub>") para pedir: await dados(env, "indice").pedir("form_dono", {id}). Lanca se
   o objeto nao responde; sem o binding, null (quem chama decide: 503 numa tela, nada num gancho). */
export function dados(env, nome) {
  if (!env || !env.WS_DADOS) return null;
  const stub = env.WS_DADOS.get(env.WS_DADOS.idFromName(nome));
  return {
    async pedir(op, d = {}) {
      const r = await stub.fetch("https://ws-dados/", { method: "POST", body: JSON.stringify({ op, ...d }) });
      return r.json();
    },
  };
}
export const doIndice = (env) => dados(env, "indice");
export const daConta = (env, sub) => dados(env, "conta:" + sub);

export const sorteio = (n = 4) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
export const isoDe = (ms) => new Date(ms).toISOString();

/* Apaga as chaves `prefixo + <iso>|...` mais antigas que `corteIso`, em ordem (as chaves crescem com o tempo), aos
   poucos. Devolve quantas apagou. */
export async function apagarAntigos(s, prefixo, corteIso, max = 5000) {
  let n = 0;
  for (let volta = 0; volta < 40 && n < max; volta++) {
    const l = await s.list({ prefix: prefixo, limit: 256 });
    const velhas = [];
    for (const [k] of l) if (k.slice(prefixo.length).split("|")[0] < corteIso) velhas.push(k);
    if (velhas.length) await s.delete(velhas);
    n += velhas.length;
    if (velhas.length < l.size || !l.size) break;
  }
  return n;
}

/* Apaga todas as chaves de um prefixo (um formulario apagado, um aplicativo que saiu). */
export async function apagarPrefixo(s, prefixo) {
  let n = 0;
  for (let volta = 0; volta < 200; volta++) {
    const l = await s.list({ prefix: prefixo, limit: 256 });
    if (!l.size) break;
    await s.delete([...l.keys()]);
    n += l.size;
  }
  return n;
}

export class WorkspaceDados {
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

  async fazer(d, agora) {
    // Ate quando o Pro foi pago (worker/workspace-plano.js): a guarda dos registros segue o plano. Quem anota e o
    // registro do cliente (cobranca/cliente.js, a cada mudanca do direito) e a porta da area (worker/workspace.js).
    if (d.op === "plano_anotar") {
      const s = this.ctx.storage;
      const ate = typeof d.plano_ate === "string" && d.plano_ate ? d.plano_ate : null;
      const antes = (await s.get("ws:plano")) || null;
      if (!antes || antes.ate !== ate) await s.put("ws:plano", { ate, anotado: isoDe(agora) });
      return { ok: true };
    }
    const f = OPS_FORMULARIOS[d.op] || OPS_AVISOS[d.op] || OPS_ENTRADAS[d.op] || OPS_STATUS[d.op] || OPS_LINKS[d.op];
    if (!f) return { ok: false, erro: "op desconhecida" };
    return f(this, d, agora);
  }

  /* Os registros do Pro ainda ficam? (o Pro pago, ou a carencia depois dele) */
  async guardaDoPro(agora) {
    const p = await this.ctx.storage.get("ws:plano");
    return guardaDoPro(p && p.ate, agora);
  }

  /* Um contador de frequencia: true se ainda cabe (e conta), false se chegou ao limite. */
  async contar(nome, janelaS, agora, limite, soma = 1) {
    const s = this.ctx.storage;
    const k = "cnt:" + nome;
    let c = await s.get(k);
    if (!c || Date.parse(c.ate) <= agora) c = { n: 0, ate: isoDe(agora + janelaS * 1000) };
    if (c.n + soma > limite) return false;
    c.n += soma;
    await s.put(k, c);
    await this.marcarLimpeza(agora);
    return true;
  }
  async contagem(nome, agora) {
    const c = await this.ctx.storage.get("cnt:" + nome);
    return c && Date.parse(c.ate) > agora ? c.n : 0;
  }

  /* O alarme serve a duas coisas: a entrega dos avisos (worker/avisos.js, quando vence a proxima tentativa) e a
     limpeza (a cada LIMPEZA_H horas, enquanto houver o que limpar). Guarda-se a hora da proxima limpeza; o alarme
     marcado e sempre o mais cedo dos dois. */
  async marcarLimpeza(agora) {
    const s = this.ctx.storage;
    if (await s.get("limpeza")) return;
    await s.put("limpeza", agora + LIMPEZA_H * 3600 * 1000);
    await this.reagendar();
  }
  async reagendar(extra) {
    const s = this.ctx.storage;
    const vezes = [await s.get("limpeza"), await s.get("avisos-proxima"), extra].filter((x) => typeof x === "number" && x > 0);
    if (!vezes.length || typeof s.setAlarm !== "function") return;
    const quando = Math.min(...vezes);
    const atual = typeof s.getAlarm === "function" ? await s.getAlarm() : null;
    if (!atual || atual > quando) await s.setAlarm(quando);
  }

  async alarm() {
    const s = this.ctx.storage;
    const agora = Date.now();
    await entregarAvisos(this, agora);
    const limpeza = await s.get("limpeza");
    if (limpeza && limpeza <= agora) {
      await s.delete("limpeza");
      const n = await this.limpar(agora);
      // Sobrou o que limpar (ou ha o que vai vencer): a proxima limpeza.
      if (n || (await this.temRegistro())) await s.put("limpeza", agora + LIMPEZA_H * 3600 * 1000);
    }
    await this.reagendar();
  }
  async temRegistro() {
    const s = this.ctx.storage;
    for (const p of ["flog:", "fstat:", "avr:", "avq:", "lg:", "st:dia:", "st:evt|", "cnt:", "lk:clk:", "lden:"]) if ((await s.list({ prefix: p, limit: 1 })).size) return true;
    return false;
  }
  async limpar(agora) {
    const s = this.ctx.storage;
    let n = 0;
    for (const [k, v] of await s.list({ prefix: "cnt:" })) if (!v || Date.parse(v.ate) <= agora) { await s.delete(k); n++; }
    n += await limparFormularios(this, agora);
    n += await limparAvisos(this, agora);
    n += await limparEntradas(this, agora);
    n += await limparStatus(this, agora);
    n += await limparLinks(this, agora);
    return n;
  }
}
