/* "Monte o seu": o configurador do menu de conta do Login Atos, para quem integra a Atos no proprio site. Escolhe com
   menu ou sem (um botao so), a marca, o tema, a confirmacao do Sair e os atalhos do dono; mostra ao vivo numa topbar de
   exemplo (antes de entrar, depois, e como o dono do aplicativo) e gera o codigo com o client_id daquele acesso.

   Usado na pagina /marca/ e no cartao "Como integrar" (assets/integrar.js: Workspace > Integracoes e o painel). Cada
   <div data-mos data-client-id="..."> da pagina vira um configurador (os cartoes que aparecem depois tambem: um
   MutationObserver). O menu da pre-visualizacao e o do pacote (menuContaAtos e ligarMenuContaAtos, da copia servida em
   /pacotes/entrar/0.5.0/). Sem estilo inline nem script na pagina: a folha e assets/monte-o-seu.css. */
import { menuContaAtos, ligarMenuContaAtos } from "/pacotes/entrar/0.5.0/entrar.js";

let seq = 0;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function grupo(nome, legenda, opcoes, marcado) {
  return '<fieldset class="mos-grupo"><legend>' + esc(legenda) + "</legend><div class=\"mos-opcoes\">" +
    opcoes.map(([valor, rotulo]) => '<label class="mos-opcao"><input type="radio" name="' + nome + '" value="' + valor + '"' + (valor === marcado ? " checked" : "") + "><span>" + esc(rotulo) + "</span></label>").join("") +
    "</div></fieldset>";
}
function caixa(nome, rotulo, dica) {
  return '<label class="mos-marcar"><input type="checkbox" name="' + nome + '"><span>' + esc(rotulo) + (dica ? '<small>' + esc(dica) + "</small>" : "") + "</span></label>";
}

function codigoDe(o, clientId) {
  const linhas = [
    "<!-- no <head> do seu site: a folha do menu (ou a do pacote, @atos.dev.br/entrar/menu.css) -->",
    '<link rel="stylesheet" href="https://atos.dev.br/marca/menu.css">',
    '<span id="conta"></span> <!-- no topo, onde o menu fica -->',
    "",
    "// no seu script (o pacote @atos.dev.br/entrar 0.5.0)",
    'import { menuContaAtos, ligarMenuContaAtos } from "@atos.dev.br/entrar";',
    "",
    "// client_id deste acesso: " + clientId + " (o login em si: veja \"Como integrar\")",
    "// pessoa: quem entrou, da sessão do SEU site (o que concluir() ou retorno() devolveu), ou null",
    "const opcoes = {",
    "  menu: " + (o.menu ? "true" : "false") + ",",
    '  marca: "' + o.marca + '",',
    '  tema: "' + o.tema + '",',
    '  email: pessoa ? pessoa.email : "",   // o e-mail vem da sessão; vazio = antes de entrar',
    '  entrar: "/entrar",                   // o caminho que começa o login',
    '  sair: "/sair",                       // um POST que apaga a sessão do SEU site (não sai da Atos)',
  ];
  if (o.confirmarSair) linhas.push("  confirmarSair: true,                 // a caixa \"Sair da conta?\" antes de sair");
  if (o.menu && o.atalhosDoDono) {
    linhas.push("  dono: pessoa ? pessoa.dono : false,  // o claim atos_dono: true só para o dono deste aplicativo");
    linhas.push("  atalhosDoDono: true,                 // ao dono: Minha conta e Workspace da Atos no menu");
  }
  linhas.push("};", 'const lugar = document.querySelector("#conta");', "lugar.innerHTML = menuContaAtos(opcoes);", "ligarMenuContaAtos(lugar, opcoes);");
  return linhas.join("\n");
}

