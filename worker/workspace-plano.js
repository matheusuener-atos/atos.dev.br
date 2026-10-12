// O plano do Atos Workspace: gratuito (o padrao) ou Pro (pago pela Atos Cobranca, como o PAVLVS: cobranca/catalogo.js,
// precos "workspace.pro.mes" e "workspace.pro.ano"). O Pro estende o mesmo direito do Workspace (direito:workspace no
// objeto do cliente, cobranca/cliente.js, op "estender"): plano "pro", ate quando (ate), o periodo e quem pagou. A
// ativacao (aceitar os termos) continua sendo do gratuito; quem ja ativou fica no gratuito ate pagar o Pro.
//
// Os limites ficam aqui, num lugar so, e cada recurso os aplica no servidor (worker/integracoes.js, formularios.js,
// avisos.js, entradas.js, status.js e links.js). A tela recebe os do plano da pessoa em `limites` e o `plano`.
//
// Quem perde o Pro (venceu, cancelou e o periodo pago acabou): NADA e apagado. O que passa do limite do gratuito fica
// "fora do plano" ate voltar ao Pro ou reduzir:
//   - sistemas: os mais antigos, ate o limite, seguem normais; os outros continuam deixando entrar quem ja entrava
//     (quem usa o sistema nao e pego de surpresa), mas ficam so leitura (pode tirar pessoas, desligar e apagar acessos
//     e apagar o aplicativo; nao pode editar, criar acesso nem liberar ninguem); liberar alguem a mais pede ficar
//     abaixo do limite de pessoas;
//   - formularios: os mais antigos, ate o limite, seguem; os outros param de entregar (quem envia ve "nao esta
//     recebendo mensagens agora"); o limite por dia volta ao do gratuito;
//   - pagina de status: os primeiros enderecos, ate o limite, seguem sendo conferidos (no intervalo do gratuito, sem o
//     aviso por e-mail); os outros ficam guardados, sem conferencia, fora da pagina publica;
//   - paginas de links: as mais antigas, ate o limite, seguem no ar com os primeiros links, ate o limite; as outras
//     saem do ar (o endereco fica reservado) e a estatistica de cliques para de contar;
//   - os registros (avisos ao sistema e entradas): o gratuito ve os ultimos 30 e 7 dias; o que ja estava guardado
//     do Pro fica CARENCIA_DIAS dias a mais (quem volta ao Pro nesse tempo nao perde nada) e depois segue a guarda do
//     gratuito; o CSV das entradas e so do Pro.
// A tela diz o que esta fora do plano e por que.

import { json } from "./comum.js";

export const PLANOS_WS = {
  gratuito: {
    id: "gratuito", nome: "Gratuito",
    apps: 2, liberados: 100,
    formularios: 1, envios_dia: 50,
    avisos_dias: 30, avisos_mostrar: 30,
    entradas_dias: 7, entradas_csv: false,
    status_enderecos: 1, status_intervalo_min: 15, status_email: false,
    links_paginas: 1, links_por_pagina: 5, links_cliques: false,
  },
  pro: {
    id: "pro", nome: "Pro",
    apps: 10, liberados: 5000,
    formularios: 10, envios_dia: 1000,
    avisos_dias: 90, avisos_mostrar: 100,
    entradas_dias: 90, entradas_csv: true,
    status_enderecos: 10, status_intervalo_min: 1, status_email: true,
    links_paginas: 3, links_por_pagina: 50, links_cliques: true,
  },
};
/* Depois que o Pro acaba, o que ja estava guardado dos registros fica mais estes dias (depois, a guarda do gratuito). */
export const CARENCIA_DIAS = 30;
/* Onde a tela manda quem bate num limite. */
export const CONHECER_PRO = "/workspace/plano";

/* O plano de um direito (cobranca/cliente.js, direito:workspace): {id, pro, ate, periodo, pago_por, venceu, limites}. */
export function planoDe(d, agora = Date.now()) {
  const ate = d && d.plano === "pro" && d.ate ? String(d.ate) : null;
  const pro = Boolean(ate && Date.parse(ate) > agora);
  return {
    id: pro ? "pro" : "gratuito", pro, ate,
    periodo: (d && d.periodo) || null, pago_por: (d && d.pago_por) || null,
    // O Pro que acabou (a tela mostra "o Pro venceu em ..." e o que ficou fora do plano).
    venceu: !pro && ate ? ate : null,
    limites: PLANOS_WS[pro ? "pro" : "gratuito"],
  };
}

/* O plano como a tela o ve (sem o direito inteiro). */
export function vistaDoPlano(p) {
  return { id: p.id, nome: PLANOS_WS[p.id].nome, pro: p.pro, ate: p.ate, periodo: p.periodo, pago_por: p.pago_por, venceu: p.venceu };
}

/* Os registros do Pro ainda estao na carencia? (`ate`: ate quando o Pro foi pago, ou null) */
export function guardaDoPro(ate, agora = Date.now()) {
  const t = ate ? Date.parse(ate) : NaN;
  return Number.isFinite(t) && agora < t + CARENCIA_DIAS * 86400000;
}

/* O 409 de um limite do plano: a mensagem diz o limite, e a tela oferece "Conhecer o Pro". */
export function limiteDoPlano(frase, p) {
  return json({
    erro: frase + (p && p.pro || /\bPro\b/.test(frase) ? "" : " (no Atos Workspace Pro, o limite é maior)"),
    codigo: "limite_do_plano", plano: p ? p.id : "gratuito", pro: CONHECER_PRO,
  }, 409);
}

/* Os ids que cabem no plano: os `n` primeiros de uma lista (ja na ordem de criacao). */
export function dentroDoPlano(ids, n) {
  return new Set(ids.slice(0, Math.max(0, n)));
}
