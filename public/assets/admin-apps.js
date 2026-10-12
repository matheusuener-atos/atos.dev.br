/* O painel da Atos, grupo Atos Workspace, secao Aplicativos de terceiros: os sistemas que as pessoas cadastram em Atos
   Workspace > Integracoes (worker/integracoes.js). Veio do Login Atos (admin-oauth.js), que ficou so com os da Atos.
   Area "atos"; ver: todos os papeis; desligar e ligar de novo por abuso: dono e suporte; apagar: so o dono (o servidor
   confere de novo; worker/admin-workspace.js).

     GET  /api/admin/workspace/apps                         os aplicativos, com o dono (e-mail e sub), o Workspace e o
                                                            e-mail Atos dele
     POST /api/admin/workspace/apps/:id/(desligar|ligar|apagar)   {motivo, confirmar?}: na hora, com registro */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var S = { raiz: null, dados: null, erro: "", carregando: false, aberto: "", acao: null };

  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }
  function carregar() {
    S.carregando = true;
    A.pedir("GET", "/api/admin/workspace/apps").then(function (d) { S.dados = d; S.erro = ""; }, function (e) { if (e.status !== 401) S.erro = e.message; })
      .then(function () { S.carregando = false; pintar(); });
  }
  function papel() { return A.quem ? A.quem.papel : ""; }
  function podeDesligar() { return papel() === "dono" || papel() === "suporte"; }
  function podeApagar() { return papel() === "dono"; }
  function app(id) { return ((S.dados || {}).apps || []).filter(function (a) { return a.id === id; })[0] || null; }

  /* Os atalhos das outras secoes (a conta do Workspace, a busca): abrir este aplicativo aqui. */
  A.atalhos = A.atalhos || {};
  A.atalhos.app = function (id) { S.aberto = id; A.navegar("ws-apps"); };

  function icone(a) {
    if (a.icone) return '<img class="logo" src="' + esc(a.icone) + '" alt="" width="32" height="32">';
    return '<span class="logo inicial" aria-hidden="true">' + esc(String(a.nome || a.id || "?").trim().charAt(0).toUpperCase()) + "</span>";
  }
  function voltasDe(c) { return c.voltas || []; }
  function quemEntra(a) {
    if (a.acesso === "todos") return "qualquer Conta Atos";
    var n = (a.liberados || []).length;
    return "só liberados (" + n + (n === 1 ? " pessoa" : " pessoas") + " e o dono)";
  }
  /* O Atos Workspace do dono: ativo, desativado ou nao conferido. Sem ele, o aplicativo continua funcionando para quem
     entra, mas o dono nao o muda ate ativar de novo. */
  function workspaceDoDono(a) {
    var w = a.dono_workspace;
    if (!w) return "não deu para conferir";
    if (w.ativo) return "ativo" + (w.ativado ? " desde " + U.quando(w.ativado) : "");
    return w.desativado ? "desativado em " + U.quando(w.desativado) + " (o dono não muda o aplicativo até ativar de novo)" : "nunca ativado (o dono não muda o aplicativo até ativar)";
  }
  /* O e-mail Atos do dono: e o que quem entra no aplicativo ve como "Cadastrado por" (sem ele, "uma Conta Atos"). */
  function aliasDoDono(a) {
    if (!a.dono_alias_lido) return "não deu para conferir";
    var x = a.dono_alias;
    if (!x) return "nenhum (quem entra vê “Cadastrado por uma Conta Atos”)";
    return x.endereco + (x.suspenso ? " · suspenso (quem entra vê “uma Conta Atos”)" : x.confirmado ? "" : " · destino não confirmado");
  }

  function tela() {
    var h = "<h1>Aplicativos de terceiros</h1>" +
      '<p class="descricao">Os sistemas que as pessoas cadastram no Atos Workspace › Integrações, com o dono de cada um e se ele tem o Workspace ativo. Os aplicativos da própria Atos ficam em Login Atos.</p>';
    if (!S.dados) return h + '<div class="card"><p class="vazio">' + (S.erro ? "Não consegui ler os aplicativos agora: " + esc(S.erro) + ' <button type="button" class="link" data-ap="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    var l = S.dados.apps || [];
    if (!l.length) return h + '<div class="card"><p class="vazio">Ninguém cadastrou um aplicativo ainda.</p></div>';
    var donos = {}, ativos = 0;
    l.forEach(function (a) { if (!(a.dono in donos)) { donos[a.dono] = 1; if (a.dono_workspace && a.dono_workspace.ativo) ativos++; } });
    var nDonos = Object.keys(donos).length;
    h += '<p class="nota">' + l.length + (l.length === 1 ? " aplicativo" : " aplicativos") + " de " + nDonos + (nDonos === 1 ? " dono" : " donos") + ", " + ativos + " com o Atos Workspace ativo.</p>";
    h += '<div class="card">' + l.map(function (a) {
      var aberto = S.aberto === a.id;
      var sit = a.bloqueado ? '<span class="pv-sit perigo">desligado pela Atos</span>' : '<span class="pv-sit ok">no ar</span>';
      var ws = a.dono_workspace && a.dono_workspace.ativo ? "" : ' <span class="pv-sit">dono sem Workspace</span>';
      var det = "";
      if (aberto) {
        det = '<div class="nf-det"><dl class="nf-info">' +
          "<dt>Dono</dt><dd>" + esc(a.dono) + (a.dono_sub ? " <small>(" + esc(a.dono_sub) + ")</small>" : "") +
          (a.dono_sub ? ' <button type="button" class="link" data-ap="conta" data-sub="' + esc(a.dono_sub) + '">Ver a conta no Workspace</button>' : "") + "</dd>" +
          "<dt>E-mail Atos do dono</dt><dd>" + esc(aliasDoDono(a)) + "</dd>" +
          "<dt>Workspace do dono</dt><dd>" + esc(workspaceDoDono(a)) + "</dd>" +
          "<dt>Site</dt><dd>" + esc(a.site) + "</dd>" +
          "<dt>Privacidade</dt><dd>" + esc(a.privacidade) + "</dd>" +
          "<dt>Termos</dt><dd>" + esc(a.termos) + "</dd>" +
          "<dt>Quem entra</dt><dd>" + esc(quemEntra(a)) + "</dd>" +
          (a.bloqueado ? "<dt>Desligado</dt><dd>" + esc(U.quando(a.bloqueado.quando)) + (a.bloqueado.motivo ? ": " + esc(a.bloqueado.motivo) : "") + "</dd>" : "") +
          "<dt>Acessos</dt><dd>" + (a.acessos.length ? a.acessos.map(function (c) {
            return "<code>" + esc(c.id) + "</code> · " + (c.tipo === "confidencial" ? "confidencial" : "público") + (c.ativo ? "" : " · desligado pelo dono") + "<br><small>" + voltasDe(c).map(esc).join(" · ") + "</small>";
          }).join("<br>") : "nenhum") + "</dd>" +
          "<dt>Registro</dt><dd>" + ((a.registro || []).map(function (x) { return esc(U.quando(x.quando)) + " · " + esc(x.por) + ": " + esc(x.oque); }).join("<br>") || "nada ainda") + "</dd>" +
          "</dl></div>";
      }
      var botoes = '<button type="button" class="btn mini" data-ap="ver" data-id="' + esc(a.id) + '" aria-expanded="' + aberto + '">Detalhes</button>';
      if (podeDesligar()) {
        botoes += a.bloqueado ? '<button type="button" class="btn mini" data-ap="ligar" data-id="' + esc(a.id) + '">Ligar de novo</button>'
          : '<button type="button" class="btn mini" data-ap="desligar" data-id="' + esc(a.id) + '">Desligar</button>';
      }
      if (podeApagar()) botoes += '<button type="button" class="btn mini perigo" data-ap="apagar" data-id="' + esc(a.id) + '">Apagar</button>';
      return '<div class="oa-cliente"><div class="item oa-item">' + icone(a) + '<span class="nome"><strong>' + esc(a.nome) + ' <span class="nf-tag">' + esc(a.id) + "</span> " + sit + ws + "</strong>" +
        "<small>" + esc(a.descricao) + " · de " + esc(a.dono) + " · " + a.acessos.length + (a.acessos.length === 1 ? " acesso" : " acessos") + " · " + esc(quemEntra(a)) + "</small></span>" +
        '<span class="pv-par">' + botoes + "</span></div>" + det + "</div>";
    }).join("") + "</div>";
    return h + '<p class="nota">Desligar, ligar e apagar valem na hora, sem a fila, e ficam no registro do aplicativo (o dono vê) e no registro da equipe. Desligado pela Atos, nenhum acesso do aplicativo começa login, troca código ou responde no userinfo; o dono vê o motivo e não consegue religar. O id_token já emitido vale até vencer. ' +
      (podeApagar() ? "" : "Apagar é só do dono.") + "</p>";
  }

  function modal() {
    var T = S.acao, a = app(T.id) || { nome: T.id, dono: "" }, apagar = T.acao === "apagar";
    return '<h2 id="modal-titulo">' + (apagar ? "Apagar " : "Desligar ") + esc(a.nome) + "</h2>" +
      "<p>" + (apagar
        ? "O aplicativo de " + esc(a.dono) + " sai do Entrar com Atos na hora, com os acessos e os segredos. Não tem volta (o dono teria de cadastrar outro)."
        : "Nenhum acesso de " + esc(a.nome) + " começa login, troca código ou responde no userinfo, até a Atos ligar de novo. O dono vê o motivo no registro do aplicativo.") +
      " O id_token já emitido vale até vencer.</p>" +
      '<label class="campo"><span class="rotulo">Motivo' + (apagar ? " (opcional)" : " (o dono vê)") + '</span><input data-ap-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo || "") + '"></label>' +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-ap="ok"' + (T.enviando ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : apagar ? "Apagar" : "Desligar") + "</button></div>";
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-ap]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-ap"), id = b.getAttribute("data-id");
    if (a === "recarregar") { carregar(); pintar(); return; }
    if (a === "ver") { S.aberto = S.aberto === id ? "" : id; pintar(); return; }
    if (a === "conta") { if (A.atalhos.contaWs) A.atalhos.contaWs(b.getAttribute("data-sub")); return; }
    if (a === "desligar" || a === "apagar") {
      S.acao = { id: id, acao: a, motivo: "", erro: "", enviando: false };
      A.modal.abrir({ html: modal, aoFechar: function () { S.acao = null; } }); return;
    }
    if (a === "ligar") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/workspace/apps/" + encodeURIComponent(id) + "/ligar", {}).then(function () { A.toast("Ligado de novo"); carregar(); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "ok") {
      var T = S.acao; if (!T || T.enviando) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/workspace/apps/" + encodeURIComponent(T.id) + "/" + T.acao, { motivo: T.motivo, confirmar: T.acao === "apagar" }).then(function () {
        if (S.acao !== T) return;
        A.modal.fechar(); A.toast(T.acao === "apagar" ? "Apagado" : "Desligado"); carregar();
      }, function (er) {
        if (S.acao !== T) return;
        T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-ap-in") === "motivo" && S.acao) S.acao.motivo = e.target.value;
  });

  A.secoes.push({
    id: "ws-apps",
    nome: "Aplicativos de terceiros",
    grupo: "Atos Workspace",
    area: "atos",
    ordem: 4,
    desenhar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.carregando) carregar();
    },
  });
})();
