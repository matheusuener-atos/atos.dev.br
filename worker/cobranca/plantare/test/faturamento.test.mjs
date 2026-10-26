import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { ClienteCobranca, cliente, idDoCliente } from "../../cliente.js";
import { guardarCompra } from "../eventos.js";
import { conferirLancamento } from "../faturamento-contrato.js";
import { ambiente, entrada, PREFIXO, storage } from "./apoio.mjs";
import { EmissorNFSe } from "../../../nfse/emissor.js";
import { K, lerPagamento, listarPagamentos, porNaFila } from "../../../nfse/atos.js";
import { lerPfx } from "../../../nfse/pfx.js";
import { b64 } from "../../../nfse/assinatura.js";
import { SefinSimulada } from "../../../nfse/sefin-simulada.js";
import { sha256 } from "../../../comum.js";
import { atenderEmissor, PREFIXO as PREFIXO_NFSE, resumoParaPainel } from "../../../nfse/api.js";

const fetchOriginal = globalThis.fetch;
after(() => { globalThis.fetch = fetchOriginal; });
globalThis.fetch = () => { throw new Error("teste financeiro não deve acessar rede"); };
const perfil = { nome: "Ana Teste", tipo: "pf", documento: "52998224725", email: "ana@example.test",
  endereco: { cep: "66010000", logradouro: "Rua dos Mundurucus", numero: "1500", bairro: "Batista Campos", cidade: "Belém", uf: "PA", ibge: "1501402" } };
const prestador = { ambiente: "producao_restrita", documento: "11222333000181", razao_social: "Atos Tecnologia", inscricao_municipal: "7788990", municipio: "1501402",
  opcao_simples: "1", regime_especial: "0", servico: { ctribnac: "010301", nbs: "115062100", descricao: "Licença de uso de software", aliquota_iss_bp: 200 },
  retencoes: Object.fromEntries(["iss", "irrf", "pis", "cofins", "csll", "cp"].map((k) => [k, { quando: "nunca" }])),
  ibscbs: { enviar: true, cst: "000", cclasstrib: "000001", cindop: "100301", indfinal: "1" }, total_tributos: { modo: "percentual", federal_bp: 1345, municipal_bp: 200 } };
const cert = lerPfx(readFileSync(new URL("../../../nfse/fixtures/a1-cn.pfx", import.meta.url)), "segredo-de-teste");

