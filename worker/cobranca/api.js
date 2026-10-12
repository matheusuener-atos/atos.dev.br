// A API da Atos Cobranca (docs/COBRANCA.md): o checkout, as assinaturas, as compras e o aviso do
// Mercado Pago. A pessoa e a da sessao Atos (cookie __Host-atos); o valor e o catalogo (catalogo.js,
// resolveOffer) - o navegador manda so o id do preco e, no cartao, o token de uso unico do MercadoPago.js.
//
//   GET  /api/mp-config                          a chave publica (sem cache)
//   GET  /api/cobranca/v1/catalogo/<produto>     os precos de um produto (publico)
//   GET  /api/cobranca/v1/cliente                os dados fiscais da pessoa
//   POST /api/cobranca/v1/cliente                salva os dados fiscais (uma vez, valem para todo produto)
//   POST /api/cobranca/v1/assinar                a mensalidade no cartao: assinatura (/preapproval, authorized)
//   POST /api/cobranca/v1/pagar                  o ano (cartao ou Pix), o mes no Pix e a recarga (Orders API)
//   GET  /api/cobranca/v1/compras/<ref>          a situacao de uma compra (a tela do Pix consulta ate mudar)
//   GET  /api/cobranca/v1/minhas                 assinaturas, compras e direitos da pessoa (o portal)
//   GET  /api/subscriptions/:id                  uma assinatura, conferida no Mercado Pago (id = a ref)
//   POST /api/subscriptions/:id/(pause|reactivate|cancel)   pausar, reativar, cancelar (a concedida pela equipe, sem
//                                                Mercado Pago: so cancelar, aqui mesmo)
//   POST /api/mp/aviso                           o webhook do Mercado Pago (assinatura HMAC conferida)
//   GET  /api/cobranca/v1/direitos?produto=&sub= o retrato do direito, para o produto (Bearer com o segredo
//                                                dele): a reserva quando um evento se perde (eventos.js)
//
// O aviso nunca e a verdade: o recurso e buscado no Mercado Pago antes de mudar qualquer coisa, e cada
// pagamento estende o direito uma vez so (pela origem). As mudancas de estado ficam no objeto do cliente.

import { json, lerJson } from "../comum.js";
import { sessaoDe } from "../contas.js";
import { carregarCatalogo, catalogoPublico, MOEDA, produtoAberto, produtoDe, resolveOffer, todosOsProdutos, voltaPermitida } from "./catalogo.js";
import { cliente, clienteDaRef, idDoCliente, novaRef } from "./cliente.js";
import { ehAmbienteDeTeste, segredoDoProduto } from "./eventos.js";
import { criarPreapproval, ErroMP, fraseDaRecusa, mpFetch } from "./mp.js";
import { arquivoDaNota, indexarCliente, notasDoCliente, notasDoProduto, porNaFila } from "../nfse/atos.js";

const ACOES = { pause: "paused", reactivate: "authorized", cancel: "cancelled" }; // cancel -> canceled (a API grafa "cancelled")
const PIX_VALIDADE = "P1D";

export function ehRotaDaCobrancaV1(url) {
  const p = url.pathname;
  return p === "/api/mp-config" || p === "/api/mp/aviso" || p.startsWith("/api/cobranca/v1/") || p.startsWith("/api/subscriptions/") || p === "/api/teste/eventos";
}

const erro = (status, frase, codigo) => json({ erro: frase, codigo: codigo || undefined }, status);

/* A chave publica do app no Mercado Pago (var do Worker, nao e segredo). Sem ela, o checkout nao monta. */
function chavePublica(env) {
  const publicKey = String(env.MP_PUBLIC_KEY || "").trim();
  if (!publicKey) throw new Error("MP_PUBLIC_KEY não está configurada no Worker");
  return publicKey;
}

