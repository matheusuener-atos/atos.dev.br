/* A tela de entrar do Atos Workspace (/workspace/entrar): so o endereco <alias>@atos.dev.br e a senha da Conta Atos.
   As rotas sao as do /entrar (worker/contas.js), com {workspace: true}: o Worker recusa ali qualquer outro e-mail
   (400, codigo "so_alias") antes de consultar a conta. Aqui a tela tambem nao tenta o login com outro e-mail: explica
   e oferece o /entrar da Conta Atos (para criar o e-mail Atos).

     GET  /api/eu                       quem esta dentro: pelo alias, vai direto ao Workspace (o Worker ja redireciona
                                        o GET da pagina; aqui e a sobra); pelo e-mail pessoal, a tela pede o alias
     POST /api/entrar     {email, senha, workspace: true}
     POST /api/esqueci    {email, workspace: true}            o codigo vai ao e-mail cadastrado da conta (mascarado)
     POST /api/redefinir  {email, codigo, senha, workspace: true}

   ?volta= so um caminho de /workspace/ (o mesmo VOLTA_DO_WORKSPACE de worker/workspace.js); ?login_hint= preenche o
   endereco; ?modo=entrar mostra a tela mesmo com a sessao pelo alias (o "Entrar de novo" do login recente). O comum
   com o /entrar (o pedido, os pedacos do formulario) e entrar-comum.js. */
