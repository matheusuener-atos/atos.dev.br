/* O painel da Atos, secao Notas fiscais: o emissor de NFS-e da Atos (worker/nfse/api.js, em /api/admin/nfse/*).
   Porte da tela "Notas fiscais" do painel do PAVLVS (site/assets/admin.js, secao 11), sem a fila de alteracoes:
   aqui tudo vale na hora (os interruptores tambem, POST config).

   Abas: Notas (a lista, com as acoes de cada nota numa linha que abre), Emitir NFS-e (os pagamentos sem nota e a
   nota avulsa), Clientes (o tomador da nota, ajustado so para a nota) e Parametros (os interruptores, o
   certificado A1, a conexao com a Sefin, o token da Cloudflare, o prestador e a producao).

   Papeis: dono e financeiro fazem tudo; suporte so consulta (o servidor recusa POST com 403), entao as acoes ficam
   desligadas com o motivo. A CSP do /admin e script-src 'self'; style-src 'self': nada de estilo nem evento no
   HTML; tudo por classe (admin.css) e por delegacao de eventos. O .pfx e aberto no navegador
   (assets/nfse-pfx.js + assets/vendor/forge.min.js, carregados so quando a pessoa instala o certificado). */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var BASE = "/api/admin/nfse/";
  var esc = A.esc;
  var MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  var UF_DO_CODIGO = { 11: "RO", 12: "AC", 13: "AM", 14: "RR", 15: "PA", 16: "AP", 17: "TO", 21: "MA", 22: "PI", 23: "CE", 24: "RN", 25: "PB", 26: "PE", 27: "AL",
    28: "SE", 29: "BA", 31: "MG", 32: "ES", 33: "RJ", 35: "SP", 41: "PR", 42: "SC", 43: "RS", 50: "MS", 51: "MT", 52: "GO", 53: "DF" };
  var ESTADOS = {
    rascunho: "Rascunho", assinada: "Assinada", enviando: "Enviando", aguardando_confirmacao: "Aguardando confirmação",
    na_fila: "Na fila de envio", emitida: "Emitida", rejeitada: "Rejeitada", cancelada: "Cancelada", substituida: "Substituída", descartada: "Descartada",
  };
  var COR = { emitida: "ok", rejeitada: "perigo", na_fila: "atencao", aguardando_confirmacao: "atencao", enviando: "atencao", assinada: "atencao" };
  var PENDENTES = ["na_fila", "aguardando_confirmacao", "enviando", "assinada"];
  var EVENTOS = { 101101: "Pedido de cancelamento", 105102: "Cancelamento por substituição", 305101: "Cancelamento por ofício",
    101103: "Pedido de análise fiscal", 105104: "Análise fiscal deferida", 105105: "Análise fiscal indeferida" };
  var TOMADOR = ["nome", "documento", "email", "telefone", "cep", "logradouro", "numero", "complemento", "bairro", "cmun", "uf", "inscricao_municipal"];
  var TRAVA = "o suporte só consulta as notas fiscais";
  var ABAS = [["notas", "Notas"], ["emitir", "Emitir NFS-e"], ["clientes", "Clientes"], ["parametros", "Parâmetros"]];
  var INTERRUPTORES = [
    ["auto", "Emitir ao confirmar o pagamento",
      "assim que a cobrança da Atos confirma o pagamento, se os dados fiscais do cliente estiverem completos; senão o motivo aparece em Emitir NFS-e › Pagamentos sem nota"],
    ["email", "Guardar a nota com a conta do cliente logo depois de emitir",
      "a nota (XML e PDF) fica guardada com a conta do cliente na Atos, e um cancelamento depois avisa o cliente; desligado, o botão Enviar ao cliente faz isso. A Minha conta ainda não mostra as notas ao cliente"],
    ["mail", "Mandar a nota por e-mail",
      "PDF e XML anexos, pelo e-mail da Atos, ao e-mail do tomador corrigido em Clientes ou, sem ele, ao dos dados fiscais do cliente; sai logo depois de emitir e no Enviar ao cliente. Precisa da RESEND_API_KEY"],
  ];

  var S = {
    raiz: null, ctx: null, aba: "notas",
    resumo: null, erro: "", carregando: false, aviso: null,
    filtro: "", aberta: null, detalhe: {}, acao: null, ocupado: "",
    clientes: null, clientesErro: "", clientesCarregando: false,
    em: null,
    cl: { filtro: "todos", q: "", editando: null, v: null, orig: null, erro: "", ok: "", enviando: false },
    par: null,
    token: "", tokenMsg: null, gravandoToken: false,
    prodConfirma: false, erroProd: "", mudandoProd: false,
    pfx: null, senha: "", instalando: false, certAviso: null,
    teste: null, testando: false, cfgMudando: false,
    mun: {},
  };
  var NOMES_MUN = {}, pedidosMun = {};

  // ------------------------------------------------------------ utilidades

  function pode() { return Boolean(S.ctx && S.ctx.quem && S.ctx.quem.papel !== "suporte"); }
  function trava() { return pode() ? "" : ' disabled title="' + TRAVA + '"'; }
  function api(metodo, caminho, corpo) { return (S.ctx ? S.ctx.api : A.api)(metodo, BASE + caminho, corpo); }
  function ok(r) { return r.status >= 200 && r.status < 300; }
  function erroDe(r) {
    var d = r.dados || {};
    if (d.erros && d.erros.length) return "A nota não passou na conferência: " + d.erros.join("; ");
    return d.erro || (r.status ? "o servidor respondeu " + r.status : "sem conexão com o servidor");
  }
  function avisar(texto, bom, r) { S.aviso = { texto: texto, ok: Boolean(bom), reentrar: Boolean(r && r.status === 401) }; }
  function data(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }
  function dataHora(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function reais(v) { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
  function decimal(centavos) { return (Number(centavos || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function competencia(c) { var m = /^(\d{4})-(\d{2})/.exec(c || ""); return m ? MESES[Number(m[2]) - 1] + "/" + m[1] : "—"; }
  function doc(d) {
    var x = String(d || "").replace(/\D/g, "");
    if (x.length === 14) return x.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    if (x.length === 11) return x.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
    return d || "";
  }
  function mesAtual() { var d = new Date(Date.now() - 3 * 36e5); return d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2); }
  function pct(bp) { return bp ? (Number(bp) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""; }
  function bp(t) {
    var s = String(t == null ? "" : t).replace(/\s/g, "");
    if (!s) return 0;
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    var n = Number(s);
    return isFinite(n) ? Math.round(n * 100) : NaN;
  }
  /* "a.b.c" -> {a: {b: {c}}}; com prefixo, so as chaves dele (sem o prefixo). */
  function aninhar(v, prefixo) {
    var saida = {};
    Object.keys(v).forEach(function (k) {
      if (prefixo && k.indexOf(prefixo) !== 0) return;
      var partes = k.slice(prefixo ? prefixo.length : 0).split("."), alvo = saida;
      partes.slice(0, -1).forEach(function (p) { alvo[p] = alvo[p] || {}; alvo = alvo[p]; });
      alvo[partes[partes.length - 1]] = v[k];
    });
    return saida;
  }
  function achatar(obj, prefixo, saida) {
    saida = saida || {};
    Object.keys(obj || {}).forEach(function (k) {
      var x = obj[k];
      if (x && typeof x === "object" && !Array.isArray(x)) achatar(x, prefixo + k + ".", saida);
      else saida[prefixo + k] = x == null ? "" : x;
    });
    return saida;
  }
  function dominio(obj, comCodigo) {
    return Object.keys(obj || {}).sort().map(function (k) { return [k, (comCodigo ? k + " – " : "") + obj[k]]; });
  }
  function acharNota(id) { return ((S.resumo && S.resumo.notas) || []).filter(function (n) { return String(n.id) === String(id); })[0]; }
  function acharCliente(id) { return (S.clientes || []).filter(function (c) { return String(c.id) === String(id); })[0]; }
  function acharPagamento(id) { return ((S.resumo && S.resumo.pagamentos) || []).filter(function (x) { return String(x.id) === String(id); })[0]; }
  function nomeDoPagamento(x) { return x.nome || "cliente " + String(x.cliente || "").slice(0, 8); }

  var scripts = {};
  function carregarScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise(function (feito, falhou) {
        var s = document.createElement("script");
        s.src = src;
        s.onload = feito;
        s.onerror = function () { delete scripts[src]; falhou(new Error("não consegui carregar " + src)); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  // ------------------------------------------------------------ os campos

  function formDe(f) { return { em: S.em, cl: S.cl, par: S.par, acao: S.acao }[f] || null; }
  function idDe(f, k) { return "nf-" + f + "-" + String(k).replace(/[^A-Za-z0-9_-]/g, "-"); }
  function valorDe(f, k) { var F = formDe(f); var v = F && F.v ? F.v[k] : ""; return v == null ? "" : v; }
  function dis() { return pode() ? "" : " disabled"; }

  function campo(f, k, rot, classe, extra) {
    return '<label class="campo ' + (classe || "") + '"><span class="rotulo">' + esc(rot) + '</span><input id="' + idDe(f, k) + '" data-f="' + f + '" data-k="' + esc(k) +
      '" value="' + esc(valorDe(f, k)) + '"' + (extra || "") + dis() + ' autocomplete="off"></label>';
  }
  function texto(f, k, rot, classe) {
    return '<label class="campo ' + (classe || "") + '"><span class="rotulo">' + esc(rot) + '</span><textarea id="' + idDe(f, k) + '" data-f="' + f + '" data-k="' + esc(k) +
      '" rows="3" maxlength="255"' + dis() + ">" + esc(valorDe(f, k)) + "</textarea></label>";
  }
  function escolha(f, k, rot, classe, opcoes) {
    var v = String(valorDe(f, k));
    return '<label class="campo ' + (classe || "") + '"><span class="rotulo">' + esc(rot) + '</span><select class="seletor" id="' + idDe(f, k) + '" data-f="' + f + '" data-k="' + esc(k) + '"' +
      (opcoes.length ? dis() : " disabled") + ">" + (opcoes.some(function (o) { return String(o[0]) === v; }) ? "" : '<option value="' + esc(v) + '" selected>' + (v ? esc(v) : "escolha") + "</option>") +
      opcoes.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === v ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") + "</select></label>";
  }
  function marcar(f, k, rot, classe) {
    return '<label class="nf-marcar ' + (classe || "") + '"><input type="checkbox" id="' + idDe(f, k) + '" data-f="' + f + '" data-k="' + esc(k) + '"' +
      (valorDe(f, k) ? " checked" : "") + dis() + "><span>" + esc(rot) + "</span></label>";
  }

  /* O municipio: digita o nome (ou cola os 7 digitos do IBGE) e escolhe na lista; o codigo fica em v[k]. */
  function rotuloMun(cod) {
    cod = String(cod || "");
    if (!/^\d{7}$/.test(cod)) return cod;
    if (NOMES_MUN[cod]) return NOMES_MUN[cod];
    pedirNomeMun(cod);
    return cod;
  }
  function pedirNomeMun(cod) {
    if (NOMES_MUN[cod] || pedidosMun[cod]) return;
    pedidosMun[cod] = 1;
    api("GET", "municipios?q=" + cod).then(function (r) {
      if (!ok(r)) { delete pedidosMun[cod]; return; }
      var m = (r.dados.municipios || [])[0];
      NOMES_MUN[cod] = m ? m.nome + "/" + m.uf : cod + " (fora da tabela do IBGE)";
      pintar();
    });
  }
  function campoMun(f, k, kUf, rot, classe) {
    var cod = String(valorDe(f, k)), st = S.mun[f + ":" + k] || {}, id = idDe(f, k), aberto = Boolean(st.editando && st.res);
    var h = '<div class="campo nf-mun ' + (classe || "") + '"><label class="rotulo" for="' + id + '">' + esc(rot) + '</label><input id="' + id + '" data-mun="' + f + '" data-k="' + esc(k) +
      '" data-uf="' + esc(kUf || "") + '" value="' + esc(st.editando ? st.texto : rotuloMun(cod)) + '" placeholder="o nome (ex.: Goiânia) ou o código IBGE" role="combobox" aria-autocomplete="list" aria-expanded="' +
      aberto + '"' + dis() + ' autocomplete="off" spellcheck="false">';
    if (aberto) {
      h += '<div class="nf-lista" role="listbox" aria-label="Municípios">' + (st.res.length ? st.res.map(function (m, i) {
        return '<button type="button" role="option" aria-selected="' + (i === st.idx) + '" data-nf="mun" data-f="' + f + '" data-k="' + esc(k) + '" data-i="' + i + '">' +
          esc(m.nome + "/" + m.uf) + "<small>" + esc(m.codigo) + "</small></button>";
      }).join("") : '<span class="dica">' + esc(st.erro || "Nenhum município com esse nome.") + "</span>") + "</div>";
    } else if (st.editando && String(st.texto || "").trim()) h += '<span class="dica">procurando…</span>';
    else h += '<span class="dica">' + (cod ? "IBGE " + esc(cod) : "escolha na lista") + "</span>";
    return h + "</div>";
  }

  function tomadorCampos(f, p) {
    var num = ' inputmode="numeric"';
    return campo(f, p + "nome", "Nome ou razão social", "s4") + campo(f, p + "documento", "CPF ou CNPJ", "s2", num) +
      campo(f, p + "email", "E-mail", "s3") + campo(f, p + "telefone", "Telefone", "s3", num) +
      campo(f, p + "cep", "CEP", "s2", num) + campo(f, p + "logradouro", "Rua", "s4") +
      campo(f, p + "numero", "Número", "s2") + campo(f, p + "complemento", "Complemento", "s2") + campo(f, p + "bairro", "Bairro", "s2") +
      campoMun(f, p + "cmun", p + "uf", "Município", "s4") + campo(f, p + "uf", "UF", "s2", ' maxlength="2"') +
      campo(f, p + "inscricao_municipal", "Inscrição municipal (se houver)", "s3");
  }

  function h2(t, dir) { return '<h2 class="titulo-secao nf-h2"><span>' + t + "</span>" + (dir || "") + "</h2>"; }
  function h3(t) { return '<h3 class="titulo-secao nf-sub">' + t + "</h3>"; }
  function vazio(t) { return '<div class="card"><p class="vazio">' + t + "</p></div>"; }
  function faixa(t, bom) { return '<p class="nf-aviso' + (bom ? " ok" : "") + '">' + t + "</p>"; }

  // ------------------------------------------------------------ o desenho

  function pintar() {
    if (!S.raiz || !document.body.contains(S.raiz)) return;
    var ativo = document.activeElement, id = ativo && ativo.id, pos = null;
    try { pos = ativo && ativo.selectionStart; } catch (x) { pos = null; }
    S.raiz.innerHTML = tela();
    // A senha do certificado e o token vao por propriedade, nunca no HTML.
    var s = document.getElementById("nf-senha");
    if (s) s.value = S.senha;
    var t = document.getElementById("nf-token");
    if (t) t.value = S.token;
    if (id) {
      var el = document.getElementById(id);
      if (el && el !== document.activeElement) {
        el.focus();
        if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch (x) { /* campo sem selecao */ }
      }
    }
  }

  function tela() {
    var h = '<h1>Notas fiscais</h1><p class="descricao">As NFS-e que a Atos emite pelos pagamentos dos clientes. Emitir, cancelar, substituir, os parâmetros e os interruptores valem na hora.</p>';
    var npg = S.resumo ? (S.resumo.pagamentos || []).length : 0;
    h += '<nav class="guias" aria-label="Notas fiscais">' + ABAS.map(function (a) {
      return '<button type="button" data-nf-aba="' + a[0] + '"' + (a[0] === S.aba ? ' aria-current="page"' : "") + ">" + a[1] + (a[0] === "emitir" && npg ? " · " + npg : "") + "</button>";
    }).join("") + '<button type="button" class="fim" data-nf="recarregar"' + (S.carregando ? " disabled" : "") + ">" + (S.carregando ? "Atualizando…" : "Atualizar") + "</button></nav>";
    if (!pode()) h += faixa("Você está no painel como suporte: aqui você só consulta. Emitir, cancelar e mudar os parâmetros é do dono e do financeiro.");
    if (S.aviso) {
      h += '<p class="nf-aviso' + (S.aviso.ok ? " ok" : "") + '" role="status"><span>' + esc(S.aviso.texto) + "</span>" +
        (S.aviso.reentrar ? '<button type="button" class="link" data-admin="reentrar">Entrar de novo</button>' : "") +
        '<button type="button" class="link" data-nf="fechar-aviso">Fechar</button></p>';
    }
    if (!S.resumo) {
      if (S.erro) return h + vazio(esc(S.erro) + ' <button type="button" class="link" data-nf="recarregar">Tentar de novo</button>');
      return h + vazio("Carregando…");
    }
    var d = S.resumo;
    if (d.emissor && d.emissor.ligado === false) h += faixa("O emissor ainda não está ligado: " + esc(d.emissor.falta) + ".");
    if (d.erro) h += faixa(esc(d.erro));
    return h + { notas: abaNotas, emitir: abaEmitir, clientes: abaClientes, parametros: abaParametros }[S.aba]();
  }

  function seloAmbiente(s) {
    if (!s) return "";
    return s.ambiente === "producao" ? '<span class="selo aviso">Produção · as notas valem de verdade</span>'
      : '<span class="selo neutro">Ambiente de testes · produção restrita, sem valor fiscal</span>';
  }

  // ---------- Notas

  function abaNotas() {
    var d = S.resumo, s = d.situacao, ns = d.notas || [], h = "";
    var naFila = ns.some(function (n) { return PENDENTES.indexOf(n.estado) >= 0; });
    h += '<div class="nf-topo">' + seloAmbiente(s) + (s && naFila ? '<button type="button" class="btn p" data-nf="fila"' + trava() + (S.ocupado === "fila" ? " disabled" : "") + ">" +
      (S.ocupado === "fila" ? "Processando…" : "Processar a fila agora") + "</button>" : "") + "</div>";
    if (s && !s.pode_emitir && (s.motivos || []).length) h += faixa("<strong>Ainda não dá para emitir:</strong> " + esc(s.motivos.join("; ")) + ".");
    var c = s && s.certificado;
    if (c && c.instalado && (c.vencido || c.dias_restantes <= 30)) {
      h += faixa(c.vencido ? "O certificado A1 venceu em " + esc(data(c.valido_ate)) + ": instale o novo em Parâmetros."
        : "O certificado A1 vence em " + esc(data(c.valido_ate)) + " (" + c.dias_restantes + (c.dias_restantes === 1 ? " dia" : " dias") + "): renove antes de vencer.");
    }
    if (s) {
      var p = (s.prestador || {}).dados || {}, sv = p.servico || {};
      h += '<div class="card nf-fatos"><div class="colunas">' +
        '<div><span class="rotulo">Prestador</span><span>' + esc(p.razao_social ? p.razao_social + " · " + (doc(p.documento) || "documento a definir") : "a definir em Parâmetros") + "</span></div>" +
        '<div><span class="rotulo">Serviço</span><span>' + esc(sv.ctribnac ? "cTribNac " + sv.ctribnac + (sv.nbs ? " · NBS " + sv.nbs : "") + (sv.aliquota_iss_bp ? " · ISS " + pct(sv.aliquota_iss_bp) + "%" : "") : "a definir") + "</span></div>" +
        '<div><span class="rotulo">Município</span><span>' + esc(s.municipio ? s.municipio.frase : "—") + "</span></div>" +
        '<div><span class="rotulo">Próxima DPS</span><span>nº ' + esc(s.proximo_numero) + " · série " + esc(p.serie || "1") + "</span></div></div></div>";
    }
    var npg = (d.pagamentos || []).length;
    if (npg) h += '<div class="card nf-faixa"><span>' + npg + (npg === 1 ? " pagamento aprovado está sem nota." : " pagamentos aprovados estão sem nota.") + '</span><button type="button" class="btn p" data-nf-aba="emitir">Ver em Emitir NFS-e</button></div>';
    var cont = { "": ns.length, pendentes: 0, emitidas: 0 };
    ns.forEach(function (n) { if (n.estado === "emitida") cont.emitidas++; else if (PENDENTES.indexOf(n.estado) >= 0 || n.estado === "rejeitada" || n.estado === "rascunho") cont.pendentes++; });
    var lista = ns.filter(function (n) {
      if (S.filtro === "emitidas") return n.estado === "emitida";
      if (S.filtro === "pendentes") return PENDENTES.indexOf(n.estado) >= 0 || n.estado === "rejeitada" || n.estado === "rascunho";
      return true;
    });
    h += h2("Notas", '<span class="opcoes" role="group" aria-label="Filtrar as notas">' + [["", "Todas"], ["pendentes", "Pendentes"], ["emitidas", "Emitidas"]].map(function (o) {
      return '<button type="button" data-nf="filtro" data-v="' + o[0] + '" aria-pressed="' + (S.filtro === o[0]) + '">' + o[1] + ' <span class="nf-n">' + cont[o[0]] + "</span></button>";
    }).join("") + "</span>");
    if (!ns.length) return h + vazio("Nenhuma nota ainda. Comece por Emitir NFS-e.");
    if (!lista.length) return h + vazio("Nenhuma nota com esse filtro.");
    h += '<div class="card nf-tabela"><div><div class="nf-tr nf-th"><span>Nº</span><span>Cliente</span><span>Competência</span><span class="dir">Valor</span><span>Situação</span><span></span></div>' +
      lista.map(function (n) {
        var aberta = String(S.aberta) === String(n.id);
        return '<button type="button" class="nf-tr" data-nf="abrir" data-id="' + esc(n.id) + '" aria-expanded="' + aberta + '"><span class="num">' + esc(n.numero || "—") + "</span>" +
          '<span class="nf-cel"><strong>' + esc(n.cliente || "—") + "</strong><small>" + esc(doc(n.documento)) + "</small></span>" +
          "<span>" + esc(competencia(n.competencia)) + '</span><span class="dir num">' + esc(reais(Number(n.centavos || 0) / 100)) + "</span>" +
          '<span class="nf-sit ' + (COR[n.estado] || "") + '">' + esc(n.estado_rotulo || ESTADOS[n.estado] || n.estado) + (n.ambiente !== "producao" ? " · testes" : "") + "</span>" +
          '<span class="nf-seta" aria-hidden="true">' + (aberta ? "−" : "+") + "</span></button>" + (aberta ? '<div class="nf-det">' + detalhe(n) + "</div>" : "");
      }).join("") + "</div></div>";
    return h;
  }

  function detalhe(n) {
    var info = [];
    var docs = n.estado === "emitida" || n.estado === "cancelada" || n.estado === "substituida";
    info.push(["Tomador", (n.cliente || "—") + (n.documento ? " · " + doc(n.documento) : "")]);
    if (n.descricao) info.push(["Descrição", n.descricao]);
    if (n.quando) info.push([docs ? "Emitida em" : "Último passo", dataHora(n.quando)]);
    if (n.chave) info.push(["Chave", n.chave]);
    if (n.numero_dps) info.push(["DPS", "nº " + n.numero_dps + " · série " + (n.serie || "1")]);
    if (n.erro && n.estado !== "emitida") info.push(["Erro", n.erro]);
    if (n.tentativas) info.push(["Tentativas", String(n.tentativas) + (n.proxima_tentativa ? " · a próxima em " + dataHora(n.proxima_tentativa) : "")]);
    if (!n.conta) info.push(["Cliente", "sem cliente da Atos (nota avulsa): para entregar, baixe o PDF"]);
    else if (n.cliente_avisado && !/^erro/.test(n.cliente_avisado)) info.push(["Cliente", "guardada com a conta do cliente em " + dataHora(n.cliente_avisado)]);
    else if (n.cliente_avisado) info.push(["Cliente", "não chegou ao cliente: " + n.cliente_avisado.replace(/^erro:\s*/, "")]);
    else if (n.estado === "emitida") info.push(["Cliente", "ainda não foi ao cliente"]);
    if (n.email) info.push(["E-mail", n.email]);
    if (n.pagamento) info.push(["Pagamento", n.pagamento]);
    if (n.substituida_por_id) info.push(["Substituída por", "nota " + (((acharNota(n.substituida_por_id) || {}).numero) || "#" + n.substituida_por_id)]);
    if (n.substitui_id) info.push(["Substitui", "nota " + (((acharNota(n.substitui_id) || {}).numero) || "#" + n.substitui_id)]);
    var h = '<dl class="nf-info">' + info.map(function (x) { return "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("") + "</dl>";
    if (S.acao && String(S.acao.id) === String(n.id)) h += formAcao(n);
    else h += botoesDaNota(n, docs);
    return h + historico(n);
  }

  function botoesDaNota(n, docs) {
    var b = [], ocup = S.ocupado.indexOf(n.id + ":") === 0;
    var botao = function (rot, acao, ocupado, classe, extra) {
      var agora = S.ocupado === n.id + ":" + acao;
      return '<button type="button" class="btn p' + (classe ? " " + classe : "") + '" data-nf="' + acao + '" data-id="' + esc(n.id) + '"' + (extra != null ? extra : trava()) +
        (ocup ? " disabled" : "") + ">" + (agora ? ocupado : rot) + "</button>";
    };
    if (docs) {
      b.push('<a class="btn p" href="' + BASE + "notas/" + encodeURIComponent(n.id) + '/pdf" target="_blank" rel="noopener">Abrir o PDF</a>');
      b.push('<a class="btn p" href="' + BASE + "notas/" + encodeURIComponent(n.id) + '/pdf?baixar=1" download>Baixar o PDF</a>');
      b.push('<a class="btn p" href="' + BASE + "notas/" + encodeURIComponent(n.id) + '/xml" download>Baixar o XML</a>');
    }
    if (n.estado === "emitida") {
      var jaFoi = n.cliente_avisado && !/^erro/.test(n.cliente_avisado);
      b.push(botao(jaFoi ? "Enviar de novo ao cliente" : "Enviar ao cliente", "enviar", "Enviando…", "",
        !n.conta ? ' disabled title="a nota não é de um cliente da Atos: baixe o PDF e mande à mão"' : null));
      b.push(botao("Consultar a situação", "situacao", "Consultando…"));
      b.push(botao("Substituir", "substituir", ""));
      b.push(botao("Cancelar a nota", "cancelar", "", "perigo direita"));
    } else if (n.estado === "cancelada" || n.estado === "substituida") {
      b.push(botao("Consultar a situação", "situacao", "Consultando…"));
    } else if (PENDENTES.indexOf(n.estado) >= 0) {
      b.push(botao("Tentar agora", "tentar", "Tentando…"));
    } else if (n.estado === "rejeitada" || n.estado === "rascunho") {
      b.push(botao("Descartar", "descartar", "", "perigo"));
    }
    return b.length ? '<div class="botoes nf-botoes">' + b.join("") + "</div>" : "";
  }

  function formAcao(n) {
    var X = S.acao, op = ((S.resumo.situacao || {}).opcoes) || {}, h = "";
    var pe = function (rot, ocupado, classe) {
      return '<p class="erro" role="alert">' + esc(X.erro) + '</p><div class="botoes"><button type="button" class="btn p ' + classe + '" data-nf="acao-sim"' + (X.enviando ? " disabled" : "") + ">" +
        (X.enviando ? ocupado : rot) + '</button><button type="button" class="btn p" data-nf="acao-voltar">Voltar</button></div>';
    };
    if (X.tipo === "descartar") {
      return '<div class="confirmar" role="alertdialog" aria-label="Descartar a nota"><p>Descartar esta nota? Ela não virou NFS-e: sai da lista de pendentes e o número da DPS volta para a próxima nota. Não se desfaz.</p>' +
        pe("Descartar a nota", "Descartando…", "perigo") + "</div>";
    }
    if (X.tipo === "cancelar") {
      h += '<div class="confirmar" role="alertdialog" aria-label="Cancelar a nota"><p>Cancelar a NFS-e nº ' + esc(n.numero) + " · " + esc(n.cliente) + " · " + esc(reais(Number(n.centavos || 0) / 100)) +
        (n.ambiente === "producao" ? "" : " · ambiente de testes") + ". O cancelamento vai ao Sistema Nacional e não se desfaz; o município tem um prazo para cancelar. Depois do prazo, o caminho é Substituir.</p>" +
        '<div class="grade nf-grade">' + escolha("acao", "motivo", "Motivo (tabela oficial)", "s3", dominio(op.motivos_cancelamento, true)) +
        texto("acao", "texto", "Descreva o motivo (15 a 255 caracteres)", "tudo") + "</div>" + pe("Cancelar a nota", "Cancelando…", "perigo") + "</div>";
      return h;
    }
    // substituir
    h += '<div class="confirmar" role="alertdialog" aria-label="Substituir a nota"><p>Sai uma nota nova no lugar da nº ' + esc(n.numero) +
      ", e a Sefin cancela a antiga sozinha. Corrija abaixo o que estava errado; o resto vem da nota original.</p>" +
      '<div class="grade nf-grade">' + escolha("acao", "motivo", "Motivo (tabela oficial)", "s3", dominio(op.motivos_substituicao, true)) +
      texto("acao", "texto", "Descrição do motivo (15 a 255 caracteres; obrigatória no 99 – Outros)", "tudo") + "</div>" +
      h3("Tomador") + '<div class="grade nf-grade">' + tomadorCampos("acao", "ajustes.tomador.") + "</div>" +
      h3("Serviço") + '<div class="grade nf-grade">' + campo("acao", "ajustes.valor", "Valor (R$)", "s2", ' inputmode="decimal"') +
      campo("acao", "ajustes.competencia", "Competência", "s2", ' type="month"') + campo("acao", "ajustes.descricao", "Descrição", "tudo") + "</div>" +
      '<p class="dica">No Simples Nacional, a substituta não pode mudar o tomador, o valor nem a competência (regra E0061).</p>' +
      pe("Emitir a substituta", "Emitindo…", "primario") + "</div>";
    return h;
  }

  function historico(n) {
    var D = S.detalhe[n.id];
    if (!D || D === "carregando") return '<p class="dica nf-hist">Carregando o histórico…</p>';
    if (D.erro) return '<p class="dica nf-hist">Sem o histórico: ' + esc(D.erro) + "</p>";
    var h = h3("Histórico") + '<ol class="nf-passos">' + (D.passos || []).map(function (p) {
      var mudou = p.de && p.de !== p.para ? (ESTADOS[p.de] || p.de) + " → " + (ESTADOS[p.para] || p.para) : (ESTADOS[p.para] || p.para);
      return '<li><span class="nf-quando">' + esc(dataHora(p.quando)) + "</span><span>" + esc(mudou + (p.detalhe ? ": " + p.detalhe : "")) + "</span><small>" + esc(p.quem || "") + "</small></li>";
    }).join("") + "</ol>";
    if ((D.eventos || []).length) {
      h += h3("Eventos") + '<ol class="nf-passos">' + D.eventos.map(function (e) {
        return '<li><span class="nf-quando">' + esc(dataHora(e.atualizado_em || e.criado_em)) + "</span><span>" + esc((EVENTOS[e.tipo] || "Evento " + e.tipo) + " · " + e.estado +
          (e.ultimo_erro ? ": " + e.ultimo_erro : "")) + "</span><small>" + esc(e.motivo ? "motivo " + e.motivo : "") + "</small></li>";
      }).join("") + "</ol>";
    }
    return h;
  }

  // ---------- Emitir NFS-e

  function novoEm() {
    var v = { conta: "", pagamento: "", valor: "", competencia: mesAtual(), descricao: "" };
    TOMADOR.forEach(function (k) { v["tomador." + k] = ""; });
    return { v: v, cliQ: "", preencher: "", erro: "", enviando: false };
  }
  function bloqueio() {
    var s = S.resumo.situacao;
    if (!s) return "o emissor ainda não está ligado";
    if (!s.pode_emitir) return "ainda não dá para emitir: " + (s.motivos || []).join("; ");
    return "";
  }

  function abaEmitir() {
    var d = S.resumo, s = d.situacao, pg = d.pagamentos || [], h = "", bl = bloqueio();
    if (!S.em) S.em = novoEm();
    if (s && bl) h += faixa("<strong>Ainda não dá para emitir:</strong> " + esc((s.motivos || []).join("; ")) + ".");
    var trancar = !pode() ? trava() : bl ? ' disabled title="' + esc(bl) + '"' : "";
    h += h2("Pagamentos sem nota" + (pg.length ? " · " + pg.length : ""));
    if (!pg.length) h += vazio("Todos os pagamentos aprovados têm nota.");
    else {
      h += '<div class="card">' + pg.map(function (x) {
        var aviso = x.motivo || x.erro;
        return '<div class="item"><span class="nome"><strong>' + esc(nomeDoPagamento(x)) + " · " + esc(reais(x.valor)) + "</strong><small>" + esc([data(x.quando), x.descricao].filter(Boolean).join(" · ")) +
          (aviso ? '<span class="nf-atencao"> · ' + esc(aviso) + "</span>" : "") + "</small></span>" +
          '<button type="button" class="btn p" data-nf="pag-revisar" data-id="' + esc(x.id) + '"' + (pode() ? "" : trava()) + ">Revisar</button>" +
          '<button type="button" class="btn p primario" data-nf="pag-emitir" data-id="' + esc(x.id) + '"' + trancar + (S.ocupado === "pag:" + x.id ? " disabled" : "") + ">" +
          (S.ocupado === "pag:" + x.id ? "Emitindo…" : "Emitir") + "</button></div>";
      }).join("") + "</div>" +
        '<p class="nota">Emitir usa os dados fiscais do cliente (com o que foi corrigido em Clientes). Revisar põe o pagamento no formulário abaixo, para conferir ou mudar antes de emitir.</p>';
    }
    h += '<div id="nf-avulsa"></div>' + h2("Emitir uma nota");
    if (!pode()) return h + vazio("O suporte só consulta: emitir é do dono e do financeiro.");
    var E = S.em, cSel = E.v.conta ? acharCliente(E.v.conta) : null;
    h += '<div class="card grade">' + buscaCliente() +
      '<label class="campo s3"><span class="rotulo">Pagamento (opcional)</span><select class="seletor" id="nf-em-pag" data-nf-in="pag"><option value="">nenhum (nota avulsa)</option>' +
      pg.map(function (x) {
        return '<option value="' + esc(x.id) + '"' + (String(x.id) === String(E.v.pagamento) ? " selected" : "") + ">" + esc(nomeDoPagamento(x) + " · " + reais(x.valor) + " · " + data(x.quando)) + "</option>";
      }).join("") + "</select></label></div>";
    if (cSel && cSel.faltas && cSel.faltas.length) {
      h += faixa("Nos dados de " + esc(cSel.nome) + " falta " + esc(cSel.faltas.join(", ")) + ". Complete abaixo (vale só para esta nota) ou em Clientes (vale para as próximas).");
    }
    h += h2("Tomador") + '<div class="card grade">' + tomadorCampos("em", "tomador.") + "</div>" +
      h2("Serviço") + '<div class="card grade">' + campo("em", "valor", "Valor (R$)", "s2", ' inputmode="decimal" placeholder="300,00"') +
      campo("em", "competencia", "Competência", "s2", ' type="month"') + campo("em", "descricao", "Descrição", "tudo") + "</div>" +
      '<div class="salvar"><p class="erro" role="alert">' + esc(E.erro) + '</p><button type="button" class="btn primario" data-nf="emitir"' +
      (E.enviando ? " disabled" : bl ? ' disabled title="' + esc(bl) + '"' : "") + ">" + (E.enviando ? "Emitindo…" : "Emitir a nota") + "</button></div>" +
      '<p class="nota">' + (s && s.ambiente === "producao" ? "Produção: esta nota vale de verdade." : "Ambiente de testes: a nota não tem valor fiscal.") +
      " Com um pagamento escolhido, o cliente, o valor, a descrição e a competência vêm dele. O tomador digitado aqui vale só para esta nota.</p>";
    return h;
  }

  function buscaCliente() {
    var E = S.em, cl = S.clientes, h = '<div class="campo nf-busca s3"><label class="rotulo" for="nf-cli-q">Cliente da Atos (opcional)</label>';
    if (E.v.conta) {
      var c = acharCliente(E.v.conta);
      return h + '<div class="nf-escolhido"><span>' + esc(c ? c.nome + (c.documento ? " · " + doc(c.documento) : "") : "cliente " + E.v.conta.slice(0, 8)) +
        '</span><button type="button" class="link" data-nf="cli-tirar">Tirar</button></div></div>';
    }
    h += '<input id="nf-cli-q" data-nf-in="cli-q" value="' + esc(E.cliQ) + '" placeholder="' + (cl ? "nome, CPF/CNPJ ou e-mail" : S.clientesErro ? "sem a lista de clientes" : "carregando…") + '" autocomplete="off" spellcheck="false">';
    var q = String(E.cliQ || "").trim().toLowerCase(), qd = q.replace(/\D/g, "");
    if (q && cl) {
      var achados = cl.filter(function (c) {
        return (c.nome + " " + c.email).toLowerCase().indexOf(q) >= 0 || (qd && String(c.documento || "").indexOf(qd) >= 0);
      }).slice(0, 8);
      h += '<div class="nf-lista" role="listbox" aria-label="Clientes">' + (achados.length ? achados.map(function (c) {
        return '<button type="button" role="option" data-nf="cli-escolher" data-id="' + esc(c.id) + '">' + esc(c.nome || "—") + "<small>" + esc([doc(c.documento), c.email].filter(Boolean).join(" · ")) +
          (c.faltas && c.faltas.length ? " · falta " + esc(c.faltas.join(", ")) : "") + "</small></button>";
      }).join("") : '<span class="dica">Nenhum cliente com “' + esc(E.cliQ) + "”.</span>") + "</div>";
    } else if (S.clientesErro) h += '<span class="dica">Sem a lista de clientes (' + esc(S.clientesErro) + "): preencha à mão.</span>";
    else h += '<span class="dica">Sem cliente, a nota sai só com o tomador digitado.</span>';
    return h + "</div>";
  }

  function escolherCliente(id) {
    var E = S.em;
    E.v.conta = id;
    E.cliQ = "";
    var c = acharCliente(id);
    if (!c) {
      if (!S.clientes && !S.clientesErro) { E.preencher = id; carregarClientes(); }
      pintar();
      return;
    }
    E.preencher = "";
    TOMADOR.forEach(function (k) { E.v["tomador." + k] = (c.tomador || {})[k] || ""; });
    limparMun("em");
    pintar();
  }
  function escolherPagamento(id) {
    var E = S.em;
    E.v.pagamento = id;
    var p = id ? acharPagamento(id) : null;
    if (!p) { pintar(); return; }
    E.v.valor = decimal(Math.round(Number(p.valor || 0) * 100));
    E.v.descricao = p.descricao || "Serviço contratado na Atos";
    if (String(p.quando || "").length >= 7) E.v.competencia = String(p.quando).slice(0, 7);
    escolherCliente(p.cliente || "");
  }

  // ---------- Clientes

  function abaClientes() {
    var C = S.cl, h = '<p class="descricao nf-intro">Os clientes vêm dos dados fiscais que cada um preencheu na Atos. O que você corrigir aqui vale só para as notas; os dados do cliente na Atos ficam como estão.</p>';
    if (S.clientesErro) return h + vazio("Não consegui ler os clientes: " + esc(S.clientesErro) + ' <button type="button" class="link" data-nf="clientes-de-novo">Tentar de novo</button>');
    if (!S.clientes) return h + vazio("Carregando…");
    if (!S.clientes.length) return h + vazio("Nenhum cliente ainda. Um cliente aparece aqui quando preenche os dados fiscais na Atos ou quando um pagamento dele entra na fila.");
    var q = C.q.trim().toLowerCase(), qd = q.replace(/\D/g, "");
    var cont = { todos: S.clientes.length, falta: 0, completo: 0 };
    S.clientes.forEach(function (c) { if (c.faltas && c.faltas.length) cont.falta++; else cont.completo++; });
    var lista = S.clientes.filter(function (c) {
      var falta = Boolean(c.faltas && c.faltas.length);
      if (C.filtro === "falta" && !falta) return false;
      if (C.filtro === "completo" && falta) return false;
      var t = c.tomador || {};
      return !q || (c.nome + " " + (t.email || c.email || "")).toLowerCase().indexOf(q) >= 0 || (qd && String(t.documento || c.documento || "").indexOf(qd) >= 0);
    });
    h += '<div class="card filtros"><div class="opcoes" role="group" aria-label="Situação dos dados">' + [["todos", "Todos"], ["falta", "Com dados faltando"], ["completo", "Completos"]].map(function (o) {
      return '<button type="button" data-nf="cl-filtro" data-v="' + o[0] + '" aria-pressed="' + (C.filtro === o[0]) + '">' + o[1] + ' <span class="nf-n">' + cont[o[0]] + "</span></button>";
    }).join("") + '</div><div class="filtros-campos"><input class="seletor busca nf-busca-cl" id="nf-cl-q" type="search" data-nf-in="cl-q" aria-label="Buscar clientes" placeholder="Buscar" value="' + esc(C.q) + '"></div></div>';
    if (C.ok) h += faixa(esc(C.ok), true);
    if (!lista.length) return h + vazio("Nenhum cliente com esse filtro.");
    h += '<div class="card nf-clientes">' + lista.map(function (c) {
      var t = c.tomador || {}, aberto = String(C.editando) === String(c.id), falta = c.faltas && c.faltas.length;
      var r = '<button type="button" class="item nf-item" data-nf="cl-editar" data-id="' + esc(c.id) + '" aria-expanded="' + aberto + '"><span class="nome"><strong>' + esc(c.nome || "—") + "</strong><small>" +
        esc([t.email || c.email, doc(t.documento || c.documento)].filter(Boolean).join(" · ")) + "</small></span>" +
        (c.ajustado ? '<span class="nf-tag">corrigido aqui</span>' : "") + (!c.tem_perfil ? '<span class="nf-tag">sem dados na Atos</span>' : "") +
        '<span class="nf-sit ' + (falta ? "atencao" : "ok") + '">' + esc(falta ? "falta " + c.faltas.join(", ") : "completo") + '</span><span class="nf-seta" aria-hidden="true">' + (aberto ? "−" : "+") + "</span></button>";
      if (aberto) {
        r += '<div class="nf-det">' + '<div class="grade nf-grade">' + tomadorCampos("cl", "tomador.") + "</div>" +
          '<p class="dica">Deixar um campo vazio desfaz a correção dele: volta o dos dados fiscais do cliente na Atos.</p>' +
          '<p class="erro" role="alert">' + esc(C.erro) + "</p>" +
          '<div class="botoes">' + (pode() ? '<button type="button" class="btn p primario" data-nf="cl-salvar" data-id="' + esc(c.id) + '"' + (C.enviando ? " disabled" : "") + ">" +
          (C.enviando ? "Salvando…" : "Salvar") + "</button>" : "") + '<button type="button" class="btn p" data-nf="cl-editar" data-id="' + esc(c.id) + '">Fechar</button></div></div>';
      }
      return r;
    }).join("") + "</div>";
    return h;
  }

  // ---------- Parâmetros

  function montarPar(s) {
    var p = JSON.parse(JSON.stringify((s.prestador || {}).dados || {}));
    var v = achatar(p, "");
    Object.keys(v).forEach(function (k) {
      if (/_bp$/.test(k)) { v[k.replace(/_bp$/, "_pct")] = pct(v[k]); delete v[k]; }
    });
    v["ibscbs.enviar"] = Boolean((p.ibscbs || {}).enviar);
    return { v: v, erro: "", enviando: false };
  }

  function abaParametros() {
    var d = S.resumo, s = d.situacao, cf = d.cloudflare || {}, c = (d.config || {}), h = "";
    h += h2("Interruptores") + '<div class="card">' + INTERRUPTORES.map(function (o) {
      var on = Boolean(c[o[0]]);
      return '<button type="button" class="nf-chave" role="switch" aria-checked="' + on + '" data-nf="cfg" data-k="' + o[0] + '"' + trava() + (S.cfgMudando ? " disabled" : "") +
        '><span class="nome"><strong>' + esc(o[1]) + "</strong><small>" + esc(o[2]) + '.</small></span><span class="nf-interruptor" aria-hidden="true"></span></button>';
    }).join("") + '</div><p class="nota">Valem na hora, para os próximos pagamentos e as próximas notas.</p>';
    if (s) h += certificado(s, cf);
    h += h2("Comunicação com a Sefin", '<button type="button" class="btn p" data-nf="testar"' + (!s ? " disabled" : trava()) + (S.testando ? " disabled" : "") + ">" + (S.testando ? "Testando…" : "Testar a comunicação") + "</button>");
    var t = S.teste;
    if (t) {
      h += '<div class="card"><p class="vazio"><strong class="' + (t.ok ? "nf-ok" : "nf-ruim") + '">' + (t.ok ? "A comunicação está certa" : "A comunicação falhou") + "</strong> · " + esc(dataHora(t.quando)) + "</p>" +
        (t.etapas || []).map(function (e) {
          return '<div class="item"><span class="nf-marca ' + (e.ok ? "nf-ok" : "nf-ruim") + '" aria-hidden="true">' + (e.ok ? "✓" : "×") + '</span><span class="nome"><strong>' + esc(e.titulo) + "</strong><small>" +
            esc(e.detalhe || "") + "</small></span>" + (e.ms != null ? '<span class="dica">' + esc(e.ms) + " ms</span>" : "") + "</div>";
        }).join("") + "</div>";
    } else h += vazio(s ? "Confere o certificado, a conexão com a Sefin (pelo mTLS) e o convênio do município, com o tempo de cada um." : "O teste precisa do emissor ligado.");
    h += h2("Token da Cloudflare") + '<div class="card"><p class="vazio">Com ele o painel cadastra o certificado na Cloudflare (o mTLS que a Sefin exige) e republica o Worker auxiliar ' +
      esc(cf.auxiliar || "atos-nfse-mtls") + ". " + esc(cf.como_criar_token || "") + " Fica guardado cifrado e não volta para a tela.</p>" +
      '<div class="botoes"><input type="password" class="seletor nf-segredo" id="nf-token" data-nf-in="token" placeholder="' + (cf.token ? "token gravado: cole outro para trocar" : "cole o token aqui") +
      '" autocomplete="off" aria-label="Token da Cloudflare"' + dis() + '><button type="button" class="btn p primario" data-nf="token"' + trava() + (S.gravandoToken ? " disabled" : "") + ">" +
      (S.gravandoToken ? "Gravando…" : "Gravar o token") + '</button><span class="selo' + (cf.token ? "" : " neutro") + '">' + (cf.token ? "token gravado" : "sem token") + "</span></div>" +
      (S.tokenMsg ? '<p class="nf-aviso dentro' + (S.tokenMsg.ok ? " ok" : "") + '">' + esc(S.tokenMsg.texto) + "</p>" : "") + "</div>";
    if (!s) return h;
    if (!S.par) S.par = montarPar(s);
    h += prestador(s) + producao(s);
    return h;
  }

  function certificado(s, cf) {
    var c = s.certificado || {}, h = h2("Certificado digital A1", c.instalado ? '<span class="dica">instalado em ' + esc(data(c.instalado_em)) + "</span>" : "") + '<div class="card">';
    if (c.instalado) {
      var dias = c.dias_restantes, perto = c.vencido || (dias != null && dias <= 30);
      h += '<div class="colunas"><div><span class="rotulo">Titular</span><span>' + esc(String(c.titular || "—").split(":")[0]) + "</span></div>" +
        '<div><span class="rotulo">CNPJ/CPF</span><span>' + esc(doc(c.documento) || "—") + "</span></div>" +
        '<div><span class="rotulo">Vencimento</span><span' + (perto ? ' class="nf-ruim"' : "") + ">" + esc(data(c.valido_ate) + (dias != null ? " · " + (dias < 0 ? "vencido" : dias + (dias === 1 ? " dia" : " dias")) : "")) + "</span></div>" +
        '<div><span class="rotulo">Conexão</span><span>' + esc(cf.mtls ? "mTLS na Cloudflare desde " + data(cf.mtls.quando) : cf.falta || "ainda não cadastrado na Cloudflare") + "</span></div></div>";
    } else h += '<p class="vazio">Nenhum certificado instalado. Use o A1 (.pfx ou .p12) de quem emite as notas da Atos; o nome, o documento e o vencimento saem dele.</p>';
    if (pode()) {
      h += '<div class="botoes nf-cert"><label class="btn p nf-arquivo"><span>' + esc(S.pfx ? S.pfx.nome : "Escolher o .pfx") + '</span><input type="file" id="nf-pfx" data-nf-arquivo accept=".pfx,.p12,application/x-pkcs12"></label>' +
        '<input type="password" class="seletor nf-segredo" id="nf-senha" data-nf-in="senha" placeholder="senha do certificado" autocomplete="off" aria-label="Senha do certificado">' +
        '<button type="button" class="btn p primario" data-nf="cert"' + (S.instalando || !S.pfx ? " disabled" : "") + ">" + (S.instalando ? "Instalando…" : c.instalado ? "Trocar o certificado" : "Instalar") + "</button></div>";
    }
    if (S.certAviso) h += '<p class="nf-aviso dentro' + (S.certAviso.ok ? " ok" : "") + '">' + esc(S.certAviso.texto) + "</p>";
    if (c.instalado && cf.falta && !cf.mtls) h += '<p class="nf-aviso dentro">Sem a conexão com a Sefin: ' + esc(cf.falta) + ".</p>";
    return h + '</div><p class="nota">O .pfx é aberto aqui no navegador: o arquivo e a senha não saem desta página. Vão ao servidor só o certificado e a chave, guardados cifrados e, com o token da Cloudflare, cadastrados no mTLS da Cloudflare.</p>';
  }

  function prestador(s) {
    var op = s.opcoes || {}, ret = op.retencoes || {}, f = "par", num = ' inputmode="numeric"', decim = ' inputmode="decimal"';
    var h = h2("O prestador (quem emite)") + '<div class="card grade">' +
      campo(f, "razao_social", "Razão social", "s4") + campo(f, "documento", "CNPJ", "s2", num) +
      campo(f, "inscricao_municipal", "Inscrição municipal", "s2") + campo(f, "email", "E-mail", "s2") + campo(f, "telefone", "Telefone", "s2", num) + "</div>" +
      h2("Endereço") + '<div class="card grade">' +
      campo(f, "endereco.cep", "CEP", "s2", num) + campo(f, "endereco.logradouro", "Rua", "s4") +
      campo(f, "endereco.numero", "Número", "s2") + campo(f, "endereco.complemento", "Complemento", "s2") + campo(f, "endereco.bairro", "Bairro", "s2") +
      campoMun(f, "municipio", "", "Município", "s4") + "</div>" +
      h2("Tributação") + '<div class="card grade">' +
      escolha(f, "opcao_simples", "Regime", "s3", dominio(op.opcao_simples)) +
      escolha(f, "regime_apuracao_sn", "Apuração no Simples", "s3", [["", "não se aplica"]].concat(dominio(op.regime_apuracao_sn, true))) +
      escolha(f, "regime_especial", "Regime especial", "s3", dominio(op.regime_especial)) + campo(f, "serie", "Série da DPS", "s3", num) + "</div>" +
      h2("Serviço") + '<div class="card grade">' +
      campo(f, "servico.ctribnac", "Código de serviço (cTribNac)", "s2", ' placeholder="ex.: 010501"') + campo(f, "servico.nbs", "NBS", "s2") +
      campo(f, "servico.ctribmun", "Código municipal (3 dígitos, se houver)", "s2") + campo(f, "servico.aliquota_iss_pct", "Alíquota do ISS (%)", "s2", decim + ' placeholder="2,00"') +
      campo(f, "servico.descricao", "Descrição padrão do serviço", "s4") + "</div>" +
      h2("IBS/CBS e tributos aproximados") + '<div class="card grade">' +
      campo(f, "ibscbs.cst", "IBS/CBS — CST", "s2") + campo(f, "ibscbs.cclasstrib", "IBS/CBS — cClassTrib", "s2") + campo(f, "ibscbs.cindop", "IBS/CBS — cIndOp", "s2") +
      escolha(f, "ibscbs.indfinal", "Consumidor final", "s2", [["0", "não"], ["1", "sim"]]) + marcar(f, "ibscbs.enviar", "Enviar o grupo IBS/CBS na nota", "s4") +
      campo(f, "pis_cofins.cst", "PIS/COFINS — CST (se houver retenção)", "s2") + campo(f, "total_tributos.federal_pct", "Aproximados — federal (%)", "s2", decim) +
      campo(f, "total_tributos.estadual_pct", "Aproximados — estadual (%)", "s2", decim) + campo(f, "total_tributos.municipal_pct", "Aproximados — municipal (%)", "s2", decim) + "</div>" +
      '<p class="nota">O código do serviço, a NBS e a classificação do IBS/CBS são do contador.</p>';
    var ks = Object.keys(ret);
    if (ks.length) {
      h += h2("Retenções") + '<div class="card grade">' + ks.map(function (k) {
        return escolha(f, "retencoes." + k + ".quando", ret[k] + " — quando reter", "s3", dominio(op.quando_reter)) +
          (k === "iss" ? '<span class="s3"></span>' : campo(f, "retencoes." + k + ".aliquota_pct", ret[k] + " — alíquota (%)", "s3", decim));
      }).join("") + "</div>";
    }
    h += h2("Contador") + '<div class="card grade">' + campo(f, "contador.nome", "Contador", "s3") + campo(f, "contador.email", "E-mail do contador", "s3") + "</div>";
    if (pode()) {
      h += '<div class="salvar"><p class="erro" role="alert">' + esc(S.par.erro) + '</p><button type="button" class="btn primario" data-nf="par-salvar"' + (S.par.enviando ? " disabled" : "") + ">" +
        (S.par.enviando ? "Gravando…" : "Gravar os parâmetros") + "</button></div>";
    }
    return h;
  }

  function producao(s) {
    var h = h2("Produção") + '<div class="card"><p class="vazio">' + (s.producao_liberada ? "Em produção: as notas valem de verdade."
      : "Em testes (produção restrita, sem valor fiscal). Só passa para produção com os parâmetros completos, o certificado instalado e ao menos uma nota emitida em testes.") + "</p>";
    if (S.prodConfirma) {
      h += '<div class="confirmar" role="alertdialog" aria-label="Passar para produção"><p>Passar para produção? Daqui em diante cada nota emitida vale de verdade no Sistema Nacional da NFS-e.</p>' +
        '<div class="botoes"><button type="button" class="btn p perigo" data-nf="prod-sim"' + (S.mudandoProd ? " disabled" : "") + ">" + (S.mudandoProd ? "Passando…" : "Passar para produção") +
        '</button><button type="button" class="btn p" data-nf="prod-nao">Voltar</button></div></div>';
    } else {
      h += '<div class="botoes">' + (s.producao_liberada
        ? '<button type="button" class="btn p" data-nf="prod-voltar"' + trava() + (S.mudandoProd ? " disabled" : "") + ">" + (S.mudandoProd ? "Voltando…" : "Voltar para testes") + "</button>"
        : '<button type="button" class="btn p" data-nf="prod-liberar"' + trava() + ">Passar para produção</button>") + "</div>";
    }
    return h + (S.erroProd ? '<p class="erro nf-dentro" role="alert">' + esc(S.erroProd) + "</p>" : "") + "</div>";
  }

  // ------------------------------------------------------------ os pedidos

  function carregar() {
    S.carregando = true;
    pintar();
    return api("GET", "resumo").then(function (r) {
      S.carregando = false;
      if (ok(r)) {
        S.resumo = r.dados;
        S.erro = "";
        S.detalhe = {};
        if (S.aberta && !acharNota(S.aberta)) S.aberta = null;
        if (S.aberta) carregarDetalhe(S.aberta);
      } else if (!S.resumo) S.erro = erroDe(r);
      else avisar(erroDe(r), false, r);
      pintar();
    });
  }
  function carregarDetalhe(id) {
    S.detalhe[id] = "carregando";
    api("GET", "notas/" + encodeURIComponent(id)).then(function (r) {
      S.detalhe[id] = ok(r) ? r.dados : { erro: erroDe(r) };
      pintar();
    });
  }
  function carregarClientes() {
    if (S.clientesCarregando) return;
    S.clientesCarregando = true;
    api("GET", "clientes").then(function (r) {
      S.clientesCarregando = false;
      if (ok(r)) { S.clientes = r.dados.clientes || []; S.clientesErro = ""; } else { S.clientes = null; S.clientesErro = erroDe(r); }
      if (S.em && S.em.preencher && S.clientes) escolherCliente(S.em.preencher);
      else pintar();
    });
  }
  /* O PDF e o e-mail num pedido separado, logo depois de emitir (o Cron faz, se este falhar). */
  function depois(id) { api("POST", "notas/" + encodeURIComponent(id) + "/depois", {}); }
  function fraseDaNota(n, antes) {
    if (n.estado === "emitida") { depois(n.id); return [(antes || "") + "NFS-e nº " + n.numero + " emitida.", true]; }
    return ["A nota ficou “" + (n.estado_rotulo || ESTADOS[n.estado] || n.estado) + "”" + (n.erro ? ": " + n.erro : "") + ".", false];
  }

  function acaoNaNota(id, acao, corpo, sucesso) {
    S.ocupado = id + ":" + acao;
    pintar();
    api("POST", "notas/" + encodeURIComponent(id) + "/" + acao, corpo || {}).then(function (r) {
      S.ocupado = "";
      if (!ok(r)) {
        if (S.acao && String(S.acao.id) === String(id)) { S.acao.enviando = false; S.acao.erro = erroDe(r); }
        else avisar(erroDe(r), false, r);
        pintar();
        return;
      }
      S.acao = null;
      var f = sucesso(r.dados);
      avisar(f[0], f[1]);
      carregar();
    });
  }

  function confirmarAcao() {
    var X = S.acao, n = X && acharNota(X.id);
    if (!X || !n || X.enviando) return;
    var tamanho = String(X.v.texto || "").trim().length;
    if (X.tipo === "cancelar" && (tamanho < 15 || tamanho > 255)) { X.erro = "Descreva o motivo com 15 a 255 caracteres."; pintar(); return; }
    if (X.tipo === "substituir") {
      if (X.v.motivo === "99" && !tamanho) { X.erro = "Com o motivo 99 – Outros, descreva o motivo (15 a 255 caracteres)."; pintar(); return; }
      if (tamanho && (tamanho < 15 || tamanho > 255)) { X.erro = "A descrição do motivo tem de 15 a 255 caracteres."; pintar(); return; }
    }
    X.enviando = true;
    X.erro = "";
    if (X.tipo === "descartar") {
      acaoNaNota(n.id, "descartar", {}, function () { return ["Nota descartada; o número volta para a próxima.", true]; });
    } else if (X.tipo === "cancelar") {
      acaoNaNota(n.id, "cancelar", { motivo: X.v.motivo, texto: X.v.texto }, function (d) {
        var ev = d.evento || {};
        if (d.nota && d.nota.estado === "cancelada") return ["NFS-e nº " + d.nota.numero + " cancelada.", true];
        return ["O cancelamento ficou “" + (ev.estado || "pendente") + "”" + (ev.ultimo_erro ? ": " + ev.ultimo_erro : "") + ".", false];
      });
    } else {
      acaoNaNota(n.id, "substituir", aninhar(X.v, ""), function (d) {
        var nova = d.nota || {};
        if (nova.estado === "emitida") { depois(nova.id); S.aberta = nova.id; return ["NFS-e nº " + nova.numero + " emitida no lugar da nº " + ((d.original || {}).numero || "") + ".", true]; }
        return ["A substituta ficou “" + (nova.estado_rotulo || nova.estado) + "”" + (nova.erro ? ": " + nova.erro : "") + ".", false];
      });
    }
  }

  function emitir() {
    var E = S.em;
    if (!E || E.enviando) return;
    var v = E.v, corpo = { tomador: aninhar(v, "tomador."), descricao: v.descricao, competencia: v.competencia };
    if (v.conta) corpo.conta = v.conta;
    if (v.pagamento) corpo.pagamento = v.pagamento;
    if (String(v.valor || "").trim()) corpo.valor = String(v.valor).trim();
    else if (!v.pagamento) { E.erro = "Diga o valor da nota."; pintar(); return; }
    E.enviando = true;
    E.erro = "";
    pintar();
    api("POST", "notas", corpo).then(function (r) {
      E.enviando = false;
      if (!ok(r)) { E.erro = erroDe(r); pintar(); return; }
      var f = fraseDaNota(r.dados);
      avisar(f[0], f[1]);
      S.em = novoEm();
      limparMun("em");
      S.aba = "notas";
      S.aberta = r.dados.id;
      carregar();
    });
  }

  function emitirPagamento(ref) {
    S.ocupado = "pag:" + ref;
    pintar();
    api("POST", "pagamentos/" + encodeURIComponent(ref) + "/emitir", {}).then(function (r) {
      S.ocupado = "";
      if (!ok(r)) { avisar(erroDe(r), false, r); pintar(); return; }
      var f = fraseDaNota(r.dados);
      avisar(f[0], f[1]);
      carregar();
    });
  }

  function salvarCliente(id) {
    var C = S.cl;
    if (C.enviando) return;
    var t = {}, mudou = 0;
    TOMADOR.forEach(function (k) {
      var antes = String(C.orig[k] == null ? "" : C.orig[k]), agora = String(C.v["tomador." + k] == null ? "" : C.v["tomador." + k]).trim();
      if (antes !== agora) { t[k] = agora; mudou++; }
    });
    if (!mudou) { C.erro = "Nada mudou."; pintar(); return; }
    C.enviando = true;
    C.erro = "";
    pintar();
    api("POST", "clientes/" + encodeURIComponent(id), { tomador: t }).then(function (r) {
      C.enviando = false;
      if (!ok(r)) { C.erro = erroDe(r); pintar(); return; }
      var c = r.dados || {};
      if (c.id) S.clientes = (S.clientes || []).map(function (x) { return String(x.id) === String(id) ? c : x; });
      C.editando = null;
      C.ok = "Dados de " + (c.nome || "cliente") + " salvos para as notas" + (c.faltas && c.faltas.length ? "; ainda falta " + c.faltas.join(", ") : "") + ".";
      pintar();
    });
  }

  function salvarParametros() {
    var P = S.par;
    if (!P || P.enviando) return;
    var v = {}, ruim = false;
    Object.keys(P.v).forEach(function (k) {
      if (/^(ambiente|revisado_por|revisado_em|uf)$/.test(k)) return;
      if (/_pct$/.test(k)) { var b = bp(P.v[k]); if (isNaN(b)) ruim = true; v[k.replace(/_pct$/, "_bp")] = b; } else v[k] = P.v[k];
    });
    if (ruim) { P.erro = "Confira os percentuais: use números como 2,00."; pintar(); return; }
    P.enviando = true;
    P.erro = "";
    pintar();
    api("POST", "prestador", { prestador: aninhar(v, "") }).then(function (r) {
      P.enviando = false;
      if (!ok(r)) { P.erro = erroDe(r); pintar(); return; }
      var d = r.dados, faltas = d.faltas && d.faltas.length ? "; ainda falta " + d.faltas.join(", ") : "";
      avisar(d.mudou ? "Parâmetros gravados (versão " + d.versao + ")" + faltas + "." : "Nada mudou nos parâmetros" + faltas + ".", !faltas);
      S.par = null;
      carregar();
    });
  }

  function instalarCertificado() {
    if (!S.pfx || S.instalando) return;
    S.instalando = true;
    S.certAviso = null;
    pintar();
    carregarScript("/assets/vendor/forge.min.js").then(function () { return carregarScript("/assets/nfse-pfx.js"); }).then(function () {
      var par = window.AtosPfx.ler(S.pfx.bytes, S.senha);
      return api("POST", "certificado", par);
    }).then(function (r) {
      S.instalando = false;
      if (!ok(r)) { S.certAviso = { ok: false, texto: erroDe(r) }; pintar(); return; }
      var cx = r.dados.conexao || {};
      S.pfx = null;
      S.senha = "";
      S.certAviso = { ok: Boolean(cx.ok), texto: "Certificado de " + ((r.dados.certificado || {}).titular || "—") + " instalado. " + (cx.frase || "") + (cx.aviso ? " " + cx.aviso : "") };
      carregar();
    }, function (e) {
      S.instalando = false;
      S.certAviso = { ok: false, texto: e.message };
      pintar();
    });
  }

  function gravarToken() {
    if (S.gravandoToken) return;
    if (!S.token.trim()) { S.tokenMsg = { ok: false, texto: "Cole o token antes de gravar." }; pintar(); return; }
    S.gravandoToken = true;
    S.tokenMsg = null;
    pintar();
    api("POST", "cloudflare", { token: S.token.trim() }).then(function (r) {
      S.gravandoToken = false;
      if (!ok(r)) { S.tokenMsg = { ok: false, texto: erroDe(r) }; pintar(); return; }
      S.token = "";
      var cx = r.dados.conexao;
      S.tokenMsg = { ok: !cx || Boolean(cx.ok), texto: "Token gravado (cifrado)." + (cx ? " " + cx.frase : "") };
      if (S.resumo) S.resumo.cloudflare = r.dados.cloudflare;
      carregar();
    });
  }

  function mudarConfig(k) {
    var c = (S.resumo && S.resumo.config) || {};
    var novo = { auto: Boolean(c.auto), email: Boolean(c.email), mail: Boolean(c.mail) };
    novo[k] = !novo[k];
    S.cfgMudando = true;
    pintar();
    api("POST", "config", novo).then(function (r) {
      S.cfgMudando = false;
      if (!ok(r)) avisar(erroDe(r), false, r);
      else {
        S.resumo.config = r.dados.config;
        var o = INTERRUPTORES.filter(function (x) { return x[0] === k; })[0];
        avisar((r.dados.config[k] ? "Ligado: " : "Desligado: ") + o[1].toLowerCase() + ".", true);
      }
      pintar();
    });
  }

  function mudarProducao(acao) {
    S.mudandoProd = true;
    S.erroProd = "";
    pintar();
    api("POST", "producao/" + acao, {}).then(function (r) {
      S.mudandoProd = false;
      S.prodConfirma = false;
      if (!ok(r)) { S.erroProd = erroDe(r); pintar(); return; }
      avisar(r.dados.producao_liberada ? "Em produção: as notas valem de verdade." : "De volta ao ambiente de testes.", true);
      S.par = null;
      carregar();
    });
  }

  function testar() {
    if (S.testando) return;
    S.testando = true;
    pintar();
    api("POST", "testar", {}).then(function (r) {
      S.testando = false;
      if (ok(r)) S.teste = r.dados; else avisar(erroDe(r), false, r);
      carregar();
    });
  }

  function processarFila() {
    S.ocupado = "fila";
    pintar();
    api("POST", "fila", {}).then(function (r) {
      S.ocupado = "";
      if (!ok(r)) avisar(erroDe(r), false, r);
      else avisar("Fila processada: " + (r.dados.feitas || 0) + (r.dados.feitas === 1 ? " nota." : " notas."), true);
      carregar();
    });
  }

  // ------------------------------------------------------------ o municipio (digitar e escolher)

  function limparMun(f) { Object.keys(S.mun).forEach(function (k) { if (k.indexOf(f + ":") === 0) delete S.mun[k]; }); }
  function digitarMun(el) {
    var f = el.getAttribute("data-mun"), k = el.getAttribute("data-k"), kUf = el.getAttribute("data-uf"), F = formDe(f);
    if (!F) return;
    var chave = f + ":" + k, st = S.mun[chave] = S.mun[chave] || {}, t = el.value;
    clearTimeout(st.timer);
    st.kUf = kUf;
    if (/^\s*\d{7}\s*$/.test(t)) {
      var cod = t.replace(/\D/g, "");
      F.v[k] = cod;
      if (kUf && UF_DO_CODIGO[cod.slice(0, 2)]) F.v[kUf] = UF_DO_CODIGO[cod.slice(0, 2)];
      delete S.mun[chave];
      pedirNomeMun(cod);
      pintar();
      return;
    }
    F.v[k] = "";
    st.editando = true;
    st.texto = t;
    st.idx = 0;
    st.erro = "";
    if (!t.trim()) { st.res = null; st.editando = false; pintar(); return; }
    st.timer = setTimeout(function () {
      api("GET", "municipios?q=" + encodeURIComponent(t)).then(function (r) {
        if (S.mun[chave] !== st || st.texto !== t) return;
        if (ok(r)) st.res = r.dados.municipios || []; else { st.res = []; st.erro = "Não consegui buscar agora: " + erroDe(r); }
        st.idx = 0;
        pintar();
      });
    }, 200);
  }
  function escolherMun(f, k, i) {
    var chave = f + ":" + k, st = S.mun[chave], F = formDe(f);
    if (!st || !st.res || !F) return;
    var m = st.res[Number(i)];
    if (!m) return;
    F.v[k] = m.codigo;
    NOMES_MUN[m.codigo] = m.nome + "/" + m.uf;
    if (st.kUf) F.v[st.kUf] = m.uf;
    delete S.mun[chave];
    pintar();
    var el = document.getElementById(idDe(f, k));
    if (el) el.focus();
  }

  // ------------------------------------------------------------ os eventos

  function dentro(el) { return Boolean(S.raiz && el && S.raiz.contains(el)); }

  function irAba(aba) {
    S.aba = aba;
    S.acao = null;
    if ((aba === "emitir" || aba === "clientes") && !S.clientes && !S.clientesErro) carregarClientes();
    pintar();
  }

  document.addEventListener("click", function (e) {
    if (!dentro(e.target)) return;
    // Clicar fora da lista de municipios fecha a lista (o texto digitado fica).
    if (!e.target.closest(".nf-mun")) {
      var fechou = false;
      Object.keys(S.mun).forEach(function (k) { if (S.mun[k].res) { S.mun[k].res = null; fechou = true; } });
      if (fechou && !e.target.closest("[data-nf], [data-nf-aba]")) { pintar(); return; }
    }
    var aba = e.target.closest("[data-nf-aba]");
    if (aba) { irAba(aba.getAttribute("data-nf-aba")); return; }
    var b = e.target.closest("[data-nf]");
    if (!b || b.disabled) return;
    var a = b.getAttribute("data-nf"), id = b.getAttribute("data-id") || "", n;
    if (a === "recarregar") { S.aviso = null; carregar(); }
    else if (a === "fechar-aviso") { S.aviso = null; pintar(); }
    else if (a === "filtro") { S.filtro = b.getAttribute("data-v"); pintar(); }
    else if (a === "fila") processarFila();
    else if (a === "abrir") {
      S.acao = null;
      if (String(S.aberta) === id) S.aberta = null;
      else { S.aberta = id; if (!S.detalhe[id]) carregarDetalhe(id); }
      pintar();
    } else if (a === "enviar") {
      acaoNaNota(id, "enviar", {}, function (d) {
        return ["Nota nº " + ((d.nota || {}).numero || "") + " guardada com a conta do cliente" + (d.email ? "; e-mail: " + d.email : "") + ".", !/^(falhou|sem)/.test(d.email || "")];
      });
    } else if (a === "tentar") acaoNaNota(id, "tentar", {}, function (d) { return fraseDaNota(d); });
    else if (a === "situacao") acaoNaNota(id, "situacao", {}, function (d) { return ["Situação consultada: a nota está “" + (d.estado_rotulo || d.estado) + "”.", true]; });
    else if (a === "descartar") { S.acao = { tipo: "descartar", id: id, v: {}, erro: "", enviando: false }; pintar(); }
    else if (a === "cancelar") { S.acao = { tipo: "cancelar", id: id, v: { motivo: "1", texto: "" }, erro: "", enviando: false }; pintar(); }
    else if (a === "substituir") {
      n = acharNota(id);
      if (!n) return;
      var v = { motivo: "99", texto: "", "ajustes.valor": decimal(n.centavos), "ajustes.competencia": String(n.competencia || "").slice(0, 7), "ajustes.descricao": n.descricao || "" };
      TOMADOR.forEach(function (k) { v["ajustes.tomador." + k] = (n.tomador || {})[k] || ""; });
      limparMun("acao");
      S.acao = { tipo: "substituir", id: id, v: v, erro: "", enviando: false };
      pintar();
    } else if (a === "acao-sim") confirmarAcao();
    else if (a === "acao-voltar") { S.acao = null; pintar(); }
    else if (a === "pag-emitir") emitirPagamento(id);
    else if (a === "pag-revisar") {
      S.em = novoEm();
      limparMun("em");
      escolherPagamento(id);
      var alvo = document.getElementById("nf-avulsa");
      if (alvo && alvo.scrollIntoView) alvo.scrollIntoView();
    } else if (a === "cli-escolher") escolherCliente(id);
    else if (a === "cli-tirar") { S.em.v.conta = ""; S.em.preencher = ""; pintar(); var q = document.getElementById("nf-cli-q"); if (q) q.focus(); }
    else if (a === "emitir") emitir();
    else if (a === "mun") escolherMun(b.getAttribute("data-f"), b.getAttribute("data-k"), b.getAttribute("data-i"));
    else if (a === "clientes-de-novo") { S.clientesErro = ""; carregarClientes(); pintar(); }
    else if (a === "cl-filtro") { S.cl.filtro = b.getAttribute("data-v"); pintar(); }
    else if (a === "cl-editar") {
      var C = S.cl;
      if (String(C.editando) === id) { C.editando = null; pintar(); return; }
      var c = acharCliente(id);
      if (!c) return;
      C.editando = id; C.erro = ""; C.ok = ""; C.v = {}; C.orig = {};
      TOMADOR.forEach(function (k) { var x = (c.tomador || {})[k] || ""; C.v["tomador." + k] = x; C.orig[k] = x; });
      limparMun("cl");
      pintar();
    } else if (a === "cl-salvar") salvarCliente(id);
    else if (a === "cfg") mudarConfig(b.getAttribute("data-k"));
    else if (a === "cert") instalarCertificado();
    else if (a === "testar") testar();
    else if (a === "token") gravarToken();
    else if (a === "par-salvar") salvarParametros();
    else if (a === "prod-liberar") { S.prodConfirma = true; S.erroProd = ""; pintar(); }
    else if (a === "prod-nao") { S.prodConfirma = false; pintar(); }
    else if (a === "prod-sim") mudarProducao("liberar");
    else if (a === "prod-voltar") mudarProducao("voltar");
  });

  function aoDigitar(e) {
    var el = e.target;
    if (!dentro(el)) return;
    var f = el.getAttribute("data-f");
    if (f) {
      var F = formDe(f);
      if (F) F.v[el.getAttribute("data-k")] = el.type === "checkbox" ? el.checked : el.value;
      return;
    }
    if (el.hasAttribute("data-mun")) { if (e.type === "input") digitarMun(el); return; }
    var x = el.getAttribute("data-nf-in");
    if (x === "senha") S.senha = el.value;
    else if (x === "token") S.token = el.value;
    else if (x === "cli-q" && e.type === "input") { S.em.cliQ = el.value; pintar(); }
    else if (x === "cl-q" && e.type === "input") { S.cl.q = el.value; pintar(); }
    else if (x === "pag" && e.type === "change") escolherPagamento(el.value);
  }
  document.addEventListener("input", aoDigitar);
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (dentro(el) && el.hasAttribute("data-nf-arquivo")) {
      var arq = el.files && el.files[0];
      if (!arq) return;
      if (arq.size > 64 * 1024) { S.certAviso = { ok: false, texto: "Esse arquivo é grande demais para um certificado A1 (.pfx)." }; el.value = ""; pintar(); return; }
      arq.arrayBuffer().then(function (buf) { S.pfx = { nome: arq.name, bytes: new Uint8Array(buf) }; S.certAviso = null; pintar(); });
      return;
    }
    aoDigitar(e);
  });

  document.addEventListener("keydown", function (e) {
    var el = e.target;
    if (!dentro(el)) return;
    if (el.hasAttribute && el.hasAttribute("data-mun")) {
      var f = el.getAttribute("data-mun"), k = el.getAttribute("data-k"), st = S.mun[f + ":" + k], n = st && st.res ? st.res.length : 0;
      if (!st || !st.editando) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) { st.idx = ((st.idx + (e.key === "ArrowDown" ? 1 : -1)) % n + n) % n; pintar(); }
      else if (e.key === "Enter" && n) escolherMun(f, k, st.idx);
      else if (e.key === "Escape" && st.res) { st.res = null; pintar(); }
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && S.acao && !S.acao.enviando) { S.acao = null; pintar(); }
    else if (e.key === "Escape" && S.prodConfirma && !S.mudandoProd) { S.prodConfirma = false; pintar(); }
  });

  A.secoes.push({
    id: "notas",
    nome: "Notas fiscais",
    desenhar: function (raiz, ctx) {
      S.raiz = raiz;
      S.ctx = ctx;
      pintar();
      if (!S.resumo && !S.carregando) carregar();
    },
  });
})();
