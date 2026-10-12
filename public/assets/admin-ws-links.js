/* O painel da Atos, grupo Atos Workspace > Paginas de links (worker/links.js): as paginas atos.dev.br/@<nome> e as
   denuncias. Area "atos"; ver: todos os papeis; tirar do ar, ligar de novo e resolver denuncia: dono e suporte (o
   servidor confere de novo).

     GET  /api/admin/workspace/links                         as paginas (com o dono e as denuncias abertas) e as denuncias
     GET  /api/admin/workspace/links/:nome                   a pagina: os links com o dominio de cada um
     POST /api/admin/workspace/links/:nome/desligar          {motivo} (o dono ve)  | /ligar
     POST /api/admin/workspace/links/denuncias/:id/resolver  {nota}

   A denuncia nao diz quem denunciou (a Atos nao guarda). */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var K = { raiz: null, dados: null, erro: "", carregando: false, acao: null, aberta: "", detalhe: null, filtro: "abertas" };
  function podeMudar() { return A.quem && (A.quem.papel === "dono" || A.quem.papel === "suporte"); }
  function pintar() { if (K.raiz && document.body.contains(K.raiz)) K.raiz.innerHTML = tela(); }
  function carregar() {
    K.carregando = true;
    A.pedir("GET", "/api/admin/workspace/links").then(function (d) { K.dados = d; K.erro = ""; }, function (e) { if (e.status !== 401) K.erro = e.message; })
      .then(function () { K.carregando = false; pintar(); });
  }
  function abrir(nome) {
    K.aberta = K.aberta === nome ? "" : nome; K.detalhe = null; pintar();
    if (!K.aberta) return;
    A.pedir("GET", "/api/admin/workspace/links/" + encodeURIComponent(nome)).then(function (d) { if (K.aberta === nome) { K.detalhe = d; pintar(); } },
      function (e) { if (K.aberta === nome && e.status !== 401) { K.detalhe = { erro: e.message }; pintar(); } });
  }

  function detalhe() {
    var D = K.detalhe;
    if (!D) return '<p class="vazio">Carregando…</p>';
    if (D.erro) return '<p class="erro">' + esc(D.erro) + "</p>";
    if (!D.pagina) return '<p class="vazio">A página não está mais na conta.</p>';
    var p = D.pagina;
    return '<div class="nf-det"><dl class="nf-info"><dt>Exibição</dt><dd>' + esc(p.exibicao) + (p.frase ? " · " + esc(p.frase) : "") + (p.foto ? " · com foto" : "") + "</dd>" +
      "<dt>Links</dt><dd>" + (p.links.length ? p.links.map(function (x) {
        return esc(x.titulo) + " → <strong>" + esc(x.dominio) + "</strong> <small>" + esc(x.url) + "</small>" + (x.ativo === false ? " (desligado)" : "");
      }).join("<br>") : "nenhum") + "</dd>" +
      "<dt>Botões</dt><dd>" + (p.email_atos ? "e-mail Atos" : "") + (p.email_atos && p.formulario ? " · " : "") + (p.formulario ? "formulário " + esc(p.formulario) : "") + (!p.email_atos && !p.formulario ? "nenhum" : "") + "</dd></dl></div>";
  }

  function tela() {
    var h = "<h1>Páginas de links</h1>", D = K.dados;
    if (!D) return h + '<div class="card"><p class="vazio">' + (K.erro ? esc(K.erro) + ' <button type="button" class="link" data-lk-adm="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    h += '<p class="nota">As páginas atos.dev.br/@&lt;nome&gt; que as pessoas criam no Workspace. A Atos gera a página (sem código da pessoa), com o domínio de destino embaixo de cada link e o rodapé “A Atos não verificou estes links”. ' +
      "Tirar do ar some com a página, o redirecionamento e o contato na hora (em até 1 minuto nos outros datacentros); o dono vê o motivo e não muda a página até a Atos ligar de novo.</p>";
    var den = (D.denuncias || []).filter(function (x) { return K.filtro === "todas" || x.estado === "aberta"; });
    h += '<h2 class="titulo-secao pv-h2"><span>Denúncias (' + den.length + ")</span>" +
      '<span class="pv-par"><button type="button" class="btn mini" data-lk-adm="filtro" aria-pressed="' + (K.filtro === "abertas") + '">' + (K.filtro === "abertas" ? "Ver todas" : "Só as abertas") + "</button></span></h2>";
    h += '<div class="card">' + (den.length ? den.map(function (x) {
      return '<div class="item oa-item"><span class="nome"><strong>@' + esc(x.nome) + " · " + esc((D.motivos || {})[x.motivo] || x.motivo) + " " +
        (x.estado === "aberta" ? '<span class="pv-sit perigo">aberta</span>' : '<span class="pv-sit ok">resolvida</span>') + "</strong>" +
        "<small>" + esc(U.quando(x.quando)) + (x.texto ? " · “" + esc(x.texto) + "”" : "") + "</small>" +
        (x.resolvida ? "<small>Resolvida em " + esc(U.quando(x.resolvida.quando)) + " por " + esc(x.resolvida.por) + (x.resolvida.nota ? ": " + esc(x.resolvida.nota) : "") + "</small>" : "") + "</span>" +
        '<span class="pv-par"><a class="btn mini" href="/@' + esc(x.nome) + '" target="_blank" rel="noopener noreferrer">Abrir a página</a>' +
        (podeMudar() && x.estado === "aberta" ? '<button type="button" class="btn mini" data-lk-adm="resolver" data-id="' + esc(x.id) + '">Resolver</button>' : "") + "</span></div>";
    }).join("") : '<p class="vazio">' + (K.filtro === "abertas" ? "Nenhuma denúncia aberta." : "Nenhuma denúncia.") + "</p>") + "</div>";
    var l = D.paginas || [];
    h += '<h2 class="titulo-secao pv-h2"><span>Páginas (' + l.length + ")</span></h2>";
    if (!l.length) return h + '<div class="card"><p class="vazio">Ninguém criou uma página de links ainda.</p></div>';
    return h + '<div class="card">' + l.map(function (x) {
      var botoes = '<button type="button" class="btn mini" data-lk-adm="ver" data-nome="' + esc(x.nome) + '" aria-expanded="' + (K.aberta === x.nome) + '">Links</button>';
      if (x.sub && A.atalhos && A.atalhos.contaWs) botoes += '<button type="button" class="btn mini" data-lk-adm="conta" data-sub="' + esc(x.sub) + '">Conta</button>';
      if (podeMudar()) botoes += x.bloqueado ? '<button type="button" class="btn mini" data-lk-adm="ligar" data-nome="' + esc(x.nome) + '">Ligar de novo</button>'
        : '<button type="button" class="btn mini perigo" data-lk-adm="desligar" data-nome="' + esc(x.nome) + '">Tirar do ar</button>';
      return '<div class="oa-cliente"><div class="item oa-item"><span class="logo inicial" aria-hidden="true">@</span><span class="nome"><strong><a href="/@' + esc(x.nome) + '" target="_blank" rel="noopener noreferrer">@' + esc(x.nome) + "</a>" +
        (x.bloqueado ? ' <span class="pv-sit perigo">fora do ar pela Atos</span>' : "") + (x.denuncias_abertas ? ' <span class="pv-sit perigo">' + x.denuncias_abertas + (x.denuncias_abertas === 1 ? " denúncia aberta" : " denúncias abertas") + "</span>" : "") + "</strong>" +
        "<small>de " + esc(x.conta || x.sub) + " · criada em " + esc(U.quando(x.criado)) + "</small>" +
        (x.bloqueado ? "<small>Fora do ar desde " + esc(U.quando(x.bloqueado.quando)) + " por " + esc(x.bloqueado.por || "") + ": " + esc(x.bloqueado.motivo || "") + "</small>" : "") +
        '</span><span class="pv-par">' + botoes + "</span></div>" + (K.aberta === x.nome ? detalhe() : "") + "</div>";
    }).join("") + "</div>";
  }

  function modal() {
    var T = K.acao;
    var resolver = T.tipo === "resolver";
    return '<h2 id="modal-titulo">' + (resolver ? "Resolver a denúncia" : "Tirar do ar a página @" + esc(T.id)) + "</h2>" +
      "<p>" + (resolver ? "A denúncia sai da lista de abertas, com a sua nota (só a equipe vê)." : "A página, o redirecionamento e o contato saem do ar na hora. O dono vê o motivo e não muda a página até a Atos ligar de novo.") + "</p>" +
      '<label class="campo"><span class="rotulo">' + (resolver ? "Nota (opcional)" : "Motivo (o dono vê)") + '</span><input data-lk-adm-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo || "") + '"></label>' +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p' + (resolver ? " primario" : " perigo") + '" data-lk-adm="ok"' + (T.enviando ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : resolver ? "Resolver" : "Tirar do ar") + "</button></div>";
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-lk-adm]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-lk-adm"), nome = b.getAttribute("data-nome");
    if (a === "recarregar") { carregar(); pintar(); return; }
    if (a === "filtro") { K.filtro = K.filtro === "abertas" ? "todas" : "abertas"; pintar(); return; }
    if (a === "ver") { abrir(nome); return; }
    if (a === "conta") { if (A.atalhos.contaWs) A.atalhos.contaWs(b.getAttribute("data-sub")); return; }
    if (a === "desligar" || a === "resolver") {
      K.acao = { tipo: a, id: a === "resolver" ? b.getAttribute("data-id") : nome, motivo: "", erro: "", enviando: false };
      A.modal.abrir({ html: modal, aoFechar: function () { K.acao = null; } });
      return;
    }
    if (a === "ligar") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/workspace/links/" + encodeURIComponent(nome) + "/ligar", {}).then(function () { A.toast("Ligada de novo"); carregar(); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "ok") {
      var T = K.acao; if (!T || T.enviando) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      var caminho = T.tipo === "resolver" ? "/api/admin/workspace/links/denuncias/" + encodeURIComponent(T.id) + "/resolver" : "/api/admin/workspace/links/" + encodeURIComponent(T.id) + "/desligar";
      A.pedir("POST", caminho, T.tipo === "resolver" ? { nota: T.motivo } : { motivo: T.motivo }).then(function () {
        if (K.acao !== T) return;
        A.modal.fechar(); A.toast(T.tipo === "resolver" ? "Resolvida" : "Tirada do ar"); carregar();
      }, function (er) { if (K.acao !== T) return; T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar(); });
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-lk-adm-in") === "motivo" && K.acao) K.acao.motivo = e.target.value;
  });
  A.secoes.push({
    id: "ws-links", nome: "Páginas de links", grupo: "Atos Workspace", area: "atos", ordem: 7,
    desenhar: function (raiz) { K.raiz = raiz; pintar(); if (!K.carregando) carregar(); },
  });
})();
