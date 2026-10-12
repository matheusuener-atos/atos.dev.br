/* O painel da Atos, grupo Atos, secao Contas Atos: o atendimento (o servidor e worker/admin-contas.js). Area "atos".
   Ver: todos os papeis. Agir: so o dono, com o motivo, a confirmacao aqui e o registro da equipe; nunca na propria conta.

     GET  /api/admin/contas?q=                 a busca (o e-mail, o endereco @atos.dev.br, os e-mails que comecam assim)
     GET  /api/admin/contas/ver?email=         a conta: como entra, o resumo da seguranca (sem segredos), os acessos,
                                               as sessoes, o Workspace e o registro da equipe
     POST /api/admin/contas/sessoes            {email, motivo, confirmar: true}
     POST /api/admin/contas/segunda-etapa      {email, motivo, confirmar: true, identidade_conferida: true, encerrar_sessoes} */
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

    h += '<h2 class="titulo-secao pv-h2"><span>Ações</span></h2>';
    if (c.propria) return h + '<div class="card"><p class="vazio">Esta é a sua conta: mude a segurança dela em Minha conta › Segurança.</p></div>';
    if (!dono()) return h + '<div class="card"><p class="vazio">Encerrar as sessões e desligar a verificação em duas etapas são só do dono.</p></div>';
    return h + '<div class="card">' +
      '<div class="excluir"><span>Encerrar todas as sessões abertas desta conta (a pessoa entra de novo; recebe um aviso no e-mail, sem link).</span><button type="button" class="btn p perigo" data-ct="sessoes">Encerrar as sessões</button></div>' +
      '<div class="excluir"><span>Desligar a verificação em duas etapas e remover as chaves de acesso: o atendimento de quem perdeu o aplicativo, os códigos e as chaves.</span><button type="button" class="btn p perigo" data-ct="segunda"' + (s.ativa || s.recuperacao ? "" : ' disabled title="a verificação já está desligada"') + ">Desligar a verificação</button></div>" +
      "</div>";
  }

  function modal() {
    var T = S.acao, c = S.conta && S.conta.conta;
    if (!T || !c) return "";
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
    if (a === "ok") {
      var T = S.acao, email = S.email; if (!T || T.enviando || !email) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      var corpo = { email: email, motivo: T.motivo, confirmar: T.confirmar === true };
      if (T.acao === "segunda") { corpo.identidade_conferida = T.identidade === true; corpo.encerrar_sessoes = T.encerrar === true; }
      A.pedir("POST", "/api/admin/contas/" + (T.acao === "sessoes" ? "sessoes" : "segunda-etapa"), corpo).then(function (d) {
        if (S.acao !== T) return;
        A.modal.fechar();
        A.toast(T.acao === "sessoes" ? "Sessões encerradas (" + d.encerradas + ")" : "Verificação desligada" + (d.encerradas ? " · " + d.encerradas + " sessões encerradas" : ""));
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
    // O botao so destrava com tudo preenchido: so ele muda (o campo de texto nao perde o foco).
    var ok = document.querySelector('#admin-camada [data-ct="ok"]'), T = S.acao;
    if (ok) ok.disabled = T.enviando || !T.confirmar || (T.acao === "segunda" && !T.identidade) || T.motivo.trim().length < 5;
  });

  A.secoes.push({
    id: "contas-atos", nome: "Contas Atos", grupo: "Atos", area: "atos", ordem: 28,
    desenhar: function (raiz) { S.raiz = raiz; pintar(); },
  });
})();
