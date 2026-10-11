// Teste do painel da Atos (worker/admin.js): quem entra, o login recente e os papeis. Sem rede.
//   node worker/teste-admin.mjs
import { atenderAdmin, equipe, RECENTE_S } from "./admin.js";
import { sha256 } from "./comum.js";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

const guardados = new Map();
const CONTAS = { get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { guardados.set(k, v); }, delete: async (k) => { guardados.delete(k); } };
const agora = Date.parse("2026-10-11T12:00:00Z");
const env = {
  CONTAS,
  ATOS_EQUIPE: JSON.stringify([{ email: "Dono@Atos.dev.br", nome: "Matheus", papel: "dono" }, { email: "sup@atos.dev.br", papel: "suporte" }, { email: "x@y", papel: "rei" }]),
};

/* Uma sessao aberta para o e-mail, com o login de `horas` atras: o cookie. */
async function sessao(email, horas) {
  const segredo = "s-" + email + "-" + horas;
  guardados.set("id:conta:" + email, JSON.stringify({ sub: "sub-" + email, nome: "Nome" }));
  guardados.set("atos:sessao:" + (await sha256(segredo)), JSON.stringify({ sub: "sub-" + email, email, auth_time: Math.floor(agora / 1000 - horas * 3600) }));
  return "__Host-atos=" + segredo;
}
async function pedir(metodo, caminho, cookie, deps = {}) {
  const req = new Request("https://atos.dev.br" + caminho, { method: metodo, headers: cookie ? { cookie } : {} });
  const r = await atenderAdmin(req, env, new URL(req.url), { agora: () => agora, ...deps });
  return { status: r.status, d: await r.json() };
}

console.log("a equipe");
checar(equipe(env).length === 2 && equipe(env)[0].email === "dono@atos.dev.br", "a equipe: o e-mail em minúsculas e só papel que existe", equipe(env));
checar(equipe({ ATOS_EQUIPE: "isto não é json" }).length === 0 && equipe({}).length === 0, "sem a lista (ou com ela quebrada), ninguém entra");

console.log("quem entra");
let r = await pedir("GET", "/api/admin/eu");
checar(r.status === 401 && r.d.entrar, "sem sessão: 401, entrar", r);
r = await pedir("GET", "/api/admin/eu", await sessao("fora@x.br", 1));
checar(r.status === 403, "Conta Atos fora da equipe: 403", r);
r = await pedir("GET", "/api/admin/eu", await sessao("dono@atos.dev.br", RECENTE_S / 3600 + 1));
checar(r.status === 401 && r.d.reentrar, "login de mais de 12 horas: 401, entrar de novo", r);
const dono = await sessao("dono@atos.dev.br", 1);
r = await pedir("GET", "/api/admin/eu", dono);
checar(r.status === 200 && r.d.email === "dono@atos.dev.br" && r.d.papel === "dono" && r.d.nome === "Matheus", "o dono entra", r.d);

{
  const bom = env.ATOS_EQUIPE;
  env.ATOS_EQUIPE = "master@atos.dev.br";
  r = await pedir("GET", "/api/admin/eu", dono);
  checar(r.status === 403 && r.d.config && /ATOS_EQUIPE/.test(r.d.erro), "a lista quebrada (só o e-mail, sem o JSON): 403 dizendo que é a configuração", r);
  env.ATOS_EQUIPE = bom;
}

console.log("as notas");
const chamadas = [];
const emissor = async (req, e, url, quem) => { chamadas.push({ metodo: req.method, caminho: url.pathname, quem }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
r = await pedir("GET", "/api/admin/nfse/situacao", dono);
checar(r.status === 503, "sem o emissor ligado: 503", r);
r = await pedir("POST", "/api/admin/nfse/notas", dono, { emissor });
checar(r.status === 200 && chamadas.at(-1).quem.papel === "dono" && chamadas.at(-1).caminho === "/api/admin/nfse/notas", "o dono emite: o emissor recebe quem pediu", chamadas.at(-1));
const sup = await sessao("sup@atos.dev.br", 1);
r = await pedir("GET", "/api/admin/nfse/notas", sup, { emissor });
checar(r.status === 200, "o suporte consulta", r.status);
const antes = chamadas.length;
r = await pedir("POST", "/api/admin/nfse/notas/1/cancelar", sup, { emissor });
checar(r.status === 403 && chamadas.length === antes, "o suporte não cancela nem emite: 403, e o emissor nem é chamado", r);
r = await pedir("GET", "/api/admin/outra", dono, { emissor });
checar(r.status === 404, "rota que não existe: 404");

console.log(falhas ? "\n" + falhas + " falha(s)" : "\ntudo certo");
process.exit(falhas ? 1 : 0);
