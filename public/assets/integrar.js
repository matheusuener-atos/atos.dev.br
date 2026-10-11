/* "Como integrar" um sistema ao Entrar com Atos: o cartao com os dados do provedor, o fluxo em 5 passos, o comando que
   grava o .env (PowerShell e Linux/macOS), o trecho minimo em cada linguagem (integrar-linguagens.js, carregado aqui),
   um pedido pronto para colar num assistente de codigo (Claude Code etc.) e os comandos que abrem o Claude Code com o
   pedido. O segredo nunca entra no pedido, no .env gravado nem nos comandos.

   Usado pelo painel da equipe (admin-oauth.js, Login Atos) e pelo Atos Workspace (workspace-integracoes.js, Integracoes):

     IntegrarAtos.cartao(acesso, dados, nomeDoApp, onde)  -> html
       acesso: {id, tipo: "publico"|"confidencial", voltas, loopback, padrao?}
       dados:  {emissor, descoberta, autorizacao, token, userinfo, jwks, revogacao, escopos, token_s} (do servidor)
       onde:   onde se muda quem pode entrar (ex.: "atos.dev.br/workspace/integracoes")
     IntegrarAtos.voltas(acesso) -> [texto]

   Copiar (data-ig="copiar", os dados do topo) e tratado aqui; as abas e o copiar dos blocos (data-il), no
   integrar-linguagens.js. Sem estilo inline (a CSP das paginas e style-src 'self'). O estilo esta em integrar.css, que
   este arquivo poe na pagina. window.IntegrarAtos so existe (e o evento "integrar-atos" so sai) depois que o
   integrar-linguagens.js carregou. */
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

  /* A volta que vai no .env: a primeira cadastrada (ou um exemplo, no programa instalado). */
  function voltaDoEnv(c) {
    if (c.voltas && c.voltas.length) return c.voltas[0];
    if (c.loopback) return "http://127.0.0.1:8765/retorno";
    return c.padrao || "";
  }

  function cartao(c, D, nomeApp, onde) {
    var L = window.IntegrarLinguagens;
    var conf = c.tipo === "confidencial";
    var pedido = pedidoPara(c, D, nomeApp, onde || "na Atos");
    textos["disc:" + c.id] = D.descoberta;
    textos["id:" + c.id] = c.id;
    var base = "ig-" + c.id;
    var v = { emissor: D.emissor, clientId: c.id, volta: voltaDoEnv(c), confidencial: conf };
    var linha = function (rotulo, valor) { return "<dt>" + esc(rotulo) + "</dt><dd><code>" + esc(valor) + "</code></dd>"; };
    return '<div class="ig-cartao" data-ig-cartao="' + esc(c.id) + '">' +
      '<h3 class="titulo-secao ig-h3">Como integrar</h3>' +
      '<dl class="ig-info">' +
      "<dt>Discovery</dt><dd><code>" + esc(D.descoberta) + "</code> " + botaoCopiar("disc:" + c.id) + "</dd>" +
      linha("Issuer", D.emissor) +
      "<dt>client_id</dt><dd><code>" + esc(c.id) + "</code> " + botaoCopiar("id:" + c.id) + "</dd>" +
      linha("Autorização", D.autorizacao) + linha("Token", D.token) + linha("Userinfo", D.userinfo) + linha("JWKS", D.jwks) + linha("Revogação", D.revogacao) +
      linha("Escopos", D.escopos.map(function (s) { return s.id; }).join(" ")) +
      "<dt>Autenticação</dt><dd>" + (conf ? "PKCE S256 e o <code>client_secret</code> (client_secret_basic ou client_secret_post), só no servidor" : "PKCE S256, sem segredo (cliente público)") + "</dd>" +
      "<dt>Volta</dt><dd>" + voltasDe(c).map(function (x) { return "<code>" + esc(x) + "</code>"; }).join("<br>") + "</dd>" +
      "</dl>" +
      '<ol class="ig-passos">' +
      "<li>O sistema gera <code>code_verifier</code>, <code>state</code> e <code>nonce</code> e abre <code>" + esc(D.autorizacao) + "</code> com o <code>client_id</code>, a volta, os escopos e o <code>code_challenge</code> (S256).</li>" +
      "<li>A pessoa entra com a Conta Atos. A Atos confere se ela pode entrar neste aplicativo; se pode, na primeira vez ela permite.</li>" +
      "<li>A Atos volta ao endereço cadastrado com <code>code</code>, <code>state</code> e <code>iss</code> (ou com <code>error=access_denied</code>, se a conta não tem acesso ou a pessoa recusou); o sistema confere o <code>state</code> e o <code>iss</code>.</li>" +
      "<li>O sistema troca o <code>code</code> em <code>" + esc(D.token) + "</code> com o <code>code_verifier</code>" + (conf ? " e o segredo (no servidor)" : "") + ".</li>" +
      "<li>O sistema valida o <code>id_token</code> (ES256 pelo JWKS; <code>iss</code>, <code>aud</code>, <code>exp</code>, <code>nonce</code>) e cria a sessão pelo <code>sub</code>. Os tokens valem " + Math.round(D.token_s / 60) + " minutos; não há refresh_token.</li>" +
      "</ol>" +
      '<h4 class="ig-h4">1. Grave o .env</h4>' +
      '<p class="dica">Rode na pasta do seu projeto. O comando lê a descoberta da Atos só para conferir que ela responde e grava no <code>.env</code> <code>ATOS_ISSUER</code>, <code>ATOS_CLIENT_ID</code> e <code>ATOS_REDIRECT_URI</code> (<code>' + esc(v.volta) + "</code>)" +
      (conf ? ", e a linha <code>ATOS_CLIENT_SECRET=</code> vazia, para você colar o segredo (ele não vai no comando)" : "") +
      ". Não baixa nem executa nada, mantém as outras linhas, não duplica chaves e avisa se o <code>.env</code> não estiver no <code>.gitignore</code>.</p>" +
      L.envHtml(v, base + "-env") +
      '<h4 class="ig-h4">2. Escolha a linguagem</h4>' +
      '<p class="dica">' + (conf ? "Os exemplos de servidor leem o <code>.env</code>." : "Num acesso público, use o de JavaScript (navegador); os de servidor são para um acesso confidencial e leem o <code>.env</code>.") +
      " As linguagens marcadas “não testado” foram escritas pela documentação da biblioteca, sem rodar aqui.</p>" +
      L.linguagensHtml(v, base + "-ling") +
      '<h4 class="ig-h4">Ou peça a um assistente de código</h4>' +
      L.blocoHtml("Pedido para um assistente de código", pedido, "Pedido para um assistente de código") +
      L.abasHtml(base + "-claude", "Sistema", [
        { id: "ps", rotulo: "PowerShell", html: L.blocoHtml("Comando", comandos(c, D, pedido, false), "Comando para PowerShell") },
        { id: "sh", rotulo: "Linux e macOS", html: L.blocoHtml("Comando", comandos(c, D, pedido, true), "Comando para Linux e macOS") },
      ]) +
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
    var planoB = function () { avisar("Selecione e copie"); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { avisar("Copiado"); }, planoB);
    else planoB();
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest('[data-ig="copiar"]');
    if (b) copiar(b.getAttribute("data-chave"), b);
  });

  // Os trechos de cada linguagem e as abas (integrar-linguagens.js): o cartao so fica pronto depois deles.
  function pronto() {
    if (window.IntegrarAtos) return;
    window.IntegrarAtos = { cartao: cartao, voltas: voltasDe, pedido: pedidoPara };
    document.dispatchEvent(new Event("integrar-atos"));
  }
  if (window.IntegrarLinguagens) { pronto(); return; }
  var js = document.querySelector('script[src="/assets/integrar-linguagens.js"]');
  if (!js) {
    js = document.createElement("script");
    js.src = "/assets/integrar-linguagens.js";
    document.head.appendChild(js);
  }
  js.addEventListener("load", pronto);
})();
