// O catalogo da Atos Cobranca (docs/COBRANCA.md, "Catalogo"): o que cada produto vende, com o
// preco em centavos. E a unica fonte de valor e de recorrencia - o navegador manda so o id do preco,
// e o servidor resolve aqui (resolveOffer). Os `metadados` sao do produto (o PAVLVS le o plano, os
// tokens do ciclo e as pessoas); a Atos so os entrega nos eventos e nos direitos.
//
// Formas de cobrar, por periodo:
//   mes    a mensalidade: no cartao, assinatura recorrente (/preapproval); no Pix, um mes avulso (Orders API)
//   ano    o ano pago de uma vez: cartao ou Pix (Orders API)
//   avulso uma compra so (a recarga do PAVLVS): Pix (Orders API); exige assinatura ativa do produto
//
// Mudar um valor e criar uma versao nova do preco (o id muda, ex.: "...@2"): quem ja assinou continua no
// valor dele. `aberto` diz se o produto ja vende pela Atos - so depois que ele recebe os eventos.

import { chaveDosProjetos, produtosDoPortfolio } from "../portfolio.js";

export const MOEDA = "BRL";

const PAVLVS_PLANOS = [
  { plano: "advogado", nome: "Advogado", mes: 44900, ano: 399000, tokens: 30000000, pessoas: 1, recarga: { centavos: 5000, tokens: 10000000 } },
  { plano: "escritorio", nome: "Escritório", mes: 129000, ano: 1149000, tokens: 60000000, pessoas: 5, recarga: { centavos: 12000, tokens: 10000000 } },
  { plano: "plus", nome: "Escritório Plus", mes: 349000, ano: 3099000, tokens: 40000000, pessoas: 15, recarga: { centavos: 30000, tokens: 5000000 } },
];

function precosDoPavlvs() {
  const l = [];
  for (const p of PAVLVS_PLANOS) {
    const meta = { plano: p.plano, tokens_por_ciclo: p.tokens, pessoas: p.pessoas };
    l.push({ id: `pavlvs.${p.plano}.mes`, nome: `PAVLVS ${p.nome}`, periodo: "mes", centavos: p.mes, formas: ["cartao", "pix"], metadados: meta });
    l.push({ id: `pavlvs.${p.plano}.ano`, nome: `PAVLVS ${p.nome} · anual`, periodo: "ano", centavos: p.ano, formas: ["cartao", "pix"], metadados: meta });
    l.push({ id: `pavlvs.${p.plano}.recarga`, nome: `PAVLVS ${p.nome} · recarga`, periodo: "avulso", centavos: p.recarga.centavos, formas: ["pix"],
      requer_assinatura: true, metadados: { plano: p.plano, tokens: p.recarga.tokens } });
  }
  return l;
}

export const PRODUTOS = {
  pavlvs: {
    nome: "PAVLVS",
    site: "https://paulus.ia.br",
    // Para onde a pessoa volta depois de pagar (so estes; o ?volta= que nao bater vira o site).
    voltas: ["https://paulus.ia.br/", "https://paulus.ia.br/minha-conta/"],
    // Onde o produto recebe os eventos (worker/cobranca/eventos.js); o segredo e EVENTOS_SEGREDO_PAVLVS.
    eventos: "https://paulus.ia.br/api/atos/eventos",
    precos: precosDoPavlvs(),
  },
  // O Atos Workspace (worker/workspace.js): o produto de quem constroi sistemas com a Conta Atos. Ativar e gratuito: nao
  // passa pelo Mercado Pago, e e aceitar os termos dele (`termos`, a versao que a ativacao registra). O Pro (desde
  // 12/10/2026; worker/workspace-plano.js) e pago aqui, pelo mesmo checkout do PAVLVS (public/workspace/assinar/): R$ 29
  // por mes no cartao (assinatura) ou R$ 290 por ano (cartao ou Pix). Ele estende o mesmo direito (direito:workspace no
  // objeto do cliente, cliente.js): plano "pro", ate quando, o periodo e quem pagou. Sem `eventos`: o produto e da
  // propria Atos, e quem le o direito e o proprio Worker (cliente.js anota a data no WorkspaceDados, para a guarda dos
  // registros). `gratuito`: o produto tem o nivel gratuito (ativar sem pagar).
  workspace: {
    nome: "Atos Workspace",
    site: "https://atos.dev.br/workspace/",
    voltas: ["https://atos.dev.br/workspace/", "https://atos.dev.br/workspace/plano"],
    gratuito: true,
    // A versao e a data (AAAA-MM-DD) e, numa segunda revisao no mesmo dia, ".N": "2026-10-11.2" (o e-mail Atos), "2026-10-11.3" (o alias como login e exigido para cadastrar sistemas), "2026-10-11.4" (a suspensao do Workspace pela equipe), "2026-10-12" (os Formularios), "2026-10-12.2" (os avisos ao sistema), "2026-10-12.3" (o registro de entradas), "2026-10-12.4" (a pagina de status), "2026-10-12.5" (o Pro e os limites de cada plano, e a pagina de links, numa revisao so).
    termos: { versao: "2026-10-12.5", endereco: "/termos/#workspace" },
    precos: [
      { id: "workspace.pro.mes", nome: "Atos Workspace Pro", periodo: "mes", centavos: 2900, formas: ["cartao"], metadados: { plano: "pro" } },
      { id: "workspace.pro.ano", nome: "Atos Workspace Pro · anual", periodo: "ano", centavos: 29000, formas: ["cartao", "pix"], metadados: { plano: "pro" } },
    ],
  },
};

