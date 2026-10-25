(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const id = new URLSearchParams(location.search).get("compra");
  const api = "/api/plantare-checkout/" + encodeURIComponent(id || "");
  const camadas = { linhas_ab: "Linhas AB", bordadura: "Bordadura", percurso: "Percurso", manobras: "Manobras" };
  const estados = { aguardando: "Aguardando pagamento", paga: "Pagamento confirmado", concedida: "Cortesia confirmada",
    cancelada: "Pagamento cancelado", expirada: "Pagamento expirado", devolvida: "Pagamento devolvido" };
  let ocupado = false, timer, copia = "";

  function desenhar(d) {
    const c = d.compra;
    $("resumo").hidden = false;
    $("area").textContent = (c.area_cent_ha / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }) + " ha";
    $("camadas").textContent = c.camadas.map((x) => camadas[x] || x).join(", ");
    $("valor").textContent = (c.centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    $("situacao").textContent = d.revisao ? "Aguardando conferência da Atos" : estados[c.estado] || c.estado;
    $("mensagem").textContent = d.revisao ? "A Atos precisa conferir esta tentativa. Não faça outro pagamento."
      : c.baixar_ate && Date.parse(c.baixar_ate) <= Date.now() ? "O prazo de download desta compra terminou."
      : c.direito_ativo ? "Confirmação registrada na Atos. Volte ao Plantare para consultar seu planejamento."
      : d.processando ? "Estamos recuperando sua tentativa de pagamento. Aguarde nesta página."
      : c.estado === "aguardando" ? "Confira os dados antes de continuar." : estados[c.estado] || "Situação atualizada.";
    const vencido = Date.parse(d.orcamento_valido_ate) <= Date.now();
    $("prazo").textContent = c.baixar_ate ? "Prazo do direito: " + new Date(c.baixar_ate).toLocaleDateString("pt-BR")
      : !d.pix && !d.processando && vencido ? "O orçamento venceu. Volte ao Plantare e solicite outro orçamento." : "";
    $("pagar").textContent = c.centavos === 0 ? "Confirmar cortesia" : "Gerar Pix";
    $("pagar").hidden = c.estado !== "aguardando" || d.revisao || !!d.pix || d.processando || vencido;
    $("pix").hidden = !d.pix;
    copia = d.pix?.qr_code || "";
    $("codigo").value = copia;
    const imagem = d.pix?.qr_code_base64 || "";
    $("qr").hidden = !imagem;
    if (imagem) $("qr").src = "data:image/png;base64," + imagem;
    else $("qr").removeAttribute("src");
    if (c.estado === "aguardando" && !d.revisao && (d.processando || d.pix)) timer = setTimeout(atualizar, 15000);
  }

  async function executar(pagar) {
    if (ocupado) return;
    ocupado = true; clearTimeout(timer);
    $("pagar").disabled = $("atualizar").disabled = true;
    $("erro").textContent = "";
    try {
      const r = await fetch(api + (pagar ? "/pagar" : ""), { credentials: "same-origin", cache: "no-store",
        ...(pagar ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      if (r.status === 401) { location.assign("/entrar/?volta=" + encodeURIComponent(location.pathname + location.search)); return; }
      const d = await r.json();
      if (!r.ok) {
        $("dados-fiscais").hidden = d.codigo !== "sem_perfil";
        throw new Error(d.erro || "Não foi possível consultar esta compra.");
      }
      $("dados-fiscais").hidden = true;
      desenhar(d);
    } catch (e) {
      $("erro").textContent = e instanceof TypeError ? "A conexão falhou. Atualize para recuperar a mesma tentativa." : e.message;
    } finally { ocupado = false; $("pagar").disabled = $("atualizar").disabled = false; }
  }
  const atualizar = () => executar(false);
  $("pagar").addEventListener("click", () => executar(true));
  $("atualizar").addEventListener("click", atualizar);
  $("copiar").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(copia); $("erro").textContent = "Código copiado."; }
    catch { $("codigo").focus(); $("codigo").select(); $("erro").textContent = "Selecione e copie o código acima."; }
  });
  atualizar();
})();
