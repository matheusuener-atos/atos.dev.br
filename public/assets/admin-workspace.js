/* O painel da Atos, grupo Atos Workspace: Visao geral e Contas do Workspace (o servidor e worker/admin-workspace.js).
   Area "atos"; ver: todos os papeis; suspender e reativar um Workspace: dono e suporte (o servidor confere de novo).
   O E-mail Atos (admin-email.js) e os Aplicativos de terceiros (admin-apps.js) sao as outras secoes do grupo; daqui se
   chega a elas pelos atalhos (A.atalhos.alias, A.atalhos.app). Tambem poe na busca do painel (Ctrl K) as contas, os
   enderecos, os aplicativos e os Workspaces (GET /api/admin/busca; worker/admin-contas.js).

     GET  /api/admin/workspace                       a visao geral
     GET  /api/admin/workspace/contas                as contas do indice
     GET  /api/admin/workspace/contas/:sub           uma conta
     POST /api/admin/workspace/contas/:sub/suspender {motivo, desligar_apps, suspender_alias}
     POST /api/admin/workspace/contas/:sub/reativar  {ligar_apps, reativar_alias, motivo?} */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var G = { raiz: null, dados: null, erro: "", carregando: false };
  var C = { raiz: null, lista: null, erro: "", carregando: false, q: "", aberta: "", conta: null, erroConta: "", acao: null };
  var ESTADO = { ativo: ["ativo", "ok"], suspenso: ["suspenso pela Atos", "perigo"], desativado: ["desativado", ""], nunca: ["nunca ativou", ""] };

  function papel() { return A.quem ? A.quem.papel : ""; }
  function podeAgir() { return papel() === "dono" || papel() === "suporte"; }
  function sit(estado) { var e = ESTADO[estado] || [estado, ""]; return '<span class="pv-sit ' + e[1] + '">' + esc(e[0]) + "</span>"; }
  function versao(v) { var m = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/.exec(String(v || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] + (m[4] ? ", rev. " + m[4] : "") : String(v || "—"); }
  function plural(n, um, varios) { return n + " " + (n === 1 ? um : varios); }
  function kpi(t, v, sub, tom) { return '<div><span class="rotulo">' + esc(t) + '</span><strong class="pv-kpi' + (tom ? " pv-" + tom : "") + '">' + esc(v) + "</strong><small>" + esc(sub) + "</small></div>"; }
  function registroHtml(l) {
    if (!l || !l.length) return '<p class="vazio">Nada no registro ainda.</p>';
    return '<ul class="nf-passos pv-hist">' + l.map(function (x) {
      return "<li><span>" + esc(U.quando(x.quando)) + "</span><span>" + esc(x.por) + ": " + esc(x.oque) + (x.motivo ? " — motivo: " + esc(x.motivo) : "") + "</span><span></span></li>";
    }).join("") + "</ul>";
  }

  /* ================================================================ Visao geral */
  function pintarGeral() { if (G.raiz && document.body.contains(G.raiz)) G.raiz.innerHTML = telaGeral(); }
  function carregarGeral() {
    G.carregando = true;
    A.pedir("GET", "/api/admin/workspace").then(function (d) { G.dados = d; G.erro = ""; }, function (e) { if (e.status !== 401) G.erro = e.message; })
      .then(function () { G.carregando = false; pintarGeral(); });
  }
  function telaGeral() {
    var h = "<h1>Atos Workspace</h1>" +
      '<p class="descricao">Quem ativou o Workspace, os endereços @atos.dev.br e os aplicativos que as pessoas cadastram, e o que precisa de atenção.</p>';
    var D = G.dados;
    if (!D) return h + '<div class="card"><p class="vazio">' + (G.erro ? esc(G.erro) + ' <button type="button" class="link" data-ws-adm="recarregar-geral">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    var n = D.numeros, w = n.workspaces, e = n.enderecos, ap = n.apps, v = n.vagas;
    h += '<div class="card pv-topo"><div class="colunas pv-kpis">' +
      kpi("Workspaces ativos", String(w.ativos), plural(w.suspensos, "suspenso", "suspensos") + " · " + plural(w.desativados, "desativado", "desativados") + (w.termos_antigos ? " · " + w.termos_antigos + " com termos antigos" : ""), w.suspensos ? "perigo" : "") +
      kpi("Endereços Atos", String(e.total), e.encaminhando + " encaminhando · " + plural(e.desligados, "desligado", "desligados") + " · " + plural(e.suspensos, "suspenso", "suspensos") + " · " + e.sem_destino + " sem destino confirmado") +
      kpi("Aplicativos de terceiros", String(ap.total), plural(ap.acessos, "acesso", "acessos") + " (" + ap.acessos_ligados + " ligados) · " + plural(ap.desligados, "desligado", "desligados") + " pela Atos · " + plural(ap.donos, "dono", "donos")) +
      kpi("Vagas de destino", v.usadas + " de " + v.limite, "na Cloudflare: " + (v.na_cf == null ? "não deu para consultar" : v.na_cf) + " de " + v.teto_cf + " (contando os do dono)", v.usadas >= v.limite ? "perigo" : "") +
      "</div></div>";
    if (!D.disponivel) h += '<p class="nf-aviso"><span>O e-mail Atos está desligado neste Worker (falta o segredo CF_EMAIL_TOKEN ou o CF_ACCOUNT_ID): ninguém reserva nem muda um endereço.</span></p>';
    else if (D.simulada) h += '<p class="nota">Neste Worker a Cloudflare do e-mail Atos é simulada.</p>';

    var at = D.atencao, itens = [];
    at.workspaces.forEach(function (x) {
      itens.push('<div class="item oa-item"><span class="nome"><strong>Workspace de ' + esc(x.email || x.sub) + " " + sit("suspenso") + "</strong><small>" + esc(U.quando(x.suspenso.quando)) + " por " + esc(x.suspenso.por || "") + (x.suspenso.motivo ? ": " + esc(x.suspenso.motivo) : "") + "</small></span>" +
        '<span class="pv-par"><button type="button" class="btn mini" data-ws-adm="abrir" data-sub="' + esc(x.sub) + '">Abrir a conta</button></span></div>');
    });
    at.enderecos.forEach(function (x) {
      itens.push('<div class="item oa-item"><span class="nome"><strong>' + esc(x.endereco) + ' <span class="pv-sit perigo">endereço suspenso</span></strong><small>de ' + esc(x.conta) + " · " + esc(U.quando(x.suspenso.quando)) + (x.suspenso.motivo ? ": " + esc(x.suspenso.motivo) : "") + "</small></span>" +
        '<span class="pv-par"><button type="button" class="btn mini" data-ws-adm="alias" data-id="' + esc(x.alias) + '">Abrir em E-mail Atos</button></span></div>');
    });
    at.apps.forEach(function (x) {
      itens.push('<div class="item oa-item"><span class="nome"><strong>' + esc(x.nome) + ' <span class="nf-tag">' + esc(x.id) + '</span> <span class="pv-sit perigo">aplicativo desligado</span></strong><small>de ' + esc(x.dono) + " · " + esc(U.quando(x.bloqueado.quando)) + (x.bloqueado.motivo ? ": " + esc(x.bloqueado.motivo) : "") + "</small></span>" +
        '<span class="pv-par"><button type="button" class="btn mini" data-ws-adm="app" data-id="' + esc(x.id) + '">Abrir em Aplicativos</button></span></div>');
    });
    h += '<h2 class="titulo-secao pv-h2"><span>Precisa de atenção</span></h2><div class="card">' + (itens.length ? itens.join("") : '<p class="vazio">Nada suspenso nem desligado agora.</p>') + "</div>" +
      '<p class="nota">Denúncias: a Atos ainda não recebe denúncias pelo sistema. Elas chegam por contato@atos.dev.br (os termos dizem isso); daqui a equipe age na conta, no endereço ou no aplicativo.</p>';

    var vr = D.indice.varredura || {};
    h += '<h2 class="titulo-secao pv-h2"><span>O índice</span></h2><div class="card"><div class="nf-det"><dl class="nf-info">' +
      "<dt>Contas no índice</dt><dd>" + D.indice.contas + ' · <a href="#ws-contas" data-secao="ws-contas">ver as contas</a></dd>' +
      "<dt>Varredura das Contas Atos</dt><dd>" + (vr.completa ? "completa: " + plural(vr.conferidas || 0, "conta conferida", "contas conferidas") + (vr.quando ? " (" + esc(U.quando(vr.quando)) + ")" : "")
        : plural(vr.conferidas || 0, "conta conferida", "contas conferidas") + " até agora; continua do mesmo ponto a cada abertura desta tela") + "</dd>" +
      "</dl></div></div>" +
      '<p class="nota">A ativação de cada conta mora no registro dela (um por conta, que não se lista). O índice anota quem ativa, desativa ou é suspenso, quem abre a área do Workspace e o que a varredura acha percorrendo as Contas Atos aos poucos; quem ativou antes do índice entra por um desses caminhos.</p>';
    h += '<h2 class="titulo-secao pv-h2"><span>Registro da equipe</span></h2><div class="card">' + registroHtml(D.registro) + "</div>";
    return h;
  }

  /* ================================================================ Contas do Workspace */
  function pintarContas() { if (C.raiz && document.body.contains(C.raiz)) C.raiz.innerHTML = telaContas(); }
  function carregarLista() {
    C.carregando = true;
    A.pedir("GET", "/api/admin/workspace/contas").then(function (d) { C.lista = d; C.erro = ""; }, function (e) { if (e.status !== 401) C.erro = e.message; })
      .then(function () { C.carregando = false; pintarContas(); });
  }
  function carregarConta(sub) {
    C.aberta = sub; C.conta = null; C.erroConta = "";
    A.pedir("GET", "/api/admin/workspace/contas/" + encodeURIComponent(sub)).then(function (d) { if (C.aberta === sub) C.conta = d; },
      function (e) { if (C.aberta === sub && e.status !== 401) C.erroConta = e.message; }).then(pintarContas);
  }
  A.atalhos = A.atalhos || {};
  A.atalhos.contaWs = function (sub) { if (!sub) return; carregarConta(sub); A.navegar("ws-contas"); };

  function filtradas() {
    var l = (C.lista && C.lista.contas) || [], q = U.norm(C.q.trim());
    if (!q) return l;
    return l.filter(function (x) { return U.norm([x.email, x.sub, x.alias ? x.alias.endereco : ""].join(" ")).indexOf(q) >= 0; });
  }
  function listaHtml() {
    var l = filtradas(), atuais = C.lista.termos_atuais;
    if (!l.length) return '<p class="vazio">' + (C.q.trim() ? "Nenhuma conta com esse texto." : "Ninguém no índice ainda. A visão geral faz a varredura das Contas Atos.") + "</p>";
    return l.map(function (x) {
      var al = x.alias ? esc(x.alias.endereco) + (x.alias.suspenso ? " (suspenso)" : x.alias.estado === "ligado" ? " (encaminhando)" : " (desligado)") : "sem endereço Atos";
      var t = x.termos ? "termos de " + esc(versao(x.termos.versao)) + (x.termos.versao !== atuais ? " (antigos)" : "") : "sem termos";
      return '<div class="item oa-item"><span class="nome"><strong>' + esc(x.email || x.sub) + " " + sit(x.estado) + "</strong>" +
        "<small>" + al + " · ativado em " + esc(U.ddmmaaaa(x.ativado)) + " · " + t + " · " + plural(x.apps, "aplicativo", "aplicativos") + "</small></span>" +
        '<span class="pv-par"><button type="button" class="btn mini" data-ws-adm="abrir" data-sub="' + esc(x.sub) + '">Abrir</button></span></div>';
    }).join("");
  }
  function telaContas() {
    var h = "<h1>Contas do Workspace</h1>";
    if (C.aberta) return h + contaHtml();
    h += '<p class="descricao">As contas que ativaram o Atos Workspace (o índice), com o endereço Atos e os aplicativos de cada uma. Abra uma conta para ver tudo dela e agir.</p>';
    if (!C.lista) return h + '<div class="card"><p class="vazio">' + (C.erro ? esc(C.erro) + ' <button type="button" class="link" data-ws-adm="recarregar-lista">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    h += '<div class="pv-barra-filtros ws-barra"><input class="seletor pv-busca-campo" id="ws-contas-q" value="' + esc(C.q) + '" placeholder="e-mail ou endereço @atos.dev.br" aria-label="Buscar contas do Workspace" autocomplete="off" spellcheck="false">' +
      '<span class="pv-mudo">' + plural(C.lista.total, "conta", "contas") + " no índice</span></div>";
    return h + '<div class="card" id="ws-contas-lista">' + listaHtml() + "</div>";
  }

  function contaHtml() {
    var h = '<p><button type="button" class="link" data-ws-adm="voltar">‹ Voltar às contas</button></p>';
    var D = C.conta;
    if (!D) return h + '<div class="card"><p class="vazio">' + (C.erroConta ? esc(C.erroConta) : "Carregando…") + "</p></div>";
    var W = D.workspace, al = D.alias;
    h += '<h2 class="titulo-secao pv-h2"><span>' + esc(D.conta.email || D.conta.sub) + " " + sit(W.estado) + "</span>" +
      (podeAgir() ? (W.suspenso ? '<button type="button" class="btn p" data-ws-adm="reativar">Tirar a suspensão</button>' : '<button type="button" class="btn p perigo" data-ws-adm="suspender">Suspender o Workspace</button>') : "") + "</h2>";
    if (W.suspenso) {
      h += '<p class="nf-aviso"><span>Suspenso em ' + esc(U.quando(W.suspenso.quando)) + " por " + esc(W.suspenso.por) + (W.suspenso.motivo ? ": " + esc(W.suspenso.motivo) : "") +
        ". A pessoa vê o motivo; a gestão (Integrações e e-mail Atos) está parada." + (W.suspenso.apps.length ? " A suspensão desligou " + esc(W.suspenso.apps.join(", ")) + "." : "") +
        (W.suspenso.alias ? " Suspendeu o endereço " + esc(W.suspenso.alias) + "@atos.dev.br." : "") + "</span></p>";
    }
    h += '<div class="card"><div class="nf-det"><dl class="nf-info">' +
      "<dt>Conta</dt><dd>" + esc(D.conta.email) + " <small>(" + esc(D.conta.sub) + ')</small> <button type="button" class="link" data-ws-adm="conta-atos" data-email="' + esc(D.conta.email) + '">Ver em Contas Atos</button></dd>' +
      "<dt>Ativado em</dt><dd>" + esc(U.quando(W.ativado)) + (W.desativado ? " · desativado em " + esc(U.quando(W.desativado)) : "") + "</dd>" +
      "<dt>Termos aceitos</dt><dd>" + (W.termos ? "versão de " + esc(versao(W.termos.versao)) + ", em " + esc(U.quando(W.termos.aceito)) + (W.termos.versao !== W.termos_atuais ? " (a atual é " + esc(versao(W.termos_atuais)) + ")" : "") : "—") + "</dd>" +
      "<dt>Histórico</dt><dd>" + ((W.historico || []).map(function (x) { return esc(U.quando(x.quando)) + " · " + esc(x.oque) + (x.por ? " (" + esc(x.por) + ")" : ""); }).join("<br>") || "—") + "</dd>" +
      "</dl></div></div>";

    h += '<h2 class="titulo-secao pv-h2"><span>Endereço Atos</span>' + (al ? '<button type="button" class="btn p" data-ws-adm="alias" data-id="' + esc(al.alias) + '">Abrir em E-mail Atos</button>' : "") + "</h2>";
    if (!al) h += '<div class="card"><p class="vazio">Esta conta não tem endereço @atos.dev.br.</p></div>';
    else {
      h += '<div class="card"><div class="nf-det"><dl class="nf-info">' +
        "<dt>Endereço</dt><dd>" + esc(al.endereco) + " " + (al.suspenso ? '<span class="pv-sit perigo">suspenso</span>' : al.estado === "ligado" ? '<span class="pv-sit ok">encaminhando</span>' : '<span class="pv-sit">desligado</span>') + "</dd>" +
        "<dt>Destino</dt><dd>" + (al.destino ? esc(al.destino.mascarado) + " · código " + (al.destino.codigo_ok ? "confirmado" : "pendente") + " · Cloudflare " + (al.destino.cf_ok ? "verificado" : "pendente") : "—") + "</dd>" +
        (al.suspenso ? "<dt>Suspenso</dt><dd>" + esc(U.quando(al.suspenso.quando)) + " por " + esc(al.suspenso.por) + (al.suspenso.motivo ? ": " + esc(al.suspenso.motivo) : "") + "</dd>" : "") +
        "<dt>Criado</dt><dd>" + esc(U.quando(al.criado)) + "</dd>" +
        "<dt>Registro</dt><dd>" + ((D.alias_mudancas || []).map(function (x) { return esc(U.quando(x.quando)) + " · " + esc(x.por || "") + ": " + esc(x.oque); }).join("<br>") || "—") + "</dd>" +
        "</dl></div></div>";
    }

    h += '<h2 class="titulo-secao pv-h2"><span>Aplicativos (' + D.apps.length + ")</span></h2>";
    h += '<div class="card">' + (D.apps.length ? D.apps.map(function (a) {
      var lig = a.acessos.filter(function (x) { return x.ativo; }).length;
      var quem = a.acesso === "todos" ? "qualquer Conta Atos" : "só liberados (" + plural(a.liberados, "pessoa", "pessoas") + " na lista, e o dono)";
      return '<div class="item oa-item"><span class="nome"><strong>' + esc(a.nome) + ' <span class="nf-tag">' + esc(a.id) + "</span> " + (a.bloqueado ? '<span class="pv-sit perigo">desligado pela Atos</span>' : '<span class="pv-sit ok">no ar</span>') + "</strong>" +
        "<small>quem entra: " + esc(quem) + " · " + plural(a.acessos.length, "acesso", "acessos") + " (" + lig + " ligados)" + (a.bloqueado && a.bloqueado.motivo ? " · motivo: " + esc(a.bloqueado.motivo) : "") + "</small></span>" +
        '<span class="pv-par"><button type="button" class="btn mini" data-ws-adm="app" data-id="' + esc(a.id) + '">Abrir em Aplicativos</button></span></div>';
    }).join("") : '<p class="vazio">Nenhum aplicativo cadastrado.</p>') + "</div>";

    h += '<h2 class="titulo-secao pv-h2"><span>Registro da equipe nesta conta</span></h2><div class="card">' + registroHtml(D.registro) + "</div>";
    if (!podeAgir()) h += '<p class="nota">Suspender e tirar a suspensão são do dono e do suporte.</p>';
    return h;
  }

  /* ---------- os pop-ups de suspender e reativar */
  function modal() {
    var T = C.acao, D = C.conta;
    if (!T || !D) return "";
    var ligados = D.apps.filter(function (a) { return !a.bloqueado; }), al = D.alias;
    var marcar = function (k, texto, desligado) {
      return '<label class="nf-marcar oa-marcar"><input type="checkbox" data-ws-adm-in="' + k + '"' + (T[k] ? " checked" : "") + (desligado ? " disabled" : "") + "><span>" + texto + "</span></label>";
    };
    var corpo;
    if (T.acao === "suspender") {
      corpo = '<h2 id="modal-titulo">Suspender o Atos Workspace de ' + esc(D.conta.email) + "</h2>" +
        "<p>A pessoa deixa de cadastrar, ver e mudar sistemas em Integrações e de mudar o e-mail Atos, na hora, e vê o motivo na área dela. Ativar de novo não tira a suspensão.</p>" +
        '<label class="campo"><span class="rotulo">Motivo (a pessoa vê)</span><input data-ws-adm-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo) + '" data-foco></label>' +
        marcar("desligar_apps", ligados.length ? "Desligar também " + (ligados.length === 1 ? "o aplicativo ligado (" + esc(ligados[0].nome) + "): ninguém mais entra nele" : "os " + ligados.length + " aplicativos ligados: ninguém mais entra neles") : "Desligar os aplicativos (nenhum ligado agora)", !ligados.length) +
        marcar("suspender_alias", al && !al.suspenso ? "Suspender também " + esc(al.endereco) + ": as mensagens passam a ser recusadas e ele deixa de entrar na conta" : "Suspender o endereço Atos (" + (al ? "já suspenso" : "não tem") + ")", !(al && !al.suspenso)) +
        '<p class="dica">O que não for marcado continua como está. O reativar oferece desfazer exatamente o que for marcado aqui.</p>';
    } else {
      var S = D.workspace.suspenso || { apps: [], alias: "" };
      corpo = '<h2 id="modal-titulo">Tirar a suspensão do Workspace de ' + esc(D.conta.email) + "</h2>" +
        "<p>A pessoa volta a gerir Integrações e o e-mail Atos na hora.</p>" +
        marcar("ligar_apps", S.apps.length ? "Ligar de novo o que a suspensão desligou (" + esc(S.apps.join(", ")) + ")" : "Ligar os aplicativos (a suspensão não desligou nenhum)", !S.apps.length) +
        marcar("reativar_alias", S.alias ? "Tirar a suspensão de " + esc(S.alias) + "@atos.dev.br (o encaminhamento continua desligado até a pessoa ligar)" : "Reativar o endereço (a suspensão não o suspendeu)", !S.alias) +
        '<label class="campo"><span class="rotulo">Observação (opcional, fica no registro)</span><input data-ws-adm-in="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo) + '"></label>';
    }
    return corpo + (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p ' + (T.acao === "suspender" ? "perigo" : "primario") + '" data-ws-adm="ok"' + (T.enviando ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : T.acao === "suspender" ? "Suspender" : "Tirar a suspensão") + "</button></div>";
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-ws-adm]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-ws-adm");
    if (a === "recarregar-geral") { carregarGeral(); pintarGeral(); return; }
    if (a === "recarregar-lista") { carregarLista(); pintarContas(); return; }
    if (a === "abrir") { A.atalhos.contaWs(b.getAttribute("data-sub")); return; }
    if (a === "voltar") { C.aberta = ""; C.conta = null; carregarLista(); pintarContas(); return; }
    if (a === "alias") { if (A.atalhos.alias) A.atalhos.alias(b.getAttribute("data-id")); return; }
    if (a === "app") { if (A.atalhos.app) A.atalhos.app(b.getAttribute("data-id")); return; }
    if (a === "conta-atos") { if (A.atalhos.conta) A.atalhos.conta(b.getAttribute("data-email")); return; }
    if (a === "suspender" || a === "reativar") {
      C.acao = { acao: a, motivo: "", desligar_apps: false, suspender_alias: false, ligar_apps: false, reativar_alias: false, erro: "", enviando: false };
      A.modal.abrir({ html: modal, aoFechar: function () { C.acao = null; } }); return;
    }
    if (a === "ok") {
      var T = C.acao, sub = C.aberta; if (!T || T.enviando || !sub) return;
      if (T.acao === "suspender" && T.motivo.trim().length < 3) { T.erro = "diga o motivo (a pessoa vê)"; A.modal.repintar(); return; }
      T.enviando = true; T.erro = ""; A.modal.repintar();
      var corpo = T.acao === "suspender" ? { motivo: T.motivo, desligar_apps: T.desligar_apps, suspender_alias: T.suspender_alias } : { motivo: T.motivo, ligar_apps: T.ligar_apps, reativar_alias: T.reativar_alias };
      A.pedir("POST", "/api/admin/workspace/contas/" + encodeURIComponent(sub) + "/" + T.acao, corpo).then(function (d) {
        if (C.acao !== T) return;
        A.modal.fechar();
        C.conta = d; G.dados = null;
        A.toast(T.acao === "suspender" ? "Workspace suspenso" + (d.desligados && d.desligados.length ? " · " + plural(d.desligados.length, "aplicativo desligado", "aplicativos desligados") : "") + (d.alias_suspenso ? " · endereço suspenso" : "")
          : "Suspensão tirada" + (d.ligados && d.ligados.length ? " · " + plural(d.ligados.length, "aplicativo ligado", "aplicativos ligados") : "") + (d.alias_reativado ? " · endereço reativado" : ""));
        pintarContas();
      }, function (er) {
        if (C.acao !== T) return;
        T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
    }
  });
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    if (el.id === "ws-contas-q") { C.q = el.value; var l = document.getElementById("ws-contas-lista"); if (l && C.lista) l.innerHTML = listaHtml(); return; }
    var k = el.getAttribute("data-ws-adm-in");
    if (k && C.acao) C.acao[k] = el.type === "checkbox" ? el.checked : el.value;
  });

  /* ================================================================ a busca do painel (Ctrl K) */
  A.fontesDeBusca.push({
    area: "atos", nome: "Atos",
    rapidas: function () {
      return [
        { t: "Contas Atos › Buscar uma conta", d: "pelo e-mail ou pelo endereço @atos.dev.br", ir: function () { A.navegar("contas-atos"); } },
        { t: "Atos Workspace › Visão geral", d: "números e o que precisa de atenção", ir: function () { A.navegar("ws-geral"); } },
      ];
    },
    buscar: function (q) {
      return A.pedir("GET", "/api/admin/busca?q=" + encodeURIComponent(q)).then(function (r) {
        var g = [];
        var contas = (r.contas || []).map(function (x) { return { t: x.email, d: [x.nome, x.alias].filter(Boolean).join(" · ") || "Conta Atos", ir: function () { if (A.atalhos.conta) A.atalhos.conta(x.email); } }; });
        if (contas.length) g.push(["Contas Atos", contas]);
        var ws = (r.workspaces || []).map(function (x) { return { t: x.email || x.sub, d: "Atos Workspace · " + (ESTADO[x.estado] || [x.estado])[0], ir: function () { A.atalhos.contaWs(x.sub); } }; });
        if (ws.length) g.push(["Atos Workspace", ws]);
        var en = (r.enderecos || []).map(function (x) { return { t: x.endereco, d: "de " + x.conta + (x.suspenso ? " · suspenso" : x.estado === "ligado" ? " · encaminhando" : " · desligado"), ir: function () { if (A.atalhos.alias) A.atalhos.alias(x.alias); } }; });
        if (en.length) g.push(["Endereços Atos", en]);
        var ap = (r.apps || []).map(function (x) { return { t: x.nome + " (" + x.id + ")", d: "de " + x.dono + (x.bloqueado ? " · desligado pela Atos" : ""), ir: function () { if (A.atalhos.app) A.atalhos.app(x.id); } }; });
        if (ap.length) g.push(["Aplicativos de terceiros", ap]);
        return g;
      });
    },
  });

  A.secoes.push({
    id: "ws-geral", nome: "Visão geral", grupo: "Atos Workspace", area: "atos", ordem: 1,
    desenhar: function (raiz) { G.raiz = raiz; pintarGeral(); if (!G.carregando) carregarGeral(); },
  });
  A.secoes.push({
    id: "ws-contas", nome: "Contas do Workspace", grupo: "Atos Workspace", area: "atos", ordem: 2,
    desenhar: function (raiz) {
      C.raiz = raiz;
      pintarContas();
      if (!C.aberta && !C.carregando) carregarLista();
    },
  });
})();
