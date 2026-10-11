/* O painel da Atos, secao Login Atos: os sistemas que usam o "Entrar com Atos" (OpenID Connect). O servidor e o
   worker/oidc-painel.js; so o papel Dono ve e muda.

     GET  /api/admin/oauth                          os aplicativos e clientes (os do codigo, so leitura, e os do KV),
                                                    o discovery, os endpoints, os escopos e a validade do token
     POST /api/admin/alteracoes                     criar, editar, ligar, desligar e apagar (tipos oauth.app e
                                                    oauth.cliente): vao para a fila da Atos e valem ao confirmar
     POST /api/admin/oauth/clientes/:id/segredo     gerar ou trocar o segredo de um cliente confidencial: na hora,
                                                    com confirmacao aqui; o valor aparece uma vez so

     POST /api/admin/oauth/terceiros/:id/(desligar|ligar|apagar)
                                                    os aplicativos que as pessoas cadastram no Atos Workspace
                                                    (Integracoes): desligar por abuso (com o motivo, que o dono ve),
                                                    ligar de novo e apagar, na hora, com registro

   Para cada cliente, "Como integrar" (o cartao do integrar.js, o mesmo do Atos Workspace): os dados do provedor, o fluxo,
   um pedido pronto para um assistente de codigo e os comandos. O segredo nunca entra no pedido nem nos comandos. */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var S = { raiz: null, dados: null, erro: "", carregando: false, aberto: "", form: null, seg: null, terc: null, tercAberto: "" };
  var ICONE_MAX = 30 * 1024;
  var textos = {}; // o que o "Copiar" do segredo copia

  // O cartao "Como integrar" e comum (integrar.js); carregado aqui, sem mexer no HTML do painel.
  if (!window.IntegrarAtos && !document.querySelector('script[src="/assets/integrar.js"]')) {
    var s = document.createElement("script");
    s.src = "/assets/integrar.js";
    document.head.appendChild(s);
  }
  document.addEventListener("integrar-atos", function () { pintar(); });

  function F() { return A.fila; }
  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }
  function carregar() {
    S.carregando = true;
    A.pedir("GET", "/api/admin/oauth").then(function (d) { S.dados = d; S.erro = ""; }, function (e) { if (e.status !== 401) S.erro = e.message; })
      .then(function () { S.carregando = false; pintar(); });
  }
  A.aoEntrar(function () { if (F()) F().ouvir(function () { if (A.secaoAtual() === "login-atos") pintar(); }); });

  function app(id) { return ((S.dados || {}).apps || []).filter(function (a) { return a.id === id; })[0] || null; }
  function cliente(id) { return ((S.dados || {}).clientes || []).filter(function (c) { return c.id === id; })[0] || null; }
  function naFila(tipo, id) { return Boolean(F() && F().naFila(tipo, id)); }
  function pendentesOAuth() { return F() ? F().pendentes.filter(function (p) { return /^oauth\./.test(p.tipo); }) : []; }

  function icone(a, classe) {
    if (a.icone) return '<img class="logo ' + (classe || "") + '" src="' + esc(a.icone) + '" alt="" width="32" height="32">';
    return '<span class="logo inicial ' + (classe || "") + '" aria-hidden="true">' + esc(String(a.nome || a.id || "?").trim().charAt(0).toUpperCase()) + "</span>";
  }
  function botaoCopiar(chave, rotulo) {
    return '<button type="button" class="btn mini" data-oa="copiar" data-chave="' + esc(chave) + '">' + esc(rotulo || "Copiar") + "</button>";
  }

  /* ------------------------------------------------------------ o texto de integrar (integrar.js) */
  function voltasDe(c) { return window.IntegrarAtos ? window.IntegrarAtos.voltas(c) : (c.voltas || []); }
  function integrar(c) {
    if (!window.IntegrarAtos) return '<p class="dica">Carregando…</p>';
    var a = app(c.app) || { nome: c.app };
    return window.IntegrarAtos.cartao(c, S.dados, a.nome, "no painel da Atos, Login Atos");
  }

  function quemEntra(a) {
    if (a.acesso === "todos") return "qualquer Conta Atos";
    var n = (a.liberados || []).length;
    return "só liberados (" + n + (n === 1 ? " pessoa" : " pessoas") + (a.dono ? " e o dono" : a.por ? " e quem criou" : "") + ")";
  }

  /* O Atos Workspace do dono (worker/workspace.js): ativo, desativado ou nao conferido. Sem ele, o aplicativo continua
     funcionando para quem entra, mas o dono nao o muda ate ativar de novo. */
  function workspaceDoDono(a) {
    var w = a.dono_workspace;
    if (!w) return "não deu para conferir";
    if (w.ativo) return "ativo" + (w.ativado ? " desde " + U.quando(w.ativado) : "");
    return w.desativado ? "desativado em " + U.quando(w.desativado) + " (o dono não muda o aplicativo até ativar de novo)" : "nunca ativado (o dono não muda o aplicativo até ativar)";
  }
  /* O e-mail Atos do dono: e o que quem entra no aplicativo ve como "Cadastrado por" (sem ele, "uma Conta Atos"). */
  function aliasDoDono(a) {
    if (!a.dono_alias_lido) return "não deu para conferir";
    var x = a.dono_alias;
    if (!x) return "nenhum (quem entra vê “Cadastrado por uma Conta Atos”)";
    return x.endereco + (x.suspenso ? " · suspenso (quem entra vê “uma Conta Atos”)" : x.confirmado ? "" : " · destino não confirmado");
  }
  /* Os aplicativos que as pessoas cadastram no Atos Workspace > Integracoes: ver, desligar por abuso, ligar e apagar. */
  function terceiros(D) {
    var l = D.terceiros || [];
    var h = '<h2 class="titulo-secao pv-h2"><span>Cadastrados pelas pessoas (Atos Workspace)</span></h2>';
    if (!l.length) return h + '<div class="card"><p class="vazio">Ninguém cadastrou um aplicativo ainda.</p></div>';
    var donos = {}, ativos = 0;
    l.forEach(function (a) { if (!(a.dono in donos)) { donos[a.dono] = 1; if (a.dono_workspace && a.dono_workspace.ativo) ativos++; } });
    var nDonos = Object.keys(donos).length;
    h += '<p class="nota">' + nDonos + (nDonos === 1 ? " dono" : " donos") + " de aplicativo, " + ativos + " com o Atos Workspace ativo.</p>";
    return h + '<div class="card">' + l.map(function (a) {
      var aberto = S.tercAberto === a.id;
      var sit = a.bloqueado ? '<span class="pv-sit perigo">desligado pela Atos</span>' : '<span class="pv-sit ok">no ar</span>';
      var ws = a.dono_workspace && a.dono_workspace.ativo ? "" : ' <span class="pv-sit">dono sem Workspace</span>';
      var det = "";
      if (aberto) {
        det = '<div class="nf-det"><dl class="nf-info">' +
          "<dt>Dono</dt><dd>" + esc(a.dono) + (a.dono_sub ? " <small>(" + esc(a.dono_sub) + ")</small>" : "") + "</dd>" +
          "<dt>E-mail Atos do dono</dt><dd>" + esc(aliasDoDono(a)) + "</dd>" +
          "<dt>Workspace do dono</dt><dd>" + esc(workspaceDoDono(a)) + "</dd>" +
          "<dt>Site</dt><dd>" + esc(a.site) + "</dd>" +
          "<dt>Privacidade</dt><dd>" + esc(a.privacidade) + "</dd>" +
          "<dt>Termos</dt><dd>" + esc(a.termos) + "</dd>" +
          "<dt>Quem entra</dt><dd>" + esc(quemEntra(a)) + "</dd>" +
          (a.bloqueado ? "<dt>Desligado</dt><dd>" + esc(U.quando(a.bloqueado.quando)) + (a.bloqueado.motivo ? ": " + esc(a.bloqueado.motivo) : "") + "</dd>" : "") +
          "<dt>Acessos</dt><dd>" + (a.acessos.length ? a.acessos.map(function (c) {
            return "<code>" + esc(c.id) + "</code> · " + (c.tipo === "confidencial" ? "confidencial" : "público") + (c.ativo ? "" : " · desligado pelo dono") + "<br><small>" + voltasDe(c).map(esc).join(" · ") + "</small>";
          }).join("<br>") : "nenhum") + "</dd>" +
          "<dt>Registro</dt><dd>" + (a.registro || []).map(function (x) { return esc(U.quando(x.quando)) + " · " + esc(x.por) + ": " + esc(x.oque); }).join("<br>") + "</dd>" +
          "</dl></div>";
      }
      return '<div class="oa-cliente"><div class="item oa-item">' + icone(a) + '<span class="nome"><strong>' + esc(a.nome) + ' <span class="nf-tag">' + esc(a.id) + "</span> " + sit + ws + "</strong>" +
        "<small>" + esc(a.descricao) + " · de " + esc(a.dono) + " · " + a.acessos.length + (a.acessos.length === 1 ? " acesso" : " acessos") + " · " + esc(quemEntra(a)) + "</small></span>" +
        '<span class="pv-par"><button type="button" class="btn mini" data-oa="terc-ver" data-id="' + esc(a.id) + '" aria-expanded="' + aberto + '">Detalhes</button>' +
        (a.bloqueado ? '<button type="button" class="btn mini" data-oa="terc-ligar" data-id="' + esc(a.id) + '">Ligar de novo</button>'
          : '<button type="button" class="btn mini" data-oa="terc-desligar" data-id="' + esc(a.id) + '">Desligar</button>') +
        '<button type="button" class="btn mini perigo" data-oa="terc-apagar" data-id="' + esc(a.id) + '">Apagar</button></span></div>' + det + "</div>";
    }).join("") + "</div>" +
      '<p class="nota">Desligar e apagar valem na hora, sem a fila, e ficam no registro do aplicativo (o dono vê) e no registro do Login Atos. Desligado pela Atos, o dono vê o motivo e não consegue religar.</p>';
  }
  function terc(id) { return ((S.dados || {}).terceiros || []).filter(function (a) { return a.id === id; })[0] || null; }
  function modalTerceiro() {
    var T = S.terc, a = terc(T.id) || { nome: T.id, dono: "" };
    var apagar = T.acao === "apagar";
    return '<h2 id="modal-titulo">' + (apagar ? "Apagar " : "Desligar ") + esc(a.nome) + "</h2>" +
      "<p>" + (apagar
        ? "O aplicativo de " + esc(a.dono) + " sai do Entrar com Atos na hora, com os acessos e os segredos. Não tem volta (o dono teria de cadastrar outro)."
        : "Nenhum acesso de " + esc(a.nome) + " começa login, troca código ou responde no userinfo, até a Atos ligar de novo. O dono vê o motivo no registro do aplicativo.") +
      " O id_token já emitido vale até vencer.</p>" +
      '<label class="campo"><span class="rotulo">Motivo' + (apagar ? " (opcional)" : " (o dono vê)") + '</span><input data-oa-terc="motivo" maxlength="200" autocomplete="off" value="' + esc(T.motivo || "") + '"></label>' +
      (T.erro ? '<p class="erro" role="alert">' + esc(T.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-oa="terc-ok"' + (T.enviando ? " disabled" : "") + ">" +
      (T.enviando ? "Um momento…" : apagar ? "Apagar" : "Desligar") + "</button></div>";
  }

  /* ------------------------------------------------------------ a tela */
  function tela() {
    var h = "<h1>Login Atos</h1>" +
      '<p class="descricao">Os sistemas que usam o Entrar com Atos. Os do código (o PAVLVS) só aparecem aqui. Nos da equipe, criar, editar, desligar e apagar entram na fila da Atos e valem quando você confirmar as alterações; gerar ou trocar o segredo de um cliente vale na hora. Os cadastrados pelas pessoas no Atos Workspace aparecem no fim, com o dono de cada um e se ele tem o Workspace ativo.</p>';
    if (!S.dados) return h + '<div class="card pv-topo"><p class="vazio">' + (S.erro ? "Não consegui ler o Login Atos agora: " + esc(S.erro) + ' <button type="button" class="link" data-oa="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    if (S.erro) h += '<p class="nf-aviso"><span>Não consegui atualizar agora: ' + esc(S.erro) + ". Mostrando a última leitura.</span></p>";
    var D = S.dados, pend = pendentesOAuth();
    if (pend.length) h += '<p class="nf-aviso"><span>' + pend.length + (pend.length === 1 ? " alteração do Login Atos está na fila e ainda não vale." : " alterações do Login Atos estão na fila e ainda não valem.") + ' <a href="#alteracoes" data-secao="alteracoes">Confirmar alterações</a></span></p>';

    h += '<h2 class="titulo-secao pv-h2"><span>Aplicativos</span><button type="button" class="btn p primario" data-oa="novo-app">Novo aplicativo</button></h2>';
    h += '<div class="card">' + D.apps.map(function (a) {
      var nos = D.clientes.filter(function (c) { return c.app === a.id; }).length, fila = naFila("oauth.app", a.id);
      return '<div class="item oa-item">' + icone(a) + '<span class="nome"><strong>' + esc(a.nome) + ' <span class="nf-tag">' + esc(a.id) + "</span>" +
        (a.codigo ? ' <span class="nf-tag">do código</span>' : "") + "</strong><small>" + esc(a.descricao) + " · " + esc(a.site) + " · " + nos + (nos === 1 ? " cliente" : " clientes") +
        " · " + esc(quemEntra(a)) +
        (fila ? ' · <span class="pv-atencao">na fila</span>' : "") + "</small></span>" +
        (a.codigo ? '<span class="pv-mudo">só leitura</span>' : '<span class="pv-par"><button type="button" class="btn mini" data-oa="editar-app" data-id="' + esc(a.id) + '">Editar</button>' +
          '<button type="button" class="btn mini perigo" data-oa="apagar-app" data-id="' + esc(a.id) + '"' + (fila ? ' disabled title="já está na fila de alterações"' : "") + ">Apagar</button></span>") + "</div>";
    }).join("") + "</div>";

    h += '<h2 class="titulo-secao pv-h2"><span>Clientes</span><button type="button" class="btn p primario" data-oa="novo-cliente">Novo cliente</button></h2>';
    h += '<div class="card">' + D.clientes.map(function (c) {
      var a = app(c.app), fila = naFila("oauth.cliente", c.id), aberto = S.aberto === c.id, conf = c.tipo === "confidencial";
      var sit = !c.ativo ? '<span class="pv-sit perigo">desligado</span>' : conf && !c.segredo ? '<span class="pv-sit atencao">sem segredo</span>' : '<span class="pv-sit ok">ligado</span>';
      var acoes = '<button type="button" class="btn mini" data-oa="integrar" data-id="' + esc(c.id) + '" aria-expanded="' + aberto + '">Como integrar</button>';
      if (!c.codigo) {
        acoes += '<button type="button" class="btn mini" data-oa="editar-cliente" data-id="' + esc(c.id) + '">Editar</button>' +
          (conf ? '<button type="button" class="btn mini" data-oa="segredo" data-id="' + esc(c.id) + '">' + (c.segredo ? "Trocar o segredo" : "Gerar o segredo") + "</button>" : "") +
          '<button type="button" class="btn mini" data-oa="' + (c.ativo ? "desligar" : "ligar") + '" data-id="' + esc(c.id) + '"' + (fila ? " disabled" : "") + ">" + (c.ativo ? "Desligar" : "Ligar") + "</button>" +
          '<button type="button" class="btn mini perigo" data-oa="apagar-cliente" data-id="' + esc(c.id) + '"' + (fila ? ' disabled title="já está na fila de alterações"' : "") + ">Apagar</button>";
      }
      return '<div class="oa-cliente"><div class="item oa-item"><span class="nome"><strong><code>' + esc(c.id) + "</code> " + sit + "</strong>" +
        "<small>" + esc(a ? a.nome : c.app) + " · " + (conf ? "confidencial (servidor)" : "público (PKCE)") + (c.codigo ? " · do código" : "") +
        (c.segredo ? " · segredo de " + esc(U.quando(c.segredo.quando)) + " por " + esc(c.segredo.por) : "") + (fila ? ' · <span class="pv-atencao">na fila</span>' : "") + "</small>" +
        "<small>" + voltasDe(c).map(esc).join(" · ") + "</small></span>" +
        '<span class="pv-par">' + acoes + "</span></div>" + (aberto ? integrar(c) : "") + "</div>";
    }).join("") + "</div>";

    h += terceiros(D);

    h += '<h2 class="titulo-secao pv-h2"><span>O que vale para quem já entrou</span></h2>' +
      '<div class="card oa-regras"><ul>' +
      "<li>Quem pode entrar: cada aplicativo tem “só as pessoas liberadas” (o padrão de todo aplicativo novo: entram quem o criou e os e-mails da lista) ou “qualquer Conta Atos”. A Atos confere antes de pedir a permissão, na troca do código e em cada userinfo: tirar alguém da lista corta o próximo login e o userinfo.</li>" +
      "<li>Desligar ou apagar um cliente: novos logins com ele param, o código ainda não trocado não vira token e o access_token já emitido deixa de valer no userinfo. A mudança chega a todos os lugares em geral em até um minuto (o tempo do KV).</li>" +
      "<li>O id_token já emitido continua válido até vencer (até " + Math.round(D.token_s / 60) + " minutos): ele é assinado e o sistema o confere sozinho, sem perguntar à Atos. A sessão que o sistema criou com ele é do sistema; a Atos não a encerra.</li>" +
      "<li>Apagar um aplicativo leva os clientes dele. A permissão que as pessoas deram não vale para um aplicativo criado de novo com o mesmo id: elas permitem de novo.</li>" +
      "<li>Trocar o segredo: o anterior para de valer na hora; o servidor que ainda usa o antigo não consegue trocar códigos até receber o novo.</li>" +
      "<li>Retroagir uma publicação traz de volta o que foi apagado, menos o segredo: gere outro.</li>" +
      "</ul></div>";
    return h;
  }

  /* ------------------------------------------------------------ os pop-ups */
  function campo(rotulo, id, valor, extra) {
    return '<label class="campo"><span class="rotulo">' + esc(rotulo) + '</span><input id="oa-' + id + '" data-oa-in="' + id + '" value="' + esc(valor || "") + '" autocomplete="off" spellcheck="false"' + (extra || "") + "></label>";
  }
  function area(rotulo, id, valor, dica) {
    return '<label class="campo"><span class="rotulo">' + esc(rotulo) + '</span><textarea id="oa-' + id + '" data-oa-in="' + id + '" spellcheck="false">' + esc(valor || "") + "</textarea>" +
      (dica ? '<span class="dica">' + esc(dica) + "</span>" : "") + "</label>";
  }
  function modalForm() {
    var X = S.form, v = X.v, erro = X.erro ? '<p class="erro" role="alert">' + esc(X.erro) + "</p>" : "";
    var pe = '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button><button type="button" class="btn p primario" data-oa="salvar"' + (X.enviando ? " disabled" : "") + ">" +
      (X.enviando ? "Pondo na fila…" : "Pôr na fila") + "</button></div>";
    if (X.tipo === "app") {
      return '<h2 id="modal-titulo">' + (X.acao === "criar" ? "Novo aplicativo" : "Editar " + esc(v.nome)) + "</h2>" +
        "<p>Quem entra vê o nome, a descrição, o ícone e os links da política de privacidade e dos termos na tela de permitir.</p>" +
        (X.acao === "criar" ? campo("Id (não muda depois; letras minúsculas, números e hífen)", "id", v.id) : "") +
        campo("Nome", "nome", v.nome) + campo("Descrição curta (ex.: mapas de plantio)", "descricao", v.descricao) +
        campo("Site (https)", "site", v.site, ' type="url"') + campo("Política de privacidade (https)", "privacidade", v.privacidade, ' type="url"') + campo("Termos de uso (https)", "termos", v.termos, ' type="url"') +
        '<div class="campo"><span class="rotulo">Ícone (opcional)</span><div class="oa-icone">' + icone({ icone: v.icone, nome: v.nome || v.id }, "oa-previa") +
        '<label class="btn mini nf-arquivo"><span>Escolher imagem</span><input type="file" accept="image/png,image/jpeg,image/webp" data-oa-arq="icone"></label>' +
        (v.icone ? '<button type="button" class="btn mini" data-oa="sem-icone">Tirar o ícone</button>' : "") + "</div>" +
        '<span class="dica">PNG, JPEG ou WebP de até 30 KB, quadrada. Fica guardada junto do aplicativo (a página de entrar não carrega imagem de fora). Sem ícone, aparece a inicial do nome.</span></div>' +
        '<div class="campo"><span class="rotulo">Quem pode entrar</span><div class="opcoes" role="group" aria-label="Quem pode entrar">' +
        '<button type="button" data-oa="modo" data-v="liberados" aria-pressed="' + (v.acesso !== "todos") + '">Só as pessoas liberadas</button>' +
        '<button type="button" data-oa="modo" data-v="todos" aria-pressed="' + (v.acesso === "todos") + '">Qualquer Conta Atos</button></div>' +
        '<span class="dica">' + (v.acesso === "todos" ? "Qualquer pessoa com Conta Atos entra." : "Entram quem criou o aplicativo e os e-mails abaixo; um e-mail sem Conta Atos entra quando a pessoa criar a conta com ele.") + "</span></div>" +
        area("Pessoas liberadas (um e-mail por linha)", "liberados", v.liberados, "Até 500. Com o cadastro aberto, a lista fica guardada, sem efeito, para quando fechar.") +
        erro + pe;
    }
    var appsKV = S.dados.apps;
    return '<h2 id="modal-titulo">' + (X.acao === "criar" ? "Novo cliente" : "Editar " + esc(v.id)) + "</h2>" +
      "<p>Um cliente é um jeito de um aplicativo pedir o login: o site, o programa instalado, o servidor. A permissão que a pessoa dá vale para o aplicativo todo.</p>" +
      (X.acao === "criar" ? campo("client_id (não muda depois; letras minúsculas, números e hífen)", "id", v.id) +
        '<label class="campo"><span class="rotulo">Aplicativo</span><select class="seletor" id="oa-app" data-oa-in="app">' + appsKV.map(function (a) {
          return '<option value="' + esc(a.id) + '"' + (a.id === v.app ? " selected" : "") + ">" + esc(a.nome + " (" + a.id + ")") + "</option>";
        }).join("") + "</select></label>" +
        '<div class="campo"><span class="rotulo">Tipo</span><div class="opcoes" role="group" aria-label="Tipo">' +
        '<button type="button" data-oa="tipo" data-v="publico" aria-pressed="' + (v.tipo === "publico") + '">Público (página ou programa)</button>' +
        '<button type="button" data-oa="tipo" data-v="confidencial" aria-pressed="' + (v.tipo === "confidencial") + '">Confidencial (servidor)</button></div>' +
        '<span class="dica">' + (v.tipo === "confidencial" ? "Troca o código no servidor, com PKCE e um segredo. O segredo você gera depois de publicar, e ele aparece uma vez só." : "Troca o código com PKCE, sem segredo: uma página que roda no navegador ou um programa instalado.") + "</span></div>"
        : "<p><strong>" + esc(v.tipo === "confidencial" ? "Confidencial (servidor)" : "Público (PKCE)") + "</strong> · " + esc((app(v.app) || {}).nome || v.app) + ". O aplicativo e o tipo não mudam: para outro, crie outro cliente.</p>") +
      area("Endereços de volta (um por linha)", "voltas", v.voltas, "Exatamente como o sistema manda em redirect_uri: https; http só em 127.0.0.1 ou [::1]; sem #.") +
      '<label class="nf-marcar oa-marcar"><input type="checkbox" data-oa-in="loopback"' + (v.loopback ? " checked" : "") + "><span>Programa instalado: aceita a volta em qualquer porta de http://127.0.0.1 e http://[::1] (RFC 8252)</span></label>" +
      area("Origens para CORS (uma por linha, opcional)", "origens", v.origens, "Só se uma página troca o código no navegador: o esquema, o host e a porta (ex.: https://exemplo.com.br).") +
      erro + pe;
  }
  function modalApagar() {
    var X = S.form, cl = X.tipo === "app" ? S.dados.clientes.filter(function (c) { return c.app === X.v.id; }) : [];
    return '<h2 id="modal-titulo">Apagar ' + esc(X.tipo === "app" ? "o aplicativo " + X.v.nome : "o cliente " + X.v.id) + "</h2>" +
      "<p>" + (X.tipo === "app"
        ? "O aplicativo sai do Entrar com Atos" + (cl.length ? " e leva " + (cl.length === 1 ? "o cliente " : "os clientes ") + cl.map(function (c) { return c.id; }).join(", ") + " (e os segredos deles)" : "") +
          ". As pessoas que permitiram deixam de vê-lo na Minha conta; se ele for criado de novo, elas permitem de novo."
        : "Os logins com este cliente param" + (X.v.tipo === "confidencial" ? " e o segredo dele é apagado" : "") + ".") +
      " Entra na fila e vale quando você confirmar as alterações. O id_token já emitido vale até vencer.</p>" +
      (X.erro ? '<p class="erro" role="alert">' + esc(X.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-oa="apagar-ok" data-foco' + (X.enviando ? " disabled" : "") + ">Apagar</button></div>";
  }
  function modalSegredo() {
    var G = S.seg, c = cliente(G.id) || { id: G.id };
    if (G.valor) {
      textos["segredo"] = G.valor;
      return '<h2 id="modal-titulo">O segredo de ' + esc(c.id) + "</h2>" +
        "<p><strong>Ele aparece só agora.</strong> A Atos guarda só um resumo dele e não consegue mostrá-lo de novo; se perder, gere outro.</p>" +
        '<div class="oa-maquina"><div class="oa-maquina-cab"><span>client_secret</span>' + botaoCopiar("segredo") + '</div><pre class="oa-pre oa-segredo" data-texto="segredo">' + esc(G.valor) + "</pre></div>" +
        '<p class="dica">Guarde-o no servidor do sistema, na variável de ambiente <code>ATOS_CLIENT_SECRET</code>. Nunca no código, no repositório, na página ou num pedido para um assistente.</p>' +
        '<div class="botoes"><button type="button" class="btn p primario" data-admin="fechar-modal" data-foco>Já guardei</button></div>';
    }
    return '<h2 id="modal-titulo">' + (c.segredo ? "Trocar o segredo de " : "Gerar o segredo de ") + esc(c.id) + "</h2>" +
      "<p>Vale na hora, sem passar pela fila" + (c.segredo ? ": <strong>o segredo de agora para de valer</strong>, e o servidor que o usa não troca códigos até receber o novo" : "") +
      ". O novo aparece uma vez só, na próxima tela. Fica registrado quem gerou e quando.</p>" +
      (G.erro ? '<p class="erro" role="alert">' + esc(G.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button><button type="button" class="btn p ' + (c.segredo ? "perigo" : "primario") + '" data-oa="segredo-ok" data-foco' +
      (G.enviando ? " disabled" : "") + ">" + (G.enviando ? "Gerando…" : c.segredo ? "Trocar o segredo" : "Gerar o segredo") + "</button></div>";
  }

  function linhas(t) { return String(t || "").split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); }
  /* Poe na fila da Atos; o erro do servidor fica no pop-up. */
  function enfileirar(tipo, alvo, dados, texto) {
    var X = S.form;
    X.enviando = true; X.erro = ""; A.modal.repintar();
    A.pedir("POST", "/api/admin/alteracoes", { tela: "login-atos", tipo: tipo, alvo: alvo, dados: dados, texto: texto }).then(function () {
      if (S.form !== X) return;
      A.modal.fechar();
      if (F()) { F().carregar(); F().avisarFila(); }
    }, function (e) {
      if (S.form !== X) return;
      X.enviando = false; X.erro = e.status === 401 ? "" : e.message; A.modal.repintar();
    });
  }
  function salvar() {
    var X = S.form, v = X.v;
    if (!X || X.enviando) return;
    if (X.tipo === "app") {
      var d = { acao: X.acao, id: v.id.trim(), nome: v.nome.trim(), descricao: v.descricao.trim(), site: v.site.trim(), privacidade: v.privacidade.trim(), termos: v.termos.trim(), icone: v.icone || "",
        acesso: v.acesso === "todos" ? "todos" : "liberados", liberados: String(v.liberados || "").split(/[\s,;]+/).filter(Boolean) };
      enfileirar("oauth.app", d.id, d, (X.acao === "criar" ? "Cadastrei o aplicativo " : "Editei o aplicativo ") + (d.nome || d.id));
      return;
    }
    var c = { acao: X.acao, id: v.id.trim(), voltas: linhas(v.voltas), loopback: Boolean(v.loopback), origens: linhas(v.origens) };
    if (X.acao === "criar") { c.app = v.app; c.tipo = v.tipo; }
    enfileirar("oauth.cliente", c.id, c, (X.acao === "criar" ? "Cadastrei o cliente " : "Editei o cliente ") + c.id + (X.acao === "criar" ? " (" + (c.tipo === "confidencial" ? "confidencial" : "público") + ")" : ""));
  }

  /* Copiar: a area de transferencia; se o navegador recusar, o texto fica selecionado para o Ctrl+C. */
  function copiar(chave, botao) {
    var t = textos[chave];
    if (t == null) return;
    var planoB = function () {
      var pre = document.querySelector('[data-texto="' + chave.replace(/"/g, "") + '"]'), ok = false;
      if (pre) {
        var r = document.createRange(); r.selectNodeContents(pre);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      }
      A.toast(ok ? "Copiado" : pre ? "Não consegui copiar sozinho: o texto está selecionado, use Ctrl+C" : "Não consegui copiar: selecione o texto e use Ctrl+C", !ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { A.toast("Copiado"); if (botao) botao.focus(); }, planoB);
    } else planoB();
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-oa]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-oa"), id = b.getAttribute("data-id");
    if (a === "recarregar") { carregar(); pintar(); return; }
    if (a === "copiar") { copiar(b.getAttribute("data-chave"), b); return; }
    if (a === "integrar") { S.aberto = S.aberto === id ? "" : id; pintar(); return; }
    var fechar = function () { S.form = null; };
    if (a === "novo-app") {
      S.form = { tipo: "app", acao: "criar", v: { id: "", nome: "", descricao: "", site: "", privacidade: "", termos: "", icone: "", acesso: "liberados", liberados: "" }, erro: "" };
      A.modal.abrir({ html: modalForm, classe: "largo", aoFechar: fechar }); return;
    }
    if (a === "editar-app") {
      var ap = app(id); if (!ap) return;
      S.form = { tipo: "app", acao: "editar", v: { id: ap.id, nome: ap.nome, descricao: ap.descricao, site: ap.site, privacidade: ap.privacidade, termos: ap.termos, icone: ap.icone || "",
        acesso: ap.acesso === "todos" ? "todos" : "liberados", liberados: (ap.liberados || []).join("\n") }, erro: "" };
      A.modal.abrir({ html: modalForm, classe: "largo", aoFechar: fechar }); return;
    }
    if (a === "modo") { if (S.form) { S.form.v.acesso = b.getAttribute("data-v"); A.modal.repintar(); } return; }
    if (a === "terc-ver") { S.tercAberto = S.tercAberto === id ? "" : id; pintar(); return; }
    if (a === "terc-desligar" || a === "terc-apagar") {
      S.terc = { id: id, acao: a === "terc-apagar" ? "apagar" : "desligar", motivo: "", erro: "", enviando: false };
      A.modal.abrir({ html: modalTerceiro, aoFechar: function () { S.terc = null; } }); return;
    }
    if (a === "terc-ligar") {
      b.disabled = true;
      A.pedir("POST", "/api/admin/oauth/terceiros/" + encodeURIComponent(id) + "/ligar", {}).then(function () { A.toast("Ligado de novo"); carregar(); },
        function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "terc-ok") {
      var T = S.terc; if (!T || T.enviando) return;
      T.enviando = true; T.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/oauth/terceiros/" + encodeURIComponent(T.id) + "/" + T.acao, { motivo: T.motivo, confirmar: T.acao === "apagar" }).then(function () {
        if (S.terc !== T) return;
        A.modal.fechar(); A.toast(T.acao === "apagar" ? "Apagado" : "Desligado"); carregar();
      }, function (er) {
        if (S.terc !== T) return;
        T.enviando = false; T.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
      return;
    }
    if (a === "novo-cliente") {
      var primeiro = S.dados.apps.filter(function (x) { return !x.codigo; })[0] || S.dados.apps[0];
      S.form = { tipo: "cliente", acao: "criar", v: { id: "", app: primeiro ? primeiro.id : "", tipo: "publico", voltas: "", loopback: false, origens: "" }, erro: "" };
      A.modal.abrir({ html: modalForm, classe: "largo", aoFechar: fechar }); return;
    }
    if (a === "editar-cliente") {
      var cl = cliente(id); if (!cl) return;
      S.form = { tipo: "cliente", acao: "editar", v: { id: cl.id, app: cl.app, tipo: cl.tipo, voltas: (cl.voltas || []).join("\n"), loopback: cl.loopback, origens: (cl.origens || []).join("\n") }, erro: "" };
      A.modal.abrir({ html: modalForm, classe: "largo", aoFechar: fechar }); return;
    }
    if (a === "tipo") { if (S.form) { S.form.v.tipo = b.getAttribute("data-v"); A.modal.repintar(); } return; }
    if (a === "sem-icone") { if (S.form) { S.form.v.icone = ""; A.modal.repintar(); } return; }
    if (a === "salvar") { salvar(); return; }
    if (a === "apagar-app" || a === "apagar-cliente") {
      var alvo = a === "apagar-app" ? app(id) : cliente(id); if (!alvo) return;
      S.form = { tipo: a === "apagar-app" ? "app" : "cliente", acao: "apagar", v: alvo, erro: "" };
      A.modal.abrir({ html: modalApagar, aoFechar: fechar }); return;
    }
    if (a === "apagar-ok") {
      var X = S.form; if (!X) return;
      enfileirar(X.tipo === "app" ? "oauth.app" : "oauth.cliente", X.v.id, { acao: "apagar", id: X.v.id }, "Apaguei " + (X.tipo === "app" ? "o aplicativo " + X.v.nome : "o cliente " + X.v.id));
      return;
    }
    if (a === "desligar" || a === "ligar") {
      var c2 = cliente(id); if (!c2) return;
      b.disabled = true;
      A.pedir("POST", "/api/admin/alteracoes", { tela: "login-atos", tipo: "oauth.cliente", alvo: id, dados: { acao: a, id: id }, texto: (a === "ligar" ? "Liguei" : "Desliguei") + " o cliente " + id })
        .then(function () { if (F()) { F().carregar(); F().avisarFila(); } }, function (er) { b.disabled = false; if (er.status !== 401) A.toast(er.message, true); });
      return;
    }
    if (a === "segredo") { S.seg = { id: id, erro: "", enviando: false, valor: "" }; A.modal.abrir({ html: modalSegredo, aoFechar: function () { S.seg = null; delete textos.segredo; carregar(); } }); return; }
    if (a === "segredo-ok") {
      var G = S.seg; if (!G || G.enviando) return;
      G.enviando = true; G.erro = ""; A.modal.repintar();
      A.pedir("POST", "/api/admin/oauth/clientes/" + encodeURIComponent(G.id) + "/segredo", { confirmar: true }).then(function (r) {
        if (S.seg !== G) return;
        G.enviando = false; G.valor = r.segredo; A.modal.repintar();
      }, function (er) {
        if (S.seg !== G) return;
        G.enviando = false; G.erro = er.status === 401 ? "" : er.message; A.modal.repintar();
      });
    }
  });
  document.addEventListener("input", function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-oa-terc") === "motivo" && S.terc) { S.terc.motivo = e.target.value; return; }
    var el = e.target.closest && e.target.closest("[data-oa-in]");
    if (!el || !S.form) return;
    var k = el.getAttribute("data-oa-in");
    S.form.v[k] = el.type === "checkbox" ? el.checked : el.value;
    if (S.form.erro) { S.form.erro = ""; var er = el.closest(".modal") && el.closest(".modal").querySelector(".erro"); if (er) er.remove(); }
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (el && el.getAttribute && el.getAttribute("data-oa-in") === "app" && S.form) { S.form.v.app = el.value; return; }
    if (el && el.getAttribute && el.getAttribute("data-oa-in") === "loopback" && S.form) { S.form.v.loopback = el.checked; return; }
    if (!el || !el.getAttribute || el.getAttribute("data-oa-arq") !== "icone" || !S.form) return;
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
    id: "login-atos",
    nome: "Login Atos",
    grupo: "Atos",
    papeis: ["dono"],
    ordem: 25,
    desenhar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.carregando) carregar();
    },
  });
})();
