/* Atos Workspace > Integracoes (/workspace/integracoes): os sistemas que a pessoa cadastra no Entrar com Atos (o Login
   Atos). O servidor e worker/integracoes.js (so com o Workspace ativo: sem ele, 403 com workspace: false); o cartao
   "Como integrar" e o integrar.js (o mesmo do painel).

     GET  /api/integracoes                       os aplicativos da conta, os limites e o que precisa para integrar
     POST /api/integracoes/apps                  criar um aplicativo
     POST /api/integracoes/apps/:id              {acao: editar|acesso|liberar|tirar|apagar}
     POST /api/integracoes/apps/:id/acessos      criar um acesso
     POST /api/integracoes/acessos/:cid          {acao: editar|ligar|desligar|apagar|segredo}
     GET  /api/integracoes/apps/:id/avisos       os avisos ao sistema (webhooks) e as ultimas entregas
     POST /api/integracoes/apps/:id/avisos       {acao: salvar|ligar|desligar|segredo|testar|reenviar|apagar}
     GET  /api/integracoes/apps/:id/entradas     o registro de entradas (90 dias; ?dias=&resultado=&q=), e .csv para exportar

   A workspace.js desenha o titulo e as guias e chama WorkspaceIntegracoes.montar(raiz) a cada desenho; o estado fica
   aqui. Os atributos sao data-ic* (a workspace.js escuta data-ws*). */
