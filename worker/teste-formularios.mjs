// Teste dos Formularios do Atos Workspace (worker/formularios.js): a porta (sessao, Workspace, e-mail Atos, login pelo
// alias, login recente), a configuracao (os sites, os campos, o "obrigado", o limite, os nomes), o envio pela rota publica
// (HTML e JSON, CORS, origem, armadilha, campos, tamanho, limite por endereco, do dia e da Atos, o alias parado, o
// Workspace desativado, desligar, redirecionar), a entrega (o e-mail ao destino do alias, o Reply-To, nada do conteudo
// guardado), o registro e a limpeza (30 dias), o Turnstile (a pagina da Atos, o bilhete assinado, a verificacao), o
// painel da equipe (ver, desligar, ligar; papeis) e o conferidor de enderecos de fora. Sem rede.
//   node worker/teste-formularios.mjs
import { A, GET, chamar, checar, contaPronta, darPro, enviados, env, fim, novoEnv, objeto, rede, resendFalhar, sessao, ativar } from "./apoio-teste-workspace.mjs";
import { conferirOrigem, conferirUrlExterna } from "./url-externa.js";
import { atenderFormularioPublico, conferirFormulario, limparCampos } from "./formularios.js";

const SITE = "https://loja.exemplo.com.br";

// ------------------------------------------------------------------ os enderecos de fora

console.log("os endereços de fora (url-externa.js)");
checar(conferirUrlExterna("https://exemplo.com.br/aviso").url === "https://exemplo.com.br/aviso", "https com domínio vale");
for (const [u, porque] of [["http://exemplo.com.br", "http"], ["https://127.0.0.1/x", "IP v4"], ["https://[::1]/", "IP v6"], ["https://localhost/", "localhost"],
  ["https://intranet/", "sem ponto"], ["https://maquina.local/", ".local"], ["https://x.internal/", ".internal"], ["https://atos.dev.br/x", "a Atos"],
  ["https://api.atos.dev.br/", "subdomínio da Atos"], ["https://atos-teste.conta.workers.dev/", "o Worker de teste"], ["https://u:s@exemplo.com.br/", "usuário e senha"],
  ["https://exemplo.com.br:8080/", "porta"], ["https://exemplo.test/", ".test"], ["ftp://exemplo.com.br/", "ftp"], ["https://2130706433/", "IP em número"]]) {
  checar(Boolean(conferirUrlExterna(u).erro), "recusa " + porque + " (" + u + ")");
}
checar(conferirOrigem("https://exemplo.com.br/").origem === "https://exemplo.com.br", "origem sem a barra");
checar(conferirOrigem("http://127.0.0.1:5500").origem === "http://127.0.0.1:5500", "http só em 127.0.0.1 e localhost");
checar(Boolean(conferirOrigem("http://exemplo.com.br").erro) && Boolean(conferirOrigem("https://exemplo.com.br/contato").erro), "http de fora e caminho recusados");

// ------------------------------------------------------------------ a configuracao

