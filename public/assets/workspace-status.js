/* Atos Workspace > Status (/workspace/status): a pagina de status do sistema do dono. O servidor e worker/status.js (a
   porta das Integracoes; o Cron confere os enderecos a cada 5 minutos).

     GET  /api/workspace/status     a configuracao, o estado de cada endereco e os acontecimentos
     POST /api/workspace/status     {acao: salvar {nome, titulo, publica, avisar, enderecos} | apagar {confirmar}}

   A workspace.js desenha o titulo e as guias e chama WorkspaceStatus.montar(raiz). Os atributos sao data-st*. */
(function () {
  "use strict";
  var S = { raiz: null, dados: null, erro: "", carregando: false, aviso: "", v: null, ocupado: false, confirmar: false, erroForm: "" };
  var VOLTA_ENTRAR = "/workspace/entrar/?modo=entrar&volta=" + encodeURIComponent("/workspace/status");
  var ROTULO = { ok: "no ar", lento: "lento", fora: "fora" };

  if (!document.querySelector('link[href="/assets/integrar.css"]')) {
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/integrar.css";
    document.head.appendChild(l);
  }
  function esc(s) {
    // O erro de um limite do plano (codigo "limite_do_plano", worker/workspace-plano.js) traz a marca [Conhecer o Pro], que
    // vira o link para /workspace/plano.
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; })
      .replace("[Conhecer o Pro]", '<a href="/workspace/plano">Conhecer o Pro</a>');
  }
  function api(caminho, corpo) {
    var op = corpo === undefined ? { credentials: "same-origin" } :
      { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) };
    return fetch(caminho, op).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; if (d.codigo === "limite_do_plano" && d.erro) d.erro += " [Conhecer o Pro]"; return d; });
    }, function () { return { erro: "sem conexão com o servidor", _status: 0 }; });
  }
  function quando(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function rascunho(cfg) {
    return cfg ? { nome: cfg.nome, titulo: cfg.titulo, publica: cfg.publica, avisar: cfg.avisar, enderecos: cfg.enderecos.map(function (e) { return { nome: e.nome, url: e.url }; }) }
      : { nome: "", titulo: "", publica: true, avisar: true, enderecos: [{ nome: "", url: "" }] };
  }
  function carregar() {
    S.carregando = true;
    api("/api/workspace/status").then(function (d) {
      S.carregando = false;
      if (d._status === 401) { location.replace("/workspace/entrar/?volta=" + encodeURIComponent("/workspace/status")); return; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; document.dispatchEvent(new CustomEvent("workspace-inativo")); return; }
      if (d.erro) { S.erro = d.erro; pintar(); return; }
      S.erro = ""; S.dados = d; S.v = rascunho(d.cfg); pintar();
    });
  }
  function mandar(corpo, msg) {
    S.ocupado = true; S.erroForm = ""; pintar();
    api("/api/workspace/status", corpo).then(function (d) {
      S.ocupado = false;
      if (d._status === 401 && d.reentrar) { S.dados.recente = false; pintar(); return; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; document.dispatchEvent(new CustomEvent("workspace-inativo")); return; }
      if (d.erro) { S.erroForm = d.erro; pintar(); return; }
      S.dados = d; S.v = rascunho(d.cfg); S.aviso = msg; S.confirmar = false; pintar();
    });
  }

  function estadoDe(id) {
    var e = (S.dados.estados || {})[id];
    if (!e || !e.ult) return '<span class="ig-sit">esperando a primeira conferência</span>';
    var u = e.ult;
    return '<span class="ig-sit ' + (u.estado === "ok" ? "ok" : u.estado === "lento" ? "atencao" : "perigo") + '">' + ROTULO[u.estado] + "</span> " +
      (u.estado !== "fora" ? u.ms + " ms" : u.codigo ? "respondeu " + u.codigo : "sem resposta") + " · desde " + esc(quando(u.desde)) + " · conferido " + esc(quando(u.ultima));
  }
  function recentes(id) {
    var e = (S.dados.estados || {})[id];
    var l = (e && e.recentes) || [];
    if (!l.length) return "";
    return '<div class="st-barras ws-st-barras" role="img" aria-label="As últimas ' + l.length + ' conferências">' + l.map(function (x) {
      return '<span class="' + (x.r === "ok" ? "e-ok" : x.r === "lento" ? "e-instavel" : "e-fora") + '" title="' + esc(quando(x.t) + " · " + ROTULO[x.r] + " · " + x.ms + " ms") + '"></span>';
    }).join("") + "</div>";
  }

  function tela() {
    if (!S.dados) return '<div class="card"><p class="vazio">' + (S.erro ? esc(S.erro) + ' <button type="button" class="link" data-st="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    var D = S.dados, c = D.cfg, v = S.v, h = "";
    if (!D.recente) h += '<p class="ig-aviso">Para criar ou mudar a página, o login precisa ser das últimas ' + D.limites.recente_h + ' horas. <a href="' + VOLTA_ENTRAR + '">Entrar de novo</a></p>';
    if (S.aviso) h += '<p class="ok ig-ok">' + esc(S.aviso) + "</p>";
    if (c && c.bloqueado) h += '<p class="ig-aviso">A Atos tirou esta página do ar em ' + esc(quando(c.bloqueado.quando)) + (c.bloqueado.motivo ? ": " + esc(c.bloqueado.motivo) : "") + ". As conferências pararam. Para conversar, escreva para contato@atos.dev.br.</p>";
    if (c) {
      var url = D.base + c.nome;
      h += '<h2 class="titulo-secao">Agora</h2><div class="card ig-app"><div class="ig-bloco"><p>' + (c.publica ? 'Página pública: <a href="/status/' + esc(c.nome) + '">' + esc(url) + "</a>" : "A página não é pública (só você vê o estado aqui).") + "</p>" +
        c.enderecos.map(function (e) {
          var fora = (D.fora_do_plano || []).indexOf(e.id) >= 0;
          return '<div class="ws-st-item"><strong>' + esc(e.nome) + "</strong> <small>" + esc(e.url) + "</small><div>" + (fora ? '<span class="ig-sit">fora do plano: sem conferência e fora da página pública</span>' : estadoDe(e.id)) + "</div>" + (fora ? "" : recentes(e.id)) + "</div>";
        }).join("") +
        (D.eventos && D.eventos.length ? '<h3 class="titulo-secao">Acontecimentos</h3><ul class="fm-registro">' + D.eventos.map(function (x) {
          return "<li><span>" + esc(quando(x.quando)) + "</span> " + esc(x.nome) + (x.oque === "caiu" ? " ficou fora do ar" : " voltou") + "</li>";
        }).join("") + "</ul>" : "") + "</div></div>";
    }
    h += '<h2 class="titulo-secao">' + (c ? "Configuração" : "Criar a página de status") + '</h2><div class="card"><form class="ig-bloco ws-st-form" data-st-form>' +
      '<label class="campo"><span class="rotulo">Nome (o endereço: ' + esc(D.base) + '&lt;nome&gt;)</span><input data-st-in="nome" value="' + esc(v.nome) + '" maxlength="30" autocomplete="off" spellcheck="false" placeholder="minha-loja"></label>' +
      '<label class="campo"><span class="rotulo">Título (aparece no topo da página)</span><input data-st-in="titulo" value="' + esc(v.titulo) + '" maxlength="60" autocomplete="off"></label>' +
      '<div class="campo"><span class="rotulo">Endereços conferidos (https, até ' + D.limites.enderecos + "; o nome aparece na página, o endereço não)</span>" +
      v.enderecos.map(function (e, i) {
        return '<div class="ws-st-linha"><input data-st-end="nome" data-i="' + i + '" value="' + esc(e.nome) + '" placeholder="Site" maxlength="40" autocomplete="off">' +
          '<input data-st-end="url" data-i="' + i + '" value="' + esc(e.url) + '" placeholder="https://exemplo.com.br/saude" autocomplete="off" spellcheck="false" type="url">' +
          (v.enderecos.length > 1 ? '<button type="button" class="btn mini" data-st="tirar" data-i="' + i + '">Tirar</button>' : "") + "</div>";
      }).join("") + (v.enderecos.length < D.limites.enderecos ? '<div><button type="button" class="btn mini" data-st="mais">Mais um endereço</button></div>' : "") + "</div>" +
      '<label class="ig-marcar"><input type="checkbox" data-st-in="publica"' + (v.publica ? " checked" : "") + "><span>Página pública em " + esc(D.base) + "&lt;nome&gt; (sem os endereços; o nome que você deu a cada um)</span></label>" +
      (D.limites.email || (c && c.avisar)
        ? '<label class="ig-marcar"><input type="checkbox" data-st-in="avisar"' + (v.avisar ? " checked" : "") + "><span>Avisar por e-mail (no destino de " + esc(D.email_atos) + ") quando um endereço cair (duas conferências seguidas fora) e quando voltar; até " + D.limites.avisos_dia + " avisos por dia" + (D.limites.email ? "" : " (o aviso é do Pro: guardado, mas sem enviar no gratuito)") + "</span></label>"
        : '<p class="dica">O aviso de queda por e-mail é do Atos Workspace Pro. <a href="/workspace/plano">Conhecer o Pro</a></p>') +
      (S.erroForm ? '<p class="erro" role="alert">' + esc(S.erroForm) + "</p>" : "") +
      '<div class="ig-acoes"><button type="submit" class="btn p primario"' + (S.ocupado || (c && c.bloqueado) ? " disabled" : "") + ">" + (S.ocupado ? "Um momento…" : c ? "Salvar" : "Criar a página") + "</button>" +
      (c ? (S.confirmar ? '<button type="button" class="btn p perigo" data-st="apagar-sim">Apagar a página e o histórico</button><button type="button" class="btn p" data-st="apagar-nao">Voltar</button>'
        : '<button type="button" class="btn p perigo" data-st="apagar">Apagar</button>') : "") + "</div></form></div>";
    if (D.fora_do_plano && D.fora_do_plano.length) h += '<p class="ig-aviso">' + D.fora_do_plano.length + (D.fora_do_plano.length === 1 ? " endereço passa" : " endereços passam") + ' do limite do seu plano (' + D.limites.enderecos + '): ficam guardados, sem conferência, até voltar ao Pro ou tirar outros. <a href="/workspace/plano">Conhecer o Pro</a></p>';
    h += '<p class="nota">No plano ' + (D.plano && D.plano.pro ? "Pro" : "gratuito") + ", até " + D.limites.enderecos + (D.limites.enderecos === 1 ? " endereço" : " endereços") + ". A Atos confere cada endereço a cada " + (D.limites.intervalo_min === 1 ? "minuto (com muitas páginas na fila, o mais cedo que der)" : D.limites.intervalo_min + " minutos") + ": um GET, sem seguir redirecionamento, esperando até 10 segundos. No ar: respondeu 2xx ou 3xx (lento, acima de 3 segundos); fora: 4xx, 5xx, erro ou tempo esgotado. " +
      "Só endereços https públicos (sem IP, rede interna nem a Atos). O histórico fica " + D.limites.historico_dias + " dias. A Atos não garante o horário exato de cada conferência: com muitas páginas, a fila pode atrasar. " +
      'Veja os <a href="/termos/#workspace-status">termos</a> e a <a href="/privacidade/">política de privacidade</a>.</p>';
    return h;
  }
  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-st]");
    if (!b || b.disabled || !S.v) { if (b && b.getAttribute("data-st") === "recarregar") { S.erro = ""; pintar(); carregar(); } return; }
    var a = b.getAttribute("data-st");
    if (a === "recarregar") { S.erro = ""; pintar(); carregar(); return; }
    if (a === "mais") { S.v.enderecos.push({ nome: "", url: "" }); pintar(); return; }
    if (a === "tirar") { S.v.enderecos.splice(Number(b.getAttribute("data-i")), 1); pintar(); return; }
    if (a === "apagar") { S.confirmar = true; pintar(); return; }
    if (a === "apagar-nao") { S.confirmar = false; pintar(); return; }
    if (a === "apagar-sim") mandar({ acao: "apagar", confirmar: true }, "Página apagada.");
  });
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (!S.v || !el.getAttribute) return;
    var k = el.getAttribute("data-st-in");
    if (k) { S.v[k] = el.type === "checkbox" ? el.checked : el.value; return; }
    var en = el.getAttribute("data-st-end");
    if (en) S.v.enderecos[Number(el.getAttribute("data-i"))][en] = el.value;
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (S.v && el.getAttribute && el.type === "checkbox" && el.getAttribute("data-st-in")) S.v[el.getAttribute("data-st-in")] = el.checked;
  });
  document.addEventListener("submit", function (e) {
    var f = e.target.closest && e.target.closest("form[data-st-form]");
    if (!f) return;
    e.preventDefault();
    var v = S.v;
    mandar({ acao: "salvar", nome: v.nome.trim(), titulo: v.titulo.trim(), publica: Boolean(v.publica), avisar: Boolean(v.avisar),
      enderecos: v.enderecos.filter(function (x) { return x.url.trim(); }).map(function (x) { return { nome: x.nome.trim(), url: x.url.trim() }; }) },
      "Salvo. A primeira conferência sai no próximo minuto.");
  });

  window.WorkspaceStatus = {
    montar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.dados && !S.carregando) carregar();
    },
  };
})();
