/* A guia Segurança da Minha conta (/conta/seguranca): a verificação em duas etapas (o aplicativo autenticador e os
   códigos de recuperação), as chaves de acesso, as sessões abertas e a atividade recente. O servidor é o
   worker/seguranca.js (GET /api/seguranca e as mudanças em /api/seguranca/*); ele confere tudo de novo (o login da
   última hora, a sessão que passou pela segunda etapa, o código para desligar). Aqui só se desenha e se pergunta.

   conta.js chama window.AtosSeguranca(ctx) uma vez: {html(), carregar(), clique(el), enviar(form)}. Os botões usam
   data-seg="<ação>" e os formulários data-form="seg-<nome>". Sem estilo inline (a CSP da conta). */
(function () {
  "use strict";
  var COMO = { senha: "Senha", alias: "Endereço Atos e senha", google: "Google", cadastro: "Cadastro (código do e-mail)", redefinir: "Troca de senha (código do e-mail)", chave: "Chave de acesso" };
  var SEGUNDA = { otp: "código do aplicativo", recuperacao: "código de recuperação", chave: "chave de acesso" };
  var EVENTO = {
    "totp-ligada": "Verificação em duas etapas ligada (aplicativo autenticador)", "totp-desligada": "Aplicativo autenticador desligado",
    "chave-cadastrada": "Chave de acesso cadastrada", "chave-removida": "Chave de acesso removida", "codigos-gerados": "Novos códigos de recuperação gerados",
    "senha-trocada": "Senha trocada", "sair-outras": "Saiu de todas as outras sessões", "chave-contador": "Uma chave de acesso mostrou um contador fora de ordem (pode ser uma cópia dela)",
  };

  window.AtosSeguranca = function (ctx) {
    var api = ctx.api, esc = ctx.esc;
    var E = { d: null, erro: "", ok: "", ocupado: false, fluxo: "", totp: null, codigos: null, alvo: "", carregando: false };

    function quando(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      return isNaN(d) ? "" : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
    }
    function como(x) {
      var t = COMO[x.como] || "Entrada";
      return x.segunda ? t + " + " + (SEGUNDA[x.segunda] || x.segunda) : t;
    }
    function onde(x) { return [x.navegador, x.onde].filter(Boolean).join(" · ") || "Lugar e navegador não anotados"; }
    function dis() { return E.ocupado ? " disabled" : ""; }
    function btn(acao, texto, classe, extra) { return '<button type="button" class="btn p' + (classe ? " " + classe : "") + '" data-seg="' + acao + '"' + (extra || "") + dis() + ">" + texto + "</button>"; }
    function avisos() { return '<p class="erro" role="alert">' + esc(E.erro) + '</p><p class="ok" role="status">' + esc(E.ok) + "</p>"; }

    /* O que impede mudar agora: o login antigo, ou a sessão sem a segunda etapa (com ela ligada). */
    function bloqueio() {
      var d = E.d;
      if (!d.recente) return "Para mudar a segurança da conta, entre de novo: o login precisa ser da última hora.";
      if (d.ativa && !d.mfa) return "Esta sessão não passou pela verificação em duas etapas. Para mudar a segurança, entre de novo.";
      return "";
    }
    function entrarDeNovo() {
      return '<div class="card seg-aviso"><span>' + esc(bloqueio()) + '</span><a class="btn p primario" href="/entrar/?modo=entrar&amp;volta=' + encodeURIComponent("/conta/seguranca") + '">Entrar de novo</a></div>';
    }

    function blocoTotp() {
      var d = E.d, h = "";
      if (E.fluxo === "totp" && E.totp) {
        return '<div class="seg-fluxo">' +
          "<p>1. Abra o aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password, Authy ou outro) e leia o QR code.</p>" +
          '<div class="seg-qr">' + E.totp.qr + "</div>" +
          '<p class="nota">Não dá para ler? Digite esta chave no aplicativo (conta “Atos”, tipo “baseado em tempo”):</p>' +
          '<p class="seg-chave" aria-label="Chave para digitar">' + esc(E.totp.chave) + "</p>" +
          '<form class="seg-form" data-form="seg-ligar"><label class="campo codigo"><span class="rotulo">2. Digite o código de 6 dígitos que aparece</span>' +
          '<input name="codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" required></label>' +
          '<div class="botoes sem-borda"><button type="submit" class="btn p primario"' + dis() + ">Confirmar e ligar</button>" + btn("cancelar", "Cancelar") + "</div></form></div>";
      }
      if (E.fluxo === "desligar") {
        return '<form class="seg-fluxo seg-form" data-form="seg-desligar"><p>Para desligar o aplicativo autenticador, confirme com um código dele ou com um código de recuperação.' +
          (d.chaves.length ? " As chaves de acesso continuam valendo como segunda etapa." : " Sem chave de acesso, a conta volta a entrar só com a senha.") + "</p>" +
          '<label class="campo"><span class="rotulo">Código do aplicativo ou de recuperação</span><input name="codigo" autocomplete="one-time-code" maxlength="20" required></label>' +
          '<div class="botoes sem-borda"><button type="submit" class="btn p perigo"' + dis() + ">Desligar</button>" + btn("cancelar", "Cancelar") + "</div></form>";
      }
      if (d.totp) h += '<div class="item"><span class="nome"><strong>Aplicativo autenticador</strong><small>Ligado desde ' + esc(quando(d.totp.desde)) + "</small></span>" +
        '<span class="selo">Ligado</span>' + (bloqueio() ? "" : btn("desligar", "Desligar")) + "</div>";
      else h += '<div class="item"><span class="nome"><strong>Aplicativo autenticador</strong><small>' +
        (d.disponivel.totp ? "Um código de 6 dígitos que muda a cada 30 segundos, no seu celular." : "Ainda não está disponível na Atos.") + "</small></span>" +
        (d.disponivel.totp && !bloqueio() ? btn("ligar", "Ligar", "primario") : '<span class="selo neutro">Desligado</span>') + "</div>";
      return h;
    }

    function blocoCodigos() {
      var d = E.d;
      if (E.fluxo === "codigos" && E.codigos) {
        return '<div class="seg-fluxo"><p><strong>Guarde estes códigos de recuperação.</strong> Cada um vale uma vez, para entrar quando você não tiver o aplicativo nem a chave. ' +
          "Esta é a única vez que eles aparecem: guarde num gerenciador de senhas ou imprima.</p>" +
          '<ul class="seg-codigos">' + E.codigos.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>" +
          '<div class="botoes sem-borda">' + btn("copiar", "Copiar os códigos") + btn("guardei", "Pronto, guardei", "primario") + "</div></div>";
      }
      if (E.fluxo === "gerar") {
        return '<div class="seg-fluxo"><p>Gerar códigos novos? Os 10 de agora deixam de valer na hora.</p><div class="botoes sem-borda">' +
          btn("gerar-sim", "Gerar códigos novos", "primario") + btn("cancelar", "Cancelar") + "</div></div>";
      }
      if (!d.recuperacao) return '<div class="item"><span class="nome"><strong>Códigos de recuperação</strong><small>Aparecem quando você liga a verificação em duas etapas.</small></span></div>';
      return '<div class="item"><span class="nome"><strong>Códigos de recuperação</strong><small>' + d.recuperacao.restantes + " de 10 restantes · gerados em " + esc(quando(d.recuperacao.gerados)) +
        "</small></span>" + (bloqueio() ? "" : btn("gerar", "Gerar novos")) + "</div>";
    }

    function blocoChaves() {
      var d = E.d, h = "";
      d.chaves.forEach(function (c) {
        var partes = ["Criada em " + quando(c.criada), c.ultimo_uso ? "último uso em " + quando(c.ultimo_uso) : "ainda não usada",
          c.sincronizada ? "sincronizada na nuvem do aparelho" : "presa a este aparelho ou chave"];
        if (!c.aqui) partes.push("cadastrada em outro endereço da Atos");
        var alerta = c.alerta ? '<small class="seg-alerta">Em ' + esc(quando(c.alerta.quando)) + " esta chave mostrou um contador fora de ordem: pode ser uma cópia dela. Se não reconhece, remova.</small>" : "";
        if (E.fluxo === "remover" && E.alvo === c.id) {
          h += '<div class="seg-fluxo"><p>Remover a chave “' + esc(c.nome) + "”?" + (d.chaves.length === 1 && !d.totp ? " É a última segunda etapa: a conta volta a entrar só com a senha." : "") + "</p>" +
            '<div class="botoes sem-borda">' + btn("remover-sim", "Remover", "perigo") + btn("cancelar", "Cancelar") + "</div></div>";
          return;
        }
        h += '<div class="item"><span class="nome"><strong>' + esc(c.nome) + "</strong><small>" + esc(partes.join(" · ")) + "</small>" + alerta + "</span>" +
          (bloqueio() ? "" : btn("remover", "Remover", "", ' data-id="' + esc(c.id) + '"')) + "</div>";
      });
      if (!d.chaves.length) h += '<div class="item"><span class="nome"><strong>Nenhuma chave de acesso</strong><small>Com uma chave de acesso (Windows Hello, a digital ou o rosto no celular, uma chave física) você entra sem a senha, e ela também confirma a segunda etapa.</small></span></div>';
      if (!d.disponivel.chaves) h += '<p class="vazio">As chaves de acesso não funcionam neste endereço.</p>';
      else if (!window.AtosChave || !window.AtosChave.disponivel()) h += '<p class="vazio">Este navegador não oferece chaves de acesso.</p>';
      else if (!bloqueio()) {
        h += '<form class="seg-nova" data-form="seg-chave"><label class="campo"><span class="rotulo">Nome da chave nova</span>' +
          '<input name="nome" maxlength="60" placeholder="Ex.: Notebook, Celular" required></label><button type="submit" class="btn p primario"' + dis() + ">Cadastrar chave de acesso</button></form>";
      }
      return h;
    }

    function blocoSessoes() {
      var d = E.d;
      var h = d.sessoes.map(function (x) {
        if (E.fluxo === "sair" && E.alvo === x.id) {
          return '<div class="seg-fluxo"><p>Sair da sessão em ' + esc(onde(x)) + "?</p><div class=\"botoes sem-borda\">" + btn("sair-sim", "Sair desta", "perigo") + btn("cancelar", "Cancelar") + "</div></div>";
        }
        return '<div class="item"><span class="nome"><strong>' + esc(onde(x)) + "</strong><small>" + esc(["Aberta em " + quando(x.criada), x.como ? como(x) : ""].filter(Boolean).join(" · ")) + "</small></span>" +
          (x.atual ? '<span class="selo">Esta sessão</span>' : btn("sair", "Sair desta", "", ' data-id="' + esc(x.id) + '"')) + "</div>";
      }).join("");
      if (d.sessoes.length > 1) {
        h += E.fluxo === "sair-outras"
          ? '<div class="seg-fluxo"><p>Sair de todas as outras sessões? Esta continua aberta.</p><div class="botoes sem-borda">' + btn("sair-outras-sim", "Sair de todas as outras", "perigo") + btn("cancelar", "Cancelar") + "</div></div>"
          : '<div class="botoes">' + btn("sair-outras", "Sair de todas as outras") + "</div>";
      }
      return h;
    }

    function blocoAtividade() {
      var l = E.d.atividade;
      if (!l.length) return '<p class="vazio">Nada anotado ainda.</p>';
      return l.map(function (x) {
        var titulo = x.tipo === "mudanca" ? (EVENTO[x.evento] || x.evento) + (x.detalhe && x.evento !== "chave-contador" ? ": " + x.detalhe : x.detalhe ? " (" + x.detalhe + ")" : "") : "Entrada: " + como(x);
        return '<div class="item"><span class="nome"><strong>' + esc(titulo) + "</strong><small>" + esc(quando(x.quando) + " · " + onde(x)) + "</small></span></div>";
      }).join("");
    }

    function html() {
      if (!E.d) return E.erro ? ctx.vazio(esc(E.erro) + ' <button type="button" class="link" data-seg="recarregar">Tentar de novo</button>') : ctx.vazio("Carregando…");
      var d = E.d;
      var h = (bloqueio() && !E.fluxo ? entrarDeNovo() : "") +
        ctx.h2("Verificação em duas etapas") +
        '<div class="card"><div class="dado"><span class="rotulo">Situação</span><span>' +
        (d.ativa ? "Ligada: depois da senha, a Atos pede o código do aplicativo, um código de recuperação ou a chave de acesso." : "Desligada: basta a senha para entrar.") +
        "</span><span></span></div>" + blocoTotp() + blocoCodigos() + "</div>" + avisos() +
        ctx.h2("Chaves de acesso") + '<div class="card">' + blocoChaves() + "</div>" +
        ctx.h2("Sessões abertas") + '<div class="card">' + blocoSessoes() + "</div>" +
        ctx.h2("Atividade recente") + '<div class="card">' + blocoAtividade() + "</div>" +
        '<p class="nota">A atividade guarda os últimos 30 acessos e mudanças, por 90 dias. O lugar é aproximado (a Cloudflare o deduz do endereço de internet, que a Atos não guarda). ' +
        "Os avisos de cada mudança vão para o e-mail da conta, sem link: se não foi você, escreva para contato@atos.dev.br.</p>" +
        '<p class="nota">Perdeu o aplicativo, os códigos de recuperação e as chaves de acesso? Por segurança, a verificação não se desliga sozinha: escreva do e-mail da conta para contato@atos.dev.br, que a Atos confere quem é você antes de desligar.</p>';
      return h;
    }

    function carregar() {
      if (E.carregando) return;
      E.carregando = true;
      api("/api/seguranca").then(function (d) {
        E.carregando = false;
        if (d._status === 401 && d.entrar) { location.replace("/entrar/?volta=" + encodeURIComponent("/conta/seguranca")); return; }
        if (d.erro) { E.erro = d.erro; E.d = null; } else { E.d = d; }
        ctx.redesenhar();
      });
    }
    /* Uma mudança: ocupa, chama, mostra o erro ou segue. */
    function mudar(caminho, corpo, depois) {
      E.ocupado = true; E.erro = ""; E.ok = ""; ctx.redesenhar();
      return api(caminho, corpo).then(function (d) {
        E.ocupado = false;
        if (d.erro) {
          if (d._status === 401 && d.reentrar && E.d) { E.d.recente = false; E.fluxo = ""; }
          E.erro = d.erro; ctx.redesenhar(); return;
        }
        depois(d);
      });
    }
    function fim(texto, codigos) {
      E.ok = texto || ""; E.fluxo = codigos ? "codigos" : ""; E.codigos = codigos || null; E.totp = null; E.alvo = "";
      api("/api/seguranca").then(function (d) { if (!d.erro) E.d = d; ctx.redesenhar(); });
    }

    function clique(el) {
      var a = el.getAttribute("data-seg");
      if (E.ocupado && a !== "recarregar") return;
      E.erro = ""; E.ok = "";
      if (a === "recarregar") { E.erro = ""; carregar(); return; }
      if (a === "cancelar") { E.fluxo = ""; E.totp = null; E.alvo = ""; ctx.redesenhar(); return; }
      if (a === "ligar") {
        mudar("/api/seguranca/totp/iniciar", {}, function (d) { E.totp = d; E.fluxo = "totp"; ctx.redesenhar(); var i = document.querySelector('input[name="codigo"]'); if (i) i.focus(); });
        return;
      }
      if (a === "desligar") { E.fluxo = "desligar"; ctx.redesenhar(); return; }
      if (a === "gerar") { E.fluxo = "gerar"; ctx.redesenhar(); return; }
      if (a === "gerar-sim") { mudar("/api/seguranca/recuperacao/gerar", {}, function (d) { fim("Códigos novos gerados. Os de antes não valem mais.", d.codigos); }); return; }
      if (a === "guardei") { E.fluxo = ""; E.codigos = null; ctx.redesenhar(); return; }
      if (a === "copiar") {
        var texto = (E.codigos || []).join("\n");
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(function () { E.ok = "Códigos copiados."; ctx.redesenhar(); }, function () { E.erro = "Não deu para copiar: selecione os códigos e copie."; ctx.redesenhar(); });
        return;
      }
      if (a === "remover") { E.fluxo = "remover"; E.alvo = el.getAttribute("data-id") || ""; ctx.redesenhar(); return; }
      if (a === "remover-sim") { mudar("/api/seguranca/chaves/remover", { id: E.alvo }, function (d) { fim(d.ativa ? "Chave removida." : "Chave removida. A verificação em duas etapas está desligada."); }); return; }
      if (a === "sair") { E.fluxo = "sair"; E.alvo = el.getAttribute("data-id") || ""; ctx.redesenhar(); return; }
      if (a === "sair-sim") {
        mudar("/api/seguranca/sessoes/sair", { id: E.alvo }, function (d) { if (d.saiu_desta) { location.replace("/entrar/"); return; } fim("Pronto: aquela sessão foi encerrada."); });
        return;
      }
      if (a === "sair-outras") { E.fluxo = "sair-outras"; ctx.redesenhar(); return; }
      if (a === "sair-outras-sim") { mudar("/api/seguranca/sessoes/sair-outras", {}, function (d) { fim(d.encerradas === 1 ? "1 outra sessão encerrada." : "Todas as outras sessões foram encerradas."); }); }
    }

    function enviar(form) {
      var f = new FormData(form), nome = form.getAttribute("data-form");
      E.erro = ""; E.ok = "";
      if (nome === "seg-ligar") {
        mudar("/api/seguranca/totp/ligar", { codigo: String(f.get("codigo") || "").replace(/\s/g, "") }, function (d) { fim("A verificação em duas etapas está ligada.", d.codigos); });
      } else if (nome === "seg-desligar") {
        var c = String(f.get("codigo") || "").trim();
        var corpo = /^\d{6}$/.test(c.replace(/\s/g, "")) ? { codigo: c.replace(/\s/g, "") } : { recuperacao: c };
        mudar("/api/seguranca/totp/desligar", corpo, function (d) { fim(d.ativa ? "Aplicativo autenticador desligado. As chaves de acesso continuam como segunda etapa." : "Aplicativo autenticador desligado. A conta entra só com a senha."); });
      } else if (nome === "seg-chave") {
        var nomeChave = String(f.get("nome") || "").trim();
        E.ocupado = true; ctx.redesenhar();
        api("/api/seguranca/chaves/opcoes", {}).then(function (o) {
          if (!o.publicKey) { E.ocupado = false; if (o._status === 401 && o.reentrar) E.d.recente = false; E.erro = o.erro || "não deu para começar agora"; ctx.redesenhar(); return; }
          return window.AtosChave.criar(o.publicKey).then(function (cred) {
            E.ocupado = false;
            return mudar("/api/seguranca/chaves/registrar", { nome: nomeChave, credencial: cred }, function (d) { fim("Chave de acesso “" + d.chave.nome + "” cadastrada.", d.codigos); });
          }, function (e) { E.ocupado = false; E.erro = window.AtosChave.motivo(e); ctx.redesenhar(); });
        });
      }
    }

    return { html: html, carregar: carregar, clique: clique, enviar: enviar, carregado: function () { return Boolean(E.d); } };
  };
})();