console.log("a configuração");
const BASE = { nome: "Contato do site", origens: [SITE], campos: ["nome", "email", "mensagem"], livres: [], limite_dia: 50 };
checar(conferirFormulario(BASE, env).cfg.origens[0] === SITE, "a configuração básica vale");
checar(/nome/.test(conferirFormulario({ ...BASE, nome: "a" }, env).erro), "nome curto");
checar(/site/.test(conferirFormulario({ ...BASE, origens: [] }, env).erro), "sem site");
checar(/no máximo 5/.test(conferirFormulario({ ...BASE, origens: ["https://a.com.br", "https://b.com.br", "https://c.com.br", "https://d.com.br", "https://e.com.br", "https://f.com.br"] }, env).erro), "mais de 5 sites");
checar(/campo/.test(conferirFormulario({ ...BASE, campos: [], livres: [] }, env).erro), "sem campo");
checar(/campo livre/.test(conferirFormulario({ ...BASE, livres: ["Telefone!"] }, env).erro), "campo livre fora do formato");
checar(/padrão/.test(conferirFormulario({ ...BASE, livres: ["email"] }, env).erro), "campo livre com nome de padrão");
checar(/no máximo 5/.test(conferirFormulario({ ...BASE, livres: ["a1", "a2", "a3", "a4", "a5", "a6"] }, env).erro), "mais de 5 livres");
checar(/um dos sites/.test(conferirFormulario({ ...BASE, redirecionar: "https://outro.com.br/obrigado" }, env).erro), "o “obrigado” fora dos sites do formulário");
checar(/https/.test(conferirFormulario({ ...BASE, redirecionar: "http://loja.exemplo.com.br/obrigado" }, env).erro), "o “obrigado” sem https");
checar(/1 a 1\.000/.test(conferirFormulario({ ...BASE, limite_dia: 1001 }, env).erro) && /1 a 1\.000/.test(conferirFormulario({ ...BASE, limite_dia: 0 }, env).erro), "o limite por dia vai de 1 a 1.000 (o teto do Pro)");
checar(/1 a 50 no plano gratuito/.test(conferirFormulario({ ...BASE, limite_dia: 51 }, env, 50).erro) && conferirFormulario({ ...BASE, limite_dia: 51 }, env, 50).codigo === "limite_do_plano", "no gratuito, de 1 a 50");
checar(conferirFormulario({ ...BASE, turnstile: true }, env).cfg.turnstile === false, "sem o Turnstile na Atos, a verificação não liga");
const cf = conferirFormulario({ ...BASE, livres: "telefone", campos: ["email", "mensagem"] }, env).cfg;
checar(limparCampos(cf, { email: "x@y.com.br", mensagem: "oi", telefone: "99", outro: "z" }).ignorados === 1, "campos não aceitos são ignorados");
checar(/e-mail/.test(limparCampos(cf, { email: "nao-e-email", mensagem: "oi" }).erro), "e-mail inválido");
checar(/vazio/.test(limparCampos(cf, { outro: "x" }).erro), "vazio");
checar(/5000/.test(limparCampos(cf, { mensagem: "x".repeat(5001) }).erro), "mensagem grande demais");

// ------------------------------------------------------------------ a porta

console.log("a porta (as mesmas regras das Integrações)");
let r = await GET("/api/workspace/formularios");
checar(r.status === 401, "sem sessão: 401");
const semWs = await sessao("semws@exemplo.com.br");
r = await GET("/api/workspace/formularios", semWs);
checar(r.status === 403 && r.d.codigo === "workspace", "sem o Workspace: 403", r.d);
await ativar(semWs);
r = await GET("/api/workspace/formularios", semWs);
checar(r.status === 403 && r.d.codigo === "sem_alias", "sem o e-mail Atos: 403 sem_alias", r.d);
const maria = await contaPronta("maria");
await darPro(maria.sub); // varios formularios: o Pro (o gratuito e a volta dele estão em teste-plano.mjs)
r = await GET("/api/workspace/formularios", maria.pessoal);
checar(r.status === 403 && r.d.codigo === "entrar_pelo_alias", "com o e-mail pessoal: 403 entrar_pelo_alias", r.d);
r = await GET("/api/workspace/formularios", maria.cookie);
checar(r.status === 200 && Array.isArray(r.d.formularios) && r.d.email_atos === maria.endereco && r.d.turnstile.disponivel === false, "pelo alias: abre, com o e-mail Atos e o Turnstile desligado", r.d);
r = await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: BASE, origem: "https://outro.com.br" });
checar(r.status === 403, "POST de outra origem: 403");
const velha = await sessao(maria.email, { alias: maria.alias, idade: 13 * 3600 });
r = await chamar("/api/workspace/formularios", { cookie: velha, corpo: BASE });
checar(r.status === 401 && r.d.reentrar, "login de mais de 12 horas: 401 reentrar", r.d);

