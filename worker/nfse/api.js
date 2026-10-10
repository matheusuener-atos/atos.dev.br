// A API do emissor de NFS-e da Atos (porte de worker/nfse/api.js do PAVLVS), para o painel da Atos em
// /api/admin/nfse/* (worker/admin.js). atenderEmissor NAO autentica nada sozinho: quem chama (o painel) ja
// conferiu a pessoa e o papel, e passa `quem` = {email, papel}; o e-mail vira o autor dos passos da nota.
// Quem so le (o papel sem emitir) deve receber do painel so os GET.
//
// As chaves do KV sao as de atos.js (K(env): "atos:nfse:*"; no Worker de teste, "atos-teste:nfse:*").
//
// Rotas (relativas ao prefixo "/api/admin/nfse/"):
//   GET  resumo                         tudo o que a aba mostra: config, emissor, situacao, notas, pagamentos sem nota, cloudflare
//   GET  situacao                       configuração, certificado, município, pode_emitir, cloudflare, config
//   POST config {auto, email, mail}     os interruptores: emitir sozinho ao pagar, entregar logo ao cliente, mandar o e-mail
//   POST prestador {prestador}          grava uma versão nova da configuração
//   POST certificado {certPem, cadeiaPem, chavePkcs8, titular, documento, validoAte}
//                                       o .pfx aberto NO NAVEGADOR (nunca vem inteiro); guarda
//                                       cifrado no DO e cadastra o mTLS na Cloudflare (mtls.js)
//   POST cloudflare {token}             o token de API da Cloudflare (cifrado no KV; "" apaga)
//   POST testar                         certificado, conexão com a Sefin e convênio, com o tempo
//   GET  municipios?q=<nome>&uf=<UF>    até 12 {codigo, nome, uf}
//   GET  clientes                       os clientes da Atos (o índice atos:nfse:clientes:*) com o tomador e o que falta
//   POST clientes/:cliente {tomador}    o ajuste do tomador, SÓ para a nota (o perfil fiscal do cliente não muda)
//   GET  pagamentos                     a fila: os pagamentos aprovados e a marca da nota
//   POST pagamentos/:ref/emitir         emite a nota de um pagamento da fila (o tomador do cliente)
//   POST notas {conta?, pagamento?, tomador, valor | valor_centavos, descricao, competencia}
//                                       (conta = o id do cliente da Atos, 32 hex)
//   GET  notas?estado=&limite=          a lista
//   GET  notas/:id                      a nota, os passos e os eventos
//   GET  notas/:id/xml?tipo=nfse|dps    o XML (application/xml)
//   GET  notas/:id/pdf[?baixar=1]       o DANFSe (gera na hora se ainda não existe)
//   POST notas/:id/enviar               entrega ao cliente (e e-mail, com "mail" ligado)
//   POST notas/:id/tentar               de novo (consulta antes de reenviar)
//   POST notas/:id/descartar            rejeitada: devolve o número
//   POST notas/:id/cancelar {motivo, texto}
//   POST notas/:id/substituir {motivo, texto, ajustes: {tomador?, valor?, descricao?, competencia?}}
//   POST notas/:id/situacao             consulta os eventos da nota (cancelada por ofício...)
//   POST notas/:id/depois               PDF + e-mail em segundo plano (ctx.waitUntil), 202
//   POST fila                           processa a fila agora (o alarme do DO faz sozinho)
//   POST producao/liberar  /  POST producao/voltar
//
// O PDF e o e-mail ficam FORA do pedido que emite (o DANFSe com pdf-lib somado à emissão passaria dos 10 ms de
// CPU do plano grátis). A tela chama POST notas/:id/depois logo depois de receber a nota emitida; o que sobrar
// (emissão automática, nota que saiu da fila) o Cron de cada minuto faz (depoisPendentes, worker/index.js).

import { b64 } from "./assinatura.js";
import {
  chamar, clienteDaAtos, configNfse, emissorDe, emitirAutomatico, faltaDoEmissor, gravarConfig, gravarTomador, K, kvJSON,
  listarClientes, listarPagamentos, lerPagamento, mandarNotaPorEmail, RE_CLIENTE,
} from "./atos.js";
import { deB64 } from "./cofre.js";
import { gerarDanfse } from "./danfse.js";
import { idNoCliente, K_DEPOIS } from "./emissor.js";
import { buscarMunicipios } from "./tabelas.js";
import { guardarTokenCf, instalarMtls, K_CADEIA, mtlsEhDeste, situacaoCf } from "./mtls.js";

