// O emissor de NFS-e na Atos: o acoplamento com a cobranca da Atos (porte do
// worker/nfse-casa.js do PAVLVS, que entregava a nota ao app do cliente dele).
//
// A Atos e a unica que cobra os produtos (docs/COBRANCA.md), entao e ela quem
// emite a nota de cada pagamento: o prestador e o certificado A1 do titular,
// guardados no Durable Object EmissorNFSe (emissor.js, idFromName("atos")).
//
//   o tomador        o perfil fiscal do cliente da Atos (cobranca/cliente.js,
//                    op "perfil_ler"), com o ajuste do painel por cima
//   a fila           um registro por pagamento aprovado (porNaFila, chamada
//                    pela cobranca quando a compra ou a mensalidade fica paga)
//   a entrega        a meta, o PDF e o XML da nota guardados para o cliente da
//                    Atos (notasDoCliente le) e o e-mail pelo Resend da Atos
//
// O KV e o env.CONTAS - o MESMO namespace do KV APOIOS do PAVLVS. Por isso TODA
// chave do emissor comeca com "atos:nfse:" (nunca "admin:nfse:*" nem
// "nfse:nota*", que sao do PAVLVS):
//   atos:nfse:config                 os interruptores do painel {auto, email, mail}
//   atos:nfse:pag:<ref>              a fila: um pagamento aprovado e a marca da nota
//   atos:nfse:clientes:<cliente>     o indice dos clientes (nome, documento, e-mail)
//   atos:nfse:tomador:<cliente>      o que o painel corrigiu do tomador (vence o perfil, so na nota)
//   atos:nfse:nota:<cliente>:<id>    a meta da nota entregue ao cliente
//   atos:nfse:nota-pdf:<cliente>:<id>  o PDF (base64)
//   atos:nfse:nota-xml:<cliente>:<id>  o XML (base64)
//   atos:nfse:pdf:<id da nota>       o DANFSe guardado para o painel (api.js)
//   atos:nfse:depois                 as notas que esperam o PDF (emissor.js, K_DEPOIS)
//   atos:nfse:cf:token|mtls|cadeia   o token da Cloudflare (cifrado), o mTLS em uso e a cadeia (mtls.js)
// No Worker de teste, as mesmas com "atos-teste:nfse:" (K, abaixo).
//
// Nada daqui lanca para a cobranca: porNaFila e emitirAutomatico devolvem o
// motivo, e a falha no e-mail nao falha a nota.

import { cliente as clienteDaCobranca } from "../cobranca/cliente.js";
import { ehAmbienteDeTeste } from "../cobranca/eventos.js";
import { enviarEmail } from "../email.js";
import { cnpjValido, cpfValido } from "./texto.js";

// As chaves, pelo ambiente: o Worker de teste (wrangler --env teste, AMBIENTE "teste") usa o MESMO KV da
// producao, entao as dele levam "atos-teste:nfse:" - a fila, as notas e o token de um nunca se misturam com os
// do outro (cada Worker tem o proprio Durable Object do emissor).
const CHAVES = new Map();
export function K(env) {
  const prefixo = ehAmbienteDeTeste(env || {}) ? "atos-teste:nfse:" : "atos:nfse:";
  if (!CHAVES.has(prefixo)) {
    CHAVES.set(prefixo, Object.freeze({
      prefixo,
      config: prefixo + "config",
      pag: prefixo + "pag:",
      clientes: prefixo + "clientes:",
      tomador: prefixo + "tomador:",
      nota: prefixo + "nota:",
      notaPdf: prefixo + "nota-pdf:",
      notaXml: prefixo + "nota-xml:",
      pdf: prefixo + "pdf:",
      depois: prefixo + "depois",
      cfToken: prefixo + "cf:token",
      cfMtls: prefixo + "cf:mtls",
      cfCadeia: prefixo + "cf:cadeia",
    }));
  }
  return CHAVES.get(prefixo);
}

