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

  window.AtosEntrar = { esc: esc, api: api, COD: COD, link: link, botao: botao, erro: erro, cabeca: cabeca, pe: pe, campo: campo,
    senhasIguais: senhasIguais, volta: volta, focar: focar, mascarar: mascarar };
})();
