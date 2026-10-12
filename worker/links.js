// Atos Workspace > Pagina de links (atos.dev.br/workspace/links; a tela e public/assets/workspace-links.js): uma pagina
// publica atos.dev.br/@<nome>, no estilo das paginas "de links" de perfil: o nome de exibicao, uma frase curta, uma foto
// opcional e a lista de links; e, se a pessoa quiser, o e-mail Atos dela e um formulario dela como botoes.
//
// Contra golpe (decisoes de 12/10/2026):
//   - so estrutura: nada de HTML, CSS ou script da pessoa. A Atos gera a pagina, sem script (CSP propria: default-src
//     'none'), com o dominio de destino escrito embaixo de cada link;
//   - links so https (worker/url-externa.js: sem IP, localhost, rede interna, porta fora do padrao nem os dominios da
//     Atos), sem encurtadores conhecidos (o destino precisa ficar visivel) e sem titulos com o nome da Atos ou dos
//     produtos dela (um "Entrar na Conta Atos" que leva para fora);
//   - nomes de pagina reservados (os do e-mail Atos, marcas, bancos, governo...) e nunca o e-mail Atos de outra pessoa;
//   - o rodape fixo: "Pagina criada por uma pessoa com Conta Atos. A Atos nao verificou estes links." e "Denunciar esta
//     pagina" (um formulario simples que chega a equipe, no painel; a Atos nao guarda quem denunciou nem o endereco de
//     internet; limite por endereco, por pagina e por dia);
//   - a equipe (painel, Atos Workspace > Paginas de links) ve as paginas e as denuncias, tira do ar com motivo (a pessoa
//     ve) e liga de novo.
// Os cliques: so no Pro, pelo redirecionamento atos.dev.br/@<nome>/ir/<id> (so para os links da propria pagina, ligados
// e dentro do plano: nunca um redirecionador aberto), contados por dia e por link, sem endereco de internet nem nada de
// quem clicou; 90 dias. No gratuito os links vao direto (o href e o destino) e nada e contado.
//
// O plano (worker/workspace-plano.js): gratuito 1 pagina com ate 5 links; Pro 3 paginas, ate 50 links cada, e a
// estatistica. Fora do plano (depois do Pro): as paginas mais novas saem do ar (o nome continua reservado) e os links
// que passam do limite nao aparecem; nada e apagado.
//
// Exige o Workspace ativo e sem suspensao (o e-mail Atos nao e obrigatorio; quem tem o alias confirmado entra por ele,
// como no resto do Workspace). Workspace desativado ou suspenso: a pagina publica sai do ar ate voltar.
//
// Os dados (worker/workspace-dados.js). No objeto da conta:
//   lk:pag:<nome>          {nome, exibicao, frase, foto, links: [{id, titulo, url, ativo}], email_atos, formulario,
//                           criado, mudado, bloqueado: null|{quando, motivo, por}}
//   lk:clk:<nome>|<dia>    {<id do link>: cliques} (90 dias; so no Pro)
//   form:<id>.pagina       o nome da pagina que mostra o formulario (a Atos aceita o envio vindo da pagina de contato)
// No objeto "indice":
//   lpag:<nome>            {sub, conta, criado, bloqueado} (a pagina publica acha o dono; o painel lista)
//   lden:<iso>|<r>         {id, nome, sub, motivo, texto, quando, estado: "aberta"|"resolvida", resolvida} as denuncias
//                          (um ano)
//
// Rotas do dono (a sessao, o Workspace ativo; mudar pede login das ultimas 12 horas):
//   GET  /api/workspace/links      as paginas, os limites do plano, a estatistica (Pro), os formularios e o e-mail Atos
//   POST /api/workspace/links      {acao: salvar {nome, exibicao, frase, foto, links, email_atos, formulario} |
//                                   apagar {nome, confirmar}}
// Publicas (sem script, CSP propria, 60 s de cache na pagina):
//   GET  /@<nome>                  a pagina
//   GET  /@<nome>/ir/<id>          o redirecionamento contado (Pro)
//   GET  /@<nome>/contato          o formulario da pessoa (se ela escolheu um), enviado a /f/<id>
//   GET|POST /@<nome>/denunciar    a denuncia
// Painel (worker/admin-workspace.js -> atenderLinksNoPainel): ver (todos), tirar do ar, ligar e resolver denuncia (dono
// e suporte).

import { json, lerJson, normal } from "./comum.js";
import { portaoDoWorkspace, workspaceDe } from "./workspace.js";
import { conferirAlias, destinoDoTitular, registro } from "./email-atos.js";
import { apagarAntigos, apagarPrefixo, daConta, doIndice, isoDe, sorteio } from "./workspace-dados.js";
import { conferirUrlExterna } from "./url-externa.js";
import { PLANOS_WS, dentroDoPlano, limiteDoPlano, planoDe, vistaDoPlano } from "./workspace-plano.js";
import { anotarDaEquipe } from "./workspace-indice.js";

export const LIMITES_LINKS = {
  paginas: 3, links: 50, exibicao: 60, frase: 140, titulo: 60, foto_kb: 50, cliques_dias: 90, recente_h: 12, mudancas_hora: 60,
  denuncias_pagina_dia: 20, denuncias_dia: 500, denuncia_texto: 1000,
};
const DIA_S = 86400;
const RECENTE_S = LIMITES_LINKS.recente_h * 3600;
const NOME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;
const LID = /^l[0-9a-f]{6}$/;
const diaDe = (ms) => isoDe(ms - 3 * 3600 * 1000).slice(0, 10);
const limparTexto = (t, max) => String(t == null ? "" : t).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// ------------------------------------------------------------------ os nomes e os links

// Alem dos nomes do e-mail Atos (conferirAlias: os enderecos de servico, a Atos, os produtos e os servicos conhecidos):
// bancos, governo, redes e lojas conhecidos (dentro do nome, com as trocas 0/o, 1/i, 3/e, 4/a, 5/s, 7/t, v/u) e alguns
// nomes curtos ou de "conta" (o nome inteiro).
const DENTRO = ["banco", "bradesco", "itau", "santander", "nubank", "bancodobrasil", "caixaeconomica", "sicoob", "sicredi", "receitafederal", "gov",
  "serasa", "detran", "inss", "correios", "policia", "tribunal", "facebook", "instagram", "whatsapp", "tiktok", "youtube", "linkedin", "twitter",
  "paypal", "picpay", "pagseguro", "netflix", "amazon", "shopee", "openai", "chatgpt", "microsoft", "apple", "google", "atos", "paulus", "anthropic"];