(function () {
  "use strict";
  var S = { raiz: null, dados: null, erro: "", carregando: false, aberto: "", modal: null, aviso: "" };
  // Os avisos ao sistema: as entregas abertas por aplicativo, o segredo que acabou de sair (uma vez), o que espera confirmar.
  var AV = { entregas: {}, segredo: null, confirmar: null, erro: {}, ocupado: "" };
  // As entradas abertas por aplicativo: {dias, resultado, q, dados}.
  var EN = {};
  var ICONE_MAX = 30 * 1024;
  var ONDE = "atos.dev.br/workspace/integracoes";
  // As Integracoes pedem a sessao pelo endereco Atos: o "Entrar de novo" e a tela de entrar do Workspace.
  var VOLTA_ENTRAR = "/workspace/entrar/?modo=entrar&volta=" + encodeURIComponent("/workspace/integracoes");

  function esc(s) {
    // O erro de um limite do plano (codigo "limite_do_plano", worker/workspace-plano.js) traz a marca [Conhecer o Pro], que
    // vira o link para /workspace/plano.
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; })
      .replace("[Conhecer o Pro]", '<a href="/workspace/plano">Conhecer o Pro</a>');
  }
  function api(caminho, corpo) {
    var op = corpo === undefined ? { credentials: "same-origin" } :
      { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) };
    return fetch(caminho, op).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; if (d.codigo === "limite_do_plano" && d.erro) d.erro += " [Conhecer o Pro]"; return d; });
    }, function () { return { erro: "sem conexão com o servidor", _status: 0 }; });
  }
  function quando(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function icone(a) {
    if (a.icone) return '<img class="logo" src="' + esc(a.icone) + '" alt="" width="32" height="32">';
    return '<span class="logo inicial" aria-hidden="true">' + esc(String(a.nome || "?").trim().charAt(0).toUpperCase()) + "</span>";
  }
  function app(id) { return ((S.dados || {}).apps || []).filter(function (a) { return a.id === id; })[0] || null; }
  function acessoDe(cid) {
    var r = null;
    ((S.dados || {}).apps || []).forEach(function (a) { a.acessos.forEach(function (c) { if (c.id === cid) r = { app: a, c: c }; }); });
    return r;
  }
  function linhas(t) { return String(t || "").split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); }

  // ------------------------------------------------------------ carregar

  function carregar() {
    S.carregando = true;
    api("/api/integracoes").then(function (d) {
      S.carregando = false;
      if (d._status === 401) { location.replace("/workspace/entrar/?volta=" + encodeURIComponent("/workspace/integracoes")); return; }
      // O Workspace foi desativado (noutra aba): a workspace.js volta a mostrar a ativacao.
      // Ou o e-mail Atos deixou de cumprir o que as Integracoes pedem (codigo: sem_alias, alias_nao_confirmado, entrar_pelo_alias).
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; document.dispatchEvent(new CustomEvent("workspace-inativo")); return; }
      if (d.erro || !d.apps) { S.erro = d.erro || "não deu para carregar as integrações agora"; pintar(); return; }
      S.erro = ""; S.dados = d; pintar();
    });
  }
  /* Uma mudanca: o servidor devolve o aplicativo como ficou. */
  function mudar(caminho, corpo, depois) {
    return api(caminho, corpo).then(function (d) {
      if (d._status === 401 && d.reentrar) { S.dados.recente = false; S.aviso = ""; pintar(); return d; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; S.modal = null; pintarModal(); document.dispatchEvent(new CustomEvent("workspace-inativo")); return d; }
      if (d.erro) return d;
      if (d.app) S.dados.apps = S.dados.apps.map(function (a) { return a.id === d.app.id ? d.app : a; });
      if (d.apagado) S.dados.apps = S.dados.apps.filter(function (a) { return a.id !== d.apagado; });
      if (depois) depois(d);
      pintar();
      return d;
    });
  }

  // ------------------------------------------------------------ a tela

  function situacao(c, a) {
    if (a.bloqueado || !c.ativo) return '<span class="ig-sit perigo">desligado</span>';
    if (c.tipo === "confidencial" && !c.segredo) return '<span class="ig-sit atencao">sem segredo</span>';
    return '<span class="ig-sit ok">ligado</span>';
  }

  function blocoQuem(a) {
    var todos = a.acesso === "todos";
    var h = '<div class="ig-bloco"><h3 class="titulo-secao">Quem pode entrar</h3>' +
      '<div class="opcoes" role="group" aria-label="Quem pode entrar">' +
      '<button type="button" data-ic="modo" data-id="' + esc(a.id) + '" data-v="liberados" aria-pressed="' + !todos + '">Só as pessoas liberadas</button>' +
      '<button type="button" data-ic="modo" data-id="' + esc(a.id) + '" data-v="todos" aria-pressed="' + todos + '">Qualquer Conta Atos</button></div>' +
      '<p class="dica">' + (todos
        ? "Qualquer pessoa com Conta Atos entra (cadastro aberto). A lista abaixo fica guardada, mas não vale enquanto o cadastro estiver aberto."
        : "Entram você (" + esc(a.dono) + ") e os e-mails da lista. Um e-mail que ainda não tem Conta Atos entra quando a pessoa criar a conta com ele (o e-mail é confirmado por código).") + "</p>";
    h += '<div class="ig-lista">' + (a.liberados.length ? a.liberados.map(function (e) {
      return '<div class="ig-pessoa"><span>' + esc(e) + '</span><button type="button" class="btn mini" data-ic="tirar" data-id="' + esc(a.id) + '" data-email="' + esc(e) + '">Tirar</button></div>';
    }).join("") : '<p class="vazio">Ninguém na lista ainda.</p>') + "</div>";
    h += '<form class="ig-liberar" data-ic-form="liberar" data-id="' + esc(a.id) + '"><label class="campo"><span class="rotulo">Liberar e-mails (um por linha, ou separados por vírgula)</span>' +
      '<textarea name="emails" rows="2" spellcheck="false" autocomplete="off" placeholder="pessoa@empresa.com"></textarea></label>' +
      '<div class="ig-linha-botoes"><span class="erro" role="alert" data-ic-erro="liberar-' + esc(a.id) + '"></span><button type="submit" class="btn p">Liberar</button></div></form>' +
      '<p class="dica">' + a.liberados.length + " de " + S.dados.limites.liberados + " pessoas. Tirar alguém da lista corta o próximo login e o userinfo na hora; o id_token que o sistema já recebeu vale até vencer (até " +
      Math.round(S.dados.token_s / 60) + " minutos), e a sessão que o seu sistema criou é dele: encerre por lá.</p></div>";
    return h;
  }

  function blocoAcessos(a) {
    var lim = S.dados.limites.acessos;
    var h = '<div class="ig-bloco"><h3 class="titulo-secao ig-h"><span>Acessos (' + a.acessos.length + " de " + lim + ")</span>" +
      (a.acessos.length < lim && !a.bloqueado ? '<button type="button" class="btn mini" data-ic="novo-acesso" data-id="' + esc(a.id) + '">Novo acesso</button>' : "") + "</h3>" +
      '<p class="dica">Um acesso é um jeito de o sistema pedir o login: o site, o programa instalado, o servidor. Cada um tem o seu client_id; a permissão que a pessoa dá vale para o aplicativo todo.</p>';
    if (!a.acessos.length) return h + '<p class="vazio">Nenhum acesso ainda: crie um para ter o client_id.</p></div>';
    h += a.acessos.map(function (c) {
      var conf = c.tipo === "confidencial", aberto = S.aberto === c.id;
      var acoes = '<button type="button" class="btn mini" data-ic="integrar" data-cid="' + esc(c.id) + '" aria-expanded="' + aberto + '">Como integrar</button>' +
        '<button type="button" class="btn mini" data-ic="editar-acesso" data-cid="' + esc(c.id) + '">Editar</button>' +
        (conf && !a.bloqueado ? '<button type="button" class="btn mini" data-ic="segredo" data-cid="' + esc(c.id) + '">' + (c.segredo ? "Trocar o segredo" : "Gerar o segredo") + "</button>" : "") +
        (a.bloqueado ? "" : '<button type="button" class="btn mini" data-ic="' + (c.ativo ? "desligar" : "ligar") + '" data-cid="' + esc(c.id) + '">' + (c.ativo ? "Desligar" : "Ligar") + "</button>") +
        '<button type="button" class="btn mini perigo" data-ic="apagar-acesso" data-cid="' + esc(c.id) + '">Apagar</button>';
      return '<div class="ig-acesso"><div class="ig-acesso-topo"><span class="nome"><strong><code>' + esc(c.id) + "</code> " + situacao(c, a) + "</strong>" +
        "<small>" + (conf ? "Confidencial (servidor, com segredo)" : "Público (página ou programa, com PKCE)") +
        (c.segredo ? " · segredo de " + esc(quando(c.segredo.quando)) : "") + "</small>" +
        "<small>" + window.IntegrarAtos.voltas(c).map(esc).join(" · ") + "</small></span>" +
        '<span class="ig-acoes">' + acoes + "</span></div>" +
        (aberto ? window.IntegrarAtos.cartao(c, S.dados, a.nome, ONDE) : "") + "</div>";
    }).join("");
    return h + "</div>";
  }

  // ------------------------------------------------------------ os avisos ao sistema (webhooks)

  var TIPOS_AV = { "acesso.revogado": "acesso revogado", "liberado.adicionado": "liberado", "liberado.removido": "tirado da lista", "aviso.teste": "teste" };
  var ESTADOS_AV = { pendente: "esperando", entregue: "entregue", falhou: "falhou", cancelado: "cancelado" };
  function avisosApi(id, corpo) {
    AV.ocupado = id; AV.erro[id] = ""; pintar();
    return api("/api/integracoes/apps/" + id + "/avisos", corpo).then(function (d) {
      AV.ocupado = "";
      if (d._status === 401 && d.reentrar) { S.dados.recente = false; pintar(); return d; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; document.dispatchEvent(new CustomEvent("workspace-inativo")); return d; }
      if (d.erro) { AV.erro[id] = d.erro; pintar(); return d; }
      if (d.segredo) AV.segredo = { id: id, valor: d.segredo };
      d._app = id;
      if (AV.entregas[id] !== undefined || d.testado) AV.entregas[id] = d;
      var x = app(id);
      if (x) x.avisos = d.aviso ? Object.assign({}, x.avisos || {}, d.aviso) : null;
      pintar();
      return d;
    });
  }
  function entregasDe(id) {
    var E = AV.entregas[id];
    if (E === undefined) return "";
    if (E === null) return '<p class="dica">Carregando as entregas…</p>';
    var l = E.entregas || [];
    if (!l.length) return '<p class="vazio">Nenhum aviso ainda.</p>';
    return '<ul class="fm-registro">' + l.map(function (x) {
      var u = x.ultimo;
      return "<li><span>" + esc(quando(x.criado)) + "</span> " + esc(TIPOS_AV[x.tipo] || x.tipo) + " · <strong>" + esc(ESTADOS_AV[x.estado] || x.estado) + "</strong>" +
        (x.tentativas ? " · " + x.tentativas + (x.tentativas === 1 ? " tentativa" : " tentativas") : "") + (u ? " · " + (u.status ? "resposta " + u.status : "sem resposta") + (u.motivo ? " (" + esc(u.motivo) + ")" : "") : "") +
        (x.proxima ? " · próxima tentativa " + esc(quando(x.proxima)) : "") +
        (x.estado === "falhou" || x.estado === "cancelado" ? ' <button type="button" class="btn mini" data-ic="av-reenviar" data-id="' + esc(E._app) + '" data-chave="' + esc(x.chave) + '">Tentar de novo</button>' : "") + "</li>";
    }).join("") + "</ul>";
  }
  function blocoAvisos(a) {
    var v = a.avisos, ocupado = AV.ocupado === a.id;
    var h = '<div class="ig-bloco"><h3 class="titulo-secao">Avisos ao seu sistema</h3>' +
      '<p class="dica">A Atos manda ao endereço do seu sistema, assinado, quando alguém tira a permissão em Minha conta (acesso.revogado, com o sub) e quando a lista de liberados muda (liberado.adicionado e liberado.removido, com o e-mail, e o sub de quem já entrou). ' +
      'Confira a assinatura com o segredo (veja <a href="/integracao/#avisos">como</a>).</p>';
    if (AV.erro[a.id]) h += '<p class="erro" role="alert">' + esc(AV.erro[a.id]) + "</p>";
    if (AV.segredo && AV.segredo.id === a.id) {
      h += "<p><strong>O segredo aparece só agora.</strong> A Atos não mostra de novo; se perder, troque.</p>" +
        '<pre class="ig-pre ig-segredo">' + esc(AV.segredo.valor) + "</pre>" +
        '<p class="dica">Guarde-o no servidor do sistema (ex.: a variável ATOS_AVISOS_SEGREDO), nunca no código ou na página.</p>' +
        '<div class="ig-acoes"><button type="button" class="btn mini" data-ic="av-copiar">Copiar</button><button type="button" class="btn mini" data-ic="av-guardei">Já guardei</button></div>';
    }
    if (!v) {
      return h + '<form class="ig-liberar" data-ic-form="avisos" data-id="' + esc(a.id) + '"><label class="campo"><span class="rotulo">Endereço do seu sistema (https)</span>' +
        '<input name="url" type="url" placeholder="https://seusistema.com.br/atos/avisos" autocomplete="off" spellcheck="false"></label>' +
        '<div class="ig-linha-botoes"><button type="submit" class="btn p"' + (ocupado ? " disabled" : "") + ">Cadastrar e gerar o segredo</button></div></form></div>";
    }
    var sit = v.bloqueado ? '<span class="ig-sit perigo">desligados pela Atos</span>' : v.ativo ? '<span class="ig-sit ok">ligados</span>' : '<span class="ig-sit">desligados</span>';
    h += '<dl class="ig-info"><dt>Endereço</dt><dd><code>' + esc(v.url) + "</code> " + sit + "</dd>" +
      "<dt>Segredo</dt><dd>gerado em " + esc(quando(v.segredo_quando)) + "</dd>" +
      (v.ultima ? "<dt>O último</dt><dd>" + esc(TIPOS_AV[v.ultima.tipo] || v.ultima.tipo) + " · " + esc(ESTADOS_AV[v.ultima.estado] || v.ultima.estado) + " · " + esc(quando(v.ultima.criado)) + "</dd>" : "") +
      (v.falhas ? "<dt>Falharam</dt><dd>" + v.falhas + " entre os últimos 20" + "</dd>" : "") + "</dl>";
    if (v.bloqueado) h += '<p class="ig-aviso">A Atos desligou os avisos deste aplicativo em ' + esc(quando(v.bloqueado.quando)) + (v.bloqueado.motivo ? ": " + esc(v.bloqueado.motivo) : "") + ". O login continua. Para conversar, escreva para contato@atos.dev.br.</p>";
    var c = AV.confirmar && AV.confirmar.id === a.id ? AV.confirmar.acao : "";
    if (c) {
      h += '<p class="ig-aviso">' + (c === "segredo" ? "Trocar o segredo? O de agora para de valer na hora: o seu sistema recusa os avisos até receber o novo." : "Apagar os avisos? O endereço, o segredo e o registro das entregas são apagados.") + "</p>" +
        '<div class="ig-acoes"><button type="button" class="btn mini perigo" data-ic="av-sim" data-id="' + esc(a.id) + '">' + (c === "segredo" ? "Trocar o segredo" : "Apagar") + '</button><button type="button" class="btn mini" data-ic="av-nao">Voltar</button></div>';
    } else {
      h += '<form class="ig-liberar" data-ic-form="avisos" data-id="' + esc(a.id) + '"><label class="campo"><span class="rotulo">Trocar o endereço</span>' +
        '<input name="url" type="url" value="' + esc(v.url) + '" autocomplete="off" spellcheck="false"></label></form>' +
        '<div class="ig-acoes">' + (v.bloqueado ? "" : '<button type="button" class="btn mini" data-ic="av-salvar" data-id="' + esc(a.id) + '">Salvar o endereço</button>' +
          '<button type="button" class="btn mini" data-ic="' + (v.ativo ? "av-desligar" : "av-ligar") + '" data-id="' + esc(a.id) + '">' + (v.ativo ? "Desligar" : "Ligar") + "</button>" +
          (v.ativo ? '<button type="button" class="btn mini" data-ic="av-testar" data-id="' + esc(a.id) + '">Mandar um aviso de teste</button>' : "") +
          '<button type="button" class="btn mini" data-ic="av-segredo" data-id="' + esc(a.id) + '">Trocar o segredo</button>') +
        '<button type="button" class="btn mini" data-ic="av-entregas" data-id="' + esc(a.id) + '" aria-expanded="' + (AV.entregas[a.id] !== undefined) + '">Entregas</button>' +
        '<button type="button" class="btn mini perigo" data-ic="av-apagar" data-id="' + esc(a.id) + '">Apagar</button></div>';
    }
    return h + entregasDe(a.id) + "</div>";
  }

  // ------------------------------------------------------------ o registro de entradas

  function consultaEntradas(id) {
    var f = EN[id];
    return "dias=" + f.dias + (f.resultado ? "&resultado=" + f.resultado : "") + (f.q ? "&q=" + encodeURIComponent(f.q) : "");
  }
  function lerEntradas(id) {
    EN[id].dados = null; pintar();
    api("/api/integracoes/apps/" + id + "/entradas?" + consultaEntradas(id)).then(function (d) { if (EN[id]) { EN[id].dados = d; pintar(); } });
  }
  function blocoEntradas(a) {
    var f = EN[a.id];
    var h = '<div class="ig-bloco"><h3 class="titulo-secao ig-h"><span>Entradas</span><button type="button" class="btn mini" data-ic="en-abrir" data-id="' + esc(a.id) + '" aria-expanded="' + Boolean(f) + '">' + (f ? "Fechar" : "Ver as entradas") + "</button></h3>";
    var L = S.dados.limites;
    if (!f) return h + '<p class="dica">Quem entrou no aplicativo nos últimos ' + L.entradas_dias + ' dias (o que o seu sistema já recebe: o sub, e o e-mail e o nome se os escopos foram permitidos), de onde e com que navegador, e as recusas por não estar liberado (sem dizer quem).</p></div>';
    var opt = function (v, t, atual) { return '<option value="' + v + '"' + (String(atual) === String(v) ? " selected" : "") + ">" + t + "</option>"; };
    h += '<form class="en-filtro" data-ic-form="entradas" data-id="' + esc(a.id) + '">' +
      '<label class="campo"><span class="rotulo">Período</span><select name="dias">' + [7, 30, 90].filter(function (n) { return n <= L.entradas_dias; }).map(function (n) { return opt(n, n + " dias", f.dias); }).join("") + "</select></label>" +
      '<label class="campo"><span class="rotulo">Resultado</span><select name="resultado">' + opt("", "todos", f.resultado) + opt("entrou", "entrou", f.resultado) + opt("recusado", "recusado (não liberado)", f.resultado) + "</select></label>" +
      '<label class="campo"><span class="rotulo">Buscar (sub, e-mail, nome, lugar)</span><input name="q" value="' + esc(f.q) + '" autocomplete="off" spellcheck="false"></label>' +
      '<div class="ig-acoes"><button type="submit" class="btn mini">Filtrar</button>' + (L.entradas_csv ? '<a class="btn mini" href="/api/integracoes/apps/' + esc(a.id) + "/entradas.csv?" + esc(consultaEntradas(a.id)) + '" download>Exportar CSV</a>'
        : '<span class="dica">Exportar em CSV e ver até 90 dias: no Pro. <a href="/workspace/plano">Conhecer o Pro</a></span>') + "</div></form>";
    var D = f.dados;
    if (!D) return h + '<p class="dica">Carregando…</p></div>';
    if (D.erro) return h + '<p class="erro">' + esc(D.erro) + "</p></div>";
    h += '<p class="dica">' + D.total + (D.total === 1 ? " entrada" : " entradas") + (D.total > D.linhas.length ? " (mostrando as " + D.linhas.length + " mais novas; o CSV traz até " + D.limites.csv + ")" : "") +
      (D.nao_registradas_hoje ? " · " + D.nao_registradas_hoje + " de hoje não entraram no registro (passou de " + D.limites.por_dia + " no dia)" : "") + "</p>";
    if (!D.linhas.length) return h + '<p class="vazio">Nenhuma entrada no período.</p></div>';
    return h + '<ul class="fm-registro">' + D.linhas.map(function (x) {
      return "<li><span>" + esc(quando(x.quando)) + "</span> <strong>" + (x.resultado === "entrou" ? "entrou" : "recusado (não liberado)") + "</strong>" +
        (x.sub ? " · " + esc(x.nome ? x.nome + " · " : "") + esc(x.email ? x.email + " · " : "") + "<code>" + esc(x.sub) + "</code>" : "") +
        (x.onde ? " · " + esc(x.onde) : "") + (x.navegador ? " · " + esc(x.navegador) : "") + "</li>";
    }).join("") + "</ul></div>";
  }

  function blocoRegistro(a) {
    if (!a.registro || !a.registro.length) return "";
    return '<details class="ig-registro"><summary>Registro de mudanças</summary><ul>' + a.registro.map(function (x) {
      return "<li><span>" + esc(quando(x.quando)) + "</span> " + esc(x.quem === "equipe" ? "Atos (" + x.por + ")" : x.por) + ": " + esc(x.oque) + "</li>";
    }).join("") + "</ul></details>";
  }

  function cartaoDoApp(a) {
    var h = '<div class="card ig-app">' +
      '<div class="item">' + icone(a) + '<span class="nome"><strong>' + esc(a.nome) + "</strong><small>" + esc(a.descricao) + " · " + esc(a.site) + "</small>" +
      "<small>Criado em " + esc(quando(a.criado)) + (a.mudado ? " · mudado em " + esc(quando(a.mudado)) : "") + "</small></span>" +
      '<span class="ig-acoes">' + (a.fora_do_plano ? "" : '<button type="button" class="btn mini" data-ic="editar-app" data-id="' + esc(a.id) + '">Editar</button>') +
      '<button type="button" class="btn mini perigo" data-ic="apagar-app" data-id="' + esc(a.id) + '">Apagar</button></span></div>';
    if (a.bloqueado) {
      h += '<p class="ig-aviso">A Atos desligou este aplicativo em ' + esc(quando(a.bloqueado.quando)) + (a.bloqueado.motivo ? ": " + esc(a.bloqueado.motivo) : "") +
        ". Ninguém entra por ele enquanto estiver assim. Para conversar, escreva para contato@atos.dev.br.</p>";
    }
    if (a.fora_do_plano) {
      h += '<p class="ig-aviso">Fora do plano: este aplicativo passa do limite do seu plano (' + S.dados.limites.apps + ' aplicativos). Ele continua deixando entrar quem já entrava, mas fica só leitura: ' +
        'dá para tirar pessoas, desligar ou apagar acessos e apagar o aplicativo. Volta ao normal com o Pro ou apagando outro. <a href="/workspace/plano">Conhecer o Pro</a></p>';
    }
    return h + blocoQuem(a) + blocoAcessos(a) + blocoAvisos(a) + blocoEntradas(a) + blocoRegistro(a) + "</div>";
  }

  function tela() {
    if (!S.dados) {
      return '<div class="card"><p class="vazio">' + (S.erro ? esc(S.erro) + ' <button type="button" class="link" data-ic="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    }
    var D = S.dados, h = "";
    if (S.erro) h += '<p class="erro" role="alert">' + esc(S.erro) + "</p>";
    if (!D.recente) h += '<p class="ig-aviso">Para criar ou mudar integrações, o login precisa ser das últimas ' + D.limites.recente_h + ' horas. <a href="' + VOLTA_ENTRAR + '">Entrar de novo</a></p>';
    if (S.aviso) h += '<p class="ok ig-ok">' + esc(S.aviso) + "</p>";
    h += '<h2 class="titulo-secao ig-h"><span>Seus aplicativos (' + D.apps.length + " de " + D.limites.apps + ")</span>" +
      (D.apps.length < D.limites.apps ? '<button type="button" class="btn p primario" data-ic="novo-app">Novo aplicativo</button>' : D.plano && !D.plano.pro ? '<a class="btn p" href="/workspace/plano">Conhecer o Pro</a>' : "") + "</h2>";
    if (!D.apps.length) {
      h += '<div class="card"><p class="vazio">Nenhum aplicativo. Cadastre o seu sistema para as pessoas entrarem nele com a Conta Atos: você recebe o client_id e diz quem pode entrar.</p></div>';
    } else h += D.apps.map(cartaoDoApp).join("");
    h += '<p class="nota">O aplicativo é seu e você responde por ele: a Atos só confirma quem é a pessoa e, com a permissão dela, passa ao seu sistema o identificador da conta, o nome e o e-mail. ' +
      "Na tela de permitir, quem entra vê que o aplicativo foi cadastrado por " + esc(D.email_atos || "uma Conta Atos") + " (o seu e-mail Atos; o pessoal não aparece) e não é da Atos. A Atos pode desligar um aplicativo usado para abuso. " +
      'Limites do plano ' + (D.plano && D.plano.pro ? "Pro" : "gratuito") + ": " + D.limites.apps + " aplicativos por conta, " + D.limites.acessos + " acessos por aplicativo e " + D.limites.liberados.toLocaleString("pt-BR") + ' pessoas liberadas por aplicativo. Veja os <a href="/termos/#workspace">termos do Atos Workspace</a> e a <a href="/privacidade/">política de privacidade</a>.</p>';
    return h;
  }

  function pintar() {
    if (!S.raiz || !document.body.contains(S.raiz)) return;
    if (!window.IntegrarAtos) { S.raiz.innerHTML = '<div class="card"><p class="vazio">Carregando…</p></div>'; return; }
    S.raiz.innerHTML = tela();
  }

  // ------------------------------------------------------------ os pop-ups

  function camada() {
    var c = document.getElementById("ig-camada");
    if (!c) { c = document.createElement("div"); c.id = "ig-camada"; document.body.appendChild(c); }
    return c;
  }
  function pintarModal() {
    var c = camada();
    if (!S.modal) { c.innerHTML = ""; return; }
    var velho = c.querySelector(".modal"), rolagem = velho ? velho.scrollTop : 0;
    c.innerHTML = '<div class="fundo-modal ig-fundo" data-ic-fundo><div class="modal ig-modal" role="dialog" aria-modal="true" aria-labelledby="ig-modal-titulo">' + S.modal.html() + "</div></div>";
    var caixa = c.querySelector(".modal");
    caixa.scrollTop = rolagem;
    if (!S.modal.focado) {
      S.modal.focado = true;
      var alvo = caixa.querySelector("input:not([type=file]):not([type=checkbox]), textarea") || caixa.querySelector("[data-ic-foco]") || caixa.querySelector("button");
      if (alvo) alvo.focus();
    }
  }
  function abrir(M) { S.modal = M; pintarModal(); }
  function fechar() { S.modal = null; pintarModal(); }

  function campo(rotulo, k, v, extra) {
    return '<label class="campo"><span class="rotulo">' + esc(rotulo) + '</span><input data-ic-in="' + k + '" value="' + esc(v || "") + '" autocomplete="off" spellcheck="false"' + (extra || "") + "></label>";
  }
  function area(rotulo, k, v, dica) {
    return '<label class="campo"><span class="rotulo">' + esc(rotulo) + '</span><textarea data-ic-in="' + k + '" rows="3" spellcheck="false">' + esc(v || "") + "</textarea>" +
      (dica ? '<span class="dica">' + esc(dica) + "</span>" : "") + "</label>";
  }
  function pe(rotulo, perigo) {
    var M = S.modal;
    return (M.erro ? '<p class="erro" role="alert">' + esc(M.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-ic="fechar">' + (M.valor ? "Fechar" : "Cancelar") + "</button>" +
      '<button type="button" class="btn p ' + (perigo ? "perigo" : "primario") + '" data-ic="ok" data-ic-foco' + (M.enviando ? " disabled" : "") + ">" + esc(M.enviando ? "Um momento…" : rotulo) + "</button></div>";
  }

  function modalApp() {
    var M = S.modal, v = M.v;
    return '<h2 id="ig-modal-titulo">' + (M.id ? "Editar " + esc(v.nome) : "Novo aplicativo") + "</h2>" +
      "<p>Quem entra vê o nome, a descrição, o ícone, quem cadastrou (o seu e-mail Atos, nunca o pessoal) e os links da política de privacidade e dos termos do seu sistema na tela de permitir.</p>" +
      campo("Nome", "nome", v.nome, ' maxlength="60"') + campo("Descrição curta (ex.: controle de canteiros)", "descricao", v.descricao, ' maxlength="140"') +
      campo("Site (https)", "site", v.site, ' type="url"') + campo("Política de privacidade (https)", "privacidade", v.privacidade, ' type="url"') +
      campo("Termos de uso (https)", "termos", v.termos, ' type="url"') +
      '<div class="campo"><span class="rotulo">Ícone (opcional)</span><div class="ig-icone">' + icone({ icone: v.icone, nome: v.nome }) +
      '<label class="btn mini ig-arquivo"><span>Escolher imagem</span><input type="file" accept="image/png,image/jpeg,image/webp" data-ic-arq="icone"></label>' +
      (v.icone ? '<button type="button" class="btn mini" data-ic="sem-icone">Tirar o ícone</button>' : "") + "</div>" +
      '<span class="dica">PNG, JPEG ou WebP de até 30 KB, quadrada. Fica guardada junto do aplicativo. Sem ícone, aparece a inicial do nome.</span></div>' +
      (M.id ? "" : '<p class="dica">O aplicativo nasce fechado: só você entra, até liberar outras pessoas ou abrir para qualquer Conta Atos.</p>') +
      pe(M.id ? "Salvar" : "Criar");
  }
  function modalAcesso() {
    var M = S.modal, v = M.v;
    return '<h2 id="ig-modal-titulo">' + (M.cid ? "Editar o acesso " + esc(M.cid) : "Novo acesso") + "</h2>" +
      (M.cid ? "<p><strong>" + (v.tipo === "confidencial" ? "Confidencial (servidor)" : "Público (página ou programa)") + "</strong>. O tipo não muda: para outro, crie outro acesso.</p>"
        : '<div class="campo"><span class="rotulo">Tipo</span><div class="opcoes" role="group" aria-label="Tipo">' +
          '<button type="button" data-ic="tipo" data-v="publico" aria-pressed="' + (v.tipo === "publico") + '">Público (página ou programa)</button>' +
          '<button type="button" data-ic="tipo" data-v="confidencial" aria-pressed="' + (v.tipo === "confidencial") + '">Confidencial (servidor)</button></div>' +
          '<span class="dica">' + (v.tipo === "confidencial" ? "Troca o código no servidor, com PKCE e um segredo. O segredo você gera depois, e ele aparece uma vez só." :
            "Troca o código com PKCE, sem segredo: uma página que roda no navegador ou um programa instalado.") + "</span></div>") +
      area("Endereços de volta (um por linha)", "voltas", v.voltas, "Exatamente como o sistema manda em redirect_uri: https; http só em 127.0.0.1 ou [::1]; sem #.") +
      '<label class="ig-marcar"><input type="checkbox" data-ic-in="loopback"' + (v.loopback ? " checked" : "") + "><span>Programa instalado: aceita a volta em qualquer porta de http://127.0.0.1 e http://[::1] (RFC 8252)</span></label>" +
      area("Origens para CORS (uma por linha, opcional)", "origens", v.origens, "Só se uma página troca o código no navegador: o esquema, o host e a porta (ex.: https://exemplo.com.br).") +
      pe(M.cid ? "Salvar" : "Criar");
  }
  function modalApagar() {
    var M = S.modal;
    if (M.tipo === "app") {
      var a = app(M.id) || { nome: "", acessos: [] };
      return '<h2 id="ig-modal-titulo">Apagar ' + esc(a.nome) + "</h2>" +
        "<p>O aplicativo sai do Entrar com Atos na hora, com " + (a.acessos.length === 1 ? "o acesso" : "os " + a.acessos.length + " acessos") +
        " e os segredos. Ninguém entra mais por ele; quem permitiu deixa de vê-lo na Minha conta. Não tem volta: para usar de novo, crie outro (com outro client_id).</p>" + pe("Apagar", true);
    }
    return '<h2 id="ig-modal-titulo">Apagar o acesso ' + esc(M.cid) + "</h2><p>Os logins com este client_id param na hora" + (M.conf ? " e o segredo dele é apagado" : "") +
      ". Não tem volta. O id_token já emitido vale até vencer.</p>" + pe("Apagar", true);
  }
  function modalSegredo() {
    var M = S.modal, x = acessoDe(M.cid);
    if (M.valor) {
      return '<h2 id="ig-modal-titulo">O segredo de ' + esc(M.cid) + "</h2>" +
        "<p><strong>Ele aparece só agora.</strong> A Atos guarda só um resumo dele e não consegue mostrá-lo de novo; se perder, gere outro.</p>" +
        '<pre class="ig-pre ig-segredo" data-ic-segredo>' + esc(M.valor) + "</pre>" +
        '<p class="dica">Guarde-o no servidor do sistema, na variável de ambiente <code>ATOS_CLIENT_SECRET</code>. Nunca no código, no repositório, na página ou num pedido para um assistente.</p>' +
        '<div class="botoes"><button type="button" class="btn p" data-ic="copiar-segredo">Copiar</button><button type="button" class="btn p primario" data-ic="fechar" data-ic-foco>Já guardei</button></div>';
    }
    var tem = x && x.c.segredo;
    return '<h2 id="ig-modal-titulo">' + (tem ? "Trocar o segredo de " : "Gerar o segredo de ") + esc(M.cid) + "</h2>" +
      "<p>Vale na hora" + (tem ? ": <strong>o segredo de agora para de valer</strong>, e o servidor que o usa não troca códigos até receber o novo" : "") +
      ". O novo aparece uma vez só, na próxima tela. Fica no registro do aplicativo que você gerou e quando (sem o valor).</p>" + pe(tem ? "Trocar o segredo" : "Gerar o segredo", tem);
  }

  function enviarModal() {
    var M = S.modal;
    if (!M || M.enviando) return;
    var caminho, corpo, depois;
    if (M.html === modalApp) {
      var v = M.v;
      corpo = { nome: v.nome.trim(), descricao: v.descricao.trim(), site: v.site.trim(), privacidade: v.privacidade.trim(), termos: v.termos.trim(), icone: v.icone || "" };
      if (M.id) { caminho = "/api/integracoes/apps/" + M.id; corpo.acao = "editar"; }
      else { caminho = "/api/integracoes/apps"; depois = function (d) { S.aviso = "Aplicativo criado. Agora crie um acesso para ter o client_id."; if (d.app) S.dados.apps.push(d.app); }; }
    } else if (M.html === modalAcesso) {
      corpo = { voltas: linhas(M.v.voltas), loopback: Boolean(M.v.loopback), origens: linhas(M.v.origens) };
      if (M.cid) { caminho = "/api/integracoes/acessos/" + M.cid; corpo.acao = "editar"; }
      else { caminho = "/api/integracoes/apps/" + M.id + "/acessos"; corpo.tipo = M.v.tipo; depois = function (d) { S.aberto = d.acesso || ""; }; }
    } else if (M.html === modalApagar) {
      caminho = M.tipo === "app" ? "/api/integracoes/apps/" + M.id : "/api/integracoes/acessos/" + M.cid;
      corpo = { acao: "apagar", confirmar: true };
    } else if (M.html === modalSegredo) {
      caminho = "/api/integracoes/acessos/" + M.cid;
      corpo = { acao: "segredo", confirmar: true };
    }
    M.enviando = true; M.erro = ""; pintarModal();
    mudar(caminho, corpo, depois).then(function (d) {
      if (S.modal !== M) return;
      M.enviando = false;
      if (d._status === 401 && d.reentrar) { fechar(); return; }
      if (d.erro) { M.erro = d.erro; pintarModal(); return; }
      if (M.html === modalSegredo) { M.valor = d.segredo; pintarModal(); return; }
      fechar();
    });
  }

  // ------------------------------------------------------------ os eventos

  document.addEventListener("click", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-ic-fundo")) { fechar(); return; }
    var b = e.target.closest && e.target.closest("[data-ic]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-ic"), id = b.getAttribute("data-id"), cid = b.getAttribute("data-cid");
    if (a === "recarregar") { S.erro = ""; pintar(); carregar(); return; }
    if (a === "fechar") { fechar(); return; }
    if (a === "ok") { enviarModal(); return; }
    if (a === "integrar") { S.aberto = S.aberto === cid ? "" : cid; pintar(); return; }
    if (a === "novo-app") { S.aviso = ""; abrir({ html: modalApp, v: { nome: "", descricao: "", site: "", privacidade: "", termos: "", icone: "" }, erro: "" }); return; }
    if (a === "editar-app") {
      var x = app(id); if (!x) return;
      abrir({ html: modalApp, id: id, v: { nome: x.nome, descricao: x.descricao, site: x.site, privacidade: x.privacidade, termos: x.termos, icone: x.icone || "" }, erro: "" }); return;
    }
    if (a === "apagar-app") { abrir({ html: modalApagar, tipo: "app", id: id, erro: "" }); return; }
    if (a === "novo-acesso") { abrir({ html: modalAcesso, id: id, v: { tipo: "publico", voltas: "", loopback: false, origens: "" }, erro: "" }); return; }
    if (a === "editar-acesso") {
      var y = acessoDe(cid); if (!y) return;
      abrir({ html: modalAcesso, cid: cid, v: { tipo: y.c.tipo, voltas: y.c.voltas.join("\n"), loopback: y.c.loopback, origens: y.c.origens.join("\n") }, erro: "" }); return;
    }
    if (a === "apagar-acesso") { var z = acessoDe(cid); abrir({ html: modalApagar, tipo: "acesso", cid: cid, conf: Boolean(z && z.c.tipo === "confidencial"), erro: "" }); return; }
    if (a === "segredo") { abrir({ html: modalSegredo, cid: cid, erro: "" }); return; }
    if (a === "tipo") { if (S.modal) { S.modal.v.tipo = b.getAttribute("data-v"); pintarModal(); } return; }
    if (a === "sem-icone") { if (S.modal) { S.modal.v.icone = ""; pintarModal(); } return; }
    if (a === "copiar-segredo") {
      var M = S.modal; if (!M || !M.valor) return;
      var feito = function (ok) { b.textContent = ok ? "Copiado" : "Selecione e copie"; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(M.valor).then(function () { feito(true); }, function () { feito(false); });
      else feito(false);
      return;
    }
    if (a === "modo") {
      b.disabled = true;
      mudar("/api/integracoes/apps/" + id, { acao: "acesso", acesso: b.getAttribute("data-v") }).then(function (d) { if (d.erro) { S.erro = d.erro; pintar(); } });
      return;
    }
    if (a === "tirar") {
      b.disabled = true;
      mudar("/api/integracoes/apps/" + id, { acao: "tirar", email: b.getAttribute("data-email") }).then(function (d) { if (d.erro) { S.erro = d.erro; pintar(); } });
      return;
    }
    if (a === "en-abrir") { if (EN[id]) { delete EN[id]; pintar(); } else { EN[id] = { dias: Math.min(30, (S.dados.limites && S.dados.limites.entradas_dias) || 30), resultado: "", q: "", dados: null }; lerEntradas(id); } return; }
    if (a === "av-guardei") { AV.segredo = null; pintar(); return; }
    if (a === "av-copiar") {
      var sv = AV.segredo && AV.segredo.valor; if (!sv) return;
      var ok2 = function (ok) { b.textContent = ok ? "Copiado" : "Selecione e copie"; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sv).then(function () { ok2(true); }, function () { ok2(false); }); else ok2(false);
      return;
    }
    if (a === "av-nao") { AV.confirmar = null; pintar(); return; }
    if (a === "av-segredo" || a === "av-apagar") { AV.confirmar = { id: id, acao: a.slice(3) }; pintar(); return; }
    if (a === "av-sim") { var cf = AV.confirmar; AV.confirmar = null; if (cf) avisosApi(id, { acao: cf.acao, confirmar: true }); return; }
    if (a === "av-ligar" || a === "av-desligar" || a === "av-testar") { avisosApi(id, { acao: a.slice(3) }); return; }
    if (a === "av-salvar") {
      var inp = b.closest(".ig-bloco").querySelector("form[data-ic-form=avisos] input[name=url]");
      avisosApi(id, { acao: "salvar", url: inp ? inp.value.trim() : "" });
      return;
    }
    if (a === "av-reenviar") { avisosApi(id, { acao: "reenviar", entrega: b.getAttribute("data-chave") }); return; }
    if (a === "av-entregas") {
      if (AV.entregas[id] !== undefined) { delete AV.entregas[id]; pintar(); return; }
      AV.entregas[id] = null; pintar();
      api("/api/integracoes/apps/" + id + "/avisos").then(function (d) { AV.entregas[id] = d.erro ? { entregas: [] } : d; AV.entregas[id]._app = id; pintar(); });
      return;
    }
    if (a === "ligar" || a === "desligar") {
      b.disabled = true;
      mudar("/api/integracoes/acessos/" + cid, { acao: a }).then(function (d) { if (d.erro) { S.erro = d.erro; pintar(); } });
    }
  });
  document.addEventListener("submit", function (e) {
    var f = e.target.closest && e.target.closest("form[data-ic-form]");
    if (!f) return;
    e.preventDefault();
    if (f.getAttribute("data-ic-form") === "entradas") {
      var fid = f.getAttribute("data-id");
      EN[fid] = { dias: f.querySelector("[name=dias]").value, resultado: f.querySelector("[name=resultado]").value, q: f.querySelector("[name=q]").value.trim(), dados: null };
      lerEntradas(fid);
      return;
    }
    if (f.getAttribute("data-ic-form") === "avisos") { avisosApi(f.getAttribute("data-id"), { acao: "salvar", url: f.querySelector("input[name=url]").value.trim() }); return; }
    var id = f.getAttribute("data-id"), t = f.querySelector("textarea[name=emails]"), botao = f.querySelector("button[type=submit]");
    var erro = f.querySelector("[data-ic-erro]");
    var emails = String(t.value || "").trim();
    if (!emails) { erro.textContent = "diga pelo menos um e-mail"; return; }
    botao.disabled = true;
    mudar("/api/integracoes/apps/" + id, { acao: "liberar", emails: emails }).then(function (d) {
      if (d.erro) { botao.disabled = false; erro.innerHTML = esc(d.erro); }
    });
  });
  document.addEventListener("input", function (e) {
    var el = e.target.closest && e.target.closest("[data-ic-in]");
    if (!el || !S.modal || !S.modal.v) return;
    S.modal.v[el.getAttribute("data-ic-in")] = el.type === "checkbox" ? el.checked : el.value;
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !S.modal) return;
    if (el.getAttribute("data-ic-in") === "loopback") { S.modal.v.loopback = el.checked; return; }
    if (el.getAttribute("data-ic-arq") !== "icone") return;
    var arq = el.files && el.files[0];
    if (!arq) return;
    if (["image/png", "image/jpeg", "image/webp"].indexOf(arq.type) < 0) { S.modal.erro = "o ícone precisa ser PNG, JPEG ou WebP"; pintarModal(); return; }
    if (arq.size > ICONE_MAX) { S.modal.erro = "o ícone tem " + Math.ceil(arq.size / 1024) + " KB; o limite é 30 KB"; pintarModal(); return; }
    var leitor = new FileReader();
    leitor.onload = function () { if (S.modal) { S.modal.v.icone = String(leitor.result || ""); S.modal.erro = ""; pintarModal(); } };
    leitor.onerror = function () { if (S.modal) { S.modal.erro = "não consegui ler a imagem"; pintarModal(); } };
    leitor.readAsDataURL(arq);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.modal) fechar(); });
  document.addEventListener("integrar-atos", pintar);

  window.WorkspaceIntegracoes = {
    montar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.dados && !S.carregando) carregar();
    },
  };
})();