// O id do cliente da Atos (cobranca/cliente.js, idDoCliente): 32 hex.
export const RE_CLIENTE = /^[0-9a-f]{32}$/;
const RE_NOTA = /^[A-Za-z0-9_.-]{1,64}$/;
const RE_REF = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_ARQUIVO = 2 * 1024 * 1024;
const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");
export const CAMPOS_TOMADOR = ["nome", "documento", "email", "telefone", "logradouro", "numero", "complemento", "bairro", "cep", "cmun", "uf", "inscricao_municipal"];
// O que a nota precisa do tomador (o resto e opcional).
const ROTULOS_TOMADOR = { nome: "nome", documento: "CPF/CNPJ", logradouro: "rua", numero: "número", bairro: "bairro", cep: "CEP", cmun: "município (código IBGE)" };

// ------------------------------------------------------------ o emissor (o DO)

export function emissorDe(env) {
  if (!env.EMISSOR_NFSE) throw new Error("falta o Durable Object EMISSOR_NFSE");
  return env.EMISSOR_NFSE.get(env.EMISSOR_NFSE.idFromName("atos"));
}

/** O que falta para o emissor funcionar ("" quando esta tudo). */
export function faltaDoEmissor(env) {
  if (!env.CONTAS) return "falta o KV CONTAS";
  if (!env.EMISSOR_NFSE) return "falta o Durable Object EMISSOR_NFSE";
  if (!env.NFSE_CHAVE_MESTRA) {
    return "falta o segredo NFSE_CHAVE_MESTRA (npx wrangler secret put NFSE_CHAVE_MESTRA" + (ehAmbienteDeTeste(env) ? " --env teste" : "") + "; gere com openssl rand -base64 32)";
  }
  return "";
}

/** Chama uma acao do DO: {status, dados}. */
export async function chamar(env, acao, dados = {}) {
  const r = await emissorDe(env).fetch("https://emissor-nfse/" + acao, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ acao, dados }),
  });
  return { status: r.status, dados: await r.json() };
}

// ------------------------------------------------------------ KV

export async function kvJSON(env, chave, padrao = null) {
  try {
    const v = env.CONTAS ? await env.CONTAS.get(chave) : null;
    return v ? JSON.parse(v) : padrao;
  } catch {
    return padrao;
  }
}

async function kvPor(env, prefixo) {
  const saida = [];
  let cursor;
  do {
    const lista = await env.CONTAS.list({ prefix: prefixo, cursor });
    for (const k of lista.keys) saida.push(k.name);
    cursor = lista.list_complete ? undefined : lista.cursor;
  } while (cursor);
  return saida;
}

/** Os interruptores do painel: auto (emitir sozinho ao pagar), email (entregar ao cliente logo depois de emitir), mail (mandar o e-mail). */
export async function configNfse(env) {
  const c = (await kvJSON(env, K(env).config, {})) || {};
  return { auto: Boolean(c.auto), email: Boolean(c.email), mail: Boolean(c.mail) };
}

export async function gravarConfig(env, d) {
  const c = { auto: Boolean(d && d.auto), email: Boolean(d && d.email), mail: Boolean(d && d.mail) };
  await env.CONTAS.put(K(env).config, JSON.stringify(c));
  return c;
}

const soDigitos = (t) => String(t || "").replace(/\D/g, "");

// ------------------------------------------------------------ clientes (o tomador)

/* O que falta no tomador para a nota: ["CEP", "bairro"...]. */
export function faltasDoTomador(t) {
  const x = t || {};
  const faltas = Object.keys(ROTULOS_TOMADOR).filter((k) => !String(x[k] || "").trim()).map((k) => ROTULOS_TOMADOR[k]);
  const doc = soDigitos(x.documento);
  if (doc && !(doc.length === 11 ? cpfValido(doc) : doc.length === 14 && cnpjValido(doc))) faltas.push("CPF/CNPJ válido");
  return faltas;
}

/* O perfil fiscal da Atos (cobranca/api.js, conferirPerfil) no formato do tomador do emissor. */
export function tomadorDoPerfil(perfil) {
  const p = perfil || {};
  const e = p.endereco || {};
  return {
    nome: p.nome || "", documento: soDigitos(p.documento), email: p.email || "", telefone: "", logradouro: e.logradouro || "",
    numero: e.numero || "", complemento: e.complemento || "", bairro: e.bairro || "", cep: soDigitos(e.cep), cmun: soDigitos(e.ibge),
    uf: e.uf || "", inscricao_municipal: "",
  };
}

async function perfilDe(env, clienteId) {
  if (!env.CLIENTES) return null;
  const r = await clienteDaCobranca(env, clienteId).pedir("perfil_ler");
  return (r && r.perfil) || null;
}

