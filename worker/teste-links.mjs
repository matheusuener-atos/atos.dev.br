// Teste da pagina de links do Atos Workspace (worker/links.js): os nomes (formato, reservados, o e-mail Atos de outra
// pessoa e o contrario), os links (so https, sem IP, localhost, Atos, produtos da Atos, encurtadores nem titulo com o nome
// da Atos), a foto (so PNG/JPEG/WebP de verdade, ate 50 KB), a porta (Workspace ativo; o e-mail Atos nao e exigido; quem
// tem o alias entra por ele), a pagina publica (sem script, CSP propria, o dominio embaixo de cada link, o rodape), o
// redirecionamento contado (so os links da propria pagina; nunca aberto; so no Pro; sem endereco de internet), o contato
// pelo formulario da pessoa, a denuncia (origem, armadilha, limites, sem guardar quem denunciou), o painel (ver, tirar do
// ar com motivo, ligar, resolver; os papeis), o Workspace desativado e apagar. Sem rede.
//   node worker/teste-links.mjs
import { A, GET, ativar, chamar, checar, contaPronta, darPro, enviados, env, fim, novoEnv, objeto, sessao } from "./apoio-teste-workspace.mjs";
import { conferirFoto, conferirLink, conferirNomeDaPagina, conferirPagina } from "./links.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const L = (titulo, url, extra = {}) => ({ titulo, url, ...extra });

console.log("os nomes");
checar(conferirNomeDaPagina("maria-doces").nome === "maria-doces" && conferirNomeDaPagina("@Maria-Doces").nome === "maria-doces", "vale (e o @ e as maiúsculas caem)");
for (const n of ["ab", "maria_doces", "-maria", "maria--doces", "maria.doces", "a".repeat(31)]) checar(Boolean(conferirNomeDaPagina(n).erro), "formato recusado: " + n);
for (const n of ["atos", "atos-oficial", "contatos", "pavlvs", "p4vlvs", "paulus-ia", "banco-xyz", "itau-cartoes", "nubank-pix", "receitafederal", "gov-br", "login", "suporte", "pix", "caixa", "google-ajuda", "whatsapp-web", "admin", "status"]) {
  checar(Boolean(conferirNomeDaPagina(n).erro), "reservado: " + n);
}
for (const n of ["maria-doces", "horta-viva", "joao123", "pizzaria-do-ze"]) checar(!conferirNomeDaPagina(n).erro, "passa: " + n);

console.log("os links");
for (const u of ["http://loja.com.br", "https://10.0.0.1/", "https://[::1]/", "https://localhost/x", "https://atos.dev.br/entrar", "https://conta.atos.dev.br/", "https://paulus.ia.br/",
  "https://bit.ly/abc", "https://tinyurl.com/x", "https://t.co/x", "https://loja.com.br:8443/", "https://user:senha@loja.com.br/", "javascript:alert(1)", "data:text/html,oi", "https://servidor.internal/"]) {
  checar(Boolean(conferirLink(L("Loja", u)).erro), "link recusado: " + u);
}
for (const t of ["Entrar na Conta Atos", "Atos", "PAVLVS oficial", "Suporte Atos", "atos.dev.br"]) checar(Boolean(conferirLink(L(t, "https://loja.com.br")).erro), "título recusado: " + t);
const ok = conferirLink(L("Minha loja", "https://loja.com.br/produtos#x"));
checar(ok.link && ok.link.url === "https://loja.com.br/produtos" && /^l[0-9a-f]{6}$/.test(ok.link.id) && ok.link.ativo === true, "vale (sem o fragmento), com um id novo", ok);
checar(conferirLink({ ...L("Contatos", "https://loja.com.br"), id: "l000000" }, new Set(["l000000"])).link.id === "l000000", "o id que já existe fica");
checar(conferirLink({ ...L("x", "https://loja.com.br"), id: "l000000" }, new Set()).link.id !== "l000000", "um id inventado não é aceito");

