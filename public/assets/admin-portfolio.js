/* O painel da Atos, grupo Atos, secao Portfolio: os projetos da home (atos.dev.br/#projetos), cadastrados a partir de um
   repositorio do GitHub, com o login social (Entrar com Atos) e a venda (Atos Cobranca) de cada um. O servidor e o
   worker/portfolio.js; so o papel dono (o servidor confere de novo). Tudo vale na hora, sem a fila; o login, depois de
   ligado, muda no Login Atos (pela fila).

     GET  /api/admin/portfolio                          a tela
     GET  /api/admin/portfolio/github/repos             os repositorios que o GitHub App enxerga
     GET  /api/admin/portfolio/github/conectar          (navegacao) instalar o app ou mudar os repositorios liberados
     POST /api/admin/portfolio/github/desconectar
     POST /api/admin/portfolio/projetos[/:id]           criar ou mudar; volta {segredo} quando a venda acaba de ligar
     POST /api/admin/portfolio/projetos/:id/(mover|segredo|apagar) */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var ICONE_MAX = 30 * 1024;
  var PRIVACIDADE = "https://atos.dev.br/privacidade/", TERMOS = "https://atos.dev.br/termos/";
  var S = { raiz: null, dados: null, erro: "", carregando: false, repos: null, reposErro: "", form: null, seg: null, apagar: null };

  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }
  function carregar() {
    S.carregando = true;
    A.pedir("GET", "/api/admin/portfolio").then(function (d) { S.dados = d; S.erro = ""; }, function (e) { if (e.status !== 401) S.erro = e.message; })
      .then(function () { S.carregando = false; pintar(); });
  }
  function carregarRepos() {
    S.repos = null; S.reposErro = "";
    A.pedir("GET", "/api/admin/portfolio/github/repos").then(function (d) { S.repos = d.repos || []; }, function (e) { S.repos = []; S.reposErro = e.status === 401 ? "" : e.message; })
      .then(function () { if (A.modal.atual() && S.form) A.modal.repintar(); });
  }
  function projeto(id) { return ((S.dados || {}).projetos || []).filter(function (p) { return p.id === id; })[0] || null; }

  /* R$ <-> centavos: "29,90" -> 2990; vazio -> null. */
  function centavos(t) {
    t = String(t == null ? "" : t).trim().replace(/^R\$\s*/, "").replace(/\./g, "").replace(",", ".");
    if (!t) return null;
    var n = Math.round(Number(t) * 100);
    return isFinite(n) ? n : NaN;
  }
  function reais(c) { return c == null ? "" : (c / 100).toFixed(2).replace(".", ","); }

  function icone(p, classe) {
    if (p.icone) return '<img class="logo' + (classe ? " " + classe : "") + '" src="' + esc(p.icone) + '" alt="" width="32" height="32">';
    return '<span class="logo inicial' + (classe ? " " + classe : "") + '" aria-hidden="true">' + esc(String(p.nome || p.id || "?").trim().charAt(0).toUpperCase()) + "</span>";
  }

  /* ------------------------------------------------------------ a tela */
  function blocoGitHub() {
    var g = S.dados.github;
    if (!g.configurado) {
      return '<div class="card"><p class="vazio">O GitHub App do Portfólio ainda não está no Worker: faltam GITHUB_APP_ID, GITHUB_APP_SLUG (vars) e o segredo GITHUB_APP_CHAVE. Sem ele, dá para cadastrar projetos à mão, sem a lista de repositórios.</p></div>';
    }
    if (!g.conectado) {
      return '<div class="card"><div class="item"><span class="nome"><strong>GitHub não conectado</strong><small>Instale o app na sua conta do GitHub e escolha os repositórios (públicos e privados). Ele só lê nome, descrição, site, tópicos e linguagem; não lê código nem escreve.</small></span>' +
        '<span class="pv-par"><a class="btn mini primario" href="/api/admin/portfolio/github/conectar">Conectar o GitHub</a></span></div></div>';
    }
    var c = g.conectado;
    return '<div class="card"><div class="item"><span class="nome"><strong>GitHub · ' + esc(c.conta) + ' <span class="pv-sit ok">conectado</span></strong><small>' +
      (c.selecao === "all" ? "Todos os repositórios da conta" : "Só os repositórios escolhidos no GitHub") + " · desde " + esc(U.quando(c.quando)) + " · por " + esc(c.por) + "</small></span>" +
      '<span class="pv-par"><a class="btn mini" href="/api/admin/portfolio/github/conectar">Mudar os repositórios</a><button type="button" class="btn mini" data-pf="desconectar">Desconectar</button></span></div></div>';
  }
  function linhaFixa(f, n) {
    return '<div class="oa-cliente"><div class="item oa-item"><span class="logo inicial" aria-hidden="true">' + esc(f.nome.charAt(0)) + '</span><span class="nome"><strong>' + esc(f.nome) +
      ' <span class="nf-tag">' + U.pad(n) + '</span> <span class="pv-sit">do código</span></strong><small>Muda em ' + esc(f.onde) + "</small></span></div></div>";
  }
  function linha(p, i, total) {
    var tags = (p.publicado ? '<span class="pv-sit ok">na home</span>' : '<span class="pv-sit">fora da home</span>') +
      (p.login ? ' <span class="pv-sit">login</span>' : "") +
      (p.produto ? (p.produto.aberto ? ' <span class="pv-sit ok">vendendo</span>' : ' <span class="pv-sit">venda fechada</span>') : "") +
      (p.repo && p.repo.privado ? ' <span class="pv-sit">repositório privado</span>' : "");
    var sub = esc(p.descricao) + (p.repo ? " · " + esc(p.repo.nome) : "") + (p.site ? " · " + esc(p.site) : "");
    var det = "";
    if (p.login || p.produto) {
      det = '<div class="nf-det"><dl class="nf-info">' +
        (p.login ? "<dt>Login</dt><dd>aplicativo <code>" + esc(p.login.app) + "</code>, acesso público <code>" + esc(p.login.cliente) + '</code> (PKCE). Voltas, origens e quem entra mudam no <a href="#login-atos" data-secao="login-atos">Login Atos</a>.</dd>' : "") +
        (p.produto ? "<dt>Checkout</dt><dd><code>atos.dev.br" + esc(p.produto.checkout) + "</code></dd>" +
          "<dt>Eventos</dt><dd>" + esc(p.produto.eventos) + "</dd>" +
          "<dt>Segredo</dt><dd>" + (p.produto.segredo ? "gerado " + esc(U.quando(p.produto.segredo.quando)) + " por " + esc(p.produto.segredo.por) : "nenhum") +
          ' <button type="button" class="link" data-pf="segredo" data-id="' + esc(p.id) + '">Gerar outro</button></dd>' +
          "<dt>Planos</dt><dd>" + p.produto.planos.map(function (pl) {
            var m = precoAtivo(p, pl.plano, "mes"), a = precoAtivo(p, pl.plano, "ano");
            return esc(pl.nome) + ": " + [m ? U.brl(m.centavos / 100) + "/mês" : "", a ? U.brl(a.centavos / 100) + "/ano" : ""].filter(Boolean).join(" · ");
          }).join("<br>") + "</dd>" : "") +
        "</dl></div>";
    }
    return '<div class="oa-cliente"><div class="item oa-item">' + icone(p) + '<span class="nome"><strong>' + esc(p.nome) + ' <span class="nf-tag">' + esc(p.id) + "</span> " + tags + "</strong><small>" + sub + "</small></span>" +
      '<span class="pv-par"><button type="button" class="btn mini" data-pf="mover" data-para="cima" data-id="' + esc(p.id) + '"' + (i === 0 ? " disabled" : "") + ' aria-label="Subir">↑</button>' +
      '<button type="button" class="btn mini" data-pf="mover" data-para="baixo" data-id="' + esc(p.id) + '"' + (i === total - 1 ? " disabled" : "") + ' aria-label="Descer">↓</button>' +
      '<button type="button" class="btn mini" data-pf="editar" data-id="' + esc(p.id) + '">Editar</button>' +
      (p.produto ? "" : '<button type="button" class="btn mini perigo" data-pf="apagar" data-id="' + esc(p.id) + '">Apagar</button>') + "</span></div>" + det + "</div>";
  }
  function precoAtivo(p, plano, periodo) {
    return (p.produto.precos || []).filter(function (x) { return x.ativo !== false && (x.metadados || {}).plano === plano && x.periodo === periodo; })[0] || null;
  }
  function tela() {
    var h = "<h1>Portfólio</h1>" +
      '<p class="descricao">Os projetos da home (atos.dev.br, “Projetos”), a partir dos seus repositórios do GitHub. Cada um pode ligar o login social (Entrar com Atos) e a venda pela Atos Cobrança. Vale na hora, sem a fila.</p>';
    if (!S.dados) return h + '<div class="card"><p class="vazio">' + (S.erro ? "Não consegui ler o Portfólio agora: " + esc(S.erro) + ' <button type="button" class="link" data-pf="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    // O motivo que volta do GitHub (?erro=): mostrado uma vez, e sai do endereco.
    var erroUrl = new URLSearchParams(location.search).get("erro");
    if (erroUrl) { S.erroGitHub = erroUrl; history.replaceState(null, "", "/admin/" + location.hash); }
    if (S.erroGitHub) h += '<p class="erro" role="alert">' + esc(S.erroGitHub) + "</p>";
    h += '<h2 class="titulo-secao">GitHub</h2>' + blocoGitHub();
    var l = S.dados.projetos || [];
    h += '<div class="pf-titulo"><h2 class="titulo-secao">Na home, nesta ordem</h2><button type="button" class="btn mini primario" data-pf="novo">Novo projeto</button></div>';
    h += '<div class="card">' + S.dados.fixos.map(function (f, i) { return linhaFixa(f, i + 1); }).join("") + l.map(function (p, i) { return linha(p, i, l.length); }).join("") + "</div>";
    if (S.dados.semente) h += '<p class="nota">Estes são os projetos que já estavam escritos na home. A primeira mudança que você fizer aqui passa a valer no lugar deles.</p>';
    if (!S.dados.venda_ligada) h += '<p class="nota">Para vender pela Atos, falta o segredo PORTFOLIO_CHAVE no Worker: é com ele que o segredo dos eventos de cada produto fica cifrado.</p>';
    var reg = S.dados.registro || [];
    if (reg.length) {
      h += '<h2 class="titulo-secao">Registro</h2><div class="card"><dl class="nf-info">' + reg.slice(0, 12).map(function (x) {
        return "<dt>" + esc(U.quando(x.quando)) + "</dt><dd>" + esc(x.por) + (x.projeto ? " · " + esc(x.projeto) : "") + ": " + esc(x.oque) + "</dd>";
      }).join("") + "</dl></div>";
    }
    return h + '<p class="nota">Um projeto que vende não se apaga: quem pagou depende dele. Feche a venda e tire da home. A home e o checkout de outros servidores da Cloudflare veem a mudança em até um minuto.</p>';
  }

  /* ------------------------------------------------------------ o formulario */
  function novoForm(p) {
    var x = p || {};
    var plano = function (pl) {
      return { plano: pl.plano, nome: pl.nome, descricao: pl.descricao || "", mes: reais((precoAtivo(x, pl.plano, "mes") || {}).centavos), ano: reais((precoAtivo(x, pl.plano, "ano") || {}).centavos) };
    };
    return {
      criar: !p, erro: "", enviando: false,
      v: {
        id: x.id || "", nome: x.nome || "", descricao: x.descricao || "", plataforma: x.plataforma || "", site: x.site || "", icone: x.icone || "",
        repo: x.repo || null, mostrar_repo: x.mostrar_repo !== false, publicado: p ? x.publicado === true : true,
        login: false, voltas: "", origens: "", privacidade: PRIVACIDADE, termos: TERMOS, acesso: "todos",
        vender: Boolean(x.produto), eventos: x.produto ? x.produto.eventos : "", voltasVenda: x.produto ? (x.produto.voltas || []).join("\n") : "",
        aberto: Boolean(x.produto && x.produto.aberto),
        planos: x.produto ? x.produto.planos.map(plano) : [{ plano: "basico", nome: "Básico", descricao: "", mes: "", ano: "" }],
      },
      tinhaLogin: Boolean(x.login), tinhaVenda: Boolean(x.produto), idTocado: Boolean(p),
    };
  }
  function campo(rotulo, k, valor, extra, dica) {
    return '<label class="campo"><span class="rotulo">' + esc(rotulo) + '</span><input id="pf-' + k + '" data-pf-in="' + k + '" value="' + esc(valor == null ? "" : valor) + '" autocomplete="off" spellcheck="false"' + (extra || "") + ">" +
      (dica ? '<span class="dica">' + esc(dica) + "</span>" : "") + "</label>";
  }
  function area(rotulo, k, valor, dica) {
    return '<label class="campo"><span class="rotulo">' + esc(rotulo) + '</span><textarea id="pf-' + k + '" data-pf-in="' + k + '" spellcheck="false">' + esc(valor || "") + "</textarea>" +
      (dica ? '<span class="dica">' + esc(dica) + "</span>" : "") + "</label>";
  }
  function marcar(k, ligado, texto, desligado) {
    return '<label class="nf-marcar oa-marcar"><input type="checkbox" id="pf-' + k + '" data-pf-in="' + k + '"' + (ligado ? " checked" : "") + (desligado ? " disabled" : "") + "><span>" + texto + "</span></label>";
  }
  function seletorRepo(v) {
    var g = S.dados.github;
    if (!g.conectado) return '<p class="nota">Sem o GitHub conectado, o projeto fica sem repositório' + (g.configurado ? ': conecte na tela do Portfólio para escolher um.' : ".") + "</p>";
    if (S.repos === null) return '<p class="nota">Lendo os repositórios do GitHub…</p>';
    if (S.reposErro) return '<p class="erro">' + esc(S.reposErro) + ' <button type="button" class="link" data-pf="repos">Tentar de novo</button></p>';
    var atual = v.repo ? v.repo.nome : "";
    var temAtual = !atual || S.repos.some(function (r) { return r.nome === atual; });
    return '<label class="campo"><span class="rotulo">Repositório</span><select class="seletor" id="pf-repo" data-pf-in="repo"><option value="">— sem repositório —</option>' +
      (temAtual ? "" : '<option value="' + esc(atual) + '" selected>' + esc(atual) + " (não está mais liberado ao app)</option>") +
      S.repos.map(function (r) {
        return '<option value="' + esc(r.nome) + '"' + (r.nome === atual ? " selected" : "") + ">" + esc(r.nome + (r.privado ? " · privado" : "") + (r.arquivado ? " · arquivado" : "")) + "</option>";
      }).join("") + "</select><span class=\"dica\">Escolher preenche o nome, a descrição, o site e a plataforma com o que está no GitHub (dá para mudar).</span></label>";
  }
  function linhaPlano(pl, i) {
    return '<div class="pf-plano">' +
      campo("Código", "plano." + i + ".plano", pl.plano, ' maxlength="24"') + campo("Nome", "plano." + i + ".nome", pl.nome, ' maxlength="40"') +
      campo("R$ por mês", "plano." + i + ".mes", pl.mes, ' inputmode="decimal" placeholder="vazio = sem mensal"') + campo("R$ por ano", "plano." + i + ".ano", pl.ano, ' inputmode="decimal" placeholder="vazio = sem anual"') +
      campo("O que inclui (aparece no checkout)", "plano." + i + ".descricao", pl.descricao, ' maxlength="120"') +
      '<button type="button" class="btn mini" data-pf="tirar-plano" data-i="' + i + '"' + (S.form.v.planos.length === 1 ? " disabled" : "") + ">Tirar</button></div>";
  }
  function modalForm() {
    var X = S.form, v = X.v;
    var h = '<h2 id="modal-titulo">' + (X.criar ? "Novo projeto" : "Editar " + esc(v.nome)) + "</h2>" + seletorRepo(v) +
      (X.criar ? campo("Id (não muda depois; vira atos.dev.br/<id>/assinar)", "id", v.id, ' maxlength="31"') : "") +
      campo("Nome", "nome", v.nome, ' maxlength="60"') + area("O que é (uma frase; aparece no cartão da home)", "descricao", v.descricao) +
      campo("Plataforma (ex.: Web, Windows, Python)", "plataforma", v.plataforma, ' maxlength="40"') + campo("Site (https, opcional)", "site", v.site, ' type="url"') +
      '<div class="campo"><span class="rotulo">Ícone (opcional)</span><div class="oa-icone">' + icone({ icone: v.icone, nome: v.nome || v.id }) +
      '<label class="btn mini nf-arquivo"><span>Escolher imagem</span><input type="file" accept="image/png,image/jpeg,image/webp" data-pf-arq="icone"></label>' +
      (v.icone ? '<button type="button" class="btn mini" data-pf="sem-icone">Tirar o ícone</button>' : "") + '</div><span class="dica">PNG, JPEG ou WebP de até 30 KB, quadrada. Sem ícone, aparece a inicial.</span></div>' +
      marcar("publicado", v.publicado, "Mostrar na home") +
      (v.repo ? marcar("mostrar_repo", v.repo.privado ? false : v.mostrar_repo, v.repo.privado ? "Botão GitHub no cartão (o repositório é privado: nunca aparece)" : "Botão GitHub no cartão", v.repo.privado) : "");

    h += '<h3 class="oa-h3">Login social (Entrar com Atos)</h3>';
    if (X.tinhaLogin) h += '<p class="nota">Ligado. Voltas, origens e quem entra mudam no Login Atos, pela fila.</p>';
    else {
      h += marcar("login", v.login, "Ligar o login: cria o aplicativo <code>" + esc(v.id || "id") + "</code> e o acesso público <code>" + esc((v.id || "id") + "-web") + "</code> (PKCE)");
      if (v.login) {
        h += area("Endereços de volta (um por linha)", "voltas", v.voltas, "Exatamente como o sistema manda em redirect_uri: https; sem #.") +
          area("Origens para CORS (uma por linha, opcional)", "origens", v.origens, "Só se a página troca o código no navegador (ex.: https://exemplo.com.br).") +
          campo("Política de privacidade (https)", "privacidade", v.privacidade, ' type="url"') + campo("Termos de uso (https)", "termos", v.termos, ' type="url"') +
          '<div class="campo"><span class="rotulo">Quem pode entrar</span><div class="opcoes" role="group" aria-label="Quem pode entrar">' +
          '<button type="button" data-pf="acesso" data-v="todos" aria-pressed="' + (v.acesso === "todos") + '">Qualquer Conta Atos</button>' +
          '<button type="button" data-pf="acesso" data-v="liberados" aria-pressed="' + (v.acesso !== "todos") + '">Só liberados (a lista fica no Login Atos)</button></div></div>';
      }
    }

    h += '<h3 class="oa-h3">Venda (Atos Cobrança)</h3>';
    h += marcar("vender", v.vender, X.tinhaVenda ? "Vende pela Atos (não desliga: quem pagou depende do produto)" : "Vender pela Atos: checkout em atos.dev.br/" + esc(v.id || "id") + "/assinar", X.tinhaVenda);
    if (v.vender) {
      h += campo("Endereço que recebe os eventos (https)", "eventos", v.eventos, ' type="url"', "A Atos manda direito.atualizado e credito.adicionado, assinados (Atos-Assinatura), com o segredo que aparece ao salvar.") +
        area("Para onde a pessoa pode voltar depois de pagar (um por linha, opcional)", "voltasVenda", v.voltasVenda, "O site do projeto sempre vale.") +
        '<div class="campo"><span class="rotulo">Planos</span>' + v.planos.map(linhaPlano).join("") +
        '<div><button type="button" class="btn mini" data-pf="mais-plano"' + (v.planos.length >= 6 ? " disabled" : "") + ">Mais um plano</button></div>" +
        '<span class="dica">Mensal: assinatura no cartão ou um mês no Pix. Anual: cartão ou Pix, de uma vez. Mudar um valor cria outra versão do preço: quem já assinou continua no dele.</span></div>' +
        marcar("aberto", v.aberto, "Vendendo: o checkout aceita pagamento e o cartão da home mostra “Assinar”");
    }
    h += (X.erro ? '<p class="erro" role="alert">' + esc(X.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button><button type="button" class="btn p primario" data-pf="salvar"' + (X.enviando ? " disabled" : "") + ">" +
      (X.enviando ? "Salvando…" : "Salvar") + "</button></div>";
    return h;
  }
  function corpoDoForm() {
    var v = S.form.v, d = {
      id: v.id.trim(), nome: v.nome, descricao: v.descricao, plataforma: v.plataforma, site: v.site.trim(), icone: v.icone, repo: v.repo,
      mostrar_repo: v.mostrar_repo, publicado: v.publicado,
    };
    if (!S.form.tinhaLogin && v.login) d.login = { criar: true, voltas: v.voltas, origens: v.origens, privacidade: v.privacidade.trim(), termos: v.termos.trim(), acesso: v.acesso };
    if (v.vender) {
      var planos = v.planos.map(function (pl) { return { plano: pl.plano.trim(), nome: pl.nome, descricao: pl.descricao, mes: centavos(pl.mes), ano: centavos(pl.ano) }; });
      var ruim = planos.filter(function (pl) { return isNaN(pl.mes) || isNaN(pl.ano); })[0];
      if (ruim) return { erro: "o valor do plano " + (ruim.nome || ruim.plano) + " não é um número (ex.: 29,90)" };
      d.produto = { eventos: v.eventos.trim(), voltas: v.voltasVenda, aberto: v.aberto, planos: planos };
    }
    return d;
  }

  /* ------------------------------------------------------------ os outros pop-ups */
  function modalSegredo() {
    var G = S.seg;
    if (G.valor) {
      return '<h2 id="modal-titulo">O segredo dos eventos de ' + esc(G.id) + "</h2>" +
        "<p>Ele aparece só agora. Guarde no sistema do projeto: é com ele que o sistema confere a Atos-Assinatura dos eventos (HMAC-SHA256 de “&lt;t&gt;.&lt;corpo&gt;”, até 5 minutos) e se autentica em /api/cobranca/v1/direitos (Bearer).</p>" +
        '<label class="campo"><span class="rotulo">Segredo</span><input id="pf-segredo" class="seletor" readonly value="' + esc(G.valor) + '" data-foco></label>' +
        '<div class="botoes"><button type="button" class="btn p" data-pf="copiar">Copiar</button><button type="button" class="btn p primario" data-admin="fechar-modal">Pronto</button></div>';
    }
    return '<h2 id="modal-titulo">Gerar outro segredo para ' + esc(G.id) + "</h2><p>O anterior para de valer na hora: os eventos seguintes saem assinados com o novo, e o sistema que ainda usa o antigo recusa até receber o novo.</p>" +
      (G.erro ? '<p class="erro" role="alert">' + esc(G.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-pf="segredo-ok"' + (G.enviando ? " disabled" : "") + ">Gerar</button></div>";
  }
  function modalApagar() {
    var X = S.apagar, p = projeto(X.id) || { nome: X.id };
    return '<h2 id="modal-titulo">Apagar ' + esc(p.nome) + "</h2><p>O projeto sai do Portfólio e da home na hora." +
      (p.login ? " O login (aplicativo " + esc(p.login.app) + ") continua no Login Atos: apague lá, pela fila, se for o caso." : "") + "</p>" +
      (X.erro ? '<p class="erro" role="alert">' + esc(X.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-pf="apagar-ok" data-foco' + (X.enviando ? " disabled" : "") + ">Apagar</button></div>";
  }
  function abrirSegredo(id, valor) {
    S.seg = { id: id, erro: "", enviando: false, valor: valor || "" };
    A.modal.abrir({ html: modalSegredo, aoFechar: function () { S.seg = null; } });
  }

  /* ------------------------------------------------------------ os eventos */
  function abrirForm(p) {
    S.form = novoForm(p);
    if (S.dados.github.conectado && S.repos === null) carregarRepos();
    A.modal.abrir({ html: modalForm, classe: "largo", aoFechar: function () { S.form = null; } });
  }
  function escolherRepo(nome) {
    var v = S.form.v;
    if (!nome) { v.repo = null; return; }
    var r = (S.repos || []).filter(function (x) { return x.nome === nome; })[0];
    if (!r) return;
    v.repo = { nome: r.nome, privado: r.privado };
    if (!v.nome) v.nome = r.curto.replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    if (!v.descricao) v.descricao = r.descricao;
    if (!v.site && /^https:\/\//.test(r.site)) v.site = r.site;
    if (!v.plataforma) v.plataforma = r.linguagem;
    if (S.form.criar && !S.form.idTocado) v.id = r.curto.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pf]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-pf"), id = b.getAttribute("data-id");
    if (a === "recarregar") { carregar(); pintar(); return; }
    if (a === "novo") { abrirForm(null); return; }
    if (a === "editar") { var p = projeto(id); if (p) abrirForm(p); return; }
    if (a === "repos") { carregarRepos(); A.modal.repintar(); return; }
    if (a === "sem-icone") { S.form.v.icone = ""; A.modal.repintar(); return; }
    if (a === "acesso") { S.form.v.acesso = b.getAttribute("data-v"); A.modal.repintar(); return; }
    if (a === "mais-plano") { S.form.v.planos.push({ plano: "", nome: "", descricao: "", mes: "", ano: "" }); A.modal.repintar(); return; }
    if (a === "tirar-plano") { S.form.v.planos.splice(Number(b.getAttribute("data-i")), 1); A.modal.repintar(); return; }
    if (a === "desconectar") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/portfolio/github/desconectar", {}).then(function (d) { S.dados = d; S.repos = null; pintar(); A.toast("GitHub desconectado. Para tirar o acesso de vez, desinstale o app no GitHub."); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "mover") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/portfolio/projetos/" + encodeURIComponent(id) + "/mover", { para: b.getAttribute("data-para") }).then(function (d) { S.dados = d; pintar(); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "salvar") {
      var X = S.form; if (!X || X.enviando) return;
      var d = corpoDoForm();
      if (d.erro) { X.erro = d.erro; A.modal.repintar(); return; }
      X.enviando = true; X.erro = ""; A.modal.repintar();
      var rota = "/api/admin/portfolio/projetos" + (X.criar ? "" : "/" + encodeURIComponent(X.v.id));
      A.pedir("POST", rota, d).then(function (r) {
        if (S.form !== X) return;
        S.dados = r; pintar();
        A.modal.fechar();
        A.toast("Salvo");
        if (r.segredo) abrirSegredo(r.salvo, r.segredo);
      }, function (er) {
        if (S.form !== X) return;
        X.enviando = false; X.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
      return;
    }
    if (a === "segredo") { abrirSegredo(id, ""); return; }
    if (a === "segredo-ok") {
      var G = S.seg; if (!G || G.enviando) return;
      G.enviando = true; G.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/portfolio/projetos/" + encodeURIComponent(G.id) + "/segredo", { confirmar: true }).then(function (r) {
        if (S.seg !== G) return;
        G.enviando = false; G.valor = r.segredo; A.modal.repintar(); carregar();
      }, function (er) {
        if (S.seg !== G) return;
        G.enviando = false; G.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
      return;
    }
    if (a === "copiar") {
      var el = document.getElementById("pf-segredo");
      if (el && navigator.clipboard) navigator.clipboard.writeText(el.value).then(function () { A.toast("Copiado"); });
      return;
    }
    if (a === "apagar") { S.apagar = { id: id, erro: "", enviando: false }; A.modal.abrir({ html: modalApagar, aoFechar: function () { S.apagar = null; } }); return; }
    if (a === "apagar-ok") {
      var Y = S.apagar; if (!Y || Y.enviando) return;
      Y.enviando = true; Y.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/portfolio/projetos/" + encodeURIComponent(Y.id) + "/apagar", { confirmar: true }).then(function (d) {
        if (S.apagar !== Y) return;
        S.dados = d; pintar(); A.modal.fechar(); A.toast("Apagado");
      }, function (er) {
        if (S.apagar !== Y) return;
        Y.enviando = false; Y.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
    }
  });

  /* Os campos: guardados no estado a cada tecla (o pop-up se redesenha). "plano.<i>.<campo>" vai para a lista. */
  function guardarCampo(el) {
    var k = el.getAttribute("data-pf-in"), v = S.form.v;
    var valor = el.type === "checkbox" ? el.checked : el.value;
    var m = /^plano\.(\d+)\.(\w+)$/.exec(k);
    if (m) { v.planos[Number(m[1])][m[2]] = valor; return false; }
    if (k === "repo") { escolherRepo(valor); return true; }
    if (k === "id") S.form.idTocado = true;
    v[k] = valor;
    return el.type === "checkbox";
  }
  document.addEventListener("input", function (e) {
    var el = e.target.closest && e.target.closest("[data-pf-in]");
    if (!el || !S.form || el.tagName === "SELECT" || el.type === "checkbox") return;
    guardarCampo(el);
    if (S.form.erro) { S.form.erro = ""; var er = el.closest(".modal") && el.closest(".modal").querySelector(".erro"); if (er) er.remove(); }
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !S.form) return;
    if (el.hasAttribute("data-pf-in") && (el.tagName === "SELECT" || el.type === "checkbox")) { if (guardarCampo(el)) A.modal.repintar(); return; }
    if (el.getAttribute("data-pf-arq") !== "icone") return;
    var arq = el.files && el.files[0];
    if (!arq) return;
    if (["image/png", "image/jpeg", "image/webp"].indexOf(arq.type) < 0) { S.form.erro = "o ícone precisa ser PNG, JPEG ou WebP"; A.modal.repintar(); return; }
    if (arq.size > ICONE_MAX) { S.form.erro = "o ícone tem " + Math.ceil(arq.size / 1024) + " KB; o limite é 30 KB"; A.modal.repintar(); return; }
    var leitor = new FileReader();
    leitor.onload = function () { if (S.form) { S.form.v.icone = String(leitor.result || ""); S.form.erro = ""; A.modal.repintar(); } };
    leitor.onerror = function () { if (S.form) { S.form.erro = "não consegui ler a imagem"; A.modal.repintar(); } };
    leitor.readAsDataURL(arq);
  });

  A.secoes.push({
    id: "portfolio",
    nome: "Portfólio",
    grupo: "Atos",
    area: "atos",
    papeis: ["dono"],
    ordem: 24,
    desenhar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.carregando) carregar();
    },
  });
})();
