// O checkout ainda depende da homologação e do receptor Plantare (M3/M4).
// Mesmo uma flag acidental em produção não inicia cobranças nesta versão.
export function checkoutAtivo(env) {
  return env.AMBIENTE === "teste" && env.PLANTARE_ORCAMENTOS_ATIVOS === "1"
    && env.PLANTARE_COMPRAS_ATIVAS === "1" && env.PLANTARE_CHECKOUT_ATIVO === "1";
}

export async function agendar(o, depois = 60000) {
  const atual = await o.ctx.storage.getAlarm(), proximo = o.agora() + depois;
  if (atual === null || atual > proximo) await o.ctx.storage.setAlarm(proximo);
}

export function objetoPlantare(env) {
  return env.PLANTARE_ORCAMENTOS.get(env.PLANTARE_ORCAMENTOS.idFromName(
    (env.AMBIENTE === "teste" ? "teste:" : "producao:") + "plantare:orcamentos:v1"));
}

export function urlCheckout(env, id) {
  if (!checkoutAtivo(env)) return null;
  // Nenhum host vindo do pedido ou do navegador determina o destino.
  const origem = String(env.PLANTARE_CHECKOUT_ORIGEM || "");
  if (!/^https:\/\/atos-teste\.[a-z0-9-]+\.workers\.dev$/.test(origem)
      && !/^https?:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(origem)) return null;
  return origem + "/plantare/assinar?compra=" + id;
}
