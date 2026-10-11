// Os dados de exemplo do Worker de TESTE (atos-teste.<conta>.workers.dev/admin/, wrangler --env teste): o painel de
// notas fiscais com um prestador, um certificado, clientes, pagamentos e notas em todos os estados, para testar a
// tela sem ninguem pagar nada. So existe com AMBIENTE "teste" (em producao a rota da 404, nfse/api.js) e so com a
// Sefin simulada (emissor.js, simulada(): AMBIENTE "teste" e nenhum SEFIN_MTLS) - nada vai ao Sistema Nacional.
//
//   POST /api/admin/nfse/teste/semear   {tudo?}  uma etapa por pedido (o painel repete ate "pronto"); tudo: true
//                                                faz todas de uma vez (testes e o wrangler dev)
//   POST /api/admin/nfse/teste/limpar            apaga o que o emissor de teste tem e as chaves de exemplo do KV
//
// As etapas, cada uma idempotente (de novo nao duplica nada; a marca atos-teste:nfse:semente diz quais ja foram):
//   base       o prestador de exemplo (CNPJ do certificado, Belem/PA, software 01.03.01), o certificado A1 de teste
//              (semente-certificado.js, cifrado com a NFSE_CHAVE_MESTRA como o do painel), o teste da comunicacao
//              (o convenio da Sefin simulada) e os interruptores (emitir sozinho desligado, entregar e e-mail ligados)
//   clientes   6 clientes ficticios com os dados fiscais (PF e PJ; um sem bairro e sem o codigo IBGE), e-mails
//              @exemplo.test, e 9 pagamentos aprovados na fila
//   notas      4 notas emitidas pelos pagamentos 1 a 4
//   eventos    a do pagamento 3 cancelada, a do 4 substituida, uma avulsa rejeitada (E0595) e a do pagamento 5 na
//              fila (a Sefin simulada "segura" a DPS: o Tentar de novo de uma pessoa solta); 6 a 9 ficam sem nota
//
// O PDF de cada nota emitida sai fora daqui (o pedido ja faz muita coisa): a resposta traz `pdf` (os ids) e o
// painel pede POST notas/:id/depois de cada uma; o Cron de cada minuto faz as que sobrarem.
//
// E-mail: no Worker de teste nenhum sai (atos.js, mandarEmail so anota); e os e-mails daqui sao @exemplo.test, que
// o email.js recusa em qualquer ambiente.

import { cliente as clienteDaCobranca, idDoCliente } from "../cobranca/cliente.js";
import { chamar, clienteDaAtos, gravarConfig, indexarCliente, K, kvJSON, porNaFila } from "./atos.js";
import { CERT_TESTE } from "./semente-certificado.js";

export const PRESTADOR_TESTE = {
  documento: CERT_TESTE.documento, razao_social: "ATOS TESTE LTDA (exemplo)", inscricao_municipal: "7788990",
  municipio: "1501402", opcao_simples: "1", regime_especial: "0",
  servico: { ctribnac: "010301", nbs: "115062100", descricao: "Licença de uso de software (exemplo do Worker de teste)", aliquota_iss_bp: 200 },
  retencoes: Object.fromEntries(["iss", "irrf", "pis", "cofins", "csll", "cp"].map((k) => [k, { quando: "nunca" }])),
  ibscbs: { enviar: true, cst: "000", cclasstrib: "000001", cindop: "100301", indfinal: "1" },
  total_tributos: { modo: "percentual", federal_bp: 1345, municipal_bp: 200 },
};

// Documentos ficticios com digito verificador valido (os de exemplo de sempre); nomes e enderecos inventados.
const end = (cep, logradouro, numero, bairro, cidade, uf, ibge) => ({ cep, logradouro, numero, complemento: "", bairro, cidade, uf, ibge });
export const CLIENTES_TESTE = [
  { tipo: "pf", documento: "52998224725", nome: "Ana Paula Ribeiro", email: "ana.ribeiro@exemplo.test",
    endereco: end("66010000", "Rua dos Mundurucus", "1500", "Batista Campos", "Belém", "PA", "1501402") },
  { tipo: "pj", documento: "11444777000161", nome: "Martins & Souza Advogados Associados", email: "financeiro@martins-souza.exemplo.test",
    endereco: end("01310100", "Avenida Paulista", "1000", "Bela Vista", "São Paulo", "SP", "3550308") },
  { tipo: "pf", documento: "11144477735", nome: "Carlos Eduardo Lima", email: "carlos.lima@exemplo.test",
    endereco: end("20040002", "Rua da Assembleia", "10", "Centro", "Rio de Janeiro", "RJ", "3304557") },
  { tipo: "pj", documento: "12345678000195", nome: "Oliveira Contabilidade Ltda", email: "contato@oliveira-contabil.exemplo.test",
    endereco: end("30130010", "Avenida Afonso Pena", "500", "Centro", "Belo Horizonte", "MG", "3106200") },
  { tipo: "pf", documento: "12345678909", nome: "Fernanda Costa", email: "fernanda.costa@exemplo.test",
    endereco: end("67030000", "Rodovia BR-316", "km 8", "Centro", "Ananindeua", "PA", "1500800") },
  // O que tem dado faltando: sem o bairro e sem o codigo IBGE (a aba Clientes mostra; o pagamento dele nao emite).
  { tipo: "pj", documento: "98765432000198", nome: "Pereira Consultoria Jurídica", email: "notas@pereira-consultoria.exemplo.test",
    endereco: end("80010000", "Rua XV de Novembro", "200", "", "Curitiba", "PR", "") },
];