console.log("criar, editar, ligar, desligar");
r = await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: { ...BASE, origens: ["http://loja.exemplo.com.br"] } });
checar(r.status === 400, "site sem https: 400", r.d);
r = await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: BASE });
checar(r.status === 200 && /^f-[a-z0-9]{12}$/.test(r.d.criado || "") && r.d.formularios.length === 1, "cria (o id f-...)", r.d);
const F1 = r.d.criado;
checar((await objeto("indice").ctx.storage.get("fidx:" + F1)).sub === maria.sub, "o índice sabe de quem é");
r = await chamar("/api/workspace/formularios/" + F1, { cookie: maria.cookie, corpo: { ...BASE, acao: "editar", nome: "Contato", livres: ["telefone"], origens: [SITE, "http://127.0.0.1:5500"] } });
checar(r.status === 200 && r.d.formularios[0].nome === "Contato" && r.d.formularios[0].livres[0] === "telefone", "edita", r.d);
checar((await objeto("indice").ctx.storage.get("fidx:" + F1)).nome === "Contato", "o nome novo vai ao índice");
const outros = [];
for (let i = 0; i < 9; i++) outros.push((await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: { ...BASE, nome: "F" + i } })).d.criado);
r = await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: BASE });
checar(r.status === 409 && r.d.codigo === "limite_do_plano", "o 11º: 409 (10 por conta no Pro)", r.d);
r = await chamar("/api/workspace/formularios/" + outros[0], { cookie: maria.cookie, corpo: { acao: "apagar" } });
checar(r.status === 400, "apagar sem confirmar: 400");
r = await chamar("/api/workspace/formularios/" + outros[0], { cookie: maria.cookie, corpo: { acao: "apagar", confirmar: true } });
checar(r.status === 200 && r.d.formularios.length === 9 && !(await objeto("indice").ctx.storage.get("fidx:" + outros[0])), "apaga (e sai do índice)");
const joao = await contaPronta("joao");
r = await chamar("/api/workspace/formularios/" + F1, { cookie: joao.cookie, corpo: { acao: "desligar" } });
checar(r.status === 404, "outra conta não mexe: 404", r.d);

// ------------------------------------------------------------------ o envio

const envio = (id, campos, { origem = SITE, json = false, ip = "203.0.113.7", aceita, e = env, cabecalhos = {} } = {}) => {
  const h = { "cf-connecting-ip": ip, ...cabecalhos };
  if (aceita) h.accept = aceita;
  if (json) return chamar("/f/" + id, { corpo: campos, origem, e, cabecalhos: { ...h, accept: "application/json" } });
  return chamar("/f/" + id, { texto: new URLSearchParams(campos).toString(), tipo: "application/x-www-form-urlencoded", origem, e, cabecalhos: { accept: "text/html", ...h } });
};
const regDe = async (id, sub = maria.sub) => [...(await objeto("conta:" + sub).ctx.storage.list({ prefix: "flog:" + id + "|" })).values()];

console.log("o envio pela rota pública");
r = await GET("/f/" + F1);
checar(r.status === 200 && /Endereço de formulário/.test(await r.r.text()) && /default-src 'none'/.test(r.r.headers.get("content-security-policy")), "GET mostra o que é, com a CSP própria");
r = await GET("/f/f-naoexiste0000");
checar(r.status === 405 || r.status === 200, "GET de id desconhecido não quebra");
r = await envio("f-naoexiste0000", { mensagem: "oi" });
checar(r.status === 404, "id desconhecido: 404");
r = await chamar("/f/" + F1, { metodo: "OPTIONS", origem: SITE, cabecalhos: { "access-control-request-method": "POST" } });
checar(r.status === 204 && r.r.headers.get("access-control-allow-origin") === SITE, "OPTIONS do site cadastrado: o CORS libera");
r = await chamar("/f/" + F1, { metodo: "OPTIONS", origem: "https://intruso.com.br" });
checar(r.status === 204 && !r.r.headers.get("access-control-allow-origin"), "OPTIONS de outro site: sem CORS");