console.log("a foto");
checar(conferirFoto(PNG).foto === PNG && conferirFoto("").foto === "", "PNG de verdade, ou nenhuma");
checar(Boolean(conferirFoto("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=").erro), "SVG recusado");
checar(Boolean(conferirFoto("data:image/png;base64," + Buffer.from("<html>nao e png</html>").toString("base64")).erro), "o conteúdo não é PNG: recusado");
checar(Boolean(conferirFoto(PNG.replace("image/png", "image/jpeg")).erro), "PNG dizendo ser JPEG: recusado");
checar(/50 KB/.test(conferirFoto("data:image/png;base64," + "A".repeat(70000)).erro || ""), "acima de 50 KB: recusada");
checar(/exibição/.test(conferirPagina({ nome: "maria-doces", exibicao: "" }).erro), "sem o nome de exibição: recusada");
checar(conferirPagina({ nome: "maria-doces", exibicao: "<b>Maria</b>", frase: "doces <script>x</script>", links: [] }).pagina.exibicao === "b Maria /b", "sem HTML: os < e > saem", conferirPagina({ nome: "maria-doces", exibicao: "<b>Maria</b>" }).pagina);

console.log("a porta");
let r = await GET("/api/workspace/links");
checar(r.status === 401, "sem sessão: 401");
const semWs = await sessao("semws@exemplo.com.br");
r = await GET("/api/workspace/links", semWs);
checar(r.status === 403 && r.d.codigo === "workspace", "sem o Workspace: 403", r.d);
await ativar(semWs);
r = await GET("/api/workspace/links", semWs);
checar(r.status === 200 && r.d.paginas.length === 0 && r.d.limites.paginas === 1 && r.d.limites.links === 5 && r.d.limites.cliques === false && r.d.email_atos === "",
  "sem o e-mail Atos: abre (não é exigido), com os limites do gratuito", r.d);
const maria = await contaPronta("maria");
r = await GET("/api/workspace/links", maria.pessoal);
checar(r.status === 403 && r.d.codigo === "entrar_pelo_alias", "quem tem o e-mail Atos entra por ele: 403 pelo e-mail pessoal", r.d);
r = await GET("/api/workspace/links", maria.cookie);
checar(r.status === 200 && r.d.email_atos === maria.endereco && r.d.base === A + "/@", "pelo alias: abre, com o e-mail Atos para o botão", r.d);
const velha = await sessao(maria.email, { alias: maria.alias, idade: 13 * 3600 });
r = await chamar("/api/workspace/links", { cookie: velha, corpo: { acao: "salvar", nome: "maria-doces", exibicao: "Maria" } });
checar(r.status === 401 && r.d.reentrar, "mudar pede login recente");
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { acao: "salvar", nome: "maria-doces", exibicao: "Maria" }, origem: "https://golpe.example" });
checar(r.status === 403, "POST de outra origem: 403");

console.log("criar (gratuito: 1 página, 5 links)");
const PAG = { acao: "salvar", nome: "maria-doces", exibicao: "Maria Doces", frase: "Bolos e doces por encomenda", foto: PNG, email_atos: true,
  links: [L("Cardápio", "https://mariadoces.com.br/cardapio"), L("Instagram", "https://www.instagram.com/mariadoces"), L("WhatsApp", "https://wa.me/5594999999999"), L("Desligado", "https://mariadoces.com.br/velho", { ativo: false })] };
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: PAG });
checar(r.status === 200 && r.d.salvo === "maria-doces" && r.d.paginas.length === 1 && r.d.paginas[0].links.length === 4, "cria", r.d);
const LIDS = r.d.paginas[0].links.map((x) => x.id);
checar((await objeto("indice").ctx.storage.get("lpag:maria-doces")).sub === maria.sub, "o índice sabe de quem é");
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, nome: "maria-bolos" } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano" && r.d.pro === "/workspace/plano", "a segunda página no gratuito: 409 com o Conhecer o Pro", r.d);
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, links: [1, 2, 3, 4, 5, 6].map((i) => L("L" + i, "https://mariadoces.com.br/" + i)) } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano" && /5 links/.test(r.d.erro), "seis links no gratuito: 409", r.d);
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, links: [L("Golpe", "https://bit.ly/x")] } });
checar(r.status === 400 && /encurtador/.test(r.d.erro), "encurtador: 400", r.d);
const joao = await contaPronta("joao");
r = await chamar("/api/workspace/links", { cookie: joao.cookie, corpo: { ...PAG, email_atos: false } });
checar(r.status === 409 && /outra página/.test(r.d.erro), "o mesmo nome em outra conta: 409", r.d);
r = await chamar("/api/workspace/links", { cookie: joao.cookie, corpo: { ...PAG, nome: "maria.loja".replace(".", "-"), email_atos: false } });
checar(r.status === 200, "outro nome: cria");
r = await chamar("/api/workspace/links", { cookie: joao.cookie, corpo: { ...PAG, nome: "joao-x", email_atos: false } });
checar(r.status === 409, "(e o João também só tem uma)");

