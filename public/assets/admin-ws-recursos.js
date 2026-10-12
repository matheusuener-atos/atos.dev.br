/* O painel da Atos, grupo Atos Workspace: os recursos que as pessoas criam no Workspace alem das Integracoes e do e-mail
   Atos. Area "atos"; ver: todos os papeis; desligar e ligar de novo por abuso: dono e suporte (o servidor confere de novo).

   Formularios (worker/formularios.js):
     GET  /api/admin/workspace/formularios                      todos, com o dono, os numeros do dia e da semana e o teto
                                                                diario da Atos
     POST /api/admin/workspace/formularios/:id/desligar         {motivo} (o dono ve)  | /ligar

   Paginas de status (worker/status.js):
     GET  /api/admin/workspace/status                           todas, a agenda do Cron e o atraso
     POST /api/admin/workspace/status/:nome/desligar            {motivo} (o dono ve)  | /ligar */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var F = { raiz: null, dados: null, erro: "", carregando: false, acao: null };
  function podeMudar() { return A.quem && (A.quem.papel === "dono" || A.quem.papel === "suporte"); }

  // ------------------------------------------------------------ Formularios

  function pintarF() { if (F.raiz && document.body.contains(F.raiz)) F.raiz.innerHTML = telaF(); }
  function carregarF() {
    F.carregando = true;
    A.pedir("GET", "/api/admin/workspace/formularios").then(function (d) { F.dados = d; F.erro = ""; }, function (e) { if (e.status !== 401) F.erro = e.message; })
      .then(function () { F.carregando = false; pintarF(); });
  }
  function telaF() {
    var h = "<h1>Formulários</h1>", D = F.dados;
    if (!D) return h + '<div class="card"><p class="vazio">' + (F.erro ? esc(F.erro) + ' <button type="button" class="link" data-wr="recarregar-f">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    h += '<p class="nota">Os formulários de contato que as pessoas criam no Workspace: cada envio vira um e-mail da Atos (pelo Resend) ao destino do e-mail Atos do dono. O conteúdo não é guardado; os números abaixo são contagens. ' +
      "Verificação Turnstile: " + (D.turnstile ? "ligada na Atos (cada dono escolhe)." : "desligada (falta TURNSTILE_SECRET ou TURNSTILE_SITEKEY); valem a armadilha e os limites.") + "</p>";
    h += '<div class="card"><div class="nf-det"><dl class="nf-info"><dt>Envios da Atos hoje</dt><dd>' + D.global.entregues_hoje + " entregues · " + D.global.hoje + " de " + D.global.limite + " do teto diário (FORMULARIOS_LIMITE_DIA)</dd>" +
      "<dt>Limites</dt><dd>" + D.limites.formularios + " por conta · " + D.limites.por_ip_hora + " por hora do mesmo endereço · até " + D.limites.dia_max + " por dia por formulário · " + D.limites.corpo_kb + " KB por envio</dd></dl></div></div>";
    var l = D.formularios || [];
    h += '<h2 class="titulo-secao pv-h2"><span>Formulários (' + l.length + ")</span></h2>";
    if (!l.length) return h + '<div class="card"><p class="vazio">Ninguém criou um formulário ainda.</p></div>';
    return h + '<div class="card">' + l.map(function (x) {
      var n = x.numeros || { hoje: { entregues: 0, recusados: 0 }, semana: { entregues: 0, recusados: 0 } };
      var botoes = "";
      if (podeMudar()) {
        botoes = x.bloqueado ? '<button type="button" class="btn mini" data-wr="ligar-f" data-id="' + esc(x.id) + '">Ligar de novo</button>'
          : '<button type="button" class="btn mini perigo" data-wr="desligar-f" data-id="' + esc(x.id) + '">Desligar</button>';
      }
      if (x.sub && A.atalhos && A.atalhos.contaWs) botoes = '<button type="button" class="btn mini" data-wr="conta" data-sub="' + esc(x.sub) + '">Conta</button>' + botoes;
      return '<div class="oa-cliente"><div class="item oa-item"><span class="logo inicial" aria-hidden="true">F</span><span class="nome"><strong>' + esc(x.nome || x.id) +
        (x.bloqueado ? ' <span class="pv-sit perigo">desligado pela Atos</span>' : "") + "</strong>" +
        "<small>" + esc(x.id) + " · de " + esc(x.conta || x.sub) + " · criado em " + esc(U.quando(x.criado)) + "</small>" +
        "<small>Hoje: " + n.hoje.entregues + " entregues, " + n.hoje.recusados + " recusados · 7 dias: " + n.semana.entregues + " entregues, " + n.semana.recusados + " recusados</small>" +
        (x.bloqueado ? "<small>Desligado em " + esc(U.quando(x.bloqueado.quando)) + " por " + esc(x.bloqueado.por || "") + ": " + esc(x.bloqueado.motivo || "") + "</small>" : "") +
        '</span><span class="pv-par">' + botoes + "</span></div></div>";
    }).join("") + "</div>" +
      '<p class="nota">Desligar para as entregas na hora (quem envia vê “formulário desligado”) e o dono não consegue religar; ele vê o motivo. Fica no registro da equipe.</p>';
  }
  function modalF() {
    var T = F.acao;
    return '<h2 id="modal-titulo">Desligar o formulário ' + esc(T.id) + "</h2><p>As entregas param na hora e o dono não consegue religar até a Atos ligar de novo. Ele vê o motivo.</p>" +
      '<label class="campo"><span class="rotulo">Motivo (o dono vê)</span><input data-wr-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo || "") + '"></label>' +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-wr="ok-f"' + (T.enviando ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : "Desligar") + "</button></div>";
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-wr]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-wr"), id = b.getAttribute("data-id");
    if (a === "recarregar-f") { carregarF(); pintarF(); return; }
    if (a === "conta") { if (A.atalhos.contaWs) A.atalhos.contaWs(b.getAttribute("data-sub")); return; }
    if (a === "desligar-f") { F.acao = { id: id, motivo: "", erro: "", enviando: false }; A.modal.abrir({ html: modalF, aoFechar: function () { F.acao = null; } }); return; }
    if (a === "ligar-f") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/workspace/formularios/" + encodeURIComponent(id) + "/ligar", {}).then(function () { A.toast("Ligado de novo"); carregarF(); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "ok-f") {
      var T = F.acao; if (!T || T.enviando) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/workspace/formularios/" + encodeURIComponent(T.id) + "/desligar", { motivo: T.motivo }).then(function () {
        if (F.acao !== T) return;
        A.modal.fechar(); A.toast("Desligado"); carregarF();
      }, function (er) {
        if (F.acao !== T) return;
        T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-wr-in") === "motivo" && F.acao) F.acao.motivo = e.target.value;
  });

  // ------------------------------------------------------------ Paginas de status

  var P = { raiz: null, dados: null, erro: "", carregando: false, acao: null };
  function pintarP() { if (P.raiz && document.body.contains(P.raiz)) P.raiz.innerHTML = telaP(); }
  function carregarP() {
    P.carregando = true;
    A.pedir("GET", "/api/admin/workspace/status").then(function (d) { P.dados = d; P.erro = ""; }, function (e) { if (e.status !== 401) P.erro = e.message; })
      .then(function () { P.carregando = false; pintarP(); });
  }
  function telaP() {
    var h = "<h1>Páginas de status</h1>", D = P.dados;
    if (!D) return h + '<div class="card"><p class="vazio">' + (P.erro ? esc(P.erro) + ' <button type="button" class="link" data-wr="recarregar-p">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    h += '<p class="nota">As páginas atos.dev.br/status/&lt;nome&gt;: a Atos confere os endereços de cada uma a cada ' + D.limites.intervalo_min + " minutos pelo Cron, até " + D.por_minuto +
      " contas por minuto (STATUS_POR_MINUTO). Só https público; sem IP, rede interna nem a Atos.</p>" +
      '<div class="card"><div class="nf-det"><dl class="nf-info"><dt>Agenda</dt><dd>' + D.agenda.contas + " contas · " + D.agenda.atrasadas + " atrasadas" +
      (D.agenda.atrasadas ? " (a maior, " + Math.round(D.agenda.maior_atraso_s / 60) + " min: aumente STATUS_POR_MINUTO)" : "") + "</dd></dl></div></div>";
    var l = D.paginas || [];
    h += '<h2 class="titulo-secao pv-h2"><span>Páginas (' + l.length + ")</span></h2>";
    if (!l.length) return h + '<div class="card"><p class="vazio">Ninguém criou uma página de status ainda.</p></div>';
    return h + '<div class="card">' + l.map(function (x) {
      var botoes = podeMudar() ? (x.bloqueado ? '<button type="button" class="btn mini" data-wr="ligar-p" data-id="' + esc(x.nome) + '">Ligar de novo</button>'
        : '<button type="button" class="btn mini perigo" data-wr="desligar-p" data-id="' + esc(x.nome) + '">Tirar do ar</button>') : "";
      if (x.sub && A.atalhos && A.atalhos.contaWs) botoes = '<button type="button" class="btn mini" data-wr="conta" data-sub="' + esc(x.sub) + '">Conta</button>' + botoes;
      return '<div class="oa-cliente"><div class="item oa-item"><span class="logo inicial" aria-hidden="true">S</span><span class="nome"><strong><a href="/status/' + esc(x.nome) + '">' + esc(x.nome) + "</a>" +
        (x.bloqueado ? ' <span class="pv-sit perigo">tirada do ar pela Atos</span>' : "") + "</strong>" +
        "<small>de " + esc(x.conta || x.sub) + " · criada em " + esc(U.quando(x.criado)) + (x.agenda && x.agenda.ultima ? " · conferida em " + esc(U.quando(x.agenda.ultima)) : " · ainda não conferida") + "</small>" +
        (x.bloqueado ? "<small>Tirada do ar em " + esc(U.quando(x.bloqueado.quando)) + " por " + esc(x.bloqueado.por || "") + ": " + esc(x.bloqueado.motivo || "") + "</small>" : "") +
        '</span><span class="pv-par">' + botoes + "</span></div></div>";
    }).join("") + "</div>" + '<p class="nota">Tirar do ar some com a página pública e para as conferências na hora; o dono vê o motivo e não consegue mudar a página até a Atos ligar de novo. Fica no registro da equipe.</p>';
  }
  function modalP() {
    var T = P.acao;
    return '<h2 id="modal-titulo">Tirar do ar a página ' + esc(T.id) + "</h2><p>A página pública some e as conferências param na hora. O dono vê o motivo.</p>" +
      '<label class="campo"><span class="rotulo">Motivo (o dono vê)</span><input data-wr-in="motivo-p" maxlength="200" autocomplete="off" value="' + esc(T.motivo || "") + '"></label>' +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-wr="ok-p"' + (T.enviando ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : "Tirar do ar") + "</button></div>";
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-wr]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-wr"), id = b.getAttribute("data-id");
    if (a === "recarregar-p") { carregarP(); pintarP(); return; }
    if (a === "desligar-p") { P.acao = { id: id, motivo: "", erro: "", enviando: false }; A.modal.abrir({ html: modalP, aoFechar: function () { P.acao = null; } }); return; }
    if (a === "ligar-p") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/workspace/status/" + encodeURIComponent(id) + "/ligar", {}).then(function () { A.toast("Ligada de novo"); carregarP(); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "ok-p") {
      var T = P.acao; if (!T || T.enviando) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/workspace/status/" + encodeURIComponent(T.id) + "/desligar", { motivo: T.motivo }).then(function () {
        if (P.acao !== T) return;
        A.modal.fechar(); A.toast("Tirada do ar"); carregarP();
      }, function (er) { if (P.acao !== T) return; T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar(); });
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-wr-in") === "motivo-p" && P.acao) P.acao.motivo = e.target.value;
  });
  A.secoes.push({
    id: "ws-status", nome: "Páginas de status", grupo: "Atos Workspace", area: "atos", ordem: 6,
    desenhar: function (raiz) { P.raiz = raiz; pintarP(); if (!P.carregando) carregarP(); },
  });

  A.secoes.push({
    id: "ws-formularios",
    nome: "Formulários",
    grupo: "Atos Workspace",
    area: "atos",
    ordem: 5,
    desenhar: function (raiz) {
      F.raiz = raiz;
      pintarF();
      if (!F.carregando) carregarF();
    },
  });
})();