function storageEmissor() {
  const db = new DatabaseSync(":memory:"); let alarme = null;
  return { db, sql: { exec(q, ...b) { const linhas = db.prepare(q).all(...b); return { toArray: () => linhas }; } },
    transactionSync(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    async getAlarm() { return alarme; }, async setAlarm(t) { alarme = t; } };
}

async function abrir(t, { automatico = true } = {}) {
  const a = ambiente();
  const clientes = new Map(), bancos = new Map(), kv = new Map(), st = storageEmissor();
  t.after(() => { a.close(); for (const s of bancos.values()) s.close(); st.db.close(); });
  Object.assign(a.env, { AMBIENTE: "teste", PLANTARE_COMPRAS_ATIVAS: "1", PLANTARE_CHECKOUT_ATIVO: "1",
    NFSE_CHAVE_MESTRA: b64(crypto.getRandomValues(new Uint8Array(32))) });
  a.env.CONTAS = {
    async get(k, tipo) {
      if (a.kvAtrasado && k.startsWith(K(a.env).pag)) return null;
      const v = kv.get(k); return v === undefined ? null : tipo === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { if (a.kvFalha && k.startsWith(K(a.env).pag)) throw new Error("KV fora"); kv.set(k, v); },
    async delete(k) { kv.delete(k); },
    async list({ prefix = "" } = {}) { return { list_complete: true, keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
  a.env.CLIENTES = { idFromName: (n) => n, get(id) {
    if (!bancos.has(id)) bancos.set(id, storage());
    if (!clientes.has(id)) clientes.set(id, new ClienteCobranca({ storage: bancos.get(id) }, a.env));
    return { async fetch(url, op) {
      const r = await clientes.get(id).fetch(new Request(url, op));
      if (a.perderCliente && JSON.parse(op.body).op === "plantare_sincronizar") { a.perderCliente = false; throw new Error("ACK do cliente perdido"); }
      return r;
    } };
  } };
  const sim = new SefinSimulada("sucesso"); a.sim = sim;
  a.reiniciarEmissor = () => { a.emissor = new EmissorNFSe({ storage: st }, a.env); a.emissor.fetchSefin = sim.fetch; a.emissor.agora = () => new Date(a.relogio.agora); };
  a.reiniciarEmissor();
  a.env.EMISSOR_NFSE = { idFromName: (n) => n, get() { return { async fetch(url, op) {
    const r = await a.emissor.fetch(new Request(url, op));
    if (a.perderEmissor && JSON.parse(op.body).acao === "plantare_registrar") { a.perderEmissor = false; throw new Error("ACK do emissor perdido"); }
    return r;
  } }; } };
  await a.emissor.configurar({ prestador });
  await a.emissor.guardarCertificado({ certificado: cert.certPem, chave: b64(cert.chavePkcs8), titular: cert.titular, documento: cert.documento });
  await a.emissor.testar();
  kv.set(K(a.env).config, JSON.stringify({ auto: automatico, email: true, mail: false }));
  const cid = await idDoCliente("sub-ana"); a.cid = cid;
  await cliente(a.env, cid, { sub: "sub-ana", email: perfil.email }).pedir("perfil_salvar", { perfil });
  kv.set("id:conta:" + perfil.email, JSON.stringify({ sub: "sub-ana", nome: "Ana" }));
  kv.set("atos:sessao:" + await sha256("sessao-faturamento"), JSON.stringify({ sub: "sub-ana", email: perfil.email, auth_time: Math.floor(Date.now() / 1000) }));
  a.nova = async (i = 1) => {
    const q = (await a.post(entrada({ intent_id: "int-financeiro-" + i }), { headers: { "idempotency-key": "orc-financeiro-" + i } })).data;
    const r = await a.chamar(PREFIXO + "/checkouts", { body: { schema: "plantare-checkout/v1", sub: q.sub, intent_id: q.intent_id, orcamento_id: q.orcamento_id },
      headers: { "idempotency-key": "checkout-financeiro-" + i } });
    assert.equal(r.status, 200); return r.data.compra;
  };
  a.mudar = async (id, estado = "paga", extra = {}) => {
    const o = [...a.objetos.values()][0];
    return o.ctx.storage.transaction(async (tx) => {
      const r = await tx.get("compra:" + id);
      r.email = perfil.email; r.fase = estado === "aguardando" ? "pix_pendente" : "concluida";
      r.snapshot = { ...r.snapshot, versao: r.snapshot.versao + (estado === "aguardando" ? 0 : 1), estado,
        pago_em: estado === "aguardando" ? null : r.snapshot.pago_em || new Date(a.relogio.agora).toISOString(), ...extra };
      await guardarCompra(o, tx, r); return r.snapshot;
    });
  };
  a.rodar = () => [...a.objetos.values()][0].alarm();
  a.avancar = () => { a.relogio.agora += 60001; };
  a.registro = (id) => cliente(a.env, cid).pedir("ler", { tipo: "compra", ref: id });
  a.fiscal = (id) => lerPagamento(a.env, id);
  a.pendentes = () => [...a.storages.values()][0].list({ prefix: "financeiro-pendente:" });
  a.lancamento = async (id) => {
    const r = await [...a.storages.values()][0].get("compra:" + id);
    return conferirLancamento({ ...r.snapshot, schema: "plantare-faturamento/v1", email: r.email, cliente: cid });
  };
  a.sincronizarCliente = (p) => cliente(a.env, cid, { sub: p.sub, email: p.email }).pedir("plantare_sincronizar", { lancamento: p });
  a.registrarFiscal = (p) => a.emissor.fetch(new Request("https://emissor/", { method: "POST", body: JSON.stringify({ acao: "plantare_registrar", dados: { lancamento: p } }) }));
  a.kv = kv; a.bancos = bancos;
  return a;
}

test("pagamento Plantare chega à fatura e emite uma nota de teste com a mesma referência", async (t) => {
  const a = await abrir(t), c = await a.nova();
  await a.mudar(c.id); await a.rodar();
  const r = await a.registro(c.id); assert.equal(r.ok, true);
  assert.equal(r.registro.status, "paga"); assert.equal(r.registro.centavos, 93500);
  const p = await a.fiscal(c.id);
  assert.equal(p.nota, "emitida"); assert.equal(p.cliente, a.cid);
  assert.equal(p.valor, 935); assert.equal(a.sim.geradas.size, 1);
  assert.equal((await a.pendentes()).size, 0);
  const conta = await a.chamar("/api/cobranca/v1/conta", { headers: { authorization: null, cookie: "__Host-atos=sessao-faturamento" } });
  assert.equal(conta.status, 200);
  assert.equal(conta.data.faturas[0].id, c.id);
  assert.match(conta.data.faturas[0].descricao, /Plantare Maps.*93,50 ha/);
  assert.equal(conta.data.notas[0].pagamento, c.id);
});

test("pendente aparece no faturamento e cortesia não cria fila fiscal ou nota", async (t) => {
  const a = await abrir(t), c = await a.nova();
  await a.mudar(c.id, "aguardando"); await a.rodar();
  assert.equal((await a.registro(c.id)).registro.status, "aguardando");
  assert.equal(await a.fiscal(c.id), null);
  const zero = await a.nova(2);
  await a.mudar(zero.id, "concedida", { centavos: 0 }); await a.rodar();
  assert.equal((await a.registro(zero.id)).registro.status, "concedida");
  assert.equal(await a.fiscal(zero.id), null); assert.equal(a.sim.geradas.size, 0);
});

test("perda do ACK do cliente recupera sem duplicar fatura ou nota", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  a.perderCliente = true; await a.rodar();
  assert.equal((await a.pendentes()).size, 1); assert.equal(a.sim.geradas.size, 0);
  a.avancar(); a.objetos.clear(); await a.get("sub-ana", c.intent_id); await a.rodar();
  assert.equal((await a.pendentes()).size, 0); assert.equal(a.sim.geradas.size, 1);
  const l = await cliente(a.env, a.cid).pedir("listar"); assert.equal(l.compra.length, 1);
});

test("perda do ACK depois de emitir e reinício do emissor não reservam outra DPS", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  a.perderEmissor = true; await a.rodar(); assert.equal(a.sim.geradas.size, 1);
  assert.equal((await a.pendentes()).size, 1);
  a.reiniciarEmissor(); a.avancar(); await a.rodar();
  assert.equal((await a.pendentes()).size, 0);
  assert.equal(a.emissor.um("SELECT COUNT(*) AS n FROM notas").n, 1); assert.equal(a.sim.geradas.size, 1);
});

test("KV indisponível ou atrasado não vira autoridade para criar outra nota", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  a.kvFalha = true; a.kvAtrasado = true; await a.rodar();
  assert.equal((await a.pendentes()).size, 0); // emissor confirmou a fila SQL durável
  assert.equal(a.sim.geradas.size, 1); assert.equal((await a.fiscal(c.id)).nota, "emitida");
  a.reiniciarEmissor(); a.kvFalha = false; a.avancar(); await a.emissor.alarm();
  assert.equal(a.emissor.um("SELECT COUNT(*) AS n FROM notas").n, 1);
  assert.equal((await listarPagamentos(a.env)).pagamentos[0].nota, "emitida");
});

test("devolução anterior à sincronização bloqueia emissão, inclusive replay de versão paga", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  const paga = await a.lancamento(c.id); await a.mudar(c.id, "devolvida"); await a.rodar();
  assert.equal((await a.registro(c.id)).registro.status, "devolvida");
  assert.equal((await a.fiscal(c.id)).revisao_fiscal, true); assert.equal(a.sim.geradas.size, 0);
  assert.equal((await a.registrarFiscal(paga)).status, 200);
  assert.equal((await a.sincronizarCliente(paga)).repetido, true);
  assert.equal((await a.registro(c.id)).registro.status, "devolvida"); assert.equal(a.sim.geradas.size, 0);
});

test("devolução posterior à nota preserva documento e sinaliza conciliação fiscal", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id); await a.rodar();
  await a.mudar(c.id, "devolvida"); await a.rodar();
  const fiscal = await a.fiscal(c.id);
  assert.equal(fiscal.situacao_financeira, "devolvida"); assert.equal(fiscal.nota, "emitida");
  assert.equal(fiscal.revisao_fiscal, true); assert.match(fiscal.motivo, /conciliação fiscal/);
  assert.equal(a.sim.eventos.size, 0);
  assert.equal((await a.registro(c.id)).registro.status, "devolvida");
});