// Os pagamentos: [cliente (indice), valor, descricao, horas atras].
const PAGAMENTOS_TESTE = [
  [0, 99.9, "PAVLVS Solo · mensalidade", 30],
  [1, 300, "PAVLVS Escritório · mensalidade", 28],
  [2, 99.9, "PAVLVS Solo · mensalidade", 26],
  [3, 300, "PAVLVS Escritório · mensalidade", 24],
  [4, 50, "PAVLVS · recarga de créditos", 20],
  [0, 50, "PAVLVS · recarga de créditos", 6],
  [1, 3000, "PAVLVS Escritório · anuidade", 5],
  [5, 99.9, "PAVLVS Solo · mensalidade", 4],
  [2, 50, "PAVLVS · recarga de créditos", 2],
];
export const REF_TESTE = (i) => "semente-pag-" + (i + 1);
const DESC_REJEITADA = "Implantação do PAVLVS (exemplo de nota rejeitada pela Sefin simulada)";
const QUEM = (autor) => "dados de exemplo (" + String(autor || "painel").slice(0, 80) + ")";

export const ETAPAS = ["base", "clientes", "notas", "eventos"];
const ROTULOS = { base: "prestador, certificado e comunicação", clientes: "clientes e pagamentos", notas: "notas emitidas", eventos: "cancelada, substituída, rejeitada e na fila" };

const chaveMarca = (env) => K(env).prefixo + "semente";

export async function idsDosClientes() {
  return Promise.all(CLIENTES_TESTE.map((_, i) => idDoCliente("atos-teste:semente:" + i)));
}

class FalhaSemente extends Error {
  constructor(mensagem, status = 409) {
    super(mensagem);
    this.status = status;
  }
}

async function pedir(env, acao, dados) {
  const r = await chamar(env, acao, dados);
  if (r.status !== 200) throw new FalhaSemente(`${acao}: ${(r.dados && r.dados.erro) || "HTTP " + r.status}`, r.status >= 500 ? 500 : 409);
  return r.dados;
}

// ------------------------------------------------------------ as etapas

async function base(env, autor) {
  const feito = [];
  const s = await pedir(env, "situacao", {});
  if (s.sefin !== "simulada") throw new FalhaSemente("os dados de exemplo só entram com a Sefin simulada (o Worker de teste sem o SEFIN_MTLS)", 409);
  const c = await pedir(env, "configurar", { prestador: PRESTADOR_TESTE, quem: QUEM(autor), motivo: "dados de exemplo do Worker de teste" });
  feito.push(c.mudou ? "prestador de exemplo gravado (versão " + c.versao + ")" : "prestador de exemplo já estava");
  const cert = s.certificado || {};
  if (!cert.instalado || cert.documento !== CERT_TESTE.documento || cert.vencido) {
    await pedir(env, "certificado", { certificado: CERT_TESTE.certPem, chave: CERT_TESTE.chavePem, titular: CERT_TESTE.titular,
      documento: CERT_TESTE.documento, algoritmo: "sha1", quem: QUEM(autor) });
    feito.push("certificado A1 de teste instalado (cifrado com a NFSE_CHAVE_MESTRA)");
  } else feito.push("certificado de teste já estava");
  const t = await pedir(env, "testar", {});
  feito.push("comunicação com a Sefin simulada: " + ((t.municipio && t.municipio.situacao) || "?"));
  await gravarConfig(env, { auto: false, email: true, mail: true });
  feito.push("interruptores: emitir ao pagar desligado; guardar com o cliente e e-mail ligados (no teste o e-mail só é anotado)");
  return { feito };
}

