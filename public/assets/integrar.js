/* "Como integrar" um sistema ao Entrar com Atos: o cartao com os dados do provedor, o fluxo em 5 passos, um pedido
   pronto para colar num assistente de codigo (Claude Code etc.) e os comandos (PowerShell e Linux/macOS) que conferem o
   discovery e abrem o Claude Code com o pedido. O segredo nunca entra no pedido nem nos comandos.

   Usado pelo painel da equipe (admin-oauth.js, Login Atos) e pela Minha conta (conta-integracoes.js, Integracoes):

     IntegrarAtos.cartao(acesso, dados, nomeDoApp, onde)  -> html
       acesso: {id, tipo: "publico"|"confidencial", voltas, loopback, padrao?}
       dados:  {emissor, descoberta, autorizacao, token, userinfo, jwks, revogacao, escopos, token_s} (do servidor)
       onde:   onde se muda quem pode entrar (ex.: "atos.dev.br/conta/integracoes")
     IntegrarAtos.voltas(acesso) -> [texto]

   Copiar e trocar de aba sao tratados aqui (data-ig="copiar" | "aba"), sem estilo inline (a CSP das paginas e
   style-src 'self'). O estilo esta em integrar.css, que este arquivo poe na pagina. */
(function () {
  "use strict";
  if (window.IntegrarAtos) return;
  if (!document.querySelector('link[href="/assets/integrar.css"]')) {
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/integrar.css";
    document.head.appendChild(l);
  }
  var textos = {};

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function botaoCopiar(chave, rotulo) {
    return '<button type="button" class="btn mini" data-ig="copiar" data-chave="' + esc(chave) + '">' + esc(rotulo || "Copiar") + "</button>";
  }

  function voltasDe(c) {
    var l = (c.voltas || []).slice();
    if (c.padrao) l.push(c.padrao);
    if (c.loopback) l.push("http://127.0.0.1:<porta livre>/<caminho> (programa instalado; [::1] também)");
    return l;
  }

  function pedidoPara(c, D, nomeApp, onde) {
    var conf = c.tipo === "confidencial";
    var linhas = [
      "Implemente o login 'Entrar com Atos' (OpenID Connect) neste projeto, para o aplicativo " + nomeApp + ".",
      "",
      "Dados do provedor (confira em " + D.descoberta + "):",
      "- issuer: " + D.emissor,
      "- authorization_endpoint: " + D.autorizacao,
      "- token_endpoint: " + D.token,
      "- userinfo_endpoint: " + D.userinfo,
      "- jwks_uri: " + D.jwks,
      "- revocation_endpoint: " + D.revogacao,
      "- client_id: " + c.id,
      "- redirect_uri (exatamente um destes): " + voltasDe(c).join(" | "),
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
      "7. Quem pode entrar quem decide é a Atos, no cadastro deste aplicativo (" + onde + "): a lista de pessoas liberadas ou o cadastro aberto a qualquer Conta Atos. Não crie no sistema outra lista de quem pode entrar pela Atos.",
      "8. Trate error=access_denied na volta (também com prompt=none): a pessoa recusou, ou a Conta Atos dela não tem acesso a este aplicativo. Mostre algo como 'Sua Conta Atos não tem acesso a " + nomeApp +
        ". Peça a quem administra o sistema.' e ofereça entrar com outra conta; não trate como falha do sistema. Se o token_endpoint responder invalid_grant ou o userinfo_endpoint responder 401, a pessoa pode ter sido tirada da lista: encerre a sessão local e não tente de novo sozinho.",
      conf ? "9. O client_secret só no servidor, lido de ATOS_CLIENT_SECRET: nunca no front-end, em log, em mensagem de erro ou no repositório. Se este projeto não tiver servidor, pare e me avise: um cliente confidencial precisa de um."
        : "9. Nenhum segredo no front-end nem no repositório (este cliente não tem nenhum).",
      "10. Mostre um botão 'Entrar com Atos' e uma forma de sair (apague a sessão local; para invalidar o access_token, POST no revocation_endpoint com token=<access_token>).",
    ];
    if (c.loopback) linhas.push("11. Programa instalado (RFC 8252): abra o navegador do sistema e receba a volta num servidor local em http://127.0.0.1 numa porta livre; use a mesma redirect_uri na ida e na troca do código.");
    linhas.push("", "Antes de mudar arquivos, olhe a estrutura do projeto e me diga o plano (onde ficam a ida, a volta e a sessão). Não instale nada sem me dizer o que é e por quê.");
    return linhas.join("\n");
  }
  function comandos(c, D, pedido, sh) {
    var l = [
      "# 1. Confira o discovery (os endereços que o projeto vai usar)",
      (sh ? "curl -fsS " : "Invoke-RestMethod ") + D.descoberta,
      "",
      "# 2. Na pasta do seu projeto, abra o Claude Code com o pedido. Precisa do Claude Code instalado",
      "#    (https://claude.com/claude-code); você acompanha e aprova cada mudança.",
    ];
    if (c.tipo === "confidencial") l.push("#    O client_secret NÃO vai aqui: ponha-o na variável ATOS_CLIENT_SECRET do servidor.");
    return l.concat(sh ? ["claude \"$(cat <<'PEDIDO'", pedido, "PEDIDO", ")\""] : ["$pedido = @'", pedido, "'@", "claude $pedido"]).join("\n");
  }

  function cartao(c, D, nomeApp, onde) {
    var conf = c.tipo === "confidencial";
    var pedido = pedidoPara(c, D, nomeApp, onde || "na Atos");
    textos["pedido:" + c.id] = pedido;
    textos["ps:" + c.id] = comandos(c, D, pedido, false);
    textos["sh:" + c.id] = comandos(c, D, pedido, true);
    textos["disc:" + c.id] = D.descoberta;
    textos["id:" + c.id] = c.id;
    var linha = function (rotulo, valor) { return "<dt>" + esc(rotulo) + "</dt><dd><code>" + esc(valor) + "</code></dd>"; };
    var aba = function (v, rotulo, sel) {
      return '<button type="button" role="tab" data-ig="aba" data-v="' + v + '" data-id="' + esc(c.id) + '" aria-selected="' + sel + '">' + rotulo + "</button>";
    };
    return '<div class="ig-cartao" data-ig-cartao="' + esc(c.id) + '">' +
      '<h3 class="titulo-secao ig-h3">Como integrar</h3>' +
      '<dl class="ig-info">' +
      "<dt>Discovery</dt><dd><code>" + esc(D.descoberta) + "</code> " + botaoCopiar("disc:" + c.id) + "</dd>" +
      linha("Issuer", D.emissor) +
      "<dt>client_id</dt><dd><code>" + esc(c.id) + "</code> " + botaoCopiar("id:" + c.id) + "</dd>" +
      linha("Autorização", D.autorizacao) + linha("Token", D.token) + linha("Userinfo", D.userinfo) + linha("JWKS", D.jwks) + linha("Revogação", D.revogacao) +
      linha("Escopos", D.escopos.map(function (s) { return s.id; }).join(" ")) +
      "<dt>Autenticação</dt><dd>" + (conf ? "PKCE S256 e o <code>client_secret</code> (client_secret_basic ou client_secret_post), só no servidor" : "PKCE S256, sem segredo (cliente público)") + "</dd>" +
      "<dt>Volta</dt><dd>" + voltasDe(c).map(function (v) { return "<code>" + esc(v) + "</code>"; }).join("<br>") + "</dd>" +
      "</dl>" +
      '<ol class="ig-passos">' +
      "<li>O sistema gera <code>code_verifier</code>, <code>state</code> e <code>nonce</code> e abre <code>" + esc(D.autorizacao) + "</code> com o <code>client_id</code>, a volta, os escopos e o <code>code_challenge</code> (S256).</li>" +
      "<li>A pessoa entra com a Conta Atos. A Atos confere se ela pode entrar neste aplicativo; se pode, na primeira vez ela permite.</li>" +
      "<li>A Atos volta ao endereço cadastrado com <code>code</code>, <code>state</code> e <code>iss</code> (ou com <code>error=access_denied</code>, se a conta não tem acesso ou a pessoa recusou); o sistema confere o <code>state</code> e o <code>iss</code>.</li>" +
      "<li>O sistema troca o <code>code</code> em <code>" + esc(D.token) + "</code> com o <code>code_verifier</code>" + (conf ? " e o segredo (no servidor)" : "") + ".</li>" +
      "<li>O sistema valida o <code>id_token</code> (ES256 pelo JWKS; <code>iss</code>, <code>aud</code>, <code>exp</code>, <code>nonce</code>) e cria a sessão pelo <code>sub</code>. Os tokens valem " + Math.round(D.token_s / 60) + " minutos; não há refresh_token.</li>" +
      "</ol>" +
      '<div class="ig-maquina">' +
      '<div class="ig-maquina-cab"><span>Pedido para um assistente de código</span>' + botaoCopiar("pedido:" + c.id) + "</div>" +
      '<pre class="ig-pre" data-texto="pedido:' + esc(c.id) + '">' + esc(pedido) + "</pre>" +
      '<div class="ig-maquina-cab ig-abas" role="tablist" aria-label="Sistema"><span>' + aba("ps", "PowerShell", true) + aba("sh", "Linux e macOS", false) + "</span>" +
      '<span data-ig-copiar-aba="' + esc(c.id) + '">' + botaoCopiar("ps:" + c.id) + "</span></div>" +
      '<pre class="ig-pre" role="tabpanel" data-aba="ps" data-texto="ps:' + esc(c.id) + '">' + esc(textos["ps:" + c.id]) + "</pre>" +
      '<pre class="ig-pre" role="tabpanel" data-aba="sh" data-texto="sh:' + esc(c.id) + '" hidden>' + esc(textos["sh:" + c.id]) + "</pre>" +
      "</div>" +
      '<p class="dica">O comando abre o Claude Code na pasta onde você está, com o pedido acima; nada é baixado nem executado de fora. ' +
      (conf ? "O segredo não está no pedido nem no comando: guarde-o na variável de ambiente <code>ATOS_CLIENT_SECRET</code> do servidor." : "Este acesso é público: não há segredo a guardar.") + "</p>" +
      "</div>";
  }

  /* Copiar: a area de transferencia; se o navegador recusar, o texto fica selecionado para o Ctrl+C. */
  function copiar(chave, botao) {
    var t = textos[chave];
    if (t == null) return;
    var avisar = function (texto) {
      var antes = botao.getAttribute("data-rotulo") || botao.textContent;
      botao.setAttribute("data-rotulo", antes);
      botao.textContent = texto;
      setTimeout(function () { botao.textContent = antes; }, 1800);
    };
    var planoB = function () {
      var pre = document.querySelector('[data-texto="' + chave.replace(/"/g, "") + '"]'), ok = false;
      if (pre && !pre.hidden) {
        var r = document.createRange(); r.selectNodeContents(pre);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      }
      avisar(ok ? "Copiado" : pre ? "Selecionado: Ctrl+C" : "Selecione e copie");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { avisar("Copiado"); }, planoB);
    else planoB();
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-ig]");
    if (!b) return;
    var a = b.getAttribute("data-ig");
    if (a === "copiar") { copiar(b.getAttribute("data-chave"), b); return; }
    if (a === "aba") {
      var cartaoEl = b.closest("[data-ig-cartao]"), v = b.getAttribute("data-v"), id = b.getAttribute("data-id");
      if (!cartaoEl) return;
      cartaoEl.querySelectorAll('[role="tab"]').forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
      cartaoEl.querySelectorAll("pre[data-aba]").forEach(function (x) { x.hidden = x.getAttribute("data-aba") !== v; });
      var lugar = cartaoEl.querySelector("[data-ig-copiar-aba]");
      if (lugar) lugar.innerHTML = botaoCopiar(v + ":" + id);
    }
  });

  window.IntegrarAtos = { cartao: cartao, voltas: voltasDe, pedido: pedidoPara };
  document.dispatchEvent(new Event("integrar-atos"));
})();
