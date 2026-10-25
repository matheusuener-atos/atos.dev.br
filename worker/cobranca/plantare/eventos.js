import { assinarEvento } from "../eventos.js";
import { checkoutAtivo } from "./config.js";

export async function agendar(o, depois = 60000) {
  const atual = await o.ctx.storage.getAlarm();
  const proximo = o.agora() + depois;
  if (atual === null || atual > proximo) await o.ctx.storage.setAlarm(proximo);
}

// Alteração do snapshot e outbox pertencem à mesma transação. Uma entrega
// pode repetir; nunca se confirma ao produto antes do commit na Atos.
export async function guardarCompra(o, tx, r) {
  const antes = await tx.get("compra:" + r.snapshot.id);
  await tx.put("compra:" + r.snapshot.id, r);
  if (!antes || antes.snapshot.versao === r.snapshot.versao) return;
  const id = "plantare:" + r.snapshot.id + ":v" + r.snapshot.versao;
  const evento = { id, tipo: "compra.atualizada", produto: "plantare", criado: new Date(o.agora()).toISOString(),
    conta: { sub: r.snapshot.sub, email: r.email || null }, dados: r.snapshot };
  await tx.put("compra-versao:" + id, r.snapshot);
  await tx.put("evento:" + id, { evento, tentativas: 0, proxima: o.agora(), entregue: false });
  await tx.put("evento-pendente:" + id, id);
}

export async function entregarEventos(o) {
  if (!checkoutAtivo(o.env)) return;
  const prefix = "evento-pendente:", cursor = await o.ctx.storage.get("eventos-cursor");
  let pendentes = await o.ctx.storage.list({ prefix, ...(cursor ? { startAfter: cursor } : {}), limit: 16 });
  if (!pendentes.size && cursor) pendentes = await o.ctx.storage.list({ prefix, limit: 16 });
  if (!pendentes.size) return;
  await agendar(o);
  for (const [key, id] of pendentes) {
    const trabalho = await o.ctx.storage.transaction(async (tx) => {
      const r = await tx.get("evento:" + id);
      if (!r || r.entregue || r.proxima > o.agora()) return null;
      r.tentativas++;
      r.proxima = o.agora() + Math.min(3600000, 60000 * 2 ** Math.min(r.tentativas - 1, 6));
      await tx.put("evento:" + id, r);
      return r;
    });
    if (trabalho) {
      let entregue = false;
      const segredo = o.env.EVENTOS_SEGREDO_PLANTARE;
      if (o.env.PLANTARE_EVENTOS_TESTE && typeof segredo === "string" && segredo.length >= 32) {
        const corpo = JSON.stringify(trabalho.evento);
        try {
          const r = await o.env.PLANTARE_EVENTOS_TESTE.fetch("https://plantare.test/api/atos/eventos", { method: "POST",
            headers: { "content-type": "application/json", "Atos-Evento": id,
              "Atos-Assinatura": await assinarEvento(segredo, corpo, Math.floor(o.agora() / 1000)) },
            body: corpo, signal: AbortSignal.timeout(15000) });
          entregue = r.ok;
        } catch { /* a fila permanece para reentrega */ }
      }
      if (entregue) await o.ctx.storage.transaction(async (tx) => {
        const atual = await tx.get("evento:" + id);
        await tx.put("evento:" + id, { ...atual, entregue: true, entregue_em: new Date(o.agora()).toISOString() });
        await tx.delete(key);
      });
    }
    await o.ctx.storage.put("eventos-cursor", key);
  }
}