(function () {
  "use strict";
  var C = window.AtosEntrar;
  var esc = C.esc;
  var DOMINIO = "atos.dev.br";
  var params = new URLSearchParams(location.search);
  var VOLTA = C.volta(params, /^\/workspace(?:\/(?!entrar(?:\/|$))[a-z0-9-]+)*\/?$/) || "/workspace/";
  var CONTA_ATOS = "/entrar/?volta=" + encodeURIComponent("/workspace/email");
  var tela = document.getElementById("tela");
  var S = { modo: "carregando", email: "", erro: "", soAlias: false, ocupado: false, conta: null, para: "", etapa: null };

  function ehAlias(e) { e = String(e || "").trim().toLowerCase(); var at = e.lastIndexOf("@"); return at > 0 && e.slice(at + 1) === DOMINIO; }

  function campoEndereco() {
    return C.campo("email", "Endereço Atos", "email", 'autocomplete="username" maxlength="200" placeholder="nome@' + DOMINIO + '" required value="' + esc(S.email) + '"');
  }
  /* O erro da tela; para outro e-mail, a explicacao e o caminho da Conta Atos. */
  function erro() {
    if (S.soAlias) {
      return '<div class="we-so-alias" role="alert"><p class="erro">No Workspace você entra com o seu endereço @' + DOMINIO + ".</p>" +
        '<p class="nota">Ainda não tem? <a href="' + CONTA_ATOS + '">Entre com a sua Conta Atos para criar o seu e-mail Atos</a>.</p></div>';
    }
    return C.erro(S.erro);
  }
  /* Ja dentro da Conta Atos pelo e-mail pessoal: o Workspace pede o endereco Atos (e a mesma conta e a mesma senha). */
  function aviso() {
    if (!S.conta || S.conta.via === "alias") return "";
    return '<p class="nota we-aviso-conta">Você está na Conta Atos como <strong>' + esc(C.mascarar(S.conta.email)) + "</strong>. Para o Workspace, entre com o seu endereço Atos.</p>";
  }

  function desenhar() {
    var h = "";
    if (S.modo === "carregando") {
      h = C.cabeca("Carregando…");
    } else if (S.modo === "entrar") {
      h = C.cabeca("Entrar no Atos Workspace", "Com o seu endereço @" + DOMINIO + " e a senha da sua Conta Atos.") + aviso() +
        '<form class="form" data-form="entrar" novalidate>' + erro() + campoEndereco() +
        C.campo("senha", "Senha", "password", 'autocomplete="current-password" maxlength="200" required', { esqueci: "Esqueci a senha" }) +
        C.botao("Entrar", S.ocupado) + "</form>" +
        C.pe('Sem o endereço @' + DOMINIO + '? <a class="we-link" href="' + CONTA_ATOS + '">Entrar com a Conta Atos</a>');
    } else if (S.modo === "etapa") {
      // A segunda etapa (entrar-comum.js): a conta tem a verificacao em duas etapas.
      h = C.etapaHtml(S.etapa);
    } else if (S.modo === "esqueci") {
      h = C.cabeca("Trocar a senha", "Digite o seu endereço @" + DOMINIO + ". O código vai para o e-mail cadastrado da sua Conta Atos, nunca para o endereço Atos.", true) +
        '<form class="form" data-form="esqueci" novalidate>' + erro() + campoEndereco() + C.botao("Enviar o código", S.ocupado) + "</form>" +
        C.pe(C.link("entrar", "Voltar"));
    } else if (S.modo === "redefinir") {
      h = C.cabeca("Trocar a senha", (S.para ? "Enviamos um código de 6 dígitos para o e-mail cadastrado da conta (<strong>" + esc(S.para) + "</strong>), não para " + esc(S.email) + "."
        : "Se <strong>" + esc(S.email) + "</strong> é o endereço de uma Conta Atos, enviamos um código de 6 dígitos para o e-mail cadastrado dela (não para o endereço @" + DOMINIO + ").") +
        " Ele vale 15 minutos.", true) +
        '<form class="form" data-form="redefinir">' + C.erro(S.erro) +
        C.campo("codigo", "Código", "text", C.COD, { classe: "codigo" }) +
        C.campo("senha", "Nova senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        C.campo("senha2", "Confirmar a nova senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        C.botao("Trocar a senha", S.ocupado) + "</form>" + C.pe(C.link("esqueci", "Voltar"));
    }
    tela.innerHTML = h;
    C.focar(tela, S.ocupado || (S.etapa && S.etapa.ocupado));
  }

  function depoisDaEtapa(d) {
    S.etapa.ocupado = false;
    if (d.ok) { entrou(); return; }
    if (d.recomecar) { S.etapa = null; ir("entrar"); S.erro = d.erro || ""; desenhar(); return; }
    S.etapa.erro = d.erro || "não deu certo: tente de novo"; desenhar();
  }

  function ir(modo) { S.modo = modo; S.erro = ""; S.soAlias = false; S.ocupado = false; desenhar(); }
  function entrou() { location.replace(VOLTA); }

  function enviar(form) {
    var f = new FormData(form);
    var v = function (k) { return String(f.get(k) || ""); };
    var modo = form.getAttribute("data-form");
    if (modo === "etapa") {
      S.etapa.ocupado = true; S.etapa.erro = ""; desenhar();
      C.etapaEnviar(S.etapa, form).then(depoisDaEtapa);
      return;
    }
    if (modo !== "redefinir") S.email = v("email").trim();
    S.erro = ""; S.soAlias = false;
    if (modo !== "redefinir") {
      // O mesmo que o Worker recusa: outro e-mail nem chega a ser tentado.
      if (!S.email) { S.erro = "digite o seu endereço @" + DOMINIO; desenhar(); return; }
      if (!ehAlias(S.email)) { S.soAlias = true; desenhar(); return; }
      if (modo === "entrar" && !v("senha")) { S.erro = "digite a senha"; desenhar(); return; }
    }
    if (modo === "redefinir" && C.senhasIguais(f)) { S.erro = C.senhasIguais(f); desenhar(); return; }
    var rota, corpo, depois;
    if (modo === "entrar") { rota = "/api/entrar"; corpo = { email: S.email, senha: v("senha"), workspace: true }; depois = entrou; }
    else if (modo === "esqueci") { rota = "/api/esqueci"; corpo = { email: S.email, workspace: true }; depois = function (d) { S.para = d.para || ""; ir("redefinir"); }; }
    else { rota = "/api/redefinir"; corpo = { email: S.email, codigo: v("codigo").trim(), senha: v("senha"), workspace: true }; depois = entrou; }
    S.ocupado = true; desenhar();
    C.api(rota, corpo).then(function (d) {
      S.ocupado = false;
      // A conta tem a verificacao em duas etapas: a sessao so abre depois dela.
      if (d.etapa) { S.etapa = C.etapaNova(d.etapa); ir("etapa"); return; }
      if (d.ok) { depois(d); return; }
      if (d.codigo === "so_alias") S.soAlias = true;
      else S.erro = d.erro || "não deu certo: tente de novo";
      desenhar();
    });
  }

  tela.addEventListener("submit", function (e) { e.preventDefault(); if (!S.ocupado && !(S.etapa && S.etapa.ocupado)) enviar(e.target); });
  tela.addEventListener("click", function (e) {
    var b = e.target.closest("[data-acao]");
    if (!b || S.ocupado || (S.etapa && S.etapa.ocupado)) return;
    var a = b.getAttribute("data-acao");
    if (a === "etapa-chave") { S.etapa.ocupado = true; S.etapa.erro = ""; desenhar(); C.etapaChave().then(depoisDaEtapa); return; }
    if (a === "etapa-recuperacao" || a === "etapa-codigo") { S.etapa.modo = a === "etapa-recuperacao" ? "recuperacao" : "codigo"; S.etapa.erro = ""; desenhar(); return; }
    if (a === "etapa-sair") { S.etapa = null; ir("entrar"); return; }
    // O endereco digitado vai junto para a outra tela.
    var campo = tela.querySelector("input[name=email]");
    if (campo) S.email = campo.value.trim();
    ir(a);
  });

  C.api("/api/eu").then(function (d) {
    S.conta = d.conta || null;
    if (S.conta && S.conta.via === "alias" && params.get("modo") !== "entrar") { entrou(); return; }
    var dica = (params.get("login_hint") || "").trim().slice(0, 200);
    if (dica && ehAlias(dica)) S.email = dica;
    else if (S.conta && S.conta.alias) S.email = S.conta.alias;
    ir(params.get("modo") === "esqueci" ? "esqueci" : "entrar");
  });
})();