async function clientes(env) {
  const ids = await idsDosClientes();
  for (let i = 0; i < CLIENTES_TESTE.length; i++) {
    const perfil = { ...CLIENTES_TESTE[i] };
    const r = await clienteDaCobranca(env, ids[i]).pedir("perfil_salvar", { perfil });
    if (!r || !r.ok) throw new FalhaSemente("não consegui gravar o cliente " + perfil.nome, 500);
    await indexarCliente(env, ids[i], r.perfil);
  }
  const agora = Date.now();
  let novos = 0;
  for (let i = 0; i < PAGAMENTOS_TESTE.length; i++) {
    const [c, valor, descricao, horas] = PAGAMENTOS_TESTE[i];
    const q = await porNaFila(env, { id: REF_TESTE(i), cliente: ids[c], produto: "pavlvs", descricao, valor,
      quando: new Date(agora - horas * 3600000).toISOString() });
    if (!q.ok) throw new FalhaSemente("o pagamento " + REF_TESTE(i) + " não entrou na fila: " + q.motivo, 500);
    if (!q.repetido) novos++;
  }
  return { feito: [CLIENTES_TESTE.length + " clientes de exemplo (um com dados faltando)", novos + " pagamento(s) novo(s) na fila (" + PAGAMENTOS_TESTE.length + " ao todo)"] };
}

async function notasPorPagamento(env) {
  const l = await pedir(env, "listar", { limite: 300 });
  const por = new Map();
  for (const n of l.notas || []) if (n.pagamento && n.estado !== "descartada" && !n.substitui_id) por.set(n.pagamento, n);
  return { notas: l.notas || [], por };
}

async function emitirDoPagamento(env, i, autor) {
  const ids = await idsDosClientes();
  const cli = await clienteDaAtos(env, ids[PAGAMENTOS_TESTE[i][0]]);
  return pedir(env, "emitir", { conta: cli.id, pagamento: REF_TESTE(i), tomador: cli.tomador, quem: QUEM(autor) });
}

async function notas(env, autor) {
  const { por } = await notasPorPagamento(env);
  const feito = [];
  await pedir(env, "simular", { modos: ["sucesso"], segurar: false });
  for (let i = 0; i < 4; i++) {
    if (por.has(REF_TESTE(i))) continue;
    const n = await emitirDoPagamento(env, i, autor);
    feito.push("nota " + (n.numero || n.id) + " de " + REF_TESTE(i) + ": " + n.estado);
  }
  if (!feito.length) feito.push("as quatro notas emitidas já estavam");
  return { feito };
}

async function eventos(env, autor) {
  const { notas: todas, por } = await notasPorPagamento(env);
  const feito = [];
  const quem = QUEM(autor);
  const n3 = por.get(REF_TESTE(2));
  if (n3 && n3.estado === "emitida") {
    await pedir(env, "cancelar", { id: n3.id, motivo: "1", texto: "Nota de exemplo cancelada pelos dados de exemplo do Worker de teste", quem });
    feito.push("nota " + n3.numero + " cancelada");
  }
  const n4 = por.get(REF_TESTE(3));
  if (n4 && n4.estado === "emitida" && !todas.some((x) => x.substitui_id === n4.id && x.estado !== "descartada")) {
    const r = await pedir(env, "substituir", { id: n4.id, motivo: "99", texto: "Descrição do serviço corrigida (exemplo do Worker de teste)",
      ajustes: { descricao: "PAVLVS Escritório · mensalidade (descrição corrigida)" }, quem });
    feito.push("nota " + n4.numero + " substituída pela " + (r.nota.numero || r.nota.id) + " (" + r.nota.estado + ")");
  }
  if (!todas.some((x) => x.descricao === DESC_REJEITADA)) {
    const ids = await idsDosClientes();
    const cli = await clienteDaAtos(env, ids[1]);
    await pedir(env, "simular", { modos: ["rejeicao", "sucesso"] });
    try {
      const n = await pedir(env, "emitir", { conta: cli.id, tomador: cli.tomador, valor: 150, descricao: DESC_REJEITADA, quem });
      feito.push("nota avulsa " + n.estado + (n.rejeicao && n.rejeicao[0] ? " (" + n.rejeicao[0].codigo + ")" : ""));
    } finally {
      await pedir(env, "simular", { modos: ["sucesso"] });
    }
  }
  if (!por.has(REF_TESTE(4))) {
    await pedir(env, "simular", { segurar: true });
    try {
      const n = await emitirDoPagamento(env, 4, autor);
      feito.push("nota de " + REF_TESTE(4) + ": " + n.estado + " (a Sefin simulada segura até alguém pedir Tentar de novo)");
    } finally {
      await pedir(env, "simular", { segurar: false });
    }
  }
  if (!feito.length) feito.push("os eventos de exemplo já estavam");
  return { feito };
}

const FAZER = { base, clientes, notas, eventos };

