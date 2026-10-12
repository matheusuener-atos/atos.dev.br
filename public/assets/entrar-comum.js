/* O que as telas de entrar da Atos tem em comum: o /entrar (entrar.js: a Conta Atos, o cadastro e o "Entrar com Atos")
   e o /workspace/entrar (workspace-entrar.js: so o endereco @atos.dev.br). As duas falam com as mesmas rotas
   (worker/contas.js: /api/entrar, /api/esqueci, /api/redefinir); quem confere senha, limites e codigos e o Worker.
   Aqui ficam o pedido ao servidor, os pedacos de HTML do formulario, a conferencia das duas senhas e o caminho de
   volta (so desta Atos). Sem estilo inline (a CSP da conta). */
(function () {
  "use strict";
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  /* GET sem corpo; POST com JSON. A resposta sempre volta como objeto, com _status (0: sem conexao). */
  function api(caminho, corpo) {
    var op = corpo === undefined ? { credentials: "same-origin" } :
      { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) };
    return fetch(caminho, op).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; });
    }, function () { return { erro: "sem conexão com o servidor", _status: 0 }; });
  }

  var COD = 'inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required';
  var DICA_SENHA = "Pelo menos 10 caracteres, com letras e números.";

  function link(acao, texto, forte) { return '<button type="button" class="link' + (forte ? " forte" : "") + '" data-acao="' + acao + '">' + texto + "</button>"; }
  function botao(texto, ocupado) { return '<button type="submit" class="btn primario largo"' + (ocupado ? " disabled" : "") + ">" + texto + "</button>"; }
  function erro(texto) { return '<p class="erro" role="alert">' + esc(texto) + "</p>"; }
  /* a frase curta embaixo do titulo vai em prata; a explicacao longa, em cinza */
  function cabeca(titulo, sub, longo) { return '<div class="cabeca"><h1>' + titulo + "</h1>" + (sub ? (longo ? '<p class="longo">' : "<p>") + sub + "</p>" : "") + "</div>"; }
  function pe(conteudo) { return '<div class="pe">' + conteudo + "</div>"; }

  /* Um campo: div e label for (e nao o label em volta), porque o "Esqueci a senha" ao lado do rotulo e um botao.
     o: {esqueci: o texto do link ao lado do rotulo, dica: o texto embaixo, classe}. */
  function campo(nome, rotulo, tipo, extra, o) {
    o = o || {};
    var topo = '<label class="rotulo" for="c-' + nome + '">' + rotulo + "</label>";
    if (o.esqueci) topo = '<span class="topo-campo">' + topo + link("esqueci", o.esqueci) + "</span>";
    var dica = o.dica || (nome === "senha2" ? DICA_SENHA : "");
    return '<div class="campo' + (o.classe ? " " + o.classe : "") + '">' + topo + '<input id="c-' + nome + '" name="' + nome + '" type="' + tipo + '" ' + (extra || "") + ">" +
      (dica ? '<span class="dica">' + dica + "</span>" : "") + "</div>";
  }

  /* As duas senhas do formulario (criar, redefinir): "" quando batem. */
  function senhasIguais(f) { return String(f.get("senha") || "") === String(f.get("senha2") || "") ? "" : "as duas senhas não são iguais"; }

  /* O ?volta= so quando e um caminho desta Atos ("/pavlvs/assinar/?preco=..."), nunca outro site: "//x", "/\x" e
     "https:" nao passam. `aceita` (uma RegExp) restringe mais (o Workspace: so /workspace/...). */
  function volta(params, aceita) {
    var v = params.get("volta") || "";
    if (!/^\/(?![\/\\])/.test(v)) return "";
    return !aceita || aceita.test(v) ? v : "";
  }

  /* O foco no primeiro campo vazio (ou na senha, ou no codigo). */
  function focar(tela, ocupado) {
    var foco = tela.querySelector("input:not([value]), input[value=''], input[name=senha], input[name=codigo]") || tela.querySelector("input");
    if (foco && !ocupado) foco.focus();
  }

  /* "pedro@gmail.com" -> "p***@gmail.com" (o mesmo de worker/contas.js, mascarar). */
  function mascarar(email) {
    var e = String(email || "").trim().toLowerCase();
    var at = e.lastIndexOf("@");
    return at < 1 ? "" : e.charAt(0) + "***" + e.slice(at);
  }

  /* ------------------------------------------------------------ a segunda etapa ("Confirme que e voce")
     Depois da senha certa (ou do Google, ou do "Esqueci a senha"), a conta com a verificacao em duas etapas recebe
     {etapa: {otp, recuperacao, chave}} e um cookie da etapa (HttpOnly; 5 minutos). A tela pede o codigo do aplicativo,
     um codigo de recuperacao ou a chave de acesso (worker/seguranca.js, /api/segunda-etapa). E: {metodos, modo
     ("codigo" | "recuperacao"), erro, ocupado}. As acoes da tela: data-acao etapa-chave, etapa-recuperacao,
     etapa-codigo, etapa-sair; o formulario: data-form="etapa". */
  var temChave = function () { return Boolean(window.AtosChave && window.AtosChave.disponivel()); };
  function etapaHtml(E) {
    var m = E.metodos || {};
    var porCodigo = E.modo !== "recuperacao" && m.otp;
    var h = cabeca("Confirme que é você", "A sua conta tem a verificação em duas etapas. " +
      (porCodigo ? "Digite o código de 6 dígitos do aplicativo autenticador." : E.modo === "recuperacao" ? "Digite um dos códigos de recuperação que você guardou." : "Use a sua chave de acesso."), true);
    if (porCodigo || E.modo === "recuperacao") {
      h += '<form class="form" data-form="etapa">' + erro(E.erro) +
        (E.modo === "recuperacao"
          ? campo("recuperacao", "Código de recuperação", "text", 'autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="xxxx-xxxx-xxxx" required', { dica: "Cada código vale uma vez." })
          : campo("codigo", "Código do aplicativo", "text", COD, { classe: "codigo" })) +
        botao("Confirmar", E.ocupado) + "</form>";
    } else if (E.erro) h += erro(E.erro);
    if (m.chave) {
      h += (porCodigo || E.modo === "recuperacao" ? '<div class="ou">ou</div>' : "") +
        (temChave() ? '<button type="button" class="btn largo' + (porCodigo || E.modo === "recuperacao" ? "" : " primario") + '" data-acao="etapa-chave"' + (E.ocupado ? " disabled" : "") + ">Usar a chave de acesso</button>"
          : '<p class="nota">Este navegador não oferece chaves de acesso.</p>');
    }
    var outros = [];
    if (E.modo === "recuperacao" && m.otp) outros.push(link("etapa-codigo", "Usar o código do aplicativo"));
    if (E.modo !== "recuperacao" && m.recuperacao) outros.push(link("etapa-recuperacao", "Usar um código de recuperação"));
    if (outros.length) h += pe(outros.join(" · "));
    h += '<p class="nota">Perdeu o aplicativo, os códigos de recuperação e a chave de acesso? Por segurança, a verificação não se desliga por aqui: ' +
      "escreva do e-mail da conta para contato@atos.dev.br, que a Atos confere quem é você antes de desligar.</p>" + pe(link("etapa-sair", "Voltar"));
    return h;
  }
  /* O modo inicial: o codigo do aplicativo, se houver; senao, a chave. */
  function etapaNova(metodos) { return { metodos: metodos || {}, modo: "codigo", erro: "", ocupado: false }; }
  /* Os metodos da etapa em andamento (a volta do Google: ?etapa=1). Resolve com {metodos} ou {erro}. */
  function etapaCarregar() { return api("/api/segunda-etapa/opcoes", {}); }
  /* Manda o codigo (ou o de recuperacao) do formulario. */
  function etapaEnviar(E, form) {
    var f = new FormData(form);
    var corpo = E.modo === "recuperacao" ? { recuperacao: String(f.get("recuperacao") || "").trim() } : { codigo: String(f.get("codigo") || "").replace(/\s/g, "") };
    return api("/api/segunda-etapa", corpo);
  }
  /* A chave de acesso: as opcoes (um desafio novo), o navegador e a resposta. */
  function etapaChave() {
    return api("/api/segunda-etapa/opcoes", {}).then(function (o) {
      if (!o.publicKey) return o.erro ? o : { erro: "a chave de acesso não está disponível agora" };
      return window.AtosChave.obter(o.publicKey).then(function (cred) { return api("/api/segunda-etapa", { credencial: cred }); },
        function (e) { return { erro: window.AtosChave.motivo(e) }; });
    });
  }
  /* "Entrar com chave de acesso" (sem senha): as opcoes, o navegador e a resposta. */
  function entrarComChave() {
    return api("/api/chave/opcoes", {}).then(function (o) {
      if (!o.publicKey) return o.erro ? o : { erro: "a chave de acesso não está disponível agora" };
      return window.AtosChave.obter(o.publicKey).then(function (cred) { return api("/api/chave/entrar", { credencial: cred }); },
        function (e) { return { erro: window.AtosChave.motivo(e) }; });
    });
  }

  window.AtosEntrar = { esc: esc, api: api, COD: COD, link: link, botao: botao, erro: erro, cabeca: cabeca, pe: pe, campo: campo,
    senhasIguais: senhasIguais, volta: volta, focar: focar, mascarar: mascarar,
    temChave: temChave, etapaHtml: etapaHtml, etapaNova: etapaNova, etapaCarregar: etapaCarregar, etapaEnviar: etapaEnviar, etapaChave: etapaChave,
    entrarComChave: entrarComChave };
})();
