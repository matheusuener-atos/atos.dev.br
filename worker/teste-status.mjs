// Teste das paginas de status do Atos Workspace (worker/status.js): a configuracao (o nome, os enderecos de fora, o
// limite), a porta, o nome unico, a agenda do Cron (o escalonamento, o limite por minuto), a conferencia (no ar, lento,
// fora, redirecionamento nao seguido, tempo), cair e voltar com o aviso por e-mail (e o teto do dia), a pagina publica (a
// CSP, sem os enderecos, 30/90 dias, nao publica, inexistente), o painel (ver, tirar do ar, ligar), a limpeza e apagar.
// Sem rede.
//   node worker/teste-status.mjs
import { GET, chamar, checar, contaPronta, darPro, env, fim, novoEnv, objeto, rede, sessao } from "./apoio-teste-workspace.mjs";
import { conferirStatus, conferirStatusAgendado } from "./status.js";

console.log("a configuração");
const E = (url, nome = "") => ({ nome, url });
checar(conferirStatus({ nome: "minha-loja", enderecos: [E("https://loja.com.br/saude")] }).cfg.titulo === "minha-loja", "vale; o título cai no nome");
checar(Boolean(conferirStatus({ nome: "ab", enderecos: [E("https://loja.com.br")] }).erro), "nome curto");
checar(Boolean(conferirStatus({ nome: "atos-loja", enderecos: [E("https://loja.com.br")] }).erro) && Boolean(conferirStatus({ nome: "status", enderecos: [E("https://loja.com.br")] }).erro), "nomes reservados");
checar(Boolean(conferirStatus({ nome: "minha-loja", enderecos: [] }).erro), "sem endereço");
checar(/no máximo 10/.test(conferirStatus({ nome: "minha-loja", enderecos: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => E("https://a" + i + ".com.br")) }).erro), "mais de 10 (o teto do Pro)");
for (const u of ["http://loja.com.br", "https://10.0.0.1/", "https://localhost/", "https://atos.dev.br/", "https://servidor.internal/", "https://loja.com.br:8080/"]) {
  checar(Boolean(conferirStatus({ nome: "minha-loja", enderecos: [E(u)] }).erro), "recusa " + u);
}
checar(/duas vezes/.test(conferirStatus({ nome: "minha-loja", enderecos: [E("https://a.com.br"), E("https://a.com.br")] }).erro), "o mesmo endereço duas vezes");

console.log("a porta e o salvar");
let r = await GET("/api/workspace/status");
checar(r.status === 401, "sem sessão: 401");
const maria = await contaPronta("maria");
await darPro(maria.sub); // dois endereços e o aviso por e-mail: o Pro (o gratuito está em teste-plano.mjs)
r = await GET("/api/workspace/status", maria.pessoal);
checar(r.status === 403 && r.d.codigo === "entrar_pelo_alias", "pelo e-mail pessoal: 403");
r = await GET("/api/workspace/status", maria.cookie);
checar(r.status === 200 && r.d.cfg === null && r.d.base === "https://atos.dev.br/status/", "pelo alias: abre, sem página ainda", r.d);
const CFG = { acao: "salvar", nome: "horta", titulo: "Horta Viva", publica: true, avisar: true, enderecos: [E("https://horta.com.br/", "Site"), E("https://api.horta.com.br/saude", "API")] };
r = await chamar("/api/workspace/status", { cookie: maria.cookie, corpo: CFG });
checar(r.status === 200 && r.d.cfg.nome === "horta" && r.d.cfg.enderecos.length === 2 && r.d.salvo, "cria", r.d);
const EIDS = r.d.cfg.enderecos.map((e) => e.id);
checar((await objeto("indice").ctx.storage.get("spag:horta")).sub === maria.sub && (await objeto("indice").ctx.storage.get("sag:" + maria.sub)), "o índice: o nome e a agenda");
const joao = await contaPronta("joao");
await darPro(joao.sub);
r = await chamar("/api/workspace/status", { cookie: joao.cookie, corpo: CFG });
checar(r.status === 409, "o mesmo nome em outra conta: 409");
r = await chamar("/api/workspace/status", { cookie: await sessao(maria.email, { alias: maria.alias, idade: 13 * 3600 }), corpo: CFG });
checar(r.status === 401 && r.d.reentrar, "mudar pede login recente");