/** O que o Worker de teste tem agora (para a resposta). */
export async function resumoDaSemente(env) {
  const { notas: todas } = await notasPorPagamento(env);
  const estados = {};
  for (const n of todas) estados[n.estado] = (estados[n.estado] || 0) + 1;
  return { clientes: CLIENTES_TESTE.length, pagamentos: PAGAMENTOS_TESTE.length, notas: todas.length, estados };
}

/**
 * Uma etapa (a proxima que falta), ou todas com tudo: true. Devolve {status, corpo}:
 * corpo {etapa, rotulo, feito: [frases], proxima, pronto, pdf: [ids das notas que esperam o PDF], resumo?}.
 */
export async function semear(env, autor, { tudo = false } = {}) {
  try {
    const marca = (await kvJSON(env, chaveMarca(env), null)) || { feitas: [] };
    const feitas = Array.isArray(marca.feitas) ? marca.feitas : [];
    let proxima = ETAPAS.find((e) => !feitas.includes(e));
    if (!proxima) return { status: 200, corpo: { ja: true, pronto: true, feito: ["os dados de exemplo já estão carregados"], pdf: [], resumo: await resumoDaSemente(env) } };
    const feito = [];
    let etapa;
    do {
      etapa = proxima;
      const r = await FAZER[etapa](env, autor);
      feito.push(...r.feito);
      feitas.push(etapa);
      await env.CONTAS.put(chaveMarca(env), JSON.stringify({ feitas, quando: new Date().toISOString(), por: String(autor || "").slice(0, 120) }));
      proxima = ETAPAS.find((e) => !feitas.includes(e));
    } while (tudo && proxima);
    // No fim, as notas emitidas que ainda nao tem o PDF (o painel pede uma a uma: POST notas/:id/depois).
    const pdf = proxima ? [] : (await notasPorPagamento(env)).notas.filter((n) => n.estado === "emitida" && !n.tem_pdf).map((n) => n.id);
    return { status: 200, corpo: { etapa, rotulo: ROTULOS[etapa], feito, proxima: proxima || null, proxima_rotulo: proxima ? ROTULOS[proxima] : "",
      pronto: !proxima, pdf, resumo: proxima ? null : await resumoDaSemente(env) } };
  } catch (e) {
    return { status: e instanceof FalhaSemente ? e.status : 500, corpo: { erro: String((e && e.message) || e).slice(0, 300) } };
  }
}

async function chavesCom(env, prefixo) {
  const saida = [];
  let cursor;
  do {
    const l = await env.CONTAS.list({ prefix: prefixo, cursor });
    for (const k of l.keys) saida.push(k.name);
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return saida;
}

/**
 * Recomecar: o emissor de teste zerado (notas, prestador, certificado, numeracao, a Sefin simulada) e, no KV (so
 * atos-teste:nfse:*), os clientes e os pagamentos de exemplo, as notas guardadas para clientes, os PDFs, a lista
 * do PDF, os e-mails anotados e a marca. Os pagamentos de teste de verdade (a compra no checkout de teste) ficam
 * na fila de novo como "pendente"; o indice e o ajuste dos clientes de teste de verdade ficam. {status, corpo}
 */
export async function limparSemente(env) {
  try {
    const z = await chamar(env, "zerar_teste", {});
    if (z.status !== 200) return { status: z.status === 404 ? 409 : z.status, corpo: { erro: z.dados.erro || "o emissor de teste não zerou" } };
    const k = K(env);
    const ids = new Set(await idsDosClientes());
    const apagar = [];
    for (const nome of await chavesCom(env, k.prefixo)) {
      const resto = nome.slice(k.prefixo.length);
      const cliente = resto.split(":")[1] || "";
      if (resto.startsWith("pag:")) {
        if (resto.startsWith("pag:semente-")) apagar.push(nome);
        else {
          const x = await kvJSON(env, nome, null);
          if (x) await env.CONTAS.put(nome, JSON.stringify({ ...x, nota: "pendente", numero: "", nota_id: "", motivo: "", erro: "" }));
        }
      } else if (resto.startsWith("clientes:") || resto.startsWith("tomador:")) {
        if (ids.has(cliente)) apagar.push(nome);
      } else if (/^(nota|nota-pdf|nota-xml|pdf):/.test(resto) || ["depois", "semente", "emails"].includes(resto)) apagar.push(nome);
    }
    for (const nome of apagar) await env.CONTAS.delete(nome);
    return { status: 200, corpo: { ok: true, apagadas: apagar.length, feito: ["o emissor de teste foi zerado", apagar.length + " chave(s) de exemplo apagadas do KV"] } };
  } catch (e) {
    return { status: 500, corpo: { erro: String((e && e.message) || e).slice(0, 300) } };
  }
}