const EXATOS = new Set(["inter", "caixa", "c6", "c6bank", "pix", "meta", "x", "bb", "nu", "oficial", "suporte", "ajuda", "login", "entrar", "conta",
  "seguranca", "verificar", "verificacao", "senha", "pagamento", "pagamentos", "premio", "sorteio", "links", "link", "ir", "denunciar", "contato"]);

function normalizado(t) {
  return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/0/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/v/g, "u");
}

/* O nome da pagina (atos.dev.br/@<nome>): {nome} ou {erro}. */
export function conferirNomeDaPagina(bruto) {
  const nome = String(bruto == null ? "" : bruto).trim().toLowerCase().replace(/^@/, "");
  if (!NOME.test(nome)) return { erro: "o nome da página: de 3 a 30 letras minúsculas sem acento, números e hífen (vira atos.dev.br/@<nome>)" };
  const junto = nome.replace(/-/g, "");
  const n = normalizado(junto);
  if (conferirAlias(nome).erro || conferirAlias(n).erro || EXATOS.has(junto) || EXATOS.has(n) || DENTRO.some((p) => n.includes(p) || junto.includes(p))) {
    return { erro: "esse nome é reservado (lembra a Atos, um banco, o governo, uma marca conhecida ou uma página de conta): escolha outro" };
  }
  return { nome };
}

// Encurtadores conhecidos: o destino precisa ficar visivel embaixo do link.
const ENCURTADORES = /(^|\.)(bit\.ly|bitly\.com|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly|shorturl\.at|rb\.gy|tiny\.cc|bl\.ink|s\.id|t\.ly|v\.gd|encurtador\.com\.br|encurta\.net|migre\.me|abre\.ai|short\.io|shorte\.st|adf\.ly|lnkd\.in|trib\.al|soo\.gd|clck\.ru|qr\.net|x\.co|db\.tt|ift\.tt|dlvr\.it|t2m\.io|surl\.li|u\.to|cli\.re|1url\.com|urlzs\.com|tiny\.one|chilp\.it)$/;
// Os dominios dos produtos da Atos (o atos.dev.br ja e recusado por conferirUrlExterna).
const DA_ATOS = /(^|\.)(paulus\.ia\.br|pavlvs\.com\.br)$/;

/* Um link: {link: {id, titulo, url, ativo}} ou {erro}. `ids`: os ids que ja existem (para manter). */
export function conferirLink(x, ids = new Set()) {
  const titulo = limparTexto(x && x.titulo, LIMITES_LINKS.titulo);
  if (titulo.length < 1) return { erro: "dê um título a cada link" };
  const t = normalizado(titulo).replace(/[^a-z0-9]+/g, " ");
  if (/(^| )(atos|paulus|conta atos|atos workspace)( |$)/.test(t) || /atos\.dev|atosdev/.test(t)) return { erro: "o título “" + titulo + "” usa o nome da Atos ou de um produto dela: escolha outro" };
  const u = conferirUrlExterna(x && x.url, { contexto: "o link “" + titulo + "”" });
  if (u.erro) return { erro: u.erro };
  const host = new URL(u.url).hostname.toLowerCase();
  if (ENCURTADORES.test(host)) return { erro: "o link “" + titulo + "” usa um encurtador (" + host + "): use o endereço de destino, que aparece embaixo do link" };
  if (DA_ATOS.test(host)) return { erro: "o link “" + titulo + "” aponta para um produto da Atos: a página de links é para os seus endereços" };
  const id = LID.test(String(x && x.id)) && ids.has(x.id) ? x.id : "l" + sorteio(3);
  return { link: { id, titulo, url: u.url, ativo: x && x.ativo !== false } };
}

/* A foto: "" ou um data: PNG, JPEG ou WebP de ate 50 KB, conferido pelos primeiros bytes. {foto} ou {erro}. */
export function conferirFoto(bruto) {
  const f = String(bruto || "");
  if (!f) return { foto: "" };
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(f);
  if (!m) return { erro: "a foto precisa ser uma imagem PNG, JPEG ou WebP (SVG não)" };
  if (m[2].length > Math.ceil((LIMITES_LINKS.foto_kb * 1024) / 3) * 4) return { erro: "a foto passa de " + LIMITES_LINKS.foto_kb + " KB: diminua a imagem" };
  let b;
  try { b = Uint8Array.from(atob(m[2].slice(0, 24)), (c) => c.charCodeAt(0)); } catch { return { erro: "a foto não é uma imagem válida" }; }
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
  if (!({ png, jpeg: jpg, webp })[m[1]]) return { erro: "a foto não é o que diz ser (o conteúdo não é " + m[1].toUpperCase() + ")" };
  return { foto: f };
}

/* A pagina que o dono mandou: {pagina} ou {erro, codigo?}. `antes`: a guardada (os ids dos links). `P`: os limites do
   plano. Quem voltou ao gratuito com mais links salva sem acrescentar (os que passam ficam fora da pagina). */
export function conferirPagina(d, antes, P = PLANOS_WS.pro) {
  const n = conferirNomeDaPagina(d.nome);
  if (n.erro) return n;
  const exibicao = limparTexto(d.exibicao, LIMITES_LINKS.exibicao);
  if (exibicao.length < 2) return { erro: "diga o nome de exibição (aparece no topo da página)" };
  const frase = limparTexto(d.frase, LIMITES_LINKS.frase);
  const f = conferirFoto(d.foto);
  if (f.erro) return f;
  const brutos = Array.isArray(d.links) ? d.links : [];
  if (brutos.length > LIMITES_LINKS.links) return { erro: "no máximo " + LIMITES_LINKS.links + " links por página" };
  const tinha = ((antes && antes.links) || []).length;
  if (brutos.length > P.links_por_pagina && brutos.length > tinha) {
    return { codigo: "limite_do_plano", erro: "no plano " + (P.id === "pro" ? "Pro" : "gratuito") + ", cada página tem até " + P.links_por_pagina + " links" };
  }
  const ids = new Set(((antes && antes.links) || []).map((x) => x.id));
  const links = [];
  for (const x of brutos) {
    const c = conferirLink(x, ids);
    if (c.erro) return c;
    if (links.some((y) => y.id === c.link.id)) c.link.id = "l" + sorteio(3);
    links.push(c.link);
  }
  const formulario = /^f-[a-z0-9]{12}$/.test(String(d.formulario || "")) ? String(d.formulario) : "";
  return { pagina: { nome: n.nome, exibicao, frase, foto: f.foto, links, email_atos: d.email_atos === true, formulario } };
}

