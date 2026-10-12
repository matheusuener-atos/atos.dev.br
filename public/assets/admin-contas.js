/* O painel da Atos, grupo Atos, secao Contas Atos: o atendimento (o servidor e worker/admin-contas.js). Area "atos".
   Ver: todos os papeis. Agir: so o dono, com o motivo, a confirmacao aqui e o registro da equipe; nunca na propria conta.

     GET  /api/admin/contas?q=                 a busca (o e-mail, o endereco @atos.dev.br, os e-mails que comecam assim)
     GET  /api/admin/contas/ver?email=         a conta: como entra, o resumo da seguranca (sem segredos), os acessos,
                                               as sessoes, o Workspace e o registro da equipe
     POST /api/admin/contas/sessoes            {email, motivo, confirmar: true}
     POST /api/admin/contas/segunda-etapa      {email, motivo, confirmar: true, identidade_conferida: true, encerrar_sessoes}
     POST /api/admin/contas/conceder           {email, produto, plano, motivo, confirmar: true}: a assinatura de R$ 0,00/mes
     POST /api/admin/contas/encerrar-concedida {email, id, motivo, confirmar: true} */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var S = { raiz: null, q: "", res: null, buscando: false, erro: "", email: "", conta: null, erroConta: "", acao: null, seq: 0 };
  var COMO = { senha: "senha", alias: "endereço Atos e senha", google: "Google", cadastro: "cadastro (código do e-mail)", redefinir: "troca de senha (código do e-mail)", chave: "chave de acesso" };
  var SEGUNDA = { otp: "código do aplicativo", recuperacao: "código de recuperação", chave: "chave de acesso" };
  var EVENTO = {
    "totp-ligada": "ligou o aplicativo autenticador", "totp-desligada": "desligou o aplicativo autenticador", "chave-cadastrada": "cadastrou uma chave de acesso",
    "chave-removida": "removeu uma chave de acesso", "codigos-gerados": "gerou códigos de recuperação novos", "senha-trocada": "trocou a senha", "sair-outras": "saiu das outras sessões",
    "chave-contador": "uma chave mostrou um contador fora de ordem", "equipe-2fa-desligada": "a equipe desligou a verificação em duas etapas", "equipe-sessoes-encerradas": "a equipe encerrou as sessões",
  };

  function dono() { return A.quem && A.quem.papel === "dono"; }
  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }
  function buscar() {
    var q = S.q.trim(), seq = ++S.seq;
    if (q.length < 2) { S.res = null; S.erro = ""; pintar(); return; }
    S.buscando = true; pintar();
    A.pedir("GET", "/api/admin/contas?q=" + encodeURIComponent(q)).then(function (d) { if (seq === S.seq) { S.res = d.contas || []; S.erro = ""; } },
      function (e) { if (seq === S.seq) { S.res = null; S.erro = e.status === 401 ? "" : e.message; } })
      .then(function () { if (seq === S.seq) { S.buscando = false; pintar(); } });
  }
  function abrir(email) {
    S.email = email; S.conta = null; S.erroConta = "";
    A.pedir("GET", "/api/admin/contas/ver?email=" + encodeURIComponent(email)).then(function (d) { if (S.email === email) S.conta = d; },
      function (e) { if (S.email === email && e.status !== 401) S.erroConta = e.message; }).then(pintar);
  }
  A.atalhos = A.atalhos || {};
  A.atalhos.conta = function (email) { if (!email) return; S.q = email; abrir(email); A.navegar("contas-atos"); };

  function tela() {
    var h = "<h1>Contas Atos</h1>";
    if (S.email) return h + contaHtml();
    h += '<p class="descricao">O atendimento: busque uma conta pelo e-mail ou pelo endereço @atos.dev.br para ver como ela entra, a segurança (sem segredo nenhum), os últimos acessos e as sessões abertas.</p>' +
      '<form class="pv-barra-filtros ws-barra" data-ct-form><input class="seletor pv-busca-campo" id="ct-q" value="' + esc(S.q) + '" placeholder="e-mail ou endereço @atos.dev.br" aria-label="Buscar uma Conta Atos" autocomplete="off" spellcheck="false">' +
      '<button type="submit" class="btn p primario">Buscar</button></form>';
    if (S.erro) return h + '<div class="card"><p class="erro">' + esc(S.erro) + "</p></div>";
    if (S.buscando) return h + '<div class="card"><p class="vazio">Buscando…</p></div>';
    if (!S.res) return h + '<div class="card"><p class="vazio">Digite pelo menos 2 letras. O e-mail exato e o endereço Atos acham a conta; um começo de e-mail (3 letras ou mais) lista as que começam assim.</p></div>';
    if (!S.res.length) return h + '<div class="card"><p class="vazio">Nenhuma Conta Atos com esse texto.</p></div>';
    return h + '<div class="card">' + S.res.map(function (x) {
      return '<div class="item oa-item"><span class="nome"><strong>' + esc(x.email) + "</strong><small>" + esc([x.nome, x.alias, x.criada ? "criada em " + U.ddmmaaaa(x.criada) : ""].filter(Boolean).join(" · ")) + "</small></span>" +
        '<span class="pv-par"><button type="button" class="btn mini" data-ct="abrir" data-email="' + esc(x.email) + '">Abrir</button></span></div>';
    }).join("") + "</div>";
  }

  function contaHtml() {
    var h = '<p><button type="button" class="link" data-ct="voltar">‹ Voltar à busca</button></p>';
    var D = S.conta;
    if (!D) return h + '<div class="card"><p class="vazio">' + (S.erroConta ? esc(S.erroConta) : "Carregando…") + "</p></div>";
    var c = D.conta, s = D.seguranca, en = D.entra;
    h += '<h2 class="titulo-secao pv-h2"><span>' + esc(c.email) + (c.na_equipe ? ' <span class="nf-tag">equipe · ' + esc(U.PAPEL_NOME[c.na_equipe] || c.na_equipe) + "</span>" : "") + "</span></h2>";
    var jeitos = [en.senha ? "e-mail e senha" : "", en.google ? "Google" : "", en.alias && en.alias !== "?" ? en.alias.endereco + (en.alias.suspenso ? " (suspenso: não entra)" : " e a senha") : ""].filter(Boolean);
    h += '<div class="card"><div class="nf-det"><dl class="nf-info">' +
      "<dt>Nome</dt><dd>" + esc(c.nome || "—") + "</dd>" +
      "<dt>Criada em</dt><dd>" + esc(U.quando(c.criada)) + (c.senha_trocada ? " · senha trocada em " + esc(U.quando(c.senha_trocada)) : "") + "</dd>" +
      "<dt>Como entra</dt><dd>" + esc(jeitos.join(" · ") || "sem senha (só o “Esqueci a senha” cria uma)") + (en.alias === "?" ? " · não deu para conferir o endereço Atos" : "") + "</dd>" +
      "<dt>Identificador</dt><dd><code>" + esc(c.sub) + "</code></dd>" +
      "<dt>Atos Workspace</dt><dd>" + (D.workspace === "?" ? "não deu para conferir" : !D.workspace ? "nunca ativou" :
        (D.workspace.suspenso ? "suspenso pela Atos" : D.workspace.ativo ? "ativo desde " + esc(U.ddmmaaaa(D.workspace.ativado)) : "desativado") +
        ' <button type="button" class="link" data-ct="ws" data-sub="' + esc(c.sub) + '">Ver no Workspace</button>') + "</dd>" +
      "</dl></div></div>";

    h += '<h2 class="titulo-secao pv-h2"><span>Segurança</span></h2><div class="card"><div class="nf-det"><dl class="nf-info">' +
      "<dt>Verificação em duas etapas</dt><dd>" + (s.ativa ? '<span class="pv-sit ok">ligada</span>' : '<span class="pv-sit">desligada</span>') + (s.bloqueado ? ' · <span class="pv-sit perigo">bloqueada por tentativas erradas (15 min)</span>' : "") + "</dd>" +
      "<dt>Aplicativo autenticador</dt><dd>" + (s.totp ? "ligado desde " + esc(U.quando(s.totp.desde)) : "não") + "</dd>" +
      "<dt>Códigos de recuperação</dt><dd>" + (s.recuperacao ? s.recuperacao.restantes + " restantes (gerados em " + esc(U.quando(s.recuperacao.gerados)) + ")" : "nenhum") + "</dd>" +
      "<dt>Chaves de acesso</dt><dd>" + (s.chaves.length ? s.chaves.map(function (k) {
        return esc(k.nome) + " · criada em " + esc(U.ddmmaaaa(k.criada)) + " · " + (k.ultimo_uso ? "último uso " + esc(U.quando(k.ultimo_uso)) : "nunca usada") + (k.sincronizada ? " · sincronizada" : "") + (k.alerta ? ' · <span class="pv-perigo">contador fora de ordem</span>' : "");
      }).join("<br>") : "nenhuma") + "</dd>" +
      "</dl></div></div>" +
      '<p class="nota">A equipe vê só o resumo: nunca o segredo do aplicativo, os códigos nem as chaves.</p>';

    h += '<h2 class="titulo-secao pv-h2"><span>Sessões abertas (' + D.sessoes.length + ")</span></h2><div class=\"card\">" + (D.sessoes.length ? D.sessoes.map(function (x) {
      return '<div class="item oa-item"><span class="nome"><strong>' + esc(x.navegador || "navegador desconhecido") + "</strong><small>" + esc(["aberta " + U.quando(x.criada), COMO[x.como] || x.como, x.segunda ? "2ª etapa: " + (SEGUNDA[x.segunda] || x.segunda) : "", x.onde].filter(Boolean).join(" · ")) + "</small></span></div>";
    }).join("") : '<p class="vazio">Nenhuma sessão aberta na lista.</p>') + "</div>";

    h += '<h2 class="titulo-secao pv-h2"><span>Últimos acessos (90 dias)</span></h2><div class="card">' + (D.atividade.length ? '<ul class="nf-passos pv-hist">' + D.atividade.slice(0, 20).map(function (x) {
      var o = x.tipo === "mudanca" ? (EVENTO[x.evento] || x.evento) + (x.detalhe ? ": " + x.detalhe : "") : "entrou com " + (COMO[x.como] || x.como) + (x.segunda ? " + " + (SEGUNDA[x.segunda] || x.segunda) : "");
      return "<li><span>" + esc(U.quando(x.quando)) + "</span><span>" + esc(o) + "</span><span>" + esc([x.navegador, x.onde].filter(Boolean).join(" · ")) + "</span></li>";
    }).join("") + "</ul>" : '<p class="vazio">Nada nos últimos 90 dias.</p>') + "</div>";

    h += '<h2 class="titulo-secao pv-h2"><span>Registro da equipe nesta conta</span></h2><div class="card">' + (D.registro.length ? '<ul class="nf-passos pv-hist">' + D.registro.map(function (x) {
      return "<li><span>" + esc(U.quando(x.quando)) + "</span><span>" + esc(x.por) + ": " + esc(x.oque) + (x.motivo ? " — motivo: " + esc(x.motivo) : "") + "</span><span></span></li>";
    }).join("") + "</ul>" : '<p class="vazio">Nada no registro.</p>') + "</div>";

    h += assinaturasHtml(D);

    h += '<h2 class="titulo-secao pv-h2"><span>Ações</span></h2>';
    if (c.propria) return h + '<div class="card"><p class="vazio">Esta é a sua conta: mude a segurança dela em Minha conta › Segurança.</p></div>';
    if (!dono()) return h + '<div class="card"><p class="vazio">Encerrar as sessões e desligar a verificação em duas etapas são só do dono.</p></div>';
    return h + '<div class="card">' +
      '<div class="excluir"><span>Encerrar todas as sessões abertas desta conta (a pessoa entra de novo; recebe um aviso no e-mail, sem link).</span><button type="button" class="btn p perigo" data-ct="sessoes">Encerrar as sessões</button></div>' +
      '<div class="excluir"><span>Desligar a verificação em duas etapas e remover as chaves de acesso: o atendimento de quem perdeu o aplicativo, os códigos e as chaves.</span><button type="button" class="btn p perigo" data-ct="segunda"' + (s.ativa || s.recuperacao ? "" : ' disabled title="a verificação já está desligada"') + ">Desligar a verificação</button></div>" +
      "</div>";
  }

  /* As assinaturas da conta (a cobranca) e a assinatura de R$ 0,00 concedida pela equipe: conceder e encerrar, so o dono. */
  var SIT_ASS = { authorized: ["ativa", "ok"], pending: ["pendente", ""], paused: ["pausada", ""], canceled: ["cancelada", "perigo"] };
  function reais(c) { return "R$ " + (Number(c || 0) / 100).toFixed(2).replace(".", ","); }
  function assinaturasHtml(D) {
    var h = '<h2 class="titulo-secao pv-h2"><span>Assinaturas</span></h2>';
    var C = D.cobranca;
    if (C === "?") return h + '<div class="card"><p class="vazio">Não deu para ler as assinaturas agora.</p></div>';
    if (!C) return h + '<div class="card"><p class="vazio">A cobrança não está neste Worker.</p></div>';
    h += '<div class="card">' + (C.assinaturas.length ? C.assinaturas.map(function (a) {
      var s = SIT_ASS[a.status] || [a.status, ""], dir = (C.direitos || []).filter(function (x) { return x.produto === a.produto; })[0];
      var info = [a.concedida ? "concedida pela equipe" + (a.concedida.por ? " (" + a.concedida.por + ")" : "") + " em " + U.ddmmaaaa(a.concedida.quando) + " · " + reais(0) + "/mês, sem cobrança" : reais(a.centavos) + "/mês no cartão",
        a.status === "authorized" && a.proxima ? (a.concedida ? "renova em " : "próxima cobrança em ") + U.ddmmaaaa(a.proxima) : "",
        dir && dir.ate ? "em dia até " + U.ddmmaaaa(dir.ate) : "", a.encerrada ? "encerrada por " + (a.encerrada.por || "?") + " em " + U.ddmmaaaa(a.encerrada.quando) : ""].filter(Boolean).join(" · ");
      return '<div class="item oa-item"><span class="nome"><strong>' + esc(a.preco) + ' <span class="pv-sit ' + s[1] + '">' + esc(s[0]) + "</span></strong><small>" + esc(info) + "</small></span>" +
        (a.concedida && a.status === "authorized" && dono() ? '<span class="pv-par"><button type="button" class="btn mini perigo" data-ct="encerrar" data-id="' + esc(a.id) + '" data-preco="' + esc(a.preco) + '">Encerrar</button></span>' : "") + "</div>";
    }).join("") : '<p class="vazio">Nenhuma assinatura.</p>') + "</div>";
    if (!dono() || !(D.conceder || []).length) return h;
    return h + '<div class="card"><div class="excluir"><span>Conceder uma assinatura de R$ 0,00 por mês: sem Mercado Pago, sem cartão e sem fatura. Ela aparece como ativa na Minha conta da pessoa, renova sozinha todo mês e libera o plano no produto como uma assinatura paga, até ser encerrada. Não vale por cima de uma assinatura paga viva.</span>' +
      '<button type="button" class="btn p" data-ct="conceder">Conceder assinatura (R$ 0,00/mês)</button></div></div>';
  }

  function modalConceder() {
    var T = S.acao, c = S.conta.conta, P = S.conta.conceder || [];
    var prod = P.filter(function (x) { return x.produto === T.produto; })[0] || P[0];
    if (prod && T.produto !== prod.produto) { T.produto = prod.produto; T.plano = ""; }
    var planos = prod ? prod.planos : [];
    if (!planos.some(function (x) { return x.plano === T.plano; })) T.plano = planos.length ? planos[planos.length - 1].plano : "";
    var plano = planos.filter(function (x) { return x.plano === T.plano; })[0];
    return '<h2 id="modal-titulo">Conceder assinatura a ' + esc(c.email) + "</h2>" +
      "<p>R$ 0,00 por mês, concedida pela equipe da Atos: nada vai ao Mercado Pago e nenhuma fatura é gerada. O produto recebe o plano e o “pago até” como numa assinatura paga, e ela renova sozinha todo mês até ser encerrada.</p>" +
      '<label class="campo"><span class="rotulo">Produto</span><select class="seletor" data-ct-in="produto">' + P.map(function (x) {
        return '<option value="' + esc(x.produto) + '"' + (prod && x.produto === prod.produto ? " selected" : "") + ">" + esc(x.nome) + "</option>"; }).join("") + "</select></label>" +
      '<label class="campo"><span class="rotulo">Plano</span><select class="seletor" data-ct-in="plano">' + planos.map(function (x) {
        return '<option value="' + esc(x.plano) + '"' + (x.plano === T.plano ? " selected" : "") + ">" + esc(x.nome) + " (de " + reais(x.centavos) + "/mês; aqui, " + reais(0) + ")</option>"; }).join("") + "</select></label>" +
      '<label class="campo"><span class="rotulo">Motivo (fica no registro da equipe)</span><input data-ct-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo) + '" data-foco></label>' +
      '<label class="nf-marcar oa-marcar"><input type="checkbox" data-ct-in="confirmar"' + (T.confirmar ? " checked" : "") + "><span>Confirmo: conceder " + esc(plano ? plano.nome : "o plano") + " por R$ 0,00/mês a " + esc(c.email) + "</span></label>" +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p primario" data-ct="ok"' + (bloqueado(T) ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : "Conceder") + "</button></div>";
  }

  function bloqueado(T) {
    return T.enviando || !T.confirmar || T.motivo.trim().length < 5 || (T.acao === "segunda" && !T.identidade) || (T.acao === "conceder" && (!T.produto || !T.plano));
  }

  function modal() {
    var T = S.acao, c = S.conta && S.conta.conta;
    if (!T || !c) return "";
    if (T.acao === "conceder") return modalConceder();
    if (T.acao === "encerrar") {
      return '<h2 id="modal-titulo">Encerrar a assinatura concedida de ' + esc(c.email) + "</h2>" +
        "<p>" + esc(T.preco) + " deixa de renovar. O mês já concedido vale até o fim, como numa assinatura paga cancelada, e o produto fica sabendo.</p>" +
        '<label class="campo"><span class="rotulo">Motivo (fica no registro da equipe)</span><input data-ct-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo) + '" data-foco></label>' +
        '<label class="nf-marcar oa-marcar"><input type="checkbox" data-ct-in="confirmar"' + (T.confirmar ? " checked" : "") + "><span>Confirmo: encerrar a assinatura concedida</span></label>" +
        (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
        '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-ct="ok"' + (bloqueado(T) ? " disabled" : "") + ">" +
        (T.enviando ? "Um momento…" : "Encerrar") + "</button></div>";
    }
    var marcar = function (k, texto) { return '<label class="nf-marcar oa-marcar"><input type="checkbox" data-ct-in="' + k + '"' + (T[k] ? " checked" : "") + "><span>" + texto + "</span></label>"; };
    var corpo = T.acao === "sessoes"
      ? '<h2 id="modal-titulo">Encerrar as sessões de ' + esc(c.email) + "</h2><p>Todas as sessões abertas desta conta caem agora; para usar a conta, a pessoa entra de novo. Ela recebe um aviso no e-mail da conta, sem link, e a ação aparece nos últimos acessos dela.</p>"
      : '<h2 id="modal-titulo">Desligar a verificação em duas etapas de ' + esc(c.email) + "</h2>" +
        '<p class="nf-aviso"><span>Antes: confira a identidade da pessoa fora do painel. O pedido tem de ter vindo do e-mail da conta para contato@atos.dev.br; na dúvida, peça mais (por exemplo, dados de um pagamento) e não desligue.</span></p>' +
        "<p>Saem o aplicativo autenticador, os códigos de recuperação e as chaves de acesso; depois, basta a senha para entrar. A pessoa recebe um aviso no e-mail da conta, sem link.</p>" +
        marcar("identidade", "Conferi a identidade da pessoa fora do painel") + marcar("encerrar", "Encerrar também as sessões abertas");
    return corpo + '<label class="campo"><span class="rotulo">Motivo (fica no registro da equipe)</span><input data-ct-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo) + '"' + (T.acao === "sessoes" ? " data-foco" : "") + "></label>" +
      marcar("confirmar", "Confirmo: " + (T.acao === "sessoes" ? "encerrar todas as sessões desta conta" : "desligar a verificação em duas etapas desta conta")) +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-ct="ok"' + (T.enviando || !T.confirmar || (T.acao === "segunda" && !T.identidade) || T.motivo.trim().length < 5 ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : T.acao === "sessoes" ? "Encerrar as sessões" : "Desligar a verificação") + "</button></div>";
  }

  document.addEventListener("submit", function (e) {
    if (!e.target || !e.target.hasAttribute || !e.target.hasAttribute("data-ct-form")) return;
    e.preventDefault();
    var el = document.getElementById("ct-q");
    if (el) S.q = el.value;
    buscar();
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-ct]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-ct");
    if (a === "abrir") { abrir(b.getAttribute("data-email")); pintar(); return; }
    if (a === "voltar") { S.email = ""; S.conta = null; pintar(); return; }
    if (a === "ws") { if (A.atalhos.contaWs) A.atalhos.contaWs(b.getAttribute("data-sub")); return; }
    if (a === "sessoes" || a === "segunda") {
      S.acao = { acao: a, motivo: "", confirmar: false, identidade: false, encerrar: true, erro: "", enviando: false };
      A.modal.abrir({ html: modal, aoFechar: function () { S.acao = null; } }); return;
    }
    if (a === "conceder" || a === "encerrar") {
      S.acao = { acao: a, motivo: "", confirmar: false, produto: "", plano: "", id: b.getAttribute("data-id") || "", preco: b.getAttribute("data-preco") || "", erro: "", enviando: false };
      A.modal.abrir({ html: modal, aoFechar: function () { S.acao = null; } }); return;
    }
    if (a === "ok") {
      var T = S.acao, email = S.email; if (!T || T.enviando || !email) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      var corpo = { email: email, motivo: T.motivo, confirmar: T.confirmar === true };
      if (T.acao === "segunda") { corpo.identidade_conferida = T.identidade === true; corpo.encerrar_sessoes = T.encerrar === true; }
      if (T.acao === "conceder") { corpo.produto = T.produto; corpo.plano = T.plano; }
      if (T.acao === "encerrar") corpo.id = T.id;
      var rota = { sessoes: "sessoes", segunda: "segunda-etapa", conceder: "conceder", encerrar: "encerrar-concedida" }[T.acao];
      A.pedir("POST", "/api/admin/contas/" + rota, corpo).then(function (d) {
        if (S.acao !== T) return;
        A.modal.fechar();
        A.toast(T.acao === "conceder" ? "Assinatura concedida (R$ 0,00/mês) · em dia até " + U.ddmmaaaa(d.direito.ate) : T.acao === "encerrar" ? "Assinatura concedida encerrada"
          : T.acao === "sessoes" ? "Sessões encerradas (" + d.encerradas + ")" : "Verificação desligada" + (d.encerradas ? " · " + d.encerradas + " sessões encerradas" : ""));
        abrir(email);
      }, function (er) {
        if (S.acao !== T) return;
        T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
    }
  });
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    if (el.id === "ct-q") { S.q = el.value; return; }
    var k = el.getAttribute("data-ct-in");
    if (!k || !S.acao) return;
    S.acao[k] = el.type === "checkbox" ? el.checked : el.value;
    // O produto muda a lista de planos (e o plano, o texto da confirmacao): a janela inteira de novo.
    if (k === "produto" || k === "plano") { if (k === "produto") S.acao.plano = ""; A.modal.repintar(); return; }
    // O botao so destrava com tudo preenchido: so ele muda (o campo de texto nao perde o foco).
    var ok = document.querySelector('#admin-camada [data-ct="ok"]');
    if (ok) ok.disabled = bloqueado(S.acao);
  });

  A.secoes.push({
    id: "contas-atos", nome: "Contas Atos", grupo: "Atos", area: "atos", ordem: 28,
    desenhar: function (raiz) { S.raiz = raiz; pintar(); },
  });
})();
