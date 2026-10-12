/* A pagina /marca/: os exemplos do menu de conta (cada [data-menu-exemplo]), desenhados pelo proprio pacote
   (menuContaAtos, da copia servida em /pacotes/entrar/0.5.0/) e mostrados com o menu aberto, parados (inert: a pagina
   ensina, nao entra nem sai). O menu de verdade, que funciona, esta no topo e no "Monte o seu" (assets/monte-o-seu.js).

   data-papel: visitante | usuario | workspace | equipe (os itens dos sites da Atos)
   data-marca: a | coroa | nenhuma;  data-modo: menu | links | botao;  data-tema: escuro | claro;  data-dono="sim" */
import { menuContaAtos } from "/pacotes/entrar/0.5.0/entrar.js";

const CONTA = { rotulo: "Minha conta", href: "/conta/" };
const WORKSPACE = { rotulo: "Workspace", href: "/workspace/" };
const PAINEL = { rotulo: "Painel Administrativo", href: "/admin/" };
const ITENS = { visitante: [], usuario: [CONTA], workspace: [CONTA, WORKSPACE], equipe: [CONTA, WORKSPACE, PAINEL] };

let n = 0;
for (const el of document.querySelectorAll("[data-menu-exemplo]")) {
  const d = el.dataset;
  const dono = d.dono === "sim";
  const opcoes = {
    menu: d.modo !== "botao", links: d.modo === "links", marca: d.marca || "a", tema: d.tema || "escuro",
    email: d.papel === "visitante" ? "" : "maria@exemplo.com",
    itens: dono ? [] : ITENS[d.papel || "usuario"], dono, atalhosDoDono: dono,
    entrar: "/entrar/", sair: "/", id: "exemplo-menu-" + ++n,
  };
  el.innerHTML = menuContaAtos(opcoes);
  const lista = el.querySelector(".atos-menu__lista");
  if (lista) {
    lista.hidden = false;
    el.querySelector(".atos-menu__botao").setAttribute("aria-expanded", "true");
  }
  el.inert = true;
  el.setAttribute("aria-hidden", "true");
}
