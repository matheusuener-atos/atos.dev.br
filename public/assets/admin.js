/* O painel da Atos (/admin/): a equipe cuida do que e da Atos e dos produtos dela. O servidor e o worker/admin.js:
   a Conta Atos com o e-mail na equipe e o login de ate 12 horas.

   Esta pagina e a casca: o acesso (entrar, entrar de novo, fora da equipe), quem esta, a navegacao em grupos e o
   que as secoes dividem (a API, os formatos, o aviso que some sozinho e a camada do pop-up). Cada secao se registra
   em AdminAtos.secoes a partir do seu proprio script (assets/admin-*.js), carregado depois deste:

     { id, nome, grupo: "Atos" | "PAVLVS", ordem, desenhar(raiz, ctx), contagem() }

   `grupo` sem valor e "Atos"; `ordem` arruma dentro do grupo (sem ela, a ordem de registro); `contagem` (opcional)
   e o numero ao lado do nome no menu (0 ou nada: sem numero). Hoje: Notas fiscais (admin-nfse.js), Equipe
   (admin-equipe.js), Confirmar alteracoes (admin-fila.js) e as do PAVLVS (admin-pavlvs.js).

   A CSP do /admin e script-src 'self'; style-src 'self': nada de estilo nem evento no HTML; tudo por classe
   (admin.css) e por delegacao de eventos. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  /* GET ou POST na API do painel: {status, dados} (ou dados.erro). */
  function api(metodo, caminho, corpo) {
    var op = { method: metodo, credentials: "same-origin", headers: {} };
    if (corpo !== undefined) { op.headers["content-type"] = "application/json"; op.body = JSON.stringify(corpo); }
    return fetch(caminho, op).then(function (r) {
      var tipo = r.headers.get("content-type") || "";
      var leitura = tipo.indexOf("json") >= 0 ? r.json().catch(function () { return {}; }) : r.text().then(function (t) { return { texto: t }; });
      return leitura.then(function (d) { return { status: r.status, dados: d || {} }; });
    }, function () { return { status: 0, dados: { erro: "sem conexão com o servidor" } }; });
  }
  /* O mesmo pedido, como promessa que falha: resolve com os dados (2xx) ou rejeita com um Error {status, dados}.
     A sessao que caiu (401) vai para a tela de acesso. */
  function pedir(metodo, caminho, corpo) {
    return api(metodo, caminho, corpo).then(function (r) {
      if (r.status >= 200 && r.status < 300) return r.dados;
      if (r.status === 401) sessaoCaiu(r);
      var e = new Error(r.dados.erro || (r.status ? "o servidor respondeu " + r.status : "sem conexão com o servidor"));
      e.status = r.status; e.dados = r.dados;
      throw e;
    });
  }

  /* ------------------------------------------------------------ os formatos que as secoes dividem */
  function pad(n) { return String(n).padStart(2, "0"); }
  function norm(t) { return String(t == null ? "" : t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function primeiro(nome) { return String(nome || "").trim().split(/\s+/)[0] || ""; }
  function dt(iso) {
    if (!iso) return null;
    var d;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { var p = iso.split("-"); d = new Date(+p[0], +p[1] - 1, +p[2]); } else d = new Date(iso);
    return isNaN(d) ? null : d;
  }
  function diasAte(d) {
    var h = new Date(), a = new Date(h.getFullYear(), h.getMonth(), h.getDate()), b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((a - b) / 864e5);
  }
  function hm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function ddmm(iso) { var d = dt(iso); return d ? pad(d.getDate()) + "/" + pad(d.getMonth() + 1) : "—"; }
  function ddmmaaaa(iso) { var d = dt(iso); return d ? ddmm(iso) + "/" + d.getFullYear() : "—"; }
  function quando(iso) {
    var d = dt(iso); if (!d) return "—";
    var n = diasAte(d);
    if (n === 0) return "hoje " + hm(d);
    if (n === 1) return "ontem " + hm(d);
    return ddmm(iso) + " " + hm(d);
  }
  function quandoCurto(iso) { var d = dt(iso); if (!d) return "—"; return diasAte(d) === 0 ? hm(d) : ddmm(iso); }
  function rel(iso) {
    var d = dt(iso); if (!d) return "nunca";
    var n = diasAte(d);
    if (n <= 0) return "hoje";
    if (n === 1) return "ontem";
    if (n < 30) return "há " + n + " dias";
    if (n < 365) { var m = Math.round(n / 30); return "há " + m + (m === 1 ? " mês" : " meses"); }
    return "há mais de 1 ano";
  }
  function dec(x, c) { return Number(x).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: c }); }
  function brl(v) { return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function usd(v) { return "US$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function tok(n) {
    n = Number(n) || 0;
    var a = Math.abs(n);
    if (a >= 1e9) return dec(n / 1e9, 1) + " bi";
    if (a >= 1e6 || Math.round(a / 1e3) >= 1000) return dec(n / 1e6, 1) + "M";
    if (a >= 1e3) return Math.round(n / 1e3).toLocaleString("pt-BR") + " mil";
    return String(Math.round(n));
  }
  function pct(x) { return Math.round(x * 100) + "%"; }
  var PAPEL_NOME = { dono: "Dono", financeiro: "Financeiro", suporte: "Suporte" };

  var A = window.AdminAtos = {
    secoes: [], quem: null, api: api, pedir: pedir, esc: esc, desenhar: null,
    util: { pad: pad, norm: norm, primeiro: primeiro, dt: dt, diasAte: diasAte, hm: hm, ddmm: ddmm, ddmmaaaa: ddmmaaaa, quando: quando,
      quandoCurto: quandoCurto, rel: rel, dec: dec, brl: brl, usd: usd, tok: tok, pct: pct, PAPEL_NOME: PAPEL_NOME },
  };
  var S = { secao: "", dentro: false, aoEntrar: [] };
  var GRUPOS = ["Atos", "PAVLVS"];

  function acesso(texto, botao) {
    S.dentro = false;
    fecharModal(true);
    $("secao").innerHTML = "<h1>Painel</h1>" + '<div class="card"><p class="vazio">' + texto + "</p>" + (botao || "") + "</div>";
  }
  /* A sessao que caiu no meio do uso: o mesmo caminho da abertura. */
  function sessaoCaiu(r) {
    var d = (r && r.dados) || {};
    if (d.entrar) { location.replace("/entrar/?volta=" + encodeURIComponent("/admin/")); return; }
    acesso(esc(d.erro || "a sessão do painel acabou"), '<div class="botoes"><button type="button" class="btn p primario" data-admin="reentrar">Entrar de novo</button></div>');
  }
  A.sessaoCaiu = sessaoCaiu;
  /* O que precisa de quem esta (a fila, as contagens do menu): roda uma vez, depois do GET /api/admin/eu. */
  A.aoEntrar = function (fn) { if (S.dentro && A.quem) fn(A.quem); else S.aoEntrar.push(fn); };

  /* As secoes na ordem do menu: os grupos, e dentro de cada um a `ordem` (ou a de registro). */
  function ordenadas() {
    return A.secoes.map(function (x, i) { return { s: x, g: GRUPOS.indexOf(x.grupo || "Atos"), o: x.ordem == null ? i : x.ordem, i: i }; })
      .sort(function (a, b) { return (a.g < 0 ? 99 : a.g) - (b.g < 0 ? 99 : b.g) || a.o - b.o || a.i - b.i; })
      .map(function (x) { return x.s; });
  }
  function secaoDe(id) { return A.secoes.filter(function (x) { return x.id === id; })[0] || null; }
  A.secaoAtual = function () { return S.secao; };
  A.nomeDaSecao = function (id) { var s = secaoDe(id); return s ? s.nome : id; };

  function menuHtml() {
    var lista = ordenadas(), h = "", grupo = null;
    if (A.buscador) h += '<button type="button" class="admin-buscar" data-admin="buscar"><span>Buscar em tudo</span><kbd>Ctrl K</kbd></button>';
    lista.forEach(function (x) {
      var g = x.grupo || "Atos";
      if (g !== grupo) { h += (grupo ? "</nav>" : "") + '<nav aria-label="' + esc(g) + '"><span>' + esc(g) + "</span>"; grupo = g; }
      var n = 0;
      try { n = x.contagem ? Number(x.contagem()) || 0 : 0; } catch (e) { n = 0; }
      h += '<a href="#' + esc(x.id) + '" data-secao="' + esc(x.id) + '"' + (x.id === S.secao ? ' aria-current="page"' : "") + "><span>" + esc(x.nome) + "</span>" +
        (n > 0 ? '<b class="admin-n" aria-label="' + n + ' para ver">' + n + "</b>" : "") + "</a>";
    });
    return h + (grupo ? "</nav>" : "");
  }
  /* So o menu (as contagens mudaram), sem redesenhar a secao. */
  A.atualizarNav = function () { var m = $("admin-menu"); if (m && S.dentro) m.innerHTML = menuHtml(); };

  function desenhar() {
    var q = A.quem;
    if (!A.secoes.length) { acesso("Nenhuma seção ligada neste painel."); return; }
    if (!secaoDe(S.secao)) S.secao = ordenadas()[0].id;
    S.dentro = true;
    $("secao").innerHTML = '<div class="admin-quem"><span>' + esc(q.nome || q.email) + " · " + esc(PAPEL_NOME[q.papel] || q.papel) + "</span>" +
      '<button type="button" class="link" data-admin="sair">Sair</button></div>' +
      '<div class="admin-casa"><aside class="admin-menu" id="admin-menu">' + menuHtml() + '</aside><div class="admin-corpo" id="admin-corpo"></div></div>';
    secaoDe(S.secao).desenhar($("admin-corpo"), { quem: q, api: api, esc: esc, redesenhar: desenhar });
  }
  A.desenhar = desenhar;
  A.navegar = function (id) {
    if (!secaoDe(id)) return;
    if (location.hash.slice(1) === id) { S.secao = id; desenhar(); return; }
    location.hash = id;
  };
  window.addEventListener("hashchange", function () {
    var id = location.hash.slice(1);
    if (!S.dentro || !secaoDe(id) || id === S.secao) return;
    S.secao = id;
    fecharModal(true);
    desenhar();
    window.scrollTo(0, 0);
  });

  /* ------------------------------------------------------------ o aviso que some sozinho */
  var tempoAviso = null;
  /* `html` so com texto ja escapado pela secao (ex.: um link para outra secao). */
  A.toast = function (msg, erro, html) {
    var el = $("admin-toast");
    if (!el) return;
    el.className = "admin-toast" + (erro ? " erro" : "");
    el.innerHTML = "<span>" + (html ? msg : esc(msg)) + "</span>";
    el.hidden = false;
    clearTimeout(tempoAviso);
    tempoAviso = setTimeout(function () { el.hidden = true; }, erro ? 6000 : 3000);
  };

  /* ------------------------------------------------------------ o pop-up (um de cada vez)
     A.modal.abrir({ html: function () { return "..."; }, classe: "largo", aoFechar: fn }); a secao muda o proprio
     estado e chama A.modal.repintar(). O fundo, o Esc e o "Fechar" ([data-admin="fechar-modal"]) fecham. */
  var M = null, focoAntes = null;
  function pintarCamada() {
    var c = $("admin-camada");
    if (!c) return;
    if (!M) { c.innerHTML = ""; c.hidden = true; document.body.classList.remove("com-modal"); return; }
    var ativo = document.activeElement, id = ativo && ativo.id && c.contains(ativo) ? ativo.id : null, pos = null;
    try { pos = ativo && ativo.selectionStart; } catch (x) { pos = null; }
    var velha = c.querySelector(".modal"), rolagem = velha ? velha.scrollTop : 0;
    c.innerHTML = '<div class="fundo-modal admin-fundo" data-admin-fundo><div class="modal' + (M.classe ? " " + esc(M.classe) : "") +
      '" role="dialog" aria-modal="true" aria-labelledby="modal-titulo">' + M.html() + "</div></div>";
    c.hidden = false;
    document.body.classList.add("com-modal");
    var caixa = c.querySelector(".modal");
    if (caixa) caixa.scrollTop = rolagem;
    if (id) {
      var el = $(id);
      if (el) { el.focus(); if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch (x) { /* sem selecao */ } }
    }
  }
  function fecharModal(calado) {
    if (!M) return;
    var x = M;
    M = null;
    pintarCamada();
    if (!calado && x.aoFechar) x.aoFechar();
    if (focoAntes && document.contains(focoAntes)) try { focoAntes.focus({ preventScroll: true }); } catch (e) { /* nada */ }
    focoAntes = null;
  }
  A.modal = {
    abrir: function (m) {
      if (!M) focoAntes = document.activeElement;
      M = m;
      pintarCamada();
      var c = $("admin-camada"), alvo = c && (c.querySelector("[data-foco]") || c.querySelector(".modal input, .modal textarea") || c.querySelector(".modal button"));
      if (alvo) alvo.focus();
    },
    fechar: function () { fecharModal(false); },
    repintar: pintarCamada,
    atual: function () { return M; },
  };

  document.addEventListener("click", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-admin-fundo")) { fecharModal(false); return; }
    var g = e.target.closest("a[data-secao]");
    if (g) { e.preventDefault(); A.navegar(g.getAttribute("data-secao")); return; }
    var b = e.target.closest("[data-admin]");
    if (!b || b.disabled) return;
    var acao = b.getAttribute("data-admin");
    if (acao === "fechar-modal") { fecharModal(false); return; }
    if (acao === "buscar") { if (A.buscador) A.buscador.abrir(); return; }
    if (acao === "sair" || acao === "reentrar") {
      // Entrar de novo: sai desta sessao e volta ao painel pelo /entrar (o login novo vale 12 horas aqui).
      api("POST", "/api/sair", {}).then(function () { location.assign("/entrar/?volta=" + encodeURIComponent("/admin/")); });
    }
  });
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k" && S.dentro && A.buscador) {
      e.preventDefault();
      if (M && M.busca) fecharModal(false); else A.buscador.abrir();
      return;
    }
    if (!M) return;
    if (e.key === "Escape") { e.preventDefault(); fecharModal(false); return; }
    if (e.key === "Tab") {
      // O foco fica dentro do pop-up.
      var caixa = document.querySelector("#admin-camada .modal");
      if (!caixa) return;
      var fs = Array.prototype.filter.call(caixa.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]'),
        function (x) { return x.offsetParent !== null; });
      if (!fs.length) return;
      var pri = fs[0], ult = fs[fs.length - 1];
      if (!caixa.contains(document.activeElement)) { e.preventDefault(); pri.focus(); }
      else if (e.shiftKey && document.activeElement === pri) { e.preventDefault(); ult.focus(); }
      else if (!e.shiftKey && document.activeElement === ult) { e.preventDefault(); pri.focus(); }
    }
  });

  // Depois de todos os scripts das secoes (defer): so entao pergunta quem esta.
  function iniciar() {
    S.secao = (location.hash || "").slice(1);
    api("GET", "/api/admin/eu").then(function (r) {
      if (r.status === 200) {
        A.quem = r.dados;
        desenhar();
        var fs = S.aoEntrar.splice(0);
        fs.forEach(function (fn) { try { fn(A.quem); } catch (e) { /* uma secao nao derruba as outras */ } });
        return;
      }
      if (r.dados.entrar) { location.replace("/entrar/?volta=" + encodeURIComponent("/admin/")); return; }
      if (r.dados.reentrar) { acesso(esc(r.dados.erro), '<div class="botoes"><button type="button" class="btn p primario" data-admin="reentrar">Entrar de novo</button></div>'); return; }
      // Conta Atos fora da equipe (chegou aqui por engano): vai para a Minha conta, sem ver nada do painel.
      if (r.status === 403) { location.replace("/conta/"); return; }
      acesso(esc(r.dados.erro || "não deu para abrir o painel agora"));
    });
  }
  // (Os scripts defer rodam com o documento ja "interactive", antes do DOMContentLoaded: esperar por ele.)
  if (document.readyState === "complete") iniciar(); else document.addEventListener("DOMContentLoaded", iniciar);
})();
