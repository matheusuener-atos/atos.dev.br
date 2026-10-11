/* O painel da Atos (/admin/): a equipe cuida do que e da Atos, e nao de um produto so. O servidor e o
   worker/admin.js: a Conta Atos com o e-mail na equipe (ATOS_EQUIPE) e o login de ate 12 horas.

   Esta pagina e a casca: o acesso (entrar, entrar de novo, fora da equipe), quem esta e as secoes. Cada secao
   se registra em AdminAtos.secoes ({id, nome, desenhar(raiz, ctx)}) a partir do seu proprio script
   (assets/admin-*.js), carregado depois deste. Hoje: as notas fiscais (assets/admin-nfse.js). */
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

  var A = window.AdminAtos = { secoes: [], quem: null, api: api, esc: esc, desenhar: null };
  var S = { secao: "" };

  function acesso(texto, botao) {
    $("secao").innerHTML = "<h1>Painel</h1>" + '<div class="card"><p class="vazio">' + texto + "</p>" + (botao || "") + "</div>";
  }

  function desenhar() {
    var q = A.quem;
    if (!A.secoes.length) { acesso("Nenhuma seção ligada neste painel."); return; }
    if (!A.secoes.some(function (x) { return x.id === S.secao; })) S.secao = A.secoes[0].id;
    var guias = A.secoes.length > 1 ? '<nav class="guias" aria-label="Painel">' + A.secoes.map(function (x) {
      return '<a href="#' + esc(x.id) + '" data-secao="' + esc(x.id) + '"' + (x.id === S.secao ? ' aria-current="page"' : "") + ">" + esc(x.nome) + "</a>";
    }).join("") + "</nav>" : "";
    $("secao").innerHTML = '<div class="admin-quem"><span>' + esc(q.nome || q.email) + " · " + esc(q.papel) + '</span><button type="button" class="link" data-admin="sair">Sair</button></div>' +
      guias + '<div id="admin-corpo"></div>';
    var secao = A.secoes.filter(function (x) { return x.id === S.secao; })[0];
    secao.desenhar($("admin-corpo"), { quem: q, api: api, esc: esc, redesenhar: desenhar });
  }
  A.desenhar = desenhar;

  document.addEventListener("click", function (e) {
    var g = e.target.closest("a[data-secao]");
    if (g) { e.preventDefault(); S.secao = g.getAttribute("data-secao"); history.replaceState(null, "", "#" + S.secao); desenhar(); return; }
    var b = e.target.closest("[data-admin]");
    if (!b) return;
    var acao = b.getAttribute("data-admin");
    if (acao === "sair" || acao === "reentrar") {
      // Entrar de novo: sai desta sessao e volta ao painel pelo /entrar (o login novo vale 12 horas aqui).
      api("POST", "/api/sair", {}).then(function () { location.assign("/entrar/?volta=" + encodeURIComponent("/admin/")); });
    }
  });

  S.secao = (location.hash || "").slice(1);
  api("GET", "/api/admin/eu").then(function (r) {
    if (r.status === 200) { A.quem = r.dados; desenhar(); return; }
    if (r.dados.entrar) { location.replace("/entrar/?volta=" + encodeURIComponent("/admin/")); return; }
    if (r.dados.reentrar) { acesso(esc(r.dados.erro), '<div class="botoes"><button type="button" class="btn p primario" data-admin="reentrar">Entrar de novo</button></div>'); return; }
    // Conta Atos fora da equipe (chegou aqui por engano): vai para a Minha conta, sem ver nada do painel.
    if (r.status === 403 && !r.dados.config) { location.replace("/conta/"); return; }
    acesso(esc(r.dados.erro || "não deu para abrir o painel agora"));
  });
})();
