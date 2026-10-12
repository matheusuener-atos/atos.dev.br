// Loja da Maria: um site de exemplo (fictício) com o "Entrar com Atos" pelo pacote @atos.dev.br/entrar.
// Servidor Express com acesso confidencial: o segredo fica só em ATOS_CLIENT_SECRET (o pacote lê de lá).
// Rode com: node --env-file=.env servidor.mjs
import express from "express";
import session from "express-session";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { botaoEntrarComAtos, entrarComAtos, menuContaAtos } from "@atos.dev.br/entrar";

for (const v of ["ATOS_CLIENT_ID", "ATOS_REDIRECT_URI", "ATOS_CLIENT_SECRET", "SESSION_SECRET"]) {
  if (!process.env[v]) { console.error("Falta " + v + " no .env (veja o README)."); process.exit(1); }
}

// 1. O cliente, com o que o .env tem (o segredo o pacote lê sozinho de ATOS_CLIENT_SECRET).
const atos = entrarComAtos({
  clientId: process.env.ATOS_CLIENT_ID,
  voltaPara: process.env.ATOS_REDIRECT_URI, // exatamente como cadastrada na Atos
  emissor: process.env.ATOS_ISSUER || undefined, // vazio: https://atos.dev.br
});

const app = express();
app.use(express.static(fileURLToPath(new URL("./publico", import.meta.url))));
// O botão oficial da Atos (atos.dev.br/marca/): a folha vem do pacote (a mesma de https://atos.dev.br/marca/botao.css).
app.get("/atos/botao.css", (req, res) => res.type("text/css").sendFile(createRequire(import.meta.url).resolve("@atos.dev.br/entrar/botao.css")));
// O menu de conta do topo (a mesma folha de https://atos.dev.br/marca/menu.css).
app.get("/atos/menu.css", (req, res) => res.type("text/css").sendFile(createRequire(import.meta.url).resolve("@atos.dev.br/entrar/menu.css")));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: atos.voltaPara.startsWith("https:") },
}));

// 2. O botão "Entrar com Atos" leva para cá: o pacote gera state, nonce e o PKCE, e a pessoa vai à Atos.
//    O "Criar conta" vai a /criar-conta: o mesmo, com a Atos abrindo em "Criar a conta Atos" (prompt=create,
//    pacote 0.2.0 ou mais novo; o 0.1 ignora a opção e abre a tela de entrar, que também tem o "Criar conta").
//    Quem já tem conta clica em "Já tem conta? Entrar" lá mesmo; quem já está com a sessão aberta na Atos
//    segue direto para a permissão.
async function irParaAtos(req, res, extra) {
  const { url, guardar } = await atos.comecar(extra);
  req.session.atos = guardar;
  res.redirect(url);
}
app.get("/entrar", (req, res) => irParaAtos(req, res));
app.get("/criar-conta", (req, res) => irParaAtos(req, res, { criarConta: true }));

// 3. A Atos devolve a pessoa aqui (o endereço de volta cadastrado). O pacote confere tudo e troca o código.
app.get(new URL(atos.voltaPara).pathname, async (req, res) => {
  const guardado = req.session.atos;
  delete req.session.atos;
  try {
    const pessoa = await atos.concluir(req.originalUrl, guardado);
    req.session.pessoa = { id: pessoa.id, nome: pessoa.nome, email: pessoa.email, dono: pessoa.dono };
    res.redirect("/");
  } catch (e) {
    // access_denied: a conta não está liberada na Loja, ou a pessoa não permitiu.
    if (e.codigo === "access_denied") return res.redirect("/sem-acesso");
    res.status(400).send(pagina("Não deu para entrar", `<header class="cabeca"><a class="logo" href="/">Loja da Maria</a></header><section class="aviso"><h1>Não deu para entrar</h1><p>${esc(e.message)}</p><p><a class="botao" href="/">Voltar à loja</a></p></section>`));
  }
});