export { chamar, emissorDe, emitirAutomatico, faltaDoEmissor, configNfse };

export const PREFIXO = "/api/admin/nfse/";

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const nomeArquivo = (t) => String(t || "").replace(/[^A-Za-z0-9 ._-]/g, "");

/**
 * O pedido do painel. url: a URL do pedido (new URL(request.url)); quem: {email, papel} de quem pede (o painel
 * autenticou); opcoes.ctx: o ctx do Worker (o PDF em segundo plano); opcoes.prefixo: o das rotas.
 */
export async function atenderEmissor(request, env, url, quem, { ctx = null, prefixo = PREFIXO } = {}) {
  url = url || new URL(request.url);
  if (!url.pathname.startsWith(prefixo)) return json({ erro: "rota não existe" }, 404);
  const autor = String((quem && (quem.email || quem.nome)) || "painel").slice(0, 120);
  const p = url.pathname.slice(prefixo.length).replace(/\/+$/, "");
  const m = request.method;
  let corpo = {};
  if (m === "POST") {
    try {
      const t = await request.text();
      corpo = t ? JSON.parse(t) : {};
    } catch {
      return json({ erro: "pedido inválido" }, 400);
    }
    if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return json({ erro: "pedido inválido" }, 400);
  }
  // O que nao precisa do emissor ligado.
  try {
    if (m === "GET" && p === "resumo") return json(await resumoParaPainel(env));
    if (m === "POST" && p === "config") return json({ config: await gravarConfig(env, corpo) });
    if (m === "GET" && p === "municipios") {
      const q = String(url.searchParams.get("q") || "").slice(0, 80);
      return json({ municipios: buscarMunicipios(q, String(url.searchParams.get("uf") || "").slice(0, 2), 12) });
    }
    if (m === "GET" && p === "clientes") return json({ clientes: await listarClientes(env) });
    const r = p.match(/^clientes\/([0-9a-f]{32})$/);
    if (r && m === "POST") {
      const g = await gravarTomador(env, r[1], corpo.tomador);
      return json(g.corpo, g.status);
    }
    if (m === "GET" && p === "pagamentos") return json(await listarPagamentos(env));
    if (m === "POST" && p === "cloudflare") return json(...(await receberTokenCf(env, corpo)));
  } catch (e) {
    return json({ erro: String((e && e.message) || e).slice(0, 300) }, 500);
  }
  const falta = faltaDoEmissor(env);
  if (falta) return json({ erro: "o emissor de NFS-e ainda não está ligado: " + falta }, 503);
  const via = async (acao, dados) => {
    const r = await chamar(env, acao, dados);
    return json(r.dados, r.status);
  };
  try {
    if (m === "GET" && p === "situacao") {
      const r = await chamar(env, "situacao", {});
      if (r.status !== 200) return json(r.dados, r.status);
      return json({ ...r.dados, cloudflare: await situacaoCf(env), config: await configNfse(env) });
    }
    if (m === "POST" && p === "prestador") return via("configurar", { prestador: corpo.prestador, quem: autor, motivo: corpo.motivo || "" });
    if (m === "POST" && p === "certificado") return json(...(await receberCertificado(env, corpo, autor)));
    if (m === "POST" && p === "testar") return json(await testar(env));
    let r = p.match(/^pagamentos\/([A-Za-z0-9_.:-]{1,80})\/emitir$/);
    if (r && m === "POST") return json(...(await emitirDoPagamento(env, r[1], autor)));
    if (m === "POST" && p === "notas") {
      if (corpo.conta && !RE_CLIENTE.test(String(corpo.conta))) return json({ erro: "cliente inválido (o id do cliente da Atos)" }, 400);
      return via("emitir", { ...corpo, quem: autor });
    }
    if (m === "GET" && p === "notas") return via("listar", { estado: url.searchParams.get("estado") || "", limite: url.searchParams.get("limite") || 300 });
    if (m === "POST" && p === "fila") return via("fila", { quem: autor });
    if (m === "POST" && p === "producao/liberar") return via("liberar_producao", { quem: autor });
    if (m === "POST" && p === "producao/voltar") return via("voltar_testes", { quem: autor });
    r = p.match(/^notas\/(\d{1,12})(?:\/([a-z]+))?$/);
    if (r) {
      const id = Number(r[1]);
      const sub = r[2] || "";
      if (m === "GET" && !sub) return via("nota", { id });
      if (m === "GET" && sub === "xml") {
        const x = await chamar(env, "xml", { id, tipo: url.searchParams.get("tipo") === "dps" ? "dps" : "nfse" });
        if (x.status !== 200) return json(x.dados, x.status);
        return new Response(x.dados.xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store",
          "content-disposition": `attachment; filename="${nomeArquivo(x.dados.nome)}"` } });
      }
      if (m === "GET" && sub === "pdf") {
        const pdf = await pdfDaNota(env, id);
        if (pdf.erro) return json({ erro: pdf.erro }, pdf.status || 409);
        return new Response(deB64(pdf.b64), { headers: { "content-type": "application/pdf", "cache-control": "no-store",
          "content-disposition": `${url.searchParams.get("baixar") ? "attachment" : "inline"}; filename="${nomeArquivo("NFS-e " + (pdf.numero || id))}.pdf"` } });
      }
      if (m === "POST" && sub === "enviar") return json(...(await enviarAoCliente(env, id, autor)));
      if (m === "POST" && sub === "tentar") return via("tentar", { id, quem: autor });
      if (m === "POST" && sub === "descartar") return via("descartar", { id, quem: autor });
      if (m === "POST" && sub === "cancelar") return via("cancelar", { id, motivo: corpo.motivo, texto: corpo.texto, quem: autor });
      if (m === "POST" && sub === "substituir") return via("substituir", { id, motivo: corpo.motivo, texto: corpo.texto, ajustes: corpo.ajustes || {}, quem: autor });
      if (m === "POST" && sub === "situacao") return via("atualizar_situacao", { id, quem: autor });
      if (m === "POST" && sub === "depois") {
        const trabalho = depoisDeEmitir(env, id);
        if (ctx && ctx.waitUntil) ctx.waitUntil(trabalho.catch(() => {}));
        else await trabalho;
        return json({ ok: true, agendado: true }, 202);
      }
    }
    return json({ erro: "rota não existe" }, 404);
  } catch (e) {
    return json({ erro: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

// ------------------------------------------------------------ pagamento da fila

/** A nota de um pagamento da fila, pelo botão do painel: o tomador do cliente (perfil + ajuste). [corpo, status] */
async function emitirDoPagamento(env, ref, autor) {
  const pag = await lerPagamento(env, ref);
  if (!pag) return [{ erro: "esse pagamento não está na fila" }, 404];
  const cli = await clienteDaAtos(env, pag.cliente);
  if (cli.faltas.length) return [{ erro: "falta " + cli.faltas.join(", ") + " do cliente (Notas fiscais › Clientes)", faltas: cli.faltas }, 409];
  const r = await chamar(env, "emitir", { conta: pag.cliente, pagamento: ref, tomador: cli.tomador, quem: autor });
  return [r.dados, r.status];
}

// ------------------------------------------------------------ certificado

/**
 * O .pfx foi aberto no navegador: chegam o certificado (PEM), a cadeia, a chave (PKCS#8 em base64), o titular, o
 * documento e a validade. 1) o DO confere o par e guarda cifrado; 2) com o token da Cloudflare, o mTLS é
 * cadastrado e o auxiliar republicado. Devolve [corpo, status].
 */
async function receberCertificado(env, corpo, quem) {
  const certificado = corpo.certPem || corpo.certificado;
  const chave = corpo.chavePkcs8 || corpo.chave;
  if (!certificado || !chave) return [{ erro: "mande o certificado e a chave (o .pfx é aberto no navegador)" }, 400];
  const g = await chamar(env, "certificado", { certificado, chave, titular: corpo.titular || "", documento: corpo.documento || "",
    algoritmo: corpo.algoritmo || "sha1", quem });
  if (g.status !== 200) return [g.dados, g.status];
  const cadeia = (Array.isArray(corpo.cadeiaPem) ? corpo.cadeiaPem : [corpo.cadeiaPem]).filter((x) => typeof x === "string" && x.includes("BEGIN CERTIFICATE")).slice(0, 5);
  await env.CONTAS.put(K_CADEIA(env), JSON.stringify(cadeia));
  const cert = g.dados;
  const conexao = await ligarMtls(env, { certPem: certificado, cadeiaPem: cadeia, chavePkcs8: String(chave), documento: cert.documento, validoAte: cert.valido_ate });
  return [{ certificado: cert, conexao, cloudflare: await situacaoCf(env) }, 200];
}

async function ligarMtls(env, par) {
  const r = await instalarMtls(env, par);
  if (r.ok) return { ok: true, certificate_id: r.certificate_id, aviso: r.aviso || "", frase: "Certificado cadastrado na Cloudflare: a conexão com a Sefin usa este certificado." };
  if (r.falta_token) {
    return { ok: false, falta_token: true, frase: "O certificado foi guardado, mas a conexão com a Sefin ainda não usa ele: falta o token da Cloudflare (Parâmetros › Token da Cloudflare). Com o token gravado, o cadastro sai sozinho." };
  }
  if (r.etapa === "configuração" || r.etapa === "token") return { ok: false, etapa: r.etapa, erro: r.erro, frase: "O certificado foi guardado, mas a conexão com a Sefin ainda não usa ele: " + r.erro + "." };
  return { ok: false, etapa: r.etapa, erro: r.erro, frase: "O certificado foi guardado, mas não consegui " + r.etapa + ": " + r.erro + "." };
}

/** O token da Cloudflare; com ele, cadastra o mTLS do certificado que já está guardado. */
async function receberTokenCf(env, corpo) {
  if (!("token" in corpo)) return [{ erro: "mande o token" }, 400];
  if (!env.NFSE_CHAVE_MESTRA && String(corpo.token || "").trim()) return [{ erro: "falta o segredo NFSE_CHAVE_MESTRA (ele cifra o token)" }, 503];
  const g = await guardarTokenCf(env, corpo.token);
  if (g.erro) return [{ erro: g.erro }, 400];
  let conexao = null;
  if (g.token && !faltaDoEmissor(env)) {
    const s = await chamar(env, "situacao", {});
    const cert = s.status === 200 ? s.dados.certificado : null;
    if (cert && cert.instalado && !(await mtlsEhDeste(env, cert))) {
      const par = await chamar(env, "par_para_mtls", {});
      if (par.status === 200) {
        const cadeia = (await kvJSON(env, K_CADEIA(env), [])) || [];
        conexao = await ligarMtls(env, { certPem: par.dados.certPem, chavePem: par.dados.chavePem, cadeiaPem: cadeia,
          documento: par.dados.documento, validoAte: par.dados.valido_ate });
      }
    }
  }
  return [{ cloudflare: await situacaoCf(env), conexao }, 200];
}

// ------------------------------------------------------------ testar

/** Três etapas, cada uma com ok, detalhe e o tempo: certificado, conexão com a Sefin, convênio. */
async function testar(env) {
  const etapas = [];
  const s = await chamar(env, "situacao", {});
  const cert = s.status === 200 ? s.dados.certificado || {} : {};
  if (!cert.instalado) etapas.push({ titulo: "Certificado", ok: false, detalhe: "nenhum certificado instalado" });
  else if (cert.vencido) etapas.push({ titulo: "Certificado", ok: false, detalhe: "venceu em " + String(cert.valido_ate).slice(0, 10).split("-").reverse().join("/") });
  else etapas.push({ titulo: "Certificado", ok: true, detalhe: (cert.titular || "") + " · vence em " + cert.dias_restantes + " dias" });
  const inicio = Date.now();
  const t = await chamar(env, "testar", {});
  const ms = Date.now() - inicio;
  if (t.status !== 200) {
    etapas.push({ titulo: "Conexão com a Sefin", ok: false, detalhe: t.dados.erro || "HTTP " + t.status, ms });
    etapas.push({ titulo: "Convênio do município", ok: false, detalhe: "não consultado" });
  } else {
    const mun = t.dados.municipio || {};
    const respondeu = t.dados.status > 0;
    const tempo = t.dados.ms != null ? t.dados.ms : ms;
    const cf = respondeu ? null : await situacaoCf(env);
    etapas.push({ titulo: "Conexão com a Sefin", ok: respondeu, ms: tempo,
      detalhe: respondeu ? "respondeu HTTP " + t.dados.status + " em " + tempo + " ms (" + (t.dados.ambiente === "producao" ? "produção" : "produção restrita") + ")"
        : (mun.detalhes || "sem resposta") + (cf && cf.falta ? " · " + cf.falta : "") });
    etapas.push({ titulo: "Convênio do município", ok: mun.situacao === "conveniado", detalhe: mun.frase || "" });
  }
  return { ok: etapas.every((e) => e.ok), etapas, municipio: t.status === 200 ? t.dados.municipio : null, quando: new Date().toISOString() };
}

// ------------------------------------------------------------ PDF, envio e e-mail

/** Monta o DANFSe da nota emitida: {b64, nota, xml} ou {erro, status}. */
async function montarPdf(env, id) {
  const r = await chamar(env, "para_pdf", { id });
  if (r.status !== 200) return { erro: r.dados.erro, status: r.status };
  const { nota, xml_nfse: xml } = r.dados;
  if (!["emitida", "cancelada", "substituida"].includes(nota.estado)) return { erro: "a nota ainda não foi emitida", status: 409 };
  if (!xml) return { erro: "a nota não tem o XML da NFS-e", status: 409 };
  // O DANFSe no leiaute da NT 008, tirado só do XML (danfse.js).
  const pdf = await gerarDanfse(xml);
  return { b64: b64(pdf), bytes: pdf.length, nota, xml };
}

/** O PDF guardado (atos:nfse:pdf:<id>) ou, se ainda não existe, gerado agora. */
export async function pdfDaNota(env, id) {
  const guardado = await env.CONTAS.get(K(env).pdf + id);
  if (guardado) {
    const n = await chamar(env, "nota", { id });
    return { b64: guardado, numero: n.status === 200 ? n.dados.nota.numero : "" };
  }
  const p = await montarPdf(env, id);
  if (p.erro) return p;
  await env.CONTAS.put(K(env).pdf + id, p.b64);
  return { b64: p.b64, numero: p.nota.numero, gerado: true };
}

function metaDoEmail(nota) {
  return { id: idNoCliente(nota.id), conta: nota.conta, numero: nota.numero, valor: Number(nota.centavos || 0) / 100,
    competencia: nota.competencia, ambiente: nota.ambiente, descricao: nota.descricao || "" };
}

/* O PDF tambem vai para a nota do cliente (atos:nfse:nota-pdf:<cliente>:<id>), se ela ja foi entregue. */
async function pdfParaOCliente(env, nota, pdfB64) {
  if (!nota.conta || !pdfB64) return;
  const base = nota.conta + ":" + idNoCliente(nota.id);
  const meta = await kvJSON(env, K(env).nota + base, null);
  if (!meta) return;
  await env.CONTAS.put(K(env).notaPdf + base, pdfB64);
  await env.CONTAS.put(K(env).nota + base, JSON.stringify({ ...meta, tem_pdf: true }));
}

/**
 * Depois de emitida, num pedido SEPARADO: o DANFSe vai para atos:nfse:pdf:<id> e, se a nota já foi entregue ao
 * cliente, para atos:nfse:nota-pdf:<cliente>:nfse-<id> (a meta passa a dizer tem_pdf); com "mail" ligado, o e-mail
 * com PDF e XML vai ao cliente. Marca na nota (pdf_em, email). Uma vez por nota (forcar refaz). Devolve {ok,
 * pdf_bytes, email}. Chamável por ctx.waitUntil.
 */
export async function depoisDeEmitir(env, id, { forcar = false } = {}) {
  await tirarDeDepois(env, id);
  const n = await chamar(env, "nota", { id });
  if (n.status !== 200) return { ok: false, erro: n.dados.erro };
  if (n.dados.nota.pdf_em && !forcar) return { ok: true, ja: true };
  const p = await montarPdf(env, id);
  if (p.erro) return { ok: false, erro: p.erro };
  const nota = p.nota;
  if (nota.estado !== "emitida") return { ok: false, erro: "a nota não está emitida" };
  await env.CONTAS.put(K(env).pdf + id, p.b64);
  let email = "";
  if (nota.conta) {
    await pdfParaOCliente(env, nota, p.b64);
    if ((await configNfse(env)).mail) email = await mandarNotaPorEmail(env, metaDoEmail(nota), p.b64, b64(new TextEncoder().encode(p.xml)));
  }
  await chamar(env, "marcar_depois", { id, pdf_em: new Date().toISOString(), email });
  return { ok: true, pdf_bytes: p.bytes, email };
}

/** Enviar ao cliente: a nota (meta, XML e PDF) guardada para ele e, com "mail" ligado, o e-mail. [corpo, status] */
async function enviarAoCliente(env, id, quem) {
  const r = await chamar(env, "enviar_cliente", { id, quem });
  if (r.status !== 200) return [r.dados, r.status];
  const nota = r.dados;
  const pdf = await pdfDaNota(env, id);
  await pdfParaOCliente(env, nota, pdf.b64);
  let email = "";
  if ((await configNfse(env)).mail) {
    const x = await chamar(env, "xml", { id, tipo: "nfse" });
    email = await mandarNotaPorEmail(env, metaDoEmail(nota), pdf.b64 || "", x.status === 200 ? b64(new TextEncoder().encode(x.dados.xml)) : "");
    await chamar(env, "anotar_email", { id, email });
  }
  return [{ ok: true, nota, email, pdf: Boolean(pdf.b64) }, 200];
}

async function tirarDeDepois(env, id) {
  const lista = (await kvJSON(env, K_DEPOIS(env), [])) || [];
  if (!Array.isArray(lista) || !lista.some((x) => x && x.id === id)) return;
  await env.CONTAS.put(K_DEPOIS(env), JSON.stringify(lista.filter((x) => x && x.id !== id)));
}

/**
 * O Cron de cada minuto (worker/index.js): o PDF (e o e-mail) das notas emitidas que ninguém pediu ainda, uma
 * por vez, as que estão na lista há mais de 1 min (a tela pede logo depois de emitir). Sem nada na lista, uma
 * leitura do KV.
 */
export async function depoisPendentes(env, agora = Date.now()) {
  if (!env.CONTAS || !env.EMISSOR_NFSE) return { feitas: 0 };
  const lista = (await kvJSON(env, K_DEPOIS(env), [])) || [];
  if (!Array.isArray(lista) || !lista.length) return { feitas: 0 };
  const pronta = lista.find((x) => x && agora - Date.parse(x.quando) >= 60 * 1000);
  if (!pronta) return { feitas: 0 };
  try {
    await depoisDeEmitir(env, pronta.id);
  } catch {
    await tirarDeDepois(env, pronta.id);
  }
  return { feitas: 1 };
}

// ------------------------------------------------------------ o painel

/**
 * GET resumo: tudo o que a aba Notas fiscais mostra de uma vez.
 * {config, emissor: {ligado, falta}, situacao | null, notas: [nota], pagamentos: [os sem nota], cloudflare, erro}
 */
export async function resumoParaPainel(env) {
  const config = await configNfse(env);
  const falta = faltaDoEmissor(env);
  const { pagamentos } = env.CONTAS ? await listarPagamentos(env) : { pagamentos: [] };
  const base = { config, emissor: { ligado: !falta, falta }, situacao: null, notas: [], cloudflare: env.CONTAS ? await situacaoCf(env) : null, erro: "" };
  if (falta) return { ...base, pagamentos: pagamentos.filter((x) => x.nota !== "emitida" && x.nota !== "cancelada") };
  const [s, l] = await Promise.all([chamar(env, "situacao", {}), chamar(env, "listar", { limite: 300 })]);
  const notas = l.status === 200 ? l.dados.notas : [];
  const comNota = new Set(notas.filter((n) => n.pagamento && n.estado !== "descartada").map((n) => n.pagamento));
  const semNota = pagamentos.filter((x) => !comNota.has(x.id) && x.nota !== "emitida" && x.nota !== "cancelada");
  return { ...base, situacao: s.status === 200 ? s.dados : null, notas, pagamentos: semNota,
    erro: s.status !== 200 ? s.dados.erro : l.status !== 200 ? l.dados.erro : "" };
}