const antes = enviados.length;
r = await envio(F1, { nome: "Ana", email: "ana@cliente.com.br", mensagem: "Quero um orçamento: CONTEUDO-SECRETO", telefone: "94 9999", extra: "ignorado" });
let html = await r.r.text();
checar(r.status === 200 && /Mensagem enviada/.test(html) && /href="https:\/\/loja\.exemplo\.com\.br"/.test(html), "HTML: a página de obrigado com o voltar ao site", r.status);
checar(enviados.length === antes + 1, "um e-mail saiu");
let m = enviados[enviados.length - 1];
checar(m.to[0] === maria.destino && m.reply_to === "ana@cliente.com.br" && /^\[Contato\]/.test(m.subject) && /CONTEUDO-SECRETO/.test(m.text) && /Telefone|telefone/.test(m.text) && !/ignorado/.test(m.text),
  "ao destino do alias, Reply-To de quem preencheu, o assunto com o nome, sem o campo ignorado", { to: m.to, reply_to: m.reply_to, subject: m.subject });
checar(/naoresponda@atos\.dev\.br/.test(m.from) && /Responder a esta mensagem vai para ana@cliente\.com\.br/.test(m.html), "de naoresponda@ e o rodapé diz para onde vai a resposta");
const tudo = JSON.stringify([...objeto("conta:" + maria.sub).ctx.storage.m.entries(), ...objeto("indice").ctx.storage.m.entries()]);
checar(!/CONTEUDO-SECRETO/.test(tudo) && !/ana@cliente/.test(tudo) && !/203\.0\.113\.7/.test(tudo), "nada do conteúdo, do e-mail de quem enviou nem do endereço de internet ficou guardado");
let reg = await regDe(F1);
checar(reg.length === 1 && reg[0].resultado === "entregue" && reg[0].origem === SITE && reg[0].tamanho > 0, "o registro: quando, origem, resultado, tamanho", reg);

r = await envio(F1, { email: "bia@cliente.com.br", mensagem: "por fetch" }, { json: true, ip: "203.0.113.8" });
checar(r.status === 200 && r.d.ok === true && r.r.headers.get("access-control-allow-origin") === SITE, "JSON: {ok: true} com o CORS", r.d);
r = await envio(F1, { mensagem: "oi" }, { origem: "https://intruso.com.br", json: true });
checar(r.status === 403 && r.d.codigo === "origem" && !r.r.headers.get("access-control-allow-origin"), "de outro site: 403 origem, sem CORS", r.d);
r = await envio(F1, { mensagem: "sem origin" }, { origem: "" });
checar(r.status === 403, "sem Origin nem Referer: 403");
r = await envio(F1, { mensagem: "pelo referer" }, { origem: "", cabecalhos: { referer: SITE + "/contato.html" }, ip: "203.0.113.9" });
checar(r.status === 200, "sem Origin, pelo Referer do site: entrega");
const antesArm = enviados.length;
r = await envio(F1, { mensagem: "robô", _armadilha: "http://spam" }, { ip: "203.0.113.10" });
checar(r.status === 200 && /Mensagem enviada/.test(await r.r.text()) && enviados.length === antesArm, "armadilha preenchida: o obrigado de sempre e nada sai");
reg = await regDe(F1);
checar(reg.some((x) => x.resultado === "armadilha") && reg.some((x) => x.motivo === "origem"), "o registro anota a armadilha e a origem recusada");
r = await envio(F1, { email: "não é e-mail", mensagem: "x" }, { json: true, ip: "203.0.113.11" });
checar(r.status === 400 && /e-mail/.test(r.d.erro), "e-mail inválido: 400", r.d);
r = await envio(F1, { mensagem: "x".repeat(40000) }, { ip: "203.0.113.12" });
checar(r.status === 413, "mais de 32 KB: 413", r.status);
r = await chamar("/f/" + F1, { texto: "<xml/>", tipo: "application/xml", origem: SITE });
checar(r.status === 400, "formato desconhecido: 400");

