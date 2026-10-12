/* A pagina /entrar: entrar na conta Atos, criar a conta, trocar a senha e,
   quando um aplicativo pede ("Entrar com Atos", ?client_id=...), permitir que
   ele saiba quem e voce. O Worker confere tudo (worker/oidc.js e
   worker/contas.js); aqui so se desenha e se pergunta.

   Sem client_id na consulta, a pessoa entra e vai para /conta - ou para o ?volta=, quando e um caminho
   desta propria Atos (o checkout de um produto manda quem ainda nao entrou para ca e volta).

   O "Continuar como" (FedCM, worker/fedcm.js) abre esta pagina numa janela do navegador de dois jeitos:
     ?fedcm=entrar          o login_url: a pessoa entra e a janela fecha (IdentityProvider.close); com a sessao ja
                            aberta, liga o FedCM nela (/api/fedcm/ligar) e fecha.
     ?fedcm_pedido=<id>     o continue_on: a tela de permissao do aplicativo; permitindo, o codigo volta ao navegador
                            (IdentityProvider.resolve), que o entrega ao site. Cancelando, a janela fecha. */
(function () {
  "use strict";
  // O comum com a tela do Workspace (entrar-comum.js): o pedido, os pedacos do formulario, a volta.
  var C = window.AtosEntrar;
  var esc = C.esc, api = C.api;
  var consulta = location.search.replace(/^\?/, "");
  var params = new URLSearchParams(consulta);
  var OIDC = params.has("client_id");
  var FEDCM_LOGIN = !OIDC && params.get("fedcm") === "entrar";
  var FEDCM_PEDIDO = OIDC ? "" : String(params.get("fedcm_pedido") || "");
  var IDP = window.IdentityProvider;
  var tela = document.getElementById("tela");
  var S = { modo: "carregando", email: "", nome: "", erro: params.get("erro_google") || "", pedido: null, ocupado: false, google: false, aviso: "", etapa: null };
  // O cadastro esperando o codigo (so na memoria desta aba): o "Reenviar codigo" manda de novo.
  var pendente = null;
  // Aberto por um aplicativo ("Entrar com Atos"): o modo popup, so a marca no topo.
  if (OIDC || FEDCM_LOGIN || FEDCM_PEDIDO) document.body.classList.add("popup");
  // O pedido do aplicativo vai junto ao Google e volta (worker/google.js); o erro dele nao.
  params.delete("erro_google");
  // ?etapa=1: o Google confirmou, e a conta tem a verificacao em duas etapas (o cookie da etapa veio junto).
  var VOLTOU_DA_ETAPA = params.get("etapa") === "1";
  params.delete("etapa");
  // So caminho daqui ("/pavlvs/assinar/?preco=..."), nunca outro site: "//x" e "https:" nao passam.
  var VOLTA = C.volta(params);
  consulta = OIDC ? (function () { var q = new URLSearchParams(params); return q.toString(); })() : FEDCM_LOGIN ? "fedcm=entrar"
    : FEDCM_PEDIDO ? "fedcm_pedido=" + encodeURIComponent(FEDCM_PEDIDO) : VOLTA ? "volta=" + encodeURIComponent(VOLTA) : "";
  var G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  /* "Continuar com Google" (worker/google.js), dentro do cartao, depois do "ou": so com o Google ligado na Atos. */
  function comGoogle() {
    var chave = S.modo === "entrar" && C.temChave() ? '<button type="button" class="btn largo" data-acao="chave"' + DIS() + ">Entrar com chave de acesso</button>" : "";
    if (!S.google && !chave) return "";
    return '<div class="ou">ou</div>' + (S.google ? '<a class="btn largo" href="/oauth/google?consulta=' + encodeURIComponent(consulta) + '">' + G + "<span>Continuar com Google</span></a>" : "") + chave;
  }

  function nomeDoApp() { return S.pedido && S.pedido.app ? S.pedido.app.nome : ""; }

  function campo(nome, rotulo, tipo, extra, classe) {
    return C.campo(nome, rotulo, tipo, extra, {
      classe: classe,
      // o "Esqueci a senha" ao lado do rotulo da senha, so na tela de entrar
      esqueci: nome === "senha" && S.modo === "entrar" ? "Esqueci a senha" : "",
      // O endereco Atos (<alias>@atos.dev.br) entra na mesma conta, com a mesma senha (worker/contas.js).
      dica: nome === "email" && (S.modo === "entrar" || S.modo === "esqueci") ? "ou o seu endereço @atos.dev.br" : "",
    });
  }
  var ERRO = function () { return C.erro(S.erro); };
  function botao(texto) { return C.botao(texto, S.ocupado); }
  var DIS = function () { return S.ocupado ? " disabled" : ""; };
  var link = C.link, cabeca = C.cabeca, pe = C.pe;
  function maiuscula(t) { t = String(t || ""); return t.charAt(0).toUpperCase() + t.slice(1); }
  function linhaDoApp(a) {
    return '<div class="linha app">' + (a.icone ? '<img class="logo" src="' + esc(a.icone) + '" alt="" width="36" height="36">'
      : '<span class="logo inicial" aria-hidden="true">' + esc(String(a.nome || "?").trim().charAt(0).toUpperCase()) + "</span>") +
      '<span class="nome"><strong>' + esc(a.nome) + "</strong><small>" + esc(maiuscula(a.descricao)) + "</small></span></div>";
  }
  /* Um aplicativo cadastrado por alguem na Minha conta (nao pela Atos): diz quem cadastrou e que nao e da Atos. */
  function linhaDeTerceiro(a) {
    if (!a.terceiro) return "";
    // "linha app": a linha de baixo quebra em vez de cortar (conta.css).
    // Quem cadastrou: o e-mail Atos dele (nunca o e-mail pessoal); sem um, "uma Conta Atos".
    return '<div class="linha app terceiro"><span class="nome"><small>Cadastrado por ' + (a.cadastrado_por ? esc(a.cadastrado_por) : "uma Conta Atos") + ". Não é um aplicativo da Atos: a Atos só confirma quem é você.</small></span></div>";
  }
  var COD = C.COD;

  function desenhar() {
    var h = "";
    var app = nomeDoApp();
    var paraApp = app ? "Para continuar em " + esc(app) : "";
    if (S.modo === "carregando") {
      h = cabeca(app ? "Voltando para " + esc(app) + "…" : "Carregando…");
    } else if (S.modo === "fatal") {
      h = cabeca("Não foi possível continuar") +
        '<div class="form"><p class="erro" role="alert">' + esc(S.erro) + '</p><p class="nota">Volte ao aplicativo e tente de novo. Se continuar, escreva para contato@atos.dev.br.</p></div>';
    } else if (S.modo === "entrar") {
      h = cabeca(app ? "Entrar com a conta Atos" : "Entrar na conta Atos", paraApp) +
        '<form class="form" data-form="entrar">' + ERRO() +
        campo("email", "E-mail", "email", 'autocomplete="username" maxlength="200" placeholder="voce@empresa.com" required value="' + esc(S.email) + '"') +
        campo("senha", "Senha", "password", 'autocomplete="current-password" maxlength="200" required') +
        botao("Entrar") + comGoogle() + "</form>" +
        pe("Não tem conta? " + link("criar", "Criar conta", true));
    } else if (S.modo === "criar") {
      h = cabeca("Criar a conta Atos", paraApp) +
        '<form class="form" data-form="criar">' + ERRO() +
        campo("nome", "Nome", "text", 'autocomplete="name" maxlength="80" value="' + esc(S.nome) + '"') +
        campo("email", "E-mail", "email", 'autocomplete="email" maxlength="200" placeholder="voce@empresa.com" required value="' + esc(S.email) + '"') +
        campo("senha", "Senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        campo("senha2", "Confirmar a senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        botao("Criar conta") + comGoogle() + "</form>" +
        pe("Já tem conta? " + link("entrar", "Entrar", true));
    } else if (S.modo === "confirmar") {
      h = cabeca("Confirme o seu e-mail", "Enviamos um código de 6 dígitos para <strong>" + esc(S.email) + "</strong>. Ele vale 15 minutos.", true) +
        '<form class="form" data-form="confirmar">' + ERRO() + (S.aviso ? '<p class="ok">' + esc(S.aviso) + "</p>" : "") +
        campo("codigo", "Código", "text", COD, "codigo") + botao("Confirmar") + "</form>" +
        pe(link("criar", "Voltar") + (pendente ? " · " + link("reenviar", "Reenviar código") : ""));
    } else if (S.modo === "esqueci") {
      h = cabeca("Trocar a senha", "Mandamos um código para o e-mail cadastrado da conta, também quando você digita o endereço @atos.dev.br. Se você só entrava com o Google, assim você cria uma senha para a mesma conta.", true) +
        '<form class="form" data-form="esqueci">' + ERRO() +
        campo("email", "E-mail", "email", 'autocomplete="email" maxlength="200" placeholder="voce@empresa.com" required value="' + esc(S.email) + '"') +
        botao("Enviar o código") + "</form>" + pe(link("entrar", "Voltar"));
    } else if (S.modo === "redefinir") {
      // Pelo endereco Atos, o codigo foi ao e-mail cadastrado da conta (mascarado), nunca ao alias.
      h = cabeca("Trocar a senha", (S.para ? "Enviamos um código de 6 dígitos para o e-mail cadastrado da conta (<strong>" + esc(S.para) + "</strong>), não para " + esc(S.email) + "."
        : S.peloAlias ? "Se <strong>" + esc(S.email) + "</strong> é o endereço de uma Conta Atos, enviamos um código de 6 dígitos para o e-mail cadastrado dela (não para o endereço @atos.dev.br)."
        : "Se <strong>" + esc(S.email) + "</strong> tem conta, chegou lá um código de 6 dígitos.") + " Ele vale 15 minutos.", true) +
        '<form class="form" data-form="redefinir">' + ERRO() +
        campo("codigo", "Código", "text", COD, "codigo") +
        campo("senha", "Nova senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        campo("senha2", "Confirmar a nova senha", "password", 'autocomplete="new-password" maxlength="200" required') +
        botao("Trocar a senha") + "</form>" + pe(link("esqueci", "Voltar"));
    } else if (S.modo === "etapa") {
      // A segunda etapa (entrar-comum.js): o codigo do aplicativo, um codigo de recuperacao ou a chave de acesso.
      h = C.etapaHtml(S.etapa);
    } else if (S.modo === "negado") {
      // A Conta Atos nao esta entre as que podem entrar neste aplicativo: nada de consentimento nem codigo.
      var pn = S.pedido;
      h = cabeca("Sem acesso a este aplicativo") +
        '<div class="card">' + linhaDoApp(pn.app) + linhaDeTerceiro(pn.app) +
        '<div class="linha"><span class="nome"><strong>' + esc(pn.conta.nome || pn.conta.email) + "</strong>" + (pn.conta.nome ? "<small>" + esc(pn.conta.email) + "</small>" : "") + "</span></div></div>" +
        '<p class="erro" role="alert">Sua Conta Atos não tem acesso a este aplicativo. Peça a quem o administra.</p>' +
        '<p class="nota">Quem decide quem entra é quem administra o aplicativo. Se você tem outra Conta Atos com acesso, entre com ela.</p>' +
        (FEDCM_PEDIDO ? '<div class="dois"><span></span><button type="button" class="btn primario" data-acao="fedcm-fechar">Fechar</button></div>'
          : '<div class="dois">' + (pn.voltar ? '<button type="button" class="btn" data-acao="voltar-app">Voltar ao aplicativo</button>' : "<span></span>") +
        '<button type="button" class="btn primario" data-acao="trocar">Entrar com outra conta</button></div>');
    } else if (S.modo === "consentir") {
      var p = S.pedido;
      var nome = esc(p.app.nome);
      h = cabeca(nome + " quer entrar com a sua conta Atos", "Confira antes de permitir") +
        '<div class="card">' + linhaDoApp(p.app) + linhaDeTerceiro(p.app) +
        '<div class="linha"><span class="nome"><strong>' + esc(p.conta.nome || p.conta.email) + "</strong>" + (p.conta.nome ? "<small>" + esc(p.conta.email) + "</small>" : "") + "</span>" + (FEDCM_PEDIDO ? "" : link("trocar", "Trocar de conta")) + "</div>" +
        // No "Continuar como", o site que pediu (a origem que o navegador confirmou).
        (FEDCM_PEDIDO && p.origem ? '<div class="linha app"><span class="nome"><small>Pedido pelo site ' + esc(p.origem) + "</small></span></div>" : "") +
        '<div class="escopos"><span class="titulo-secao">' + nome + " poderá</span>" +
        p.escopos.map(function (e) { return '<div><span aria-hidden="true">✓</span><span>' + esc(e.texto) + "</span></div>"; }).join("") + "</div></div>" +
        '<p class="nota">' + nome + " não recebe a sua senha. Você pode tirar essa permissão quando quiser, em Minha conta. " +
        'Veja como o aplicativo trata os seus dados na <a href="' + esc(p.app.privacidade) + '" target="_blank" rel="noopener">política de privacidade</a> e nos ' +
        '<a href="' + esc(p.app.termos) + '" target="_blank" rel="noopener">termos de uso</a> dele.</p>' + ERRO() +
        '<div class="dois"><button type="button" class="btn" data-acao="negar"' + DIS() + ">Cancelar</button>" +
        '<button type="button" class="btn primario" data-acao="permitir"' + DIS() + ">Permitir</button></div>";
    }
    tela.innerHTML = h;
    C.focar(tela, S.ocupado || (S.etapa && S.etapa.ocupado));
  }

  /* A resposta da segunda etapa (ou do "Entrar com chave de acesso"). */
  function depoisDaEtapa(d) {
    if (S.etapa) S.etapa.ocupado = false;
    S.ocupado = false;
    if (d.ok) { depoisDeEntrar(); return; }
    if (d.recomecar) { S.etapa = null; ir("entrar", d.erro); return; }
    if (S.modo === "etapa") { S.etapa.erro = d.erro || "não deu certo: tente de novo"; desenhar(); return; }
    S.erro = d.erro || "não deu certo: tente de novo"; desenhar();
  }
  function comecarEtapa(metodos) { S.etapa = C.etapaNova(metodos); ir("etapa"); }

  function ir(modo, erro) { S.modo = modo; S.erro = erro || ""; S.aviso = ""; S.ocupado = false; desenhar(); }

  /* Ja dentro da conta: com aplicativo, segue o pedido; sem, vai para /conta. */
  function depoisDeEntrar() {
    if (FEDCM_PEDIDO) { continuarFedCM(); return; }
    if (FEDCM_LOGIN) { fecharFedCM(false); return; }
    if (!OIDC) { location.replace(VOLTA || "/conta/"); return; }
    pedir();
  }

  function pedir() {
    api("/api/pedido", { consulta: consulta }).then(function (d) {
      if (d.ir) { location.replace(d.ir); return; }
      if (d.erro) { ir("fatal", d.erro); return; }
      S.pedido = d;
      S.google = Boolean(d.google);
      // prompt=create (d.criar): o aplicativo pediu o cadastro; "Ja tem conta? Entrar" continua o mesmo pedido.
      if (d.entrar) { S.email = S.email || d.dica || (d.conta && d.conta.email) || ""; ir(d.criar ? "criar" : "entrar", S.erro); return; }
      if (d.negado) { ir("negado"); return; }
      if (d.permitido) { autorizar(true); return; }
      ir("consentir");
    });
  }

  /* O FedCM: a janela fecha (o navegador volta ao site). ligar: a sessao e de antes do FedCM, sem o cookie dele. */
  function fecharFedCM(ligar) {
    S.modo = "carregando"; desenhar();
    (ligar ? api("/api/fedcm/ligar", {}) : Promise.resolve({})).then(function () {
      if (IDP && typeof IDP.close === "function") { IDP.close(); return; }
      ir("fatal", "Você já entrou na Atos. Pode fechar esta janela e voltar ao site.");
    });
  }

  /* O FedCM: a permissao do aplicativo (o pedido que /fedcm/afirmar guardou). */
  function continuarFedCM() {
    api("/api/fedcm/continuar", { pedido: FEDCM_PEDIDO }).then(function (d) {
      if (d._status === 401) { ir("entrar"); return; }
      if (d._status === 403 && d.negado) { S.pedido = d.app ? d : { app: { nome: "o aplicativo", descricao: "" }, conta: { email: "", nome: "" } }; ir("negado"); return; }
      if (d.erro) { ir("fatal", d.erro); return; }
      S.pedido = d;
      ir("consentir");
    });
  }

  function autorizarFedCM(permitir) {
    S.ocupado = true; S.erro = ""; desenhar();
    api("/api/fedcm/continuar", { pedido: FEDCM_PEDIDO, permitir: permitir }).then(function (d) {
      if (d.token) {
        if (IDP && typeof IDP.resolve === "function") { IDP.resolve(d.token); return; }
        ir("fatal", "Este navegador não terminou o pedido. Volte ao site e use o botão Entrar com Atos.");
        return;
      }
      if (d.negado && !d.erro) { fecharFedCM(false); return; }
      if (d._status === 401) { ir("entrar", d.erro); return; }
      S.ocupado = false; S.erro = d.erro || "não deu certo: tente de novo"; desenhar();
    });
  }

  function autorizar(permitir) {
    if (FEDCM_PEDIDO) { autorizarFedCM(permitir); return; }
    S.ocupado = true; S.erro = "";
    if (permitir && S.modo !== "consentir") S.modo = "carregando";
    desenhar();
    api("/api/autorizar", { consulta: consulta, permitir: permitir }).then(function (d) {
      if (d.ir) { location.replace(d.ir); return; }
      if (d._status === 401) { ir("entrar", d.erro); return; }
      if (d._status === 403 && d.negado) { S.pedido.voltar = d.voltar; ir("negado"); return; }
      S.ocupado = false; S.erro = d.erro || "não deu certo: tente de novo"; desenhar();
    });
  }

  function enviar(form) {
    var f = new FormData(form);
    var v = function (k) { return String(f.get(k) || ""); };
    var modo = form.getAttribute("data-form");
    if (modo === "etapa") {
      S.etapa.ocupado = true; S.etapa.erro = ""; desenhar();
      C.etapaEnviar(S.etapa, form).then(depoisDaEtapa);
      return;
    }
    if (v("email")) S.email = v("email").trim();
    if (modo === "criar") S.nome = v("nome").trim();
    if ((modo === "criar" || modo === "redefinir") && C.senhasIguais(f)) { S.erro = C.senhasIguais(f); desenhar(); return; }
    var rota, corpo, depois;
    if (modo === "entrar") { rota = "/api/entrar"; corpo = { email: S.email, senha: v("senha") }; depois = depoisDeEntrar; }
    else if (modo === "criar") { rota = "/api/cadastrar"; corpo = { email: S.email, senha: v("senha"), nome: S.nome }; depois = function () { pendente = corpo; ir("confirmar"); }; }
    else if (modo === "confirmar") { rota = "/api/confirmar"; corpo = { email: S.email, codigo: v("codigo").trim() }; depois = depoisDeEntrar; }
    else if (modo === "esqueci") { rota = "/api/esqueci"; corpo = { email: S.email }; depois = function (d) { S.para = d.para || ""; S.peloAlias = Boolean(d.alias); ir("redefinir"); }; }
    else if (modo === "redefinir") { rota = "/api/redefinir"; corpo = { email: S.email, codigo: v("codigo").trim(), senha: v("senha") }; depois = depoisDeEntrar; }
    S.ocupado = true; S.erro = ""; desenhar();
    api(rota, corpo).then(function (d) {
      S.ocupado = false;
      // A conta tem a verificacao em duas etapas: a senha (ou o codigo do e-mail) certa, mas a sessao ainda nao abriu.
      if (d.etapa) { comecarEtapa(d.etapa); return; }
      if (d.ok) { depois(d); return; }
      S.erro = d.erro || "não deu certo: tente de novo"; desenhar();
    });
  }

  tela.addEventListener("submit", function (e) { e.preventDefault(); if (!S.ocupado && !(S.etapa && S.etapa.ocupado)) enviar(e.target); });
  tela.addEventListener("click", function (e) {
    var b = e.target.closest("[data-acao]");
    if (!b || S.ocupado || (S.etapa && S.etapa.ocupado)) return;
    var a = b.getAttribute("data-acao");
    if (a === "chave") { S.ocupado = true; S.erro = ""; desenhar(); C.entrarComChave().then(depoisDaEtapa); }
    else if (a === "etapa-chave") { S.etapa.ocupado = true; S.etapa.erro = ""; desenhar(); C.etapaChave().then(depoisDaEtapa); }
    else if (a === "etapa-recuperacao" || a === "etapa-codigo") { S.etapa.modo = a === "etapa-recuperacao" ? "recuperacao" : "codigo"; S.etapa.erro = ""; desenhar(); }
    else if (a === "etapa-sair") { S.etapa = null; ir("entrar"); }
    else if (a === "permitir") autorizar(true);
    else if (a === "negar") autorizar(false);
    else if (a === "trocar") api("/api/sair", {}).then(function () { S.email = ""; ir("entrar"); });
    else if (a === "fedcm-fechar") fecharFedCM(false);
    else if (a === "voltar-app") { if (S.pedido && S.pedido.voltar) location.replace(S.pedido.voltar); }
    else if (a === "reenviar") {
      if (!pendente) return;
      S.ocupado = true; S.erro = ""; S.aviso = ""; desenhar();
      api("/api/cadastrar", pendente).then(function (d) {
        S.ocupado = false;
        if (d.ok) S.aviso = "Mandamos um código novo. O anterior não vale mais."; else S.erro = d.erro || "não deu certo: tente de novo";
        desenhar();
      });
    }
    else ir(a);
  });

  function comecar() {
    if (OIDC) { pedir(); return; }
    if (FEDCM_PEDIDO) { continuarFedCM(); return; }
    carregarConta();
  }
  // A volta do Google com a etapa: primeiro "Confirme que e voce"; depois, o pedido do aplicativo (ou a conta).
  if (VOLTOU_DA_ETAPA) {
    C.etapaCarregar().then(function (d) {
      if (d.metodos) { S.google = false; comecarEtapa(d.metodos); return; }
      S.erro = d.erro || "a confirmação venceu: entre de novo";
      comecar();
    });
  } else comecar();

  function carregarConta() { api("/api/eu").then(function (d) {
    var modo = params.get("modo");
    S.google = Boolean(d.google);
    if (d.conta && !modo && !S.erro && FEDCM_LOGIN) { fecharFedCM(true); return; }
    if (d.conta && !modo && !S.erro) { location.replace(VOLTA || "/conta/"); return; }
    if (d.conta) S.email = d.conta.email;
    // ?login_hint=: o endereco ja preenchido (o Workspace usa a propria tela, /workspace/entrar, que tambem le o login_hint).
    var dica = (params.get("login_hint") || "").trim().slice(0, 200);
    if (dica) S.email = dica;
    ir(modo === "criar" || modo === "esqueci" ? modo : "entrar", S.erro);
  }); }
})();
