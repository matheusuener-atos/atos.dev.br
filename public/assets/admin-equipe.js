/* O painel da Atos, secao Equipe: quem entra no painel e com que papel. Porte da tela 12 do painel do PAVLVS
   (site/assets/admin.js do coryphaeus); a equipe agora e da Atos, em /api/admin/equipe (as mesmas formas de
   resposta do contrato do PAVLVS):

     GET  /api/admin/equipe                              {membros: [{email, nome, papel, ultimo, convite?}], matriz}
     POST /api/admin/equipe/convite/:email/reenviar      o e-mail de aviso de novo -> a equipe
     GET  /api/admin/pavlvs/papeis                       {matriz}: o que cada papel faz no PAVLVS

   Incluir, mudar o papel, tirar da equipe e cancelar um convite mudam quem entra: vao para a fila da Atos
   (AdminAtos.fila; tipos equipe.membro e equipe.papel) e valem em "Commitar e pushar". So o papel Dono muda a
   equipe. Convidar e o nome, o e-mail e o papel: publicado, a pessoa entra com a Conta Atos daquele
   e-mail; nao ha aceite. */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var BASE = "/api/admin/equipe";
  var esc = A.esc, U = A.util;
  var PAPEIS = [["dono", "Dono"], ["financeiro", "Financeiro"], ["suporte", "Suporte"]];
  var S = { raiz: null, dados: null, erro: "", carregando: false, conv: null, excluir: null, papeisPv: null };

  function F() { return A.fila; }
  function podeMudar() { return Boolean(F() && F().pode("equipe.membro")); }
  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }
  function carregar() {
    S.carregando = true;
    A.pedir("GET", BASE).then(function (d) { S.dados = d; S.erro = ""; }, function (e) { if (e.status !== 401) S.erro = e.message; })
      .then(function () { S.carregando = false; pintar(); });
    // A matriz do PAVLVS (quem pode o que la): se nao vier, a tela so mostra a da Atos.
    A.pedir("GET", "/api/admin/pavlvs/papeis").then(function (d) { S.papeisPv = d.matriz || []; pintar(); }, function () { S.papeisPv = null; });
  }
  A.aoEntrar(function () { if (F()) F().ouvir(function () { if (A.secaoAtual() === "equipe") pintar(); }); });

  function opcoesPapel(nome, ativo, travado) {
    return '<div class="opcoes" role="group" aria-label="Papel">' + PAPEIS.map(function (p) {
      return '<button type="button" data-eq="' + nome + '" data-v="' + p[0] + '" aria-pressed="' + (p[0] === ativo) + '"' + (travado ? " disabled" : "") + ">" + p[1] + "</button>";
    }).join("") + "</div>";
  }

  function tela() {
    var h = "<h1>Equipe</h1><p class=\"descricao\">Quem entra neste painel, com a Conta Atos do e-mail da equipe. O papel decide o que cada um vê e faz aqui dentro.</p>";
    if (!S.dados) return h + '<div class="card pv-topo"><p class="vazio">' + (S.erro ? "Não consegui ler a equipe agora: " + esc(S.erro) + ' <button type="button" class="link" data-eq="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    if (S.erro) h += '<p class="nf-aviso"><span>Não consegui atualizar a equipe agora: ' + esc(S.erro) + ". Mostrando a última leitura.</span></p>";
    var d = S.dados, pode = podeMudar(), fila = F();
    h += '<h2 class="titulo-secao pv-h2"><span>Pessoas</span>' + (pode ? '<button type="button" class="btn p primario" data-eq="convidar">Convidar</button>' : "") + "</h2>";
    h += '<div class="card">' + (d.membros || []).map(function (m) {
      var naFila = fila && fila.naFila("equipe.membro", m.email);
      if (m.convite) {
        var venc = m.convite.vence ? new Date(m.convite.vence) : null, vencido = m.convite.vencido || (venc && venc < new Date());
        return '<div class="item eq-item"><span class="nome"><strong>' + esc(m.nome || m.email) + ' <span class="nf-tag">' + (vencido ? "convite vencido" : "ainda não entrou") + "</span></strong>" +
          "<small>" + esc(m.email) + " · " + esc(U.PAPEL_NOME[m.papel] || m.papel) + " · incluída " + esc(U.ddmm(m.convite.criado)) + (venc ? " · " + (vencido ? "venceu " : "vence ") + esc(U.ddmm(venc.toISOString())) : "") +
          (naFila ? ' · <span class="pv-atencao">na fila</span>' : "") + "</small></span>" +
          (pode ? '<span class="pv-par"><button type="button" class="btn mini" data-eq="reenviar" data-email="' + esc(m.email) + '">Reenviar o aviso</button>' +
            '<button type="button" class="btn mini perigo" data-eq="excluir" data-email="' + esc(m.email) + '"' + (naFila ? ' disabled title="já está na fila de alterações"' : "") + ">Cancelar convite</button></span>" : "") + "</div>";
      }
      var p = fila && fila.ultima("equipe.papel", m.email), papel = p && p.dados ? p.dados.papel : m.papel;
      return '<div class="item eq-item"><span class="nome"><strong>' + esc(m.nome || m.email) + "</strong><small>" + esc(m.email) + " · último acesso " + esc(m.ultimo ? U.quando(m.ultimo) : "nunca") +
        (p || naFila ? ' · <span class="pv-atencao">na fila</span>' : "") + "</small></span>" +
        '<span class="pv-par">' + opcoesPapel("papel:" + m.email, papel, !pode) +
        (pode ? '<button type="button" class="btn mini perigo" data-eq="excluir" data-email="' + esc(m.email) + '"' + (naFila ? ' disabled title="já está na fila de alterações"' : "") + ">Tirar</button>" : "") + "</span></div>";
    }).join("") + ((d.membros || []).length ? "" : '<p class="vazio">Ninguém na equipe.</p>') + "</div>";
    if (!pode) h += '<p class="nota">Só o papel Dono muda a equipe.</p>';
    var marca = function (v) { return '<span class="' + (v ? "pv-ok" : "pv-mudo") + '">' + (v ? "sim" : "—") + "</span>"; };
    var matriz = function (titulo, mz) {
      return mz && mz.length ? '<h2 class="titulo-secao pv-h2"><span>' + titulo + '</span></h2><div class="card pv-tabela"><div>' +
        '<div class="pv-tr pv-th pv-c-matriz"><span>Ação</span><span>Dono</span><span>Financeiro</span><span>Suporte</span></div>' +
        mz.map(function (x) { return '<div class="pv-tr pv-c-matriz"><span>' + esc(x.acao) + "</span>" + marca(x.dono) + marca(x.financeiro) + marca(x.suporte) + "</div>"; }).join("") + "</div></div>" : "";
    };
    return h + matriz("O que cada papel faz na Atos", d.matriz) + matriz("O que cada papel faz no PAVLVS", S.papeisPv);
  }

  /* ------------------------------------------------------------ os pop-ups */
  function modalConvite() {
    var C = S.conv;
    return '<h2 id="modal-titulo">Convidar para a equipe</h2>' +
      "<p>Entra na fila e vale quando você confirmar as alterações. Publicado, a pessoa já está na equipe e entra no painel com a Conta Atos deste e-mail (quem não tem cria em atos.dev.br/entrar, com o mesmo e-mail); vai um e-mail de aviso para ela.</p>" +
      '<label class="campo"><span class="rotulo">Nome</span><input id="eq-nome" data-eq-in="nome" value="' + esc(C.nome) + '" autocomplete="off"></label>' +
      '<label class="campo"><span class="rotulo">E-mail</span><input id="eq-email" type="email" data-eq-in="email" value="' + esc(C.email) + '" autocomplete="off" spellcheck="false"' + (C.erro ? ' aria-invalid="true"' : "") + "></label>" +
      '<div class="campo"><span class="rotulo">Papel</span>' + opcoesPapel("conv-papel", C.papel, false) + "</div>" +
      (C.erro ? '<p class="erro" role="alert">' + esc(C.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button><button type="button" class="btn p primario" data-eq="convidar-ok">Pôr na fila</button></div>';
  }
  function modalExcluir() {
    var X = S.excluir;
    return '<h2 id="modal-titulo">' + (X.convite ? "Cancelar convite" : "Tirar da equipe") + "</h2>" +
      "<p>" + (X.convite ? esc(X.email) + " sai da equipe antes de entrar." : esc(X.nome || X.email) + " (" + esc(X.email) + ") perde o acesso a este painel.") +
      " Entra na fila e vale quando você confirmar as alterações.</p>" +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-eq="excluir-ok" data-foco>' + (X.convite ? "Cancelar convite" : "Tirar da equipe") + "</button></div>";
  }
  function membro(email) { return ((S.dados || {}).membros || []).filter(function (m) { return m.email === email; })[0]; }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-eq]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-eq"), fila = F();
    if (a === "recarregar") { carregar(); pintar(); return; }
    if (a === "convidar") { S.conv = { nome: "", email: "", papel: "suporte", erro: "" }; A.modal.abrir({ html: modalConvite, aoFechar: function () { S.conv = null; } }); return; }
    if (a === "conv-papel") { if (S.conv) { S.conv.papel = b.getAttribute("data-v"); A.modal.repintar(); } return; }
    if (a === "convidar-ok") {
      var C = S.conv, email = C.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { C.erro = "confira o e-mail"; A.modal.repintar(); return; }
      if (membro(email)) { C.erro = "esse e-mail já está na equipe"; A.modal.repintar(); return; }
      if (C.nome.trim().length < 2) { C.erro = "diga o nome da pessoa"; A.modal.repintar(); return; }
      A.modal.fechar();
      fila.enfileirar("equipe", "equipe.membro", email, { acao: "criar", nome: C.nome.trim(), email: email, papel: C.papel }, "Incluí " + (C.nome.trim() || email) + " (" + email + ") como " + U.PAPEL_NOME[C.papel]);
      return;
    }
    if (a.indexOf("papel:") === 0) {
      var em = a.slice(6), m = membro(em), v = b.getAttribute("data-v");
      if (!m) return;
      var p = fila.ultima("equipe.papel", em), atual = p && p.dados ? p.dados.papel : m.papel;
      if (atual !== v) fila.enfileirar("equipe", "equipe.papel", em, { email: em, papel: v }, "Mudei " + (m.nome || em) + " para " + U.PAPEL_NOME[v]);
      return;
    }
    if (a === "excluir") {
      var x = membro(b.getAttribute("data-email"));
      if (!x) return;
      S.excluir = { email: x.email, nome: x.nome, convite: Boolean(x.convite) };
      A.modal.abrir({ html: modalExcluir, aoFechar: function () { S.excluir = null; } });
      return;
    }
    if (a === "excluir-ok") {
      var X = S.excluir;
      A.modal.fechar();
      fila.enfileirar("equipe", "equipe.membro", X.email, { acao: X.convite ? "cancelar_convite" : "excluir", email: X.email },
        X.convite ? "Cancelei o convite de " + (X.nome || X.email) : "Tirei " + (X.nome || X.email) + " da equipe");
      return;
    }
    if (a === "reenviar") {
      b.disabled = true;
      A.pedir("POST", BASE + "/convite/" + encodeURIComponent(b.getAttribute("data-email")) + "/reenviar", {}).then(function (d) {
        if (d && d.membros) S.dados = d;
        A.toast("Aviso reenviado");
        pintar();
      }, function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
    }
  });
  document.addEventListener("input", function (e) {
    var el = e.target.closest("[data-eq-in]");
    if (el && S.conv && el.getAttribute("data-eq-in") === "nome") { S.conv.nome = el.value; return; }
    if (el && S.conv) { S.conv.email = el.value; if (S.conv.erro) { S.conv.erro = ""; el.removeAttribute("aria-invalid"); var er = el.closest(".modal").querySelector(".erro"); if (er) er.remove(); } }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.id === "eq-email") { e.preventDefault(); var b = document.querySelector('[data-eq="convidar-ok"]'); if (b) b.click(); }
  });

  A.secoes.push({
    id: "equipe",
    nome: "Equipe",
    grupo: "Atos",
    ordem: 20,
    desenhar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.carregando) carregar();
    },
  });
})();
