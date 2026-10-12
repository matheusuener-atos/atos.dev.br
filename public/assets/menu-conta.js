/* O menu de conta no topo de todas as paginas da Atos (menos as telas de entrar): o mesmo componente do pacote
   @atos.dev.br/entrar (menuContaAtos e ligarMenuContaAtos, da copia servida em /pacotes/entrar/0.5.0/) e a folha
   /marca/menu.css, no tema escuro, com a marca "a".

   GET /api/eu diz quem esta aqui: sem sessao, o botao "Entrar" (/entrar/); com sessao, o e-mail, e o clique abre o menu
   com Minha conta, Workspace (com o Atos Workspace ativo), Painel Administrativo (a equipe do painel) e Sair. Nos sites da
   Atos o Sair sai direto (sem a caixa de confirmacao), em vermelho: POST /api/sair e volta a inicio (das paginas da
   conta, do Workspace e do painel) ou fica na pagina publica, ja sem a sessao.

   O lugar e o link [data-conta] do topo (o "Entrar" ou o "Minha conta" que a pagina traz sem script). Modulo: carregado
   com <script type="module" src="/assets/menu-conta.js">. Sem estilo inline (a CSP das paginas e style-src 'self'). */
import { menuContaAtos, ligarMenuContaAtos } from "/pacotes/entrar/0.5.0/entrar.js";

const lugar = document.querySelector("[data-conta]");
const PRIVADA = /^\/(conta|workspace|admin)(\/|$)/;

async function quem() {
  try {
    const r = await fetch("/api/eu", { credentials: "same-origin", headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function sair() {
  try {
    await fetch("/api/sair", { method: "POST", credentials: "same-origin" });
  } catch {
    /* sem resposta: a pagina recarrega e o /api/eu diz se a sessao continua */
  }
  if (PRIVADA.test(location.pathname)) location.assign("/");
  else location.reload();
}

if (lugar) {
  const d = await quem();
  const email = d && d.conta && d.conta.email ? d.conta.email : "";
  const itens = [{ rotulo: "Minha conta", href: "/conta/" }];
  if (d && d.workspace === true) itens.push({ rotulo: "Workspace", href: "/workspace/" });
  if (d && d.painel === true) itens.push({ rotulo: "Painel Administrativo", href: "/admin/" });
  const opcoes = { menu: true, marca: "a", tema: "escuro", email, entrar: "/entrar/", itens, sair, confirmarSair: false, id: "menu-conta" };
  const caixa = document.createElement("span");
  caixa.className = "topo-conta";
  caixa.innerHTML = menuContaAtos(opcoes);
  lugar.replaceWith(caixa);
  ligarMenuContaAtos(caixa, opcoes);
  document.documentElement.setAttribute("data-menu-conta", email ? "dentro" : "fora");
}