function montar(raiz) {
  raiz.setAttribute("data-mos-pronto", "");
  const n = ++seq;
  const clientId = raiz.getAttribute("data-client-id") || "SEU_CLIENT_ID";
  const p = "mos" + n + "-";
  raiz.classList.add("mos");
  raiz.innerHTML =
    '<div class="mos-controles">' +
    grupo(p + "menu", "Depois de entrar", [["sim", "Com menu"], ["nao", "Sem menu (um botão só)"]], "sim") +
    grupo(p + "marca", "Marca", [["a", "“A”"], ["coroa", "Coroa"], ["nenhuma", "Sem marca"]], "a") +
    grupo(p + "tema", "Tema (o fundo do seu topo)", [["claro", "Claro"], ["escuro", "Escuro"]], "claro") +
    '<div class="mos-grupo mos-caixas">' +
    caixa(p + "confirmar", "Confirmar antes de sair", "Uma caixa “Sair da conta?”; Esc, Cancelar ou o clique fora fecham sem sair.") +
    caixa(p + "dono", "Mostrar Minha conta e Workspace ao dono do aplicativo", "Só para quem a Atos diz que é o dono (atos_dono); os outros veem só o e-mail e Sair.") +
    "</div>" +
    grupo(p + "ver", "Pré-visualizar", [["antes", "Antes de entrar"], ["depois", "Depois de entrar"], ["dono", "Depois, como o dono"]], "depois") +
    '<label class="campo mos-campo"><span class="rotulo">E-mail de exemplo</span><input type="email" name="' + p + 'email" value="maria@exemplo.com" autocomplete="off" spellcheck="false"></label>' +
    "</div>" +
    '<div class="mos-saida">' +
    '<div class="mos-palco" data-tema="claro"><div class="mos-topo"><span class="mos-logo">Seu site</span><span class="mos-lugar"></span></div>' +
    '<p class="mos-nota" aria-live="polite"></p></div>' +
    '<div class="il-bloco mos-bloco"><div class="il-cab"><span>O código</span><button type="button" class="btn mini" data-mos-copiar>Copiar</button></div>' +
    '<pre class="il-pre mos-pre" tabindex="0" aria-label="O código do menu de conta"><code></code></pre></div>' +
    '<p class="dica mos-dica">O Sair sai do <strong>seu</strong> site (o caminho <code>/sair</code> recebe um POST e apaga a sessão do seu sistema), não da Atos. No seu site, Minha conta, Workspace e Painel Administrativo não aparecem para as pessoas: só o dono do aplicativo pode ver Minha conta e Workspace, se você marcar a opção acima. Se preferir, ponha esses dois links no seu próprio menu, com o mesmo <code>pessoa.dono</code>.</p>' +
    "</div>";

  const lugar = raiz.querySelector(".mos-lugar");
  const palco = raiz.querySelector(".mos-palco");
  const nota = raiz.querySelector(".mos-nota");
  const codigo = raiz.querySelector(".mos-pre code");
  const email = raiz.querySelector('input[name="' + p + 'email"]');
  const val = (nome) => (raiz.querySelector('input[name="' + p + nome + '"]:checked') || {}).value;
  const marcado = (nome) => raiz.querySelector('input[name="' + p + nome + '"]').checked;
  let ligado = null;

  function estado() {
    return {
      menu: val("menu") === "sim", marca: val("marca"), tema: val("tema"), ver: val("ver"),
      confirmarSair: marcado("confirmar"), atalhosDoDono: marcado("dono"), email: email.value.trim() || "maria@exemplo.com",
    };
  }
  function desenhar(aviso) {
    const e = estado();
    raiz.querySelector('input[name="' + p + 'dono"]').disabled = !e.menu;
    raiz.querySelector('input[name="' + p + 'dono"]').closest(".mos-marcar").classList.toggle("mos-desligado", !e.menu);
    palco.setAttribute("data-tema", e.tema);
    const opcoes = {
      menu: e.menu, marca: e.marca, tema: e.tema, entrar: "#entrar", confirmarSair: e.confirmarSair,
      email: e.ver === "antes" ? "" : e.email, dono: e.ver === "dono", atalhosDoDono: e.atalhosDoDono,
      sair: () => {
        raiz.querySelector('input[name="' + p + 'ver"][value="antes"]').checked = true;
        desenhar("Saiu (no exemplo). No seu site, o formulário faz o POST para /sair.");
      },
      id: p + "menu",
    };
    if (ligado) ligado.desligar();
    lugar.innerHTML = menuContaAtos(opcoes);
    ligado = ligarMenuContaAtos(lugar, opcoes);
    nota.textContent = aviso || "";
    codigo.textContent = codigoDe(e, clientId);
  }
  raiz.addEventListener("change", () => desenhar());
  email.addEventListener("input", () => desenhar());
  // Na pre-visualizacao, os links nao saem da pagina: o Entrar mostra o "depois"; os outros dizem para onde iriam.
  lugar.addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest("a");
    if (!a) return;
    ev.preventDefault();
    if (a.classList.contains("atos-menu__entrar")) {
      raiz.querySelector('input[name="' + p + 'ver"][value="depois"]').checked = true;
      desenhar("Entrou (no exemplo). No seu site, o Entrar leva ao login da Atos.");
    } else {
      nota.textContent = "No seu site, este link abre " + a.getAttribute("href") + ".";
    }
  });
  raiz.querySelector("[data-mos-copiar]").addEventListener("click", (ev) => {
    const b = ev.currentTarget;
    const t = codigo.textContent;
    const avisar = (x) => { b.textContent = x; setTimeout(() => { b.textContent = "Copiar"; }, 1800); };
    const planoB = () => {
      const s = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(codigo);
      s.removeAllRanges();
      s.addRange(r);
      avisar("Selecione e copie");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => avisar("Copiado"), planoB);
    else planoB();
  });
  desenhar();
}

function procurar(dentro) {
  for (const el of (dentro || document).querySelectorAll("[data-mos]:not([data-mos-pronto])")) montar(el);
}
procurar();
new MutationObserver(() => procurar()).observe(document.body, { childList: true, subtree: true });