// ------------------------------------------------------------------ o objeto (worker/workspace-dados.js)

async function paginasDe(s) {
  return [...(await s.list({ prefix: "lk:pag:" })).values()].sort((a, b) => String(a.criado).localeCompare(String(b.criado)) || String(a.nome).localeCompare(String(b.nome)));
}
async function paginasNoPlano(s, max) {
  return dentroDoPlano((await paginasDe(s)).map((p) => p.nome), max);
}
async function soltarFormulario(s, nome, manter) {
  for (const [k, f] of await s.list({ prefix: "form:" })) {
    if (f.pagina === nome && f.id !== manter) { f.pagina = ""; await s.put(k, f); }
  }
}

export const OPS_LINKS = {
  async lk_lista(o, d) {
    const s = o.ctx.storage;
    const l = await paginasDe(s);
    const cabem = dentroDoPlano(l.map((p) => p.nome), Number(d.max_paginas) || LIMITES_LINKS.paginas);
    const forms = [...(await s.list({ prefix: "form:" })).values()].map((f) => ({ id: f.id, nome: f.nome, ativo: f.ativo !== false, bloqueado: Boolean(f.bloqueado), pagina: f.pagina || "" }));
    return { ok: true, paginas: l.map((p) => ({ ...p, fora_do_plano: !cabem.has(p.nome) })), formularios: forms };
  },
  async lk_salvar(o, d, agora) {
    const s = o.ctx.storage;
    const p = d.pagina;
    const antes = await s.get("lk:pag:" + p.nome);
    if (antes && antes.bloqueado) return { ok: false, status: 403, erro: "a Atos tirou esta página do ar" + (antes.bloqueado.motivo ? " (" + antes.bloqueado.motivo + ")" : "") + ": escreva para contato@atos.dev.br" };
    if (!antes && (await paginasDe(s)).length >= Number(d.max_paginas)) {
      return { ok: false, status: 409, codigo: "limite_do_plano", erro: "no seu plano, cada conta tem até " + d.max_paginas + (Number(d.max_paginas) === 1 ? " página de links" : " páginas de links") };
    }
    if (antes && !(await paginasNoPlano(s, Number(d.max_paginas))).has(p.nome)) {
      return { ok: false, status: 409, codigo: "limite_do_plano", erro: "esta página está fora do plano (fora do ar): apague outra ou volte ao Pro para mudá-la" };
    }
    if (!(await o.contar("lkmud", 3600, agora, LIMITES_LINKS.mudancas_hora))) return { ok: false, status: 429, erro: "muitas mudanças na última hora: espere um pouco" };
    // O formulario escolhido precisa ser desta conta (e nao desligado pela Atos).
    if (p.formulario) {
      const f = await s.get("form:" + p.formulario);
      if (!f) return { ok: false, status: 400, erro: "esse formulário não existe nesta conta" };
      if (f.bloqueado) return { ok: false, status: 400, erro: "a Atos desligou esse formulário: escolha outro" };
      if (f.pagina && f.pagina !== p.nome) return { ok: false, status: 409, erro: "esse formulário já está na página @" + f.pagina + ": um formulário vai em uma página só" };
      f.pagina = p.nome;
      await s.put("form:" + f.id, f);
    }
    await soltarFormulario(s, p.nome, p.formulario);
    const pagina = { ...p, criado: (antes && antes.criado) || isoDe(agora), mudado: antes ? isoDe(agora) : null, bloqueado: null };
    await s.put("lk:pag:" + p.nome, pagina);
    return { ok: true, pagina, nova: !antes };
  },
  async lk_apagar(o, d) {
    const s = o.ctx.storage;
    const antes = await s.get("lk:pag:" + d.nome);
    if (!antes) return { ok: false, status: 404, erro: "essa página não existe nesta conta" };
    await s.delete("lk:pag:" + d.nome);
    await apagarPrefixo(s, "lk:clk:" + d.nome + "|");
    await soltarFormulario(s, d.nome, "");
    return { ok: true };
  },
  async lk_bloqueio(o, d) {
    const s = o.ctx.storage;
    const p = await s.get("lk:pag:" + d.nome);
    if (!p) return { ok: false, status: 404, erro: "essa página não existe (mais)" };
    p.bloqueado = d.bloqueado || null;
    await s.put("lk:pag:" + d.nome, p);
    return { ok: true, pagina: p };
  },
  /* O que a pagina publica mostra: so a pagina dentro do plano, os links ligados dentro do plano, e o formulario se ele
     entrega (ligado, nao desligado pela Atos e dentro do plano). null se a pagina nao vai ao ar. */
  async lk_publico(o, d) {
    const s = o.ctx.storage;
    const p = await s.get("lk:pag:" + d.nome);
    if (!p) return { ok: true, pagina: null };
    if (p.bloqueado) return { ok: true, pagina: null, motivo: "bloqueada" };
    if (!(await paginasNoPlano(s, Number(d.max_paginas))).has(p.nome)) return { ok: true, pagina: null, motivo: "fora_do_plano" };
    const links = p.links.slice(0, Number(d.max_links)).filter((x) => x.ativo !== false);
    let formulario = null;
    if (p.formulario) {
      const f = await s.get("form:" + p.formulario);
      const forms = [...(await s.list({ prefix: "form:" })).values()].sort((a, b) => String(a.criado).localeCompare(String(b.criado)) || String(a.id).localeCompare(String(b.id)));
      const noPlano = forms.slice(0, Number(d.max_forms)).some((x) => x.id === p.formulario);
      if (f && f.ativo !== false && !f.bloqueado && f.pagina === p.nome && noPlano) formulario = { id: f.id, nome: f.nome, campos: f.campos || [], livres: f.livres || [], turnstile: Boolean(f.turnstile) };
    }
    return { ok: true, pagina: { nome: p.nome, exibicao: p.exibicao, frase: p.frase, foto: p.foto, links, email_atos: p.email_atos, formulario } };
  },
  async lk_clique(o, d, agora) {
    const s = o.ctx.storage;
    const k = "lk:clk:" + d.nome + "|" + diaDe(agora);
    const x = (await s.get(k)) || {};
    // Um teto por pagina por dia (um robo nao enche o objeto); passou, para de contar.
    const total = Object.values(x).reduce((a, b) => a + b, 0);
    if (total >= 200000) return { ok: true, contado: false };
    x[d.lid] = (x[d.lid] || 0) + 1;
    await s.put(k, x);
    await o.marcarLimpeza(agora);
    return { ok: true, contado: true };
  },
  async lk_cliques(o, d, agora) {
    const s = o.ctx.storage;
    const dias = Math.min(Number(d.dias) || 90, LIMITES_LINKS.cliques_dias);
    const desde = diaDe(agora - (dias - 1) * DIA_S * 1000);
    const porDia = [];
    const porLink = {};
    for (const [k, x] of await s.list({ prefix: "lk:clk:" + d.nome + "|" })) {
      const dia = k.split("|")[1];
      if (dia < desde) continue;
      let n = 0;
      for (const [lid, c] of Object.entries(x)) { n += c; porLink[lid] = (porLink[lid] || 0) + c; }
      porDia.push({ dia, n });
    }
    return { ok: true, dias, por_dia: porDia, por_link: porLink, total: porDia.reduce((a, b) => a + b.n, 0) };
  },

  // ---- o indice
  async lpag_reservar(o, d, agora) {
    const s = o.ctx.storage;
    const x = await s.get("lpag:" + d.nome);
    if (x && x.sub !== d.sub) return { ok: false };
    await s.put("lpag:" + d.nome, { sub: d.sub, conta: d.conta || "", criado: (x && x.criado) || isoDe(agora), bloqueado: (x && x.bloqueado) || null });
    return { ok: true };
  },
  async lpag_soltar(o, d) {
    const s = o.ctx.storage;
    const x = await s.get("lpag:" + d.nome);
    if (x && (!d.sub || x.sub === d.sub)) await s.delete("lpag:" + d.nome);
    return { ok: true };
  },
  async lpag_dono(o, d) {
    return { ok: true, dono: (await o.ctx.storage.get("lpag:" + d.nome)) || null };
  },
  async lpag_bloqueio(o, d) {
    const s = o.ctx.storage;
    const x = await s.get("lpag:" + d.nome);
    if (!x) return { ok: false, status: 404, erro: "essa página não existe (mais)" };
    x.bloqueado = d.bloqueado || null;
    await s.put("lpag:" + d.nome, x);
    return { ok: true, linha: x };
  },
  /* Uma denuncia: no maximo LIMITES_LINKS.denuncias_pagina_dia por pagina e denuncias_dia na Atos inteira, por dia. */
  async lden_anotar(o, d, agora) {
    const s = o.ctx.storage;
    const dia = diaDe(agora);
    if (!(await o.contar("lden:" + d.nome + ":" + dia, 2 * DIA_S, agora, LIMITES_LINKS.denuncias_pagina_dia))) return { ok: false, motivo: "limite" };
    if (!(await o.contar("lden-atos:" + dia, 2 * DIA_S, agora, LIMITES_LINKS.denuncias_dia))) return { ok: false, motivo: "limite" };
    const quando = isoDe(agora);
    const id = "d" + sorteio(5);
    await s.put("lden:" + quando + "|" + id, { id, nome: d.nome, sub: d.sub || "", motivo: String(d.motivo || ""), texto: String(d.texto || ""), quando, estado: "aberta", resolvida: null });
    return { ok: true, id };
  },
  async lden_resolver(o, d, agora) {
    const s = o.ctx.storage;
    for (const [k, x] of await s.list({ prefix: "lden:" })) {
      if (x.id !== d.id) continue;
      if (x.estado === "resolvida") return { ok: true, denuncia: x, repetido: true };
      x.estado = "resolvida";
      x.resolvida = { quando: isoDe(agora), por: String(d.por || ""), nota: String(d.nota || "").slice(0, 200) };
      await s.put(k, x);
      return { ok: true, denuncia: x };
    }
    return { ok: false, status: 404, erro: "essa denúncia não existe (mais)" };
  },
  async lpag_painel(o) {
    const s = o.ctx.storage;
    const denuncias = [...(await s.list({ prefix: "lden:", reverse: true, limit: 500 })).values()];
    const abertas = {};
    for (const x of denuncias) if (x.estado === "aberta") abertas[x.nome] = (abertas[x.nome] || 0) + 1;
    const paginas = [];
    for (const [k, x] of await s.list({ prefix: "lpag:" })) paginas.push({ nome: k.slice(5), ...x, denuncias_abertas: abertas[k.slice(5)] || 0 });
    return { ok: true, paginas, denuncias };
  },
};

