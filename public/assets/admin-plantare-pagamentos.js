/* Revisões financeiras Plantare; a sessão, área e papel são conferidos no servidor. */
(function () {
  "use strict";
  var A = window.AdminAtos;
  if (!A) return;
  var B = "/api/admin/plantare-pagamentos", esc = A.esc;
  var S = { raiz: null, itens: [], cursor: null, detalhe: null, erro: "", ocupado: false, tentativa: null };
  function agir() { return A.quem && ["dono", "financeiro"].includes(A.quem.papel); }
  function pintar() {
    if (!S.raiz || !document.body.contains(S.raiz)) return;
    var h = '<h1>Pagamentos Plantare</h1><p class="descricao">Recuperar ordens em revisão e conferir pagamentos tardios.</p>';
    if (S.erro) h += '<p class="aviso" role="alert">' + esc(S.erro) + '</p>';
    h += '<div class="botoes"><button type="button" class="btn p" data-pr="atualizar"' + (S.ocupado ? ' disabled' : '') + '>Atualizar lista</button></div>';
    h += '<div class="card form nf-dentro"><h2>Em revisão</h2>';
    if (!S.itens.length) h += '<p class="vazio">Nenhuma revisão nesta página.</p>';
    S.itens.forEach(function (d) {
      h += '<p><button type="button" class="link" data-pr-id="' + esc(d.compra.id) + '">' + esc(d.email || d.compra.sub) + '</button> · ' + esc(d.compra.id) + ' · ' + esc(d.compra.estado) + '</p>';
    });
    if (S.cursor) h += '<button type="button" class="btn p" data-pr="mais"' + (S.ocupado ? ' disabled' : '') + '>Próxima página</button>';
    h += '</div><form data-pr-busca class="card form nf-dentro"><label class="campo">Consultar compra pelo ID<input name="compra" required pattern="cmp-[a-f0-9-]+" placeholder="cmp-…"></label><button class="btn p"' + (S.ocupado ? ' disabled' : '') + '>Consultar histórico</button></form>';
    var d = S.detalhe;
    if (d) {
      h += '<div class="card form nf-dentro"><h2>Conferência da compra</h2><p>' + esc(d.compra.id) + '</p><p>' + esc(d.email || d.compra.sub) + ' · ' + esc(d.compra.estado) + ' · ' + esc(d.fase) + '</p>';
      h += '<p>Referência no provedor: <code>' + esc(d.referencia) + '</code></p><p>' + esc(d.orientacao) + '</p>';
      if (d.gateway) h += '<p>Última consulta: ' + esc(d.gateway.estado) + ' · ' + esc(d.gateway.detalhe) + '</p>';
      if (d.fase === "revisao" && agir()) h += '<form class="form" data-pr-conferir><label class="campo">ID da ordem no provedor<input name="order_id" value="' + esc(d.order_id) + '" required maxlength="100" pattern="[A-Za-z0-9_-]+"></label><label class="campo">Justificativa da conferência<textarea name="justificativa" required minlength="10" maxlength="1000"></textarea></label><button class="btn p primario"' + (S.ocupado ? ' disabled' : '') + '>Consultar gateway e registrar</button></form>';
      if (d.fase === "revisao" && !agir()) h += '<p class="descricao">Dono e financeiro podem registrar a conferência.</p>';
      h += '<h3>Histórico · até 100 conferências recentes</h3>';
      if (!d.historico.length) h += '<p class="vazio">Nenhuma conferência registrada.</p>';
      d.historico.forEach(function (x) { h += '<p>' + esc(x.quando) + ' · ' + esc(x.quem) + ' · ' + esc(x.resultado) + '<br>' + esc(x.justificativa) + '<br>Ordem ' + esc(x.order_id) + ' · ' + esc(x.gateway.estado) + ' · ' + esc(x.gateway.detalhe) + '</p>'; });
      h += '</div>';
    }
    S.raiz.innerHTML = h;
  }
  async function executar(fn, redesenhar) {
    if (S.ocupado) return;
    S.ocupado = true; S.erro = "";
    if (redesenhar) pintar();
    else S.raiz.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    try { await fn(); } catch (e) { S.erro = e.message; }
    S.ocupado = false;
    // Erros de rede preservam formulário e chave para repetir a mesma ação.
    if (S.erro && !redesenhar) {
      S.raiz.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
      var aviso = S.raiz.querySelector('[role="alert"]');
      if (!aviso) { aviso = document.createElement("p"); aviso.className = "aviso"; aviso.setAttribute("role", "alert"); S.raiz.prepend(aviso); }
      aviso.textContent = S.erro;
    } else pintar();
  }
  async function lista(cursor) {
    var d = await A.pedir("GET", B + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    S.itens = d.itens; S.cursor = d.cursor;
  }
  async function detalhe(id) { S.detalhe = await A.pedir("GET", B + "/" + encodeURIComponent(id)); S.tentativa = null; }
  async function conferir(dados) {
    var assinatura = JSON.stringify(dados);
    if (!S.tentativa || S.tentativa.assinatura !== assinatura) S.tentativa = { assinatura: assinatura, chave: crypto.randomUUID() };
    var r = await fetch(B + "/" + S.detalhe.compra.id + "/consultar", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "idempotency-key": S.tentativa.chave }, body: assinatura });
    var d = await r.json();
    if (!r.ok) { if (r.status === 401) A.sessaoCaiu({ dados: d }); throw new Error(d.erro || "falha na conferência"); }
    await detalhe(d.compra.id);
    await lista();
  }
  A.secoes.push({ id: "plantare-pagamentos", nome: "Pagamentos Plantare", grupo: "Atos", area: "atos", ordem: 3,
    desenhar: function (raiz) {
      S.raiz = raiz; pintar();
      raiz.onclick = function (e) {
        var b = e.target.closest("[data-pr], [data-pr-id]"); if (!b || S.ocupado) return;
        executar(function () { return b.dataset.prId ? detalhe(b.dataset.prId) : lista(b.dataset.pr === "mais" ? S.cursor : null); }, true);
      };
      raiz.onsubmit = function (e) {
        var f = e.target; e.preventDefault(); if (S.ocupado) return;
        var campos = new FormData(f);
        if (f.hasAttribute("data-pr-busca")) executar(function () { return detalhe(String(campos.get("compra")).trim()); }, true);
        else executar(function () { return conferir({ token: S.detalhe.token, order_id: String(campos.get("order_id")).trim(), justificativa: String(campos.get("justificativa")).trim() }); }, false);
      };
      executar(function () { return lista(); }, true);
    }
  });
})();