/* O indice dos clientes no KV (atos:nfse:clientes:<id>): os clientes sao um Durable Object cada, e o painel lista
   sem varrer objetos. Gravado quando o perfil e salvo (cobranca/api.js) e quando um pagamento entra na fila.
   Nunca lanca. */
export async function indexarCliente(env, clienteId, perfil) {
  try {
    if (!env.CONTAS || !RE_CLIENTE.test(String(clienteId || "")) || !perfil) return false;
    const novo = { id: clienteId, nome: String(perfil.nome || "").slice(0, 150), documento: soDigitos(perfil.documento), email: String(perfil.email || "").slice(0, 120),
      tipo: perfil.tipo || "" };
    const antes = await kvJSON(env, K(env).clientes + clienteId, null);
    if (antes && antes.nome === novo.nome && antes.documento === novo.documento && antes.email === novo.email && antes.tipo === novo.tipo) return true;
    await env.CONTAS.put(K(env).clientes + clienteId, JSON.stringify({ ...novo, atualizado: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

/* O cliente para o painel: o perfil da Atos com o ajuste do painel por cima. */
export async function clienteDaAtos(env, clienteId, indice = null) {
  const perfil = await perfilDe(env, clienteId);
  const ind = indice || (await kvJSON(env, K(env).clientes + clienteId, null)) || {};
  const base = perfil ? tomadorDoPerfil(perfil) : { ...tomadorDoPerfil(null), nome: ind.nome || "", documento: ind.documento || "", email: ind.email || "" };
  const ajuste = (await kvJSON(env, K(env).tomador + clienteId)) || {};
  const tomador = { ...base };
  for (const k of CAMPOS_TOMADOR) if (ajuste[k] !== undefined && ajuste[k] !== "") tomador[k] = ajuste[k];
  return {
    id: clienteId, nome: (perfil && perfil.nome) || ind.nome || "", email: (perfil && perfil.email) || ind.email || "", documento: base.documento,
    tem_perfil: Boolean(perfil), tomador, ajustado: Object.keys(ajuste).length > 0, faltas: faltasDoTomador(tomador),
  };
}

export async function listarClientes(env) {
  const ids = (await kvPor(env, K(env).clientes)).map((k) => k.slice(K(env).clientes.length)).filter((x) => RE_CLIENTE.test(x));
  const lista = await Promise.all(ids.map(async (id) => clienteDaAtos(env, id, await kvJSON(env, K(env).clientes + id, null))));
  return lista.sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR"));
}

/* O tomador conferido, ou {erro}. So os campos enviados entram; "" apaga o ajuste daquele campo (volta o do perfil). */
export function conferirTomador(t) {
  if (!t || typeof t !== "object") return { erro: "mande o tomador" };
  const limpo = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const saida = {};
  for (const k of CAMPOS_TOMADOR) {
    if (t[k] === undefined) continue;
    let v = limpo(t[k], k === "nome" ? 150 : k === "logradouro" ? 125 : 60);
    if (v === "") { saida[k] = ""; continue; }
    if (k === "documento") {
      v = soDigitos(v);
      if (!(v.length === 11 ? cpfValido(v) : cnpjValido(v))) return { erro: "o CPF ou CNPJ do tomador não confere" };
    } else if (k === "cep") {
      v = soDigitos(v);
      if (v.length !== 8) return { erro: "o CEP tem 8 dígitos" };
    } else if (k === "cmun") {
      v = soDigitos(v);
      if (v.length !== 7) return { erro: "o código do município (IBGE) tem 7 dígitos" };
    } else if (k === "uf") {
      v = v.toUpperCase();
      if (!UFS.includes(v)) return { erro: "a UF tem 2 letras (ex.: PA)" };
    } else if (k === "email") {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || v.length > 120) return { erro: "o e-mail do tomador não confere" };
    } else if (k === "telefone") {
      v = soDigitos(v);
      if (v.length < 10 || v.length > 13) return { erro: "o telefone precisa do DDD" };
    } else if (k === "nome") {
      if (v.length < 2) return { erro: "o nome do tomador é curto demais" };
    }
    saida[k] = v;
  }
  return { tomador: saida };
}

/* O ajuste do tomador, SO para a nota (atos:nfse:tomador:<cliente>): o perfil fiscal que o cliente digitou na Atos
   nao muda (ele e do cliente, e vale para o Mercado Pago). {status, corpo}. */
export async function gravarTomador(env, clienteId, tomador) {
  if (!RE_CLIENTE.test(String(clienteId || ""))) return { status: 400, corpo: { erro: "cliente inválido" } };
  const c = conferirTomador(tomador);
  if (c.erro) return { status: 400, corpo: { erro: c.erro } };
  const existe = (await kvJSON(env, K(env).clientes + clienteId, null)) || (await perfilDe(env, clienteId));
  if (!existe) return { status: 404, corpo: { erro: "esse cliente não existe na Atos (ou ainda não preencheu os dados fiscais)" } };
  const antes = (await kvJSON(env, K(env).tomador + clienteId)) || {};
  const novo = { ...antes, ...c.tomador };
  for (const k of Object.keys(novo)) if (novo[k] === "") delete novo[k];
  if (Object.keys(novo).length) await env.CONTAS.put(K(env).tomador + clienteId, JSON.stringify(novo));
  else await env.CONTAS.delete(K(env).tomador + clienteId);
  return { status: 200, corpo: await clienteDaAtos(env, clienteId) };
}

// ------------------------------------------------------------ a fila de pagamentos

/**
 * Um pagamento aprovado na Atos entra na fila da nota, uma vez por ref (o aviso repetido nao duplica):
 * {id: a ref do pagamento, cliente, produto, descricao, valor (reais), quando}. Com o "auto" ligado, emite logo
 * (emitirAutomatico). Nunca lanca: devolve {ok, repetido?, automatico?, motivo?}.
 */
export async function porNaFila(env, pagamento) {
  try {
    if (!env.CONTAS) return { ok: false, motivo: "sem o KV" };
    const p = pagamento || {};
    const id = String(p.id || "");
    const cli = String(p.cliente || "");
    const valor = Math.round(Number(p.valor) * 100) / 100;
    if (!RE_REF.test(id) || !RE_CLIENTE.test(cli) || !Number.isFinite(valor) || valor <= 0) return { ok: false, motivo: "pagamento inválido" };
    const chave = K(env).pag + id;
    if (await env.CONTAS.get(chave)) return { ok: true, repetido: true };
    const registro = {
      id, cliente: cli, produto: String(p.produto || "").slice(0, 32), preco: String(p.preco || "").slice(0, 80),
      descricao: String(p.descricao || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 300), valor,
      quando: String(p.quando || new Date().toISOString()).slice(0, 40), nota: "pendente",
    };
    await env.CONTAS.put(chave, JSON.stringify(registro));
    if (!(await configNfse(env)).auto) return { ok: true, automatico: false };
    const a = await emitirAutomatico(env, id);
    return { ok: true, automatico: a.feito, motivo: a.motivo || "" };
  } catch (e) {
    return { ok: false, motivo: String((e && e.message) || e).slice(0, 200) };
  }
}

export async function marcarPagamento(env, pagamento, campos) {
  const chave = K(env).pag + pagamento;
  const x = await kvJSON(env, chave);
  if (!x) return;
  await env.CONTAS.put(chave, JSON.stringify({ ...x, ...campos }));
}

export async function lerPagamento(env, pagamento) {
  return kvJSON(env, K(env).pag + pagamento, null);
}

export async function listarPagamentos(env) {
  const lista = [];
  const nomes = new Map();
  for (const k of await kvPor(env, K(env).pag)) {
    const x = await kvJSON(env, k);
    if (!x) continue;
    if (!nomes.has(x.cliente)) nomes.set(x.cliente, ((await kvJSON(env, K(env).clientes + x.cliente, null)) || {}).nome || "");
    lista.push({ id: x.id, cliente: x.cliente || "", nome: nomes.get(x.cliente), produto: x.produto || "", descricao: x.descricao || "", valor: x.valor,
      quando: x.quando, nota: x.nota || "pendente", numero: x.numero || "", nota_id: x.nota_id || "", motivo: x.motivo || "", erro: x.erro || "" });
  }
  lista.sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
  return { pagamentos: lista, config: await configNfse(env) };
}

/**
 * O pagamento na fila com o "auto" ligado: emite no DO se o tomador do cliente estiver completo; senao o motivo
 * fica no pagamento (o painel mostra) e a nota fica pendente. Nunca lanca. Devolve {feito, motivo?, nota?}.
 */
export async function emitirAutomatico(env, pagamentoId) {
  try {
    if (faltaDoEmissor(env)) return { feito: false, motivo: "emissor desligado: " + faltaDoEmissor(env) };
    if (!(await configNfse(env)).auto) return { feito: false, motivo: "emissão automática desligada" };
    const pag = await lerPagamento(env, pagamentoId);
    if (!pag) return { feito: false, motivo: "pagamento não encontrado" };
    const perfil = await perfilDe(env, pag.cliente);
    if (perfil) await indexarCliente(env, pag.cliente, perfil);
    const cli = await clienteDaAtos(env, pag.cliente);
    if (!cli.tem_perfil && !cli.ajustado) {
      await marcarPagamento(env, pagamentoId, { motivo: "emissão automática parada: o cliente não tem os dados fiscais na Atos" });
      return { feito: false, motivo: "cliente sem dados fiscais" };
    }
    if (cli.faltas.length) {
      const motivo = "emissão automática parada: falta " + cli.faltas.join(", ") + " do cliente (Notas fiscais › Clientes)";
      await marcarPagamento(env, pagamentoId, { motivo });
      return { feito: false, motivo };
    }
    const r = await chamar(env, "emitir", { conta: pag.cliente, pagamento: pagamentoId, tomador: cli.tomador, quem: "automático" });
    if (r.status !== 200) {
      const motivo = "a emissão automática falhou: " + (r.dados.erro || "HTTP " + r.status);
      await marcarPagamento(env, pagamentoId, { motivo });
      return { feito: false, motivo };
    }
    if (r.dados.estado !== "emitida") {
      await marcarPagamento(env, pagamentoId, { motivo: "nota " + String(r.dados.estado_rotulo || r.dados.estado).toLowerCase() + (r.dados.erro ? ": " + r.dados.erro : "") });
    }
    return { feito: true, nota: r.dados };
  } catch (e) {
    try {
      await marcarPagamento(env, pagamentoId, { motivo: "a emissão automática falhou: " + String((e && e.message) || e).slice(0, 200) });
    } catch {
      // nada
    }
    return { feito: false, motivo: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------ a nota do cliente

function bytesDoBase64(b64) {
  const s = String(b64 || "").replace(/\s+/g, "");
  if (!s) return { tamanho: 0, b64: "" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return { erro: true };
  const tamanho = Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  return { tamanho, b64: s };
}

/* A nota emitida guardada para o cliente da Atos (atos:nfse:nota*), com a meta, o PDF e o XML (base64). O emissor
   (emissor.js, mandarAoCliente) grava por aqui. Devolve {status, corpo}. */
export async function guardarNotaDoCliente(env, d) {
  const json = (corpo, status = 200) => ({ corpo, status });
  const id = String(d.id || "");
  const conta = String(d.conta || "");
  if (!RE_NOTA.test(id)) return json({ erro: "o id da nota vai com letras, números, ponto, _ ou - (até 64)" }, 400);
  if (!RE_CLIENTE.test(conta)) return json({ erro: "cliente inválido" }, 400);
  if (!(await env.CONTAS.get(K(env).clientes + conta))) return json({ erro: "esse cliente não existe na Atos" }, 404);
  const competencia = String(d.competencia || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia)) return json({ erro: "a competência vai como AAAA-MM" }, 400);
  const valor = Number(d.valor);
  if (!Number.isFinite(valor) || valor < 0) return json({ erro: "o valor é um número em reais" }, 400);
  const ambiente = d.ambiente === "producao_restrita" ? "producao_restrita" : d.ambiente === "producao" ? "producao" : "";
  if (!ambiente) return json({ erro: "o ambiente é producao ou producao_restrita" }, 400);
  const pdf = bytesDoBase64(d.pdf_b64);
  const xml = bytesDoBase64(d.xml_b64);
  if (pdf.erro || xml.erro) return json({ erro: "o PDF e o XML vão em base64" }, 400);
  if (pdf.tamanho > MAX_ARQUIVO || xml.tamanho > MAX_ARQUIVO) return json({ erro: "cada arquivo pode ter até 2 MB" }, 413);
  const pagamento = d.pagamento ? String(d.pagamento).slice(0, 80) : "";
  const limpo = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").trim().slice(0, max);
  const base = conta + ":" + id;
  // Sem pdf_b64 no pedido, o PDF que ja estava fica (o emissor manda a nota antes de o PDF existir e o PDF depois).
  const manterPdf = d.pdf_b64 === undefined;
  const meta = {
    id, conta, pagamento, numero: limpo(d.numero, 30), chave: limpo(d.chave, 60), competencia, valor: Math.round(valor * 100) / 100,
    descricao: limpo(d.descricao, 2000), ambiente, emitida_em: limpo(d.emitida_em, 40) || new Date().toISOString(),
    tem_pdf: manterPdf ? Boolean(await env.CONTAS.get(K(env).notaPdf + base)) : Boolean(pdf.b64), tem_xml: Boolean(xml.b64), cancelada: false,
    recebida: new Date().toISOString(),
  };
  if (!manterPdf && pdf.b64) await env.CONTAS.put(K(env).notaPdf + base, pdf.b64);
  else if (!manterPdf) await env.CONTAS.delete(K(env).notaPdf + base);
  if (xml.b64) await env.CONTAS.put(K(env).notaXml + base, xml.b64);
  else await env.CONTAS.delete(K(env).notaXml + base);
  await env.CONTAS.put(K(env).nota + base, JSON.stringify(meta));
  if (pagamento) await marcarPagamento(env, pagamento, { nota: "emitida", numero: meta.numero, nota_id: id, erro: "" });
  if (d.email !== true) return json({ ok: true });
  const email = await mandarNotaPorEmail(env, meta, pdf.b64, xml.b64);
  return json({ ok: true, email });
}

/* As notas de um cliente da Atos (a meta, sem os arquivos), da mais nova para a mais velha. Para a Minha conta. */
export async function notasDoCliente(env, clienteId) {
  if (!RE_CLIENTE.test(String(clienteId || ""))) return [];
  const notas = [];
  for (const k of await kvPor(env, K(env).nota + clienteId + ":")) {
    const m = await kvJSON(env, k, null);
    if (m) notas.push(m);
  }
  return notas.sort((a, b) => String(b.emitida_em).localeCompare(String(a.emitida_em)));
}

/* O PDF ou o XML (base64) de uma nota do cliente, ou "". */
export async function arquivoDaNota(env, clienteId, id, tipo = "pdf") {
  if (!RE_CLIENTE.test(String(clienteId || "")) || !RE_NOTA.test(String(id || ""))) return "";
  return (await env.CONTAS.get((tipo === "xml" ? K(env).notaXml : K(env).notaPdf) + clienteId + ":" + id)) || "";
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function mesAno(competencia) {
  const [a, m] = String(competencia || "").split("-");
  return MESES[Number(m) - 1] ? MESES[Number(m) - 1] + "/" + a : String(competencia || "");
}
function brl(v) {
  return "R$ " + Number(v || 0).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/* O e-mail "Sua NFS-e de ..." com o PDF e o XML (base64) anexos. Nunca lanca (veja mandarEmail). */
export async function mandarNotaPorEmail(env, meta, pdfB64, xmlB64) {
  const anexos = [];
  const arquivo = "NFS-e " + String(meta.numero || meta.id).replace(/[^A-Za-z0-9_.-]/g, "");
  if (pdfB64) anexos.push({ nome: arquivo + ".pdf", b64: pdfB64 });
  if (xmlB64) anexos.push({ nome: arquivo + ".xml", b64: xmlB64 });
  const linhas = [
    "Segue a nota fiscal de serviço (NFS-e) do seu pagamento na Atos" + (meta.descricao ? " (" + String(meta.descricao).slice(0, 200) + ")" : "") + ", com o PDF e o XML anexos.",
    "Número: " + (meta.numero || "—") + "\nValor: " + brl(meta.valor) + "\nCompetência: " + mesAno(meta.competencia),
  ];
  if (meta.ambiente === "producao_restrita") linhas.push("Esta nota foi emitida no ambiente de testes, sem valor fiscal.");
  return mandarEmail(env, meta.conta, {
    assunto: "Sua NFS-e de " + mesAno(meta.competencia) + " — Atos", titulo: "Sua NFS-e de " + mesAno(meta.competencia), texto: linhas.join("\n\n"), anexos,
  });
}

/* Manda o e-mail da nota ao e-mail do tomador ajustado no painel ou, sem ele, ao dos dados fiscais do cliente.
   Devolve "enviado" | "sem RESEND_API_KEY" | "sem e-mail do cliente" | "falhou: <motivo>"; nunca lanca.
   No Worker de teste (AMBIENTE "teste") NADA sai: o e-mail so fica anotado (registrarEmailDeTeste) e a nota diz
   "registrado no teste (não saiu)" - os clientes de la sao de exemplo ou de teste, e o Resend nao e chamado. */
export async function mandarEmail(env, clienteId, { assunto, titulo, texto, anexos }) {
  const teste = ehAmbienteDeTeste(env);
  if (!teste && !env.RESEND_API_KEY) return "sem RESEND_API_KEY";
  try {
    const ajuste = (await kvJSON(env, K(env).tomador + clienteId)) || {};
    let para = ajuste.email || "";
    if (!para) para = ((await perfilDe(env, clienteId)) || {}).email || "";
    if (!para) para = ((await kvJSON(env, K(env).clientes + clienteId, null)) || {}).email || "";
    if (!para) return "sem e-mail do cliente";
    if (teste) return await registrarEmailDeTeste(env, { para, assunto, anexos });
    const r = await enviarEmail(env, { para, assunto, titulo, texto, anexos });
    return r.ok ? "enviado" : "falhou: " + (r.erro || "o provedor de e-mail recusou");
  } catch (e) {
    return "falhou: " + String((e && e.message) || e).slice(0, 200);
  }
}

/* O e-mail que sairia, anotado (os ultimos 30) em atos-teste:nfse:emails: so no Worker de teste. */
export const MARCA_EMAIL_DE_TESTE = "registrado no teste (não saiu)";
async function registrarEmailDeTeste(env, { para, assunto, anexos }) {
  const chave = K(env).prefixo + "emails";
  const lista = (await kvJSON(env, chave, [])) || [];
  lista.push({ para: String(para).slice(0, 120), assunto: String(assunto || "").slice(0, 200), anexos: (anexos || []).map((a) => a.nome), quando: new Date().toISOString() });
  await env.CONTAS.put(chave, JSON.stringify(lista.slice(-30)));
  return MARCA_EMAIL_DE_TESTE;
}

/* A nota cancelada (ou substituida) para o cliente. Usada pelo emissor. d: {conta, email?, substituta?: {numero}}.
   Devolve {status, corpo}. */
export async function avisarNotaCancelada(env, id, d) {
  const json = (corpo, status = 200) => ({ corpo, status });
  const conta = String(d.conta || "");
  if (!RE_CLIENTE.test(conta)) return json({ erro: "cliente inválido" }, 400);
  const chave = K(env).nota + conta + ":" + id;
  const meta = await kvJSON(env, chave);
  if (!meta) return json({ erro: "essa nota não existe" }, 404);
  meta.cancelada = true;
  meta.cancelada_em = new Date().toISOString();
  const substituta = d.substituta && typeof d.substituta === "object" ? String(d.substituta.numero || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 30) : "";
  if (substituta) meta.substituta = substituta;
  await env.CONTAS.put(chave, JSON.stringify(meta));
  if (meta.pagamento) await marcarPagamento(env, meta.pagamento, { nota: "cancelada" });
  if (d.email !== true) return json({ ok: true });
  const linhas = [
    "A NFS-e nº " + (meta.numero || id) + " (" + mesAno(meta.competencia) + ", " + brl(meta.valor) + ") do seu pagamento na Atos foi cancelada.",
  ];
  if (substituta) linhas.push("Ela foi substituída pela nota nº " + substituta + ", que você recebe à parte.");
  if (meta.ambiente === "producao_restrita") linhas.push("Esta nota era do ambiente de testes, sem valor fiscal.");
  const email = await mandarEmail(env, conta, {
    assunto: "NFS-e nº " + (meta.numero || id) + " cancelada — Atos", titulo: "NFS-e cancelada", texto: linhas.join("\n\n"),
  });
  return json({ ok: true, email });
}