console.log("o nome e o e-mail Atos de outra pessoa");
{
  // A Bia tem o e-mail Atos bia-docinhos@; o João não pode pegar "bia-docinhos" como página. E o contrário: a página
  // "maria-doces" não vira o e-mail Atos de ninguém.
  const bia = await contaPronta("bia");
  await bia.pedirEmail("remover", {});
  await bia.pedirEmail("reservar", { alias: "bia-docinhos" });
  await chamar("/api/workspace/links", { cookie: joao.cookie, corpo: { acao: "apagar", nome: "maria-loja", confirmar: true } });
  r = await chamar("/api/workspace/links", { cookie: joao.cookie, corpo: { ...PAG, nome: "bia-docinhos", email_atos: false } });
  checar(r.status === 409 && /e-mail Atos de outra pessoa/.test(r.d.erro), "o e-mail Atos de outra pessoa: 409", r.d);
  const nova = await sessao("nova@exemplo.com.br");
  await ativar(nova);
  r = await chamar("/api/workspace/email/alias", { cookie: nova, corpo: { alias: "maria-doces" } });
  checar(r.status === 409, "o nome da página de outra pessoa não vira e-mail Atos", r.d);
  r = await GET("/api/workspace/email/disponivel?alias=maria-doces", nova);
  checar(r.d && r.d.ok === false, "e a busca diz que não está disponível", r.d);
}