export async function limparLinks(o, agora) {
  const s = o.ctx.storage;
  let n = 0;
  const dia = diaDe(agora - LIMITES_LINKS.cliques_dias * DIA_S * 1000);
  const velhas = [];
  for (const [k] of await s.list({ prefix: "lk:clk:" })) if (k.split("|")[1] < dia) velhas.push(k);
  for (let i = 0; i < velhas.length; i += 128) await s.delete(velhas.slice(i, i + 128));
  n += velhas.length;
  // As denuncias (no indice): um ano.
  n += await apagarAntigos(s, "lden:", isoDe(agora - 365 * DIA_S * 1000));
  return n;
}

// ------------------------------------------------------------------ as rotas do dono

export function ehRotaDosLinks(url) {
  return url.pathname === "/api/workspace/links";
}

const FORA = () => json({ erro: "não deu para falar com o registro do Workspace agora: tente de novo em instantes" }, 503);

function vistaDaPagina(p) {
  return {
    nome: p.nome, exibicao: p.exibicao, frase: p.frase || "", foto: p.foto || "", links: p.links || [], email_atos: Boolean(p.email_atos), formulario: p.formulario || "",
    criado: p.criado || null, mudado: p.mudado || null, bloqueado: p.bloqueado ? { quando: p.bloqueado.quando, motivo: p.bloqueado.motivo || "" } : null,
    fora_do_plano: Boolean(p.fora_do_plano),
  };
}