test("mesma versão divergente, preço alterado e conta errada são recusados", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id); await a.rodar();
  const p = await a.lancamento(c.id);
  for (const patch of [{ centavos: 1 }, { estado: "devolvida" }, { cliente: "0".repeat(32) }, { sub: "sub-beto" }]) {
    assert.equal((await a.sincronizarCliente({ ...p, ...patch })).ok, false);
    assert.ok((await a.registrarFiscal({ ...p, ...patch })).status >= 400);
  }
  assert.equal(a.sim.geradas.size, 1);
});

test("cliente indisponível mantém outbox e recuperação não perde o pagamento", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  const clientes = a.env.CLIENTES; a.env.CLIENTES = null; await a.rodar();
  assert.equal((await a.pendentes()).size, 1);
  a.env.CLIENTES = clientes; a.avancar(); await a.rodar();
  assert.equal(a.sim.geradas.size, 1); assert.equal((await a.pendentes()).size, 0);
});

test("tomador incompleto permanece na fila SQL e emite depois da correção", async (t) => {
  const a = await abrir(t), c = await a.nova();
  await cliente(a.env, a.cid).pedir("perfil_salvar", { perfil: { ...perfil, endereco: { ...perfil.endereco, ibge: "" } } });
  await a.mudar(c.id); await a.rodar();
  assert.equal(a.sim.geradas.size, 0); assert.match((await a.fiscal(c.id)).motivo, /município/);
  await cliente(a.env, a.cid).pedir("perfil_salvar", { perfil }); a.avancar(); await a.emissor.alarm();
  assert.equal(a.sim.geradas.size, 1);
});