console.log("a página pública");
r = await GET("/@maria-doces");
let html = await r.r.text();
const csp = r.r.headers.get("content-security-policy") || "";
checar(r.status === 200 && /default-src 'none'/.test(csp) && !/script-src/.test(csp) && !/<script/i.test(html) && /img-src 'self' data:/.test(csp), "200, sem script, com a CSP própria", csp);
checar(/Maria Doces/.test(html) && /Bolos e doces por encomenda/.test(html) && /<img class="lk-foto" src="data:image\/png/.test(html), "o nome, a frase e a foto");
checar(/href="https:\/\/mariadoces\.com\.br\/cardapio"/.test(html) && /<span class="lk-dominio">mariadoces\.com\.br<\/span>/.test(html) && /<span class="lk-dominio">instagram\.com<\/span>/.test(html),
  "no gratuito o link vai direto, com o domínio embaixo");
checar(!/\/ir\//.test(html) && !/Desligado/.test(html), "sem o redirecionamento contado, e o link desligado não aparece");
checar(/mailto:maria\.loja@atos\.dev\.br/.test(html), "o botão do e-mail Atos");
checar(/Página criada por uma pessoa com Conta Atos\. A Atos não verificou estes links\./.test(html) && /href="\/@maria-doces\/denunciar">Denunciar esta página/.test(html), "o rodapé fixo e o Denunciar");
checar(r.r.headers.get("cache-control") === "public, max-age=60" && r.r.headers.get("x-frame-options") === "DENY", "60 s de cache e sem moldura");
checar((await GET("/@nao-existe")).status === 404 && (await GET("/@AB")).status === 404 && (await GET("/@maria-doces/outra-coisa")).status === 404, "inexistente, fora do formato e caminho desconhecido: 404");

console.log("o redirecionamento");
r = await GET("/@maria-doces/ir/" + LIDS[0]);
checar(r.status === 302 && r.r.headers.get("location") === "https://mariadoces.com.br/cardapio", "um link da página: 302 para ele");
r = await GET("/@maria-doces/ir/" + LIDS[3]);
checar(r.status === 404, "o link desligado: 404");
r = await GET("/@maria-doces/ir/l999999");
checar(r.status === 404, "id que não é da página: 404");
r = await GET("/@maria-doces/ir/" + encodeURIComponent("https://golpe.example"));
checar(r.status === 404 && !r.r.headers.get("location"), "nunca um redirecionador aberto");
checar(![...objeto("conta:" + maria.sub).ctx.storage.m.keys()].some((k) => k.startsWith("lk:clk:")), "no gratuito nada é contado");

console.log("o Pro: 3 páginas, 50 links, os cliques");
await darPro(maria.sub);
r = await GET("/api/workspace/links", maria.cookie);
checar(r.d.limites.paginas === 3 && r.d.limites.links === 50 && r.d.limites.cliques === true && r.d.plano.id === "pro", "os limites do Pro", r.d.limites);
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, links: [...PAG.links, ...[1, 2, 3, 4, 5, 6].map((i) => L("L" + i, "https://mariadoces.com.br/" + i))].map((x, i) => ({ ...x, id: LIDS[i] })) } });
checar(r.status === 200 && r.d.paginas[0].links.length === 10 && r.d.paginas[0].links[0].id === LIDS[0], "dez links (os ids ficam)", r.d);
for (const n of ["maria-bolos", "maria-salgados"]) checar((await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, nome: n, email_atos: false } })).status === 200, "mais uma página: " + n);
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, nome: "maria-quarta", email_atos: false } });
checar(r.status === 409 && r.d.codigo === "limite_do_plano", "a quarta: 409", r.d);
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, links: Array.from({ length: 51 }, (_, i) => L("L" + i, "https://mariadoces.com.br/" + i)) } });
checar(r.status === 400 && /no máximo 50/.test(r.d.erro), "51 links: 400", r.d);
html = await (await GET("/@maria-doces")).r.text();
checar(new RegExp('href="/@maria-doces/ir/' + LIDS[0] + '"').test(html) && /<span class="lk-dominio">mariadoces\.com\.br<\/span>/.test(html), "no Pro o link passa pelo redirecionamento, e o domínio continua embaixo");
for (let i = 0; i < 3; i++) await chamar("/@maria-doces/ir/" + LIDS[0], { metodo: "GET", cabecalhos: { "cf-connecting-ip": "203.0.113.50" } });
await chamar("/@maria-doces/ir/" + LIDS[1], { metodo: "GET" });
r = await GET("/api/workspace/links", maria.cookie);
const pg = r.d.paginas.find((x) => x.nome === "maria-doces");
checar(pg.cliques && pg.cliques.total === 4 && pg.cliques.por_link[LIDS[0]] === 3 && pg.cliques.por_dia.length === 1, "os cliques por dia e por link", pg.cliques);
checar(!JSON.stringify([...objeto("conta:" + maria.sub).ctx.storage.m.entries()]).includes("203.0.113.50"), "sem o endereço de internet de quem clicou");