console.log("os limites");
let ultimo;
for (let i = 0; i < 6; i++) ultimo = await envio(F1, { mensagem: "seguido " + i }, { json: true, ip: "198.51.100.1" });
checar(ultimo.status === 429 && ultimo.d.codigo === "limite_ip", "o sexto do mesmo endereço na hora: 429", ultimo.d);
r = await envio(F1, { mensagem: "outro endereço" }, { json: true, ip: "198.51.100.2" });
checar(r.status === 200, "outro endereço passa");
const F2 = (await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: { ...BASE, nome: "Pequeno", limite_dia: 2 } })).d.criado;
for (let i = 0; i < 2; i++) await envio(F2, { mensagem: "dia " + i }, { json: true, ip: "198.51.100." + (10 + i) });
r = await envio(F2, { mensagem: "terceiro" }, { json: true, ip: "198.51.100.20" });
checar(r.status === 429 && r.d.codigo === "limite_dia", "o limite do dia do formulário: 429 limite_dia", r.d);
{
  const e2 = novoEnv({ FORMULARIOS_LIMITE_DIA: "1" });
  const c2 = await contaPronta("carla", { e: e2 });
  const f = (await chamar("/api/workspace/formularios", { cookie: c2.cookie, corpo: BASE, e: e2 })).d.criado;
  await envio(f, { mensagem: "um" }, { json: true, e: e2, ip: "192.0.2.1" });
  r = await envio(f, { mensagem: "dois" }, { json: true, e: e2, ip: "192.0.2.2" });
  checar(r.status === 503 && r.d.codigo === "limite_atos", "o teto diário da Atos: 503 limite_atos", r.d);
}

console.log("o que precisa estar de pé");
await maria.pedirEmail("desligar", {});
r = await envio(F1, { mensagem: "alias desligado" }, { json: true, ip: "192.0.2.30" });
checar(r.status === 503 && r.d.codigo === "parado", "o encaminhamento do alias desligado: 503", r.d);
checar((await regDe(F1)).some((x) => x.motivo === "alias_desligado"), "o registro diz o motivo (alias_desligado)");
await maria.pedirEmail("ligar", {});
await chamar("/api/workspace/desativar", { cookie: maria.pessoal, corpo: { confirmar: true } });
r = await envio(F1, { mensagem: "sem workspace" }, { json: true, ip: "192.0.2.31" });
checar(r.status === 503 && (await regDe(F1)).some((x) => x.motivo === "sem_workspace"), "o Workspace desativado: 503 (sem_workspace)", r.d);
await ativar(maria.pessoal);
resendFalhar(true);
r = await envio(F1, { mensagem: "o resend caiu" }, { json: true, ip: "192.0.2.32" });
resendFalhar(false);
checar(r.status === 502 && (await regDe(F1)).some((x) => x.resultado === "falhou"), "o e-mail não saiu: 502 e o registro diz falhou", r.d);
r = await chamar("/api/workspace/formularios/" + F1, { cookie: maria.cookie, corpo: { acao: "desligar" } });
r = await envio(F1, { mensagem: "desligado" }, { json: true, ip: "192.0.2.33" });
checar(r.status === 403 && r.d.codigo === "desligado", "desligado pelo dono: 403", r.d);
await chamar("/api/workspace/formularios/" + F1, { cookie: maria.cookie, corpo: { acao: "ligar" } });
await chamar("/api/workspace/formularios/" + F1, { cookie: maria.cookie, corpo: { ...BASE, acao: "editar", nome: "Contato", livres: ["telefone"], redirecionar: SITE + "/obrigado" } });
r = await envio(F1, { mensagem: "com obrigado" }, { ip: "192.0.2.34" });
checar(r.status === 303 && r.r.headers.get("location") === SITE + "/obrigado", "com o endereço de obrigado: 303 para ele", r.status);