console.log("a conferência (o Cron)");
const enviados = [];
const enviarEmail = async (e, m) => { enviados.push(m); return { ok: true }; };
let respostas = {};
rede.fn = async (url, op) => {
  const f = respostas[url] || (() => new Response("ok"));
  return f(url, op);
};
let agora = Date.now();
rede.chamadas.length = 0;
let x = await conferirStatusAgendado(env, { agora: () => agora, enviarEmail });
checar(x.contas === 1, "o Cron confere a conta vencida", x);
checar(rede.chamadas.length === 2 && rede.chamadas.every((c) => c.op.method === "GET" && c.op.redirect === "manual" && /AtosStatus/.test(c.op.headers["user-agent"])), "GET em cada endereço, sem seguir redirecionamento");
r = await GET("/api/workspace/status", maria.cookie);
checar(r.d.estados[EIDS[0]].ult.estado === "ok" && r.d.estados[EIDS[0]].recentes.length === 1, "no ar, com a conferência recente", r.d.estados);
x = await conferirStatusAgendado(env, { agora: () => agora + 30000, enviarEmail });
checar(x.contas === 0, "antes de 1 minuto (o intervalo do Pro), não confere de novo");
agora += 5 * 60000;
respostas["https://api.horta.com.br/saude"] = () => new Response("erro", { status: 503 });
respostas["https://horta.com.br/"] = () => new Response(null, { status: 301, headers: { location: "https://10.0.0.1/" } });
rede.chamadas.length = 0;
await conferirStatusAgendado(env, { agora: () => agora, enviarEmail });
r = await GET("/api/workspace/status", maria.cookie);
checar(r.d.estados[EIDS[0]].ult.estado === "ok" && !rede.chamadas.some((c) => /10\.0\.0\.1/.test(c.url)), "301 conta como no ar e não é seguido");
checar(r.d.estados[EIDS[1]].ult.estado === "fora" && r.d.estados[EIDS[1]].ult.codigo === 503 && !enviados.length, "503: fora; uma vez só não avisa");
agora += 5 * 60000;
await conferirStatusAgendado(env, { agora: () => agora, enviarEmail });
checar(enviados.length === 1 && enviados[0].para === maria.destino && /Fora do ar: API/.test(enviados[0].assunto), "duas seguidas fora: caiu, com o e-mail ao destino do alias", enviados[0]);
agora += 5 * 60000;
await conferirStatusAgendado(env, { agora: () => agora, enviarEmail });
checar(enviados.length === 1, "continua fora: não repete o aviso");
delete respostas["https://api.horta.com.br/saude"];
respostas["https://horta.com.br/"] = () => { throw new TypeError("conexao"); };
agora += 5 * 60000;
await conferirStatusAgendado(env, { agora: () => agora, enviarEmail });
checar(enviados.length === 2 && /De volta: API/.test(enviados[1].assunto), "voltou: o aviso de volta");
r = await GET("/api/workspace/status", maria.cookie);
checar(r.d.estados[EIDS[0]].ult.estado === "fora" && r.d.estados[EIDS[0]].ult.codigo === 0 && r.d.eventos.length === 2, "erro de conexão: fora; os acontecimentos", r.d.eventos);
delete respostas["https://horta.com.br/"];
respostas["https://api.horta.com.br/saude"] = () => new Promise((ok) => setTimeout(() => ok(new Response("ok")), 3100));
agora += 5 * 60000;
await conferirStatusAgendado(env, { agora: () => agora, enviarEmail });
r = await GET("/api/workspace/status", maria.cookie);
checar(r.d.estados[EIDS[1]].ult.estado === "lento" && r.d.estados[EIDS[1]].ult.ms >= 3000, "acima de 3 s: lento", r.d.estados[EIDS[1]].ult);
delete respostas["https://api.horta.com.br/saude"];
{
  const o = objeto("conta:" + maria.sub);
  let n = 0;
  for (let i = 0; i < 30; i++) { const y = await o.fazer({ op: "st_conferir" }, agora + i); n += y.avisos.length; respostas["https://api.horta.com.br/saude"] = i % 4 < 2 ? () => new Response("", { status: 500 }) : undefined; if (!respostas["https://api.horta.com.br/saude"]) delete respostas["https://api.horta.com.br/saude"]; }
  checar(n <= 10, "no máximo 10 avisos por dia", n);
}

console.log("o limite por minuto");
{
  const e2 = novoEnv({ STATUS_POR_MINUTO: "2" });
  for (const nome of ["ana", "bia", "caio"]) {
    const c = await contaPronta(nome, { e: e2 });
    await chamar("/api/workspace/status", { cookie: c.cookie, corpo: { ...CFG, nome: "pagina-" + nome, avisar: false, enderecos: CFG.enderecos.slice(0, 1) }, e: e2 });
  }
  const y = await conferirStatusAgendado(e2, { agora: () => Date.now() + 1000, enviarEmail });
  checar(y.contas === 2 && y.restantes === 1, "STATUS_POR_MINUTO=2: confere 2, a terceira fica para o minuto seguinte", y);
  const z = await conferirStatusAgendado(e2, { agora: () => Date.now() + 61000, enviarEmail });
  checar(z.contas === 1, "e sai no minuto seguinte", z);
}

