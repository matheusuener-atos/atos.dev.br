import { cliente, idDoCliente } from "../cliente.js";
import { agendar, checkoutAtivo } from "./config.js";
import { conferirLancamento } from "./faturamento-contrato.js";

// Outbox por compra: a versão mais recente substitui a pendente. ACK de uma
// versão antiga nunca remove trabalho criado enquanto a chamada estava em voo.
export async function planejarFaturamento(o, tx, r) {
  if (!r.email || r.fase === "rascunho" || r.financeiro_versao === r.snapshot.versao) return false;
  const atual = await tx.getAlarm(), proximo = o.agora() + 60000;
  if (atual === null || atual > proximo) await tx.setAlarm(proximo);
  await tx.put("financeiro-pendente:" + r.snapshot.id, {
    versao: r.snapshot.versao, tentativas: 0, proxima: o.agora(),
  });
  r.financeiro_versao = r.snapshot.versao;
  return true;
}

export async function sincronizarFaturamento(o) {
  if (!checkoutAtivo(o.env)) return;
  const prefix = "financeiro-pendente:", cursor = await o.ctx.storage.get("financeiro-cursor");
  let itens = await o.ctx.storage.list({ prefix, ...(cursor ? { startAfter: cursor } : {}), limit: 16 });
  if (!itens.size && cursor) itens = await o.ctx.storage.list({ prefix, limit: 16 });
  if (!itens.size) return;
  await agendar(o);
  for (const [key] of itens) {
    const trabalho = await o.ctx.storage.transaction(async (tx) => {
      const job = await tx.get(key);
      if (!job || job.proxima > o.agora()) return null;
      const r = await tx.get("compra:" + key.slice(prefix.length));
      if (!r) return null;
      job.tentativas++;
      job.proxima = o.agora() + Math.min(3600000, 60000 * 2 ** Math.min(job.tentativas - 1, 6));
      await tx.put(key, job);
      return { job, r };
    });
    if (trabalho) {
      let sucesso = false;
      let etapa = "lançamento";
      try {
        const { snapshot: c, email } = trabalho.r;
        const p = conferirLancamento({ ...c, schema: "plantare-faturamento/v1", cliente: await idDoCliente(c.sub), email });
        if (!o.env.CLIENTES) throw new Error("registro financeiro indisponível");
        etapa = "faturamento";
        const espelho = await cliente(o.env, p.cliente, { sub: p.sub, email }).pedir("plantare_sincronizar", { lancamento: p });
        if (!espelho.ok || !(espelho.versao >= p.versao)) throw new Error("espelho financeiro não confirmou");
        const atual = await o.ctx.storage.get("compra:" + p.id);
        if (atual.snapshot.versao !== p.versao) throw new Error("a compra mudou durante a sincronização");
        // Zero não entra na fila fiscal; fica apenas no histórico do cliente.
        if (p.centavos > 0 && p.pago_em) {
          etapa = "fila fiscal";
          if (!o.env.EMISSOR_NFSE) throw new Error("emissor indisponível");
          const r = await o.env.EMISSOR_NFSE.get(o.env.EMISSOR_NFSE.idFromName("atos")).fetch("https://emissor-nfse/plantare_registrar", {
            method: "POST", body: JSON.stringify({ acao: "plantare_registrar", dados: { lancamento: p } }),
          });
          const ack = await r.json();
          if (!r.ok || !ack.ok || ack.versao < p.versao) throw new Error("fila fiscal não confirmou");
        }
        sucesso = true;
      } catch {
        await o.ctx.storage.transaction(async (tx) => {
          const atual = await tx.get(key);
          if (atual?.versao === trabalho.job.versao)
            await tx.put(key, { ...atual, ultimo_erro: "confirmação pendente: " + etapa });
        });
      }
      if (sucesso) await o.ctx.storage.transaction(async (tx) => {
        const atual = await tx.get(key);
        if (atual?.versao === trabalho.job.versao) {
          await tx.put("financeiro-confirmado:" + trabalho.r.snapshot.id, { versao: atual.versao, quando: new Date(o.agora()).toISOString() });
          await tx.delete(key);
        }
      });
    }
    await o.ctx.storage.put("financeiro-cursor", key);
  }
}
