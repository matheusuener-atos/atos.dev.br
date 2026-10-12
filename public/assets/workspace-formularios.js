/* Atos Workspace > Formularios (/workspace/formularios): o formulario de contato de um site, entregue no destino do e-mail
   Atos do dono. O servidor e worker/formularios.js (a mesma porta das Integracoes: Workspace ativo, e-mail Atos
   confirmado, login por ele; sem isso, 403 com o codigo, e a workspace.js mostra o passo que falta).

     GET  /api/workspace/formularios                 os formularios, os limites e o que esta ligado contra spam
     GET  /api/workspace/formularios/:id/registro    o registro (30 dias, sem o conteudo)
     POST /api/workspace/formularios                 criar
     POST /api/workspace/formularios/:id             {acao: editar|ligar|desligar|apagar}

   A workspace.js desenha o titulo e as guias e chama WorkspaceFormularios.montar(raiz) a cada desenho. Usa as pecas de
   integrar.css (ig-*). Os atributos sao data-fm*. */
(function () {
  "use strict";
  var S = { raiz: null, dados: null, erro: "", carregando: false, aviso: "", modal: null, registro: {}, aberto: "", exemplo: "" };
  var VOLTA_ENTRAR = "/workspace/entrar/?modo=entrar&volta=" + encodeURIComponent("/workspace/formularios");
  var NOMES = { nome: "Nome", email: "E-mail", assunto: "Assunto", mensagem: "Mensagem" };
  var RESULTADOS = { entregue: "entregue", recusado: "recusado", falhou: "falhou", armadilha: "armadilha (nada saiu)" };
  var MOTIVOS = {
    origem: "site não cadastrado", campos: "campos inválidos", tamanho: "grande demais", formato: "formato desconhecido", limite_ip: "limite por endereço",
    limite_dia: "limite do dia", limite_atos: "limite da Atos", desligado: "formulário desligado", desligado_pela_atos: "desligado pela Atos",
    sem_workspace: "Workspace desativado", workspace_suspenso: "Workspace suspenso", sem_alias: "sem e-mail Atos", alias_suspenso: "e-mail Atos suspenso",
    alias_nao_confirmado: "destino não confirmado", alias_desligado: "encaminhamento desligado", envio: "o e-mail não saiu", workspace_fora: "a Atos não respondeu",
    verificacao: "verificação não passou", verificacao_json: "JSON com verificação ligada", bilhete: "bilhete inválido",
  };

  if (!document.querySelector('link[href="/assets/integrar.css"]')) {
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = "/assets/integrar.css";
    document.head.appendChild(l);
  }

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
  function form(id) { return ((S.dados || {}).formularios || []).filter(function (f) { return f.id === id; })[0] || null; }
  function endereco(f) { return location.origin + "/f/" + f.id; }

  function carregar() {
    S.carregando = true;
    api("/api/workspace/formularios").then(function (d) {
      S.carregando = false;
      if (d._status === 401) { location.replace("/workspace/entrar/?volta=" + encodeURIComponent("/workspace/formularios")); return; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; document.dispatchEvent(new CustomEvent("workspace-inativo")); return; }
      if (d.erro || !d.formularios) { S.erro = d.erro || "não deu para carregar os formulários agora"; pintar(); return; }
      S.erro = ""; S.dados = d; pintar();
    });
  }
  function mudar(caminho, corpo) {
    return api(caminho, corpo).then(function (d) {
      if (d._status === 401 && d.reentrar) { S.dados.recente = false; pintar(); return d; }
      if (d._status === 403 && (d.workspace === false || d.codigo)) { S.dados = null; fechar(); document.dispatchEvent(new CustomEvent("workspace-inativo")); return d; }
      if (d.erro) return d;
      if (d.formularios) S.dados = d;
      pintar();
      return d;
    });
  }
  function lerRegistro(id) {
    S.registro[id] = null;
    api("/api/workspace/formularios/" + id + "/registro").then(function (d) { S.registro[id] = d; pintar(); });
  }

  // ------------------------------------------------------------ a tela

  function situacao(f) {
    if (f.bloqueado) return '<span class="ig-sit perigo">desligado pela Atos</span>';
    if (!f.ativo) return '<span class="ig-sit">desligado</span>';
    return '<span class="ig-sit ok">recebendo</span>';
  }

  /* O HTML pronto para copiar: os campos do formulario, a armadilha escondida e o endereco. */
  function exemploHtml(f) {
    var linhas = ['<form action="' + endereco(f) + '" method="post">'];
    f.campos.forEach(function (c) {
      if (c === "mensagem") linhas.push('  <label>Mensagem <textarea name="mensagem" required></textarea></label>');
      else if (c === "email") linhas.push('  <label>E-mail <input name="email" type="email" required></label>');
      else linhas.push("  <label>" + NOMES[c] + ' <input name="' + c + '"></label>');
    });
    f.livres.forEach(function (c) { linhas.push("  <label>" + c + ' <input name="' + c + '"></label>'); });
    linhas.push("  <!-- A armadilha contra robôs: fica escondida e vazia. Quem a preenche recebe o “obrigado” e nada sai. -->");
    linhas.push('  <div style="position:absolute;left:-10000px" aria-hidden="true"><input name="_armadilha" tabindex="-1" autocomplete="off"></div>');
    linhas.push('  <button type="submit">Enviar</button>');
    linhas.push("</form>");
    return linhas.join("\n");
  }
  function exemploFetch(f) {
    var corpo = f.campos.concat(f.livres).map(function (c) { return c + ": form." + c + ".value"; }).join(", ");
    return "// Por fetch (o site em " + (f.origens[0] || "https://seu-site") + "): o CORS só libera os sites cadastrados.\n" +
      "const r = await fetch(\"" + endereco(f) + "\", {\n  method: \"POST\",\n  headers: { \"content-type\": \"application/json\", accept: \"application/json\" },\n" +
      "  body: JSON.stringify({ " + corpo + ", _armadilha: form._armadilha.value }),\n});\n" +
      "const d = await r.json(); // {ok: true} ou {ok: false, erro, codigo}" +
      (f.turnstile ? "\n// Este formulário pede a verificação contra robôs: o envio por fetch é recusado (codigo \"verificacao\"). Use o HTML acima." : "");
  }

  function registroDe(f) {
    var R = S.registro[f.id];
    if (R === undefined) return "";
    if (R === null) return '<p class="dica">Carregando o registro…</p>';
    if (R.erro) return '<p class="erro">' + esc(R.erro) + "</p>";
    var l = R.registro || [];
    return '<div class="ig-bloco"><h3 class="titulo-secao">Registro (' + R.retencao_dias + " dias; sem o conteúdo)</h3>" +
      '<p class="dica">Hoje: ' + R.hoje + " de " + f.limite_dia + " envios." + (R.nao_registrados_hoje ? " " + R.nao_registrados_hoje + " envios recusados hoje não entraram no registro (passou de 500 linhas no dia)." : "") + "</p>" +
      (l.length ? '<ul class="fm-registro">' + l.map(function (x) {
        return "<li><span>" + esc(quando(x.quando)) + "</span> " + esc(RESULTADOS[x.resultado] || x.resultado) + (x.motivo ? " (" + esc(MOTIVOS[x.motivo] || x.motivo) + ")" : "") +
          (x.origem ? " · " + esc(x.origem) : "") + (x.tamanho ? " · " + Math.max(1, Math.round(x.tamanho / 1024)) + " KB" : "") + "</li>";
      }).join("") + "</ul>" : '<p class="vazio">Nenhum envio ainda.</p>') + "</div>";
  }

  function cartao(f) {
    var D = S.dados;
    var h = '<div class="card ig-app"><div class="item"><span class="logo inicial" aria-hidden="true">F</span><span class="nome"><strong>' + esc(f.nome) + " " + situacao(f) + "</strong>" +
      "<small><code>" + esc(endereco(f)) + "</code></small><small>Criado em " + esc(quando(f.criado)) + (f.mudado ? " · mudado em " + esc(quando(f.mudado)) : "") + "</small></span>" +
      '<span class="ig-acoes"><button type="button" class="btn mini" data-fm="editar" data-id="' + esc(f.id) + '">Editar</button>' +
      (f.bloqueado ? "" : '<button type="button" class="btn mini" data-fm="' + (f.ativo ? "desligar" : "ligar") + '" data-id="' + esc(f.id) + '">' + (f.ativo ? "Desligar" : "Ligar") + "</button>") +
      '<button type="button" class="btn mini perigo" data-fm="apagar" data-id="' + esc(f.id) + '">Apagar</button></span></div>';
    if (f.fora_do_plano) h += '<p class="ig-aviso">Fora do plano: este formulário passa do limite do seu plano (' + D.limites.formularios + (D.limites.formularios === 1 ? " formulário" : " formulários") + '). Ele não entrega nada (quem envia vê que não está recebendo mensagens) até você voltar ao Pro ou apagar outro. Nada foi apagado. <a href="/workspace/plano">Conhecer o Pro</a></p>';
    if (f.pagina) h += '<p class="dica ig-bloco">Está na página de links <a href="/@' + esc(f.pagina) + '">atos.dev.br/@' + esc(f.pagina) + '</a> (a Atos aceita o envio que vem de lá).</p>';
    if (f.bloqueado) h += '<p class="ig-aviso">A Atos desligou este formulário em ' + esc(quando(f.bloqueado.quando)) + (f.bloqueado.motivo ? ": " + esc(f.bloqueado.motivo) : "") + ". Nada é entregue enquanto estiver assim. Para conversar, escreva para contato@atos.dev.br.</p>";
    h += '<div class="ig-bloco"><dl class="ig-info">' +
      "<dt>Sites</dt><dd>" + f.origens.map(esc).join("<br>") + "</dd>" +
      "<dt>Campos</dt><dd>" + f.campos.map(function (c) { return NOMES[c]; }).concat(f.livres).map(esc).join(", ") + "</dd>" +
      "<dt>Depois de enviar</dt><dd>" + (f.redirecionar ? "vai para " + esc(f.redirecionar) : "a página de “obrigado” da Atos") + "</dd>" +
      "<dt>Contra robôs</dt><dd>armadilha, " + D.limites.por_ip_hora + " por hora do mesmo endereço, " + esc(String(f.limite_dia)) + " por dia" + (f.turnstile ? ", verificação Turnstile na página da Atos" : "") + "</dd>" +
      "<dt>Entrega</dt><dd>no destino de " + esc(D.email_atos) + " (o e-mail Atos ligado e confirmado)</dd></dl>" +
      '<div class="ig-acoes"><button type="button" class="btn mini" data-fm="exemplo" data-id="' + esc(f.id) + '" aria-expanded="' + (S.exemplo === f.id) + '">Exemplo de HTML</button>' +
      '<button type="button" class="btn mini" data-fm="registro" data-id="' + esc(f.id) + '" aria-expanded="' + (S.aberto === f.id) + '">Registro</button></div></div>';
    if (S.exemplo === f.id) {
      h += '<div class="ig-bloco"><h3 class="titulo-secao">Cole no seu site</h3><pre class="ig-pre" data-fm-pre="html">' + esc(exemploHtml(f)) + "</pre>" +
        '<div class="ig-acoes"><button type="button" class="btn mini" data-fm="copiar" data-qual="html" data-id="' + esc(f.id) + '">Copiar o HTML</button></div>' +
        '<pre class="ig-pre" data-fm-pre="fetch">' + esc(exemploFetch(f)) + "</pre>" +
        '<div class="ig-acoes"><button type="button" class="btn mini" data-fm="copiar" data-qual="fetch" data-id="' + esc(f.id) + '">Copiar o fetch</button></div>' +
        '<p class="dica">Os nomes dos campos (name) têm de ser estes; outros são ignorados. Arquivos não são aceitos. A página que tem o formulário precisa estar num dos sites cadastrados: a Atos confere a origem de cada envio.</p></div>';
    }
    if (S.aberto === f.id) h += registroDe(f);
    return h + "</div>";
  }

  function tela() {
    if (!S.dados) return '<div class="card"><p class="vazio">' + (S.erro ? esc(S.erro) + ' <button type="button" class="link" data-fm="recarregar">Tentar de novo</button>' : "Carregando…") + "</p></div>";
    var D = S.dados, h = "";
    if (S.erro) h += '<p class="erro" role="alert">' + esc(S.erro) + "</p>";
    if (!D.recente) h += '<p class="ig-aviso">Para criar ou mudar formulários, o login precisa ser das últimas ' + D.limites.recente_h + ' horas. <a href="' + VOLTA_ENTRAR + '">Entrar de novo</a></p>';
    if (S.aviso) h += '<p class="ok ig-ok">' + esc(S.aviso) + "</p>";
    h += '<h2 class="titulo-secao ig-h"><span>Seus formulários (' + D.formularios.length + " de " + D.limites.formularios + ")</span>" +
      (D.formularios.length < D.limites.formularios ? '<button type="button" class="btn p primario" data-fm="novo">Novo formulário</button>' : D.plano && !D.plano.pro ? '<a class="btn p" href="/workspace/plano">Conhecer o Pro</a>' : "") + "</h2>";
    if (!D.formularios.length) h += '<div class="card"><p class="vazio">Nenhum formulário. Crie um para ter o endereço que o seu site usa no &lt;form action&gt;.</p></div>';
    else h += D.formularios.map(cartao).join("");
    h += '<p class="nota">Cada envio vira um e-mail da Atos (naoresponda@atos.dev.br) no destino confirmado de ' + esc(D.email_atos) + "; responder vai ao e-mail que a pessoa digitou. " +
      "A Atos não guarda o que foi preenchido: o registro tem só quando, o site, o resultado e o tamanho, por " + D.limites.registro_dias + " dias. " +
      "Com o e-mail Atos desligado, suspenso ou sem destino confirmado, ou com o Workspace desativado, os envios são recusados. " +
      "Contra robôs, sempre: o site precisa estar cadastrado, o campo-armadilha, " + D.limites.por_ip_hora + " envios por hora do mesmo endereço de internet e o limite por dia de cada formulário. " +
      "No plano " + (D.plano && D.plano.pro ? "Pro" : "gratuito") + ": até " + D.limites.formularios + (D.limites.formularios === 1 ? " formulário" : " formulários") + " e " + D.limites.conta_dia.toLocaleString("pt-BR") + " envios por dia, somando todos (e o teto diário da Atos inteira vale por cima). " +
      (D.turnstile.disponivel ? "A verificação do Cloudflare Turnstile pode ser ligada em cada formulário: ela acontece numa página da Atos, antes da entrega." : "A verificação do Cloudflare Turnstile ainda não está ligada na Atos: valem a armadilha e os limites.") +
      ' Veja os <a href="/termos/#workspace-formularios">termos</a> e a <a href="/privacidade/">política de privacidade</a>.</p>';
    return h;
  }
  function pintar() { if (S.raiz && document.body.contains(S.raiz)) S.raiz.innerHTML = tela(); }

  // ------------------------------------------------------------ o pop-up de criar e editar

  function camada() {
    var c = document.getElementById("fm-camada");
    if (!c) { c = document.createElement("div"); c.id = "fm-camada"; document.body.appendChild(c); }
    return c;
  }
  function pintarModal() {
    var c = camada();
    if (!S.modal) { c.innerHTML = ""; return; }
    c.innerHTML = '<div class="fundo-modal ig-fundo" data-fm-fundo><div class="modal ig-modal" role="dialog" aria-modal="true" aria-labelledby="fm-modal-titulo">' + S.modal.html() + "</div></div>";
    if (!S.modal.focado) { S.modal.focado = true; var a = c.querySelector("input, textarea, button"); if (a) a.focus(); }
  }
  function abrir(M) { S.modal = M; pintarModal(); }
  function fechar() { S.modal = null; pintarModal(); }
  function pe(rotulo, perigo) {
    var M = S.modal;
    return (M.erro ? '<p class="erro" role="alert">' + esc(M.erro) + "</p>" : "") +
      '<div class="botoes"><button type="button" class="btn p" data-fm="fechar">Cancelar</button>' +
      '<button type="button" class="btn p ' + (perigo ? "perigo" : "primario") + '" data-fm="ok"' + (M.enviando ? " disabled" : "") + ">" + esc(M.enviando ? "Um momento…" : rotulo) + "</button></div>";
  }
  function modalForm() {
    var M = S.modal, v = M.v, D = S.dados;
    var marcas = D.campos_padrao.map(function (c) {
      return '<label class="ig-marcar"><input type="checkbox" data-fm-campo="' + c + '"' + (v.campos.indexOf(c) >= 0 ? " checked" : "") + "><span>" + NOMES[c] + (c === "email" ? " (vira o Responder do e-mail)" : "") + "</span></label>";
    }).join("");
    return '<h2 id="fm-modal-titulo">' + (M.id ? "Editar " + esc(v.nome) : "Novo formulário") + "</h2>" +
      '<label class="campo"><span class="rotulo">Nome (aparece no assunto do e-mail)</span><input data-fm-in="nome" maxlength="60" value="' + esc(v.nome) + '" autocomplete="off"></label>' +
      '<label class="campo"><span class="rotulo">Sites de onde ele é enviado (um por linha, até ' + D.limites.origens + ')</span><textarea data-fm-in="origens" rows="2" spellcheck="false" placeholder="https://exemplo.com.br">' + esc(v.origens) + "</textarea>" +
      '<span class="dica">Só a origem: https:// e o domínio (http:// só em localhost e 127.0.0.1, para testar). Envios de outros sites são recusados.</span></label>' +
      '<div class="campo"><span class="rotulo">Campos aceitos</span>' + marcas + "</div>" +
      '<label class="campo"><span class="rotulo">Campos livres (opcional, até ' + D.limites.livres + ', separados por vírgula)</span><input data-fm-in="livres" value="' + esc(v.livres) + '" placeholder="telefone, empresa" autocomplete="off" spellcheck="false"></label>' +
      '<label class="campo"><span class="rotulo">Depois de enviar, ir para (opcional, https, num dos sites acima)</span><input data-fm-in="redirecionar" value="' + esc(v.redirecionar) + '" placeholder="https://exemplo.com.br/obrigado" autocomplete="off" spellcheck="false">' +
      '<span class="dica">Vazio: a página de “obrigado” da Atos, com o botão de voltar ao site.</span></label>' +
      '<label class="campo"><span class="rotulo">Limite de envios por dia (1 a ' + D.limites.dia_max + ')</span><input data-fm-in="limite_dia" type="number" min="1" max="' + D.limites.dia_max + '" value="' + esc(v.limite_dia) + '"></label>' +
      (D.turnstile.disponivel ? '<label class="ig-marcar"><input type="checkbox" data-fm-in="turnstile"' + (v.turnstile ? " checked" : "") + "><span>Pedir a verificação contra robôs (Cloudflare Turnstile) numa página da Atos antes de entregar. Com ela, o envio por fetch/JSON é recusado.</span></label>"
        : '<p class="dica">A verificação do Cloudflare Turnstile ainda não está ligada na Atos: valem o campo-armadilha e os limites.</p>') +
      pe(M.id ? "Salvar" : "Criar");
  }
  function modalApagar() {
    var f = form(S.modal.id) || { nome: "" };
    return '<h2 id="fm-modal-titulo">Apagar ' + esc(f.nome) + "</h2><p>O endereço para de receber na hora (os envios passam a ver “formulário não encontrado”) e o registro dele é apagado. Não tem volta: para usar de novo, crie outro (com outro endereço).</p>" + pe("Apagar", true);
  }
  function enviarModal() {
    var M = S.modal;
    if (!M || M.enviando) return;
    var caminho, corpo;
    if (M.html === modalForm) {
      var v = M.v;
      corpo = { nome: v.nome, origens: String(v.origens).split(/\s+/).filter(Boolean), campos: v.campos, livres: String(v.livres).split(/[\s,]+/).filter(Boolean),
        redirecionar: v.redirecionar, limite_dia: Number(v.limite_dia), turnstile: Boolean(v.turnstile) };
      if (M.id) { caminho = "/api/workspace/formularios/" + M.id; corpo.acao = "editar"; } else caminho = "/api/workspace/formularios";
    } else { caminho = "/api/workspace/formularios/" + M.id; corpo = { acao: "apagar", confirmar: true }; }
    M.enviando = true; M.erro = ""; pintarModal();
    mudar(caminho, corpo).then(function (d) {
      if (S.modal !== M) return;
      M.enviando = false;
      if (d._status === 401 && d.reentrar) { fechar(); return; }
      if (d.erro) { M.erro = d.erro; pintarModal(); return; }
      if (d.criado) { S.aviso = "Formulário criado. Use “Exemplo de HTML” para colar no seu site."; S.exemplo = d.criado; pintar(); }
      fechar();
    });
  }

  document.addEventListener("click", function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute("data-fm-fundo")) { fechar(); return; }
    var b = e.target.closest && e.target.closest("[data-fm]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-fm"), id = b.getAttribute("data-id");
    if (a === "recarregar") { S.erro = ""; pintar(); carregar(); return; }
    if (a === "fechar") { fechar(); return; }
    if (a === "ok") { enviarModal(); return; }
    if (a === "novo") { S.aviso = ""; abrir({ html: modalForm, v: { nome: "", origens: "", campos: ["nome", "email", "mensagem"], livres: "", redirecionar: "", limite_dia: S.dados.limites.dia_padrao, turnstile: S.dados.turnstile.disponivel }, erro: "" }); return; }
    if (a === "editar") {
      var f = form(id); if (!f) return;
      abrir({ html: modalForm, id: id, v: { nome: f.nome, origens: f.origens.join("\n"), campos: f.campos.slice(), livres: f.livres.join(", "), redirecionar: f.redirecionar, limite_dia: f.limite_dia, turnstile: f.turnstile }, erro: "" });
      return;
    }
    if (a === "apagar") { abrir({ html: modalApagar, id: id, erro: "" }); return; }
    if (a === "ligar" || a === "desligar") {
      b.disabled = true;
      mudar("/api/workspace/formularios/" + id, { acao: a }).then(function (d) { if (d.erro) { S.erro = d.erro; pintar(); } });
      return;
    }
    if (a === "exemplo") { S.exemplo = S.exemplo === id ? "" : id; pintar(); return; }
    if (a === "registro") { if (S.aberto === id) S.aberto = ""; else { S.aberto = id; lerRegistro(id); } pintar(); return; }
    if (a === "copiar") {
      var x = form(id); if (!x) return;
      var texto = b.getAttribute("data-qual") === "fetch" ? exemploFetch(x) : exemploHtml(x);
      var feito = function (ok) { b.textContent = ok ? "Copiado" : "Selecione e copie"; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(function () { feito(true); }, function () { feito(false); });
      else feito(false);
    }
  });
  document.addEventListener("input", function (e) {
    var el = e.target.closest && e.target.closest("[data-fm-in]");
    if (!el || !S.modal || !S.modal.v) return;
    S.modal.v[el.getAttribute("data-fm-in")] = el.type === "checkbox" ? el.checked : el.value;
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.getAttribute || !S.modal || !S.modal.v) return;
    if (el.getAttribute("data-fm-in") === "turnstile") { S.modal.v.turnstile = el.checked; return; }
    var c = el.getAttribute("data-fm-campo");
    if (!c) return;
    var l = S.modal.v.campos.filter(function (x) { return x !== c; });
    if (el.checked) l.push(c);
    S.modal.v.campos = S.dados.campos_padrao.filter(function (x) { return l.indexOf(x) >= 0; });
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.modal) fechar(); });

  window.WorkspaceFormularios = {
    montar: function (raiz) {
      S.raiz = raiz;
      pintar();
      if (!S.dados && !S.carregando) carregar();
    },
  };
})();
