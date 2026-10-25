import { DatabaseSync } from "node:sqlite";
import worker from "../../../index.js";
import { PlantareOrcamentos } from "../objeto.js";

export const TOKEN = "token-plantare-apenas-para-testes-1234567890";
export const PREFIXO = "/api/cobranca/v1/plantare";
export const entrada = (extra = {}) => ({ schema: "plantare-orcamento/v1", intent_id: "int-teste-0001", sub: "sub-ana",
  area_hash: "a".repeat(64), area_cent_ha: 9350, camadas: ["linhas_ab", "bordadura", "percurso", "manobras"], cupom: null, ...extra });

// Storage transacional real em SQLite. A fila representa o isolamento de
// transações do DO; injetamos também falha de escrita e perda da resposta.
export function storage() {
  const db = new DatabaseSync(":memory:");
  db.exec("create table dados (chave text primary key, valor text not null)");
  let cauda = Promise.resolve();
  const s = {
    falharEm: 0,
    async get(k) { const r = db.prepare("select valor from dados where chave = ?").get(k); return r ? JSON.parse(r.valor) : undefined; },
    async put(k, v) {
      if (s.falharEm && --s.falharEm === 0) throw new Error("falha de escrita simulada");
      db.prepare("insert into dados values (?,?) on conflict(chave) do update set valor=excluded.valor").run(k, JSON.stringify(v));
    },
    contar() { return db.prepare("select count(*) as n from dados").get().n; },
    async list({ prefix = "", startAfter = "", end = "\uffff", limit = 1000 } = {}) {
      const rows = db.prepare("select chave, valor from dados where chave >= ? and chave > ? and chave < ? order by chave limit ?")
        .all(prefix, startAfter, end, limit);
      return new Map(rows.filter((r) => r.chave.startsWith(prefix)).map((r) => [r.chave, JSON.parse(r.valor)]));
    },
    transaction(fn) {
      const run = cauda.then(async () => {
        db.exec("begin");
        try { const result = await fn(s); db.exec("commit"); return result; }
        catch (e) { db.exec("rollback"); throw e; }
      });
      cauda = run.catch(() => {});
      return run;
    },
    close() { db.close(); },
  };
  return s;
}

export function ambiente(cupons = {}) {
  const relogio = { agora: Date.parse("2026-10-24T12:00:00Z") };
  const objetos = new Map(), storages = new Map();
  const env = { PLANTARE_ORCAMENTOS_ATIVOS: "1", PLANTARE_COBRANCA_TOKEN: TOKEN, PLANTARE_CUPONS: JSON.stringify(cupons) };
  env.PLANTARE_ORCAMENTOS = {
    idFromName: (n) => n,
    get(id) {
      if (!storages.has(id)) storages.set(id, storage());
      if (!objetos.has(id)) objetos.set(id, new PlantareOrcamentos({ storage: storages.get(id) }, env, { agora: () => relogio.agora }));
      return { async fetch(url, op) {
        const r = await objetos.get(id).fetch(new Request(url, op));
        if (env.perderResposta) { env.perderResposta = false; throw new Error("resposta perdida após persistir"); }
        return r;
      } };
    },
  };
  async function chamar(path, { body, method = body === undefined ? "GET" : "POST", headers = {}, e = env } = {}) {
    const h = new Headers({ authorization: "Bearer " + TOKEN, "content-type": "application/json", "idempotency-key": "chave-teste-0001" });
    for (const [k, v] of Object.entries(headers)) { if (v === null) h.delete(k); else h.set(k, v); }
    const request = new Request("https://atos.dev.br" + path, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const r = await worker.fetch(request, e, { waitUntil() {} });
    return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
  }
  return { env, relogio, storages, objetos, chamar,
    post: (d = entrada(), options = {}) => chamar(PREFIXO + "/orcamentos", { ...options, body: d }),
    get: (sub = "sub-ana", id = "int-teste-0001") => chamar(PREFIXO + "/intencoes/" + id + "?sub=" + sub),
    close() { for (const s of storages.values()) s.close(); },
  };
}