console.log("o contato pelo formulário da pessoa");
{
  const f = (await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: { nome: "Encomendas", origens: ["https://mariadoces.com.br"], campos: ["nome", "email", "mensagem"] } })).d.criado;
  const outro = (await chamar("/api/workspace/formularios", { cookie: maria.cookie, corpo: { nome: "Outro", origens: ["https://mariadoces.com.br"], campos: ["mensagem"] } })).d.criado;
  r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, formulario: f, links: PAG.links.map((x, i) => ({ ...x, id: LIDS[i] })) } });
  checar(r.status === 200 && r.d.paginas[0].formulario === f, "escolhe o formulário", r.d);
  r = await chamar("/api/workspace/links", { cookie: joao.cookie, corpo: { acao: "salvar", nome: "joao-x", exibicao: "João", formulario: f } });
  checar(r.status === 400 || r.status === 409, "o formulário de outra conta: recusado", r.d);
  html = await (await GET("/@maria-doces")).r.text();
  checar(/href="\/@maria-doces\/contato"/.test(html) && /Encomendas/.test(html), "o botão do formulário");
  r = await GET("/@maria-doces/contato");
  html = await r.r.text();
  checar(r.status === 200 && new RegExp('action="/f/' + f + '"').test(html) && /name="_armadilha"/.test(html) && !/<script/i.test(html), "a página de contato: o formulário, a armadilha, sem script");
  const antes = enviados.length;
  r = await chamar("/f/" + f, { texto: new URLSearchParams({ nome: "Ana", email: "ana@cliente.com.br", mensagem: "Quero um bolo" }).toString(), tipo: "application/x-www-form-urlencoded", cabecalhos: { accept: "text/html", "cf-connecting-ip": "203.0.113.60" } });
  html = await r.r.text();
  checar(r.status === 200 && /Mensagem enviada/.test(html) && /href="https:\/\/atos\.dev\.br\/@maria-doces"/.test(html) && enviados.length === antes + 1, "enviado da Atos: entrega, e o voltar é a página de links", r.status);
  r = await chamar("/f/" + outro, { texto: "mensagem=oi", tipo: "application/x-www-form-urlencoded", cabecalhos: { accept: "application/json", "cf-connecting-ip": "203.0.113.61" } });
  checar(r.status === 403 && r.d.codigo === "origem", "o formulário que não está na página não aceita a Atos como origem", r.d);
  r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { ...PAG, nome: "maria-bolos", email_atos: false, formulario: f } });
  checar(r.status === 409 && /uma página só/.test(r.d.erro), "um formulário vai em uma página só", r.d);
}

console.log("a denúncia");
r = await GET("/@maria-doces/denunciar");
html = await r.r.text();
checar(r.status === 200 && /Denunciar a página @maria-doces/.test(html) && /method="post"/.test(html) && !/<script/i.test(html) && /noindex/.test(html), "o formulário da denúncia, sem script");
const den = (campos, { origem = A, ip = "203.0.113.70", e = env } = {}) => chamar("/@maria-doces/denunciar", { texto: new URLSearchParams(campos).toString(), tipo: "application/x-www-form-urlencoded", origem, e, cabecalhos: { "cf-connecting-ip": ip } });
r = await den({ motivo: "golpe", texto: "pede senha" }, { origem: "https://golpe.example" });
checar(r.status === 403, "de outra origem: 403");
r = await den({ motivo: "xpto" });
checar(r.status === 400, "sem um motivo da lista: 400");
r = await den({ motivo: "golpe", texto: "O link do Instagram pede a senha do banco." });
checar(r.status === 200 && /Denúncia recebida/.test(await r.r.text()), "recebida");
const dens = () => [...objeto("indice").ctx.storage.m.entries()].filter(([k]) => k.startsWith("lden:")).map(([, v]) => v);
checar(dens().length === 1 && dens()[0].nome === "maria-doces" && dens()[0].motivo === "golpe" && dens()[0].estado === "aberta" && !JSON.stringify(dens()).includes("203.0.113.70"), "guardada para a equipe, sem o endereço de internet", dens());
r = await den({ motivo: "spam", _armadilha: "x" });
checar(r.status === 200 && dens().length === 1, "a armadilha: “recebida” e nada fica");
{
  let limitado = false;
  r = await den({ motivo: "spam" }, { e: { ...env, LIMITE: { limit: async () => { limitado = true; return { success: false }; } } } });
  checar(r.status === 429 && limitado, "passa pelo limite por endereço de internet");
}
for (let i = 0; i < 25; i++) r = await den({ motivo: "spam" }, { ip: "198.51.100." + i });
checar(r.status === 429 && dens().length === 20, "no máximo 20 por página por dia", dens().length);
checar((await GET("/@nao-existe/denunciar")).status === 404, "página inexistente: 404");

