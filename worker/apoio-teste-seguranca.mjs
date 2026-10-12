// Para os testes: o Durable Object da seguranca de cada conta (worker/seguranca/objeto.js) rodando na memoria deste
// processo, e um atalho para ligar a segunda etapa de uma conta (os testes do painel, que exige a verificacao em duas
// etapas). Os objetos sao os mesmos para todos os env do processo (como no Worker: um objeto por conta).
import { SegurancaConta } from "./seguranca/objeto.js";

export function memoria() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { let n = 0; for (const x of Array.isArray(k) ? k : [k]) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = "" } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))); },
  };
}

const objetos = new Map();

/* Poe em `env` o binding SEGURANCA. */
export function comSeguranca(env) {
  env.SEGURANCA = {
    idFromName: (n) => String(n),
    get(id) {
      if (!objetos.has(id)) objetos.set(id, new SegurancaConta({ storage: memoria() }, env));
      const o = objetos.get(id);
      return { fetch: (url, op) => o.fetch(new Request(url, op)), o };
    },
  };
  return env;
}

/* Liga a segunda etapa da conta `sub` com uma chave de acesso de mentira (so para o painel deixar entrar). */
export async function ligarSegundaEtapa(env, sub) {
  if (!env.SEGURANCA) comSeguranca(env);
  const o = env.SEGURANCA.get(sub).o;
  const reg = (await o.ctx.storage.get("reg")) || { chaves: [] };
  if (!reg.chaves.length) {
    reg.chaves.push({ id: "chave-de-teste", nome: "Chave de teste", criada: "2026-10-11T00:00:00.000Z", ultimo_uso: null, alg: -7, jwk: {}, contador: 0, rp: "atos.dev.br", sincronizada: false, transportes: [] });
  }
  await o.ctx.storage.put("reg", reg);
}