console.log("o registro e a limpeza");
r = await GET("/api/workspace/formularios/" + F1 + "/registro", maria.cookie);
checar(r.status === 200 && r.d.registro.length >= 8 && r.d.retencao_dias === 30 && !JSON.stringify(r.d).includes("orçamento"), "o dono vê o registro, sem conteúdo", r.d.registro && r.d.registro.length);
{
  const velho = Date.now() - 40 * 864e5;
  await atenderFormularioPublico(new Request(A + "/f/" + F1, { method: "POST", headers: { origin: "https://intruso.com.br", "content-type": "application/json" }, body: "{}" }), env, new URL(A + "/f/" + F1), { agora: () => velho });
  const o = objeto("conta:" + maria.sub);
  const n0 = (await regDe(F1)).length;
  checar((await regDe(F1)).some((x) => x.quando < new Date(Date.now() - 30 * 864e5).toISOString()), "uma linha de 40 dias atrás");
  await o.limpar(Date.now());
  const depois = await regDe(F1);
  checar(depois.length === n0 - 1 && !depois.some((x) => x.quando < new Date(Date.now() - 30 * 864e5).toISOString()), "a limpeza tira o que passou de 30 dias", { n0, n: depois.length });
  checar(typeof o.ctx.storage.alarme === "number", "o alarme da limpeza fica marcado");
}

console.log("o Turnstile (a verificação na página da Atos)");
{
  const e3 = novoEnv({ TURNSTILE_SECRET: "segredo-turnstile", TURNSTILE_SITEKEY: "chave-publica" });
  const c3 = await contaPronta("tiago", { e: e3 });
  r = await GET("/api/workspace/formularios", c3.cookie, e3);
  checar(r.d.turnstile.disponivel === true, "com o segredo e a chave: disponível");
  const f = (await chamar("/api/workspace/formularios", { cookie: c3.cookie, corpo: { ...BASE, turnstile: true }, e: e3 })).d.criado;
  r = await envio(f, { email: "x@cliente.com.br", mensagem: "pelo JSON" }, { json: true, e: e3, ip: "192.0.2.40" });
  checar(r.status === 400 && r.d.codigo === "verificacao", "JSON com a verificação ligada: 400 verificacao", r.d);
  const antesT = enviados.length;
  r = await envio(f, { email: "x@cliente.com.br", mensagem: "TEXTO-DO-BILHETE" }, { e: e3, ip: "192.0.2.41" });
  html = await r.r.text();
  const csp = r.r.headers.get("content-security-policy") || "";
  const bilhete = (/name="_atos_bilhete" value="([^"]+)"/.exec(html) || [])[1];
  checar(r.status === 200 && /cf-turnstile/.test(html) && /data-sitekey="chave-publica"/.test(html) && bilhete && enviados.length === antesT, "HTML: a página de confirmação, com o bilhete, e nada saiu ainda");
  checar(/script-src https:\/\/challenges\.cloudflare\.com/.test(csp) && /frame-src https:\/\/challenges\.cloudflare\.com/.test(csp) && !/unsafe-inline/.test(csp), "a CSP da página libera só o Turnstile", csp);
  const tudo3 = JSON.stringify([...e3.WS_DADOS.get("conta:" + c3.sub).o.ctx.storage.m.entries()]);
  checar(!/TEXTO-DO-BILHETE/.test(tudo3), "o conteúdo está no bilhete, não guardado");
  let verificado = [];
  rede.fn = async (url, op) => {
    if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      const p = new URLSearchParams(op.body);
      verificado.push(Object.fromEntries(p));
      return Response.json(p.get("response") === "token-bom" ? { success: true, hostname: "atos.dev.br" } : p.get("response") === "token-outro-host" ? { success: true, hostname: "outro.com" } : { success: false });
    }
    throw new Error("fetch inesperado " + url);
  };
  const segundo = (campos) => chamar("/f/" + f, { texto: new URLSearchParams(campos).toString(), tipo: "application/x-www-form-urlencoded", origem: A, e: e3, cabecalhos: { accept: "text/html", "cf-connecting-ip": "192.0.2.41" } });
  r = await segundo({ _atos_bilhete: bilhete, "cf-turnstile-response": "token-ruim" });
  checar(r.status === 400 && enviados.length === antesT, "o desafio não passou: 400 e nada sai");
  r = await segundo({ _atos_bilhete: bilhete, "cf-turnstile-response": "token-outro-host" });
  checar(r.status === 400 && enviados.length === antesT, "o desafio resolvido em outro site: 400");
  r = await segundo({ _atos_bilhete: bilhete.replace(/.$/, (c) => (c === "a" ? "b" : "a")), "cf-turnstile-response": "token-bom" });
  checar(r.status === 400 && enviados.length === antesT, "o bilhete adulterado: 400");
  r = await segundo({ _atos_bilhete: bilhete, "cf-turnstile-response": "token-bom" });
  checar(r.status === 200 && enviados.length === antesT + 1 && /TEXTO-DO-BILHETE/.test(enviados[enviados.length - 1].text) && verificado.at(-1).secret === "segredo-turnstile", "o desafio passou: entrega", r.status);
  r = await chamar("/f/" + f, { texto: new URLSearchParams({ _atos_bilhete: bilhete, "cf-turnstile-response": "token-bom" }).toString(), tipo: "application/x-www-form-urlencoded", origem: "https://intruso.com.br", e: e3 });
  checar(r.status === 400, "o bilhete mandado de outro site: 400");
  rede.fn = null;
}