export async function atenderCobrancaV1(request, env, url, deps = {}) {
  const p = url.pathname;
  const buscar = deps.fetch || fetch;
  const op = { buscar, ctx: deps.ctx };
  // Os produtos do Portfolio (worker/portfolio.js) entram no catalogo antes de tudo.
  await carregarCatalogo(env);

  if (p === "/api/mp-config") {
    // A chave publica do app Atos Cobranca. Sem cache: uma pagina guardada nao fica com a chave velha.
    const h = new Headers({ "content-type": "application/json; charset=utf-8" });
    h.set("Cache-Control", "no-store, max-age=0");
    try {
      return new Response(JSON.stringify({ publicKey: chavePublica(env) }), { headers: h });
    } catch (e) {
      return new Response(JSON.stringify({ erro: e.message }), { status: 500, headers: h });
    }
  }

  if (p === "/api/mp/aviso") return receberAviso(request, env, url, deps);

  // As NFS-e de um cliente para o produto (o PAULUS instalado mostra as notas recebidas): o produto pelo segredo
  // dele, como nos direitos, e so as notas dos pagamentos daquele produto. Com Bearer; sem ele, a rota e a da
  // Minha conta (a sessao da pessoa), mais abaixo.
  const mNf = /^\/api\/cobranca\/v1\/notas(?:\/([A-Za-z0-9_.-]{1,64})\/(pdf|xml))?$/.exec(p);
  if (mNf && request.method === "GET" && request.headers.get("authorization")) {
    const produto = url.searchParams.get("produto") || "";
    const segredo = await segredoDoProduto(env, produto);
    const m = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") || "");
    if (!segredo || !m || !iguais(m[1], segredo)) return erro(401, "produto não autenticado");
    const sub = url.searchParams.get("sub") || "";
    if (!sub || sub.length > 200) return erro(400, "falta o sub");
    const cid = await idDoCliente(sub);
    const notas = await notasDoProduto(env, cid, produto);
    if (!mNf[1]) return json({ notas: notas.map(notaPublica) });
    if (!notas.some((n) => n.id === mNf[1])) return erro(404, "essa nota não existe");
    const b64 = await arquivoDaNota(env, cid, mNf[1], mNf[2]);
    if (!b64) return erro(404, "essa nota não tem " + mNf[2].toUpperCase());
    return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: {
      "content-type": mNf[2] === "pdf" ? "application/pdf" : "application/xml; charset=utf-8", "cache-control": "no-store" } });
  }

  if (p === "/api/cobranca/v1/direitos" && request.method === "GET") {
    // So o produto (o segredo dele, o mesmo dos eventos), e so o direito a ele.
    const produto = url.searchParams.get("produto") || "";
    const segredo = await segredoDoProduto(env, produto);
    const m = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") || "");
    if (!segredo || !m || !iguais(m[1], segredo)) return erro(401, "produto não autenticado");
    const sub = url.searchParams.get("sub") || "";
    if (!sub || sub.length > 200) return erro(400, "falta o sub");
    return json({ produto, sub, ...(await cliente(env, await idDoCliente(sub)).pedir("retrato", { produto })).retrato });
  }

  const mCat = /^\/api\/cobranca\/v1\/catalogo\/([a-z0-9-]{1,32})$/.exec(p);
  if (mCat && request.method === "GET") {
    const c = catalogoPublico(mCat[1]);
    // A volta depois de pagar: so as do produto (o ?volta= que nao bater vira o site dele).
    return c ? json({ ...c, aberto: produtoAberto(env, mCat[1]), volta: voltaPermitida(mCat[1], url.searchParams.get("volta") || "") }) : erro(404, "produto desconhecido");
  }

  // Daqui em diante, so com a sessao Atos.
  const s = await sessaoDe(request, env);
  if (!s) return erro(401, "entre na sua conta Atos");
  const cid = await idDoCliente(s.sub);
  const meu = cliente(env, cid, { sub: s.sub, email: s.email });

  try {
    // So no Worker de teste: a fila de eventos desta conta (entregue, pendente ou falhou), para conferir.
    if (p === "/api/teste/eventos" && request.method === "GET") {
      if (!ehAmbienteDeTeste(env)) return erro(404, "rota não existe");
      // Com os registros como estao guardados (a resposta do Mercado Pago na recusa): o teste e para conferir.
      return json({ eventos: (await meu.pedir("eventos")).eventos, registros: await meu.pedir("listar") });
    }
    if (p === "/api/cobranca/v1/cliente") {
      if (request.method === "GET") return json({ perfil: (await meu.pedir("perfil_ler")).perfil });
      const d = (await lerJson(request)) || {};
      const perfil = conferirPerfil(d, s.email);
      if (perfil.erro) return erro(400, perfil.erro);
      const salvo = (await meu.pedir("perfil_salvar", { perfil })).perfil;
      // O indice dos clientes da NFS-e (nfse/atos.js): o painel lista os tomadores sem varrer os objetos.
      await emSegundoPlano(op, indexarCliente(env, cid, salvo));
      return json({ perfil: salvo });
    }

    if (p === "/api/cobranca/v1/conta" && request.method === "GET") {
      // As notas nao seguram a Minha conta: sem elas (o KV fora), a conta abre do mesmo jeito.
      const notas = await notasDoCliente(env, cid).catch(() => []);
      return json({ ...(await minhaConta(meu)), notas: notas.map(notaPublica) });
    }
    // O PDF ou o XML de uma NFS-e entregue a esta conta (nfse/atos.js, guardarNotaDoCliente): so a propria.
    const arq = /^\/api\/cobranca\/v1\/notas\/([A-Za-z0-9_.-]{1,64})\/(pdf|xml)$/.exec(p);
    if (arq && request.method === "GET") {
      const b64 = await arquivoDaNota(env, cid, arq[1], arq[2]);
      if (!b64) return erro(404, "essa nota não está na sua conta");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const nome = "NFS-e " + arq[1].replace(/^nfse-/, "") + "." + arq[2];
      return new Response(bytes, { headers: {
        "content-type": arq[2] === "pdf" ? "application/pdf" : "application/xml; charset=utf-8",
        "content-disposition": (url.searchParams.has("baixar") || arq[2] === "xml" ? "attachment" : "inline") + '; filename="' + nome + '"',
        "cache-control": "private, no-store", "x-content-type-options": "nosniff",
      } });
    }

    if (p === "/api/cobranca/v1/minhas") {
      const l = await meu.pedir("listar");
      const dir = await meu.pedir("direitos");
      return json({ assinaturas: l.assinatura.map(publicaAssinatura), compras: l.compra.map(publicaCompra), direitos: dir.direitos });
    }

    if (p === "/api/cobranca/v1/assinar" && request.method === "POST") return await assinar(request, env, s, cid, meu, op);
    if (p === "/api/cobranca/v1/pagar" && request.method === "POST") return await pagar(request, env, s, cid, meu, op);

    const mCompra = /^\/api\/cobranca\/v1\/compras\/(atos-[0-9a-f]{32}-compra-[0-9a-f]{16})$/.exec(p);
    if (mCompra && request.method === "GET") {
      const r = await meu.pedir("ler", { tipo: "compra", ref: mCompra[1] });
      if (!r.ok) return erro(404, "compra não encontrada");
      let compra = r.registro;
      // Pix esperando: confere no Mercado Pago (se o aviso atrasar, a tela nao fica parada).
      if (compra.mp_id && ["aguardando", "processando"].includes(compra.status)) {
        const o = await mpFetch(env, "GET", "/v1/orders/" + encodeURIComponent(compra.mp_id), undefined, op);
        if (o.ok) compra = (await aplicarOrder(env, o.dados, op)) || compra;
      }
      return json(publicaCompra(compra));
    }

    // GET /api/subscriptions/:id - a assinatura, conferida no Mercado Pago (o id e a ref da Atos).
    const mSub = /^\/api\/subscriptions\/(atos-[0-9a-f]{32}-assinatura-[0-9a-f]{16})(?:\/(pause|reactivate|cancel))?$/.exec(p);
    if (mSub) {
      const r = await meu.pedir("ler", { tipo: "assinatura", ref: mSub[1] });
      // A concedida pela equipe (R$ 0,00, sem Mercado Pago): ver e cancelar aqui mesmo; pausar nao (nada e cobrado).
      if (r.ok && r.registro.concedida) {
        if (request.method === "GET" && !mSub[2]) return json(publicaAssinatura(r.registro));
        if (request.method === "POST" && mSub[2] === "cancel") {
          const e = await meu.pedir("encerrar_concedida", { ref: mSub[1], por: s.email, motivo: "cancelada pela própria pessoa" });
          return e.ok ? json(publicaAssinatura(e.registro)) : erro(e.status || 409, e.erro);
        }
        if (request.method === "POST") return erro(409, "a assinatura concedida pela equipe não é cobrada, então não pausa: cancele se não quiser mais", "concedida");
      }
      if (!r.ok || !r.registro.mp_id) return erro(404, "assinatura não encontrada");
      const a = r.registro;
      if (request.method === "GET" && !mSub[2]) {
        const g = await mpFetch(env, "GET", "/preapproval/" + encodeURIComponent(a.mp_id), undefined, op);
        const atual = g.ok ? (await aplicarPreapproval(env, g.dados)) || a : a;
        return json(publicaAssinatura(atual));
      }
      if (request.method === "POST" && mSub[2]) {
        // So estas tres acoes (ACOES): o navegador nunca escolhe o estado.
        const status = ACOES[mSub[2]];
        const u = await mpFetch(env, "PUT", "/preapproval/" + encodeURIComponent(a.mp_id), { status }, op);
        if (!u.ok) return erro(502, "o Mercado Pago não aceitou a mudança agora: tente de novo");
        const atual = (await aplicarPreapproval(env, u.dados)) || a;
        return json(publicaAssinatura(atual));
      }
    }
  } catch (e) {
    if (e instanceof ErroMP) return erro(e.status, e.message, e.codigo);
    throw e;
  }
  return erro(404, "rota não existe");
}

