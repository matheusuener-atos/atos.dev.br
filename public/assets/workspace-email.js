/* Atos Workspace > E-mail Atos (/workspace/email): um endereco <alias>@atos.dev.br que encaminha para o e-mail da
   pessoa. O servidor e worker/email-atos.js.

     GET  /api/workspace/email                    o estado (alias, destino, passos, limites, disponivel, workspace)
     GET  /api/workspace/email/disponivel?alias=  o nome vale e esta livre?
     POST /api/workspace/email/alias              {alias}
     POST /api/workspace/email/destino            {destino}
     POST /api/workspace/email/codigo             {codigo}
     POST /api/workspace/email/conferir           a Cloudflare ja verificou?
     POST /api/workspace/email/reenviar           {qual: "codigo"|"cloudflare"}
     POST /api/workspace/email/ligar | /desligar
     POST /api/workspace/email/remover            {confirmar: true}

   A workspace.js desenha o titulo e as guias e chama WorkspaceEmail.montar(raiz) a cada desenho; o estado fica aqui.
   Os atributos sao data-em*. Sem estilo inline (a CSP da conta): so classes de conta.css e workspace.css. */
(function () {
  "use strict";
  var S = { raiz: null, dados: null, erro: "", carregando: false, ocupado: false, msg: "", livre: null, alias: "", destino: "", codigo: "",
    trocar: false, remover: false, codigoTeste: "" };
  // "Entrar de novo" (o login recente): pelo endereco Atos, a tela do Workspace; pelo e-mail pessoal, o /entrar.
  var VOLTA_ENTRAR = "/entrar/?modo=entrar&volta=" + encodeURIComponent("/workspace/email");
  var VOLTA_ENTRAR_WS = "/workspace/entrar/?modo=entrar&volta=" + encodeURIComponent("/workspace/email");
  function entrarDeNovo(D) { return D && D.entrou_pelo_alias ? VOLTA_ENTRAR_WS : VOLTA_ENTRAR; }

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
  function quando(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function h2(t) { return '<h2 class="titulo-secao">' + t + "</h2>"; }

  function oQueE(D) {
    var L = D.limites;
    return h2("Como funciona") + '<div class="card ws-texto">' +
      "<p>O e-mail Atos é um endereço <strong>@" + esc(D.dominio) + "</strong> que <strong>encaminha</strong> o que chega para um e-mail seu (Gmail, Outlook, o do seu domínio). " +
      "Serve para dar um endereço da Atos aos seus sistemas e contatos sem mostrar o seu.</p>" +
      "<p>Ele também <strong>entra na sua Conta Atos</strong>, com a mesma senha (é a mesma conta). “Esqueci a senha” pelo endereço manda o código para o e-mail cadastrado da conta, nunca para ele. " +
      "E é o que o Workspace pede para <strong>cadastrar sistemas</strong>: com o destino confirmado e o login feito por ele, as Integrações abrem, e quem entra nos seus sistemas vê esse endereço como quem cadastrou, nunca o seu e-mail pessoal.</p>" +
      "<p><strong>Não é uma caixa de entrada.</strong> A Atos não guarda as mensagens: elas passam direto para o seu e-mail. " +
      "Não dá para enviar nem responder como " + esc((D.alias && D.alias.endereco) || "o endereço da Atos") + ": a resposta sai do seu e-mail, com o seu endereço.</p>" +
      "<p>O encaminhamento começa <strong>desligado</strong>. Enquanto estiver desligado (ou se o Atos Workspace for desativado), as mensagens são <strong>recusadas na entrega</strong>: " +
      "quem mandou recebe o aviso de falha do próprio provedor, sem resposta da Atos e sem saber para onde iria.</p>" +
      "<p>Limites: mensagens de até " + esc(L.tamanho_mb) + " MB; " + esc(L.por_hora) + " encaminhadas por hora e " + esc(L.por_dia) + " por dia; " +
      esc(L.por_remetente_hora) + " por hora do mesmo remetente. Acima disso, recusadas. A entrega depende da Cloudflare e do seu provedor: a Atos não garante que toda mensagem chegue " +
      "(um provedor pode recusar ou mandar para o spam). A Atos guarda, por 30 dias, só o registro de cada entrega (quando, o resultado e o domínio de quem mandou), nunca o conteúdo. " +
      '<a href="/termos/#email-atos">Termos do e-mail Atos</a>.</p></div>';
  }

  function blocoEscolher(D) {
    var h = h2("Escolher o endereço") + '<div class="card ws-ativar">';
    if (!D.recente) return h + '<p class="ws-aviso">Para escolher o endereço, o login precisa ser das últimas ' + D.limites.recente_h + ' horas. <a href="' + entrarDeNovo(D) + '">Entrar de novo</a></p></div>';
    h += '<form data-em-form="alias" class="we-form"><label class="campo"><span class="rotulo">Endereço</span>' +
      '<span class="we-alias"><input data-em-in="alias" value="' + esc(S.alias) + '" maxlength="30" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="seunome" aria-describedby="we-alias-dica">' +
      '<span class="we-dominio">@' + esc(D.dominio) + "</span></span></label>" +
      '<p class="dica" id="we-alias-dica">De 3 a 30 caracteres: letras minúsculas sem acento, números, ponto e hífen. Nomes da Atos, dos produtos dela e de serviços (contato, suporte, admin, postmaster…) são reservados.</p>' +
      (S.livre ? '<p class="' + (S.livre.ok ? "ok" : "erro") + '" role="status">' + esc(S.livre.ok ? S.livre.alias + "@" + D.dominio + " está disponível." : S.livre.erro) + "</p>" : "") +
      '<p class="erro" role="alert">' + esc(S.erro) + "</p>" +
      '<div class="ws-botoes"><button type="button" class="btn p" data-em="verificar"' + (S.ocupado ? " disabled" : "") + ">Ver se está livre</button>" +
      '<button type="submit" class="btn p primario"' + (S.ocupado ? " disabled" : "") + ">" + (S.ocupado ? "Um momento…" : "Reservar o endereço") + "</button></div>" +
      '<p class="dica">Um endereço por conta. Se você remover o seu, ele fica 30 dias sem poder ser de outra pessoa.</p></form></div>';
    return h;
  }

  function estado(A) {
    if (A.suspenso) return '<span class="selo perigo">Suspenso pela Atos</span>';
    return A.estado === "ligado" ? '<span class="selo">Encaminhando</span>' : '<span class="selo neutro">Desligado: recusa as mensagens</span>';
  }

  function passos(D, A) {
    var d = A.destino;
    if (!d || S.trocar) {
      return h2(d ? "Trocar o destino" : "Para onde encaminhar") + '<div class="card ws-ativar"><form data-em-form="destino" class="we-form">' +
        '<label class="campo"><span class="rotulo">O seu e-mail</span><input type="email" data-em-in="destino" value="' + esc(S.destino) + '" maxlength="90" autocomplete="email" placeholder="voce@gmail.com"></label>' +
        "<p class=\"dica\">A Atos manda um código de 6 números para esse endereço, e a Cloudflare (o serviço que entrega as mensagens da Atos) manda um e-mail pedindo para verificá-lo. " +
        "As duas confirmações são necessárias para ligar. " + (d ? "Trocar desliga o encaminhamento até o destino novo ser confirmado." : "") + "</p>" +
        '<p class="erro" role="alert">' + esc(S.erro) + "</p>" +
        '<div class="ws-botoes"><button type="submit" class="btn p primario"' + (S.ocupado ? " disabled" : "") + ">" + (S.ocupado ? "Um momento…" : "Mandar o código") + "</button>" +
        (d ? '<button type="button" class="btn p" data-em="trocar-nao">Voltar</button>' : "") + "</div></form></div>";
    }
    var h = h2("Confirmar o destino") + '<div class="card we-passos">';
    h += '<div class="we-passo"><span class="we-num' + (d.codigo_ok ? " feito" : "") + '" aria-hidden="true">' + (d.codigo_ok ? "✓" : "1") + "</span><div>" +
      "<strong>O código da Atos</strong>";
    if (d.codigo_ok) h += '<p class="nota">Confirmado em ' + esc(quando(d.codigo_ok)) + ".</p>";
    else {
      h += '<p class="nota">Mandamos um código de 6 números para ' + esc(d.email) + " (vale " + esc(D.limites.codigo_min) + " minutos). Procure também no spam.</p>" +
        (S.codigoTeste ? '<p class="ws-aviso">Worker de teste: nenhum e-mail sai. O código é ' + esc(S.codigoTeste) + ".</p>" : "") +
        '<form data-em-form="codigo" class="we-linha"><label class="campo codigo"><span class="rotulo">Código</span><input data-em-in="codigo" inputmode="numeric" maxlength="6" autocomplete="one-time-code" value="' + esc(S.codigo) + '"></label>' +
        '<button type="submit" class="btn p primario"' + (S.ocupado ? " disabled" : "") + ">Confirmar</button>" +
        '<button type="button" class="btn p" data-em="reenviar-codigo"' + (S.ocupado ? " disabled" : "") + ">Mandar o código de novo</button></form>";
    }
    h += "</div></div>";
    h += '<div class="we-passo"><span class="we-num' + (d.cf_ok ? " feito" : "") + '" aria-hidden="true">' + (d.cf_ok ? "✓" : "2") + "</span><div>" +
      "<strong>A verificação da Cloudflare</strong>";
    if (d.cf_ok) h += '<p class="nota">Verificado' + (d.cf_ok ? " (a Atos viu em " + esc(quando(d.cf_ok)) + ")" : "") + ".</p>";
    else {
      h += '<p class="nota">' + (D.simulada ? "Worker de teste: a Cloudflare é simulada; “Já verifiquei, conferir” marca como verificado." :
        "A Cloudflare mandou para " + esc(d.email) + " um e-mail em inglês com o botão <strong>Verify email address</strong>. Clique nele e volte aqui." +
        (d.na_cf ? "" : " (A Atos ainda não conseguiu falar com a Cloudflare: “Conferir” tenta de novo.)")) + "</p>" +
        '<div class="ws-botoes"><button type="button" class="btn p" data-em="conferir"' + (S.ocupado ? " disabled" : "") + ">Já verifiquei, conferir</button>" +
        (D.simulada ? "" : '<button type="button" class="btn p" data-em="reenviar-cf"' + (S.ocupado ? " disabled" : "") + ">Mandar o e-mail da Cloudflare de novo</button>") + "</div>";
    }
    h += "</div></div>";
    h += '<div class="we-passo"><span class="we-num' + (A.estado === "ligado" ? " feito" : "") + '" aria-hidden="true">' + (A.estado === "ligado" ? "✓" : "3") + "</span><div>" +
      "<strong>Ligar o encaminhamento</strong>" +
      '<p class="nota">' + (A.estado === "ligado" ? "Ligado: o que chega a " + esc(A.endereco) + " vai para " + esc(d.email) + "." :
        d.codigo_ok && d.cf_ok ? "Pronto para ligar." : "Depois das duas confirmações acima.") + "</p>" +
      '<div class="ws-botoes">' + (A.estado === "ligado"
        ? '<button type="button" class="btn p" data-em="desligar"' + (S.ocupado ? " disabled" : "") + ">Desligar</button>"
        : '<button type="button" class="btn p primario" data-em="ligar"' + (S.ocupado || !d.codigo_ok || !d.cf_ok || A.suspenso ? " disabled" : "") + ">Ligar</button>") +
      "</div></div></div>";
    h += '<p class="erro we-erro" role="alert">' + esc(S.erro) + "</p></div>";
    return h;
  }

  function blocoAlias(D) {
    var A = D.alias;
    var h = "";
    if (S.msg) h += '<p class="ok ws-ok" role="status">' + esc(S.msg) + "</p>";
    if (A.suspenso) {
      h += '<p class="ws-aviso">A Atos suspendeu este endereço em ' + esc(quando(A.suspenso.quando)) + (A.suspenso.motivo ? " (" + esc(A.suspenso.motivo) + ")" : "") +
        ". As mensagens são recusadas. Para entender ou contestar, escreva para contato@atos.dev.br.</p>";
    }
    h += h2("O seu endereço") + '<div class="card">' +
      '<div class="dado"><span class="rotulo">Endereço</span><span><strong>' + esc(A.endereco) + "</strong></span>" + estado(A) + "</div>" +
      '<div class="dado"><span class="rotulo">Destino</span><span>' + (A.destino ? esc(A.destino.email) + (A.destino.codigo_ok && A.destino.cf_ok ? "" : " (falta confirmar)") : "—") + "</span>" +
      (A.destino && !S.trocar && !A.suspenso ? '<button type="button" class="btn p" data-em="trocar">Trocar</button>' : "<span></span>") + "</div>" +
      '<div class="dado"><span class="rotulo">Desde</span><span>' + esc(quando(A.criado)) + "</span><span></span></div></div>";
    // Confirmado, mas a sessao veio do e-mail pessoal: as Integracoes pedem o login pelo endereco (workspace.js, "entrar-alias").
    if (!A.suspenso && A.destino && A.destino.codigo_ok && A.destino.cf_ok && !D.entrou_pelo_alias) {
      h += '<div class="card ws-ativar"><p>Destino confirmado. Para cadastrar sistemas nas Integrações, entre com <strong>' + esc(A.endereco) + "</strong> (a mesma senha da conta).</p>" +
        '<div class="ws-botoes"><button type="button" class="btn p primario" data-ws="entrar-alias" data-alias="' + esc(A.endereco) + '">Entrar com ' + esc(A.endereco) + "</button></div></div>";
    }
    if (!D.recente) h += '<p class="ws-aviso">Para mudar o e-mail Atos, o login precisa ser das últimas ' + D.limites.recente_h + ' horas. <a href="' + entrarDeNovo(D) + '">Entrar de novo</a></p>';
    if (!A.suspenso) h += passos(D, A);
    if (A.historico && A.historico.length) {
      h += h2("Registro") + '<div class="card ws-texto">' + A.historico.map(function (x) { return "<p>" + esc(quando(x.quando)) + " · " + esc(x.oque) + "</p>"; }).join("") + "</div>";
    }
    h += h2("Remover") + '<div class="card">';
    if (S.remover) {
      h += '<div class="confirmar" role="alertdialog" aria-label="Remover o endereço"><p>Remover ' + esc(A.endereco) + "? Ele para de receber na hora (as mensagens passam a ser recusadas) " +
        "e fica 30 dias sem poder ser de outra conta; nesse tempo, só você pode pegá-lo de volta.</p>" +
        '<p class="erro" role="alert">' + esc(S.erro) + "</p>" +
        '<div class="botoes"><button type="button" class="btn p perigo" data-em="remover-sim"' + (S.ocupado || !D.recente ? " disabled" : "") + ">" + (S.ocupado ? "Removendo…" : "Remover") + "</button>" +
        '<button type="button" class="btn p" data-em="remover-nao">Voltar</button></div></div>';
    } else {
      h += '<div class="excluir"><span>Tira o endereço da sua conta; as mensagens para ele passam a ser recusadas.</span><button type="button" class="btn p perigo" data-em="remover">Remover</button></div>';
    }
    return h + "</div>";
  }

  function tela() {
    var D = S.dados;
    if (!D) return S.erro ? '<div class="card"><p class="vazio">' + esc(S.erro) + ' <button type="button" class="link" data-em="recarregar">Tentar de novo</button></p></div>'
      : '<div class="card"><p class="vazio">Carregando…</p></div>';
    var h = "";
    if (!D.disponivel) {
      h += '<div class="card ws-ativar"><p class="ws-aviso">O e-mail Atos ainda está em preparação: a entrega das mensagens não está ligada na Atos. Por enquanto não dá para reservar um endereço.</p></div>';
      return h + oQueE(D);
    }
    if (!D.workspace) {
      h += '<div class="card ws-ativar"><p>O e-mail Atos faz parte do Atos Workspace. Ative o Workspace (gratuito) para usar.' +
        (D.alias ? " O seu endereço " + esc(D.alias.endereco) + " continua reservado, e as mensagens para ele são recusadas enquanto o Workspace estiver desativado." : "") + "</p>" +
        '<div class="ws-botoes"><a class="btn primario" href="/workspace/" data-ws-secao="geral">Ativar o Atos Workspace</a></div></div>';
      return h + oQueE(D);
    }
    if (!D.alias) return h + oQueE(D) + blocoEscolher(D);
    return h + blocoAlias(D) + oQueE(D);
  }

  function pintar() {
    if (!S.raiz || !document.body.contains(S.raiz)) return;
    var foco = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-em-in");
    S.raiz.innerHTML = tela();
    if (foco) { var el = S.raiz.querySelector('[data-em-in="' + foco + '"]'); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* email nao tem selecao */ } } }
  }
  function carregar() {
    S.carregando = true;
    return api("/api/workspace/email").then(function (d) {
      S.carregando = false;
      if (d._status === 401 && d.entrar) { location.replace("/workspace/entrar/?volta=" + encodeURIComponent("/workspace/email")); return; }
      if (d.erro || typeof d.disponivel !== "boolean") { S.dados = null; S.erro = d.erro || "não deu para carregar o e-mail Atos agora"; }
      else { S.dados = d; S.erro = ""; }
      pintar();
    });
  }
  function mudar(caminho, corpo, depois) {
    S.ocupado = true; S.erro = ""; S.msg = ""; pintar();
    return api(caminho, corpo).then(function (d) {
      S.ocupado = false;
      if (d._status === 401 && d.reentrar && S.dados) { S.dados.recente = false; pintar(); return; }
      if (d._status === 403 && d.workspace === false) { document.dispatchEvent(new CustomEvent("workspace-inativo")); carregar(); return; }
      if (d.erro || typeof d.disponivel !== "boolean") { S.erro = d.erro || "não deu agora: tente de novo"; pintar(); return; }
      S.dados = d;
      if (d.codigo_teste) S.codigoTeste = d.codigo_teste;
      if (depois) depois(d);
      pintar();
    });
  }

  document.addEventListener("submit", function (e) {
    var f = e.target.closest && e.target.closest("[data-em-form]");
    if (!f) return;
    e.preventDefault();
    if (S.ocupado) return;
    var qual = f.getAttribute("data-em-form");
    if (qual === "alias") mudar("/api/workspace/email/alias", { alias: S.alias }, function (d) { S.livre = null; S.msg = "Reservado: " + d.alias.endereco + ". Agora informe para onde encaminhar."; });
    else if (qual === "destino") {
      mudar("/api/workspace/email/destino", { destino: S.destino }, function (d) {
        S.trocar = false; S.codigo = "";
        S.msg = d.codigo_enviado ? "Mandamos o código para " + d.alias.destino.email + "." : (d.aviso || "");
        if (d.aviso_cf) S.msg += " " + d.aviso_cf;
      });
    } else if (qual === "codigo") mudar("/api/workspace/email/codigo", { codigo: S.codigo }, function () { S.codigo = ""; S.codigoTeste = ""; S.msg = "Código confirmado."; });
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-em]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-em");
    if (a === "recarregar") { S.erro = ""; pintar(); carregar(); }
    else if (a === "verificar") {
      var pedido = S.alias;
      S.ocupado = true; pintar();
      api("/api/workspace/email/disponivel?alias=" + encodeURIComponent(pedido)).then(function (d) {
        S.ocupado = false; S.erro = "";
        // A resposta de um nome que a pessoa ja trocou nao vale para o que esta no campo.
        if (pedido !== S.alias) { pintar(); return; }
        S.livre = d.erro && d.ok === undefined ? { ok: false, erro: d.erro } : { ok: Boolean(d.ok), alias: d.alias, erro: d.erro };
        pintar();
      });
    }
    else if (a === "trocar") { S.trocar = true; S.destino = ""; S.erro = ""; pintar(); }
    else if (a === "trocar-nao") { S.trocar = false; S.erro = ""; pintar(); }
    else if (a === "reenviar-codigo") mudar("/api/workspace/email/reenviar", { qual: "codigo" }, function () { S.msg = "Mandamos um código novo."; });
    else if (a === "reenviar-cf") mudar("/api/workspace/email/reenviar", { qual: "cloudflare" }, function () { S.msg = "Pedimos à Cloudflare um e-mail de verificação novo."; });
    else if (a === "conferir") mudar("/api/workspace/email/conferir", {}, function (d) { S.msg = d.alias && d.alias.destino && d.alias.destino.cf_ok ? "A Cloudflare confirmou o destino." : "A Cloudflare ainda não mostra o destino como verificado."; });
    else if (a === "ligar") mudar("/api/workspace/email/ligar", {}, function () { S.msg = "Ligado: as mensagens passam a ser encaminhadas."; });
    else if (a === "desligar") mudar("/api/workspace/email/desligar", {}, function () { S.msg = "Desligado: as mensagens passam a ser recusadas."; });
    else if (a === "remover") { S.remover = true; S.erro = ""; pintar(); }
    else if (a === "remover-nao") { S.remover = false; S.erro = ""; pintar(); }
    else if (a === "remover-sim") mudar("/api/workspace/email/remover", { confirmar: true }, function () { S.remover = false; S.trocar = false; S.msg = ""; });
  });
  document.addEventListener("input", function (e) {
    var el = e.target;
    var k = el && el.getAttribute && el.getAttribute("data-em-in");
    if (!k) return;
    if (k === "alias") { S.alias = el.value.trim().toLowerCase(); S.livre = null; }
    else if (k === "destino") S.destino = el.value.trim();
    else if (k === "codigo") S.codigo = el.value.replace(/\D/g, "").slice(0, 6);
  });

  window.WorkspaceEmail = {
    montar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.dados && !S.carregando) carregar();
    },
    recarregar: carregar,
  };
})();
