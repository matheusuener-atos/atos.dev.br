/* O painel da Atos, as secoes do PAVLVS: Visao geral, Contas e cadastros, Permissoes Google, Tuneis Cloudflare,
   Nao renovacoes, Tokens e custos, Planos e Disparo de e-mails, mais a busca (Ctrl K). Porte das telas do painel do
   PAVLVS (site/assets/admin.js do coryphaeus) sobre o mesmo contrato (worker/admin-api.md do coryphaeus), sob o
   prefixo /api/admin/pavlvs/ (GET /api/admin/contas -> GET /api/admin/pavlvs/contas). Tudo o que aparece vem da
   API; nada de dado inventado.

   O que muda o que esta no ar vai para a fila (AdminAtos.fila, assets/admin-fila.js) e so acontece em "Commitar e
   pushar"; o que e comunicacao ou marcacao (avisar o responsavel, lembrete, mensagem, tratada, os avisos, o e-mail
   de teste) vale na hora. A CSP do /admin e script-src 'self'; style-src 'self': nada de estilo nem evento no HTML;
   as barras e o grafico sao SVG com atributos, as cores sao classes. */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var P = "/api/admin/pavlvs/";
  var esc = A.esc, U = A.util;
  var norm = U.norm, pad = U.pad, primeiro = U.primeiro, dt = U.dt, ddmm = U.ddmm, ddmmaaaa = U.ddmmaaaa, quando = U.quando, rel = U.rel,
    dec = U.dec, brl = U.brl, usd = U.usd, tok = U.tok, pct = U.pct, hm = U.hm;
  function num(v) { var s = String(v == null ? "" : v).trim(); if (/,/.test(s)) s = s.replace(/\./g, "").replace(",", "."); var n = Number(s); return isFinite(n) ? n : 0; }
  function cambioTxt(c) { return Number(c || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function taxa(v) { v = Number(v) || 0; return Math.round(v > 1 ? v : v * 100) + "%"; }
  function isoDia(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function plural(n, um, varios) { return n + " " + (n === 1 ? um : varios); }

  /* ================================================================ estado */

  var TELAS = [
    { id: "visao", nome: "Visão geral", o: "a visão geral", ler: ["visao"] },
    { id: "contas", nome: "Contas e cadastros", o: "as contas", ler: ["contas"] },
    { id: "google", nome: "Permissões Google", o: "as contas com Google", ler: ["contas"] },
    { id: "tuneis", nome: "Túneis Cloudflare", o: "os túneis", ler: ["tuneis"] },
    { id: "renovacoes", nome: "Não renovações", o: "as não renovações", ler: ["renovacoes"] },
    { id: "tokens", nome: "Tokens e custos", o: "os tokens e custos", ler: [] },
    { id: "planos", nome: "Planos", o: "os planos", ler: ["planos", "tokens:geral:mes"] },
    { id: "emails", nome: "Disparo de e-mails", o: "as campanhas", ler: ["campanhas"] },
  ];
  var TELA = {}; TELAS.forEach(function (t) { TELA[t.id] = t; });

  var D = {}; // as leituras: D[chave] = {dados, erro, carregando, promessa}
  var R = { raiz: null, secao: "", abrindoConta: false };
  var UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];
  function novaCamp() { return { publico: "", nome: "", assunto: "", pre: "", titulo: "", texto: "", botao: "Abrir o Paulus", link: "https://paulus.ia.br/", quando: "agora", de: "", hora: "09:00" }; }
  var Q = {
    visao: { todas: false },
    contas: { filtro: "todas", agrupar: "conta", q: "", aberta: null, det: null, erro: "", aba: "resumo", cad: null, google: null, ext: { tipo: "todos", periodo: "tudo", de: "", ate: "" } },
    google: { confirmando: null, sel: null },
    tuneis: { filtro: "todos", aberto: null, sel: null, reg: "todos", regQ: "", de: "", ate: "", regTodos: false },
    renovacoes: { aberto: null, sel: null, msg: {}, erro: {} },
    tokens: { visao: "geral", periodo: "mes", de: "", ate: "", sel: null },
    planos: { aba: null, lado: "resumo", ed: null, json: null, versao: null },
    emails: { aba: "campanhas", passo: 1, camp: novaCamp(), escolhidas: [], outroLink: false, erros: {} },
  };
  var MP = null; // o pop-up desta secao (google, endereco, campCancelar, escContas, tunelHist, busca)

  function fila() { return A.fila; }
  /* Os tipos que estas telas poem na fila do PAVLVS (a fila e escolhida pelo prefixo; admin-fila.js nao conhece o
     PAVLVS) e o papel que pode cada um: o PODE de worker/admin.js do coryphaeus (conta.creditar, conta.cadastro,
     conta.instalacao.apagar, google.servicos, google.desvincular, tunel.apagar, tunel.endereco, tunel.ativo,
     plano.editar, plano.criar, planos.json, campanha.disparar, campanha.cancelar). Tipo novo do PAVLVS com outro
     prefixo: acrescentar aqui, senao a fila recusa com o erro na tela. */
  var DF = ["dono", "financeiro"], DS = ["dono", "suporte"];
  if (fila()) fila().tiposDo("pavlvs", ["conta.", "google.", "tunel.", "plano.", "planos.", "campanha."], {
    "conta.creditar": DF, "conta.instalacao.apagar": DS, "google.servicos": DS, "google.desvincular": DS,
    "tunel.apagar": DS, "tunel.endereco": DS, "tunel.ativo": DS, "plano.editar": DF, "plano.criar": DF, "planos.json": DF,
  });
  function pode(tipo) { return fila() ? fila().pode(tipo) : false; }
  function naFila(tipo, alvo) { return Boolean(fila() && fila().naFila(tipo, alvo)); }
  function enfileirar(tela, tipo, alvo, dados, texto, quieto) {
    if (!fila()) { A.toast("a fila de alterações não carregou", true); return Promise.resolve(false); }
    return fila().enfileirar(tela, tipo, alvo, dados, texto, quieto);
  }
  // A configuracao (GET sessao do contrato: config.email, config.tuneis, config.nuvem...): sem ela, vale ligada.
  function cfg(nome) { var s = dadosDe("sessao"), c = s && s.config && s.config[nome]; return c || { ligado: true, falta: "" }; }
  function desligado(c) { return Boolean(c && c.ligado === false); }

  /* ================================================================ leitura */

  function caminhoDe(ch) {
    if (ch.indexOf("tokens:") === 0) {
      var p = ch.split(":");
      return P + "tokens?visao=" + p[1] + "&periodo=" + (p[2] === "custom" ? "custom&de=" + p[3] + "&ate=" + p[4] : p[2]);
    }
    return P + ch;
  }
  function ler(ch, calado) {
    var r = D[ch] || (D[ch] = {});
    if (r.promessa) return r.promessa;
    r.carregando = true;
    r.promessa = A.pedir("GET", caminhoDe(ch)).then(function (d) { r.dados = d; r.erro = null; },
      function (e) { if (e.status !== 401 && !calado) r.erro = e.message; if (calado) r.dados = r.dados || null; })
      .then(function () { r.carregando = false; r.promessa = null; render(); });
    return r.promessa;
  }
  function dadosDe(ch) { return D[ch] && D[ch].dados; }
  function tokensChave() { var T = Q.tokens; return "tokens:" + T.visao + ":" + T.periodo + (T.periodo === "custom" ? ":" + T.de + ":" + T.ate : ""); }
  function leiturasDa(t) {
    if (t !== "tokens") return TELA[t].ler;
    var T = Q.tokens;
    return T.periodo === "custom" && !(T.de && T.ate && T.de <= T.ate) ? [] : [tokensChave()];
  }
  function estadoLeitura(chaves, t) {
    for (var i = 0; i < chaves.length; i++) {
      var r = D[chaves[i]];
      if (r && r.erro && !r.dados) return '<p class="nf-aviso"><span>Não consegui ler ' + esc(TELA[t].o) + " agora: " + esc(r.erro) + '</span><button type="button" class="link" data-pv="reler">Tentar de novo</button></p>';
    }
    for (var j = 0; j < chaves.length; j++) { var q = D[chaves[j]]; if (!q || !q.dados) return '<div class="card pv-topo"><p class="vazio">Carregando…</p></div>'; }
    return "";
  }
  function erroRecente(ch, t) {
    var r = D[ch];
    return r && r.erro && r.dados ? '<p class="nf-aviso"><span>Não consegui atualizar ' + esc(TELA[t].o) + " agora: " + esc(r.erro) + ". Mostrando a última leitura.</span></p>" : "";
  }

  /* ================================================================ desenho */

  function pintar(el, html) {
    var a = document.activeElement, id = a && a.id && el.contains(a) ? a.id : null, s = null, f = null;
    if (id && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) { try { s = a.selectionStart; f = a.selectionEnd; } catch (x) { s = null; } }
    el.innerHTML = html;
    if (id) {
      var n = document.getElementById(id);
      if (n && el.contains(n)) { n.focus({ preventScroll: true }); if (s != null) { try { n.setSelectionRange(s, f); } catch (x) { /* sem selecao */ } } }
    }
  }
  function render() {
    if (R.raiz && TELA[R.secao] && A.secaoAtual() === R.secao && document.body.contains(R.raiz)) pintar(R.raiz, TELAS_RENDER[R.secao]());
    A.atualizarNav();
    if (MP) A.modal.repintar();
  }

  function cab(titulo, lead) { return "<h1>" + esc(titulo) + "</h1>" + (lead ? '<p class="descricao">' + lead + "</p>" : ""); }
  function falta(c) { return c && c.ligado === false ? '<p class="nf-aviso"><span>' + esc(c.falta || "não configurado") + "</span></p>" : ""; }
  function opcoes(nome, ops, ativo, travado, rotulo) {
    return '<div class="opcoes" role="group"' + (rotulo ? ' aria-label="' + esc(rotulo) + '"' : "") + ">" + ops.map(function (o) {
      return '<button type="button" data-pv="seg" data-seg="' + esc(nome) + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (o[0] === ativo) + '"' + (travado ? " disabled" : "") + ">" + esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }
  function guias(nome, ops, ativo, rotulo) {
    return '<nav class="guias pv-guias" aria-label="' + esc(rotulo || "Partes") + '">' + ops.map(function (o) {
      return '<button type="button" data-pv="seg" data-seg="' + esc(nome) + '" data-v="' + esc(o[0]) + '"' + (o[0] === ativo ? ' aria-current="page"' : "") + ">" + esc(o[1]) + "</button>";
    }).join("") + "</nav>";
  }
  function sit(texto, tom) { return '<span class="pv-sit ' + (tom || "mudo") + '">' + esc(texto) + "</span>"; }
  function h2(t, dir) { return '<h2 class="titulo-secao pv-h2"><span>' + t + "</span>" + (dir || "") + "</h2>"; }
  function cardCab(t, dir) { return '<div class="pv-card-cab"><span class="titulo-secao">' + t + "</span>" + (dir != null ? "<span>" + dir + "</span>" : "") + "</div>"; }
  function tabela(cls, cabeca, linhas) { return '<div class="card pv-tabela"><div><div class="pv-tr pv-th ' + cls + '">' + cabeca + "</div>" + linhas + "</div></div>"; }
  function fato(k, v) { return "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>"; }
  function fatoH(k, v) { return "<dt>" + esc(k) + "</dt><dd>" + v + "</dd>"; }
  function dis(cond, titulo) { return cond ? ' disabled title="' + esc(titulo || "") + '"' : ""; }
  function vazio(t) { return '<p class="vazio">' + t + "</p>"; }
  /* Uma barra de 0 a 100 (SVG: largura por atributo, sem estilo no HTML). */
  function barra(p) {
    p = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
    return '<svg class="pv-barra" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="fundo" width="100" height="4"></rect><rect class="cheio" width="' + p + '" height="4"></rect></svg>';
  }
  function interruptor(attrs, on, titulo, sub, travado) {
    return '<button type="button" class="nf-chave" role="switch" aria-checked="' + Boolean(on) + '" ' + attrs + (travado ? ' disabled title="' + esc(travado) + '"' : "") + '><span class="nome"><strong>' + esc(titulo) + "</strong><small>" + sub + '</small></span><span class="nf-interruptor" aria-hidden="true"></span></button>';
  }
  /* A barra de selecao (marcar varias linhas): "Selecionar" liga, e cada linha ganha a caixinha. */
  function caixa(tela, id, marcada) { return '<button type="button" class="pv-caixa" role="checkbox" aria-checked="' + Boolean(marcada) + '" data-pv="marcar" data-tela="' + tela + '" data-id="' + esc(id) + '" aria-label="Selecionar"></button>'; }
  function selIds(S) { return S ? Object.keys(S).filter(function (k) { return S[k]; }) : []; }
  function baixar(nome, texto, tipo) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([texto], { type: tipo || "application/json" }));
    a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  var SIT_CONTA = { ativa: ["ativa", "ok"], vencida: ["vencida", "perigo"], cortesia: ["cortesia", "neutro"], pendente: ["pendente", "atencao"], cancelada: ["cancelada", "mudo"] };
  function sitConta(s) { return SIT_CONTA[s] || [s || "—", "mudo"]; }
  var ESCOPOS = [["mail.google.com", "Gmail"], ["calendar.events", "Agenda e Meet"], ["drive.file", "Drive · enviar"], ["drive.readonly", "Drive · ler"]];
  var SERV_G = [["mail.google.com", "Gmail", "ler e enviar, com Aprovações"], ["calendar.events", "Agenda e Meet", "criar e atualizar eventos (o Meet vem junto)"],
    ["drive.file", "Drive · enviar", "só os arquivos que o Paulus envia"], ["drive.readonly", "Drive · ler", "ler as pastas escolhidas"]];

  /* ================================================================ telas */

  var TELAS_RENDER = {};

  /* ---------- Visao geral ---------- */
  TELAS_RENDER.visao = function () {
    var nome = primeiro(A.quem && A.quem.nome), hora = new Date().getHours();
    var saud = (hora >= 5 && hora < 12 ? "Bom dia" : hora >= 12 && hora < 18 ? "Boa tarde" : "Boa noite") + (nome ? ", " + nome : "") + ".";
    var hoje = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace("-feira", "");
    var est = estadoLeitura(["visao"], "visao");
    var h = "<h1>" + esc(saud) + "</h1>";
    if (est) return h + '<p class="descricao">' + esc(hoje) + "</p>" + est;
    var v = dadosDe("visao"), k = v.kpi || {};
    var receita = Number(k.receita_mes) || 0, cambio = Number(k.cambio) || 0, custoU = Number(k.custo_usd_mes) || 0, custoR = custoU * cambio;
    var margem = receita > 0 ? 1 - custoR / receita : null;
    h += '<p class="descricao">' + esc(hoje) + " · PAVLVS: " + (k.contas_ativas || 0) + " contas ativas em " + (k.escritorios || 0) + " escritórios</p>" + erroRecente("visao", "visao");
    h += '<div class="card pv-topo"><div class="colunas pv-kpis">' +
      kpi("Arrecadado no mês", brl(receita), brl(k.receita_assinaturas) + " assinaturas · " + brl(k.receita_recargas) + " recargas") +
      kpi("Custo de IA no mês", brl(custoR), "DeepInfra · " + usd(custoU) + " · câmbio " + cambioTxt(cambio)) +
      kpi("Margem", margem == null ? "—" : pct(margem), brl(receita - custoR) + " líquido", margem == null ? "" : margem >= 0 ? "ok" : "perigo") +
      kpi("Tokens no mês", tok((k.entrada_mes || 0) + (k.saida_mes || 0)), tok(k.entrada_mes) + " entrada · " + tok(k.saida_mes) + " saída") + "</div></div>";

    var pend = v.pendencias || [], ver = Q.visao.todas ? pend : pend.slice(0, 4);
    var hp = '<div class="card">' + cardCab("Precisa de você", '<span class="' + (pend.length ? "pv-perigo" : "pv-mudo") + '">' + plural(pend.length, "item", "itens") + "</span>") +
      (pend.length ? ver.map(function (p) {
        var t = TELA[p.tela] ? p.tela : null;
        var dentro = '<span class="nome"><strong>' + esc(p.titulo) + "</strong><small>" + esc(p.sub) + "</small></span>";
        return t ? '<button type="button" class="item pv-item-btn" data-pv="irTela" data-tela="' + esc(t) + '" data-filtro="' + esc(p.filtro || "") + '">' + dentro + '<span class="seta">›</span></button>'
          : '<div class="item">' + dentro + "</div>";
      }).join("") : vazio("Nada precisa de você agora.")) +
      (pend.length > 4 ? '<div class="botoes"><button type="button" class="link" data-pv="visaoMais">' + (Q.visao.todas ? "Ver menos" : "Ver os " + pend.length) + "</button></div>" : "") + "</div>";

    var dias = v.dias || [], max = dias.reduce(function (m, d) { return Math.max(m, Number(d.total) || 0); }, 0) || 1;
    var TURNO = ["manhã", "tarde", "noite"];
    var svg = '<svg class="pv-ondas" viewBox="0 0 ' + Math.max(10, dias.length * 10) + ' 100" preserveAspectRatio="none" role="img" aria-label="Tokens por turno nos últimos 14 dias">' +
      dias.map(function (d, i) {
        var t = Number(d.total) || 0, s = Number(d.saida) || 0, ht = t ? Math.max(2, Math.round(t / max * 100)) : 0, hs = Math.round(s / max * 100);
        return "<g><title>" + esc(ddmm(d.dia) + " · " + (TURNO[d.turno] || "") + " · " + tok(t) + " (" + tok(s) + " saída)") + "</title>" +
          '<rect class="t" x="' + (i * 10 + 1) + '" y="' + (100 - ht) + '" width="8" height="' + ht + '"></rect><rect class="s" x="' + (i * 10 + 1) + '" y="' + (100 - hs) + '" width="8" height="' + hs + '"></rect></g>';
      }).join("") + "</svg>";
    var somaT = 0, somaS = 0, porDia = {};
    dias.forEach(function (d) { var t = Number(d.total) || 0; somaT += t; somaS += Number(d.saida) || 0; porDia[d.dia] = (porDia[d.dia] || 0) + t; });
    var ords = Object.keys(porDia).sort(), sem = function (ds) { return ds.reduce(function (s, x) { return s + porDia[x]; }, 0); };
    var sA = sem(ords.slice(-7)), sB = sem(ords.slice(-14, -7));
    var hd = '<div class="card">' + cardCab("Tokens · últimos 14 dias", esc(tok(k.tokens_hoje)) + " hoje") + '<div class="pv-grafico">' + svg +
      '<p class="pv-legenda"><span class="t">entrada + saída</span><span class="s">saída</span></p></div>' +
      (dias.length ? '<div class="colunas pv-colunas-fim"><div><span class="rotulo">Média por dia</span><span>' + esc(tok(ords.length ? somaT / ords.length : 0)) + "</span></div>" +
        '<div><span class="rotulo">Última semana</span><span>' + esc(sB ? (sA >= sB ? "+" : "−") + pct(Math.abs(sA / sB - 1)) + " vs anterior" : "—") + "</span></div>" +
        '<div><span class="rotulo">Saída</span><span>' + esc(somaT ? pct(somaS / somaT) : "—") + "</span></div></div>" : "") + "</div>";
    return h + '<div class="pv-duas pv-topo">' + hp + hd + "</div>";
  };
  function kpi(t, v, sub, tom) { return '<div><span class="rotulo">' + esc(t) + '</span><strong class="pv-kpi' + (tom ? " pv-" + tom : "") + '">' + esc(v) + "</strong><small>" + esc(sub) + "</small></div>"; }

  /* ---------- Contas e cadastros ---------- */
  function contasFiltradas() {
    var d = dadosDe("contas"); if (!d) return [];
    var q = norm(Q.contas.q.trim()), f = Q.contas.filtro;
    return (d.contas || []).filter(function (c) {
      if (f !== "todas" && c.situacao !== f) return false;
      if (!q) return true;
      return norm([c.nome, c.email, c.escritorio && c.escritorio.nome, c.escritorio && c.escritorio.slug, c.oab].join(" ")).indexOf(q) >= 0;
    });
  }
  function contaResumo(id) { var d = dadosDe("contas"); return d ? (d.contas || []).filter(function (c) { return String(c.id) === String(id); })[0] : null; }
  TELAS_RENDER.contas = function () {
    if (Q.contas.aberta != null) return contaPagina();
    var h = cab("Contas e cadastros", "Uma linha por conta do PAVLVS. O escritório agrupa as contas que compartilham o mesmo CNPJ ou o mesmo endereço de acesso externo.");
    h += '<div class="pv-barra-filtros">' + opcoes("contas.filtro", [["todas", "Todas"], ["ativa", "Ativas"], ["vencida", "Vencidas"], ["cortesia", "Cortesias"], ["cancelada", "Canceladas"]], Q.contas.filtro, false, "Situação") +
      opcoes("contas.agrupar", [["conta", "Por conta"], ["escritorio", "Por escritório"]], Q.contas.agrupar, false, "Agrupar") +
      '<input class="seletor pv-busca-campo" id="pv-contas-q" data-pv-in="contasQ" value="' + esc(Q.contas.q) + '" placeholder="nome, e-mail, escritório, OAB ou RG" aria-label="Buscar contas" spellcheck="false"></div>';
    var est = estadoLeitura(["contas"], "contas"); if (est) return h + est;
    h += erroRecente("contas", "contas");
    var lista = contasFiltradas();
    if (Q.contas.agrupar === "conta") {
      var linhas = lista.map(function (c) {
        var s = sitConta(c.situacao);
        return '<button type="button" class="pv-tr pv-clicavel pv-c-contas" data-pv="abrirConta" data-id="' + esc(c.id) + '">' +
          '<span class="nf-cel"><strong>' + esc(c.nome) + "</strong><small>" + esc(c.email) + (c.escritorio && c.escritorio.nome ? " · " + esc(c.escritorio.nome) : "") + "</small></span>" +
          "<span>" + esc(c.plano ? c.plano.nome : "—") + "</span>" + sit(s[0], s[1]) +
          '<span class="pv-num dir">' + esc(tok(c.restantes)) + '</span><span class="pv-num dir pv-mudo">' + esc(rel(c.ultimo_uso)) + "</span></button>";
      }).join("") || vazio("Nenhuma conta com esse filtro.");
      h += tabela("pv-c-contas", '<span>Conta</span><span>Plano</span><span>Situação</span><span class="dir">Restantes</span><span class="dir">Último uso</span>', linhas) +
        '<p class="nota">' + plural(lista.length, "conta", "contas") + "</p>";
    } else {
      var ids = {}; lista.forEach(function (c) { ids[c.id] = c; });
      var escs = (dadosDe("contas").escritorios || []).map(function (e) {
        return { e: e, cs: (e.contas || []).map(function (id) { return ids[id]; }).filter(Boolean) };
      }).filter(function (x) { return x.cs.length; });
      h += escs.length ? escs.map(function (x) {
        var e = x.e;
        return '<div class="card pv-topo"><div class="pv-card-cab"><span class="nf-cel"><strong>' + esc(e.nome) + "</strong><small>" + esc(e.slug ? e.slug + ".paulus.ia.br" : "sem endereço") + (e.documento ? " · " + esc(e.documento) : "") + "</small></span>" +
          '<span class="pv-par pv-num"><span>' + plural(x.cs.length, "conta", "contas") + "</span><span>" + esc(tok(e.tokens_mes)) + ' no mês</span><span class="pv-ok">' + esc(brl(e.receita_mes)) + "</span></span></div>" +
          x.cs.map(function (c) {
            var s = sitConta(c.situacao);
            return '<button type="button" class="item pv-item-btn" data-pv="abrirConta" data-id="' + esc(c.id) + '"><span class="nome"><strong>' + esc(c.nome) + "</strong><small>" + esc(c.email) + "</small></span><span>" + esc(c.plano ? c.plano.nome : "—") + "</span>" + sit(s[0], s[1]) + "</button>";
          }).join("") + "</div>";
      }).join("") : '<div class="card pv-topo">' + vazio("Nenhum escritório com esse filtro.") + "</div>";
    }
    return h;
  };

  function abrirConta(id) {
    var C = Q.contas;
    C.aberta = id; C.det = null; C.erro = ""; C.aba = "resumo"; C.cad = null; C.google = null;
    C.ext = { tipo: "todos", periodo: "tudo", de: "", ate: "" };
    if (!dadosDe("contas")) ler("contas");
    R.abrindoConta = true;
    if (A.secaoAtual() === "contas") { R.abrindoConta = false; render(); } else A.navegar("contas");
    window.scrollTo(0, 0);
    A.pedir("GET", P + "contas/" + encodeURIComponent(id)).then(function (d) { if (C.aberta === id) { C.det = d; render(); } },
      function (e) { if (C.aberta === id && e.status !== 401) { C.erro = e.message; render(); } });
  }
  function recarregarConta() { var C = Q.contas, aba = C.aba; if (C.aberta == null) return; abrirConta(C.aberta); C.aba = aba; }

  function contaPagina() {
    var C = Q.contas, det = C.det, c = det || contaResumo(C.aberta);
    var h = '<button type="button" class="link pv-voltar" data-pv="voltarContas">‹ Contas</button>';
    if (!c) return h + "<h1>Conta</h1>" + (C.erro ? '<p class="nf-aviso"><span>Não foi possível ler a conta agora: ' + esc(C.erro) + "</span></p>" : '<div class="card pv-topo"><p class="vazio">Carregando…</p></div>');
    var s = sitConta(c.situacao), slug = ((det && det.escritorio) || c.escritorio || {}).slug;
    h += "<h1>" + esc(c.nome) + '</h1><p class="descricao pv-par">' + esc(c.email) + " " + sit(s[0], s[1]) +
      (slug ? '<a href="https://' + esc(slug) + '.paulus.ia.br" target="_blank" rel="noopener">' + esc(slug) + ".paulus.ia.br ↗</a>" : "") + "</p>";
    if (C.erro) h += '<p class="nf-aviso"><span>Não foi possível ler o detalhe da conta: ' + esc(C.erro) + "</span></p>";
    if (!det) return h + '<div class="card pv-topo"><p class="vazio">Carregando o detalhe…</p></div>';
    var abas = [["resumo", "Resumo"], ["pagamentos", "Pagamentos"], ["cadastro", "Cadastro"]];
    if (det.google && pode("google.servicos")) abas.push(["google", "Permissões Google"]);
    if (slug) abas.push(["tunel", "Túnel"]);
    if (!abas.some(function (a) { return a[0] === C.aba; })) C.aba = "resumo";
    h += guias("conta.aba", abas, C.aba, "Partes da conta");
    if (C.aba === "pagamentos") return h + extratoHtml(c, det);
    if (C.aba === "cadastro") return h + cadastroHtml(c, det);
    if (C.aba === "google") return h + googleCartao(contaGoogle(c, det), "aba");
    if (C.aba === "tunel") return h + tunelAba(slug);
    return h + contaResumoHtml(c, det);
  }

  function contaResumoHtml(c, det) {
    var cad = det.cadastro || {}, es = det.escritorio || {}, con = det.consentimento, ass = det.assinatura;
    var prepago = ass && (ass.periodo === "anual" || ass.periodo === "avulso");
    var cic = det.ciclo, p = cic && cic.tokens ? Math.min(100, Math.round((cic.usados || 0) / cic.tokens * 100)) : 0;
    var card = function (titulo, dl, dir) { return '<div class="card pv-topo">' + cardCab(titulo, dir) + '<dl class="nf-info pv-dl">' + dl + "</dl></div>"; };
    var h = "";
    if (cic) h += '<div class="card pv-topo pv-uso"><div class="pv-card-cab"><span class="titulo-secao">Uso do ciclo</span><strong>' + p + "%</strong></div>" + barra(p) + "</div>";
    var podeC = pode("conta.creditar"), filaC = naFila("conta.creditar", det.id);
    var esq = card("Plano", fato("Plano", c.plano ? c.plano.nome : "—") + (c.plano ? fato("Valor", brl(c.plano.valor) + "/mês") : "") +
      fato("Ciclo", cic ? ddmm(cic.inicio) + " a " + ddmm(cic.fim) : "sem ciclo aberto") + (cic ? fato("Usados", tok(cic.usados)) : "") +
      fato("Restantes", tok(det.restantes)) + fato("Recarga", tok(det.extra)),
      podeC ? '<button type="button" class="btn mini" data-pv="contaCreditar"' + dis(filaC, "já está na fila de alterações") + ">" + (filaC ? "Cortesia na fila" : "Creditar 10M de cortesia") + "</button>" : null);
    var tipoAss = !ass ? "sem assinatura" : ass.periodo === "anual" ? "anual" : ass.periodo === "avulso" ? "um mês avulso" : "mensal";
    esq += card("Cobrança (Atos)", fato("Assinatura", tipoAss) + (ass ? fato("Situação", ass.situacao || "—") : "") +
      (prepago && det.pago_ate ? fato("Pago até", ddmmaaaa(det.pago_ate)) : "") + (ass && !prepago && ass.desde ? fato("Desde", ddmmaaaa(ass.desde)) : "") +
      (ass && ass.id ? fato("ID na Atos", ass.id) : ""), '<button type="button" class="link" data-pv="seg" data-seg="conta.aba" data-v="pagamentos">Pagamentos ›</button>');
    var pgs = (det.pagamentos || []).slice().sort(function (a, b) { return Date.parse(b.quando) - Date.parse(a.quando); });
    esq += '<div class="card pv-topo">' + cardCab("Pagamentos", String(pgs.length)) + (pgs.length ? pgs.slice(0, 5).map(function (x) {
      return '<div class="item"><span class="nome"><strong>' + esc((TIPO_PAG[x.tipo] || x.tipo) + " de " + brl(x.valor)) + "</strong><small>" + esc(ddmmaaaa(x.quando)) +
        (x.reembolso ? " · reembolsado em " + esc(ddmm(x.reembolso.quando)) : "") + "</small></span></div>";
    }).join("") : vazio("Nenhum pagamento.")) + "</div>";
    var dir = card("Cadastro", fato("Escritório", es.nome || "—") + (es.slug ? fato("Endereço externo", es.slug + ".paulus.ia.br") : "") +
      fato("CPF/CNPJ", cad.documento || es.documento || "—") + fato("OAB, RG ou CNH", cad.oab || det.oab || "—") + fato("Telefone", cad.telefone || "—") +
      fato("Endereço", ([cad.logradouro, cad.numero].filter(Boolean).join(", ") || "—") + (cad.complemento ? " · " + cad.complemento : "")) +
      fato("Bairro", cad.bairro || "—") + fato("Cidade", (cad.cidade || "—") + (cad.uf ? " / " + cad.uf : "")) + fato("CEP", cad.cep || "—") +
      fato("Conta desde", ddmmaaaa(det.criada)) + (cad.ajustado ? fato("Ajustado", ddmmaaaa(cad.ajustado.quando) + " por " + (cad.ajustado.por || "—")) : ""),
      '<button type="button" class="link" data-pv="seg" data-seg="conta.aba" data-v="cadastro">Editar ›</button>');
    var esc2 = det.google ? (det.google.escopos || []) : [];
    dir += card("Google e termos", fato("Google", det.google ? "ligado" : "desligado") +
      (det.google ? fatoH("Permissões", '<span class="pv-chips">' + ESCOPOS.map(function (s) { var on = esc2.indexOf(s[0]) >= 0; return '<span class="nf-tag' + (on ? "" : " pv-off") + '" title="' + esc(s[0]) + (on ? "" : " · o Paulus não usa") + '">' + esc(s[1]) + "</span>"; }).join("") + "</span>") : "") +
      (det.google_pendente ? fato("Pendente", "o Paulus do escritório ainda não cumpriu") : "") +
      fato("Termos", con ? "versão " + con.versao : "—") + (con && con.quem ? fato("Aceito por", con.quem) : "") + (con && con.quando ? fato("Aceito em", ddmmaaaa(con.quando)) : ""));
    var inst = det.instalacoes || [], podeI = pode("conta.instalacao.apagar");
    dir += '<div class="card pv-topo">' + cardCab("Instalações", inst.length + " de 3") + (inst.length ? inst.map(function (i) {
      var f = naFila("conta.instalacao.apagar", det.id + ":" + i.hash8);
      return '<div class="item"><span class="nome"><strong>' + esc(i.instalacao) + "</strong><small>desde " + esc(ddmm(i.criado)) + "</small></span>" +
        (podeI ? '<button type="button" class="btn mini" data-pv="instDesvincular" data-hash="' + esc(i.hash8) + '" data-inst="' + esc(i.instalacao) + '"' + dis(f, "já está na fila de alterações") + ">" + (f ? "Na fila" : "Desvincular") + "</button>" : "") + "</div>";
    }).join("") : vazio("Nenhuma instalação ligada.")) + "</div>";
    return h + '<div class="pv-duas pv-topo">' + '<div class="pv-pilha">' + esq + '</div><div class="pv-pilha">' + dir + "</div></div>";
  }

  /* o extrato (aba Pagamentos) */
  var TIPO_PAG = { assinatura: "Mensalidade", anual: "Anual", avulso: "Mês avulso", recarga: "Recarga" };
  var MODALIDADE = { assinatura: "Assinatura mensal", anual: "Assinatura anual", avulso: "Mês avulso", recarga: "Recarga avulsa" };
  var SIT_FAT = { pago: ["paga", "ok"], pendente: ["pendente", "atencao"], recusado: ["recusada", "perigo"], reembolsado: ["reembolsada", "mudo"] };
  function itensExtrato(c, det) {
    var X = Q.contas.ext, agora = Date.now();
    var itens = (det.pagamentos || []).concat(det.pendentes || []).slice().sort(function (a, b) { return Date.parse(b.quando || 0) - Date.parse(a.quando || 0); });
    return itens.filter(function (x) {
      var okT = X.tipo === "todos" || (X.tipo === "reembolsados" ? Boolean(x.reembolso) : !x.reembolso && x.tipo === X.tipo);
      var qx = x.quando || new Date(agora).toISOString(), dia = qx.slice(0, 10), dd = (agora - Date.parse(qx)) / 864e5;
      var okP = X.periodo === "tudo" || (X.periodo === "custom" ? (!X.de || dia >= X.de) && (!X.ate || dia <= X.ate) : dd <= Number(X.periodo));
      return okT && okP;
    });
  }
  function descPag(x, c) { return x.tipo === "recarga" ? "Recarga" + (x.tokens ? " de " + tok(x.tokens) + " tokens" : "") : "Plano " + (x.plano || (c.plano ? c.plano.nome : "")); }
  function linkNf(u, rot) { return u && /^\//.test(u) ? '<a class="btn mini" href="' + esc(u) + '" download>' + rot + "</a>" : ""; }
  function extratoHtml(c, det) {
    var X = Q.contas.ext, ass = det.assinatura, itens = itensExtrato(c, det);
    var h = '<div class="card pv-topo"><div class="colunas">' +
      (ass ? '<div><span class="rotulo">Assinatura</span><span>' + esc(MODALIDADE[ass.periodo === "anual" ? "anual" : ass.periodo === "avulso" ? "avulso" : "assinatura"]) + (c.plano ? " · " + esc(c.plano.nome) : "") + "</span></div>" +
        '<div><span class="rotulo">Situação</span><span>' + esc(ass.situacao || "—") + "</span></div>" +
        '<div><span class="rotulo">Desde</span><span>' + esc(ass.desde ? ddmmaaaa(ass.desde) : "—") + "</span></div>" +
        (ass.id ? '<div><span class="rotulo">ID na Atos</span><span class="pv-par"><span class="pv-corta">' + esc(ass.id) + '</span><button type="button" class="link" data-pv="copiar" data-t="' + esc(ass.id) + '">Copiar</button></span></div>' : "")
        : '<div><span class="rotulo">Assinatura</span><span>Sem assinatura na Atos</span></div>') + "</div></div>";
    h += '<div class="pv-barra-filtros">' + opcoes("ext.tipo", [["todos", "Todos"], ["assinatura", "Mensalidades"], ["anual", "Anuais"], ["avulso", "Avulsos"], ["recarga", "Recargas"], ["reembolsados", "Reembolsados"]], X.tipo, false, "Tipo") +
      opcoes("ext.periodo", [["tudo", "Tudo"], ["30", "30 dias"], ["90", "90 dias"], ["custom", "Período"]], X.periodo, false, "Período") +
      (X.periodo === "custom" ? '<span class="pv-par"><input type="date" class="seletor" id="pv-ext-de" data-pv-in="extDe" value="' + esc(X.de) + '" aria-label="De"><span class="pv-mudo">a</span><input type="date" class="seletor" id="pv-ext-ate" data-pv-in="extAte" value="' + esc(X.ate) + '" aria-label="Até"></span>' : "") + "</div>";
    var linhas = itens.map(function (x) {
      var st = SIT_FAT[x.reembolso ? "reembolsado" : (x.situacao || "pago")] || [x.situacao, "mudo"], nf = x.nfse;
      return '<div class="pv-tr pv-c-ext"><span class="pv-num">' + esc(x.quando ? ddmmaaaa(x.quando) : "—") + '</span><span class="pv-corta">' + esc(descPag(x, c)) + "</span>" +
        '<span class="pv-num dir">' + esc(brl(x.valor)) + "</span><span>" + esc(MODALIDADE[x.tipo] || "—") + "</span>" + sit(st[0], st[1]) +
        '<span class="pv-par">' + (nf ? '<span class="pv-num" title="' + esc(nf.estado || "") + '">' + esc(nf.numero || "—") + "</span>" + linkNf(nf.pdf, "PDF") + linkNf(nf.xml, "XML") : '<span class="pv-mudo">—</span>') + "</span></div>";
    }).join("") || vazio("Nenhum pagamento com esse filtro.");
    var pago = itens.reduce(function (s, x) { return s + (x.reembolso || x.situacao === "pendente" ? 0 : Number(x.valor) || 0); }, 0);
    var nPend = itens.filter(function (x) { return x.situacao === "pendente"; }).length;
    h += '<div id="pv-extrato"><p class="pv-so-impressao">Extrato · ' + esc(c.nome) + " · " + esc(c.email) + " · " + esc(ddmmaaaa(new Date().toISOString())) + "</p>" +
      tabela("pv-c-ext", '<span>Data</span><span>Descrição</span><span class="dir">Valor</span><span>Modalidade</span><span>Situação</span><span>NFS-e</span>', linhas) +
      (itens.length ? '<p class="faturas-resumo card pv-total"><span>' + plural(itens.length, "lançamento", "lançamentos") + (nPend ? " · " + plural(nPend, "pendente", "pendentes") + ", fora do total" : "") + "</span><span>Total pago <strong>" + esc(brl(pago)) + "</strong></span></p>" : "") + "</div>";
    if (itens.length) h += '<div class="botoes pv-botoes-fora"><button type="button" class="btn p" data-pv="extratoJson">Baixar .json</button><button type="button" class="btn p" data-pv="extratoImprimir">Imprimir ou salvar em PDF</button></div>';
    return h + '<p class="nota">A assinatura, o cartão e as faturas ficam na Conta Atos da pessoa.</p>';
  }

  /* o cadastro (aba Cadastro): vai para a fila como conta.cadastro, so os campos que mudaram */
  var CAD = [["escritorio", "Escritório", "s4"], ["documento", "CPF ou CNPJ", "s2"], ["telefone", "Telefone ou WhatsApp", "s2"], ["oab", "OAB, RG ou CNH", "s2"], ["cep", "CEP", "s2"],
    ["logradouro", "Rua", "s4"], ["numero", "Número", "s2"], ["complemento", "Complemento", "s2"], ["bairro", "Bairro", "s2"], ["cidade", "Cidade", "s2"], ["uf", "UF", "s2"]];
  function cadEstado(det) {
    var C = Q.contas;
    if (C.cad && C.cad.id === det.id) return C.cad;
    var cad = det.cadastro || {}, es = det.escritorio || {};
    var v = { escritorio: es.nome || "", documento: cad.documento || es.documento || "", oab: cad.oab || det.oab || "", telefone: cad.telefone || "",
      cep: cad.cep || "", logradouro: cad.logradouro || "", numero: cad.numero || "", complemento: cad.complemento || "", bairro: cad.bairro || "", cidade: cad.cidade || "", uf: cad.uf || "" };
    C.cad = { id: det.id, v: v, antes: Object.assign({}, v), erros: {}, cidades: [] };
    return C.cad;
  }
  function cadastroHtml(c, det) {
    var K = cadEstado(det), fila = naFila("conta.cadastro", det.id);
    var campos = CAD.map(function (x) {
      var k = x[0], inv = K.erros[k] ? ' aria-invalid="true"' : "";
      if (k === "uf") return '<label class="campo ' + x[2] + '"><span class="rotulo">UF</span><select class="seletor" id="pv-cad-uf" data-pv-in="cad" data-k="uf"' + inv + '><option value="">—</option>' +
        UFS.map(function (u) { return '<option value="' + u + '"' + (K.v.uf === u ? " selected" : "") + ">" + u + "</option>"; }).join("") + "</select></label>";
      if (k === "cidade") return '<label class="campo ' + x[2] + '"><span class="rotulo">Cidade</span><input id="pv-cad-cidade" data-pv-in="cad" data-k="cidade" list="pv-cidades" autocomplete="off" value="' + esc(K.v.cidade) + '"' + inv + '><datalist id="pv-cidades">' +
        K.cidades.map(function (m) { return '<option value="' + esc(m.nome) + '">' + esc(m.nome + "/" + m.uf) + "</option>"; }).join("") + "</datalist></label>";
      return '<label class="campo ' + x[2] + '"><span class="rotulo">' + esc(x[1]) + '</span><input id="pv-cad-' + k + '" data-pv-in="cad" data-k="' + k + '" value="' + esc(K.v[k]) + '"' + inv + "></label>";
    }).join("");
    var erros = Object.keys(K.erros).map(function (k) { return K.erros[k]; });
    return '<div class="card pv-topo"><div class="grade">' + campos + "</div>" +
      (erros.length ? '<p class="erro nf-dentro" role="alert">' + esc(erros.join("; ")) + "</p>" : "") +
      '<p class="nota nf-dentro">O CPF ou CNPJ e o endereço vão na nota fiscal da assinatura. As mudanças entram na fila e valem quando você confirmar as alterações.' + (fila ? " Já há uma edição deste cadastro na fila." : "") + "</p>" +
      '<div class="botoes"><button type="button" class="btn p" data-pv="cadDesfazer">Desfazer</button><button type="button" class="btn p primario" data-pv="cadSalvar">Pôr na fila</button></div></div>';
  }
  function soDigitos(v) { return String(v || "").replace(/\D/g, ""); }
  function cpfOk(d) {
    if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
    for (var t = 9; t < 11; t++) { var s = 0; for (var i = 0; i < t; i++) s += Number(d[i]) * (t + 1 - i); if ((s * 10) % 11 % 10 !== Number(d[t])) return false; }
    return true;
  }
  function cnpjOk(d) {
    if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
    var calc = function (n) { var p = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], s = 0; for (var i = 0; i < n; i++) s += Number(d[i]) * p[i]; var r = s % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
  }
  var REGRA_CAD = {
    escritorio: function (v) { return v.length >= 2 && v.length <= 80 ? "" : "diga o nome do escritório"; },
    documento: function (v) { var d = soDigitos(v); return cpfOk(d) || cnpjOk(d) ? "" : "o CPF ou CNPJ não confere"; },
    telefone: function (v) { var d = soDigitos(v); return d.length >= 10 && d.length <= 13 ? "" : "o telefone precisa do DDD"; },
    oab: function (v) { return v ? "" : "falta o número da OAB, do RG ou da CNH"; },
    cep: function (v) { return soDigitos(v).length === 8 ? "" : "o CEP tem 8 dígitos"; },
    logradouro: function (v) { return v.length >= 2 ? "" : "diga a rua"; },
    numero: function (v) { return v ? "" : "diga o número (ou S/N)"; },
    bairro: function (v) { return v ? "" : "diga o bairro"; },
    cidade: function (v) { return v.length >= 2 ? "" : "diga a cidade"; },
    uf: function (v) { return UFS.indexOf(v) >= 0 ? "" : "a UF tem 2 letras"; },
  };

  /* ---------- Permissoes do Google ---------- */
  function contaGoogle(c, det) {
    var C = Q.contas;
    if (!C.google || C.google.id !== det.id) {
      var lig = {}; ((det.google && det.google.escopos) || []).forEach(function (s) { lig[s] = true; });
      C.google = { id: det.id, nome: c.nome, email: c.email, ligados: lig, tela: "contas" };
    }
    return C.google;
  }
  /* O cartao das permissoes: a conta e um interruptor por servico. Serve ao pop-up (tela Permissoes) e a aba da conta. */
  function googleCartao(G, onde) {
    var h = '<div class="card pv-topo">' + cardCab(esc(G.nome), esc(G.email)) +
      SERV_G.map(function (s) { return interruptor('data-pv="googleServico" data-k="' + s[0] + '"', G.ligados[s[0]], s[1], esc(s[2])); }).join("") + "</div>" +
      '<p class="nota">Desligar um serviço faz o Paulus do escritório parar de usá-lo (quando ele estiver aberto e falar com paulus.ia.br); o Google não revoga um escopo sozinho, e a permissão continua concedida lá. Com todos desligados, o Paulus revoga a concessão inteira no Google e passa a pedir o consentimento de novo.</p>' +
      '<div class="botoes pv-botoes-fora">' + (onde === "modal" ? '<button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button>' : "") +
      '<button type="button" class="btn p primario" data-pv="googleAplicar"' + dis(naFila("google.servicos", G.id), "já está na fila de alterações") + ">Pôr na fila</button></div>";
    if (pode("google.desvincular")) {
      var f = naFila("google.desvincular", G.id);
      h += h2("Desvincular a conta Google") + '<div class="card"><div class="item"><span class="nome"><strong>Tira a conta Google da nuvem do Paulus</strong><small>As instalações param de usar a nuvem e esta conta Google não ativa de novo. Não revoga nada no Google: para isso, desligue antes todos os serviços e espere o Paulus do escritório cumprir.</small></span>' +
        '<button type="button" class="btn p perigo" data-pv="googleDesvincular" data-id="' + esc(G.id) + '"' + dis(f, "já está na fila de alterações") + ">" + (f ? "Na fila" : "Desvincular") + "</button></div></div>";
    }
    return h;
  }
  TELAS_RENDER.google = function () {
    var h = cab("Permissões do Google", "Quem ligou o Gmail, a Agenda ou o Drive ao Paulus. <strong>Revogar</strong> manda o Paulus do escritório parar de usar serviços (com todos desligados, ele revoga a concessão no Google); <strong>Desvincular</strong> tira a conta da nuvem do Paulus.");
    var est = estadoLeitura(["contas"], "google"); if (est) return h + est;
    h += erroRecente("contas", "google");
    var todas = dadosDe("contas").contas || [], gs = todas.filter(function (c) { return c.google; });
    var podeRev = pode("google.servicos"), podeDes = pode("google.desvincular"), SEL = Q.google.sel, ids = selIds(SEL);
    var topo = SEL ? '<span class="pv-par"><span>' + plural(ids.length, "selecionada", "selecionadas") + '</span><button type="button" class="btn mini perigo" data-pv="googleDesvMassa"' + (ids.length ? "" : " disabled") + '>Desvincular</button><button type="button" class="btn mini" data-pv="selTodas" data-tela="google">Todas</button><button type="button" class="link" data-pv="selSair" data-tela="google">Sair da seleção</button></span>'
      : '<span class="pv-par"><span>' + gs.length + " de " + todas.length + "</span>" + (podeDes && gs.length ? '<button type="button" class="link" data-pv="selEntrar" data-tela="google">Selecionar</button>' : "") + "</span>";
    h += '<div class="card pv-topo">' + cardCab("Contas com Google ligado", topo) + (gs.length ? gs.map(function (c) {
      var filaS = naFila("google.servicos", c.id), filaD = naFila("google.desvincular", c.id), acoes;
      if (Q.google.confirmando === c.id) {
        acoes = '<span class="pv-par"><span class="pv-perigo">Desvincular a conta Google de ' + esc(primeiro(c.nome)) + '?</span><button type="button" class="btn mini" data-pv="googleVoltar">Voltar</button><button type="button" class="btn mini perigo" data-pv="googleDesvincular" data-id="' + esc(c.id) + '">Confirmar</button></span>';
      } else {
        acoes = '<span class="pv-par">' + (podeRev ? '<button type="button" class="btn mini" data-pv="modalGoogle" data-id="' + esc(c.id) + '"' + dis(filaS, "já está na fila de alterações") + ">" + (filaS ? "Revogação na fila" : "Revogar permissões") + "</button>" : "") +
          (podeDes ? '<button type="button" class="btn mini perigo" data-pv="googleConfirmar" data-id="' + esc(c.id) + '"' + dis(filaD, "já está na fila de alterações") + ">" + (filaD ? "Na fila" : "Desvincular") + "</button>" : "") + "</span>";
      }
      return '<div class="item pv-g-item">' + (SEL ? (filaD ? '<span class="pv-caixa-vazia"></span>' : caixa("google", c.id, SEL[c.id])) : "") +
        '<span class="nome"><strong>' + esc(c.nome) + "</strong><small>" + esc(c.email) + " · conferido " + esc(rel(c.google.conferido)) + "</small></span>" +
        '<span class="pv-chips">' + ESCOPOS.filter(function (s) { return (c.google.escopos || []).indexOf(s[0]) >= 0; }).map(function (s) { return '<span class="nf-tag" title="' + esc(s[0]) + '">' + esc(s[1]) + "</span>"; }).join("") + "</span>" +
        (SEL ? "" : acoes) + "</div>";
    }).join("") : vazio("Nenhuma conta ligou o Google ainda.")) + "</div>";
    if (!podeRev && !podeDes) h += '<p class="nota">O papel ' + esc(U.PAPEL_NOME[A.quem.papel] || A.quem.papel) + " vê as permissões, mas não revoga nem desvincula.</p>";
    return h + '<p class="nota">Os escopos vêm do consentimento guardado no Paulus instalado; aqui só o nome. O token em si nunca passa por este painel.</p>';
  };

  /* ---------- Tuneis Cloudflare ---------- */
  var EST_TUNEL = { healthy: ["saudável", "ok"], degraded: ["instável", "atencao"], inactive: ["parado", "mudo"], down: ["fora do ar", "perigo"], desativado: ["desativado", "perigo"] };
  function parado(t) { return t.estado === "inactive" || t.estado === "down"; }
  function limpezaDe(t) {
    var l = t.limpeza;
    if (!l || l.dias == null) return ["sem previsão", "mudo", null];
    var d = Number(l.dias), tom = !t.ultima_conexao ? (d <= 2 ? "perigo" : "atencao") : (d <= 7 ? "perigo" : "atencao");
    return [d <= 0 ? "apaga hoje" : "apaga em " + d + "d", tom, d];
  }
  function tuneisCf() { var d = dadosDe("tuneis") || {}; return d.cf && d.cf.ligado === false ? d.cf : cfg("tuneis"); }
  function tunel(slug) { return ((dadosDe("tuneis") || {}).tuneis || []).filter(function (x) { return x.slug === slug; })[0]; }
  function tunelAcoes(t) {
    var cf = tuneisCf(), cfOff = desligado(cf), emailOff = desligado(cfg("email"));
    var fA = naFila("tunel.apagar", t.slug), fE = naFila("tunel.endereco", t.slug), fT = naFila("tunel.ativo", t.slug);
    return '<div class="botoes">' +
      '<button type="button" class="btn mini" data-pv="tunelAvisar" data-slug="' + esc(t.slug) + '"' + dis(emailOff || !t.responsavel, emailOff ? cfg("email").falta : "sem responsável") + ">Avisar o responsável</button>" +
      (pode("tunel.endereco") ? '<button type="button" class="btn mini" data-pv="modalEndereco" data-slug="' + esc(t.slug) + '"' + dis(cfOff || fE || fA, cfOff ? cf.falta : "já está na fila de alterações") + ">" + (fE ? "Troca na fila" : "Alterar endereço") + "</button>" : "") +
      (pode("tunel.ativo") ? '<button type="button" class="btn mini" data-pv="tunelAtivo" data-slug="' + esc(t.slug) + '"' + dis(cfOff || fT || fA, cfOff ? cf.falta : "já está na fila de alterações") + ">" + (fT ? "Na fila" : t.ativo === false ? "Ativar acesso" : "Desativar acesso") + "</button>" : "") +
      (pode("tunel.apagar") ? '<button type="button" class="btn mini perigo" data-pv="tunelLiberar" data-slug="' + esc(t.slug) + '"' + dis(cfOff || fA, cfOff ? cf.falta : "já está na fila de alterações") + ">" + (fA ? "Apagar na fila" : "Liberar endereço") + "</button>" : "") + "</div>";
  }
  function tunelDados(t) {
    var l = limpezaDe(t), k = t.ativo === false ? "desativado" : t.estado, e = EST_TUNEL[k] || [k, "mudo"];
    return '<dl class="nf-info pv-dl">' + fatoH("Situação", sit(e[0], e[1])) + fato("Última conexão", rel(t.ultima_conexao)) +
      fatoH("Limpeza", '<span class="pv-' + l[1] + '">' + esc(l[0]) + "</span>" + (t.limpeza && t.limpeza.motivo ? ' <small class="pv-mudo">' + esc(t.limpeza.motivo) + "</small>" : "")) +
      fato("Responsável", t.responsavel || "—") + fato("Criado", ddmmaaaa(t.criado_em)) + fato("Porta", t.porta == null ? "—" : String(t.porta)) + fato("ID do túnel", t.tunnel_id || "—") + "</dl>";
  }
  function histOrd(t) { return (t.historico || []).slice().sort(function (a, b) { return String(b.quando).localeCompare(String(a.quando)); }); }
  TELAS_RENDER.tuneis = function () {
    var T = Q.tuneis;
    var h = cab("Túneis Cloudflare", "Cada escritório tem um túnel e um endereço em paulus.ia.br. A limpeza diária apaga os que nunca conectaram em 7 dias e os parados há mais de 180.");
    h += '<div class="pv-barra-filtros">' + opcoes("tuneis.filtro", [["todos", "Todos"], ["parados", "Só parados"], ["risco", "Perto de apagar"], ["ativos", "Conectados"]], T.filtro, false, "Filtro") + "</div>";
    var est = estadoLeitura(["tuneis"], "tuneis"); if (est) return h + est;
    var cf = tuneisCf(), cfOff = desligado(cf), podeA = pode("tunel.apagar");
    h += falta(cf) + erroRecente("tuneis", "tuneis");
    var d = dadosDe("tuneis"), todos = d.tuneis || [];
    var lista = todos.filter(function (t) {
      if (T.filtro === "parados") return parado(t);
      if (T.filtro === "risco") return limpezaDe(t)[2] !== null;
      if (T.filtro === "ativos") return t.ativo !== false && (t.estado === "healthy" || t.estado === "degraded");
      return true;
    });
    var SEL = T.sel, ids = selIds(SEL);
    var topo = SEL ? '<span class="pv-par"><span>' + plural(ids.length, "selecionado", "selecionados") + '</span><button type="button" class="btn mini perigo" data-pv="tuneisApagar"' + dis(cfOff || !ids.length, cfOff ? cf.falta : "") + '>Apagar túnel e DNS</button><button type="button" class="btn mini" data-pv="tuneisParados">Os parados</button><button type="button" class="link" data-pv="selSair" data-tela="tuneis">Sair da seleção</button></span>'
      : (podeA && todos.length ? '<button type="button" class="link" data-pv="selEntrar" data-tela="tuneis">Selecionar</button>' : "");
    var linhas = lista.map(function (t) {
      var k = t.ativo === false ? "desativado" : t.estado, e = EST_TUNEL[k] || [k, "mudo"];
      var ult = dt(t.ultima_conexao), velho = !ult || (Date.now() - ult) > 60 * 864e5, l = limpezaDe(t), aberto = T.aberto === t.slug && !SEL;
      var fA = naFila("tunel.apagar", t.slug);
      var r = '<div class="pv-tr pv-c-tuneis' + (SEL ? " pv-c-sel" : "") + (aberto ? " pv-aberto" : "") + '">' +
        (SEL ? (fA ? '<span class="pv-caixa-vazia"></span>' : caixa("tuneis", t.slug, SEL[t.slug])) : "") +
        '<button type="button" class="pv-linha-btn" data-pv="tunelAbrir" data-slug="' + esc(t.slug) + '" aria-expanded="' + aberto + '"><span class="nf-cel"><strong>' + esc(t.slug) + '<span class="pv-mudo">.paulus.ia.br</span></strong><small>' + esc(t.nome) + (t.responsavel ? " · " + esc(t.responsavel) : "") + "</small></span></button>" +
        sit(e[0], e[1]) + '<span class="pv-num dir' + (velho ? " pv-perigo" : "") + '">' + esc(rel(t.ultima_conexao)) + "</span>" +
        '<span class="pv-num dir pv-' + l[1] + '"' + (t.limpeza && t.limpeza.motivo ? ' title="' + esc(t.limpeza.motivo) + '"' : "") + ">" + esc(l[0]) + "</span></div>";
      if (aberto) {
        var hist = histOrd(t);
        r += '<div class="nf-det pv-det-duas"><div>' + tunelDados(t) + tunelAcoes(t) + '</div><div><span class="titulo-secao">Histórico</span><ul class="nf-passos pv-hist">' +
          (hist.length ? hist.slice(0, 4).map(function (x) { return "<li><span>" + esc(ddmmaaaa(x.quando)) + "</span><span>" + esc(x.texto) + "</span><span></span></li>"; }).join("") : "<li><span>—</span><span>Sem eventos registrados.</span><span></span></li>") + "</ul>" +
          (hist.length > 4 ? '<button type="button" class="link" data-pv="tunelHist" data-slug="' + esc(t.slug) + '">Ver o histórico completo</button>' : "") + "</div></div>";
      }
      return r;
    }).join("") || vazio("Nenhum túnel com esse filtro.");
    h += '<div class="card pv-topo">' + cardCab(plural(lista.length, "túnel", "túneis"), topo) + '<div class="pv-tabela"><div><div class="pv-tr pv-th pv-c-tuneis' + (SEL ? " pv-c-sel" : "") + '">' + (SEL ? "<span></span>" : "") +
      '<span>Endereço</span><span>Estado</span><span class="dir">Última conexão</span><span class="dir">Limpeza</span></div>' + linhas + "</div></div></div>";

    // O registro de enderecos: cada evento com data, endereco, o que aconteceu, quem fez e como ficou.
    var REG_EV = { criado: "criou o endereço", alterado: "trocou o endereço", desativado: "desativou o endereço", reativado: "reativou o endereço", liberado: "liberou o endereço" };
    var REG_EST = { ativo: ["ativo", "ok"], desativado: ["desativado", "perigo"], livre: ["livre", "mudo"] };
    var reg = (d.registro || []).slice().sort(function (a, b) { return String(b.quando).localeCompare(String(a.quando)); });
    var fq = norm(T.regQ || "");
    var regF = reg.filter(function (x) {
      var dia = String(x.quando).slice(0, 10);
      return (T.reg === "todos" || x.evento === T.reg) && (!fq || norm([x.slug, x.de, x.quem, x.motivo].join(" ")).indexOf(fq) >= 0) &&
        (!T.de || dia >= T.de) && (!T.ate || dia <= T.ate);
    });
    regFiltrado = regF;
    var ver = T.regTodos ? regF : regF.slice(0, 8);
    h += h2("Registro de endereços") + '<div class="pv-barra-filtros">' + opcoes("tuneis.reg", [["todos", "Todos"], ["criado", "Criados"], ["alterado", "Alterados"], ["desativado", "Desativados"], ["reativado", "Reativados"], ["liberado", "Liberados"]], T.reg, false, "Evento") +
      '<input class="seletor pv-busca-campo" id="pv-reg-q" data-pv-in="regQ" value="' + esc(T.regQ) + '" placeholder="endereço, e-mail ou motivo" aria-label="Buscar no registro" autocomplete="off">' +
      '<span class="pv-par"><input type="date" class="seletor" id="pv-reg-de" data-pv-in="regDe" value="' + esc(T.de) + '" aria-label="De"><span class="pv-mudo">a</span><input type="date" class="seletor" id="pv-reg-ate" data-pv-in="regAte" value="' + esc(T.ate) + '" aria-label="Até"></span></div>';
    h += tabela("pv-c-reg", "<span>Data</span><span>Endereço</span><span>Evento</span><span>Quem</span><span>Estado</span>", ver.map(function (x) {
      var es = REG_EST[x.estado] || [x.estado || "—", "mudo"], auto = /autom/.test(x.quem || "");
      return '<div class="pv-tr pv-c-reg"><span class="nf-cel pv-num"><span>' + esc(ddmmaaaa(x.quando)) + "</span><small>" + esc(String(x.quando).slice(11, 16)) + "</small></span>" +
        '<span class="nf-cel"><strong>' + esc(x.slug) + "</strong>" + (x.de ? "<small>antes " + esc(x.de) + "</small>" : "") + "</span>" +
        '<span class="nf-cel"><strong>' + esc((auto ? "O sistema " : "") + (REG_EV[x.evento] || x.evento)) + "</strong>" + (x.motivo ? "<small>" + esc(x.motivo) + "</small>" : "") + "</span>" +
        '<span class="pv-corta' + (auto ? " pv-mudo" : "") + '">' + esc(x.quem || "—") + "</span>" + sit(es[0], es[1]) + "</div>";
    }).join("") || vazio("Nenhum evento com esse filtro."));
    if (regF.length) h += '<div class="botoes pv-botoes-fora"><button type="button" class="btn p" data-pv="regJson">Baixar .json</button>' +
      (regF.length > 8 ? '<button type="button" class="link" data-pv="regMais">' + (T.regTodos ? "Ver menos" : "Ver todos os " + regF.length) + "</button>" : "") + "</div>";
    h += '<div class="card pv-topo"><div class="item"><span class="nome"><strong>Liberar ou apagar</strong><small>Remove o túnel, o endereço e o registro do escritório. O nome fica livre para outro escritório, e o acesso externo precisa ser ligado de novo no Paulus.</small></span></div>' +
      '<div class="item"><span class="nome"><strong>Desativar acesso</strong><small>Só pausa o endereço: o túnel continua e nada é apagado. O Paulus do escritório recebe o motivo na próxima conexão, e Ativar acesso devolve tudo como estava.</small></span></div></div>';
    return h;
  };
  var regFiltrado = [];
  function tunelAba(slug) {
    var d = dadosDe("tuneis");
    if (!d) { if (!D.tuneis || !D.tuneis.promessa) ler("tuneis"); return '<div class="card pv-topo"><p class="vazio">Carregando o túnel…</p></div>'; }
    var t = tunel(slug);
    if (!t) return '<div class="card pv-topo"><p class="vazio">Este escritório ainda não tem túnel.</p></div>';
    var hist = histOrd(t);
    return '<div class="card pv-topo">' + cardCab("Túnel Cloudflare", '<a href="https://' + esc(t.slug) + '.paulus.ia.br" target="_blank" rel="noopener">' + esc(t.slug) + ".paulus.ia.br ↗</a>") + '<div class="nf-dentro">' + tunelDados(t) + "</div>" + tunelAcoes(t) + "</div>" +
      falta(tuneisCf()) + h2("Histórico · " + hist.length) + '<div class="card"><ul class="nf-passos pv-hist nf-dentro">' +
      (hist.length ? hist.map(function (x) { return "<li><span>" + esc(ddmmaaaa(x.quando)) + "</span><span>" + esc(x.texto) + "</span><span></span></li>"; }).join("") : "<li><span>—</span><span>Sem eventos registrados.</span><span></span></li>") + "</ul></div>";
  }

  /* ---------- Nao renovacoes ---------- */
  TELAS_RENDER.renovacoes = function () {
    var h = cab("Não renovações", "Ciclos das contas do PAVLVS cobradas pela Atos que venceram sem renovar. O plano segue valendo durante a tolerância; depois, a conta fica sem IA até pagar.");
    var est = estadoLeitura(["renovacoes"], "renovacoes"); if (est) return h + est;
    h += erroRecente("renovacoes", "renovacoes");
    var d = dadosDe("renovacoes"), ab = d.abertas || [], tr = d.tratadas || [], email = cfg("email"), emailOff = desligado(email), N = Q.renovacoes;
    h += falta(email);
    var SEL = N.sel, ids = selIds(SEL);
    var topo = SEL ? '<span class="pv-par"><span>' + plural(ids.length, "selecionada", "selecionadas") + '</span><button type="button" class="btn mini" data-pv="renovLembreteMassa"' + dis(emailOff || !ids.length, emailOff ? email.falta : "") + '>Enviar lembrete</button><button type="button" class="btn mini" data-pv="renovTratarMassa"' + (ids.length ? "" : " disabled") + '>Marcar tratadas</button><button type="button" class="btn mini" data-pv="selTodas" data-tela="renovacoes">Todas</button><button type="button" class="link" data-pv="selSair" data-tela="renovacoes">Sair da seleção</button></span>'
      : (ab.length ? '<button type="button" class="link" data-pv="selEntrar" data-tela="renovacoes">Selecionar</button>' : "");
    var linhas = ab.map(function (r) {
      var dv = Number(r.dias_vencido) || 0, tol = r.tolerancia_dias == null ? 0 : Number(r.tolerancia_dias), resta = tol - dv;
      var prazo = resta > 0 ? "venceu há " + dv + "d · " + resta + "d de tolerância" : "sem IA há " + (-resta) + "d";
      var aberto = !SEL && String(N.aberto) === String(r.id);
      var l = '<div class="pv-tr pv-c-renov' + (SEL ? " pv-c-sel" : "") + (aberto ? " pv-aberto" : "") + '">' + (SEL ? caixa("renovacoes", r.id, SEL[r.id]) : "") +
        '<button type="button" class="pv-linha-btn" data-pv="renovAbrir" data-id="' + esc(r.id) + '" aria-expanded="' + aberto + '"><span class="nf-cel"><strong>' + esc(r.nome) + "</strong><small>" + esc(r.email) + "</small></span></button>" +
        '<span class="nf-cel"><span>' + esc(r.plano ? r.plano.nome : "—") + "</span><small>" + esc(r.plano ? brl(r.plano.valor) : "") + "</small></span>" +
        '<span class="pv-num ' + (resta > 0 ? "pv-atencao" : "pv-perigo") + '" title="venceu em ' + esc(ddmmaaaa(r.fim)) + '">' + esc(prazo) + "</span>" +
        "<span>" + esc(r.motivo || "—") + "</span>" +
        (SEL ? "<span></span>" : '<span class="pv-par dir"><button type="button" class="btn mini" data-pv="renovLembrete" data-id="' + esc(r.id) + '"' + (emailOff ? ' disabled title="' + esc(email.falta) + '"' : r.lembrete_em ? ' title="enviado ' + esc(quando(r.lembrete_em)) + '"' : "") + ">" + (r.lembrete_em ? "Lembrete enviado" : "Lembrete") + "</button>" +
          '<button type="button" class="btn mini" data-pv="abrirConta" data-id="' + esc(r.id) + '">Conta</button><button type="button" class="btn mini" data-pv="renovTratar" data-id="' + esc(r.id) + '">Tratada</button></span>') + "</div>";
      if (aberto) {
        var id = String(r.id), err = N.erro[id];
        l += '<div class="nf-det"><label class="campo pv-campo-msg"><span class="rotulo">Mensagem para ' + esc(primeiro(r.nome)) + " (vai para " + esc(r.email) + ")</span>" +
          '<textarea id="pv-rd-msg-' + esc(id) + '" data-pv-in="renovMsg" data-id="' + esc(id) + '" rows="4" placeholder="Escreva do seu jeito. Sai do e-mail do Paulus, com o seu nome."' + (err ? ' aria-invalid="true"' : "") + ">" + esc(N.msg[id] || "") + "</textarea></label>" +
          (err ? '<p class="erro">' + esc(err) + "</p>" : "") +
          '<div class="botoes"><button type="button" class="btn p primario" data-pv="renovMsgEnviar" data-id="' + esc(id) + '"' + dis(emailOff, email.falta) + ">Enviar mensagem</button></div></div>";
      }
      return l;
    }).join("") || vazio("Nenhuma pendente.");
    h += '<div class="card pv-topo">' + cardCab(plural(ab.length, "aberta", "abertas") + " · " + plural(tr.length, "tratada", "tratadas"), topo) +
      '<div class="pv-tabela"><div><div class="pv-tr pv-th pv-c-renov' + (SEL ? " pv-c-sel" : "") + '">' + (SEL ? "<span></span>" : "") + "<span>Conta</span><span>Plano</span><span>Prazo</span><span>Motivo</span><span></span></div>" + linhas + "</div></div></div>";
    var c = d.config || {}, eu = (A.quem && A.quem.email) || "você";
    var OP = [["email", "E-mail a cada não renovação", "para " + eu + ", na hora do aviso da Atos"], ["resumo", "Resumo diário às 8h", "vencidas, tolerância acabando, túneis parados"],
      ["whats", "WhatsApp quando a tolerância acabar", "só o nome e o plano, sem dados pessoais"], ["tol", "Lembrete automático ao cliente no 3º dia", "modelo “Seu plano não renovou”"]];
    h += '<div class="pv-duas pv-topo"><div class="card">' + cardCab("Como você quer ser avisado") + OP.map(function (o) { return interruptor('data-pv="renovCfg" data-k="' + o[0] + '"', c[o[0]], o[1], esc(o[2])); }).join("") + "</div>" +
      '<div class="card">' + cardCab("Tratadas", String(tr.length)) + (tr.length ? tr.map(function (r) {
        return '<div class="item"><span class="nome"><strong>' + esc(r.nome) + "</strong><small>" + esc(r.plano ? r.plano.nome : "") + '</small></span><button type="button" class="btn mini" data-pv="renovReabrir" data-id="' + esc(r.id) + '">Reabrir</button></div>';
      }).join("") : vazio("Nenhuma tratada.")) + "</div></div>";
    return h;
  };

  /* ---------- Tokens, custos e receita ---------- */
  TELAS_RENDER.tokens = function () {
    var T = Q.tokens, ch = tokensChave(), d = dadosDe(ch), pr = d && d.precos;
    var h = cab("Tokens, custos e receita", "Entrada e saída medidas no portão do PAVLVS, custo pelo preço do provedor por milhão, receita pelos pagamentos que a Atos confirmou.");
    h += '<div class="pv-barra-filtros">' + opcoes("tokens.visao", [["geral", "Geral"], ["modelo", "Por modelo"], ["escritorio", "Por escritório"], ["conta", "Por conta"]], T.visao, false, "Visão") +
      opcoes("tokens.periodo", [["mes", "Este mês"], ["30", "30 dias"], ["90", "90 dias"], ["ano", "Este ano"], ["custom", "Outro período"]], T.periodo, false, "Período") +
      (T.periodo === "custom" ? '<span class="pv-par"><input type="date" class="seletor" id="pv-tok-de" data-pv-in="tokDe" value="' + esc(T.de) + '" aria-label="De"><span class="pv-mudo">a</span><input type="date" class="seletor" id="pv-tok-ate" data-pv-in="tokAte" value="' + esc(T.ate) + '" aria-label="Até"></span>' : "") + "</div>";
    if (pr) h += '<p class="dica">Provedor · entrada ' + esc(usd(pr.entrada)) + "/M · saída " + esc(usd(pr.saida)) + "/M · câmbio " + esc(cambioTxt(pr.cambio)) + "</p>";
    h += falta(cfg("nuvem"));
    if (T.periodo === "custom" && (!T.de || !T.ate || T.de > T.ate)) return h + '<div class="card pv-topo"><p class="vazio">Escolha o primeiro e o último dia do período.</p></div>';
    var est = estadoLeitura([ch], "tokens"); if (est) return h + est;
    h += erroRecente(ch, "tokens");
    var k = d.kpis || {}, cambio = Number(pr && pr.cambio) || 0;
    var custoR = (Number(k.custo_usd) || 0) * cambio, rec = Number(k.receita) || 0, nc = Number(k.contas) || 0, mg = rec > 0 ? 1 - custoR / rec : null;
    h += '<div class="card pv-topo"><div class="colunas pv-kpis">' + kpi("Entrada", tok(k.entrada), "prompt_tokens") + kpi("Saída", tok(k.saida), "completion_tokens") +
      kpi("Custo", brl(custoR), usd(k.custo_usd) + " · câmbio " + cambioTxt(cambio)) + kpi("Arrecadado", brl(rec), "pagamentos confirmados") +
      kpi("Margem", mg == null ? "—" : pct(mg), brl(rec - custoR) + " líquido", mg == null ? "" : mg >= 0 ? "ok" : "perigo") +
      kpi("Custo por conta", nc ? brl(custoR / nc) : "—", nc ? "média · " + brl(rec / nc) + " arrecadado" : "sem contas") + "</div></div>";
    if (d.incompleto && d.aviso) h += '<p class="nf-aviso"><span>' + esc(d.aviso) + "</span></p>";
    var ls = (d.linhas || []).slice().sort(function (a, b) { return ((b.entrada || 0) + (b.saida || 0)) - ((a.entrada || 0) + (a.saida || 0)); });
    var max = ls.reduce(function (m, l) { return Math.max(m, (l.entrada || 0) + (l.saida || 0)); }, 0) || 1;
    var SEL = T.sel, sel = SEL ? ls.filter(function (l) { return SEL[l.nome]; }) : [];
    var linhas = ls.map(function (l) {
      var cu = (Number(l.custo_usd) || 0) * cambio, r = Number(l.receita) || 0, m = r > 0 ? 1 - cu / r : null;
      var tom = m == null ? "mudo" : m >= 0.4 ? "ok" : m >= 0 ? "atencao" : "perigo";
      return '<div class="pv-tr pv-c-tok' + (SEL ? " pv-c-sel" : "") + '">' + (SEL ? caixa("tokens", l.nome, SEL[l.nome]) : "") +
        '<span class="nf-cel"><strong>' + esc(l.nome) + "</strong>" + (l.sub ? "<small>" + esc(l.sub) + "</small>" : "") +
        (l.preco ? "<small>" + esc(usd(l.preco[0]) + " entrada · " + usd(l.preco[1]) + " saída, por milhão") + "</small>" : "") + barra(((l.entrada || 0) + (l.saida || 0)) / max * 100) + "</span>" +
        '<span class="pv-num dir">' + esc(tok(l.entrada)) + '</span><span class="pv-num dir">' + esc(tok(l.saida)) + '</span><span class="pv-num dir" title="' + esc(usd(l.custo_usd)) + '">' + esc(brl(cu)) + "</span>" +
        '<span class="pv-num dir">' + esc(brl(r)) + '</span><span class="pv-num dir pv-' + tom + '">' + (m == null ? "—" : pct(m)) + "</span></div>";
    }).join("") || vazio("Nada medido neste período.");
    var soma = function (c) { return sel.reduce(function (s, l) { return s + (Number(l[c]) || 0); }, 0); };
    var topo = SEL ? '<span class="pv-par"><span>' + plural(sel.length, "selecionada", "selecionadas") + " · " + esc(tok(soma("entrada") + soma("saida"))) + " tokens · custo " + esc(brl(soma("custo_usd") * cambio)) + " · arrecadado " + esc(brl(soma("receita"))) +
      '</span><button type="button" class="btn mini" data-pv="selTodas" data-tela="tokens">Todas</button><button type="button" class="link" data-pv="selSair" data-tela="tokens">Sair da seleção</button></span>'
      : (ls.length ? '<button type="button" class="link" data-pv="selEntrar" data-tela="tokens">Somar linhas</button>' : "");
    var col = { geral: "Origem", modelo: "Modelo", escritorio: "Escritório", conta: "Conta" }[T.visao];
    h += '<div class="card pv-topo">' + cardCab(d.periodo ? esc((d.periodo.nome || "") + " · " + ddmm(d.periodo.de) + " a " + ddmm(d.periodo.ate)) : "Período", topo) +
      '<div class="pv-tabela"><div><div class="pv-tr pv-th pv-c-tok' + (SEL ? " pv-c-sel" : "") + '">' + (SEL ? "<span></span>" : "") + "<span>" + col + '</span><span class="dir">Entrada</span><span class="dir">Saída</span><span class="dir">Custo</span><span class="dir">Arrecadado</span><span class="dir">Margem</span></div>' + linhas + "</div></div></div>";
    return h;
  };

  /* ---------- Planos ---------- */
  function precosPlanos() { var d = dadosDe("tokens:geral:mes"); return d && d.precos ? d.precos : null; }
  // Se o assinante usar o pacote inteiro (a proporcao entrada/saida 72/28 e uma estimativa); o preco e o do modelo do plano.
  function custoCheio(tokens, preco) {
    var p = precosPlanos(); if (!p) return null;
    var ok = Array.isArray(preco) && isFinite(preco[0]) && isFinite(preco[1]);
    var e = ok ? Number(preco[0]) : Number(p.entrada), s = ok ? Number(preco[1]) : Number(p.saida);
    var v = (tokens * 0.72 / 1e6 * e + tokens * 0.28 / 1e6 * s) * p.cambio;
    return isFinite(v) ? v : null;
  }
  var CAMPOS_PLANO = ["id", "nome", "para", "valor", "valor_anual", "tokens", "pessoas", "modelos", "recarga", "recursos", "heranca", "itens"];
  function planosAtuais(ps) {
    var d = dadosDe("planos");
    if (d && typeof d.json === "string" && d.json) { try { return JSON.stringify(JSON.parse(d.json), null, 2); } catch (e) { /* cai no montado */ } }
    return JSON.stringify(ps.map(function (p) { var o = {}; CAMPOS_PLANO.forEach(function (k) { if (p[k] !== undefined) o[k] = p[k]; }); return o; }), null, 2);
  }
  function validaPlanos(t) {
    var v; try { v = JSON.parse(t); } catch (e) { return "JSON inválido: " + e.message; }
    if (!Array.isArray(v) || !v.length) return "precisa ser uma lista de planos: [ { … }, … ]";
    for (var i = 0; i < v.length; i++) {
      var p = v[i], n = "plano " + (i + 1) + (p && p.nome ? " (" + p.nome + ")" : "");
      if (!p || typeof p !== "object") return n + ": não é um objeto";
      if (!/^[a-z0-9-]{2,24}$/.test(p.id || "")) return n + ": o id precisa ter 2 a 24 letras minúsculas, números e hífen";
      if (!p.nome) return n + ": falta o nome";
      if (!(p.valor > 0) || !(p.valor_anual > 0)) return n + ": valor e valor_anual precisam ser números maiores que zero";
      if (!(p.tokens > 0)) return n + ": tokens precisa ser um número maior que zero";
      if (p.itens && (!Array.isArray(p.itens) || p.itens.some(function (it) { return !it || !it.titulo; }))) return n + ": cada item precisa de titulo (e, se quiser, descricao)";
    }
    var ids = v.map(function (p) { return p.id; });
    if (ids.some(function (x, k) { return ids.indexOf(x) !== k; })) return "há dois planos com o mesmo id";
    return null;
  }
  function planoEd(p) {
    var e = Q.planos.ed;
    if (!e || e.id !== p.id) e = Q.planos.ed = { id: p.id, erros: {}, v: { nome: p.nome, para: (p.textos && p.textos.para) ? p.para || "" : "", heranca: (p.textos && p.textos.heranca) ? p.heranca || "" : "",
      valor: String(p.valor).replace(".", ","), anual: String(p.valor_anual || "").replace(".", ","), tokens: dec(p.tokens / 1e6, 2), pessoas: String(p.pessoas || 1),
      rv: p.recarga ? String(p.recarga.valor).replace(".", ",") : "", rt: p.recarga ? dec(p.recarga.tokens / 1e6, 2) : "" },
      itens: (p.itens || []).map(function (x) { return { titulo: x.titulo, descricao: x.descricao || "" }; }) };
    return e;
  }
  TELAS_RENDER.planos = function () {
    var h = cab("Planos do PAVLVS", "Preços, créditos e os textos que aparecem na página de assinatura do PAVLVS. A cobrança é da Atos: mudar o valor aqui não muda o que a Atos já cobra de quem assina.");
    var est = estadoLeitura(["planos"], "planos"); if (est) return h + est;
    h += erroRecente("planos", "planos");
    var d = dadosDe("planos"), ps = d.planos || [], podeE = pode("plano.editar"), Pl = Q.planos;
    var aba = ps.some(function (p) { return p.id === Pl.aba; }) ? Pl.aba : (ps[0] && ps[0].id), pe = ps.filter(function (p) { return p.id === aba; })[0];
    var lado = ["json", "edicao", "historico"].indexOf(Pl.lado) >= 0 ? Pl.lado : "resumo";
    h += '<div class="pv-barra-filtros">' + (ps.length > 1 ? opcoes("planos.aba", ps.map(function (p) { return [p.id, p.nome]; }), aba, false, "Plano") : "") + "</div>";
    h += guias("planos.lado", [["resumo", "Resumo"], ["edicao", "Edição"], ["json", ".JSON"], ["historico", "Histórico"]], lado, "Planos");
    if (lado === "json") return h + planosJson(ps, podeE);
    if (lado === "historico") return h + planosHist(d, podeE);
    if (lado === "edicao") return h + (podeE && pe ? planoEdicao(pe) : '<p class="nota">O papel ' + esc(U.PAPEL_NOME[A.quem.papel] || A.quem.papel) + " vê os planos, mas não edita.</p>");
    if (!pe) return h + '<div class="card pv-topo"><p class="vazio">Nenhum plano.</p></div>';
    var p = pe, cc = custoCheio(p.tokens, p.custo_modelo), mg = cc != null && p.valor ? 1 - cc / p.valor : null;
    var econ = p.valor_anual && p.valor ? 1 - p.valor_anual / (p.valor * 12) : null, fila = naFila("plano.editar", p.id);
    h += '<div class="card pv-topo">' + cardCab(esc(p.nome) + (p.id === d.padrao ? ' <span class="nf-tag">padrão</span>' : "") + (fila ? ' <span class="nf-tag pv-atencao">edição na fila</span>' : ""),
      podeE ? '<button type="button" class="link" data-pv="seg" data-seg="planos.lado" data-v="edicao">Editar ›</button>' : null) +
      '<div class="colunas pv-kpis">' + kpi("Por mês", brl(p.valor), p.id) + kpi("Por ano", p.valor_anual ? brl(p.valor_anual) : "—", econ > 0 ? Math.round(econ * 100) + "% de desconto" : "sem plano anual") +
      kpi("Assinantes", String(p.assinantes || 0), "") + "</div>" +
      '<dl class="nf-info pv-dl nf-dentro">' + fato("Créditos por mês", tok(p.tokens) + " tokens") + fato("Pessoas", String(p.pessoas || 1)) + fato("Modelo", p.modelo_nome || "—") +
      fato("Preço por milhão", brl(p.valor / (p.tokens / 1e6))) +
      fatoH("Se usar tudo, custa", cc != null ? esc(brl(cc)) + ' <span class="' + (mg >= 0.4 ? "pv-ok" : "pv-perigo") + '">margem mínima de ' + Math.round(mg * 100) + "%</span>" : '<span class="pv-mudo">' + (D["tokens:geral:mes"] && D["tokens:geral:mes"].carregando ? "carregando os preços…" : "sem os preços do provedor") + "</span>") +
      fato("Recarga", p.recarga ? brl(p.recarga.valor) + " · " + tok(p.recarga.tokens) + " tokens" : "—") + "</dl></div>";
    if ((p.itens || []).length || p.para) {
      h += h2("Na página de assinatura") + '<div class="card">' + (p.para ? '<p class="vazio pv-claro">' + esc(p.para) + (p.heranca ? " " + esc(p.heranca) + ":" : "") + "</p>" : "") +
        (p.itens || []).map(function (it) { return '<div class="item"><span class="nome"><strong>' + esc(it.titulo) + "</strong><small>" + esc(it.descricao || "") + "</small></span></div>"; }).join("") + "</div>" +
        '<p class="nota">' + (p.textos && p.textos.itens ? "Itens escritos no painel." : "Itens padrão: a página os monta com os números do plano.") + "</p>";
    }
    return h;
  };
  function planoEdicao(pe) {
    var ed = planoEd(pe), v = ed.v, fila = naFila("plano.editar", pe.id), tp = pe.textos_padrao || {};
    var vv = num(v.valor), tt = num(v.tokens) * 1e6, cc = tt ? custoCheio(tt, pe.custo_modelo) : null, mg = cc != null && vv ? 1 - cc / vv : null;
    var inv = function (k) { return ed.erros[k] ? ' aria-invalid="true"' : ""; };
    var cN = function (k, rot, cls, suf) { return '<label class="campo ' + cls + '"><span class="rotulo">' + esc(rot) + (suf ? " (" + suf + ")" : "") + '</span><input id="pv-pe-' + k + '" data-pv-in="planoEd" data-k="' + k + '" value="' + esc(v[k]) + '" inputmode="decimal"' + inv(k) + "></label>"; };
    var cT = function (k, rot, ph, cls) { return '<label class="campo ' + cls + '"><span class="rotulo">' + esc(rot) + '</span><input id="pv-pe-' + k + '" data-pv-in="planoEd" data-k="' + k + '" value="' + esc(v[k]) + '" placeholder="' + esc(ph || "") + '"' + inv(k) + "></label>"; };
    var erros = Object.keys(ed.erros).map(function (k) { return ed.erros[k]; });
    return '<div class="card pv-topo"><div class="grade">' + cT("nome", "Nome", "", "s2") + cT("para", "Frase do plano", tp.para || "vazio: o cartão sai sem frase", "s4") +
      cN("valor", "Valor por mês", "s2", "R$") + cN("anual", "Valor por ano", "s2", "R$") + cN("tokens", "Créditos por mês", "s2", "milhões") +
      cN("pessoas", "Pessoas", "s2") + cN("rv", "Recarga", "s2", "R$") + cN("rt", "Tokens da recarga", "s2", "milhões") +
      cT("heranca", "Antes dos itens", tp.heranca || "vazio: nada antes dos itens", "tudo") + "</div>" +
      '<p class="nota nf-dentro">' + (tt ? esc(brl(vv / (tt / 1e6))) + " por milhão de tokens." : "Preencha valor e créditos.") +
      (cc != null ? ' <span class="' + (mg >= 0.4 ? "pv-ok" : "pv-perigo") + '">Se o assinante usar tudo, custa ' + esc(brl(cc)) + ": margem mínima de " + Math.round(mg * 100) + "%.</span>" : "") + "</p></div>" +
      h2("Itens na página de assinatura", '<button type="button" class="btn mini" data-pv="planoItemMais">Mais um item</button>') +
      '<div class="card">' + (ed.itens.length ? ed.itens.map(function (it, k) {
        return '<div class="pv-ed-item"><div class="pv-card-cab"><span class="pv-mudo">' + (k + 1) + '</span><span class="pv-par">' +
          '<button type="button" class="btn mini" data-pv="planoItemMover" data-i="' + k + '" data-d="-1"' + (k ? "" : " disabled") + ' aria-label="Subir o item">Subir</button>' +
          '<button type="button" class="btn mini" data-pv="planoItemMover" data-i="' + k + '" data-d="1"' + (k < ed.itens.length - 1 ? "" : " disabled") + ' aria-label="Descer o item">Descer</button>' +
          '<button type="button" class="btn mini perigo" data-pv="planoItemTirar" data-i="' + k + '">Tirar</button></span></div>' +
          '<div class="grade"><label class="campo tudo"><span class="rotulo">Título</span><input id="pv-pi-t-' + k + '" data-pv-in="planoItem" data-i="' + k + '" data-k="titulo" value="' + esc(it.titulo) + '"></label>' +
          '<label class="campo tudo"><span class="rotulo">Descrição</span><textarea id="pv-pi-d-' + k + '" data-pv-in="planoItem" data-i="' + k + '" data-k="descricao" rows="2">' + esc(it.descricao || "") + "</textarea></label></div></div>";
      }).join("") : vazio("Sem itens escritos: a página usa os itens padrão.")) + "</div>" +
      (erros.length ? '<p class="erro pv-topo" role="alert">' + esc(erros.join("; ")) + "</p>" : "") +
      '<p class="nota">A cobrança é da Atos: o valor daqui não muda o que a Atos já cobra de quem assina. Pessoas e recarga valem no Paulus. A frase, o texto antes dos itens e os itens vão para a página de assinatura; vazio, ou igual ao padrão, fica o padrão, que acompanha os números do plano.</p>' +
      '<div class="botoes pv-botoes-fora"><button type="button" class="btn p" data-pv="planoDesfazer">Desfazer</button><button type="button" class="btn p primario" data-pv="planoSalvar"' + dis(fila, "já está na fila de alterações") + ">Pôr " + esc(pe.nome) + " na fila</button></div>";
  }
  function planosJson(ps, podeE) {
    var atual = planosAtuais(ps), t = Q.planos.json != null ? Q.planos.json : atual, mudou = t !== atual, erro = mudou ? validaPlanos(t) : null, fila = naFila("planos.json", "IA_PLANOS");
    return '<div class="card pv-topo">' + cardCab("IA_PLANOS", '<span class="pv-par"><button type="button" class="btn mini" data-pv="planosBaixar">Baixar .json</button>' +
      (podeE ? '<label class="btn mini pv-arquivo">Carregar arquivo<input type="file" accept=".json,application/json" data-pv-in="planosArquivo"></label>' : "") +
      '<button type="button" class="btn mini" data-pv="planosCopiar">Copiar</button></span>') +
      '<textarea id="pv-planos-json" class="pv-json" spellcheck="false" data-pv-in="planosJson"' + (podeE && !fila ? "" : " readonly") + (erro ? ' aria-invalid="true"' : "") + ">" + esc(t) + "</textarea>" +
      (podeE ? '<div class="botoes"><span id="pv-json-st" class="dica' + (erro ? " pv-perigo" : "") + '">' + esc(fila ? "Há uma alteração do IA_PLANOS na fila." : erro || (mudou ? "Alterado: confira e ponha na fila." : "Igual ao que está no ar.")) + "</span>" +
        '<span class="direita pv-par"><button type="button" class="btn mini" id="pv-json-desfazer" data-pv="planosRestaurar"' + (mudou ? "" : " disabled") + '>Desfazer</button><button type="button" class="btn mini" id="pv-json-salvar" data-pv="planosSalvarJson"' + (mudou && !erro && !fila ? "" : " disabled") + ">Pôr na fila</button></span></div>" : "") + "</div>";
  }
  function planosStatus() {
    var ps = (dadosDe("planos") || {}).planos || [], atual = planosAtuais(ps), t = Q.planos.json, mudou = t != null && t !== atual, erro = mudou ? validaPlanos(t) : null;
    var st = document.getElementById("pv-json-st"), b = document.getElementById("pv-json-salvar"), r = document.getElementById("pv-json-desfazer"), ta = document.getElementById("pv-planos-json");
    if (st) { st.textContent = erro || (mudou ? "Alterado: confira e ponha na fila." : "Igual ao que está no ar."); st.classList.toggle("pv-perigo", Boolean(erro)); }
    if (b) b.disabled = !mudou || Boolean(erro);
    if (r) r.disabled = !mudou;
    if (ta) { if (erro) ta.setAttribute("aria-invalid", "true"); else ta.removeAttribute("aria-invalid"); }
  }
  function planosHist(d, podeE) {
    var vs = (d.versoes || []).slice().sort(function (a, b) { return b.n - a.n; }), ab = Q.planos.versao;
    if (!vs.length) return '<div class="card pv-topo"><p class="vazio">Ainda não há versões salvas.</p></div>';
    return '<div class="card pv-topo">' + cardCab("Versões do IA_PLANOS", plural(vs.length, "versão", "versões")) + vs.map(function (v, k) {
      var aberta = String(ab) === String(v.n);
      return '<button type="button" class="item pv-item-btn" data-pv="planoVersao" data-n="' + v.n + '" aria-expanded="' + aberta + '"><span class="pv-mudo pv-num">v' + v.n + '</span><span class="nome"><strong>' + esc(v.resumo) + "</strong><small>" + esc(v.quem) + " · " + esc(ddmmaaaa(v.quando)) + (dt(v.quando) ? " " + esc(hm(dt(v.quando))) : "") + "</small></span>" +
        (k === 0 ? '<span class="nf-tag">no ar</span>' : "") + "</button>" +
        (aberta ? '<div class="nf-det"><pre class="pv-json pv-pre">' + esc(JSON.stringify(v.planos, null, 2)) + "</pre>" +
          (k > 0 && podeE ? '<div class="botoes"><span class="dica">Vai para a guia .JSON; nada muda até você pôr na fila.</span><button type="button" class="btn mini direita" data-pv="planoUsarVersao" data-n="' + v.n + '">Usar esta versão</button></div>' : "") + "</div>" : "");
    }).join("") + "</div>";
  }

  /* ---------- Disparo de e-mails ---------- */
  var SIT_CAMP = { enviada: "ok", agendada: "atencao", "na fila": "atencao", enviando: "atencao", rascunho: "mudo", cancelada: "mudo" };
  var LINKS_BOTAO = [["Abrir o Paulus", "https://paulus.ia.br/"], ["Planos e preços", "https://paulus.ia.br/assinatura/"], ["Termos de uso", "https://paulus.ia.br/termos-de-uso/"], ["Política de privacidade", "https://paulus.ia.br/politica-de-privacidade/"]];
  function publicosLista() {
    var d = dadosDe("campanhas") || {}, l = (d.publicos || []).slice(), es = Q.emails.escolhidas || [];
    l.push({ id: "escolhidas", label: "Escolher contas", sub: "busque e adicione uma a uma", n: es.length, gmail: es.filter(function (c) { return /@gmail\.com$/i.test(c.email || ""); }).length });
    return l;
  }
  function publicoAtual() { var l = publicosLista(), id = Q.emails.camp.publico; return l.filter(function (p) { return p.id === id; })[0] || null; }
  // Os campos {nome} {escritorio}... ficam a mostra, marcados: cada conta recebe os dela.
  function trocaCampos(t) { return esc(t).replace(/\{(nome|escritorio|plano|vence_em)\}/g, function (m) { return '<span class="pv-campo-livre">' + m + "</span>"; }); }
  TELAS_RENDER.emails = function () {
    var E = Q.emails, d = dadosDe("campanhas"), cs = d ? d.campanhas || [] : [];
    var h = cab("Campanhas de e-mail", "E-mails do PAVLVS para as contas: escreva, escolha quem recebe e envie agora ou agende. As mensagens saem aos poucos, em lotes por minuto.");
    h += guias("emails.aba", [["campanhas", "Campanhas"], ["nova", "Nova campanha"], ["publicos", "Públicos"]], E.aba, "Campanhas");
    var est = estadoLeitura(["campanhas"], "emails"); if (est) return h + est;
    var envio = d.envio && d.envio.ligado === false ? d.envio : cfg("email"), envioOff = desligado(envio);
    h += falta(envio) + erroRecente("campanhas", "emails");
    if (E.aba === "campanhas") {
      var st = d.stats || {}, env = cs.filter(function (c) { return c.situacao === "enviada"; }).length;
      h += '<div class="card pv-topo"><div class="colunas pv-kpis">' + kpi("Enviados", String(st.enviados || 0), plural(env, "campanha enviada", "campanhas enviadas")) + kpi("Abertura", taxa(st.abertura), "") + kpi("Cliques", taxa(st.cliques), "") + kpi("Devolvidos", String(st.devolvidos || 0), "") + "</div></div>";
      var linhas = cs.map(function (c) {
        var n = Number(c.enviados) || 0, fC = naFila("campanha.cancelar", c.id);
        var cancelar = c.situacao === "agendada" ? '<button type="button" class="btn mini" data-pv="campCancelar" data-id="' + esc(c.id) + '"' + dis(fC, "o cancelamento já está na fila de alterações") + ">" + (fC ? "Na fila" : "Cancelar") + "</button>" : "<span></span>";
        return '<div class="pv-tr pv-c-camp"><span class="nf-cel"><strong>' + esc(c.nome) + "</strong>" + sit(fC ? "agendada · cancelamento na fila" : c.situacao, SIT_CAMP[c.situacao]) + "</span>" +
          '<span class="pv-corta">' + esc(c.publico ? c.publico.label : "—") + '</span><span class="pv-num dir">' + (n || "—") + '</span><span class="pv-num dir">' + (n ? pct((c.abertos || 0) / n) : "—") + "</span>" +
          '<span class="pv-num dir">' + (n ? pct((c.cliques || 0) / n) : "—") + '</span><span class="pv-num dir pv-mudo">' + esc(c.situacao === "enviada" ? ddmm(c.quando) : quando(c.quando)) + "</span>" + cancelar + "</div>";
      }).join("") || vazio("Nenhuma campanha ainda.");
      return h + tabela("pv-c-camp", '<span>Campanha</span><span>Público</span><span class="dir">Enviados</span><span class="dir">Abertura</span><span class="dir">Cliques</span><span class="dir">Quando</span><span></span>', linhas) +
        '<div class="botoes pv-botoes-fora"><button type="button" class="btn p primario" data-pv="seg" data-seg="emails.aba" data-v="nova">Nova campanha</button></div>';
    }
    if (E.aba === "publicos") {
      return h + tabela("pv-c-pub", '<span>Público</span><span class="dir">Contas</span><span class="dir">No Gmail</span><span></span>', publicosLista().map(function (p) {
        return '<div class="pv-tr pv-c-pub"><span class="nf-cel"><strong>' + esc(p.label) + "</strong>" + (p.sub ? "<small>" + esc(p.sub) + "</small>" : "") + '</span><span class="pv-num dir">' + (p.n || 0) + '</span><span class="pv-num dir">' + (p.gmail || 0) + "</span>" +
          '<span class="dir"><button type="button" class="btn mini" data-pv="usarPublico" data-id="' + esc(p.id) + '">Usar numa campanha</button></span></div>';
      }).join("")) + '<p class="nota">Cada público é montado com as contas cadastradas, pela situação da assinatura, pelo plano e por usar ou não o Gmail.</p>';
    }
    // Nova campanha, em tres passos
    var c = E.camp, pub = publicoAtual(), n = pub ? pub.n || 0 : 0;
    h += '<div class="opcoes pv-topo" role="group" aria-label="Passos">' + ["Público", "Conteúdo", "Revisar"].map(function (t, i) {
      return '<button type="button" data-pv="passo" data-n="' + (i + 1) + '" aria-pressed="' + (E.passo === i + 1) + '"' + (E.passo === i + 1 ? ' aria-current="step"' : "") + ">" + (i + 1) + ". " + t + "</button>";
    }).join("") + "</div>";
    var esq;
    if (E.passo === 1) {
      esq = '<div class="card" role="radiogroup" aria-label="Quem recebe">' + cardCab("Quem recebe") + publicosLista().map(function (p) {
        var on = pub && p.id === pub.id;
        return '<button type="button" class="item pv-item-btn" role="radio" aria-checked="' + Boolean(on) + '" data-pv="escolherPublico" data-id="' + esc(p.id) + '"><span class="pv-radio" aria-hidden="true"></span><span class="nome"><strong>' + esc(p.label) + "</strong><small>" +
          (p.id === "escolhidas" ? (Q.emails.escolhidas.length ? "clique para mudar a lista" : "clique para escolher") : (p.gmail || 0) + " no Gmail") + '</small></span><span class="pv-num">' + (p.n || 0) + "</span></button>";
      }).join("") + "</div>";
    } else if (E.passo === 2) {
      var er = E.erros, inv = function (k) { return er[k] ? ' aria-invalid="true"' : ""; };
      var campo = function (k, rot, ph, cls) { return '<label class="campo ' + (cls || "tudo") + '"><span class="rotulo">' + esc(rot) + '</span><input id="pv-camp-' + k + '" data-pv-in="camp" data-k="' + k + '" value="' + esc(c[k]) + '" placeholder="' + esc(ph || "") + '" spellcheck="false"' + inv(k) + "></label>"; };
      var pre = LINKS_BOTAO.filter(function (l) { return l[1] === c.link; })[0], outro = E.outroLink || !pre;
      esq = '<div class="card">' + cardCab("Conteúdo") + '<div class="grade">' + campo("nome", "Nome da campanha (interno)", "Lembrete · outubro") + campo("assunto", "Assunto", "Um aviso para o {escritorio}") +
        campo("pre", "Pré-cabeçalho", "o texto cinza que aparece ao lado do assunto") + campo("titulo", "Título", "Novidade no plano {plano}") +
        '<label class="campo tudo"><span class="rotulo">Texto</span><textarea id="pv-camp-texto" rows="6" data-pv-in="camp" data-k="texto" placeholder="Olá, {nome}."' + inv("texto") + ">" + esc(c.texto) + "</textarea></label>" +
        campo("botao", "Texto do botão", "", "s3") +
        '<label class="campo s3"><span class="rotulo">Link do botão</span><select class="seletor" id="pv-camp-linksel" data-pv-in="campLink">' + LINKS_BOTAO.map(function (l) { return '<option value="' + esc(l[1]) + '"' + (!outro && pre[1] === l[1] ? " selected" : "") + ">" + esc(l[0]) + "</option>"; }).join("") +
        '<option value=""' + (outro ? " selected" : "") + ">Outro link…</option></select></label>" +
        (outro ? campo("link", "Outro link", "https://") : "") + "</div>" +
        (Object.keys(er).length ? '<p class="erro nf-dentro" role="alert">' + esc(Object.keys(er).map(function (k) { return er[k]; }).join("; ")) + "</p>" : "") +
        '<p class="dica nf-dentro">Campos: {nome}, {escritorio}, {plano}, {vence_em}</p></div>';
    } else {
      var de = (d.envio && d.envio.de) || "—", ritmo = Number(d.envio && d.envio.ritmo) || 50, erQ = E.erros.quando;
      esq = '<div class="card">' + cardCab("Revisar") + '<dl class="nf-info pv-dl nf-dentro">' + fato("Público", pub ? pub.label + " · " + n : "—") + fato("Assunto", c.assunto || "(sem assunto)") +
        fato("De", de) + fato("Botão", (c.botao || "—") + " → " + (c.link || "—")) + fato("Ritmo", ritmo + " por minuto · " + Math.max(1, Math.ceil(n / ritmo)) + " min") + "</dl>" +
        '<div class="grade"><div class="campo s2"><span class="rotulo">Quando</span>' + opcoes("camp.quando", [["agora", "Agora"], ["agendado", "Agendar"]], c.quando, false, "Quando") + "</div>" +
        (c.quando === "agendado" ? '<label class="campo s2"><span class="rotulo">Dia (horário de Brasília)</span><input type="date" class="seletor" id="pv-camp-de" data-pv-in="camp" data-k="de" value="' + esc(c.de) + '" min="' + isoDia(new Date()) + '"' + (erQ ? ' aria-invalid="true"' : "") + "></label>" +
          '<label class="campo s2"><span class="rotulo">Hora</span><input type="time" class="seletor" id="pv-camp-hora" data-pv-in="camp" data-k="hora" value="' + esc(c.hora) + '" step="300"' + (erQ ? ' aria-invalid="true"' : "") + "></label>" : "") + "</div>" +
        (erQ ? '<p class="erro nf-dentro" role="alert">' + esc(erQ) + "</p>" : "") +
        '<div class="botoes"><button type="button" class="btn mini" data-pv="enviarTeste"' + dis(envioOff, envio.falta) + ">Mandar um teste para mim</button></div></div>";
    }
    esq += '<div class="botoes pv-botoes-fora">' + (E.passo > 1 ? '<button type="button" class="btn p" data-pv="passo" data-n="' + (E.passo - 1) + '">‹ Voltar</button>' : "") +
      (E.passo < 3 ? '<button type="button" class="btn p primario direita" data-pv="passo" data-n="' + (E.passo + 1) + '">Avançar para ' + (E.passo === 1 ? "Conteúdo" : "Revisar") + " ›</button>"
        : '<button type="button" class="btn p primario direita" data-pv="pedirDisparo"' + dis(envioOff || !n, envioOff ? envio.falta : "público vazio") + ">Pôr o disparo na fila</button>") + "</div>";
    var dir = '<div class="card">' + cardCab("Prévia", esc("para " + (pub ? pub.label : "—"))) + '<div class="pv-previa">' +
      '<p class="pv-previa-cab"><strong>' + (trocaCampos(c.assunto) || "Assunto do e-mail") + "</strong><span>" + (trocaCampos(c.pre) || "pré-cabeçalho") + "</span></p>" +
      '<div class="pv-previa-corpo"><span class="pv-previa-marca">PAVLVS</span><h3>' + (trocaCampos(c.titulo) || "Título do e-mail") + "</h3><p>" + (trocaCampos(c.texto) || "O texto que você escrever em Conteúdo aparece aqui.") + "</p>" +
      '<span class="btn p primario pv-previa-botao" aria-hidden="true">' + esc(c.botao || "Botão") + "</span>" +
      '<small>PAVLVS · ' + esc((d.envio && d.envio.de) || "") + " · Este e-mail é automático e não recebe respostas.</small></div></div></div>";
    return h + '<div class="pv-duas pv-topo"><div class="pv-pilha">' + esq + "</div>" + dir + "</div>";
  };
  function dadosCampanha() {
    var c = Q.emails.camp, pub = publicoAtual();
    return { nome: c.nome.trim() || c.assunto.trim(), publico: pub ? pub.id : "", contas: pub && pub.id === "escolhidas" ? Q.emails.escolhidas.map(function (x) { return x.id; }) : undefined,
      assunto: c.assunto, pre: c.pre, titulo: c.titulo, texto: c.texto, botao: c.botao, link: c.link, quando: c.quando,
      de: c.quando === "agendado" ? c.de : undefined, hora: c.quando === "agendado" ? c.hora : undefined };
  }
  function conferirCampanha() {
    var c = Q.emails.camp, er = {};
    if (!c.assunto.trim()) er.assunto = "escreva o assunto";
    if (!c.texto.trim()) er.texto = "escreva o texto";
    if (c.link && !/^https?:\/\/[^\s]+\.[^\s]+$/.test(c.link)) er.link = "o link começa com https://";
    Q.emails.erros = er;
    return !Object.keys(er).length;
  }

  /* ================================================================ os pop-ups */

  function abrirModal(m, classe) { MP = m; A.modal.abrir({ html: modalHtml, classe: classe || "", busca: m.tipo === "busca", aoFechar: function () { MP = null; } }); }
  function modalHtml() {
    if (!MP) return "";
    var M = MP, t = function (x) { return '<h2 id="modal-titulo">' + esc(x) + "</h2>"; };
    if (M.tipo === "google") return t("Permissões do Google") + googleCartao(M.G, "modal");
    if (M.tipo === "tunelHist") return t("Histórico · " + M.slug + ".paulus.ia.br") + '<ul class="nf-passos pv-hist">' + (M.itens.length ? M.itens.map(function (x) { return "<li><span>" + esc(ddmmaaaa(x.quando)) + "</span><span>" + esc(x.texto) + "</span><span></span></li>"; }).join("") : "<li><span>—</span><span>Sem eventos registrados.</span><span></span></li>") + "</ul>" +
      '<div class="botoes"><button type="button" class="btn p primario" data-admin="fechar-modal">Fechar</button></div>';
    if (M.tipo === "campCancelar") return t("Cancelar o envio") + "<p>A campanha <strong>" + esc(M.nome) + "</strong>, agendada para " + esc(quando(M.quando)) + ", não sai mais. O cancelamento entra na fila e vale quando você confirmar as alterações; se a hora chegar antes disso, ela sai.</p>" +
      '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Voltar</button><button type="button" class="btn p perigo" data-pv="campCancelarOk" data-foco>Pôr o cancelamento na fila</button></div>';
    if (M.tipo === "endereco") {
      var ch = M.check, livres = ((dadosDe("tuneis") || {}).livres || []);
      return t("Alterar endereço") + "<p>Endereço atual: <strong>" + esc(M.slug) + ".paulus.ia.br</strong></p>" +
        '<label class="campo"><span class="rotulo">Endereço novo (.paulus.ia.br)</span><input id="pv-slug" data-pv-in="slugNovo" value="' + esc(M.novo) + '" placeholder="nome-do-escritorio" spellcheck="false" autocapitalize="none" maxlength="24"' + (ch && !ch.ok && !ch.esperando && M.tocado ? ' aria-invalid="true"' : "") + "></label>" +
        '<p class="dica" id="pv-slug-msg" aria-live="polite">' + (ch ? '<span class="' + (ch.ok ? "pv-ok" : ch.esperando ? "pv-mudo" : "pv-perigo") + '">' + esc(ch.msg) + "</span>" : "3 a 24 letras minúsculas, números e hífen") + "</p>" +
        (livres.length ? '<div class="pv-chips"><span class="rotulo">Livres</span>' + livres.map(function (l) { return '<button type="button" class="btn mini" data-pv="usarLivre" data-v="' + esc(l) + '">' + esc(l) + "</button>"; }).join("") + "</div>" : "") +
        "<p>O endereço antigo sai do ar e fica livre para outro escritório; o novo é criado no mesmo túnel, sem reinstalar nada; o Paulus do escritório passa a usar o novo na próxima conexão.</p>" +
        '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button><button type="button" class="btn p primario" data-pv="enderecoOk"' + (ch && ch.ok ? "" : " disabled") + ">Pôr a troca na fila</button></div>";
    }
    if (M.tipo === "escContas") {
      var todas = (dadosDe("contas") || {}).contas, qn = norm(M.q || "");
      var fora = (todas || []).filter(function (c) { return !M.sel[c.id] && (!qn || norm([c.nome, c.email, c.escritorio && c.escritorio.nome].join(" ")).indexOf(qn) >= 0); });
      var dentro = Object.keys(M.sel).filter(function (k) { return M.sel[k]; }).map(function (k) { return (todas || []).concat(Q.emails.escolhidas).filter(function (x) { return String(x.id) === k; })[0]; }).filter(Boolean);
      var op = function (c, ja) { return '<button type="button" class="item pv-item-btn" data-pv="escMarcar" data-id="' + esc(c.id) + '"><span class="nome"><strong>' + esc(c.nome) + "</strong><small>" + esc([c.email, c.escritorio && c.escritorio.nome].filter(Boolean).join(" · ")) + '</small></span><span class="pv-mudo">' + (ja ? "tirar" : "pôr") + "</span></button>"; };
      return t("Escolher contas") + '<div class="pv-duas pv-esc"><div><input class="seletor pv-busca-campo" id="pv-escm-q" data-pv-in="escmQ" value="' + esc(M.q || "") + '" placeholder="nome, e-mail ou escritório" autocomplete="off" aria-label="Buscar contas">' +
        '<div class="card pv-esc-lista">' + (!todas ? vazio("Carregando contas…") : fora.length ? fora.slice(0, 200).map(function (c) { return op(c, false); }).join("") : vazio(qn ? "Nenhuma conta com esse texto." : "Todas as contas já estão na lista.")) + "</div></div>" +
        '<div><span class="titulo-secao">Recebem · ' + dentro.length + '</span><div class="card pv-esc-lista">' + (dentro.length ? dentro.map(function (c) { return op(c, true); }).join("") : vazio("Clique numa conta para ela entrar aqui.")) + "</div></div></div>" +
        '<div class="botoes"><button type="button" class="btn p" data-admin="fechar-modal">Cancelar</button><button type="button" class="btn p primario" data-pv="escConfirmar">' + (dentro.length ? "Usar " + plural(dentro.length, "conta", "contas") : "Sem contas") + "</button></div>";
    }
    if (M.tipo === "busca") return buscaHtml();
    return "";
  }

  /* ---------- a busca (Ctrl K) ---------- */
  var NOME_GRUPO = { contas: "Contas", escritorios: "Escritórios", tuneis: "Túneis", planos: "Planos" };
  var itensBusca = [];
  function rapidas() {
    var l = [];
    l.push({ t: "E-mails › Nova campanha", d: "público, conteúdo e disparo em 3 passos", ir: function () { Q.emails.aba = "nova"; Q.emails.passo = 1; irPara("emails"); } });
    l.push({ t: "Confirmar alterações", d: (fila() ? fila().pendentes.length : 0) + " pendentes", ir: function () { A.navegar("alteracoes"); } });
    l.push({ t: "Túneis › Perto de apagar", d: "os que a limpeza diária vai pegar", ir: function () { Q.tuneis.filtro = "risco"; irPara("tuneis"); } });
    l.push({ t: "Não renovações › Abertas", d: "ciclos sem renovação", ir: function () { irPara("renovacoes"); } });
    return l;
  }
  function gruposBusca() {
    var B = MP, q = norm(B.q.trim());
    if (!q) return [["Ações rápidas", rapidas()]];
    var bate = function (t) { return norm(t).indexOf(q) >= 0; }, g = [];
    var telas = A.secoes.filter(function (s) { return bate(s.nome); }).map(function (s) { return { t: s.nome, d: "seção · " + (s.grupo || "Atos"), ir: function () { A.navegar(s.id); } }; });
    if (telas.length) g.push(["Seções", telas]);
    var ac = rapidas().filter(function (r) { return bate(r.t + " " + r.d); });
    if (ac.length) g.push(["Ações", ac]);
    var res = B.res || {};
    ["contas", "escritorios", "tuneis", "planos"].forEach(function (k) {
      var it = (res[k] || []).slice(0, 6).map(function (x) { return { t: NOME_GRUPO[k] + " › " + x.titulo, d: x.desc, ir: function () { abrirResultado(k, x); } }; });
      if (it.length) g.push([NOME_GRUPO[k] + " do PAVLVS", it]);
    });
    return g;
  }
  function abrirResultado(k, x) {
    if (k === "contas") { abrirConta(x.alvo); return; }
    if (k === "escritorios") { Q.contas.agrupar = "escritorio"; Q.contas.q = x.titulo || ""; Q.contas.filtro = "todas"; irPara("contas"); return; }
    if (k === "tuneis") { Q.tuneis.filtro = "todos"; Q.tuneis.aberto = x.alvo; irPara("tuneis"); return; }
    if (k === "planos") { Q.planos.aba = x.alvo; Q.planos.lado = "resumo"; irPara("planos"); return; }
    if (TELA[x.tela]) irPara(x.tela);
  }
  function buscaHtml() {
    var B = MP, gr = gruposBusca(), n = 0, total = gr.reduce(function (s, g) { return s + g[1].length; }, 0);
    itensBusca = [];
    if (B.idx >= total) B.idx = Math.max(0, total - 1);
    var corpo = gr.map(function (g) {
      return '<p class="titulo-secao pv-busca-grupo">' + esc(g[0]) + "</p>" + g[1].map(function (r) {
        var i = n++; itensBusca.push(r);
        return '<button type="button" class="item pv-item-btn pv-busca-item" role="option" id="pv-bi-' + i + '" aria-selected="' + (i === B.idx) + '" data-pv="buscaIr" data-i="' + i + '" tabindex="-1"><span class="nome"><strong>' + esc(r.t) + "</strong><small>" + esc(r.d || "") + '</small></span><span class="seta">›</span></button>';
      }).join("");
    }).join("");
    var q = B.q.trim();
    if (q && !total) corpo += vazio(B.carregando ? "Buscando…" : "Nada com “" + esc(q) + "”. Tente o nome de uma conta, um escritório ou uma seção.");
    if (q && B.erro) corpo += '<p class="erro">Não consegui buscar no PAVLVS agora: ' + esc(B.erro) + "</p>";
    return '<h2 id="modal-titulo" class="pv-so-leitor">Buscar em tudo</h2><input class="seletor pv-busca-q" id="pv-busca-q" data-pv-in="buscaQ" value="' + esc(B.q) + '" placeholder="Seções, ações, contas, escritórios, túneis, planos…" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="pv-busca-lista" aria-activedescendant="pv-bi-' + B.idx + '" data-foco>' +
      '<div class="card pv-busca-res" id="pv-busca-lista" role="listbox" aria-label="Resultados">' + corpo + "</div>" +
      '<p class="dica">↑ ↓ para navegar · Enter para abrir · Esc para fechar</p>';
  }
  var tempoBusca = null;
  function buscar() {
    var B = MP, q = B.q.trim();
    clearTimeout(tempoBusca);
    if (q.length < 2) { B.res = null; B.erro = ""; B.carregando = false; return; }
    B.carregando = true;
    tempoBusca = setTimeout(function () {
      var seq = ++B.seq;
      A.pedir("GET", P + "busca?q=" + encodeURIComponent(q)).then(function (r) { if (seq === B.seq) { B.res = r; B.erro = ""; } }, function (e) { if (seq === B.seq) { B.res = null; B.erro = e.status === 401 ? "" : e.message; } })
        .then(function () { if (seq === B.seq && MP === B) { B.carregando = false; A.modal.repintar(); } });
    }, 200);
  }
  function marcarBusca(i) {
    MP.idx = i;
    document.querySelectorAll(".pv-busca-item").forEach(function (b) { b.setAttribute("aria-selected", String(Number(b.getAttribute("data-i")) === i)); });
    var inp = document.getElementById("pv-busca-q"); if (inp) inp.setAttribute("aria-activedescendant", "pv-bi-" + i);
    var at = document.getElementById("pv-bi-" + i); if (at && at.scrollIntoView) at.scrollIntoView({ block: "nearest" });
  }
  A.buscador = { area: "pavlvs", abrir: function () { abrirModal({ tipo: "busca", q: "", idx: 0, res: null, erro: "", carregando: false, seq: 0 }, "largo pv-busca"); } };

  /* ================================================================ acoes */

  function irPara(id) {
    if (MP) A.modal.fechar();
    if (A.secaoAtual() === id) { render(); window.scrollTo(0, 0); } else A.navegar(id);
  }
  function naHora(metodo, caminho, corpo, ok) {
    return A.pedir(metodo, caminho, corpo).then(function (r) { if (ok) A.toast(ok); return r || {}; }, function (e) { if (e.status !== 401) A.toast(e.message, true); return null; });
  }
  var conferindoSlug = null;
  function conferirSlug() {
    var M = MP, s = M.novo.trim().toLowerCase(), motivo = "";
    clearTimeout(conferindoSlug);
    if (!s) { M.check = null; return; }
    if (s.length < 3) motivo = "use pelo menos 3 letras";
    else if (s.length > 24) motivo = "use no máximo 24 letras";
    else if (!/^[a-z0-9-]+$/.test(s)) motivo = "só letras minúsculas sem acento, números e hífen";
    else if (/^-|-$/.test(s)) motivo = "não comece nem termine com hífen";
    else if (s === M.slug) motivo = "é o endereço de agora";
    if (motivo) { M.check = { msg: motivo, ok: false }; return; }
    M.check = { msg: "conferindo…", ok: false, esperando: true };
    var seq = ++M.seq;
    conferindoSlug = setTimeout(function () {
      A.pedir("GET", P + "tuneis/disponivel?nome=" + encodeURIComponent(s)).then(function (r) {
        if (MP !== M || seq !== M.seq) return;
        M.check = r.ok ? { msg: "disponível", ok: true } : { msg: r.motivo || "já em uso", ok: false };
        A.modal.repintar();
      }, function (e) {
        if (MP !== M || seq !== M.seq || e.status === 401) return;
        M.check = { msg: "não consegui conferir: " + e.message, ok: false };
        A.modal.repintar();
      });
    }, 250);
  }
  function renovPor(id) { return (((dadosDe("renovacoes") || {}).abertas) || []).filter(function (x) { return String(x.id) === String(id); })[0]; }
  function emMassa(ids, caminho, fim) {
    var ok = 0, i = 0;
    var passo = function () {
      if (i >= ids.length) { fim(ok); return; }
      A.pedir("POST", P + "renovacoes/" + encodeURIComponent(ids[i++]) + "/" + caminho, {}).then(function () { ok++; }, function () { /* segue */ }).then(passo);
    };
    passo();
  }

  var X = {};
  X.reler = function () { var t = R.secao; leiturasDa(t).forEach(function (ch) { if (D[ch]) D[ch].erro = null; ler(ch); }); render(); };
  X.seg = function (b) {
    var n = b.getAttribute("data-seg"), v = b.getAttribute("data-v");
    if (n === "tokens.visao") { Q.tokens.visao = v; Q.tokens.sel = null; if (Q.tokens.periodo !== "custom" || (Q.tokens.de && Q.tokens.ate)) ler(tokensChave()); }
    else if (n === "tokens.periodo") { Q.tokens.periodo = v; Q.tokens.sel = null; if (v !== "custom") ler(tokensChave()); }
    else if (n === "planos.aba") { Q.planos.aba = v; Q.planos.ed = null; }
    else if (n === "planos.lado") Q.planos.lado = v;
    else if (n === "conta.aba") { Q.contas.aba = v; if (v === "tunel" && !dadosDe("tuneis")) ler("tuneis"); }
    else if (n === "ext.tipo") Q.contas.ext.tipo = v;
    else if (n === "ext.periodo") Q.contas.ext.periodo = v;
    else if (n === "camp.quando") { Q.emails.camp.quando = v; delete Q.emails.erros.quando; }
    else if (n === "emails.aba") { Q.emails.aba = v; if (v === "nova") Q.emails.passo = Q.emails.passo || 1; }
    else { var p = n.split("."); if (Q[p[0]]) Q[p[0]][p[1]] = v; if (n === "tuneis.filtro") Q.tuneis.sel = null; }
    render();
  };
  X.irTela = function (b) {
    var t = b.getAttribute("data-tela"), f = b.getAttribute("data-filtro");
    if (!TELA[t]) return;
    if (f && Q[t] && "filtro" in Q[t]) Q[t].filtro = f;
    irPara(t);
  };
  X.visaoMais = function () { Q.visao.todas = !Q.visao.todas; render(); };
  // a selecao de varias linhas
  X.selEntrar = function (b) { Q[b.getAttribute("data-tela")].sel = {}; render(); };
  X.selSair = function (b) { Q[b.getAttribute("data-tela")].sel = null; render(); };
  X.marcar = function (b) { var S = Q[b.getAttribute("data-tela")].sel; if (!S) return; var id = b.getAttribute("data-id"); S[id] = !S[id]; render(); };
  X.selTodas = function (b) {
    var t = b.getAttribute("data-tela"), S = Q[t].sel = {};
    if (t === "google") ((dadosDe("contas") || {}).contas || []).forEach(function (c) { if (c.google && !naFila("google.desvincular", c.id)) S[c.id] = true; });
    if (t === "renovacoes") (((dadosDe("renovacoes") || {}).abertas) || []).forEach(function (r) { S[r.id] = true; });
    if (t === "tokens") (((dadosDe(tokensChave()) || {}).linhas) || []).forEach(function (l) { S[l.nome] = true; });
    render();
  };
  // contas
  X.abrirConta = function (b) { abrirConta(b.getAttribute("data-id")); };
  X.voltarContas = function () { Q.contas.aberta = null; Q.contas.det = null; render(); window.scrollTo(0, 0); };
  X.contaCreditar = function () {
    var c = Q.contas.det; if (!c) return;
    enfileirar("contas", "conta.creditar", c.id, { id: c.id, tokens: 10000000 }, "Creditei 10M tokens de cortesia para " + c.nome);
  };
  X.instDesvincular = function (b) {
    var c = Q.contas.det; if (!c) return;
    var h8 = b.getAttribute("data-hash");
    enfileirar("contas", "conta.instalacao.apagar", c.id + ":" + h8, { id: c.id, hash8: h8 }, "Desvinculei a instalação " + b.getAttribute("data-inst") + " de " + c.nome);
  };
  X.copiar = function (b) {
    var t = b.getAttribute("data-t") || "";
    if (!navigator.clipboard) { A.toast("o navegador não deixou copiar", true); return; }
    navigator.clipboard.writeText(t).then(function () { A.toast("Copiado"); }, function () { A.toast("o navegador não deixou copiar", true); });
  };
  X.extratoJson = function () {
    var C = Q.contas, det = C.det; if (!det) return;
    var c = det, ls = itensExtrato(c, det).map(function (x) {
      return { data: (x.quando || "").slice(0, 10), descricao: descPag(x, c), modalidade: MODALIDADE[x.tipo] || null, valor: Number(x.valor) || 0,
        situacao: (SIT_FAT[x.reembolso ? "reembolsado" : (x.situacao || "pago")] || [x.situacao])[0], nfse: x.nfse ? { numero: x.nfse.numero, estado: x.nfse.estado } : null, ref: x.ref };
    });
    baixar("extrato-" + det.id + ".json", JSON.stringify({ conta: { id: det.id, nome: det.nome, email: det.email }, gerado: new Date().toISOString(), filtro: C.ext, pagamentos: ls }, null, 2));
  };
  // O PDF sai pela impressao do navegador: a folha de impressao (admin.css) so mostra o extrato.
  X.extratoImprimir = function () {
    document.body.classList.add("pv-imprimindo");
    var tirar = function () { document.body.classList.remove("pv-imprimindo"); window.removeEventListener("afterprint", tirar); };
    window.addEventListener("afterprint", tirar);
    window.print();
    setTimeout(tirar, 1000);
  };
  X.cadDesfazer = function () { Q.contas.cad = null; render(); };
  X.cadSalvar = function () {
    var K = Q.contas.cad, det = Q.contas.det; if (!K || !det) return;
    var mud = Object.keys(K.v).filter(function (k) { return String(K.v[k]).trim() !== K.antes[k]; });
    if (!mud.length) { A.toast("Nada mudou no cadastro de " + det.nome); return; }
    K.erros = {};
    mud.forEach(function (k) { var e = REGRA_CAD[k] && REGRA_CAD[k](String(K.v[k]).trim()); if (e) K.erros[k] = e; });
    if (Object.keys(K.erros).length) { render(); return; }
    var dados = { id: det.id }; mud.forEach(function (k) { dados[k] = String(K.v[k]).trim(); });
    enfileirar("contas", "conta.cadastro", det.id, dados, "Editei o cadastro de " + det.nome + " (" + plural(mud.length, "campo", "campos") + ")").then(function (ok) { if (ok) { K.antes = Object.assign({}, K.v); render(); } });
  };
  // google
  X.googleConfirmar = function (b) { Q.google.confirmando = b.getAttribute("data-id"); render(); };
  X.googleVoltar = function () { Q.google.confirmando = null; render(); };
  X.googleDesvincular = function (b) {
    var id = b.getAttribute("data-id"), c = contaResumo(id) || (Q.contas.det && String(Q.contas.det.id) === String(id) ? Q.contas.det : null);
    Q.google.confirmando = null;
    if (MP && MP.tipo === "google") A.modal.fechar();
    if (c) enfileirar(A.secaoAtual() === "contas" ? "contas" : "google", "google.desvincular", c.id, { id: c.id }, "Desvinculei a conta Google de " + c.nome); else render();
  };
  X.modalGoogle = function (b) {
    var c = contaResumo(b.getAttribute("data-id")); if (!c || !c.google) return;
    var lig = {}; (c.google.escopos || []).forEach(function (s) { lig[s] = true; });
    abrirModal({ tipo: "google", G: { id: c.id, nome: c.nome, email: c.email, ligados: lig, tela: "google" } });
  };
  function googleAtual() { return MP && MP.tipo === "google" ? MP.G : Q.contas.google; }
  X.googleServico = function (b) { var G = googleAtual(); if (!G) return; var k = b.getAttribute("data-k"); G.ligados[k] = !G.ligados[k]; render(); };
  X.googleAplicar = function () {
    var G = googleAtual(); if (!G) return;
    var lig = SERV_G.map(function (s) { return s[0]; }).filter(function (k) { return G.ligados[k]; });
    if (MP && MP.tipo === "google") A.modal.fechar();
    enfileirar(G.tela, "google.servicos", G.id, { id: G.id, ligados: lig }, lig.length ? "Deixei " + primeiro(G.nome) + " só com " + lig.join(", ") : "Revoguei todo o acesso ao Google de " + G.nome);
  };
  X.googleDesvMassa = function () {
    var ids = selIds(Q.google.sel), cs = (dadosDe("contas") || {}).contas || [];
    if (!ids.length) return;
    Q.google.sel = null; render();
    var i = 0, ok = 0;
    var passo = function () {
      if (i >= ids.length) { if (ok && fila()) fila().avisarFila(); return; }
      var c = cs.filter(function (x) { return String(x.id) === ids[i]; })[0]; i++;
      if (!c) { passo(); return; }
      enfileirar("google", "google.desvincular", c.id, { id: c.id }, "Desvinculei a conta Google de " + c.nome, true).then(function (r) { if (r) ok++; passo(); });
    };
    passo();
  };
  // tuneis
  X.tunelAbrir = function (b) { var s = b.getAttribute("data-slug"); Q.tuneis.aberto = Q.tuneis.aberto === s ? null : s; render(); };
  X.tunelHist = function (b) { var t = tunel(b.getAttribute("data-slug")); if (t) abrirModal({ tipo: "tunelHist", slug: t.slug, itens: histOrd(t) }, "largo"); };
  X.tunelAvisar = function (b) {
    var s = b.getAttribute("data-slug"), t = tunel(s);
    b.disabled = true;
    naHora("POST", P + "tuneis/" + encodeURIComponent(s) + "/avisar", {}, "Aviso enviado a " + ((t && t.responsavel) || "o responsável")).then(function (r) { if (r) ler("tuneis"); else b.disabled = false; });
  };
  X.tunelAtivo = function (b) {
    var s = b.getAttribute("data-slug"), t = tunel(s); if (!t) return;
    var ativo = t.ativo === false;
    enfileirar("tuneis", "tunel.ativo", s, { slug: s, ativo: ativo }, (ativo ? "Reativei " : "Desativei ") + s + ".paulus.ia.br");
  };
  X.tunelLiberar = function (b) {
    var s = b.getAttribute("data-slug");
    enfileirar("tuneis", "tunel.apagar", s, { slug: s }, "Liberei o endereço " + s + ".paulus.ia.br (túnel e DNS apagados)");
  };
  X.tuneisParados = function () {
    var par = ((dadosDe("tuneis") || {}).tuneis || []).filter(function (t) { return parado(t) && !naFila("tunel.apagar", t.slug); });
    var S = Q.tuneis.sel || {}, todos = par.length && par.every(function (t) { return S[t.slug]; });
    Q.tuneis.sel = {}; if (!todos) par.forEach(function (t) { Q.tuneis.sel[t.slug] = true; });
    render();
  };
  X.tuneisApagar = function () {
    var slugs = selIds(Q.tuneis.sel).filter(function (k) { return !naFila("tunel.apagar", k); });
    Q.tuneis.sel = null; render();
    var i = 0, ok = 0;
    var passo = function () {
      if (i >= slugs.length) { if (ok && fila()) fila().avisarFila(); return; }
      var s = slugs[i++];
      enfileirar("tuneis", "tunel.apagar", s, { slug: s }, "Apaguei " + s + ".paulus.ia.br (túnel e DNS)", true).then(function (r) { if (r) ok++; passo(); });
    };
    passo();
  };
  X.modalEndereco = function (b) { abrirModal({ tipo: "endereco", slug: b.getAttribute("data-slug"), novo: "", check: null, seq: 0, tocado: false }); };
  X.usarLivre = function (b) { MP.novo = b.getAttribute("data-v"); MP.tocado = true; conferirSlug(); A.modal.repintar(); };
  X.enderecoOk = function () {
    var M = MP; if (!M || !M.check || !M.check.ok) return;
    var novo = M.novo.trim().toLowerCase(), slug = M.slug;
    A.modal.fechar();
    enfileirar("tuneis", "tunel.endereco", slug, { slug: slug, novo: novo }, "Alterei o endereço " + slug + " → " + novo + ".paulus.ia.br");
  };
  X.regJson = function () {
    var T = Q.tuneis;
    baixar("registro-de-enderecos.json", JSON.stringify({ gerado: new Date().toISOString(), filtro: { evento: T.reg, busca: T.regQ || "", de: T.de || null, ate: T.ate || null }, eventos: regFiltrado }, null, 2));
  };
  X.regMais = function () { Q.tuneis.regTodos = !Q.tuneis.regTodos; render(); };
  // renovacoes
  X.renovAbrir = function (b) { var id = b.getAttribute("data-id"); Q.renovacoes.aberto = String(Q.renovacoes.aberto) === String(id) ? null : id; render(); };
  X.renovLembrete = function (b) {
    var id = b.getAttribute("data-id"), r = renovPor(id);
    b.disabled = true;
    naHora("POST", P + "renovacoes/" + encodeURIComponent(id) + "/lembrete", {}, "Lembrete enviado para " + (r ? r.email : "a conta")).then(function (x) { if (x) ler("renovacoes"); else b.disabled = false; });
  };
  X.renovMsgEnviar = function (b) {
    var id = b.getAttribute("data-id"), N = Q.renovacoes, t = (N.msg[id] || "").trim();
    if (!t) { N.erro[id] = "escreva a mensagem"; render(); return; }
    if (t.length > 4000) { N.erro[id] = "a mensagem passa de 4.000 caracteres"; render(); return; }
    b.disabled = true;
    naHora("POST", P + "renovacoes/" + encodeURIComponent(id) + "/mensagem", { texto: t }, "Mensagem enviada").then(function (r) {
      if (r) { N.msg[id] = ""; delete N.erro[id]; if (r.abertas) D.renovacoes.dados = r; render(); } else b.disabled = false;
    });
  };
  X.renovTratar = function (b) { b.disabled = true; naHora("POST", P + "renovacoes/" + encodeURIComponent(b.getAttribute("data-id")) + "/tratar", {}, "Marcada como tratada").then(function (r) { if (r) ler("renovacoes"); else b.disabled = false; }); };
  X.renovReabrir = function (b) { b.disabled = true; naHora("POST", P + "renovacoes/" + encodeURIComponent(b.getAttribute("data-id")) + "/reabrir", {}, "Reaberta").then(function (r) { if (r) ler("renovacoes"); else b.disabled = false; }); };
  X.renovLembreteMassa = function () {
    var ids = selIds(Q.renovacoes.sel); if (!ids.length) return;
    Q.renovacoes.sel = null; render();
    emMassa(ids, "lembrete", function (ok) { A.toast(ok === ids.length ? "Lembrete enviado a " + plural(ok, "conta", "contas") : ok + " de " + ids.length + " lembretes enviados", ok !== ids.length); ler("renovacoes"); });
  };
  X.renovTratarMassa = function () {
    var ids = selIds(Q.renovacoes.sel); if (!ids.length) return;
    Q.renovacoes.sel = null; render();
    emMassa(ids, "tratar", function (ok) { A.toast(ok + (ok === 1 ? " marcada como tratada" : " marcadas como tratadas"), ok !== ids.length); ler("renovacoes"); });
  };
  X.renovCfg = function (b) {
    var d = dadosDe("renovacoes"); if (!d) return;
    var antes = Object.assign({ email: false, resumo: false, whats: false, tol: false }, d.config || {}), novo = Object.assign({}, antes), k = b.getAttribute("data-k");
    novo[k] = !antes[k];
    d.config = novo; render();
    naHora("POST", P + "renovacoes/config", novo, "Avisos atualizados").then(function (r) { if (!r) d.config = antes; else if (r.config) d.config = r.config; render(); });
  };
  // planos
  X.planoItemMais = function () { var e = Q.planos.ed; if (e) { e.itens.push({ titulo: "", descricao: "" }); render(); } };
  X.planoItemTirar = function (b) { var e = Q.planos.ed; if (e) { e.itens.splice(Number(b.getAttribute("data-i")), 1); render(); } };
  X.planoItemMover = function (b) {
    var e = Q.planos.ed; if (!e) return;
    var k = Number(b.getAttribute("data-i")), d = Number(b.getAttribute("data-d")), x = e.itens[k];
    e.itens.splice(k, 1); e.itens.splice(k + d, 0, x); render();
  };
  X.planoDesfazer = function () { Q.planos.ed = null; render(); };
  X.planoSalvar = function () {
    var e = Q.planos.ed; if (!e) return;
    var v = e.v, er = {};
    if (!v.nome.trim()) er.nome = "diga o nome do plano";
    if (!(num(v.valor) > 0)) er.valor = "o valor por mês precisa ser maior que zero";
    if (!(num(v.anual) > 0)) er.anual = "o valor por ano precisa ser maior que zero";
    if (!(num(v.tokens) > 0)) er.tokens = "os créditos por mês precisam ser maiores que zero";
    var pes = num(v.pessoas); if (!(pes >= 1 && pes <= 500 && pes === Math.round(pes))) er.pessoas = "pessoas é um número inteiro de 1 a 500";
    if (v.rv.trim() && !(num(v.rv) >= 0)) er.rv = "a recarga é um valor em reais";
    if (num(v.rv) > 0 && !(num(v.rt) > 0)) er.rt = "os tokens da recarga precisam ser maiores que zero";
    if (v.para.length > 160) er.para = "a frase vai até 160 caracteres";
    if (v.heranca.length > 120) er.heranca = "o texto antes dos itens vai até 120 caracteres";
    e.erros = er;
    if (Object.keys(er).length) { render(); return; }
    var dados = { id: e.id, nome: v.nome.trim(), para: v.para.trim(), heranca: v.heranca.trim() || null, valor: num(v.valor), valor_anual: num(v.anual), tokens: Math.round(num(v.tokens) * 1e6),
      pessoas: Math.round(pes), recarga: num(v.rv) > 0 ? { valor: num(v.rv), tokens: Math.round(num(v.rt) * 1e6) } : null,
      itens: e.itens.filter(function (x) { return x.titulo.trim(); }).map(function (x) { return { titulo: x.titulo.trim(), descricao: x.descricao.trim() }; }) };
    enfileirar("planos", "plano.editar", e.id, dados, "Editei o plano " + dados.nome + " (" + brl(dados.valor) + "/mês, " + plural(dados.itens.length, "item", "itens") + ")").then(function (ok) { if (ok) { Q.planos.ed = null; render(); } });
  };
  X.planosBaixar = function () { var ps = (dadosDe("planos") || {}).planos || []; baixar("IA_PLANOS.json", Q.planos.json != null ? Q.planos.json : planosAtuais(ps)); };
  X.planosCopiar = function (b) { var ps = (dadosDe("planos") || {}).planos || []; b.setAttribute("data-t", Q.planos.json != null ? Q.planos.json : planosAtuais(ps)); X.copiar(b); };
  X.planosRestaurar = function () { Q.planos.json = null; render(); };
  X.planosSalvarJson = function () {
    var t = Q.planos.json; if (t == null || validaPlanos(t)) return;
    var v = JSON.parse(t);
    enfileirar("planos", "planos.json", "IA_PLANOS", { planos: v }, "Atualizei o IA_PLANOS (" + plural(v.length, "plano", "planos") + ")").then(function (ok) { if (ok) { Q.planos.json = null; render(); } });
  };
  X.planoVersao = function (b) { var n = b.getAttribute("data-n"); Q.planos.versao = String(Q.planos.versao) === n ? null : n; render(); };
  X.planoUsarVersao = function (b) {
    var v = ((dadosDe("planos") || {}).versoes || []).filter(function (x) { return String(x.n) === b.getAttribute("data-n"); })[0]; if (!v) return;
    Q.planos.json = JSON.stringify(v.planos, null, 2); Q.planos.lado = "json"; Q.planos.versao = null; render();
    A.toast("Versão " + v.n + " no editor: confira e ponha na fila");
  };
  // e-mails
  X.passo = function (b) {
    var n = Number(b.getAttribute("data-n")) || 1;
    if (n === 3 && Q.emails.passo === 2 && !conferirCampanha()) { render(); return; }
    Q.emails.passo = n; render();
  };
  X.escolherPublico = function (b) { var id = b.getAttribute("data-id"); Q.emails.camp.publico = id; render(); if (id === "escolhidas") X.escAbrir(); };
  X.usarPublico = function (b) { Q.emails.camp.publico = b.getAttribute("data-id"); Q.emails.aba = "nova"; Q.emails.passo = b.getAttribute("data-id") === "escolhidas" ? 1 : 2; render(); if (b.getAttribute("data-id") === "escolhidas") X.escAbrir(); };
  X.escAbrir = function () {
    if (!dadosDe("contas")) ler("contas");
    var sel = {}; Q.emails.escolhidas.forEach(function (c) { sel[c.id] = true; });
    abrirModal({ tipo: "escContas", q: "", sel: sel }, "largo");
  };
  X.escMarcar = function (b) { var id = b.getAttribute("data-id"); MP.sel[id] = !MP.sel[id]; A.modal.repintar(); };
  X.escConfirmar = function () {
    var S = MP.sel, todas = ((dadosDe("contas") || {}).contas || []).concat(Q.emails.escolhidas);
    Q.emails.escolhidas = selIds(S).map(function (k) { var c = todas.filter(function (x) { return String(x.id) === k; })[0]; return c ? { id: c.id, nome: c.nome, email: c.email } : null; }).filter(Boolean);
    A.modal.fechar(); render();
  };
  X.pedirDisparo = function () {
    var E = Q.emails, c = E.camp, pub = publicoAtual();
    if (!conferirCampanha()) { E.passo = 2; render(); return; }
    if (c.quando === "agendado") {
      var quandoMs = Date.parse(c.de + "T" + (c.hora || "") + ":00-03:00");
      if (!c.de || !/^\d{2}:\d{2}$/.test(c.hora || "")) { E.erros.quando = "escolha o dia e a hora"; render(); return; }
      if (!(quandoMs > Date.now())) { E.erros.quando = "a hora marcada já passou"; render(); return; }
      if (quandoMs > Date.now() + 365 * 864e5) { E.erros.quando = "agende para menos de um ano"; render(); return; }
    }
    var dd = dadosCampanha(), n = pub ? pub.n || 0 : 0, q = c.quando === "agendado" ? ddmm(c.de) + " às " + c.hora : "agora";
    enfileirar("emails", "campanha.disparar", dd.nome, dd, "Pedi o disparo “" + dd.nome + "” para " + plural(n, "conta", "contas") + " (" + q + ")").then(function (ok) {
      if (!ok) return;
      var keep = { botao: c.botao, link: c.link };
      E.camp = novaCamp(); E.camp.botao = keep.botao; E.camp.link = keep.link; E.aba = "campanhas"; E.passo = 1; E.erros = {}; E.outroLink = false;
      render();
    });
  };
  X.campCancelar = function (b) {
    var c = (((dadosDe("campanhas") || {}).campanhas) || []).filter(function (x) { return String(x.id) === b.getAttribute("data-id"); })[0]; if (!c) return;
    abrirModal({ tipo: "campCancelar", id: c.id, nome: c.nome, quando: c.quando });
  };
  X.campCancelarOk = function () {
    var M = MP; A.modal.fechar();
    enfileirar("emails", "campanha.cancelar", M.id, { id: M.id }, "Cancelei o envio de “" + M.nome + "” (" + quando(M.quando) + ")");
  };
  X.enviarTeste = function (b) {
    b.disabled = true;
    naHora("POST", P + "campanhas/teste", { campanha: dadosCampanha() }, "Teste enviado para " + ((A.quem && A.quem.email) || "você")).then(function () { b.disabled = false; });
  };
  // busca
  X.buscaIr = function (b) { var r = itensBusca[Number(b.getAttribute("data-i"))]; if (r) { A.modal.fechar(); r.ir(); } };

  /* ---------- as entradas de texto ---------- */
  var IN = {
    contasQ: function (el) { Q.contas.q = el.value; render(); },
    regQ: function (el) { Q.tuneis.regQ = el.value; render(); },
    regDe: function (el) { Q.tuneis.de = el.value; render(); },
    regAte: function (el) { Q.tuneis.ate = el.value; render(); },
    extDe: function (el) { Q.contas.ext.de = el.value; render(); },
    extAte: function (el) { Q.contas.ext.ate = el.value; render(); },
    tokDe: function (el) { Q.tokens.de = el.value; if (Q.tokens.de && Q.tokens.ate && Q.tokens.de <= Q.tokens.ate) ler(tokensChave()); render(); },
    tokAte: function (el) { Q.tokens.ate = el.value; if (Q.tokens.de && Q.tokens.ate && Q.tokens.de <= Q.tokens.ate) ler(tokensChave()); render(); },
    cad: function (el) {
      var K = Q.contas.cad; if (!K) return;
      var k = el.getAttribute("data-k");
      K.v[k] = el.value;
      if (K.erros[k]) { delete K.erros[k]; el.removeAttribute("aria-invalid"); }
      if (k === "cidade") cidades(el.value);
    },
    renovMsg: function (el) { var id = el.getAttribute("data-id"); Q.renovacoes.msg[id] = el.value; if (Q.renovacoes.erro[id]) { delete Q.renovacoes.erro[id]; el.removeAttribute("aria-invalid"); } },
    planoEd: function (el) { var e = Q.planos.ed; if (e) { var k = el.getAttribute("data-k"); e.v[k] = el.value; if (e.erros[k]) { delete e.erros[k]; el.removeAttribute("aria-invalid"); } } },
    planoItem: function (el) { var e = Q.planos.ed, i = el.getAttribute("data-i"); if (e && e.itens[i]) e.itens[i][el.getAttribute("data-k")] = el.value; },
    planosJson: function (el) { Q.planos.json = el.value; planosStatus(); },
    camp: function (el) {
      var k = el.getAttribute("data-k"), E = Q.emails;
      E.camp[k] = el.value;
      if (k === "de" || k === "hora") delete E.erros.quando;
      if (E.erros[k]) { delete E.erros[k]; el.removeAttribute("aria-invalid"); }
      if (k !== "de" && k !== "hora") pintarPrevia();
    },
    campLink: function (el) { var E = Q.emails; if (el.value) { E.camp.link = el.value; E.outroLink = false; } else { E.outroLink = true; E.camp.link = ""; } render(); },
    slugNovo: function (el) { if (!MP) return; MP.novo = el.value; MP.tocado = true; conferirSlug(); A.modal.repintar(); },
    escmQ: function (el) { if (MP) { MP.q = el.value; A.modal.repintar(); } },
    buscaQ: function (el) { if (MP) { MP.q = el.value; MP.idx = 0; buscar(); A.modal.repintar(); } },
  };
  // A previa acompanha o que se digita sem redesenhar o formulario.
  function pintarPrevia() { if (R.raiz && A.secaoAtual() === "emails") pintar(R.raiz, TELAS_RENDER.emails()); }
  var tempoCidade = null;
  function cidades(t) {
    var K = Q.contas.cad;
    clearTimeout(tempoCidade);
    t = t.trim();
    if (t.length < 2) return;
    tempoCidade = setTimeout(function () {
      // A tabela de municipios do IBGE do emissor de NFS-e da Atos (a mesma da secao Notas fiscais).
      A.pedir("GET", "/api/admin/nfse/municipios?q=" + encodeURIComponent(t)).then(function (r) {
        if (Q.contas.cad !== K) return;
        K.cidades = (r.municipios || []).filter(function (m) { return !K.v.uf || m.uf === K.v.uf; });
        var dl = document.getElementById("pv-cidades");
        if (dl) dl.innerHTML = K.cidades.map(function (m) { return '<option value="' + esc(m.nome) + '">' + esc(m.nome + "/" + m.uf) + "</option>"; }).join("");
        var achou = (r.municipios || []).filter(function (m) { return m.nome === K.v.cidade; })[0];
        if (achou && !K.v.uf) { K.v.uf = achou.uf; var s = document.getElementById("pv-cad-uf"); if (s) s.value = achou.uf; }
      }, function () { /* sem sugestao */ });
    }, 200);
  }

  /* ---------- os eventos ---------- */
  function minha(el) { return (R.raiz && R.raiz.contains(el)) || (MP && el.closest("#admin-camada")); }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-pv]");
    if (!b || b.disabled || !minha(b)) return;
    var f = X[b.getAttribute("data-pv")];
    if (!f) return;
    e.preventDefault();
    f(b, e);
  });
  document.addEventListener("input", function (e) {
    var el = e.target.closest("[data-pv-in]");
    if (!el || el.type === "file" || !minha(el)) return;
    var f = IN[el.getAttribute("data-pv-in")];
    if (f) f(el);
  });
  document.addEventListener("change", function (e) {
    var el = e.target.closest("[data-pv-in]");
    if (!el || !minha(el)) return;
    if (el.getAttribute("data-pv-in") === "planosArquivo") {
      var a = el.files && el.files[0]; if (!a) return;
      a.text().then(function (t) { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch (x) { /* mostra como veio; o aviso diz o erro */ } Q.planos.json = t; render(); A.toast("Arquivo carregado: confira e ponha na fila"); });
    } else if (el.tagName === "SELECT" && el.getAttribute("data-pv-in") === "cad") IN.cad(el);
  });
  document.addEventListener("keydown", function (e) {
    if (MP && MP.tipo === "busca" && e.target.id === "pv-busca-q") {
      var total = itensBusca.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (total) marcarBusca(((MP.idx + (e.key === "ArrowDown" ? 1 : -1)) % total + total) % total); }
      else if (e.key === "Enter") { e.preventDefault(); var r = itensBusca[MP.idx]; if (r) { A.modal.fechar(); r.ir(); } }
      return;
    }
    if (e.key === "Enter" && MP && MP.tipo === "endereco" && e.target.id === "pv-slug") { e.preventDefault(); X.enderecoOk(); }
  });
  document.addEventListener("mouseover", function (e) {
    var b = e.target.closest(".pv-busca-item");
    if (b && MP && MP.tipo === "busca" && Number(b.getAttribute("data-i")) !== MP.idx) marcarBusca(Number(b.getAttribute("data-i")));
  });

  /* ================================================================ as secoes */

  A.aoEntrar(function () {
    // As contagens do menu e a configuracao (o e-mail, os tuneis, a nuvem) leem em segundo plano.
    // So para quem atua no PAVLVS (os outros nem veem as secoes; o servidor recusaria).
    if (!A.temArea("pavlvs")) return;
    ler("sessao", true); ler("tuneis"); ler("renovacoes");
    if (fila()) fila().ouvir(function () { if (TELA[A.secaoAtual()]) render(); });
  });
  var CONTAGEM = {
    tuneis: function () { var t = dadosDe("tuneis"); return t ? (t.tuneis || []).filter(parado).length : 0; },
    renovacoes: function () { var r = dadosDe("renovacoes"); return r ? (r.abertas || []).length : 0; },
  };
  TELAS.forEach(function (t, i) {
    A.secoes.push({
      id: t.id, nome: t.nome, grupo: "PAVLVS", area: "pavlvs", ordem: i + 1, contagem: CONTAGEM[t.id],
      desenhar: function (raiz) {
        if (t.id === "contas" && !R.abrindoConta) Q.contas.aberta = null;
        R.abrindoConta = false;
        R.raiz = raiz; R.secao = t.id;
        leiturasDa(t.id).forEach(function (ch) { var r = D[ch]; if (!r || (!r.dados && !r.promessa) || r.erro) ler(ch); });
        pintar(raiz, TELAS_RENDER[t.id]());
      },
    });
  });
})();
