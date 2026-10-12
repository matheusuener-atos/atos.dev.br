// "Continuar como" (FedCM) na Loja da Maria. Onde o navegador tem FedCM (Chrome e Edge), os botões "Entrar com Atos"
// viram "Continuar com Atos" e, no clique, o navegador mostra a Conta Atos aberta nele ("Continuar como <nome>"), sem
// sair da loja. O código vai ao servidor (/fedcm/concluir), que o troca com o segredo. Nos outros navegadores, o botão
// continua um link para /entrar (o redirecionamento de sempre); se a pessoa fecha a janela do navegador, também.
import { entrarComAtos } from "/atos/entrar.js";

if ("IdentityCredential" in window) {
  for (const a of document.querySelectorAll('a.atos-entrar[href="/entrar"]')) {
    const texto = a.querySelector(".atos-entrar__texto");
    if (texto) texto.textContent = "Continuar com Atos";
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const ida = await (await fetch("/fedcm/comecar", { method: "POST" })).json();
        const atos = entrarComAtos({ clientId: ida.clientId, voltaPara: ida.voltaPara, emissor: ida.emissor });
        const r = await atos.continuarComFedCM({ params: ida.params, semFedCM: "/entrar" });
        if (!r) return; // sem FedCM ou a janela fechada: já foi para /entrar
        const fim = await (await fetch("/fedcm/concluir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo: r.codigo }) })).json();
        location.assign(fim.ir || "/");
      } catch (erro) {
        // access_denied (a conta não está liberada): a mesma página da volta; o resto, o caminho de sempre.
        location.assign(erro && erro.codigo === "access_denied" ? "/sem-acesso" : "/entrar");
      }
    });
  }
}
