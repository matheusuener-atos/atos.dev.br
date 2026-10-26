import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sha256 } from "../../../comum.js";
import { ambiente, entrada, PREFIXO } from "./apoio.mjs";
export const perfil = { nome: "Ana Teste", tipo: "pf", documento: "52998224725", email: "ana@example.test",
  endereco: { cep: "01001000", logradouro: "Praça da Sé", numero: "1", bairro: "Sé", cidade: "São Paulo", uf: "SP" } };

export async function abrir(t, cupons = {}) {
  const a = ambiente(cupons); t.after(() => a.close());
  Object.assign(a.env, { AMBIENTE: "teste", PLANTARE_COMPRAS_ATIVAS: "1", PLANTARE_CHECKOUT_ATIVO: "1",
    PLANTARE_CHECKOUT_ORIGEM: "https://atos-teste.exemplo.workers.dev", MP_ACCESS_TOKEN: "token-ficticio-do-gateway",
    MP_PAGADOR_TESTE: "test_user_123@testuser.com" });
  const kv = new Map();
  a.env.CONTAS = { async get(k, tipo) { const v = kv.get(k); return v === undefined ? null : tipo === "json" ? structuredClone(v) : JSON.stringify(v); } };
  for (const pessoa of ["ana", "beto"]) {
    const email = pessoa + "@example.test", sub = "sub-" + pessoa;
    kv.set("id:conta:" + email, { sub, nome: pessoa });
    kv.set("atos:sessao:" + await sha256("sessao-" + pessoa), { sub, email, auth_time: Math.floor(Date.now() / 1000) });
  }
  a.env.CLIENTES = { idFromName: (n) => n, get() { return { async fetch() { return Response.json({ ok: true, perfil: a.perfil }); } }; } };
  a.perfil = perfil;
  a.env.ASSETS = { async fetch() { return new Response(await readFile(new URL("../../../../public/plantare/assinar/index.html", import.meta.url), "utf8"), {
    headers: { "content-type": "text/html" },
  }); } };
  const gateway = { chamadas: [], orders: new Map(), porRef: new Map(), perder: false, falhar: false, transformar: null, travar: null };
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith("https://api.mercadopago.com/v1/orders"));
    gateway.chamadas.push({ url, ...init });
    if (gateway.falhar) throw new Error("rede fora");
    let order;
    if (init.method === "POST") {
      const body = JSON.parse(init.body), ref = body.external_reference;
      assert.equal(init.headers["X-Idempotency-Key"], ref);
      if (!gateway.porRef.has(ref)) {
        const id = "ORD" + (gateway.orders.size + 1);
        gateway.porRef.set(ref, id);
        gateway.orders.set(id, { id, external_reference: ref, type: "online", total_amount: body.total_amount,
          status: "action_required", status_detail: "waiting_transfer", country_code: "BRA",
          transactions: { payments: [{ amount: body.total_amount, status: "action_required", payment_method: {
            id: "pix", type: "bank_transfer", qr_code: "000201-Pix-teste", qr_code_base64: "aW1hZ2Vt" } }] } });
      }
      order = gateway.orders.get(gateway.porRef.get(ref));
      const retrato = structuredClone(order);
      if (gateway.travar) await gateway.travar;
      if (gateway.perder) { gateway.perder = false; throw new Error("gateway criou, resposta perdida"); }
      order = retrato;
    } else order = gateway.orders.get(String(url).split("/").at(-1));
    const d = structuredClone(order);
    return Response.json(gateway.transformar ? gateway.transformar(d) : d, { status: gateway.status || 200 });
  };
  a.gateway = gateway;
  a.browser = (id, pagar = false, options = {}) => a.chamar("/api/plantare-checkout/" + id + (pagar ? "/pagar" : ""), {
    ...(pagar ? { body: {} } : {}), ...options,
    headers: { authorization: null, cookie: "__Host-atos=sessao-ana", ...(pagar ? { origin: "https://atos.dev.br" } : {}), ...options.headers },
  });
  a.nova = async (extra = {}, key = "primeira-chave") => {
    const q = (await a.post(entrada(extra), { headers: { "idempotency-key": key } })).data;
    const r = await a.chamar(PREFIXO + "/checkouts", { body: { schema: "plantare-checkout/v1", sub: q.sub,
      intent_id: q.intent_id, orcamento_id: q.orcamento_id }, headers: { "idempotency-key": key } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  a.avancar = (ms = 15000) => { a.relogio.agora += ms; };
  a.pagarMP = () => {
    const order = [...gateway.orders.values()][0];
    Object.assign(order, { status: "processed", status_detail: "accredited", total_paid_amount: order.total_amount });
    Object.assign(order.transactions.payments[0], { status: "processed", status_detail: "accredited", paid_amount: order.total_amount });
    return order;
  };
  a.aviso = async (order, extra = {}) => {
    a.env.MP_WEBHOOK_SECRET = "segredo-do-aviso-para-testes";
    const ts = String(Date.now()), requestId = "aviso-teste";
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(a.env.MP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const manifest = `id:${order.id};request-id:${requestId};ts:${ts};`;
    const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(manifest)))].map((n) => n.toString(16).padStart(2, "0")).join("");
    return a.chamar("/api/mp/aviso?type=order&data.id=" + order.id, { body: { data: { id: order.id, status: "refunded" } },
      headers: { authorization: null, "x-request-id": requestId, "x-signature": `ts=${ts},v1=${hash}`, ...extra } });
  };
  return a;
}
