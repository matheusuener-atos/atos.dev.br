/* O Atos Workspace (/workspace/ e /workspace/integracoes): o produto da Atos para quem constroi sistemas com a Conta
   Atos. Visao geral (o que e, a ativacao, os termos aceitos, desativar), Integracoes (workspace-integracoes.js, com o
   cartao "Como integrar" do integrar.js, carregados so quando a guia abre e o Workspace esta ativo) e E-mail Atos
   (workspace-email.js, carregado quando a guia abre).

     GET  /api/eu                     quem esta dentro (sem sessao: /entrar/?volta=<esta pagina>)
     GET  /api/workspace              a ativacao, os termos atuais, o login recente, quantos aplicativos a conta tem e o
                                      e-mail Atos (alias, via_alias, pendencia: sem_alias, alias_nao_confirmado,
                                      entrar_pelo_alias). Quem tem o alias usa o Workspace entrando por ele; a ativacao,
                                      os termos e a guia E-mail Atos abrem com qualquer login.
     POST /api/workspace/ativar       {aceito: true, versao}
     POST /api/workspace/desativar    {confirmar: true}

   O servidor e worker/workspace.js. Os atributos daqui sao data-ws*; os das Integracoes, data-ic*. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var SECOES = ["geral", "integracoes", "email"];
  var S = { conta: null, ws: null, erro: "", aceito: false, ocupado: false, confirmar: false, msg: "" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function api(caminho, corpo) {
    var op = corpo === undefined ? { credentials: "same-origin" } :
      { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) };
    return fetch(caminho, op).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; });
    }, function () { return { erro: "sem conexão com o servidor", _status: 0 }; });
  }
  function data(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }
  /* A versao dos termos ("2026-10-11", ou "2026-10-11.2" na segunda revisao do dia) como data. */
  function versao(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/.exec(String(v || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] + (m[4] ? ", revisão " + m[4] : "") : String(v || "");
  }

  function secaoAtual() {
    var m = /^\/workspace\/([a-z]+)/.exec(location.pathname);
    return m && SECOES.indexOf(m[1]) > 0 ? m[1] : "geral";
  }
  var GUIAS = [["geral", "Visão geral", "/workspace/"], ["integracoes", "Integrações", "/workspace/integracoes"], ["email", "E-mail Atos", "/workspace/email"]];
  function guias() {
    var sec = secaoAtual();
    return '<nav class="guias" aria-label="Atos Workspace">' + GUIAS.map(function (g) {
      return '<a href="' + g[2] + '" data-ws-secao="' + g[0] + '"' + (g[0] === sec ? ' aria-current="page"' : "") + ">" + g[1] + "</a>";
    }).join("") + '<a class="fim" href="/conta/">Minha conta</a></nav>';
  }
  function titulo(t, descricao) { return "<h1>" + t + "</h1>" + (descricao ? '<p class="descricao">' + descricao + "</p>" : "") + guias(); }
  function h2(t) { return '<h2 class="titulo-secao">' + t + "</h2>"; }
  function vazio(t) { return '<div class="card"><p class="vazio">' + t + "</p></div>"; }
  var VOLTA_ENTRAR = function () { return "/entrar/?modo=entrar&volta=" + encodeURIComponent(location.pathname); };
  function apps(n) { return n + (n === 1 ? " aplicativo" : " aplicativos"); }

  // ------------------------------------------------------------ Visao geral

  function oQueE() {
    return h2("O que é") + '<div class="card ws-texto">' +
      "<p>A Conta Atos é a sua identidade e a sua carteira nos produtos da Atos: com ela você entra, assina e paga. " +
      "O Atos Workspace é o que você ativa para construir com ela.</p>" +
      '<p>Hoje ele traz o <strong>Login Atos para os seus sistemas</strong>: você cadastra o seu site, aplicativo ou servidor no “Entrar com Atos”, ' +
      "as pessoas entram nele com a Conta Atos (por OpenID Connect, como entram com o Google) e você decide quem pode entrar. " +
      '<a href="/integracao/">Como funciona</a>.</p>' +
      (S.ws && S.ws.email && S.ws.email.disponivel
        ? "<p>E o <strong>e-mail Atos</strong>: um endereço @atos.dev.br que encaminha para o seu e-mail (não é caixa de entrada; desligado, as mensagens são recusadas).</p>"
        : "<p>Em preparação: o <strong>e-mail Atos</strong>, um endereço @atos.dev.br que encaminha para o seu e-mail.</p>") +
      "<p>Para cadastrar um sistema: <strong>1.</strong> ative o Workspace; <strong>2.</strong> crie o seu e-mail Atos e confirme o destino; " +
      "<strong>3.</strong> entre com o endereço @atos.dev.br (a mesma senha da conta); <strong>4.</strong> cadastre o sistema em Integrações. " +
      "Quem entra nele vê o seu endereço @atos.dev.br como quem cadastrou, nunca o seu e-mail pessoal.</p></div>";
  }

  function blocoAtivar(W) {
    var h = h2("Ativar");
    var desativado = W.desativado ? '<p class="ws-aviso">Você desativou o Atos Workspace em ' + esc(data(W.desativado)) + "." +
      (W.apps ? " Os seus " + esc(apps(W.apps)) + " continuam funcionando para quem entra neles; ative de novo para vê-los e mudá-los." : "") + "</p>" : "";
    h += '<div class="card ws-ativar">' + desativado +
      '<p>Gratuito: ativar não pede cartão nem pagamento. Ao ativar, você aceita os <a href="' + esc(W.termos.endereco) + '">termos do Atos Workspace</a> ' +
      "(versão de " + esc(versao(W.termos.versao)) + "). Em resumo: o sistema que você cadastra é seu e você responde por ele; " +
      "cadastrar sistemas pede o seu e-mail Atos (um endereço @atos.dev.br com o destino confirmado) e o login feito por ele; " +
      "quem entra vê esse endereço como quem cadastrou (nunca o seu e-mail pessoal) e o aviso de que o sistema não é da Atos; " +
      "nomes que se passem pela Atos ou por outro serviço são recusados; e a Atos pode desligar um aplicativo usado para fraude ou abuso.</p>";
    if (!W.recente) {
      h += '<p class="ws-aviso">Para ativar, o login precisa ser das últimas ' + W.limites.recente_h + ' horas. <a href="' + VOLTA_ENTRAR() + '">Entrar de novo</a></p>';
    } else {
      h += '<label class="ws-marcar"><input type="checkbox" data-ws-in="aceito"' + (S.aceito ? " checked" : "") + ">" +
        "<span>Li e aceito os termos do Atos Workspace (versão de " + esc(versao(W.termos.versao)) + ")</span></label>";
    }
    h += '<p class="erro" role="alert">' + esc(S.erro) + "</p>" +
      '<div class="ws-botoes"><button type="button" class="btn primario" data-ws="ativar"' + (!W.recente || !S.aceito || S.ocupado ? " disabled" : "") + ">" +
      (S.ocupado ? "Ativando…" : "Ativar o Atos Workspace") + "</button></div></div>";
    return h;
  }

  /* Quem tem o e-mail Atos e entrou com o e-mail pessoal: sai e volta ao /entrar com o endereco Atos preenchido. */
  function entrarPeloAlias(W) {
    var a = W.alias.endereco;
    return '<div class="card ws-ativar"><p><strong>Entre com ' + esc(a) + " para usar o Workspace.</strong> Você entrou com o e-mail pessoal (" + esc(W.conta.email) + "). " +
      "É a mesma conta e a mesma senha. A ativação, os termos e o E-mail Atos abrem com qualquer login.</p>" +
      '<div class="ws-botoes"><button type="button" class="btn primario" data-ws="entrar-alias" data-alias="' + esc(a) + '">Entrar com ' + esc(a) + "</button></div></div>";
  }
  function temAliasAtivo(W) { return Boolean(W.alias && !W.alias.suspenso); }

  function blocoAtivo(W) {
    var termosNovos = W.aceito && W.aceito.versao !== W.termos.versao;
    var h = "";
    if (S.msg) h += '<p class="ok ws-ok">' + esc(S.msg) + "</p>";
    if (temAliasAtivo(W) && !W.via_alias) h += entrarPeloAlias(W);
    h += h2("Ativação") + '<div class="card">' +
      '<div class="dado"><span class="rotulo">Situação</span><span>Ativo desde ' + esc(data(W.ativado)) + "</span><span></span></div>" +
      '<div class="dado"><span class="rotulo">Plano</span><span>Gratuito</span><span></span></div>' +
      '<div class="dado"><span class="rotulo">Termos aceitos</span><span>' + (W.aceito ? "Versão de " + esc(versao(W.aceito.versao)) + ", em " + esc(data(W.aceito.quando)) : "—") +
      '</span><a class="btn p" href="' + esc(W.termos.endereco) + '">Ler os termos</a></div>' +
      '<div class="dado"><span class="rotulo">Conta</span><span>' + esc(W.conta.email) + "</span><span></span></div>" +
      "</div>";
    if (termosNovos) {
      h += '<div class="card ws-ativar"><p class="ws-aviso">Os termos do Atos Workspace mudaram (versão de ' + esc(versao(W.termos.versao)) + '). <a href="' + esc(W.termos.endereco) + '">Leia</a> e aceite para continuar de acordo.</p>' +
        (W.recente ? '<label class="ws-marcar"><input type="checkbox" data-ws-in="aceito"' + (S.aceito ? " checked" : "") + "><span>Li e aceito os termos novos</span></label>" +
          '<p class="erro" role="alert">' + esc(S.erro) + '</p><div class="ws-botoes"><button type="button" class="btn p primario" data-ws="ativar"' + (!S.aceito || S.ocupado ? " disabled" : "") + ">Aceitar os termos novos</button></div>"
          : '<p class="ws-aviso">Para aceitar, o login precisa ser das últimas ' + W.limites.recente_h + ' horas. <a href="' + VOLTA_ENTRAR() + '">Entrar de novo</a></p>') + "</div>";
    }
    h += h2("O que está incluído") + '<div class="card"><a class="item" href="/workspace/integracoes" data-ws-secao="integracoes"><span class="logo inicial" aria-hidden="true">L</span>' +
      '<span class="nome"><strong>Integrações</strong><small>O Login Atos para os seus sistemas · ' + esc(String(W.apps)) + " de 5 aplicativos</small></span>" +
      '<span class="seta" aria-hidden="true">→</span></a>' +
      '<a class="item" href="/workspace/email" data-ws-secao="email"><span class="logo inicial" aria-hidden="true">@</span>' +
      '<span class="nome"><strong>E-mail Atos</strong><small>' + (W.alias ? esc(W.alias.endereco) + (W.alias.suspenso ? " · suspenso" : W.alias.confirmado ? "" : " · falta confirmar o destino")
        : W.email && W.email.disponivel ? "Um endereço @atos.dev.br que encaminha para o seu e-mail. Crie o seu antes de cadastrar sistemas" : "Em preparação") + "</small></span>" +
      '<span class="seta" aria-hidden="true">→</span></a></div>';
    h += h2("Desativar") + '<div class="card">';
    if (S.confirmar) {
      h += '<div class="confirmar" role="alertdialog" aria-label="Desativar o Atos Workspace">' +
        "<p>Desativar o Atos Workspace? " + (W.apps ? "Os seus " + esc(apps(W.apps)) + " continuam funcionando para quem entra neles, mas você" : "Você") +
        " não vê nem muda mais nenhum aplicativo (quem pode entrar, acessos, segredos) até ativar de novo." +
        (W.apps ? " Para que ninguém mais entre, desligue os acessos ou apague os aplicativos antes, em Integrações." : "") + "</p>" +
        '<p class="erro" role="alert">' + esc(S.erro) + "</p>" +
        (W.recente ? "" : '<p class="ws-aviso">Para desativar, o login precisa ser das últimas ' + W.limites.recente_h + ' horas. <a href="' + VOLTA_ENTRAR() + '">Entrar de novo</a></p>') +
        '<div class="botoes"><button type="button" class="btn p perigo" data-ws="desativar-sim"' + (S.ocupado || !W.recente ? " disabled" : "") + ">" + (S.ocupado ? "Desativando…" : "Desativar") + "</button>" +
        '<button type="button" class="btn p" data-ws="desativar-nao">Voltar</button></div></div>';
    } else {
      h += '<div class="excluir"><span>' + (W.apps ? "Os aplicativos continuam funcionando para quem entra; você só volta a mudá-los ativando de novo." : "Você pode ativar de novo quando quiser.") + "</span>" +
        '<button type="button" class="btn p perigo" data-ws="desativar">Desativar</button></div>';
    }
    return h + "</div>";
  }

  function geral() {
    var h = titulo("Atos Workspace", "Para quem constrói sistemas com a Conta Atos.");
    if (!S.ws) return h + (S.erro ? vazio(esc(S.erro) + ' <button type="button" class="link" data-ws="recarregar">Tentar de novo</button>') : vazio("Carregando…"));
    var W = S.ws;
    if (W.ativo) return h + blocoAtivo(W) + oQueE();
    return h + oQueE() + blocoAtivar(W);
  }

  // ------------------------------------------------------------ Integracoes

  function integracoes() {
    var h = titulo("Integrações", "Os seus sistemas que usam o Entrar com Atos, e quem pode entrar em cada um.");
    if (!S.ws) return h + (S.erro ? vazio(esc(S.erro) + ' <button type="button" class="link" data-ws="recarregar">Tentar de novo</button>') : vazio("Carregando…"));
    if (!S.ws.ativo) {
      return h + '<div class="card ws-ativar"><p>As Integrações fazem parte do Atos Workspace. Ative o Workspace (gratuito) para cadastrar os seus sistemas no Login Atos.' +
        (S.ws.apps ? " Os seus " + esc(apps(S.ws.apps)) + " continuam funcionando para quem entra neles; ative de novo para vê-los e mudá-los." : "") + "</p>" +
        '<div class="ws-botoes"><a class="btn primario" href="/workspace/" data-ws-secao="geral">Ativar o Atos Workspace</a></div></div>';
    }
    var W = S.ws;
    var antigos = W.apps ? " Os seus " + esc(apps(W.apps)) + " continuam funcionando para quem entra neles; você volta a vê-los e mudá-los quando cumprir este passo." : "";
    if (W.pendencia === "sem_alias") {
      if (W.alias && W.alias.suspenso) {
        return h + '<div class="card ws-ativar"><p class="ws-aviso">A Atos suspendeu o seu e-mail Atos (' + esc(W.alias.endereco) + "). Sem ele, as Integrações ficam paradas. Para entender ou contestar, escreva para contato@atos.dev.br." + antigos + "</p></div>";
      }
      if (!(W.email && W.email.disponivel)) {
        return h + '<div class="card ws-ativar"><p>Cadastrar sistemas pede o e-mail Atos, que ainda está em preparação na Atos. As Integrações abrem quando ele estiver ligado.' + antigos + "</p></div>";
      }
      return h + '<div class="card ws-ativar"><p><strong>Crie o seu e-mail Atos para cadastrar sistemas.</strong> Quem entra nos seus sistemas vê esse endereço como quem cadastrou, nunca o seu e-mail pessoal. ' +
        "Depois de criar e confirmar o destino, entre com ele (é a mesma conta e a mesma senha)." + antigos + "</p>" +
        '<div class="ws-botoes"><a class="btn primario" href="/workspace/email" data-ws-secao="email">Criar o e-mail Atos</a></div></div>';
    }
    if (W.pendencia === "alias_nao_confirmado") {
      return h + '<div class="card ws-ativar"><p><strong>Confirme o destino do seu e-mail Atos.</strong> ' + esc(W.alias.endereco) + " ainda não tem o destino confirmado (o código da Atos e o e-mail da Cloudflare). " +
        "Depois, entre com ele para usar as Integrações." + antigos + "</p>" +
        '<div class="ws-botoes"><a class="btn primario" href="/workspace/email" data-ws-secao="email">Ir ao E-mail Atos</a></div></div>';
    }
    if (W.pendencia === "entrar_pelo_alias") return h + entrarPeloAlias(W);
    return h + '<div id="ig-raiz"><div class="card"><p class="vazio">Carregando…</p></div></div>';
  }
  var scripts = {};
  function script(src, cb) {
    if (scripts[src] === true) { cb(); return; }
    if (scripts[src]) { scripts[src].push(cb); return; }
    scripts[src] = [cb];
    var s = document.createElement("script");
    s.src = src;
    s.onload = function () { var l = scripts[src]; scripts[src] = true; l.forEach(function (f) { f(); }); };
    document.head.appendChild(s);
  }
  function montarIntegracoes() {
    script("/assets/integrar.js", function () {
      script("/assets/workspace-integracoes.js", function () { var r = $("ig-raiz"); if (r && window.WorkspaceIntegracoes) window.WorkspaceIntegracoes.montar(r); });
    });
  }

  // ------------------------------------------------------------ E-mail Atos

  function email() {
    var h = titulo("E-mail Atos", "Um endereço @atos.dev.br que encaminha para o seu e-mail.");
    if (!S.ws) return h + (S.erro ? vazio(esc(S.erro) + ' <button type="button" class="link" data-ws="recarregar">Tentar de novo</button>') : vazio("Carregando…"));
    return h + '<div id="em-raiz"><div class="card"><p class="vazio">Carregando…</p></div></div>';
  }
  function montarEmail() {
    script("/assets/workspace-email.js", function () { var r = $("em-raiz"); if (r && window.WorkspaceEmail) window.WorkspaceEmail.montar(r); });
  }
  /* Ativou ou desativou: o e-mail Atos le o estado de novo. */
  function emailDeNovo() { if (window.WorkspaceEmail) window.WorkspaceEmail.recarregar(); }

  // ------------------------------------------------------------ desenhar e carregar

  var DESENHO = { geral: geral, integracoes: integracoes, email: email };
  function desenhar() {
    var sec = secaoAtual();
    $("secao").innerHTML = DESENHO[sec]();
    if (sec === "integracoes" && S.ws && S.ws.ativo && !S.ws.pendencia) montarIntegracoes();
    if (sec === "email" && S.ws) montarEmail();
  }
  function ir(sec) {
    var url = sec === "geral" ? "/workspace/" : "/workspace/" + sec;
    if (location.pathname !== url) history.pushState(null, "", url);
    S.erro = ""; S.confirmar = ""; S.msg = "";
    desenhar();
    window.scrollTo(0, 0);
    // O e-mail Atos pode ter mudado na outra guia (criado, confirmado): a Visao geral e as Integracoes leem de novo.
    if (sec !== "email" && S.ws) carregar();
  }
  function carregar() {
    return api("/api/workspace").then(function (d) {
      if (d._status === 401 && d.entrar) { location.replace("/entrar/?volta=" + encodeURIComponent(location.pathname)); return; }
      if (d.erro || typeof d.ativo !== "boolean") { S.ws = null; S.erro = d.erro || "não deu para carregar o Atos Workspace agora"; }
      else { S.ws = d; S.erro = ""; }
      desenhar();
    });
  }
  function mudar(caminho, corpo, depois) {
    S.ocupado = true; S.erro = ""; desenhar();
    api(caminho, corpo).then(function (d) {
      S.ocupado = false;
      if (d._status === 401 && d.reentrar && S.ws) { S.ws.recente = false; S.erro = ""; desenhar(); return; }
      if (d.erro || typeof d.ativo !== "boolean") { S.erro = d.erro || "não deu agora: tente de novo"; desenhar(); return; }
      S.ws = d; S.aceito = false; S.confirmar = false;
      if (depois) depois(d);
      desenhar();
    });
  }

  document.addEventListener("click", function (e) {
    var link = e.target.closest("a[data-ws-secao]");
    if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); ir(link.getAttribute("data-ws-secao")); return; }
    var b = e.target.closest("[data-ws]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-ws");
    if (a === "recarregar") { S.erro = ""; desenhar(); carregar(); }
    else if (a === "entrar-alias") {
      // Sai desta sessao (a do e-mail pessoal) e volta ao /entrar com o endereco Atos preenchido; depois, de volta aqui.
      var alias = b.getAttribute("data-alias") || "";
      b.disabled = true;
      api("/api/sair", {}).then(function () {
        location.assign("/entrar/?modo=entrar&login_hint=" + encodeURIComponent(alias) + "&volta=" + encodeURIComponent(location.pathname));
      });
    }
    else if (a === "ativar") {
      mudar("/api/workspace/ativar", { aceito: true, versao: S.ws.termos.versao }, function (d) { S.msg = d.ativo ? "Atos Workspace ativo. As Integrações já estão liberadas." : ""; emailDeNovo(); });
    }
    else if (a === "desativar") { S.confirmar = true; S.erro = ""; desenhar(); }
    else if (a === "desativar-nao") { S.confirmar = false; S.erro = ""; desenhar(); }
    else if (a === "desativar-sim") mudar("/api/workspace/desativar", { confirmar: true }, emailDeNovo);
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || el.getAttribute("data-ws-in") !== "aceito") return;
    S.aceito = el.checked;
    var botao = document.querySelector('[data-ws="ativar"]');
    if (botao) botao.disabled = !S.aceito || S.ocupado;
  });
  // As Integracoes souberam (403) que o Workspace foi desativado noutra aba: le de novo e mostra a ativacao.
  document.addEventListener("workspace-inativo", function () { carregar(); });
  window.addEventListener("popstate", function () { S.confirmar = false; desenhar(); });

  api("/api/eu").then(function (d) {
    if (!d.conta) { location.replace("/entrar/?volta=" + encodeURIComponent(location.pathname)); return; }
    S.conta = d.conta;
    $("workspace").hidden = false;
    desenhar();
    carregar();
  });
})();
