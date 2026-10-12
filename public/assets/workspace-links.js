/* Atos Workspace > Pagina de links (/workspace/links): a pagina publica atos.dev.br/@<nome>. O servidor e worker/links.js
   (a porta do Workspace; o e-mail Atos nao e exigido).

     GET  /api/workspace/links     as paginas, os limites do plano, os cliques (Pro), os formularios e o e-mail Atos
     POST /api/workspace/links     {acao: salvar {nome, exibicao, frase, foto, links, email_atos, formulario} | apagar {nome, confirmar}}

   A workspace.js desenha o titulo e as guias e chama WorkspaceLinks.montar(raiz). Os atributos sao data-lk*. A foto e
   reduzida aqui (um quadrado de 192 px, JPEG) antes de ir ao servidor, que confere de novo (so PNG, JPEG ou WebP, ate 50 KB). */
(function () {
  "use strict";
  var S = { raiz: null, dados: null, erro: "", carregando: false, aviso: "", ed: null, ocupado: false, erroForm: "", confirmar: "", stats: "" };
  var VOLTA_ENTRAR = "/workspace/entrar/?modo=entrar&volta=" + encodeURIComponent("/workspace/links");

  if (!document.querySelector('link[href="/assets/integrar.css"]')) {
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/integrar.css";
    document.head.appendChild(l);
  }
  function esc(s) {
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
  function data(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }
  function dominio(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } }

  function carregar() {
    S.carregando = true;
    api("/api/workspace/links").then(function (d) {
      S.carregando = false;
      if (d._status === 401) { location.replace("/workspace/entrar/?volta=" + encodeURIComponent("/workspace/links")); return; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; document.dispatchEvent(new CustomEvent("workspace-inativo")); return; }
      if (d.erro) { S.erro = d.erro; pintar(); return; }
      S.erro = ""; S.dados = d; pintar();
    });
  }
  function mandar(corpo, msg) {
    S.ocupado = true; S.erroForm = ""; pintar();
    api("/api/workspace/links", corpo).then(function (d) {
      S.ocupado = false;
      if (d._status === 401 && d.reentrar) { S.dados.recente = false; pintar(); return; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; document.dispatchEvent(new CustomEvent("workspace-inativo")); return; }
      if (d.erro) { S.erroForm = d.erro; pintar(); return; }
      S.dados = d; S.ed = null; S.confirmar = ""; S.aviso = msg; pintar();
    });
  }

  function situacao(p) {
    if (p.bloqueado) return '<span class="ig-sit perigo">fora do ar pela Atos</span>';
    if (p.fora_do_plano) return '<span class="ig-sit">fora do plano: fora do ar</span>';
    return '<span class="ig-sit ok">no ar</span>';
  }

  function estatistica(p) {
    var c = p.cliques;
    if (!c) return "";
    var maior = c.por_dia.reduce(function (m, x) { return Math.max(m, x.n); }, 0);
    var porDia = {};
    c.por_dia.forEach(function (x) { porDia[x.dia] = x.n; });
    var barras = "";
    for (var i = c.dias - 1; i >= 0; i--) {
      var dia = new Date(Date.now() - 3 * 3600000 - i * 86400000).toISOString().slice(0, 10);
      var n = porDia[dia] || 0;
      // A altura por classe (a CSP da conta nao aceita style inline): de 0 a 10.
      var nivel = maior ? Math.ceil((n / maior) * 10) : 0;
      barras += '<span class="lk-b' + nivel + '" title="' + esc(dia.split("-").reverse().join("/") + ": " + n + (n === 1 ? " clique" : " cliques")) + '"></span>';
    }
    var linhas = p.links.map(function (x) { return { t: x.titulo, d: dominio(x.url), n: c.por_link[x.id] || 0 }; }).sort(function (a, b) { return b.n - a.n; });
    return '<div class="ig-bloco"><h3 class="titulo-secao">Cliques nos últimos ' + c.dias + " dias: " + c.total.toLocaleString("pt-BR") + "</h3>" +
      '<div class="lk-barras" role="img" aria-label="Cliques por dia nos últimos ' + c.dias + ' dias">' + barras + "</div>" +
      '<ul class="fm-registro">' + linhas.map(function (x) { return "<li><strong>" + x.n.toLocaleString("pt-BR") + "</strong> " + esc(x.t) + " <span>" + esc(x.d) + "</span></li>"; }).join("") + "</ul>" +
      '<p class="dica">A Atos conta o clique quando a pessoa passa pelo endereço atos.dev.br/@' + esc(p.nome) + "/ir/…, por dia e por link, sem guardar nada de quem clicou.</p></div>";
  }

  function cartao(p) {
    var D = S.dados;
    var url = D.base + p.nome;
    var h = '<div class="card ig-app"><div class="item">' + (p.foto ? '<img class="logo" src="' + esc(p.foto) + '" alt="" width="40" height="40">' : '<span class="logo inicial" aria-hidden="true">@</span>') +
      '<span class="nome"><strong>' + esc(p.exibicao) + " " + situacao(p) + "</strong><small>" + (p.bloqueado || p.fora_do_plano ? esc(url) : '<a href="/@' + esc(p.nome) + '">' + esc(url) + "</a>") + "</small>" +
      "<small>" + p.links.length + (p.links.length === 1 ? " link" : " links") + " · criada em " + esc(data(p.criado)) + (p.mudado ? " · mudada em " + esc(data(p.mudado)) : "") + "</small></span>" +
      '<span class="ig-acoes">' + (p.bloqueado || p.fora_do_plano ? "" : '<button type="button" class="btn mini" data-lk="editar" data-nome="' + esc(p.nome) + '">Editar</button>') +
      (p.cliques ? '<button type="button" class="btn mini" data-lk="stats" data-nome="' + esc(p.nome) + '" aria-expanded="' + (S.stats === p.nome) + '">Cliques</button>' : "") +
      '<button type="button" class="btn mini perigo" data-lk="apagar" data-nome="' + esc(p.nome) + '">Apagar</button></span></div>';
    if (p.bloqueado) h += '<p class="ig-aviso">A Atos tirou esta página do ar em ' + esc(data(p.bloqueado.quando)) + (p.bloqueado.motivo ? ": " + esc(p.bloqueado.motivo) : "") + ". Enquanto estiver assim, ela não abre nem muda. Para conversar, escreva para contato@atos.dev.br.</p>";
    if (p.fora_do_plano) h += '<p class="ig-aviso">Fora do plano: esta página passa do limite do seu plano (' + D.limites.paginas + (D.limites.paginas === 1 ? " página" : " páginas") + ") e está fora do ar. Nada foi apagado e o nome continua seu: ela volta com o Pro, ou apagando outra. <a href=\"/workspace/plano\">Conhecer o Pro</a></p>";
    if (!p.fora_do_plano && p.links.length > D.limites.links) h += '<p class="ig-aviso">' + (p.links.length - D.limites.links) + " dos links passam do limite do seu plano (" + D.limites.links + " por página) e não aparecem na página (só os primeiros). <a href=\"/workspace/plano\">Conhecer o Pro</a></p>";
    if (S.confirmar === p.nome) {
      h += '<div class="confirmar ig-bloco" role="alertdialog" aria-label="Apagar a página"><p>Apagar a página @' + esc(p.nome) + "? Ela sai do ar, a estatística é apagada e o nome fica livre para outra pessoa.</p>" +
        '<div class="botoes"><button type="button" class="btn p perigo" data-lk="apagar-sim" data-nome="' + esc(p.nome) + '"' + (S.ocupado ? " disabled" : "") + '>Apagar</button><button type="button" class="btn p" data-lk="apagar-nao">Voltar</button></div></div>';
    }
    if (S.stats === p.nome) h += estatistica(p);
    return h + "</div>";
  }

  function editor() {
    var D = S.dados, v = S.ed, L = D.limites;
    var novo = !v.existe;
    var forms = (D.formularios || []).filter(function (f) { return !f.bloqueado && (!f.pagina || f.pagina === v.nome); });
    var h = '<h2 class="titulo-secao">' + (novo ? "Nova página" : "Editar @" + esc(v.nome)) + '</h2><div class="card"><form class="ig-bloco lk-form-ed" data-lk-form>' +
      '<label class="campo"><span class="rotulo">Nome (o endereço: ' + esc(D.base) + "&lt;nome&gt;; de 3 a 30 letras minúsculas, números e hífen)</span>" +
      '<input name="nome" data-lk-in="nome" value="' + esc(v.nome) + '" maxlength="30" autocomplete="off" spellcheck="false" placeholder="maria-doces"' + (novo ? "" : " readonly") + "></label>" +
      '<label class="campo"><span class="rotulo">Nome de exibição</span><input name="exibicao" data-lk-in="exibicao" value="' + esc(v.exibicao) + '" maxlength="' + L.exibicao + '" autocomplete="off"></label>' +
      '<label class="campo"><span class="rotulo">Uma frase curta (opcional)</span><input name="frase" data-lk-in="frase" value="' + esc(v.frase) + '" maxlength="' + L.frase + '" autocomplete="off"></label>' +
      '<div class="campo"><span class="rotulo">Foto (opcional; PNG, JPEG ou WebP; a Atos guarda um quadrado pequeno)</span><div class="lk-foto-ed">' +
      (v.foto ? '<img src="' + esc(v.foto) + '" alt="A foto da página" width="64" height="64">' : '<span class="logo inicial" aria-hidden="true">' + esc((v.exibicao || "?").charAt(0).toUpperCase()) + "</span>") +
      '<input type="file" name="foto" data-lk-foto accept="image/png,image/jpeg,image/webp" aria-label="Escolher a foto">' + (v.foto ? '<button type="button" class="btn mini" data-lk="sem-foto">Tirar a foto</button>' : "") + "</div></div>" +
      '<div class="campo"><span class="rotulo">Links (só https; até ' + L.links + " no seu plano; o domínio aparece embaixo de cada um)</span>" +
      v.links.map(function (x, i) {
        return '<div class="lk-linha"><input name="titulo-' + i + '" data-lk-link="titulo" data-i="' + i + '" value="' + esc(x.titulo) + '" placeholder="Título" maxlength="' + L.titulo + '" autocomplete="off">' +
          '<input name="url-' + i + '" data-lk-link="url" data-i="' + i + '" value="' + esc(x.url) + '" placeholder="https://exemplo.com.br" type="url" autocomplete="off" spellcheck="false">' +
          '<label class="ig-marcar"><input type="checkbox" name="ativo-' + i + '" data-lk-link="ativo" data-i="' + i + '"' + (x.ativo !== false ? " checked" : "") + "><span>ligado</span></label>" +
          '<span class="lk-mover"><button type="button" class="btn mini" data-lk="subir" data-i="' + i + '"' + (i ? "" : " disabled") + ' aria-label="Subir">↑</button>' +
          '<button type="button" class="btn mini" data-lk="descer" data-i="' + i + '"' + (i < v.links.length - 1 ? "" : " disabled") + ' aria-label="Descer">↓</button>' +
          '<button type="button" class="btn mini" data-lk="tirar" data-i="' + i + '">Tirar</button></span></div>';
      }).join("") +
      (v.links.length < L.links ? '<div><button type="button" class="btn mini" data-lk="mais">Mais um link</button></div>' : '<p class="dica">Chegou ao limite do seu plano.' + (D.plano && D.plano.pro ? "" : ' <a href="/workspace/plano">Conhecer o Pro</a>') + "</p>") + "</div>" +
      (D.email_atos ? '<label class="ig-marcar"><input type="checkbox" name="email_atos" data-lk-in="email_atos"' + (v.email_atos ? " checked" : "") + "><span>Mostrar o meu e-mail Atos (" + esc(D.email_atos) + ") como botão</span></label>"
        : '<p class="dica">O botão do e-mail Atos aparece aqui quando o seu e-mail Atos estiver com o destino confirmado e ligado.</p>') +
      '<label class="campo"><span class="rotulo">Um formulário seu como botão (opcional)</span><select name="formulario" data-lk-in="formulario"><option value="">nenhum</option>' +
      forms.map(function (f) { return '<option value="' + esc(f.id) + '"' + (v.formulario === f.id ? " selected" : "") + ">" + esc(f.nome) + (f.ativo ? "" : " (desligado)") + "</option>"; }).join("") + "</select></label>" +
      (S.erroForm ? '<p class="erro" role="alert">' + esc(S.erroForm) + "</p>" : "") +
      '<div class="ig-acoes"><button type="submit" class="btn p primario"' + (S.ocupado ? " disabled" : "") + ">" + (S.ocupado ? "Um momento…" : novo ? "Criar a página" : "Salvar") + "</button>" +
      '<button type="button" class="btn p" data-lk="cancelar">Cancelar</button></div></form></div>';
    return h;
  }

  function tela() {
    if (!S.dados) return '<div class="card"><p class="vazio">' + (S.erro ? esc(S.erro) + ' <button type="button" class="link" data-lk="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    var D = S.dados, h = "";
    if (!D.recente) h += '<p class="ig-aviso">Para criar ou mudar a página, o login precisa ser das últimas ' + D.limites.recente_h + ' horas. <a href="' + VOLTA_ENTRAR + '">Entrar de novo</a></p>';
    if (S.aviso) h += '<p class="ok ig-ok">' + esc(S.aviso) + "</p>";
    if (S.ed) return h + editor();
    h += '<h2 class="titulo-secao ig-h"><span>Suas páginas (' + D.paginas.length + " de " + D.limites.paginas + ")</span>" +
      (D.paginas.length < D.limites.paginas ? '<button type="button" class="btn p primario" data-lk="nova">Nova página</button>' : D.plano && !D.plano.pro ? '<a class="btn p" href="/workspace/plano">Conhecer o Pro</a>' : "") + "</h2>";
    if (S.erroForm) h += '<p class="erro" role="alert">' + esc(S.erroForm) + "</p>";
    if (!D.paginas.length) h += '<div class="card"><p class="vazio">Nenhuma página. Crie a sua: um endereço atos.dev.br/@&lt;nome&gt; com o seu nome, uma frase e os seus links.</p></div>';
    else h += D.paginas.map(cartao).join("");
    h += '<p class="nota">A página é gerada pela Atos, sem nenhum código seu: só o nome, a frase, a foto e os links (https; sem endereço IP, encurtador nem endereço da Atos), cada um com o domínio de destino à mostra. ' +
      "Embaixo, sempre: “Página criada por uma pessoa com Conta Atos. A Atos não verificou estes links.” e o Denunciar esta página. Nomes que lembrem a Atos, bancos, governo ou marcas conhecidas são recusados. " +
      "A equipe da Atos pode tirar do ar uma página usada para golpe; você vê o motivo aqui. " +
      (D.limites.cliques ? "No Pro, cada clique passa por atos.dev.br/@nome/ir/… e é contado por dia e por link (" + D.limites.cliques_dias + " dias), sem guardar nada de quem clicou. " : "No gratuito, os links vão direto ao destino e nada é contado. ") +
      'Veja os <a href="/termos/#workspace-links">termos</a> e a <a href="/privacidade/">política de privacidade</a>.</p>';
    return h;
  }
  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }

  function abrirEditor(p) {
    S.aviso = ""; S.erroForm = "";
    S.ed = p ? { existe: true, nome: p.nome, exibicao: p.exibicao, frase: p.frase, foto: p.foto, email_atos: p.email_atos, formulario: p.formulario,
      links: p.links.map(function (x) { return { id: x.id, titulo: x.titulo, url: x.url, ativo: x.ativo !== false }; }) }
      : { existe: false, nome: "", exibicao: "", frase: "", foto: "", email_atos: false, formulario: "", links: [{ titulo: "", url: "", ativo: true }] };
    pintar();
    window.scrollTo(0, 0);
  }

  /* A foto: um quadrado de 192 px (recortado ao centro), em JPEG, para caber nos 50 KB. */
  function reduzirFoto(arquivo) {
    if (!/^image\/(png|jpeg|webp)$/.test(arquivo.type)) { S.erroForm = "a foto precisa ser PNG, JPEG ou WebP"; pintar(); return; }
    if (arquivo.size > 8 * 1024 * 1024) { S.erroForm = "essa imagem é grande demais (até 8 MB para reduzir)"; pintar(); return; }
    var leitor = new FileReader();
    leitor.onload = function () {
      var img = new Image();
      img.onload = function () {
        var lado = 192, c = document.createElement("canvas");
        c.width = lado; c.height = lado;
        var m = Math.min(img.naturalWidth, img.naturalHeight);
        c.getContext("2d").drawImage(img, (img.naturalWidth - m) / 2, (img.naturalHeight - m) / 2, m, m, 0, 0, lado, lado);
        var q = 0.86, url = c.toDataURL("image/jpeg", q);
        while (url.length > 66000 && q > 0.4) { q -= 0.12; url = c.toDataURL("image/jpeg", q); }
        if (!S.ed) return;
        S.ed.foto = url; S.erroForm = ""; pintar();
      };
      img.onerror = function () { S.erroForm = "não deu para ler essa imagem"; pintar(); };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(arquivo);
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-lk]");
    if (!b || b.disabled || !S.raiz || !S.raiz.contains(b)) return;
    var a = b.getAttribute("data-lk"), nome = b.getAttribute("data-nome"), i = Number(b.getAttribute("data-i"));
    if (a === "recarregar") { S.erro = ""; pintar(); carregar(); return; }
    if (a === "nova") { abrirEditor(null); return; }
    if (a === "editar") { abrirEditor(S.dados.paginas.filter(function (p) { return p.nome === nome; })[0]); return; }
    if (a === "cancelar") { S.ed = null; S.erroForm = ""; pintar(); return; }
    if (a === "stats") { S.stats = S.stats === nome ? "" : nome; pintar(); return; }
    if (a === "apagar") { S.confirmar = nome; S.aviso = ""; pintar(); return; }
    if (a === "apagar-nao") { S.confirmar = ""; pintar(); return; }
    if (a === "apagar-sim") { mandar({ acao: "apagar", nome: nome, confirmar: true }, "Página apagada."); return; }
    if (!S.ed) return;
    if (a === "sem-foto") { S.ed.foto = ""; pintar(); return; }
    if (a === "mais") { S.ed.links.push({ titulo: "", url: "", ativo: true }); pintar(); return; }
    if (a === "tirar") { S.ed.links.splice(i, 1); pintar(); return; }
    if (a === "subir" && i > 0) { var x = S.ed.links.splice(i, 1)[0]; S.ed.links.splice(i - 1, 0, x); pintar(); return; }
    if (a === "descer" && i < S.ed.links.length - 1) { var y = S.ed.links.splice(i, 1)[0]; S.ed.links.splice(i + 1, 0, y); pintar(); }
  });
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (!S.ed || !el.getAttribute) return;
    var k = el.getAttribute("data-lk-in");
    if (k) { S.ed[k] = el.type === "checkbox" ? el.checked : el.value; return; }
    var lk = el.getAttribute("data-lk-link");
    if (lk) S.ed.links[Number(el.getAttribute("data-i"))][lk] = el.type === "checkbox" ? el.checked : el.value;
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!S.ed || !el.getAttribute) return;
    if (el.hasAttribute("data-lk-foto") && el.files && el.files[0]) { reduzirFoto(el.files[0]); return; }
    var k = el.getAttribute("data-lk-in");
    if (k) { S.ed[k] = el.type === "checkbox" ? el.checked : el.value; return; }
    var lk = el.getAttribute("data-lk-link");
    if (lk && el.type === "checkbox") S.ed.links[Number(el.getAttribute("data-i"))].ativo = el.checked;
  });
  document.addEventListener("submit", function (e) {
    var f = e.target.closest && e.target.closest("form[data-lk-form]");
    if (!f || !S.ed) return;
    e.preventDefault();
    var v = S.ed;
    mandar({ acao: "salvar", nome: v.nome.trim().toLowerCase(), exibicao: v.exibicao.trim(), frase: v.frase.trim(), foto: v.foto, email_atos: Boolean(v.email_atos), formulario: v.formulario,
      links: v.links.filter(function (x) { return x.url.trim() || x.titulo.trim(); }).map(function (x) { return { id: x.id, titulo: x.titulo.trim(), url: x.url.trim(), ativo: x.ativo !== false }; }) },
      v.existe ? "Salvo. A página pública muda em até 1 minuto." : "Página criada: " + S.dados.base + v.nome.trim().toLowerCase());
  });

  window.WorkspaceLinks = {
    montar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.dados && !S.carregando) carregar();
    },
  };
})();