test("automático desligado só enfileira; nota cancelada não permite nova emissão por replay", async (t) => {
  const a = await abrir(t, { automatico: false }), c = await a.nova(); await a.mudar(c.id); await a.rodar();
  assert.equal(a.sim.geradas.size, 0); assert.equal((await a.fiscal(c.id)).nota, "pendente");
  a.kv.set(K(a.env).config, JSON.stringify({ auto: true, email: false, mail: false }));
  const n = await a.emissor.emitir({ pagamento: c.id, conta: a.cid, tomador: {
    nome: perfil.nome, documento: perfil.documento, logradouro: perfil.endereco.logradouro, numero: "1500", bairro: "Batista Campos", cep: "66010000", cmun: "1501402", uf: "PA",
  } });
  a.emissor.rodar("UPDATE notas SET estado='cancelada' WHERE id=?", n.id);
  await a.registrarFiscal(await a.lancamento(c.id));
  assert.equal(a.emissor.um("SELECT COUNT(*) AS n FROM notas").n, 1);
  await assert.rejects(a.emissor.emitir({ pagamento: c.id, conta: a.cid }), /já possui registro de nota/);
});

test("falha ao registrar outbox reverte também a alteração financeira da compra", async (t) => {
  const a = await abrir(t), c = await a.nova(); const s = [...a.storages.values()][0], put = s.put;
  s.put = async (k, v) => { if (k.startsWith("financeiro-pendente:")) throw new Error("fila fora"); return put(k, v); };
  await assert.rejects(a.mudar(c.id), /fila fora/); s.put = put;
  assert.equal((await a.get("sub-ana", c.intent_id)).data.compra.estado, "aguardando");
  assert.equal((await a.pendentes()).size, 0);
});

test("registro antigo sem outbox é recuperado na consulta sem mudar versão pública", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  const s = [...a.storages.values()][0], r = await s.get("compra:" + c.id);
  delete r.financeiro_versao; await s.put("compra:" + c.id, r); await s.delete("financeiro-pendente:" + c.id);
  const l = await a.get("sub-ana", c.intent_id); assert.equal(l.data.compra.versao, 2);
  assert.equal((await a.pendentes()).size, 1); await a.rodar(); assert.equal(a.sim.geradas.size, 1);
});

test("fila legada não aceita referência Plantare fora do registro transacional", async (t) => {
  const a = await abrir(t), c = await a.nova();
  assert.equal((await porNaFila(a.env, { id: c.id, cliente: a.cid, valor: 935 })).ok, false);
  assert.equal(await a.fiscal(c.id), null);
});

