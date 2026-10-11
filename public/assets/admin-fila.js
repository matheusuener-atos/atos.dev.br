/* O painel da Atos, as filas de alteracoes e a secao Confirmar alteracoes. Porte da tela 13 do painel do PAVLVS
   (site/assets/admin.js do coryphaeus), sobre o contrato worker/admin-api.md do coryphaeus. Uma fila por lugar, a
   mesma regra: o que muda o que esta no ar entra na fila de quem mexeu e so acontece em "Commitar e pushar".

     a da Atos       /api/admin/alteracoes, /publicar, /retroagir   fixa: a equipe (equipe.papel, equipe.membro,
                                                                    equipe.areas) e o Login Atos (oauth.app,
                                                                    oauth.cliente); nada aqui vira commit: publica
                                                                    sem o GitHub
     a de um produto /api/admin/<id>/alteracoes, /publicar, ...     uma por produto do registro do servidor (GET
                                                                    /api/admin/eu, produtos: [{id, nome, github}]),
                                                                    montada quando a pessoa entra e mostrada so a
                                                                    quem tem a area <id>; com github: true, publicar
                                                                    e retroagir pedem o GitHub ligado

   Nenhum produto tem nome aqui. Cada tela de produto diz os tipos que poe na fila, pelos prefixos, ao carregar:

     AdminAtos.fila.tiposDo("<id>", ["conta.", "plano.", ...], {"conta.creditar": ["dono", "financeiro"], ...})

   (o terceiro argumento, opcional, e o papel que pode cada tipo, a tabela do contrato do produto; o que nao esta la,
   todos os papeis). A fila escolhe pelo prefixo; um tipo que nao e de ninguem, que casa com dois lugares ou que e de
   um produto fora do painel desta pessoa nao vai para fila nenhuma: o erro aparece na tela (aviso e Confirmar
   alteracoes), nunca em silencio. Prefixo repetido entre lugares tambem e erro, na hora de declarar.

   Acrescentar um produto: o registro no servidor (PRODUTOS em worker/admin.js, com o binding e o segredo) e a tela
   dele (public/assets/admin-<id>.js, que chama tiposDo). Nada muda neste arquivo.

   AdminAtos.fila e o que as outras secoes usam: pendentes (de todas as filas desta pessoa), naFila, ultima,
   enfileirar (escolhe a fila pelo tipo), pode (o papel que pode cada tipo), ouvir (redesenhar quando uma fila muda)
   e tiposDo. O GitHub: GET /api/admin/eu traz github: login|null; sem ele, a fila de produto com github prepara mas
   nao publica e a tela pede "Ligar o GitHub" (GET /api/admin/github/entrar?volta=<tela>, que volta ao painel). */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  // O papel que pode cada tipo; o que nao esta aqui, todos os papeis. Os da Atos aqui; os de cada produto, da tela
  // dele (tiposDo). O servidor decide de verdade.
  var PAPEIS = {
    "retroagir": ["dono"],
    "equipe.papel": ["dono"], "equipe.membro": ["dono"], "equipe.areas": ["dono"], "oauth.app": ["dono"], "oauth.cliente": ["dono"],
  };
  function novaFila(x) {
    return { id: x.id, nome: x.nome, area: x.area, base: x.base, github: Boolean(x.github), vazio: x.vazio,
      pendentes: [], publicacoes: [], lido: false, erro: "", carregando: false };
  }
  var ATOS = novaFila({ id: "atos", nome: "Atos", base: "/api/admin/", github: false, vazio: "Nada pendente na Atos (equipe e Login Atos)." });
  // As filas dos produtos entram antes da da Atos, na ordem do registro, quando a pessoa entra (montar).
  var FILAS = [ATOS];
  // Os prefixos de cada lugar: o da Atos, fixo; os dos produtos, das telas deles.
  var PREFIXOS = { atos: ["equipe.", "oauth."] };
  var PROBLEMAS = []; // o que nao vale (declaracao errada, tipo sem fila): aparece na tela
  var avisados = {};
  /* Um problema e dito uma vez (o aviso e a lista em Confirmar alteracoes); `sempre`: o aviso de novo (quem clicou). */
  function problema(texto, sempre) {
    var novo = !avisados[texto];
    if (novo) { avisados[texto] = true; PROBLEMAS.push(texto); if (window.console) console.error("fila de alterações: " + texto); }
    if ((novo || sempre) && A.quem) A.toast(texto, true);
  }
  function filaDe(id) { return FILAS.filter(function (f) { return f.id === id; })[0]; }
  /* As filas que esta pessoa ve: a da Atos (a equipe e o Login Atos) para todos; a de um produto, so com a area. */
  function minhas() { garantir(); return FILAS.filter(function (f) { return !f.area || A.temArea(f.area); }); }
  var montado = false;
  /* As filas dos produtos existem assim que se sabe quem esta (as secoes ja pintam antes do aoEntrar rodar). */
  function garantir() { if (!montado && A.quem) { montado = true; montar(A.quem); } }
  function montar(quem) {
    var ps = (quem && quem.produtos) || [];
    ps.forEach(function (p) {
      if (!p || !/^[a-z0-9-]{1,30}$/.test(String(p.id)) || p.id === "atos" || filaDe(p.id)) return;
      FILAS.splice(FILAS.length - 1, 0, novaFila({ id: p.id, nome: p.nome || p.id, area: p.id, base: "/api/admin/" + p.id + "/", github: p.github === true,
        vazio: "Nada pendente. O " + (p.nome || p.id) + " está igual ao que está no ar." }));
    });
    // Uma tela que declarou tipos para um produto que o servidor nao registrou: os tipos dela nao tem para onde ir.
    Object.keys(PREFIXOS).forEach(function (id) {
      if (id !== "atos" && !ps.some(function (p) { return p && p.id === id; })) problema("a tela do produto “" + id + "” declarou tipos, mas o painel não tem esse produto no registro (GET /api/admin/eu)");
    });
  }
  /* A fila do tipo: {fila} ou {erro}. Pelo prefixo declarado; nunca por palpite. */
  function lugarDo(tipo) {
    garantir();
    tipo = String(tipo || "");
    var donos = Object.keys(PREFIXOS).filter(function (id) { return PREFIXOS[id].some(function (p) { return tipo.indexOf(p) === 0; }); });
    if (!donos.length) return { erro: "a alteração “" + tipo + "” não é de nenhuma fila: a tela que a usa não declarou o tipo (AdminAtos.fila.tiposDo)" };
    if (donos.length > 1) return { erro: "a alteração “" + tipo + "” casa com mais de uma fila (" + donos.join(", ") + "): não vai para nenhuma" };
    var f = filaDe(donos[0]);
    if (!f) return { erro: "a alteração “" + tipo + "” é do produto “" + donos[0] + "”, que não está no registro do painel" };
    if (minhas().indexOf(f) < 0) return { erro: "a alteração “" + tipo + "” é do " + f.nome + ", e você não atua nele: peça ao dono para incluir a área" };
    return { fila: f };
  }
  function filaDoTipo(tipo) {
    var l = lugarDo(tipo);
    if (l.erro) problema(l.erro);
    return l.fila || null;
  }

  var F = A.fila = {
    filas: FILAS, ouvintes: [],
    get pendentes() { return minhas().reduce(function (l, f) { return l.concat(f.pendentes); }, []); },
    pode: function (tipo) { var p = PAPEIS[tipo]; return !p || Boolean(A.quem && p.indexOf(A.quem.papel) >= 0); },
    naFila: function (tipo, alvo) {
      var f = filaDoTipo(tipo);
      return Boolean(f) && f.pendentes.some(function (p) { return p.tipo === tipo && String(p.alvo) === String(alvo); });
    },
    ultima: function (tipo, alvo) {
      var r = null, f = filaDoTipo(tipo);
      if (f) f.pendentes.forEach(function (p) { if (p.tipo === tipo && (alvo == null || String(p.alvo) === String(alvo))) r = p; });
      return r;
    },
    ouvir: function (fn) { F.ouvintes.push(fn); },
    github: function () { return Boolean(A.quem && A.quem.github); },
    ligarGithub: function (volta) { location.assign("/api/admin/github/entrar?volta=" + encodeURIComponent(volta || A.secaoAtual() || "alteracoes")); },
    /* A tela de um produto diz os tipos dela: tiposDo(id, ["conta.", ...], {tipo: [papeis]}?). Prefixo que ja e de
       outro lugar (ou que contem / esta contido num dele) e recusado, com o erro na tela. */
    tiposDo: function (id, prefixos, papeis) {
      id = String(id || "");
      if (!/^[a-z0-9-]{1,30}$/.test(id) || id === "atos") { problema("tiposDo: “" + id + "” não é id de produto"); return false; }
      var meus = PREFIXOS[id] || (PREFIXOS[id] = []), ok = true;
      (prefixos || []).forEach(function (p) {
        p = String(p || "");
        if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.$/.test(p)) { problema("tiposDo(" + id + "): o prefixo “" + p + "” precisa terminar em ponto (ex.: “conta.”)"); ok = false; return; }
        var de = Object.keys(PREFIXOS).filter(function (outro) {
          return outro !== id && PREFIXOS[outro].some(function (q) { return q.indexOf(p) === 0 || p.indexOf(q) === 0; });
        });
        if (de.length) { problema("tiposDo(" + id + "): o prefixo “" + p + "” já é da fila " + de.join(", ")); ok = false; return; }
        if (meus.indexOf(p) < 0) meus.push(p);
      });
      Object.keys(papeis || {}).forEach(function (t) {
        if (!meus.some(function (p) { return t.indexOf(p) === 0; })) { problema("tiposDo(" + id + "): o papel de “" + t + "” é de um tipo fora dos prefixos dele"); ok = false; return; }
        if (Array.isArray(papeis[t])) PAPEIS[t] = papeis[t].slice();
      });
      return ok;
    },
    /* (para a tela e para conferir) a fila de um tipo, sem enfileirar: {fila: id} ou {erro} */
    lugar: function (tipo) { var l = lugarDo(tipo); return l.erro ? { erro: l.erro } : { fila: l.fila.id }; },
  };
  function mudou() {
    F.ouvintes.forEach(function (fn) { try { fn(); } catch (e) { /* uma secao nao derruba as outras */ } });
    A.atualizarNav();
    if (A.secaoAtual() === "alteracoes") pintar();
  }
  function carregarUma(f) {
    if (f.carregando) return f.promessa;
    f.carregando = true;
    f.promessa = A.pedir("GET", f.base + "alteracoes").then(function (d) {
      f.pendentes = d.pendentes || []; f.publicacoes = d.publicacoes || []; f.lido = true; f.erro = "";
    }, function (e) { if (e.status !== 401) f.erro = e.message; }).then(function () { f.carregando = false; mudou(); });
    return f.promessa;
  }
  F.carregar = function () { return Promise.all(minhas().map(carregarUma)); };
  /* Poe na fila (a do tipo): {tela, tipo, alvo, dados, texto} -> true/false. `texto` e a frase no passado da lista.
     O tipo sem fila nao vai a lugar nenhum: o erro aparece (aviso vermelho) e volta false. */
  F.enfileirar = function (tela, tipo, alvo, dados, texto, quieto) {
    var l = lugarDo(tipo);
    if (l.erro) { problema(l.erro, true); if (A.secaoAtual() === "alteracoes") pintar(); return Promise.resolve(false); }
    var f = l.fila;
    return A.pedir("POST", f.base + "alteracoes", { tela: tela, tipo: tipo, alvo: String(alvo), dados: dados, texto: texto }).then(function (r) {
      if (r.pendentes) f.pendentes = r.pendentes;
      if (!quieto) F.avisarFila();
      mudou();
      return true;
    }, function (e) {
      if (e.status !== 401) A.toast(e.message, true);
      return false;
    });
  };
  F.avisarFila = function () { A.toast('Na fila de alterações · <a href="#alteracoes" data-secao="alteracoes">Confirmar alterações</a>', false, true); };
  A.aoEntrar(function () {
    var antes = PROBLEMAS.length;
    garantir();
    // O que deu errado antes de entrar (as declaracoes) e dito agora (o que garantir() achou ja foi dito).
    if (antes) A.toast(PROBLEMAS[0] + (antes > 1 ? " (e mais " + (antes - 1) + " em Confirmar alterações)" : ""), true);
    F.carregar();
    // Na volta do GitHub (?github=1 ou ?erro=), a frase e dita e o endereco fica limpo.
    var u = new URL(location.href), erro = u.searchParams.get("erro");
    if (u.searchParams.get("github") === "1" || erro) {
      A.toast(erro ? "GitHub: " + erro : "GitHub ligado. Agora é só confirmar de novo.", Boolean(erro));
      u.searchParams.delete("github"); u.searchParams.delete("erro");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
    }
  });

  /* ------------------------------------------------------------ a secao */
  var S = { raiz: null };
  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }

  function blocoFila(f) {
    var gh = F.github(), ps = f.pendentes, pubs = f.publicacoes || [], precisaGh = f.github && !gh;
    var h = '<h2 class="titulo-secao pv-h2"><span>' + esc(f.nome) + " · " + ps.length + (ps.length === 1 ? " pendente" : " pendentes") + "</span></h2>";
    if (!f.lido) return h + '<div class="card"><p class="vazio">' + (f.erro ? "Não consegui ler esta fila agora: " + esc(f.erro) + ' <button type="button" class="link" data-fila="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    if (f.erro) h += '<p class="nf-aviso"><span>Não consegui atualizar esta fila agora: ' + esc(f.erro) + ". Mostrando a última leitura.</span></p>";
    h += '<div class="card">' + (ps.length ? ps.map(function (a) {
      return '<div class="item fila-item"><span class="pv-mudo pv-num">' + esc(U.quandoCurto(a.quando)) + '</span><span class="nf-tag">' + esc(A.nomeDaSecao(a.tela)) + "</span>" +
        '<span class="nome"><strong>' + esc(a.texto) + "</strong></span>" +
        '<button type="button" class="btn mini" data-fila="tirar" data-f="' + f.id + '" data-id="' + esc(a.id) + '" aria-label="Tirar da fila: ' + esc(a.texto) + '">Tirar</button></div>';
    }).join("") : '<p class="vazio">' + esc(f.vazio) + "</p>") + "</div>";
    h += '<div class="botoes pv-botoes-fora">' +
      (precisaGh ? '<button type="button" class="btn p primario" data-fila="github">Ligar o GitHub</button><button type="button" class="btn p" disabled title="ligue o GitHub para publicar">Commitar e pushar</button>'
        : '<button type="button" class="btn p primario" data-fila="commit" data-f="' + f.id + '"' + (ps.length ? "" : " disabled") + ">Commitar e pushar</button>") +
      '<span class="dica">' + (f.github ? "aplica cada alteração na ordem e registra a publicação" : "aplica na hora, sem commit no GitHub") + "</span></div>";
    var podeR = F.pode("retroagir");
    if (pubs.length) {
      h += '<div class="card pv-topo">' + '<div class="pv-card-cab"><span class="titulo-secao">Publicações anteriores</span></div>' + pubs.map(function (p, i) {
        var motivo = !podeR ? "só o papel Dono retroage" : f.github && !gh ? "ligue o GitHub para retroagir" : p.retroagivel === false ? "esta publicação não tem como voltar" : "";
        return '<div class="item fila-item"><span class="pv-mudo pv-num">' + esc(U.quando(p.quando)) + '</span><span class="pv-num">' + esc(String(p.commit || "").slice(0, 8)) + "</span>" +
          '<span class="nome"><strong>' + esc(p.resumo) + "</strong><small>" + (p.n || 0) + (p.n === 1 ? " alteração" : " alterações") + (p.por ? " · " + esc(p.por) : "") +
          (p.revertida ? " · retroagida " + esc(U.quando(p.revertida.quando)) : "") + "</small></span>" +
          (p.revertida ? '<span class="pv-mudo">retroagida</span>' : '<button type="button" class="btn mini" data-fila="retroagir" data-f="' + f.id + '" data-i="' + i + '"' + (motivo ? ' disabled title="' + esc(motivo) + '"' : "") + ">Retroagir</button>") + "</div>";
      }).join("") + "</div>";
    }
    return h;
  }
  function tela() {
    var gh = F.github();
    var h = "<h1>Confirmar alterações</h1>" +
      '<p class="descricao">Tudo o que muda o que está no ar fica aqui até publicar. Publicar aplica em ordem, uma depois da outra; a que falha não desfaz as outras e volta para a fila com o motivo.</p>';
    // O que nao foi para fila nenhuma (tipo sem dono, declaracao errada): dito aqui tambem, para nao sumir com o aviso.
    if (PROBLEMAS.length) h += '<div class="nf-aviso fila-problemas" role="alert"><span><strong>Alterações sem fila.</strong> ' + PROBLEMAS.map(esc).join(" · ") + "</span></div>";
    var comGh = minhas().filter(function (f) { return f.github; });
    if (!comGh.length) return h + minhas().map(blocoFila).join("");
    var nomes = comGh.map(function (f) { return f.nome; }), quais = nomes.length > 1 ? nomes.slice(0, -1).join(", ") + " e " + nomes[nomes.length - 1] : nomes[0];
    var semGh = minhas().filter(function (f) { return !f.github; }).map(function (f) { return f.nome; });
    h += gh ? '<p class="nf-aviso ok fila-gh"><span>GitHub ligado nesta sessão: <strong>' + esc(A.quem.github) + "</strong>. Você pode publicar e retroagir: " + esc(quais) + ".</span></p>"
      : '<p class="nf-aviso fila-gh"><span>Para publicar ou retroagir ' + esc(quais) + ", o painel precisa do seu GitHub. Sem ele, você prepara a fila, mas não publica." +
        (semGh.length ? " " + (semGh.length > 1 ? "As filas de " : "A fila da ") + esc(semGh.join(", ")) + " não " + (semGh.length > 1 ? "precisam" : "precisa") + "." : "") + "</span>" +
        '<button type="button" class="btn p primario" data-fila="github">Ligar o GitHub</button></p>';
    return h + minhas().map(blocoFila).join("");
  }

  /* ------------------------------------------------------------ os pop-ups: publicar e retroagir */
  var P = null; // {tipo: "commit"|"retroagir", f, texto, enviando, erro, resultado, itens, pub}
  function pedeGitHub(e) { return e && e.status === 403 && e.dados && e.dados.passo === "github"; }
  function modalHtml() {
    var f = P.f, cab = function (t) { return '<h2 id="modal-titulo">' + esc(t) + "</h2>"; };
    var pe = function (botao) { return '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button>' + botao + "</div>"; };
    if (P.tipo === "commit" && P.resultado) {
      var R = P.resultado, rs = R.resultados || [], falhas = rs.filter(function (x) { return !x.ok; }), avisos = rs.filter(function (x) { return x.ok && x.aviso; });
      var porId = {}; (P.itens || []).forEach(function (a) { porId[a.id] = a; });
      return cab("Commitar e pushar · " + f.nome) + "<p><strong>" + (rs.length - falhas.length) + " de " + rs.length + "</strong> alterações foram para o ar" +
        (R.publicacao && R.publicacao.commit ? " (" + esc(String(R.publicacao.commit).slice(0, 8)) + ")" : "") + ".</p>" +
        (falhas.length ? '<div class="pv-lista-modal"><span class="titulo-secao">Falharam</span>' + falhas.map(function (x) { var a = porId[x.id]; return '<p class="erro">' + esc((a ? a.texto : x.id) + ": " + (x.erro || "sem motivo")) + "</p>"; }).join("") +
          '<p class="dica">As que falharam continuam na fila; as outras não são desfeitas.</p></div>' : "") +
        (avisos.length ? '<div class="pv-lista-modal"><span class="titulo-secao">Feitas, com aviso</span>' + avisos.map(function (x) { var a = porId[x.id]; return "<p>" + esc((a ? a.texto : x.id) + ": " + x.aviso) + "</p>"; }).join("") + "</div>" : "") +
        '<div class="botoes"><button type="button" class="btn p primario" data-admin="fechar-modal" data-foco>Fechar</button></div>';
    }
    if (P.tipo === "commit") {
      var ps = f.pendentes, okT = P.texto.trim() === "comitar e pushar";
      return cab("Commitar e pushar · " + f.nome) + "<p><strong>" + ps.length + (ps.length === 1 ? " alteração vai" : " alterações vão") + "</strong> para o ar, uma depois da outra. Se uma falhar, as outras ficam feitas e ela volta para a fila com o motivo.</p>" +
        '<div class="pv-lista-modal">' + ps.slice(0, 5).map(function (a) { return "<p>— " + esc(a.texto) + "</p>"; }).join("") + (ps.length > 5 ? '<p class="dica">+ ' + (ps.length - 5) + " alterações</p>" : "") + "</div>" +
        '<label class="campo"><span class="rotulo">Digite <code>comitar e pushar</code> para confirmar</span><input id="fila-confirma" data-fila-in="texto" value="' + esc(P.texto) + '" autocomplete="off" spellcheck="false" autocapitalize="none"></label>' +
        (P.erro ? '<p class="erro" role="alert">' + esc(P.erro) + "</p>" : "") +
        pe('<button type="button" class="btn p primario" id="fila-ok" data-fila="publicar"' + (P.enviando || !okT ? " disabled" : "") + ">" + (P.enviando ? "Publicando…" : "Commitar e pushar") + "</button>");
    }
    var pub = P.pub, okR = P.texto.trim() === "retroagir";
    return cab("Retroagir publicação · " + f.nome) + "<p>Desfaz a publicação de <strong>" + esc(U.quando(pub.quando)) + "</strong>" + (pub.commit ? " (" + esc(String(pub.commit).slice(0, 8)) + ")" : "") + ": " +
      (pub.n || 0) + (pub.n === 1 ? " alteração volta" : " alterações voltam") + " ao estado de antes" + (f.github ? "; as que viraram commit na main voltam num commit de reversão" : "") +
      ". É tudo ou nada: se uma não puder voltar, nada muda e a tela diz por quê.</p>" +
      '<div class="pv-lista-modal"><p>— ' + esc(pub.resumo || "") + "</p></div>" +
      '<p class="dica">O que já saiu para fora não volta: e-mails enviados continuam enviados.</p>' +
      '<label class="campo"><span class="rotulo">Digite <code>retroagir</code> para confirmar</span><input id="fila-confirma" data-fila-in="texto" value="' + esc(P.texto) + '" autocomplete="off" spellcheck="false" autocapitalize="none"></label>' +
      (P.erro ? '<p class="erro" role="alert">' + esc(P.erro) + "</p>" : "") +
      pe('<button type="button" class="btn p perigo" id="fila-ok" data-fila="retroagir-ok"' + (P.enviando || !okR ? " disabled" : "") + ">" + (P.enviando ? "Retroagindo…" : "Retroagir") + "</button>");
  }
  function abrir(p) { P = p; A.modal.abrir({ html: modalHtml, aoFechar: function () { P = null; } }); }
  function publicar() {
    if (!P || P.enviando || P.texto.trim() !== "comitar e pushar") return;
    var esta = P, f = P.f;
    P.enviando = true; P.erro = ""; P.itens = f.pendentes.slice(); A.modal.repintar();
    A.pedir("POST", f.base + "publicar", { confirmacao: "comitar e pushar" }).then(function (r) {
      if (P !== esta) return;
      P.enviando = false;
      var rs = r.resultados || [];
      A.toast("Publicado" + (r.publicacao && r.publicacao.commit ? " · " + String(r.publicacao.commit).slice(0, 8) : ""));
      // Com falha ou com aviso, o resultado fica aberto para ler.
      if (rs.some(function (x) { return !x.ok || x.aviso; })) { P.resultado = r; A.modal.repintar(); } else A.modal.fechar();
      carregarUma(f);
    }, function (e) {
      if (P !== esta) return;
      if (pedeGitHub(e)) { F.ligarGithub("alteracoes"); return; }
      P.enviando = false; P.erro = e.status === 401 ? "" : e.message; A.modal.repintar();
    });
  }
  function retroagir() {
    if (!P || P.enviando || P.texto.trim() !== "retroagir") return;
    var esta = P, f = P.f;
    P.enviando = true; P.erro = ""; A.modal.repintar();
    A.pedir("POST", f.base + "retroagir", { commit: esta.pub.commit, publicacao: esta.pub.id, confirmacao: "retroagir" }).then(function (r) {
      if (P !== esta) return;
      A.toast("Retroagido" + (r.commit ? " · " + String(r.commit).slice(0, 8) : "") + ((r.avisos || []).length ? ". " + r.avisos.join(" ") : ""));
      A.modal.fechar();
      carregarUma(f);
    }, function (e) {
      if (P !== esta) return;
      if (pedeGitHub(e)) { F.ligarGithub("alteracoes"); return; }
      P.enviando = false; P.erro = e.status === 401 ? "" : e.message; A.modal.repintar();
    });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-fila]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-fila"), f = filaDe(b.getAttribute("data-f"));
    if (a === "github") F.ligarGithub("alteracoes");
    else if (a === "recarregar") { F.carregar(); pintar(); }
    else if (a === "tirar" && f) {
      b.disabled = true;
      A.pedir("DELETE", f.base + "alteracoes/" + encodeURIComponent(b.getAttribute("data-id"))).then(function (r) {
        f.pendentes = r.pendentes || []; A.toast("Tirei da fila"); mudou();
      }, function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
    } else if (a === "commit" && f) { if (f.pendentes.length) abrir({ tipo: "commit", f: f, texto: "", enviando: false, erro: "" }); }
    else if (a === "publicar") publicar();
    else if (a === "retroagir" && f) { var p = f.publicacoes[Number(b.getAttribute("data-i"))]; if (p) abrir({ tipo: "retroagir", f: f, pub: p, texto: "", enviando: false, erro: "" }); }
    else if (a === "retroagir-ok") retroagir();
  });
  document.addEventListener("input", function (e) {
    var el = e.target.closest("[data-fila-in]");
    if (!el || !P) return;
    P.texto = el.value; P.erro = "";
    var ok = document.getElementById("fila-ok");
    if (ok) ok.disabled = P.enviando || P.texto.trim() !== (P.tipo === "commit" ? "comitar e pushar" : "retroagir");
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || !P || e.target.id !== "fila-confirma") return;
    e.preventDefault();
    if (P.tipo === "commit") publicar(); else retroagir();
  });

  A.secoes.push({
    id: "alteracoes",
    nome: "Confirmar alterações",
    grupo: "Atos",
    ordem: 30,
    contagem: function () { return F.pendentes.length; },
    desenhar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (minhas().some(function (f) { return !f.lido && !f.carregando; })) F.carregar();
    },
  });
})();
