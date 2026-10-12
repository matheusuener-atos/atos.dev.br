/* O painel da Atos, grupo Atos Workspace, secao E-mail Atos: os enderecos @atos.dev.br (worker/email-atos.js). Area "atos";
   ver: todos os papeis; suspender, reativar e remover por abuso: dono e suporte (o servidor confere de novo).

     GET  /api/admin/email                          os enderecos (dono, estado, destino), as vagas e as recusas a
                                                    enderecos que nao existem, por dia
     GET  /api/admin/email/registro?alias=          as entregas (30 dias, sem conteudo) e as mudancas
     POST /api/admin/email/:alias/suspender         {motivo} (a pessoa ve o motivo)
     POST /api/admin/email/:alias/reativar
     POST /api/admin/email/:alias/remover           {confirmar: true, motivo?} */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var S = { raiz: null, dados: null, erro: "", carregando: false, aberto: "", registro: {}, acao: null };
  var MOTIVOS = {
    inexistente: "não existe", loop: "loop", suspenso: "suspenso", desligado: "desligado", destino_nao_verificado: "destino não confirmado",
    limite_automaticas: "limite de automáticas", limite_remetente: "limite do remetente", limite_hora: "limite por hora", limite_dia: "limite por dia",
    sem_workspace: "sem Workspace", workspace_fora: "Workspace não respondeu", forward: "a Cloudflare não encaminhou",
  };

  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }
  function carregar() {
    S.carregando = true;
    A.pedir("GET", "/api/admin/email").then(function (d) { S.dados = d; S.erro = ""; }, function (e) { if (e.status !== 401) S.erro = e.message; })
      .then(function () { S.carregando = false; pintar(); });
  }
  /* Abre (ou fecha) os detalhes de um endereco e le o registro dele. */
  function abrir(id) {
    S.aberto = id;
    if (!id) return;
    delete S.registro[id];
    A.pedir("GET", "/api/admin/email/registro?alias=" + encodeURIComponent(id)).then(function (r) { S.registro[id] = r; }, function (er) { S.registro[id] = { erro: er.message }; }).then(pintar);
  }
  /* Os atalhos das outras secoes (a conta do Workspace, a busca): abrir este endereco aqui. */
  A.atalhos = A.atalhos || {};
  A.atalhos.alias = function (id) { abrir(id); A.navegar("email-atos"); };
  function podeMudar() { return A.quem && (A.quem.papel === "dono" || A.quem.papel === "suporte"); }
  function alias(a) { return ((S.dados || {}).aliases || []).filter(function (x) { return x.alias === a; })[0] || null; }

  function situacao(x) {
    if (x.suspenso) return '<span class="pv-sit perigo">suspenso</span>';
    if (x.estado === "ligado") return '<span class="pv-sit ok">encaminhando</span>';
    return '<span class="pv-sit">desligado</span>';
  }
  function registroDe(a) {
    var R = S.registro[a];
    if (!R) return '<p class="dica">Carregando o registro…</p>';
    if (R.erro) return '<p class="erro">' + esc(R.erro) + "</p>";
    var ent = R.entregas.slice(0, 30).map(function (x) {
      return esc(U.quando(x.quando)) + " · " + esc(x.resultado) + (x.motivo ? " (" + esc(MOTIVOS[x.motivo] || x.motivo) + ")" : "") + (x.de ? " · de " + esc(x.de) : "") + " · " + Math.ceil((x.tamanho || 0) / 1024) + " KB";
    });
    var mud = R.mudancas.slice(0, 30).map(function (x) { return esc(U.quando(x.quando)) + " · " + esc(x.por || "") + ": " + esc(x.oque); });
    return "<dt>Entregas (" + R.retencao_dias + " dias)</dt><dd>" + (ent.length ? ent.join("<br>") : "nenhuma") + "</dd>" +
      "<dt>Mudanças</dt><dd>" + (mud.length ? mud.join("<br>") : "nenhuma") + "</dd>";
  }

  function tela() {
    var h = "<h1>E-mail Atos</h1>";
    var D = S.dados;
    if (!D) return h + '<div class="card"><p class="vazio">' + (S.erro ? esc(S.erro) + ' <button type="button" class="link" data-em-adm="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    h += '<p class="nota">Os endereços @atos.dev.br do Atos Workspace: cada um encaminha para um destino que a pessoa confirmou (o código da Atos e a verificação da Cloudflare). ' +
      (D.disponivel ? (D.simulada ? "Neste Worker a Cloudflare é simulada." : "Ligado.") : "Desligado neste Worker (falta o segredo CF_EMAIL_TOKEN ou o CF_ACCOUNT_ID): ninguém reserva nem muda.") + "</p>";
    var v = D.vagas;
    h += '<div class="card"><div class="nf-det"><dl class="nf-info">' +
      "<dt>Destinos criados pela Atos</dt><dd>" + v.usadas + "</dd>" +
      "<dt>Destinos na conta Cloudflare</dt><dd>" + (v.na_cf == null ? "não deu para consultar" : v.na_cf) + " (teto da Cloudflare: " + v.teto_cf + " por conta; a Atos para em " + v.limite + ")</dd>" +
      "<dt>Recusas a endereços que não existem</dt><dd>" + (Object.keys(D.inexistentes || {}).sort().reverse().map(function (d) { return esc(d) + ": " + D.inexistentes[d]; }).join(" · ") || "nenhuma") + "</dd>" +
      "<dt>Limites</dt><dd>" + Math.round(D.limites.tamanho / 1048576) + " MB por mensagem · " + D.limites.por_hora + " por hora e " + D.limites.por_dia + " por dia por endereço · " +
      D.limites.por_remetente_hora + " por hora do mesmo remetente · " + D.limites.auto_por_hora + " automáticas por hora</dd></dl></div></div>";
    var l = D.aliases || [];
    h += '<h2 class="titulo-secao pv-h2"><span>Endereços (' + l.length + ")</span></h2>";
    if (!l.length) return h + '<div class="card"><p class="vazio">Ninguém reservou um endereço ainda.</p></div>';
    return h + '<div class="card">' + l.map(function (x) {
      var aberto = S.aberto === x.alias;
      var det = aberto ? '<div class="nf-det"><dl class="nf-info">' +
        "<dt>Conta</dt><dd>" + esc(x.conta) + (x.sub ? ' <button type="button" class="link" data-em-adm="conta" data-sub="' + esc(x.sub) + '">Ver a conta no Workspace</button>' : "") + "</dd>" +
        "<dt>Destino</dt><dd>" + (x.destino ? esc(x.destino.email) + " · código " + (x.destino.codigo_ok ? "confirmado" : "pendente") + " · Cloudflare " + (x.destino.cf_ok ? "verificado" : "pendente") : "—") + "</dd>" +
        (x.suspenso ? "<dt>Suspenso</dt><dd>" + esc(U.quando(x.suspenso.quando)) + " por " + esc(x.suspenso.por || "") + (x.suspenso.motivo ? ": " + esc(x.suspenso.motivo) : "") + "</dd>" : "") +
        "<dt>Criado</dt><dd>" + esc(U.quando(x.criado)) + "</dd>" + registroDe(x.alias) + "</dl></div>" : "";
      var botoes = '<button type="button" class="btn mini" data-em-adm="ver" data-id="' + esc(x.alias) + '" aria-expanded="' + aberto + '">Detalhes</button>';
      if (podeMudar()) {
        botoes += x.suspenso ? '<button type="button" class="btn mini" data-em-adm="reativar" data-id="' + esc(x.alias) + '">Tirar a suspensão</button>'
          : '<button type="button" class="btn mini" data-em-adm="suspender" data-id="' + esc(x.alias) + '">Suspender</button>';
        botoes += '<button type="button" class="btn mini perigo" data-em-adm="remover" data-id="' + esc(x.alias) + '">Remover</button>';
      }
      return '<div class="oa-cliente"><div class="item oa-item"><span class="logo inicial" aria-hidden="true">@</span><span class="nome"><strong>' + esc(x.endereco) + " " + situacao(x) + "</strong>" +
        "<small>de " + esc(x.conta) + (x.destino ? " · para " + esc(x.destino.email) : " · sem destino") + "</small></span>" +
        '<span class="pv-par">' + botoes + "</span></div>" + det + "</div>";
    }).join("") + "</div>" +
      '<p class="nota">Suspender recusa as mensagens na hora e impede a pessoa de ligar ou trocar o destino; ela vê o motivo. Tirar a suspensão deixa o endereço desligado até ela ligar. ' +
      "Remover tira o endereço da conta (ele fica 30 dias em quarentena) e apaga da Cloudflare o destino que só ele usava. Tudo vale na hora e fica no registro.</p>";
  }

  function modal() {
    var T = S.acao, rem = T.acao === "remover";
    return '<h2 id="modal-titulo">' + (rem ? "Remover " : "Suspender ") + esc(T.id) + "@atos.dev.br</h2>" +
      "<p>" + (rem ? "O endereço sai da conta de " + esc((alias(T.id) || {}).conta || "") + " na hora; as mensagens passam a ser recusadas. Ele fica 30 dias sem poder ser reservado por outra conta."
        : "As mensagens passam a ser recusadas na hora, e a pessoa não liga nem troca o destino até a Atos tirar a suspensão. Ela vê o motivo.") + "</p>" +
      '<label class="campo"><span class="rotulo">Motivo' + (rem ? " (opcional)" : " (a pessoa vê)") + '</span><input data-em-adm-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo || "") + '"></label>' +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-em-adm="ok"' + (T.enviando ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : rem ? "Remover" : "Suspender") + "</button></div>";
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-em-adm]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-em-adm"), id = b.getAttribute("data-id");
    if (a === "recarregar") { carregar(); pintar(); return; }
    if (a === "ver") { abrir(S.aberto === id ? "" : id); pintar(); return; }
    if (a === "conta") { if (A.atalhos.contaWs) A.atalhos.contaWs(b.getAttribute("data-sub")); return; }
    if (a === "suspender" || a === "remover") {
      S.acao = { id: id, acao: a, motivo: "", erro: "", enviando: false };
      A.modal.abrir({ html: modal, aoFechar: function () { S.acao = null; } }); return;
    }
    if (a === "reativar") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/email/" + encodeURIComponent(id) + "/reativar", {}).then(function () { A.toast("Suspensão tirada"); carregar(); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "ok") {
      var T = S.acao; if (!T || T.enviando) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/email/" + encodeURIComponent(T.id) + "/" + T.acao, { motivo: T.motivo, confirmar: T.acao === "remover" }).then(function () {
        if (S.acao !== T) return;
        A.modal.fechar(); A.toast(T.acao === "remover" ? "Removido" : "Suspenso"); carregar();
      }, function (er) {
        if (S.acao !== T) return;
        T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-em-adm-in") === "motivo" && S.acao) S.acao.motivo = e.target.value;
  });

  A.secoes.push({
    id: "email-atos",
    nome: "E-mail Atos",
    grupo: "Atos Workspace",
    area: "atos",
    ordem: 3,
    desenhar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.carregando) carregar();
    },
  });
})();