console.log("a página pública");
r = await GET("/status/horta");
let html = await r.r.text();
const csp = r.r.headers.get("content-security-policy") || "";
checar(r.status === 200 && /Horta Viva/.test(html) && /<span class="st-ponto/.test(html) && /default-src 'none'/.test(csp) && !/script-src/.test(csp) && !/<script/.test(html), "200, sem script, com a CSP própria");
checar(!/horta\.com\.br/.test(html) && /API/.test(html) && /Site/.test(html), "os nomes dos endereços, nunca as URLs");
checar((html.match(/<div class="st-barras/g) || []).length === 2 && (html.split(/<div class="st-barras[^"]*"/)[1].split('</div>')[0].match(/<span/g) || []).length === 30, "30 dias por padrão");
r = await GET("/status/horta?dias=90");
html = await r.r.text();
checar((html.split(/<div class="st-barras[^"]*"/)[1].split('</div>')[0].match(/<span/g) || []).length === 90 && /aria-current="page">90 dias/.test(html), "e 90 com ?dias=90");
checar(r.r.headers.get("cache-control") === "public, max-age=60", "60 s de cache");
r = await GET("/status/nao-existe");
checar(r.status === 404, "inexistente: 404");
await chamar("/api/workspace/status", { cookie: maria.cookie, corpo: { ...CFG, publica: false } });
r = await GET("/status/horta");
checar(r.status === 404, "não pública: 404");
await chamar("/api/workspace/status", { cookie: maria.cookie, corpo: CFG });
r = await chamar("/status/horta", { metodo: "POST", corpo: {} });
checar(r.status === 405, "POST: 405");

console.log("o painel");
const sup = await sessao("sup@atos.dev.br");
const fin = await sessao("fin@atos.dev.br");
r = await GET("/api/admin/workspace/status", fin);
checar(r.status === 200 && r.d.paginas.some((p) => p.nome === "horta" && p.conta === maria.email) && typeof r.d.agenda.atrasadas === "number", "todos veem as páginas e a agenda", r.d.agenda);
r = await chamar("/api/admin/workspace/status/horta/desligar", { cookie: fin, corpo: { motivo: "abuso" } });
checar(r.status === 403, "o financeiro não tira do ar");
r = await chamar("/api/admin/workspace/status/horta/desligar", { cookie: sup, corpo: { motivo: "página enganosa" } });
checar(r.status === 200, "o suporte tira do ar");
checar((await GET("/status/horta")).status === 404, "a página some");
rede.chamadas.length = 0;
await objeto("indice").fazer({ op: "sag_marcar", sub: maria.sub, proxima: 0 }, Date.now());
await conferirStatusAgendado(env, { agora: () => Date.now(), enviarEmail });
checar(!rede.chamadas.length, "as conferências param");
r = await chamar("/api/workspace/status", { cookie: maria.cookie, corpo: CFG });
checar(r.status === 403, "o dono não muda");
r = await GET("/api/workspace/status", maria.cookie);
checar(r.d.cfg.bloqueado.motivo === "página enganosa", "e vê o motivo");
r = await chamar("/api/admin/workspace/status/horta/ligar", { cookie: sup, corpo: {} });
checar(r.status === 200 && (await GET("/status/horta")).status === 200, "liga de novo");

console.log("a limpeza e apagar");
{
  const o = objeto("conta:" + maria.sub);
  const velho = new Date(Date.now() - 95 * 864e5).toISOString().slice(0, 10);
  await o.ctx.storage.put("st:dia:" + EIDS[0] + "|" + velho, { n: 1, ok: 1, lento: 0, fora: 0, ms: 10 });
  await o.limpar(Date.now());
  checar(!(await o.ctx.storage.get("st:dia:" + EIDS[0] + "|" + velho)), "o dia de mais de 90 dias some");
}
r = await chamar("/api/workspace/status", { cookie: maria.cookie, corpo: { ...CFG, enderecos: [E("https://horta.com.br/", "Site")] } });
checar(!(await objeto("conta:" + maria.sub).ctx.storage.get("st:ult:" + EIDS[1])), "o endereço que saiu leva o histórico");
r = await chamar("/api/workspace/status", { cookie: maria.cookie, corpo: { acao: "apagar" } });
checar(r.status === 400, "apagar pede confirmar");
r = await chamar("/api/workspace/status", { cookie: maria.cookie, corpo: { acao: "apagar", confirmar: true } });
checar(r.status === 200 && r.d.cfg === null && (await GET("/status/horta")).status === 404 && !(await objeto("indice").ctx.storage.get("sag:" + maria.sub)), "apaga: a página, a agenda e o nome");
r = await chamar("/api/workspace/status", { cookie: joao.cookie, corpo: CFG });
checar(r.status === 200, "o nome fica livre para outra conta");

console.log("as páginas da área");
r = await GET("/workspace/status");
checar(r.status === 302 && /volta=%2Fworkspace%2Fstatus/.test(r.r.headers.get("location")), "/workspace/status sem sessão: a tela de entrar");
rede.fn = null;
fim();