// ------------------------------------------------------------------ cliente

const soDigitos = (v) => String(v || "").replace(/\D/g, "");

export function cpfValido(c) {
  c = soDigitos(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export function cnpjValido(c) {
  c = soDigitos(c);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (n) => { const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = pesos.reduce((t, p, i) => t + p * Number(c[i]), 0); const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

const limpo = (v, n) => String(v || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

/* Os dados fiscais (o tomador da NFS-e): CPF ou CNPJ conferidos, o nome e o endereco. */
export function conferirPerfil(d, email) {
  const documento = soDigitos(d.documento);
  const tipo = documento.length === 11 ? "pf" : documento.length === 14 ? "pj" : "";
  if (!tipo || !(tipo === "pf" ? cpfValido(documento) : cnpjValido(documento))) return { erro: "confira o CPF ou o CNPJ" };
  const nome = limpo(d.nome, 120);
  if (nome.length < 3) return { erro: tipo === "pf" ? "diga o nome completo" : "diga a razão social" };
  const e = d.endereco || {};
  const endereco = { cep: soDigitos(e.cep).slice(0, 8), logradouro: limpo(e.logradouro, 120), numero: limpo(e.numero, 20),
    complemento: limpo(e.complemento, 60), bairro: limpo(e.bairro, 60), cidade: limpo(e.cidade, 60), uf: limpo(e.uf, 2).toUpperCase(),
    ibge: soDigitos(e.ibge).slice(0, 7) };
  if (endereco.cep.length !== 8 || !endereco.logradouro || !endereco.numero || !endereco.cidade || !/^[A-Z]{2}$/.test(endereco.uf)) {
    return { erro: "confira o endereço (CEP, rua, número, cidade e UF)" };
  }
  return { tipo, documento, nome, email, endereco };
}

// ------------------------------------------------------------------ cobrar

/* O que vale para cobrar: o produto aberto, o preco do catalogo, o perfil completo. */
async function preparar(env, meu, precoId) {
  const oferta = resolveOffer(precoId, { paraCobrar: true });
  if (!oferta) return { falha: erro(400, "preço desconhecido") };
  if (!produtoAberto(env, oferta.produto)) return { falha: erro(409, `o ${oferta.produtoNome} ainda não vende pela Atos`, "produto_fechado") };
  // Um produto com nivel gratuito (o Atos Workspace): o plano pago e dele ativo, com os termos aceitos e sem suspensao.
  if (produtoDe(oferta.produto).gratuito) {
    const dir = (await meu.pedir("direito", { produto: oferta.produto })).direito;
    if (!dir || !dir.ativo) return { falha: erro(409, `ative o ${oferta.produtoNome} (gratuito, aceitando os termos) antes de assinar o plano pago`, "sem_ativacao") };
    if (dir.suspenso) return { falha: erro(409, `a Atos suspendeu o seu ${oferta.produtoNome}: escreva para contato@atos.dev.br`, "suspenso") };
    const termos = produtoDe(oferta.produto).termos;
    if (termos && (!dir.termos || dir.termos.versao !== termos.versao)) return { falha: erro(409, `os termos do ${oferta.produtoNome} mudaram: aceite a versão atual na área dele antes de assinar`, "termos") };
  }
  const perfil = (await meu.pedir("perfil_ler")).perfil;
  if (!perfil) return { falha: erro(409, "preencha os dados para a nota fiscal antes de pagar", "sem_perfil") };
  return { oferta, perfil, situacao: await situacaoDoProduto(meu, oferta.produto) };
}

const VIVAS = ["authorized", "pending", "paused", "criando"];

/* O que a pessoa ja tem do produto: a assinatura viva (se houver) e ate quando esta pago. */
async function situacaoDoProduto(meu, produto) {
  const viva = (await meu.pedir("listar")).assinatura.find((a) => a.produto === produto && VIVAS.includes(a.status)) || null;
  const dir = (await meu.pedir("direitos")).direitos.find((x) => x.produto === produto) || null;
  const pagoAte = dir && dir.ate && Date.parse(dir.ate) > Date.now() ? dir.ate : null;
  return { viva, pagoAte, plano: dir && dir.plano };
}

/* Quem paga, para o Mercado Pago: o e-mail dos dados fiscais. No Worker de teste, o comprador de teste
   (MP_PAGADOR_TESTE): com as credenciais de teste, o Mercado Pago so aceita pagador que tambem e de teste. */
function pagadorDe(env, perfil) {
  return ehAmbienteDeTeste(env) && env.MP_PAGADOR_TESTE ? String(env.MP_PAGADOR_TESTE) : perfil.email;
}

const dataBR = (iso) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

/* As regras de uma cobranca de periodo (mes ou ano), para nunca cobrar em dobro nem deixar o plano ambiguo:
   com assinatura viva, so a recarga se compra a parte (o plano se troca pela assinatura); com o produto pago
   ate uma data, mais tempo so no mesmo plano, e a assinatura no cartao so depois do vencimento. */
function conflito(oferta, situacao, assinando) {
  if (oferta.periodo === "avulso") return null;
  if (situacao.viva) {
    return erro(409, `você já assina o ${oferta.produtoNome}, e outra cobrança seria em dobro: para mudar de plano ou passar para o anual, cancele a assinatura em Minha conta › Assinaturas ou escreva para contato@atos.dev.br`, "ja_assina");
  }
  if (situacao.pagoAte && assinando) {
    return erro(409, `o ${oferta.produtoNome} está pago até ${dataBR(situacao.pagoAte)}: a assinatura no cartão começa depois disso`, "pago_ate");
  }
  if (situacao.pagoAte && situacao.plano && situacao.plano !== oferta.metadados.plano) {
    return erro(409, `o ${oferta.produtoNome} está pago até ${dataBR(situacao.pagoAte)} no outro plano: para trocar, espere o vencimento ou fale com contato@atos.dev.br`, "troca_de_plano");
  }
  return null;
}

/* A mensalidade no cartao: uma assinatura sem plano, ja autorizada com o token do cartao. */
async function assinar(request, env, s, cid, meu, op) {
  const d = (await lerJson(request)) || {};
  const { oferta, perfil, situacao, falha } = await preparar(env, meu, d.preco);
  if (falha) return falha;
  if (oferta.periodo !== "mes") return erro(400, "a assinatura é da mensalidade; o ano e o Pix são pagamento único");
  if (!/^[A-Za-z0-9]{16,64}$/.test(String(d.token || ""))) return erro(400, "o cartão não foi lido: preencha de novo", "sem_token");
  // Uma assinatura viva por produto, e nenhuma por cima de um periodo ja pago: seria cobranca em dobro.
  const barrado = conflito(oferta, situacao, true);
  if (barrado) return barrado;
  const ref = novaRef(cid, "assinatura");
  await meu.pedir("registrar", { tipo: "assinatura", registro: { ref, produto: oferta.produto, preco: oferta.id, plano: oferta.metadados.plano,
    centavos: oferta.centavos, forma: "cartao", bandeira: /^[a-z_]{2,20}$/.test(String(d.paymentMethodId || "")) ? String(d.paymentMethodId) : "", status: "criando" } });
  const backUrl = (env.APP_URL || "https://atos.dev.br") + "/conta/assinaturas";
  const r = await criarPreapproval(env, {
    reason: oferta.nome,
    external_reference: ref,
    payer_email: pagadorDe(env, perfil),
    card_token_id: String(d.token),
    auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: oferta.centavos / 100, currency_id: MOEDA },
    back_url: backUrl,
    status: "authorized",
  }, op);
  if (!r.ok || !r.dados || !r.dados.id) {
    const motivo = (r.dados && (r.dados.message || r.dados.error)) || "recusado";
    // O porque do Mercado Pago, nos logs do Worker (o status e a resposta dele; nada do cartao vai nela).
    console.warn("cobranca: o Mercado Pago recusou a assinatura", ref, r.status, JSON.stringify(r.dados || null).slice(0, 800));
    await meu.pedir("atualizar", { tipo: "assinatura", ref, campos: { status: "recusada", motivo: String(motivo).slice(0, 200), resposta: JSON.stringify(r.dados || null).slice(0, 800) } });
    if (/unsupported_credit_card_for_recurring/i.test(String(motivo))) {
      return erro(402, "este cartão não aceita cobrança mensal automática (alguns pré-pagos e de débito não aceitam): use outro cartão de crédito, ou pague no Pix", "recusada");
    }
    return erro(402, "o cartão não foi aceito para a assinatura: confira os dados ou use outro cartão", "recusada");
  }
  const atual = (await aplicarPreapproval(env, r.dados)) || { ref, status: r.dados.status };
  return json(publicaAssinatura(atual));
}

/* O pagamento unico (Orders API): o ano no cartao ou no Pix, o mes no Pix, a recarga no Pix. */
async function pagar(request, env, s, cid, meu, op) {
  const d = (await lerJson(request)) || {};
  const { oferta, perfil, situacao, falha } = await preparar(env, meu, d.preco);
  if (falha) return falha;
  const forma = d.forma === "cartao" ? "cartao" : d.forma === "pix" ? "pix" : "";
  if (!forma || !oferta.formas.includes(forma)) return erro(400, "forma de pagamento não aceita para este preço");
  if (oferta.periodo === "mes" && forma === "cartao") return erro(400, "a mensalidade no cartão é assinatura (/assinar)");
  if (forma === "cartao" && !/^[A-Za-z0-9]{16,64}$/.test(String(d.token || ""))) return erro(400, "o cartão não foi lido: preencha de novo", "sem_token");
  const barrado = conflito(oferta, situacao, false);
  if (barrado) return barrado;
  if (oferta.requer_assinatura && !situacao.pagoAte) return erro(409, `a recarga é para quem tem o ${oferta.produtoNome} em dia`, "sem_assinatura");
  const ref = novaRef(cid, "compra");
  await meu.pedir("registrar", { tipo: "compra", registro: { ref, produto: oferta.produto, preco: oferta.id, plano: oferta.metadados.plano,
    periodo: oferta.periodo, centavos: oferta.centavos, forma, status: "criando" } });
  const pagamento = forma === "pix"
    ? { amount: oferta.valor, payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: PIX_VALIDADE }
    : { amount: oferta.valor, payment_method: { id: String(d.paymentMethodId || "").slice(0, 40), type: "credit_card", token: String(d.token), installments: 1 } };
  // issuer_id nao vai em payment_method na Orders API. A chave de idempotencia e a ref: uma nova tentativa
  // da mesma compra nunca cobra duas vezes.
  const r = await mpFetch(env, "POST", "/v1/orders", {
    type: "online",
    processing_mode: "automatic",
    total_amount: oferta.valor,
    external_reference: ref,
    payer: { email: pagadorDe(env, perfil), identification: { type: perfil.tipo === "pj" ? "CNPJ" : "CPF", number: perfil.documento } },
    transactions: { payments: [pagamento] },
  }, { ...op, idempotencia: ref });
  if (!r.ok || !r.dados || !r.dados.id) {
    const detalhe = r.dados && r.dados.errors && r.dados.errors[0] && r.dados.errors[0].code;
    console.warn("cobranca: o Mercado Pago recusou a order", ref, r.status, JSON.stringify(r.dados || null).slice(0, 800));
    await meu.pedir("atualizar", { tipo: "compra", ref, campos: { status: "recusada", motivo: String(detalhe || r.status).slice(0, 120), resposta: JSON.stringify(r.dados || null).slice(0, 800) } });
    return erro(402, forma === "pix" ? "não deu para gerar o Pix agora: tente de novo" : fraseDaRecusa(detalhe), "recusada");
  }
  const compra = (await aplicarOrder(env, r.dados, op)) || { ref, status: "processando" };
  if (compra.status === "recusada") return erro(402, fraseDaRecusa(compra.motivo), "recusada");
  return json(publicaCompra(compra));
}

// ------------------------------------------------------------- aplicar (o que o Mercado Pago diz)

const ESTADO_DA_ORDER = { processed: "paga", action_required: "aguardando", processing: "processando", failed: "recusada",
  canceled: "cancelada", cancelled: "cancelada", expired: "vencida", refunded: "devolvida" };

/* A NFS-e como a Minha conta mostra: sem o caminho interno dos arquivos. */
function notaPublica(n) {
  return { id: n.id, pagamento: n.pagamento || "", numero: n.numero || "", competencia: n.competencia, valor: n.valor, descricao: n.descricao || "",
    ambiente: n.ambiente, emitida_em: n.emitida_em, tem_pdf: Boolean(n.tem_pdf), tem_xml: Boolean(n.tem_xml),
    cancelada: Boolean(n.cancelada), substituta: n.substituta || "" };
}

/* Uma order buscada no Mercado Pago, aplicada a compra dela. Devolve a compra como ficou. op.ctx (se houver): a
   fila da NFS-e vai em segundo plano. */
export async function aplicarOrder(env, order, op = {}) {
  const dono = clienteDaRef(order && order.external_reference);
  if (!dono || dono.tipo !== "compra") return null;
  const meu = cliente(env, dono.clienteId);
  const pag = (order.transactions && order.transactions.payments && order.transactions.payments[0]) || {};
  const pm = pag.payment_method || {};
  const status = ESTADO_DA_ORDER[order.status] || "processando";
  const campos = { mp_id: order.id, status, mp_status: order.status, mp_detalhe: order.status_detail || pag.status_detail || "" };
  if (pm.id === "pix" && pm.qr_code) campos.pix = { qr_code: pm.qr_code, qr_code_base64: pm.qr_code_base64 || "", ticket_url: pm.ticket_url || "" };
  if (status === "recusada") campos.motivo = pag.status_detail || order.status_detail || "";
  if (status === "paga") campos.paga_em = new Date().toISOString();
  const r = await meu.pedir("atualizar", { tipo: "compra", ref: order.external_reference, campos });
  if (!r.ok) return null;
  const c = r.registro;
  if (status === "paga") {
    // O direito: o ano e o mes estendem o produto; a recarga soma creditos. Uma vez por pagamento.
    const origem = "order:" + order.id;
    const metadados = (resolveOffer(c.preco) || {}).metadados || null;
    if (c.periodo === "ano") await meu.pedir("estender", { produto: c.produto, plano: c.plano, metadados, meses: 12, origem });
    else if (c.periodo === "mes") await meu.pedir("estender", { produto: c.produto, plano: c.plano, metadados, meses: 1, origem });
    else await meu.pedir("estender", { produto: c.produto, origem, credito: { preco: c.preco, centavos: c.centavos, metadados } });
    // A NFS-e: so quando a compra ACABOU de ficar paga (o objeto atende um pedido de cada vez: o aviso e a consulta
    // da tela nao veem os dois a virada). A fila ainda confere a ref (porNaFila).
    if (!r.antes || r.antes.status !== "paga") {
      await emSegundoPlano(op, porNaFila(env, { id: c.ref, cliente: dono.clienteId, produto: c.produto, preco: c.preco,
        descricao: descricaoDaNota(c.preco, c.periodo), valor: c.centavos / 100, quando: c.paga_em }));
    }
  }
  return c;
}

/* O texto da nota: o nome do preco no catalogo (o mes no Pix diz que e um mes). */
function descricaoDaNota(preco, periodo) {
  const nome = (resolveOffer(preco) || {}).nome || String(preco || "");
  return periodo === "mes" ? nome + " · um mês" : nome;
}

/* O que nao pode atrasar nem quebrar a cobranca (a fila da NFS-e, o indice dos clientes): com o ctx, em segundo
   plano; sem ele, esperado aqui. Nunca lanca. */
function emSegundoPlano(op, promessa) {
  const t = Promise.resolve(promessa).catch((e) => console.warn("cobranca: a NFS-e falhou (a cobranca segue)", String((e && e.message) || e).slice(0, 200)));
  if (op && op.ctx && typeof op.ctx.waitUntil === "function") {
    op.ctx.waitUntil(t);
    return undefined;
  }
  return t;
}

const ESTADO_DA_ASSINATURA = { pending: "pending", authorized: "authorized", paused: "paused", cancelled: "canceled", canceled: "canceled" };

/* Uma assinatura (preapproval) buscada no Mercado Pago, aplicada a da Atos. */
export async function aplicarPreapproval(env, pre) {
  const dono = clienteDaRef(pre && pre.external_reference);
  if (!dono || dono.tipo !== "assinatura") return null;
  const campos = { mp_id: pre.id, status: ESTADO_DA_ASSINATURA[pre.status] || "pending", proxima: pre.next_payment_date || null };
  const r = await cliente(env, dono.clienteId).pedir("atualizar", { tipo: "assinatura", ref: pre.external_reference, campos });
  return r.ok ? r.registro : null;
}

/* Uma mensalidade cobrada (authorized_payment): aprovada, estende o direito um mes. */
export async function aplicarCobrancaRecorrente(env, ap, op) {
  if (!ap || !ap.preapproval_id) return null;
  const g = await mpFetch(env, "GET", "/preapproval/" + encodeURIComponent(ap.preapproval_id), undefined, op);
  if (!g.ok) return null;
  const assinatura = await aplicarPreapproval(env, g.dados);
  if (!assinatura) return null;
  const aprovado = ap.payment && ap.payment.status === "approved";
  const recusado = ap.payment && ["rejected", "cancelled", "canceled"].includes(ap.payment.status);
  const salva = await cliente(env, clienteDaRef(assinatura.ref).clienteId).pedir("cobranca_salvar", { registro: {
    ref: "ap-" + String(ap.id), assinatura: assinatura.ref, produto: assinatura.produto, preco: assinatura.preco, plano: assinatura.plano,
    centavos: Math.round(Number(ap.transaction_amount) * 100) || assinatura.centavos, forma: "cartao",
    status: aprovado ? "paga" : recusado ? "recusada" : "processando", quando: ap.debit_date || ap.date_created || new Date().toISOString() } });
  if (aprovado) {
    const dono = clienteDaRef(assinatura.ref);
    await cliente(env, dono.clienteId).pedir("estender", { produto: assinatura.produto, plano: assinatura.plano,
      metadados: (resolveOffer(assinatura.preco) || {}).metadados || null, meses: 1, origem: "ap:" + ap.id });
    // A NFS-e da mensalidade: so quando ela ACABOU de ficar paga (o aviso repetido nao poe de novo na fila).
    const c = salva && salva.registro;
    if (c && (!salva.antes || salva.antes.status !== "paga")) {
      await emSegundoPlano(op, porNaFila(env, { id: c.ref, cliente: dono.clienteId, produto: c.produto, preco: c.preco,
        descricao: ((resolveOffer(c.preco) || {}).nome || c.preco) + " · mensalidade", valor: c.centavos / 100, quando: c.quando }));
    }
  }
  return assinatura;
}

// ------------------------------------------------------------------ o aviso

const te = new TextEncoder();
async function hmacHex(segredo, texto) {
  const k = await crypto.subtle.importKey("raw", te.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(texto)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const AVISO_VALIDADE_MS = 10 * 60 * 1000;

/* O webhook: conferir a assinatura (x-signature) antes de tudo, responder logo e aplicar depois. */
async function receberAviso(request, env, url, deps) {
  if (request.method !== "POST") return erro(405, "use POST");
  if (!env.MP_WEBHOOK_SECRET) return erro(503, "o aviso ainda não está ligado (falta o MP_WEBHOOK_SECRET)");
  const corpo = (await lerJson(request)) || {};
  const dataId = String(url.searchParams.get("data.id") || (corpo.data && corpo.data.id) || "");
  const tipo = String(url.searchParams.get("type") || corpo.type || corpo.topic || "");
  const partes = Object.fromEntries((request.headers.get("x-signature") || "").split(",").map((x) => x.trim().split("=")).filter((x) => x.length === 2));
  const requestId = request.headers.get("x-request-id") || "";
  if (!partes.ts || !partes.v1 || !dataId) return erro(401, "aviso sem assinatura");
  // O id alfanumerico entra no manifest em minusculas; o numerico, como veio.
  let valido = false;
  for (const id of new Set([dataId, dataId.toLowerCase()])) {
    const manifest = `id:${id};` + (requestId ? `request-id:${requestId};` : "") + `ts:${partes.ts};`;
    if (iguais(await hmacHex(env.MP_WEBHOOK_SECRET, manifest), String(partes.v1).toLowerCase())) valido = true;
  }
  if (!valido) return erro(401, "assinatura não confere");
  const quando = Number(partes.ts) < 1e12 ? Number(partes.ts) * 1000 : Number(partes.ts);
  if (Math.abs(Date.now() - quando) > AVISO_VALIDADE_MS) return erro(401, "aviso velho");
  const trabalho = aplicarAviso(env, tipo, dataId, { buscar: deps.fetch || fetch }).catch(() => null);
  if (deps.ctx && deps.ctx.waitUntil) deps.ctx.waitUntil(trabalho);
  else await trabalho;
  return json({ recebido: true });
}

/* O que o aviso disse, buscado no Mercado Pago e aplicado (o aviso so traz o id). */
export async function aplicarAviso(env, tipo, id, op) {
  if (tipo === "order") {
    const o = await mpFetch(env, "GET", "/v1/orders/" + encodeURIComponent(id), undefined, op);
    return o.ok ? aplicarOrder(env, o.dados, op) : null;
  }
  if (tipo === "subscription_preapproval" || tipo === "preapproval") {
    const g = await mpFetch(env, "GET", "/preapproval/" + encodeURIComponent(id), undefined, op);
    return g.ok ? aplicarPreapproval(env, g.dados) : null;
  }
  if (tipo === "subscription_authorized_payment") {
    const a = await mpFetch(env, "GET", "/authorized_payments/" + encodeURIComponent(id), undefined, op);
    return a.ok ? aplicarCobrancaRecorrente(env, a.dados, op) : null;
  }
  return null;
}

// ------------------------------------------------------------------ o que a tela ve

export function publicaAssinatura(a) {
  return { id: a.ref, produto: a.produto, preco: a.preco, plano: a.plano, centavos: a.centavos, status: a.status, proxima: a.proxima || null, criada: a.criada,
    bandeira: a.bandeira || "", forma: a.forma || "cartao",
    // A concedida pela equipe da Atos: R$ 0,00 por mes, sem cartao e sem fatura; renova sozinha ate ser cancelada.
    ...(a.concedida ? { concedida: { quando: a.concedida.quando, renovacoes: a.renovacoes || 1 }, encerrada: a.encerrada ? a.encerrada.quando : null } : {}) };
}

/* A Minha conta da Atos (public/assets/conta.js): por produto pago, o direito, a assinatura que importa e o nome do
   plano; os gratuitos (o Atos Workspace: ativo ou nao); e as faturas (as compras e as cobrancas do mes), da mais nova para a mais velha. */
async function minhaConta(meu) {
  const l = await meu.pedir("listar");
  const direitos = (await meu.pedir("direitos")).direitos;
  const perfil = (await meu.pedir("perfil_ler")).perfil;
  const nomeDoPreco = (id) => (resolveOffer(id) || {}).nome || id;
  const produtos = [];
  // Os gratuitos (o Atos Workspace): ativo ou nao, com os termos aceitos; sempre na lista (a tela oferece "Ativar").
  const gratuitos = [];
  for (const [produto, p] of todosOsProdutos()) {
    const dir = direitos.find((x) => x.produto === produto) || null;
    const minhas = l.assinatura.filter((a) => a.produto === produto && !["criando", "recusada"].includes(a.status))
      .sort((a, b) => String(b.criada).localeCompare(String(a.criada)));
    const a = minhas.find((x) => VIVAS.includes(x.status)) || minhas[0] || null;
    if (p.gratuito) {
      // O plano pago do gratuito (o Atos Workspace Pro): ate quando, para a linha e o cartao do produto.
      const pago = dir && dir.plano && dir.ate ? { plano: dir.plano, ate: dir.ate, pro: Date.parse(dir.ate) > Date.now() } : null;
      gratuitos.push({ produto, nome: p.nome, endereco: new URL(p.site).pathname, ativo: Boolean(dir && dir.ativo), ativado: (dir && dir.ativo && dir.ativado) || null,
        desativado: (dir && !dir.ativo && dir.desativado) || null, termos: dir && dir.termos ? { versao: dir.termos.versao, aceito: dir.termos.aceito } : null, pago });
      // Quem ja pagou (ou assina) o plano pago tambem aparece entre os produtos pagos: a assinatura, o cancelar, o renovar.
      if (!pago && !a) continue;
    }
    if (!dir && !a) continue;
    const plano = (dir && dir.plano) || (a && a.plano) || null;
    produtos.push({
      produto, nome: p.nome, plano, plano_nome: plano ? nomeDoPreco(`${produto}.${plano}.mes`).replace(p.nome + " ", "") : null, endereco: new URL(p.site).pathname,
      direito: dir ? { ate: dir.ate || null, periodo: dir.periodo || null, pago_por: dir.pago_por || null } : null,
      assinatura: a ? { ...publicaAssinatura(a), nome: nomeDoPreco(a.preco) } : null,
    });
  }
  const faturas = [
    ...l.compra.filter((c) => ["paga", "aguardando", "processando", "devolvida"].includes(c.status))
      .map((c) => ({ id: c.ref, data: c.paga_em || c.criada, descricao: nomeDoPreco(c.preco), centavos: c.centavos, status: c.status, forma: c.forma, produto: c.produto || "" })),
    ...l.cobranca.map((c) => ({ id: c.ref, data: c.quando || c.criada, descricao: nomeDoPreco(c.preco) + " · mensalidade", centavos: c.centavos, status: c.status, forma: "cartao", produto: c.produto || "" })),
  ].sort((x, y) => String(y.data).localeCompare(String(x.data)));
  return { perfil, produtos, gratuitos, faturas };
}

function publicaCompra(c) {
  return { id: c.ref, produto: c.produto, preco: c.preco, periodo: c.periodo, centavos: c.centavos, forma: c.forma, status: c.status,
    pix: c.status === "aguardando" ? c.pix || null : null, paga_em: c.paga_em || null, criada: c.criada };
}


// ------------------------------------------------------------- a equipe (o painel, worker/admin-contas.js)

/* Os planos que a equipe pode conceder: o preco mensal a venda de cada produto que vende pela Atos. */
export async function planosParaConceder(env) {
  await carregarCatalogo(env);
  const l = [];
  for (const [produto, p] of todosOsProdutos()) {
    if (!produtoAberto(env, produto)) continue;
    const planos = p.precos.filter((x) => x.periodo === "mes" && x.ativo !== false && x.metadados && x.metadados.plano)
      .map((x) => ({ plano: x.metadados.plano, nome: x.nome, preco: x.id, centavos: x.centavos }));
    if (planos.length) l.push({ produto, nome: p.nome, planos });
  }
  return l;
}

/* As assinaturas e os direitos de uma Conta Atos, para o painel (sem nada do cartao). */
export async function cobrancaDaConta(env, sub) {
  const meu = cliente(env, await idDoCliente(sub));
  const l = await meu.pedir("listar");
  const direitos = (await meu.pedir("direitos")).direitos;
  return {
    assinaturas: l.assinatura.filter((a) => !["criando", "recusada"].includes(a.status)).map((a) => ({ ...publicaAssinatura(a),
      ...(a.concedida ? { concedida: { por: a.concedida.por, quando: a.concedida.quando, motivo: a.concedida.motivo, renovacoes: a.renovacoes || 1 },
        encerrada: a.encerrada ? { por: a.encerrada.por, quando: a.encerrada.quando, motivo: a.encerrada.motivo } : null } : {}) }))
      .sort((a, b) => String(b.criada).localeCompare(String(a.criada))),
    direitos: direitos.filter((x) => x.plano || x.ate).map((x) => ({ produto: x.produto, plano: x.plano || null, ate: x.ate || null, periodo: x.periodo || null, pago_por: x.pago_por || null })),
  };
}

/* A equipe concede uma assinatura de R$ 0,00 por mes (cliente.js, conceder): sem Mercado Pago, sem cartao, sem fatura e
   sem NFS-e (nada foi pago). {status, ...}: 200 {assinatura, direito} ou o motivo da recusa. */
export async function concederAssinatura(env, { sub, email, produto, plano, por, motivo }) {
  await carregarCatalogo(env);
  const p = produtoDe(String(produto || ""));
  if (!p) return { status: 404, erro: "produto desconhecido" };
  if (!produtoAberto(env, produto)) return { status: 409, erro: `o ${p.nome} ainda não vende pela Atos`, codigo: "produto_fechado" };
  const oferta = resolveOffer(`${produto}.${String(plano || "")}.mes`, { paraCobrar: true });
  if (!oferta || oferta.periodo !== "mes") return { status: 400, erro: `o ${p.nome} não tem o plano mensal "${String(plano || "").slice(0, 40)}"` };
  const cid = await idDoCliente(sub);
  const meu = cliente(env, cid, { sub, email });
  if (p.gratuito) {
    // O plano pago de um produto com nivel gratuito (o Atos Workspace Pro): o mesmo que o checkout pede.
    const dir = (await meu.pedir("direito", { produto })).direito;
    if (!dir || !dir.ativo) return { status: 409, erro: `esta conta não ativou o ${p.nome}: a pessoa ativa (aceitando os termos) antes`, codigo: "sem_ativacao" };
    if (dir.suspenso) return { status: 409, erro: `o ${p.nome} desta conta está suspenso pela Atos`, codigo: "suspenso" };
  }
  const r = await meu.pedir("conceder", { produto, plano: oferta.metadados.plano, preco: oferta.id, metadados: oferta.metadados, ref: novaRef(cid, "assinatura"), por, motivo });
  if (!r.ok) return { status: r.status || 409, erro: r.erro, codigo: r.codigo };
  return { status: 200, assinatura: publicaAssinatura(r.registro), direito: { produto, plano: r.direito.plano, ate: r.direito.ate } };
}

/* A equipe encerra (cancela) uma assinatura concedida. So a concedida: a paga se cancela pelo Mercado Pago. */
export async function encerrarAssinaturaConcedida(env, { sub, ref, por, motivo }) {
  if (!clienteDaRef(ref) || clienteDaRef(ref).tipo !== "assinatura") return { status: 400, erro: "assinatura inválida" };
  const cid = await idDoCliente(sub);
  if (clienteDaRef(ref).clienteId !== cid) return { status: 404, erro: "essa assinatura não é desta conta" };
  const r = await cliente(env, cid).pedir("encerrar_concedida", { ref, por, motivo });
  if (!r.ok) return { status: r.status || 409, erro: r.erro };
  return { status: 200, assinatura: publicaAssinatura(r.registro), repetido: Boolean(r.repetido) };
}