test("versão nova durante ACK antigo mantém outbox e não inicia emissão desatualizada", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  const original = a.env.CLIENTES; let liberar, iniciou;
  const pronto = new Promise((r) => { iniciou = r; }), espera = new Promise((r) => { liberar = r; });
  a.env.CLIENTES = { idFromName: original.idFromName, get(id) {
    const stub = original.get(id);
    return { async fetch(url, op) {
      const r = await stub.fetch(url, op);
      if (JSON.parse(op.body).op === "plantare_sincronizar") { iniciou(); await espera; }
      return r;
    } };
  } };
  const trabalho = a.rodar(); await pronto; await a.mudar(c.id, "devolvida"); liberar(); await trabalho;
  assert.equal((await a.pendentes()).size, 1); assert.equal(a.sim.geradas.size, 0);
  a.env.CLIENTES = original; await a.rodar();
  assert.equal((await a.pendentes()).size, 0); assert.equal(a.sim.geradas.size, 0);
  assert.equal((await a.registro(c.id)).registro.status, "devolvida");
});

test("conciliação é auditada por versão, exige papel financeiro e não cancela a nota", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id); await a.rodar();
  await a.mudar(c.id, "devolvida"); await a.rodar();
  const antes = await resumoParaPainel(a.env);
  assert.equal(antes.revisoes_fiscais.length, 1); assert.equal(antes.pagamentos.length, 0);
  const url = new URL("https://atos.dev.br" + PREFIXO_NFSE + "plantare/" + c.id + "/conciliar");
  const pedir = (papel, patch = {}) => atenderEmissor(new Request(url, { method: "POST", body: JSON.stringify({
    versao: 3, texto: "Conferência de teste registrada sem alterar o documento.", ...patch,
  }) }), a.env, url, { papel, email: "financeiro@example.test" });
  assert.equal((await pedir("suporte")).status, 403);
  assert.equal((await pedir("financeiro", { versao: 2 })).status, 409);
  assert.equal((await pedir("financeiro")).status, 200);
  assert.equal((await pedir("financeiro")).status, 200);
  assert.equal(a.emissor.um("SELECT COUNT(*) AS n FROM plantare_conciliacoes").n, 1);
  const p = await a.fiscal(c.id);
  assert.equal(p.revisao_fiscal, false); assert.equal(p.conciliacao.quem, "financeiro@example.test");
  assert.equal(p.nota, "emitida"); assert.equal(a.sim.eventos.size, 0);
  assert.equal((await resumoParaPainel(a.env)).revisoes_fiscais.length, 0);
});

test("emissão de Plantare é bloqueada se configuração fiscal aponta para produção", async (t) => {
  const a = await abrir(t), c = await a.nova();
  // Mesmo sem uma liberação fiscal, a guarda adicional recusa produção.
  const prest = a.emissor.prestadorAtual();
  a.emissor.rodar("UPDATE prestador SET dados=? WHERE id=?", JSON.stringify({ ...prest.dados, ambiente: "producao" }), prest.id);
  await a.mudar(c.id); await a.rodar();
  assert.equal(a.sim.geradas.size, 0); assert.notEqual((await a.fiscal(c.id)).nota, "emitida");
  a.env.AMBIENTE = "producao";
  assert.equal((await a.registrarFiscal(await a.lancamento(c.id))).status, 503);
});

test("rodízio financeiro processa mais de 16 compras sem abandonar as últimas", async (t) => {
  const a = await abrir(t, { automatico: false });
  for (let i = 1; i <= 17; i++) { const c = await a.nova(i); await a.mudar(c.id); }
  await a.rodar(); assert.equal((await a.pendentes()).size, 1);
  await a.rodar(); assert.equal((await a.pendentes()).size, 0);
  assert.equal(a.emissor.um("SELECT COUNT(*) AS n FROM plantare_financeiro").n, 17);
  assert.equal(a.sim.geradas.size, 0);
});

test("devolução durante preparação fiscal impede reservar nova DPS após o await", async (t) => {
  const a = await abrir(t), c = await a.nova(); await a.mudar(c.id);
  let liberar, iniciou;
  const pronto = new Promise((r) => { iniciou = r; }), espera = new Promise((r) => { liberar = r; });
  const abrirChave = a.emissor.abrirChave.bind(a.emissor);
  a.emissor.abrirChave = async () => { const k = await abrirChave(); iniciou(); await espera; return k; };
  const trabalho = a.rodar(); await pronto;
  await a.mudar(c.id, "devolvida");
  assert.equal((await a.registrarFiscal(await a.lancamento(c.id))).status, 200);
  liberar(); await trabalho;
  assert.equal(a.emissor.um("SELECT COUNT(*) AS n FROM notas").n, 0);
  assert.equal(a.sim.geradas.size, 0);
  assert.equal((await a.fiscal(c.id)).situacao_financeira, "devolvida");
});