console.log("o painel");
const fin = await sessao("fin@atos.dev.br");
const sup = await sessao("sup@atos.dev.br");
r = await GET("/api/admin/workspace/links", fin);
checar(r.status === 200 && r.d.paginas.some((x) => x.nome === "maria-doces" && x.conta === maria.email && x.denuncias_abertas === 20) && r.d.denuncias.length === 20, "todos veem as páginas e as denúncias", r.d.paginas);
r = await GET("/api/admin/workspace/links/maria-doces", fin);
checar(r.status === 200 && r.d.pagina.links.some((x) => x.dominio === "instagram.com") && r.d.pagina.foto === "(com foto)", "o detalhe: os links com o domínio", r.d);
r = await GET("/api/admin/workspace", fin);
checar(r.d.numeros.links && r.d.numeros.links.denuncias_abertas === 20 && r.d.atencao.denuncias.length === 20, "a visão geral conta as denúncias abertas", r.d.numeros.links);
r = await chamar("/api/admin/workspace/links/maria-doces/desligar", { cookie: fin, corpo: { motivo: "golpe" } });
checar(r.status === 403, "o financeiro não tira do ar");
r = await chamar("/api/admin/workspace/links/maria-doces/desligar", { cookie: sup, corpo: {} });
checar(r.status === 400, "tirar do ar pede o motivo");
r = await chamar("/api/admin/workspace/links/maria-doces/desligar", { cookie: sup, corpo: { motivo: "link pedindo senha de banco" } });
checar(r.status === 200, "o suporte tira do ar");
r = await GET("/@maria-doces");
checar(r.status === 410 && /tirou esta página do ar/.test(await r.r.text()), "a página pública: 410");
checar((await GET("/@maria-doces/ir/" + LIDS[0])).status === 404 && (await GET("/@maria-doces/contato")).status === 404, "o redirecionamento e o contato param");
r = await GET("/api/workspace/links", maria.cookie);
checar(r.d.paginas.find((x) => x.nome === "maria-doces").bloqueado.motivo === "link pedindo senha de banco", "a dona vê o motivo");
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: PAG });
checar(r.status === 403, "e não muda a página");
const idDen = dens()[0].id;
r = await chamar("/api/admin/workspace/links/denuncias/" + idDen + "/resolver", { cookie: sup, corpo: { nota: "página tirada do ar" } });
checar(r.status === 200 && dens().find((x) => x.id === idDen).estado === "resolvida", "resolve uma denúncia");
r = await chamar("/api/admin/workspace/links/maria-doces/ligar", { cookie: sup, corpo: {} });
checar(r.status === 200 && (await GET("/@maria-doces")).status === 200, "liga de novo");

console.log("o Workspace desativado e apagar");
await chamar("/api/workspace/desativar", { cookie: maria.pessoal, corpo: { confirmar: true } });
r = await GET("/@maria-doces");
checar(r.status === 404 && /não está no ar agora/.test(await r.r.text()), "Workspace desativado: a página sai do ar");
await ativar(maria.pessoal);
checar((await GET("/@maria-doces")).status === 200, "ativado de novo: volta");
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { acao: "apagar", nome: "maria-doces" } });
checar(r.status === 400, "apagar pede confirmar");
r = await chamar("/api/workspace/links", { cookie: maria.cookie, corpo: { acao: "apagar", nome: "maria-doces", confirmar: true } });
checar(r.status === 200 && r.d.apagada === "maria-doces" && !(await objeto("indice").ctx.storage.get("lpag:maria-doces")) &&
  ![...objeto("conta:" + maria.sub).ctx.storage.m.keys()].some((k) => k.startsWith("lk:clk:maria-doces")), "apaga: a página, a estatística e o nome");
checar((await GET("/@maria-doces")).status === 404, "e a página some");
r = await chamar("/api/workspace/links", { cookie: joao.cookie, corpo: { ...PAG, email_atos: false } });
checar(r.status === 200, "o nome fica livre para outra conta");

console.log("a página da área");
r = await GET("/workspace/links");
checar(r.status === 302 && /volta=%2Fworkspace%2Flinks/.test(r.r.headers.get("location")), "/workspace/links sem sessão: a tela de entrar");
r = await GET("/workspace/links", maria.cookie);
checar(r.status === 200 && /script-src 'self'/.test(r.r.headers.get("content-security-policy")), "/workspace/links com a CSP da conta");
void novoEnv;
fim();