// Os produtos do Portfolio (worker/portfolio.js): os projetos que o dono cadastra no painel com a venda ligada. Ficam
// no KV, nao no codigo; carregarCatalogo(env) os le (no maximo a cada CACHE_MS) antes de quem usa as funcoes abaixo.
// Um Worker e um isolate so tem um env, entao o que foi lido vale para todo pedido dele; o painel, ao salvar, le de
// novo na hora (forcar), e os outros isolates veem a mudanca em ate CACHE_MS.
const CACHE_MS = 30000;
const LIDOS = {};
let DINAMICOS = {};

/* Le os produtos do Portfolio para as funcoes do catalogo. Sem o KV, fica com a ultima leitura boa (ou nenhuma). */
export async function carregarCatalogo(env, { forcar = false, agora = Date.now() } = {}) {
  const chave = chaveDosProjetos(env);
  const lido = LIDOS[chave];
  if (!forcar && lido && agora - lido.em < CACHE_MS) {
    DINAMICOS = lido.produtos;
    return;
  }
  try {
    const produtos = await produtosDoPortfolio(env);
    LIDOS[chave] = { em: agora, produtos };
  } catch {
    // o KV fora: a ultima leitura boa continua
  }
  DINAMICOS = (LIDOS[chave] && LIDOS[chave].produtos) || {};
}

/* O produto (do codigo ou do Portfolio), ou null. */
export function produtoDe(id) {
  if (Object.prototype.hasOwnProperty.call(PRODUTOS, id)) return PRODUTOS[id];
  return Object.prototype.hasOwnProperty.call(DINAMICOS, id) ? DINAMICOS[id] : null;
}

/* Todos os produtos: os do codigo e os do Portfolio. [[id, produto]] */
export function todosOsProdutos() {
  return [...Object.entries(PRODUTOS), ...Object.entries(DINAMICOS).filter(([id]) => !Object.prototype.hasOwnProperty.call(PRODUTOS, id))];
}

/* Um produto gratuito (ativar = aceitar os termos dele; worker/workspace.js), ou null. */
export function produtoGratuito(produto) {
  const p = PRODUTOS[produto];
  return p && p.gratuito ? p : null;
}

/* O produto vende pela Atos? Os do codigo ligam por var (PRODUTOS_ABERTOS="pavlvs,..."), quando ja recebem os eventos;
   os do Portfolio, pelo "vendendo" do painel. */
export function produtoAberto(env, produto) {
  if (String(env.PRODUTOS_ABERTOS || "").split(",").map((s) => s.trim()).includes(produto)) return true;
  const d = Object.prototype.hasOwnProperty.call(PRODUTOS, produto) ? null : produtoDe(produto);
  return Boolean(d && d.aberto);
}

/* O que o checkout mostra. Dos precos do Portfolio, so os de agora (um preco mudado vira outra versao; a antiga fica
   para quem ja assinou, fora da vitrine). */
export function catalogoPublico(produto) {
  const p = produtoDe(produto);
  if (!p) return null;
  const extra = p.dinamico ? { site: p.site, icone: p.icone || "", planos: p.planos || [] } : {};
  return { produto, nome: p.nome, moeda: MOEDA, precos: p.precos.filter((x) => x.ativo !== false), ...(p.gratuito ? { gratuito: true } : {}), ...extra };
}

/* A oferta confiavel de um preco (resolveOffer): o que o servidor cobra, nunca o que o navegador disse. `paraCobrar`:
   so um preco que ainda esta a venda (a versao antiga resolve o nome, mas nao cobra de novo). */
export function resolveOffer(precoId, { paraCobrar = false } = {}) {
  const [produto] = String(precoId || "").split(".");
  const p = produtoDe(produto);
  const preco = p && p.precos.find((x) => x.id === precoId);
  if (!preco || (paraCobrar && preco.ativo === false)) return null;
  return { produto, produtoNome: p.nome, ...preco, valor: (preco.centavos / 100).toFixed(2) };
}

export function voltaPermitida(produto, volta) {
  const p = produtoDe(produto);
  if (!p) return "";
  return p.voltas.includes(volta) ? volta : p.site;
}