console.log("o painel da equipe");
const dono = await sessao("dono@atos.dev.br");
const sup = await sessao("sup@atos.dev.br");
const fin = await sessao("fin@atos.dev.br");
r = await GET("/api/admin/workspace/formularios", fin);
const linha = r.d && r.d.formularios.find((x) => x.id === F1);
checar(r.status === 200 && linha && linha.conta === maria.email && linha.numeros.hoje.entregues >= 3 && r.d.global.limite === 500, "todos os papéis veem: o dono, os números do dia e o teto", r.d && r.d.global);
r = await chamar("/api/admin/workspace/formularios/" + F1 + "/desligar", { cookie: fin, corpo: { motivo: "spam" } });
checar(r.status === 403, "o financeiro não desliga");
r = await chamar("/api/admin/workspace/formularios/" + F1 + "/desligar", { cookie: sup, corpo: {} });
checar(r.status === 400, "sem motivo: 400");
r = await chamar("/api/admin/workspace/formularios/" + F1 + "/desligar", { cookie: sup, corpo: { motivo: "phishing denunciado" } });
checar(r.status === 200, "o suporte desliga com o motivo", r.d);
r = await envio(F1, { mensagem: "depois do bloqueio" }, { json: true, ip: "192.0.2.50" });
checar(r.status === 403 && r.d.codigo === "desligado", "desligado pela Atos: os envios param");
r = await GET("/api/workspace/formularios", maria.cookie);
checar(r.d.formularios.find((x) => x.id === F1).bloqueado.motivo === "phishing denunciado", "o dono vê o motivo");
r = await chamar("/api/workspace/formularios/" + F1, { cookie: maria.cookie, corpo: { acao: "ligar" } });
checar(r.status === 403, "e não consegue religar", r.d);
r = await GET("/api/admin/workspace", dono);
checar(r.status === 200 && r.d.registro.some((x) => x.tipo === "workspace.formulario.desligar"), "fica no registro da equipe");
r = await chamar("/api/admin/workspace/formularios/" + F1 + "/ligar", { cookie: dono, corpo: {} });
checar(r.status === 200, "o dono liga de novo");
r = await envio(F1, { mensagem: "ligado de novo" }, { json: true, ip: "192.0.2.51" });
checar(r.status === 200, "e volta a entregar");

console.log("as páginas e a área");
r = await GET("/workspace/formularios");
checar(r.status === 302 && /\/workspace\/entrar\/\?volta=%2Fworkspace%2Fformularios/.test(r.r.headers.get("location")), "/workspace/formularios sem sessão: a tela de entrar do Workspace");
r = await GET("/workspace/formularios", maria.cookie);
checar(r.status === 200 && /pagina \/workspace\/</.test(await r.r.text()) && /script-src 'self'/.test(r.r.headers.get("content-security-policy")), "/workspace/formularios serve a página do Workspace com a CSP da conta");

fim();