// 4. "Continuar como" (FedCM, Chrome e Edge): o navegador mostra a Conta Atos aberta nele, sem sair da loja.
//    publico/fedcm.js pede /fedcm/comecar (o nonce e o code_challenge; o code_verifier fica na sessão), chama
//    continuarComFedCM({ params }) e manda o código a /fedcm/concluir, que troca com o segredo (como na volta).
//    Sem FedCM no navegador, ou fechando a janela, o botão vai a /entrar (o redirecionamento de sempre).
app.get("/atos/entrar.js", (req, res) => res.type("text/javascript").sendFile(createRequire(import.meta.url).resolve("@atos.dev.br/entrar")));
app.post("/fedcm/comecar", async (req, res) => {
  const { params, guardar } = await atos.comecarFedCM();
  req.session.atosFedcm = guardar;
  res.json({ params, clientId: atos.clientId, emissor: atos.emissor, voltaPara: atos.voltaPara });
});
app.post("/fedcm/concluir", express.json({ limit: "2kb" }), async (req, res) => {
  const guardado = req.session.atosFedcm;
  delete req.session.atosFedcm;
  try {
    const pessoa = await atos.concluirFedCM(String((req.body && req.body.codigo) || ""), guardado);
    req.session.pessoa = { id: pessoa.id, nome: pessoa.nome, email: pessoa.email, dono: pessoa.dono };
    res.json({ ir: "/" });
  } catch (e) {
    res.status(e.codigo === "access_denied" ? 403 : 400).json({ ir: e.codigo === "access_denied" ? "/sem-acesso" : "/entrar", erro: e.message });
  }
});

app.post("/sair", express.urlencoded({ extended: false }), (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/sem-acesso", (req, res) => {
  res.status(403).send(pagina("Sem acesso", `<header class="cabeca"><a class="logo" href="/">Loja da Maria</a></header>
    <section class="aviso">
      <h1>Sua conta ainda não tem acesso</h1>
      <p>A área de clientes da Loja da Maria é só para quem já fez encomenda. Se você é cliente, mande uma mensagem que a Maria libera o seu e-mail.</p>
      <p><a class="botao" href="/">Voltar à loja</a></p>
    </section>`));
});

app.get("/", (req, res) => {
  const p = req.session.pessoa;
  // O menu de conta (pacote 0.5.0): "Entrar" antes; depois, o e-mail, e o clique abre o menu com Sair (POST /sair, que
  // sai da Loja, não da Atos; com a caixa "Sair da conta?"). A Maria, dona do aplicativo na Atos (pessoa.dono, o claim
  // atos_dono), vê também Minha conta e Workspace. publico/menu.js liga o comportamento.
  const topo = `<span class="conta" id="conta">${menuContaAtos(MENU(p))}</span>`;
  const corpo = p
    ? `<section class="ola">
        <p class="sobre">Área de clientes</p>
        <h1>Olá, ${esc(p.nome || p.email)}</h1>
        <p class="email">${esc(p.email)}</p>
        <div class="pedidos">
          <h2>Seus pedidos</h2>
          <p>Nenhuma encomenda em aberto. Que tal um bolo de fubá para o fim de semana?</p>
        </div>
      </section>`
    : `<section class="vitrine-topo">
        <h1>Bolos e doces feitos em casa</h1>
        <p>Encomende pela área de clientes e retire no sábado. Primeira vez aqui? Crie a sua conta. Já é cliente? Entre para ver os seus pedidos.</p>
        <div class="botoes">
          ${botaoEntrarComAtos({ tamanho: "grande", href: "/entrar" })}
          ${botaoEntrarComAtos({ tamanho: "grande", tema: "neutro", texto: "criar-conta", href: "/criar-conta" })}
        </div>
      </section>`;
  res.send(pagina("Loja da Maria", `<header class="cabeca"><a class="logo" href="/">Loja da Maria</a>${topo}</header>${corpo}${vitrine()}`));
});

/* As opções do menu (as mesmas em publico/menu.js). */
function MENU(p) {
  return { menu: true, marca: "a", tema: "claro", email: p ? p.email : "", entrar: "/entrar", sair: "/sair", confirmarSair: true, dono: Boolean(p && p.dono), atalhosDoDono: true };
}

function vitrine() {
  const itens = [["Bolo de fubá", "R$ 32,00"], ["Brigadeiro (cento)", "R$ 120,00"], ["Pão de mel", "R$ 6,50"]];
  return `<ul class="vitrine">${itens.map(([n, v], i) => `<li><div class="foto foto-${i + 1}" aria-hidden="true"></div><strong>${n}</strong><span>${v}</span></li>`).join("")}</ul>`;
}

function pagina(titulo, conteudo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/atos/botao.css"><link rel="stylesheet" href="/atos/menu.css"><link rel="stylesheet" href="/loja.css"><script type="module" src="/fedcm.js"></script><script type="module" src="/menu.js"></script></head><body><main>${conteudo}</main>
<footer>Loja da Maria · site de exemplo, com dados fictícios</footer></body></html>`;
}

function esc(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const porta = Number(process.env.PORT || new URL(atos.voltaPara).port || 3000);
app.listen(porta, () => console.log("Loja da Maria na porta " + porta));
