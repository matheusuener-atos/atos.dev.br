/* O painel da Atos, secao Login Atos: os sistemas que usam o "Entrar com Atos" (OpenID Connect). O servidor e o
   worker/oidc-painel.js; so o papel Dono ve e muda.

     GET  /api/admin/oauth                          os aplicativos e clientes (os do codigo, so leitura, e os do KV),
                                                    o discovery, os endpoints, os escopos e a validade do token
     POST /api/admin/alteracoes                     criar, editar, ligar, desligar e apagar (tipos oauth.app e
                                                    oauth.cliente): vao para a fila da Atos e valem ao confirmar
     POST /api/admin/oauth/clientes/:id/segredo     gerar ou trocar o segredo de um cliente confidencial: na hora,
                                                    com confirmacao aqui; o valor aparece uma vez so

   Para cada cliente, "Como integrar": os dados do provedor, o fluxo em 5 passos, um pedido pronto para colar num
   assistente de codigo (Claude Code etc.) e os comandos (PowerShell e Linux/macOS) que conferem o discovery e abrem
   o Claude Code com o pedido. O segredo nunca entra no pedido nem nos comandos. */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var esc = A.esc, U = A.util;
  var S = { raiz: null, dados: null, erro: "", carregando: false, aberto: "", aba: "ps", form: null, seg: null };
  var ICONE_MAX = 30 * 1024;
  var textos = {}; // o que cada botao "Copiar" copia (preenchido ao desenhar)

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

  /* ------------------------------------------------------------ o texto de integrar */
  function voltasDe(c) {
    var l = (c.voltas || []).slice();
    if (c.padrao) l.push(c.padrao);
    if (c.loopback) l.push("http://127.0.0.1:<porta livre>/<caminho> (programa instalado; [::1] também)");
    return l;
  }
  function pedidoPara(c) {
    var D = S.dados, conf = c.tipo === "confidencial", a = app(c.app) || { nome: c.app };
    var voltas = voltasDe(c);
    var linhas = [
      "Implemente o login 'Entrar com Atos' (OpenID Connect) neste projeto, para o aplicativo " + a.nome + ".",
      "",
      "Dados do provedor (confira em " + D.descoberta + "):",
      "- issuer: " + D.emissor,
      "- authorization_endpoint: " + D.autorizacao,
      "- token_endpoint: " + D.token,
      "- userinfo_endpoint: " + D.userinfo,
      "- jwks_uri: " + D.jwks,
      "- revocation_endpoint: " + D.revogacao,
      "- client_id: " + c.id,
      "- redirect_uri (exatamente um destes): " + voltas.join(" | "),
      "- escopos: " + D.escopos.map(function (s) { return s.id; }).join(" "),
      "- cliente " + (conf ? "confidencial: autentique no token_endpoint com client_secret_basic; o client_secret fica na variável de ambiente ATOS_CLIENT_SECRET do servidor"
        : "público: não existe client_secret"),
      "",
      "Regras:",
      "1. Fluxo authorization code com PKCE S256 (obrigatório na Atos): a cada login, gere um code_verifier aleatório (43 a 128 caracteres) e mande code_challenge = BASE64URL(SHA-256(code_verifier)) com code_challenge_method=S256 e response_type=code.",
      "2. A cada login, gere também state e nonce aleatórios; guarde-os com o code_verifier (na sessão do servidor ou, numa página sem servidor, em sessionStorage) e, na volta, confira o state antes de qualquer outra coisa.",
      "3. Na volta: se vier error, mostre a mensagem e pare; confira que o parâmetro iss é exatamente " + D.emissor + ".",
      "4. Troque o code no token_endpoint: POST application/x-www-form-urlencoded com grant_type=authorization_code, code, redirect_uri (a mesma da ida), code_verifier" +
        (conf ? " e a autenticação client_secret_basic (Authorization: Basic com client_id e client_secret). Essa troca acontece só no servidor." : " e client_id."),
      "5. Valide o id_token com uma biblioteca JOSE/JWT conhecida (não implemente criptografia à mão): assinatura ES256 com a chave do jwks_uri escolhida pelo kid, iss igual a " + D.emissor +
        ", aud igual a " + c.id + ", exp no futuro (tolerância de poucos segundos) e nonce igual ao guardado. Só então crie a sessão, identificando a pessoa pelo claim sub (o e-mail pode mudar; use email e name só para mostrar).",
      "6. O id_token e o access_token valem " + Math.round(D.token_s / 60) + " minutos e não há refresh_token: para renovar, comece o login de novo (prompt=none tenta sem mostrar tela; se voltar login_required ou consent_required, faça o login normal).",
      conf ? "7. O client_secret só no servidor, lido de ATOS_CLIENT_SECRET: nunca no front-end, em log, em mensagem de erro ou no repositório. Se este projeto não tiver servidor, pare e me avise: um cliente confidencial precisa de um."
        : "7. Nenhum segredo no front-end nem no repositório (este cliente não tem nenhum).",
      "8. Mostre um botão 'Entrar com Atos' e uma forma de sair (apague a sessão local; para invalidar o access_token, POST no revocation_endpoint com token=<access_token>).",
    ];
    if (c.loopback) linhas.push("9. Programa instalado (RFC 8252): abra o navegador do sistema e receba a volta num servidor local em http://127.0.0.1 numa porta livre; use a mesma redirect_uri na ida e na troca do código.");
    linhas.push("", "Antes de mudar arquivos, olhe a estrutura do projeto e me diga o plano (onde ficam a ida, a volta e a sessão). Não instale nada sem me dizer o que é e por quê.");
    return linhas.join("\n");
  }
  function comandosPs(c, pedido) {
    return [
      "# 1. Confira o discovery (os endereços que o projeto vai usar)",
      "Invoke-RestMethod " + S.dados.descoberta,
      "",
      "# 2. Na pasta do seu projeto, abra o Claude Code com o pedido. Precisa do Claude Code instalado",
      "#    (https://claude.com/claude-code); você acompanha e aprova cada mudança.",
    ].concat(c.tipo === "confidencial" ? ["#    O client_secret NÃO vai aqui: ponha-o na variável ATOS_CLIENT_SECRET do servidor."] : []).concat([
      "$pedido = @'",
      pedido,
      "'@",
      "claude $pedido",
    ]).join("\n");
  }
  function comandosSh(c, pedido) {
    return [
      "# 1. Confira o discovery (os endereços que o projeto vai usar)",
      "curl -fsS " + S.dados.descoberta,
      "",
      "# 2. Na pasta do seu projeto, abra o Claude Code com o pedido. Precisa do Claude Code instalado",
      "#    (https://claude.com/claude-code); você acompanha e aprova cada mudança.",
    ].concat(c.tipo === "confidencial" ? ["#    O client_secret NÃO vai aqui: ponha-o na variável ATOS_CLIENT_SECRET do servidor."] : []).concat([
      "claude \"$(cat <<'PEDIDO'",
      pedido,
      "PEDIDO",
      ")\"",
    ]).join("\n");
  }

  function integrar(c) {
    var D = S.dados, conf = c.tipo === "confidencial";
    var pedido = pedidoPara(c);
    textos["pedido:" + c.id] = pedido;
    textos["ps:" + c.id] = comandosPs(c, pedido);
    textos["sh:" + c.id] = comandosSh(c, pedido);
    textos["disc:" + c.id] = D.descoberta;
    textos["id:" + c.id] = c.id;
    var linha = function (rotulo, valor) { return "<dt>" + esc(rotulo) + '</dt><dd><code>' + esc(valor) + "</code></dd>"; };
    var aba = S.aba === "sh" ? "sh" : "ps";
    return '<div class="nf-det oa-integrar">' +
      '<h3 class="titulo-secao oa-h3">Como integrar</h3>' +
      '<dl class="nf-info">' +
      '<dt>Discovery</dt><dd><code>' + esc(D.descoberta) + "</code> " + botaoCopiar("disc:" + c.id) + "</dd>" +
      linha("Issuer", D.emissor) +
      '<dt>client_id</dt><dd><code>' + esc(c.id) + "</code> " + botaoCopiar("id:" + c.id) + "</dd>" +
      linha("Autorização", D.autorizacao) + linha("Token", D.token) + linha("Userinfo", D.userinfo) + linha("JWKS", D.jwks) + linha("Revogação", D.revogacao) +
      linha("Escopos", D.escopos.map(function (s) { return s.id; }).join(" ")) +
      "<dt>Autenticação</dt><dd>" + (conf ? "PKCE S256 e o <code>client_secret</code> (client_secret_basic ou client_secret_post), só no servidor" : "PKCE S256, sem segredo (cliente público)") + "</dd>" +
      "<dt>Volta</dt><dd>" + voltasDe(c).map(function (v) { return "<code>" + esc(v) + "</code>"; }).join("<br>") + "</dd>" +
      "</dl>" +
      '<ol class="oa-passos">' +
      "<li>O sistema gera <code>code_verifier</code>, <code>state</code> e <code>nonce</code> e abre <code>" + esc(D.autorizacao) + "</code> com o <code>client_id</code>, a volta, os escopos e o <code>code_challenge</code> (S256).</li>" +
      "<li>A pessoa entra com a Conta Atos e, na primeira vez, permite o aplicativo.</li>" +
      "<li>A Atos volta ao endereço cadastrado com <code>code</code>, <code>state</code> e <code>iss</code>; o sistema confere o <code>state</code> e o <code>iss</code>.</li>" +
      "<li>O sistema troca o <code>code</code> em <code>" + esc(D.token) + "</code> com o <code>code_verifier</code>" + (conf ? " e o segredo (no servidor)" : "") + ".</li>" +
      "<li>O sistema valida o <code>id_token</code> (ES256 pelo JWKS; <code>iss</code>, <code>aud</code>, <code>exp</code>, <code>nonce</code>) e cria a sessão pelo <code>sub</code>. Os tokens valem " + Math.round(D.token_s / 60) + " minutos; não há refresh_token.</li>" +
      "</ol>" +
      '<div class="oa-maquina">' +
      '<div class="oa-maquina-cab"><span>Pedido para um assistente de código</span>' + botaoCopiar("pedido:" + c.id) + "</div>" +
      '<pre class="oa-pre" data-texto="pedido:' + esc(c.id) + '">' + esc(pedido) + "</pre>" +
      '<div class="oa-maquina-cab oa-abas" role="tablist" aria-label="Sistema">' +
      '<span><button type="button" role="tab" data-oa="aba" data-v="ps" aria-selected="' + (aba === "ps") + '">PowerShell</button>' +
      '<button type="button" role="tab" data-oa="aba" data-v="sh" aria-selected="' + (aba === "sh") + '">Linux e macOS</button></span>' + botaoCopiar(aba + ":" + c.id) + "</div>" +
      '<pre class="oa-pre" role="tabpanel" data-texto="' + aba + ":" + esc(c.id) + '">' + esc(textos[aba + ":" + c.id]) + "</pre>" +
      "</div>" +
      '<p class="dica">O comando abre o Claude Code na pasta onde você está, com o pedido acima; nada é baixado nem executado de fora. ' +
      (conf ? "O segredo não está no pedido nem no comando: guarde-o na variável de ambiente <code>ATOS_CLIENT_SECRET</code> do servidor." : "Este cliente é público: não há segredo a guardar.") + "</p>" +
      "</div>";
  }

  /* ------------------------------------------------------------ a tela */
  function tela() {
    var h = "<h1>Login Atos</h1>" +
      '<p class="descricao">Os sistemas que usam o Entrar com Atos. Os do código (o PAVLVS) só aparecem aqui. Criar, editar, desligar e apagar entram na fila da Atos e valem quando você confirmar as alterações; gerar ou trocar o segredo de um cliente vale na hora.</p>';
    if (!S.dados) return h + '<div class="card pv-topo"><p class="vazio">' + (S.erro ? "Não consegui ler o Login Atos agora: " + esc(S.erro) + ' <button type="button" class="link" data-oa="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    if (S.erro) h += '<p class="nf-aviso"><span>Não consegui atualizar agora: ' + esc(S.erro) + ". Mostrando a última leitura.</span></p>";
    var D = S.dados, pend = pendentesOAuth();
    if (pend.length) h += '<p class="nf-aviso"><span>' + pend.length + (pend.length === 1 ? " alteração do Login Atos está na fila e ainda não vale." : " alterações do Login Atos estão na fila e ainda não valem.") + ' <a href="#alteracoes" data-secao="alteracoes">Confirmar alterações</a></span></p>';

    h += '<h2 class="titulo-secao pv-h2"><span>Aplicativos</span><button type="button" class="btn p primario" data-oa="novo-app">Novo aplicativo</button></h2>';
    h += '<div class="card">' + D.apps.map(function (a) {
      var nos = D.clientes.filter(function (c) { return c.app === a.id; }).length, fila = naFila("oauth.app", a.id);
      return '<div class="item oa-item">' + icone(a) + '<span class="nome"><strong>' + esc(a.nome) + ' <span class="nf-tag">' + esc(a.id) + "</span>" +
        (a.codigo ? ' <span class="nf-tag">do código</span>' : "") + "</strong><small>" + esc(a.descricao) + " · " + esc(a.site) + " · " + nos + (nos === 1 ? " cliente" : " clientes") +
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

    h += '<h2 class="titulo-secao pv-h2"><span>O que vale para quem já entrou</span></h2>' +
      '<div class="card oa-regras"><ul>' +
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
      var d = { acao: X.acao, id: v.id.trim(), nome: v.nome.trim(), descricao: v.descricao.trim(), site: v.site.trim(), privacidade: v.privacidade.trim(), termos: v.termos.trim(), icone: v.icone || "" };
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
    if (a === "aba") { S.aba = b.getAttribute("data-v"); pintar(); return; }
    var fechar = function () { S.form = null; };
    if (a === "novo-app") {
      S.form = { tipo: "app", acao: "criar", v: { id: "", nome: "", descricao: "", site: "", privacidade: "", termos: "", icone: "" }, erro: "" };
      A.modal.abrir({ html: modalForm, classe: "largo", aoFechar: fechar }); return;
    }
    if (a === "editar-app") {
      var ap = app(id); if (!ap) return;
      S.form = { tipo: "app", acao: "editar", v: { id: ap.id, nome: ap.nome, descricao: ap.descricao, site: ap.site, privacidade: ap.privacidade, termos: ap.termos, icone: ap.icone || "" }, erro: "" };
      A.modal.abrir({ html: modalForm, classe: "largo", aoFechar: fechar }); return;
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