/* O e-mail Atos da conta que pode virar botao (o destino confirmado e ligado), ou "". */
async function emailDaConta(env, sub) {
  try {
    const d = await destinoDoTitular(env, sub);
    return d.pronto ? d.endereco : "";
  } catch {
    return "";
  }
}

/* Apaga a copia da pagina do cache da Cloudflare (o datacentro de quem mudou; nos outros, ate 60 s). */
async function esquecerDoCache(url, nome, deps = {}) {
  const cache = deps.cache === undefined ? (typeof caches !== "undefined" ? caches.default : null) : deps.cache;
  if (!cache) return;
  try { await cache.delete(new Request(url.origin + "/@" + nome)); } catch { /* o cache vence sozinho */ }
}

export async function atenderLinks(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  if (!env.WS_DADOS) return json({ erro: "a página de links ainda não está ligada neste Worker" }, 503);
  const porta = await portaoDoWorkspace(request, env, { alias: "se_tiver" });
  if (porta.resposta) return porta.resposta;
  const { sessao, plano } = porta;
  const P = plano.limites;
  const conta = daConta(env, sessao.sub);
  const indice = doIndice(env);
  const recente = agora / 1000 - sessao.auth_time < RECENTE_S;
  const tela = async (extra = {}) => {
    const r = await conta.pedir("lk_lista", { agora, max_paginas: P.links_paginas });
    if (!r || !r.ok) return FORA();
    const paginas = r.paginas.map(vistaDaPagina);
    // A estatistica (so no Pro): os cliques por dia e por link, 90 dias.
    if (P.links_cliques) {
      for (const p of paginas) {
        const c = await conta.pedir("lk_cliques", { agora, nome: p.nome, dias: LIMITES_LINKS.cliques_dias });
        p.cliques = c && c.ok ? { dias: c.dias, por_dia: c.por_dia, por_link: c.por_link, total: c.total } : null;
      }
    }
    return json({
      paginas, formularios: r.formularios, email_atos: await emailDaConta(env, sessao.sub), plano: vistaDoPlano(plano),
      limites: { ...LIMITES_LINKS, paginas: P.links_paginas, links: P.links_por_pagina, cliques: P.links_cliques }, recente, base: url.origin + "/@", ...extra,
    });
  };
  try {
    if (request.method === "GET") return await tela();
    if (request.method !== "POST") return json({ erro: "use POST" }, 405);
    if (!recente) return json({ erro: "para mudar a página de links, entre de novo (o login precisa ser das últimas " + LIMITES_LINKS.recente_h + " horas)", reentrar: true }, 401);
    const d = await lerJson(request);
    if (!d || typeof d !== "object" || Array.isArray(d)) return json({ erro: "pedido inválido" }, 400);

    if (d.acao === "apagar") {
      const nome = String(d.nome || "").trim().toLowerCase().replace(/^@/, "");
      if (!NOME.test(nome)) return json({ erro: "qual página?" }, 400);
      if (d.confirmar !== true) return json({ erro: "confirme na página: ela sai do ar, a estatística é apagada e o nome fica livre" }, 400);
      const r = await conta.pedir("lk_apagar", { nome });
      if (!r || !r.ok) return json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
      await indice.pedir("lpag_soltar", { nome, sub: sessao.sub });
      await esquecerDoCache(url, nome, deps);
      return await tela({ apagada: nome });
    }
    if (d.acao !== "salvar") return json({ erro: "o que fazer? (salvar ou apagar)" }, 400);
    const lista = await conta.pedir("lk_lista", { agora, max_paginas: P.links_paginas });
    if (!lista || !lista.ok) return FORA();
    const nomeBruto = String(d.nome || "").trim().toLowerCase().replace(/^@/, "");
    const antes = lista.paginas.find((p) => p.nome === nomeBruto) || null;
    const c = conferirPagina(d, antes, P);
    if (c.erro) return c.codigo ? limiteDoPlano(c.erro, plano) : json({ erro: c.erro }, 400);
    if (!antes && lista.paginas.length >= P.links_paginas) {
      return limiteDoPlano("no plano " + (plano.pro ? "Pro" : "gratuito") + ", cada conta tem até " + P.links_paginas + (P.links_paginas === 1 ? " página de links" : " páginas de links"), plano);
    }
    if (c.pagina.email_atos && !(await emailDaConta(env, sessao.sub))) return json({ erro: "o botão do e-mail Atos pede o seu e-mail Atos com o destino confirmado e ligado" }, 400);
    if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return json({ erro: "muitos pedidos seguidos: espere um pouco" }, 429);
    if (!antes) {
      // O nome nao pode ser o e-mail Atos de outra pessoa (nem um que esta na quarentena de 30 dias de alguem).
      if (env.EMAIL_ATOS) {
        const l = await registro(env).pedir("livre", { alias: c.pagina.nome, sub: sessao.sub, agora });
        if (!l || !l.ok) return FORA();
        if (!l.livre) return json({ erro: "esse nome é o e-mail Atos de outra pessoa: escolha outro" }, 409);
      }
      const res = await indice.pedir("lpag_reservar", { agora, nome: c.pagina.nome, sub: sessao.sub, conta: sessao.email });
      if (!res || !res.ok) return json({ erro: "esse nome já é de outra página: escolha outro" }, 409);
    }
    const r = await conta.pedir("lk_salvar", { agora, pagina: c.pagina, max_paginas: P.links_paginas });
    if (!r || !r.ok) {
      if (!antes) await indice.pedir("lpag_soltar", { nome: c.pagina.nome, sub: sessao.sub });
      return r && r.codigo === "limite_do_plano" ? limiteDoPlano(r.erro, plano) : json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
    }
    await esquecerDoCache(url, c.pagina.nome, deps);
    return await tela({ salvo: c.pagina.nome });
  } catch {
    return FORA();
  }
}

// ------------------------------------------------------------------ as paginas publicas

/* Tudo o que comeca com /@ e daqui (o caminho que nao existe responde a pagina de "nao disponivel"). */
export function ehRotaDaPaginaDeLinks(url) {
  return url.pathname.startsWith("/@");
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CSP_LINKS = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function cabecalhos(extra = {}) {
  return {
    "content-type": "text/html; charset=utf-8", "content-security-policy": CSP_LINKS, "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=31536000", ...extra,
  };
}

const RODAPE = (nome) => '<footer class="lk-pe"><p>Página criada por uma pessoa com Conta Atos. A Atos não verificou estes links.</p>' +
  '<p><a href="/@' + esc(nome) + '/denunciar">Denunciar esta página</a> · <a href="/integracao/#links">O que é</a> · <a href="/privacidade/">Privacidade</a></p></footer>';

function documento({ titulo, corpo, status = 200, cache = "no-store", robots = "" }) {
  const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    (robots ? '<meta name="robots" content="' + robots + '">' : "") +
    "<title>" + esc(titulo) + '</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">' +
    '<link rel="stylesheet" href="/assets/conta.css"><link rel="stylesheet" href="/assets/publico.css"><link rel="stylesheet" href="/assets/links.css"></head><body>' +
    corpo + "</body></html>";
  return new Response(html, { status, headers: cabecalhos({ "cache-control": cache }) });
}

function indisponivel(status = 404, texto = "Não há uma página de links com este endereço.") {
  return documento({
    titulo: "Página de links não encontrada · Atos", status, cache: "public, max-age=60", robots: "noindex",
    corpo: '<main class="pub"><p class="pub-marca">Atos</p><h1>Página não disponível</h1><p class="pub-texto">' + esc(texto) + "</p></main>",
  });
}

/* O dominio que aparece embaixo do link (sem www.). */
function dominioDe(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function paginaHtml(p, pro, contatoAtivo) {
  const inicial = esc(String(p.exibicao || "?").trim().charAt(0).toUpperCase());
  const foto = p.foto ? '<img class="lk-foto" src="' + esc(p.foto) + '" alt="" width="96" height="96">' : '<span class="lk-foto lk-inicial" aria-hidden="true">' + inicial + "</span>";
  const itens = p.links.map((x) => {
    // No Pro o link passa pelo redirecionamento contado; no gratuito, direto ao destino.
    const href = pro ? "/@" + p.nome + "/ir/" + x.id : x.url;
    return '<li><a class="lk-link" href="' + esc(href) + '" rel="noopener nofollow ugc"><span class="lk-titulo">' + esc(x.titulo) + '</span><span class="lk-dominio">' + esc(dominioDe(x.url)) + "</span></a></li>";
  });
  if (p.email) itens.push('<li><a class="lk-link lk-proprio" href="mailto:' + esc(p.email) + '"><span class="lk-titulo">E-mail</span><span class="lk-dominio">' + esc(p.email) + "</span></a></li>");
  if (contatoAtivo) itens.push('<li><a class="lk-link lk-proprio" href="/@' + esc(p.nome) + '/contato"><span class="lk-titulo">' + esc(p.formulario.nome || "Mande uma mensagem") + '</span><span class="lk-dominio">formulário na atos.dev.br</span></a></li>');
  const corpo = '<main class="lk"><header class="lk-topo">' + foto + "<h1>" + esc(p.exibicao) + "</h1>" + (p.frase ? '<p class="lk-frase">' + esc(p.frase) + "</p>" : "") + "</header>" +
    (itens.length ? '<ul class="lk-lista">' + itens.join("") + "</ul>" : '<p class="lk-vazio">Nenhum link ainda.</p>') + RODAPE(p.nome) + "</main>";
  return documento({ titulo: p.exibicao + " · @" + p.nome, corpo, cache: "public, max-age=60" });
}

/* A pagina publica (ou null) e o dono: o indice, o Workspace do dono (ativo, sem suspensao) e o plano dele. */
async function acharPagina(env, nome, agora) {
  const x = await doIndice(env).pedir("lpag_dono", { nome });
  if (!x || !x.ok || !x.dono || x.dono.bloqueado) return { pagina: null, motivo: x && x.dono && x.dono.bloqueado ? "bloqueada" : "inexistente" };
  const w = await workspaceDe(env, x.dono.sub);
  if (!w || !w.ativo || w.suspenso) return { pagina: null, motivo: "workspace" };
  const plano = planoDe(w, agora);
  const P = plano.limites;
  const r = await daConta(env, x.dono.sub).pedir("lk_publico", { nome, max_paginas: P.links_paginas, max_links: P.links_por_pagina, max_forms: P.formularios });
  if (!r || !r.ok) throw new Error("o objeto da conta não respondeu");
  return { pagina: r.pagina, motivo: r.motivo || "", dono: x.dono, plano };
}

export async function atenderPaginaDeLinks(request, env, url, deps = {}) {
  const agora = (deps.agora || Date.now)();
  const partes = url.pathname.replace(/\/$/, "").split("/");
  const nome = decodeURIComponent(partes[1] || "").slice(1).toLowerCase();
  const sub = partes[2] || "";
  if (!NOME.test(nome) || !env.WS_DADOS) return indisponivel();
  const conhecido = (sub === "" && partes.length === 2) || ((sub === "contato" || sub === "denunciar") && partes.length === 3) || (sub === "ir" && partes.length === 4);
  if (!conhecido) return indisponivel();
  if (sub === "denunciar") return atenderDenuncia(request, env, url, nome, agora, deps);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET" } });

  if (sub === "ir") {
    // O redirecionamento contado: so um link da propria pagina, ligado e dentro do plano. Nunca um destino de fora dela.
    const lid = partes[3] || "";
    if (!LID.test(lid)) return indisponivel();
    let a;
    try { a = await acharPagina(env, nome, agora); } catch { return indisponivel(503, "Não deu para abrir agora: tente de novo em instantes."); }
    const link = a.pagina && a.pagina.links.find((x) => x.id === lid);
    if (!link) return indisponivel();
    if (a.plano.limites.links_cliques && request.method === "GET") {
      try { await daConta(env, a.dono.sub).pedir("lk_clique", { agora, nome, lid }); } catch { /* o clique e o segundo lugar */ }
    }
    return new Response(null, { status: 302, headers: { location: link.url, "cache-control": "no-store", "referrer-policy": "strict-origin-when-cross-origin", "x-content-type-options": "nosniff" } });
  }

  if (sub === "contato") {
    let a;
    try { a = await acharPagina(env, nome, agora); } catch { return indisponivel(503, "Não deu para abrir agora: tente de novo em instantes."); }
    if (!a.pagina || !a.pagina.formulario) return indisponivel(404, "Esta página não tem um formulário de contato.");
    return paginaDeContato(a.pagina);
  }

  // A pagina: 60 s no cache da Cloudflare (a mesma para todos).
  const cache = deps.cache === undefined ? (typeof caches !== "undefined" ? caches.default : null) : deps.cache;
  const chave = new Request(url.origin + "/@" + nome);
  if (cache) { const c = await cache.match(chave); if (c) return c; }
  let a;
  try { a = await acharPagina(env, nome, agora); } catch { return indisponivel(503, "Não deu para abrir agora: tente de novo em instantes."); }
  if (!a.pagina) {
    if (a.motivo === "bloqueada") return indisponivel(410, "A Atos tirou esta página do ar.");
    if (a.motivo === "fora_do_plano" || a.motivo === "workspace") return indisponivel(404, "Esta página não está no ar agora.");
    return indisponivel();
  }
  const p = { ...a.pagina, email: "" };
  if (p.email_atos) p.email = await emailDaConta(env, a.dono.sub);
  const resp = paginaHtml(p, a.plano.limites.links_cliques, Boolean(p.formulario));
  if (cache) await cache.put(chave, resp.clone());
  return resp;
}

const NOMES_CAMPO = { nome: "Nome", email: "E-mail", assunto: "Assunto", mensagem: "Mensagem" };

/* O formulario da pessoa, numa pagina da Atos (sem script), enviado a /f/<id> (worker/formularios.js aceita a Atos como
   origem do formulario que esta numa pagina de links). */
function paginaDeContato(p) {
  const f = p.formulario;
  const campo = (k, livre) => {
    const rot = esc(NOMES_CAMPO[k] || k);
    if (k === "mensagem") return '<label class="campo"><span class="rotulo">' + rot + '</span><textarea name="mensagem" rows="6" maxlength="5000" required></textarea></label>';
    const tipo = k === "email" ? "email" : "text";
    return '<label class="campo"><span class="rotulo">' + rot + '</span><input name="' + esc(k) + '" type="' + tipo + '" maxlength="' + (livre ? 1000 : k === "email" ? 254 : 200) + '"' + (k === "email" ? ' autocomplete="email"' : k === "nome" ? ' autocomplete="name"' : "") + "></label>";
  };
  const corpo = '<main class="lk"><header class="lk-topo"><h1>' + esc(f.nome || "Mande uma mensagem") + '</h1><p class="lk-frase">Para ' + esc(p.exibicao) + " (@" + esc(p.nome) + ")</p></header>" +
    '<form class="lk-form" method="post" action="/f/' + esc(f.id) + '">' + f.campos.map((k) => campo(k, false)).join("") + f.livres.map((k) => campo(k, true)).join("") +
    '<label class="lk-armadilha" aria-hidden="true">Não preencha<input name="_armadilha" tabindex="-1" autocomplete="off"></label>' +
    '<button type="submit" class="btn primario">Enviar</button>' +
    '<p class="dica">A mensagem vai ao e-mail de quem criou esta página. A Atos não guarda o conteúdo.' + (f.turnstile ? " Antes de entregar, a Atos pede a confirmação de que você não é um robô." : "") + "</p></form>" +
    '<p><a href="/@' + esc(p.nome) + '">Voltar à página</a></p>' + RODAPE(p.nome) + "</main>";
  return documento({ titulo: (f.nome || "Contato") + " · @" + p.nome, corpo, robots: "noindex" });
}

// ------------------------------------------------------------------ a denuncia

const MOTIVOS = {
  golpe: "Golpe ou roubo de senha (phishing)",
  passar_por: "Se passa por outra pessoa, empresa ou pela Atos",
  ilegal: "Conteúdo ilegal",
  spam: "Spam ou propaganda enganosa",
  outro: "Outro motivo",
};

function paginaDeDenuncia(nome, { erro = "", feito = false, status = 200 } = {}) {
  if (feito) {
    return documento({
      titulo: "Denúncia recebida · Atos", status, robots: "noindex",
      corpo: '<main class="pub"><p class="pub-marca">Atos</p><h1>Denúncia recebida</h1><p class="pub-texto">Obrigado. A equipe da Atos vai olhar a página @' + esc(nome) +
        ". A Atos não guarda quem denunciou nem o seu endereço de internet, por isso não há resposta: se a página sair do ar, é porque a denúncia procedeu.</p>" +
        '<p><a class="btn" href="/">Ir à Atos</a></p></main>',
    });
  }
  const opcoes = Object.entries(MOTIVOS).map(([k, v]) => '<label class="lk-opcao"><input type="radio" name="motivo" value="' + k + '"' + (k === "golpe" ? " required" : "") + "><span>" + esc(v) + "</span></label>").join("");
  return documento({
    titulo: "Denunciar @" + nome + " · Atos", status, robots: "noindex",
    corpo: '<main class="pub"><p class="pub-marca">Atos</p><h1>Denunciar a página @' + esc(nome) + '</h1><p class="pub-texto">A denúncia chega à equipe da Atos. Ela não guarda quem denunciou nem o seu endereço de internet.</p>' +
      (erro ? '<p class="erro" role="alert">' + esc(erro) + "</p>" : "") +
      '<form class="pub-form" method="post" action="/@' + esc(nome) + '/denunciar"><fieldset class="lk-motivos"><legend class="rotulo">O que há de errado?</legend>' + opcoes + "</fieldset>" +
      '<label class="campo lk-largo"><span class="rotulo">Conte o que viu (opcional, até ' + LIMITES_LINKS.denuncia_texto + ' caracteres; não escreva dados pessoais seus)</span><textarea name="texto" rows="4" maxlength="' + LIMITES_LINKS.denuncia_texto + '"></textarea></label>' +
      '<label class="lk-armadilha" aria-hidden="true">Não preencha<input name="_armadilha" tabindex="-1" autocomplete="off"></label>' +
      '<button type="submit" class="btn primario">Enviar a denúncia</button></form>' +
      '<p class="nota pub-pe">Se você caiu num golpe, procure também o seu banco e a polícia. <a href="/@' + esc(nome) + '">Voltar à página</a> · <a href="/privacidade/">Privacidade</a></p></main>',
  });
}

async function atenderDenuncia(request, env, url, nome, agora, deps) {
  const indice = doIndice(env);
  let x;
  try { x = await indice.pedir("lpag_dono", { nome }); } catch { return indisponivel(503, "Não deu para abrir agora: tente de novo em instantes."); }
  if (!x || !x.ok || !x.dono) return indisponivel();
  if (request.method === "GET" || request.method === "HEAD") return paginaDeDenuncia(nome);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  // So da propria pagina da Atos (o navegador manda Origin num POST de formulario).
  if (request.headers.get("origin") !== url.origin) return paginaDeDenuncia(nome, { erro: "Envie pela página de denúncia da Atos.", status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 8192) return paginaDeDenuncia(nome, { erro: "A denúncia ficou grande demais.", status: 413 });
  if (deps.dentroDoLimite && !(await deps.dentroDoLimite(request, env))) return paginaDeDenuncia(nome, { erro: "Muitos pedidos seguidos: espere um minuto e envie de novo.", status: 429 });
  let f;
  try { f = await request.formData(); } catch { return paginaDeDenuncia(nome, { erro: "A denúncia não chegou: envie de novo.", status: 400 }); }
  // O campo-armadilha: quem o preenche ve o "recebida" e nada fica.
  if (String(f.get("_armadilha") || "").trim()) return paginaDeDenuncia(nome, { feito: true });
  const motivo = String(f.get("motivo") || "");
  if (!MOTIVOS[motivo]) return paginaDeDenuncia(nome, { erro: "Escolha o que há de errado.", status: 400 });
  const texto = String(f.get("texto") || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, LIMITES_LINKS.denuncia_texto);
  let r;
  try { r = await indice.pedir("lden_anotar", { agora, nome, sub: x.dono.sub, motivo, texto }); } catch { return paginaDeDenuncia(nome, { erro: "Não deu para registrar agora: tente de novo em instantes.", status: 503 }); }
  if (!r || !r.ok) return paginaDeDenuncia(nome, { erro: "Esta página já recebeu muitas denúncias hoje; a equipe já foi avisada por elas. Se for urgente, escreva para contato@atos.dev.br.", status: 429 });
  return paginaDeDenuncia(nome, { feito: true });
}

// ------------------------------------------------------------------ o painel da equipe

export const ehRotaDosLinksNoPainel = (p) => p === "/api/admin/workspace/links" || p.startsWith("/api/admin/workspace/links/");
const PODE_AGIR = ["dono", "suporte"];
const limparMotivo = (m) => String(m || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 200);

/* `c`: {quem: {email, papel}, agora} (worker/admin.js). */
export async function atenderLinksNoPainel(request, env, url, c) {
  if (!env.WS_DADOS) return json({ erro: "as páginas de links não estão neste Worker" }, 503);
  const p = url.pathname;
  const indice = doIndice(env);
  const agora = c.agora || Date.now();
  if (p === "/api/admin/workspace/links" && request.method === "GET") {
    const r = await indice.pedir("lpag_painel", {});
    if (!r || !r.ok) throw new Error("o indice não respondeu");
    return json({ paginas: r.paginas.sort((a, b) => String(b.criado || "").localeCompare(String(a.criado || ""))), denuncias: r.denuncias, motivos: MOTIVOS, limites: LIMITES_LINKS });
  }
  let m = p.match(/^\/api\/admin\/workspace\/links\/([a-z0-9-]{3,30})$/);
  if (m && request.method === "GET") {
    const x = await indice.pedir("lpag_dono", { nome: m[1] });
    if (!x || !x.ok || !x.dono) return json({ erro: "essa página não existe (mais)" }, 404);
    const l = await daConta(env, x.dono.sub).pedir("lk_lista", {});
    const pg = l && l.ok ? l.paginas.find((y) => y.nome === m[1]) : null;
    return json({ dono: x.dono, pagina: pg ? { ...vistaDaPagina(pg), foto: pg.foto ? "(com foto)" : "", links: pg.links.map((y) => ({ ...y, dominio: dominioDe(y.url) })) } : null });
  }
  if (request.method !== "POST") return json({ erro: "use GET para ver e POST para mudar" }, 405);
  if (!PODE_AGIR.includes(c.quem.papel)) return json({ erro: "o papel " + c.quem.papel + " não muda as páginas de links" }, 403);
  const d = (await lerJson(request)) || {};
  m = p.match(/^\/api\/admin\/workspace\/links\/denuncias\/(d[0-9a-f]{10})\/resolver$/);
  if (m) {
    const r = await indice.pedir("lden_resolver", { agora, id: m[1], por: c.quem.email, nota: limparMotivo(d.nota) });
    if (!r || !r.ok) return json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
    try {
      await anotarDaEquipe(env, { por: c.quem.email, tipo: "workspace.links.denuncia", sub: r.denuncia.sub, email: "", alvo: r.denuncia.nome, motivo: limparMotivo(d.nota), oque: "resolveu a denúncia " + m[1] + " da página @" + r.denuncia.nome });
    } catch { /* a acao ja valeu */ }
    return json({ ok: true });
  }
  m = p.match(/^\/api\/admin\/workspace\/links\/([a-z0-9-]{3,30})\/(desligar|ligar)$/);
  if (!m) return json({ erro: "rota não existe" }, 404);
  const [, nome, acao] = m;
  const motivo = limparMotivo(d.motivo);
  if (acao === "desligar" && motivo.length < 3) return json({ erro: "diga o motivo (o dono vê)" }, 400);
  const x = await indice.pedir("lpag_dono", { nome });
  if (!x || !x.ok || !x.dono) return json({ erro: "essa página não existe (mais)" }, 404);
  const bloqueado = acao === "desligar" ? { quando: isoDe(agora), motivo, por: c.quem.email } : null;
  const r = await daConta(env, x.dono.sub).pedir("lk_bloqueio", { nome, bloqueado });
  if (!r || !r.ok) return json({ erro: (r && r.erro) || "não deu agora" }, (r && r.status) || 503);
  await indice.pedir("lpag_bloqueio", { nome, bloqueado });
  await esquecerDoCache(url, nome, c.deps || {});
  try {
    await anotarDaEquipe(env, { por: c.quem.email, tipo: "workspace.links." + acao, sub: x.dono.sub, email: normal(x.dono.conta), alvo: "@" + nome, motivo,
      oque: (acao === "desligar" ? "tirou do ar a página de links @" : "ligou de novo a página de links @") + nome });
  } catch { /* a acao ja valeu */ }
  return json({ ok: true });
}
