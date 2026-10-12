// A seguranca de cada Conta Atos num Durable Object (SegurancaConta, idFromName(<sub>)): a verificacao em duas etapas
// (o segredo TOTP cifrado e o ultimo passo usado), os codigos de recuperacao (so os resumos), as chaves de acesso (so as
// chaves publicas), a contagem de erros, os desafios do WebAuthn e as "segundas etapas" em andamento. Tudo o que e de
// uso unico (o passo do TOTP, o codigo de recuperacao, o desafio, a etapa) precisa de consistencia forte - o KV nao da
// (uma leitura em outro lugar do mundo pode ver o valor antigo por ate 60 s). Cada objeto atende um pedido de cada vez
// (a fila abaixo), entao conferir e gastar acontecem juntos.
//
// Uma instancia a mais, idFromName("entrar"), guarda so os desafios do "Entrar com chave de acesso" (antes de saber de
// quem e a chave). O Worker de teste tem os proprios objetos.
//
// O Worker fala com o objeto por fetch, {op, ...}; o objeto le os segredos do mesmo env (CONTA_CHAVE_MESTRA).

import { aleatorio, sha256 } from "../comum.js";
import { base32, chaveMestra, cifrar, conferirTotp, decifrar, novosCodigos, novoSegredoTotp, resumoCodigo } from "./totp.js";
import { ErroWebAuthn, conferirAssinatura, conferirCadastro, desafioDe } from "./webauthn.js";

export const TENTATIVAS = 8; // o mesmo limite do login (worker/contas.js)
export const BLOQUEIO_S = 15 * 60;
export const DESAFIO_S = 5 * 60;
export const ETAPA_S = 5 * 60;
export const ETAPA_TENTATIVAS = 5;
const PEND_S = 10 * 60;
export const MAX_CHAVES = 20;

/* O cliente do objeto da conta `nome` (o sub, ou "entrar"). Lanca se o objeto nao responde. */
export function seg(env, nome) {
  const stub = env.SEGURANCA.get(env.SEGURANCA.idFromName(String(nome)));
  return async (op, dados = {}) => {
    const r = await stub.fetch("https://seguranca/", { method: "POST", body: JSON.stringify({ op, ...dados }) });
    const d = await r.json();
    if (!r.ok && !d) throw new Error("o objeto de segurança não respondeu");
    if (d && d.falha) throw new Error(d.falha);
    return d;
  };
}

const VAZIO = { ativa: false, totp: null, recuperacao: null, chaves: [], bloqueado: false };

/* O resumo da seguranca da conta (o que a tela e o login precisam), sem nada secreto. Sem o objeto no Worker, nada
   pode ter sido ligado (tudo mora nele): VAZIO. Lanca se o objeto existe e nao responde (quem chama recusa: nunca
   "sem segunda etapa" por falha). */
export async function resumoDaSeguranca(env, sub, agora = Date.now()) {
  if (!env.SEGURANCA) return VAZIO;
  return seg(env, sub)("resumo", { agora });
}

function publicaDaChave(c) {
  return { id: c.id, nome: c.nome, criada: c.criada, ultimo_uso: c.ultimo_uso || null, sincronizada: Boolean(c.sincronizada), rp: c.rp,
    transportes: c.transportes || [], alerta: c.alerta || null };
}

export class SegurancaConta {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.fila = Promise.resolve();
  }

  async fetch(request) {
    let d;
    try {
      d = await request.json();
    } catch {
      return Response.json({ falha: "pedido inválido" }, { status: 400 });
    }
    const agora = typeof d.agora === "number" ? d.agora : Date.now();
    // Um pedido de cada vez: conferir e gastar (o passo, o codigo, o desafio) sem outro pedido no meio.
    const vez = this.fila.then(() => this.fazer(d, agora));
    this.fila = vez.catch(() => null);
    try {
      return Response.json(await vez);
    } catch (e) {
      return Response.json({ falha: String((e && e.message) || e) }, { status: 500 });
    }
  }

  async reg() {
    const r = await this.ctx.storage.get("reg");
    return r && typeof r === "object" ? { chaves: [], ...r } : { chaves: [] };
  }
  async gravar(r) { await this.ctx.storage.put("reg", r); }

  ativa(r) { return Boolean(r.totp) || (r.chaves || []).length > 0; }

  resumo(r, bloqueado) {
    return {
      ativa: this.ativa(r),
      totp: r.totp ? { desde: r.totp.desde } : null,
      recuperacao: r.rec ? { restantes: r.rec.hashes.length, gerados: r.rec.gerados } : null,
      chaves: (r.chaves || []).map(publicaDaChave),
      bloqueado: Boolean(bloqueado),
    };
  }

  // ------------------------------------------------------------ os erros (o mesmo limite do login)
  async bloqueado(agora) {
    const e = await this.ctx.storage.get("erros");
    return Boolean(e && e.ate > agora && e.n >= TENTATIVAS);
  }
  async errou(agora) {
    let e = await this.ctx.storage.get("erros");
    if (!e || e.ate <= agora) e = { n: 0, ate: agora + BLOQUEIO_S * 1000 };
    e.n++;
    await this.ctx.storage.put("erros", e);
    return e.n >= TENTATIVAS;
  }
  async acertou() { await this.ctx.storage.delete("erros"); }

  // ------------------------------------------------------------ os efemeros (desafios e etapas): uso unico, com prazo
  async limpar(agora) {
    const velhos = [];
    for (const [k, v] of await this.ctx.storage.list({ prefix: "ef:" })) if (!v || v.ate <= agora) velhos.push(k);
    if (velhos.length) await this.ctx.storage.delete(velhos.slice(0, 128));
  }
  async tomar(k, agora) {
    const v = await this.ctx.storage.get(k);
    if (v === undefined) return null;
    await this.ctx.storage.delete(k);
    return v && v.ate > agora ? v : null;
  }

  novosCodigosGuardados(r, sub, agora) {
    return (async () => {
      const codigos = novosCodigos();
      r.rec = { hashes: await Promise.all(codigos.map((c) => resumoCodigo(sub, c))), gerados: new Date(agora).toISOString() };
      return codigos;
    })();
  }

  /* Confere um codigo do aplicativo ou de recuperacao, gastando-o. {ok, metodo, restantes?} ou {ok: false, erro}. */
  async conferirCodigo(r, sub, d, agora) {
    if (await this.bloqueado(agora)) return { ok: false, erro: "bloqueado" };
    if (d.codigo !== undefined && d.codigo !== null && d.codigo !== "") {
      if (!r.totp) return { ok: false, erro: "sem_totp" };
      const segredo = await decifrar(this.env, sub, r.totp.cifra);
      if (!segredo) return { ok: false, erro: "sem_chave" };
      const p = await conferirTotp(segredo, d.codigo, agora, Number.isInteger(r.totp.ultimo) ? r.totp.ultimo : -1);
      if (p < 0) return { ok: false, erro: (await this.errou(agora)) ? "bloqueado" : "codigo" };
      r.totp.ultimo = p;
      await this.gravar(r);
      await this.acertou();
      return { ok: true, metodo: "otp" };
    }
    if (d.recuperacao) {
      if (!r.rec || !r.rec.hashes.length) return { ok: false, erro: (await this.errou(agora)) ? "bloqueado" : "codigo" };
      const h = await resumoCodigo(sub, String(d.recuperacao).slice(0, 40));
      const i = r.rec.hashes.indexOf(h);
      if (i < 0) return { ok: false, erro: (await this.errou(agora)) ? "bloqueado" : "codigo" };
      r.rec.hashes.splice(i, 1);
      await this.gravar(r);
      await this.acertou();
      return { ok: true, metodo: "recuperacao", restantes: r.rec.hashes.length };
    }
    return { ok: false, erro: "vazio" };
  }

  /* Confere a assinatura de uma chave de acesso desta conta. `desafio`: ja tirado do servidor por quem chama. */
  async conferirChave(r, d, desafio, agora) {
    if (await this.bloqueado(agora)) return { ok: false, erro: "bloqueado" };
    const cred = d.credencial;
    const chave = (r.chaves || []).find((c) => cred && c.id === cred.id && c.rp === d.rp);
    if (!chave) return { ok: false, erro: (await this.errou(agora)) ? "bloqueado" : "chave_desconhecida" };
    let v;
    try {
      v = await conferirAssinatura(cred, chave, { desafio, rpId: d.rp, origem: d.origem });
    } catch (e) {
      if (!(e instanceof ErroWebAuthn)) throw e;
      return { ok: false, erro: (await this.errou(agora)) ? "bloqueado" : "chave", motivo: e.motivo };
    }
    chave.contador = v.contador;
    chave.ultimo_uso = new Date(agora).toISOString();
    if (v.regrediu) chave.alerta = { quando: chave.ultimo_uso, motivo: "contador" };
    await this.gravar(r);
    await this.acertou();
    return { ok: true, metodo: "chave", chave: { id: chave.id, nome: chave.nome, sincronizada: Boolean(v.sincronizada) }, regrediu: v.regrediu };
  }

  async fazer(d, agora) {
    const s = this.ctx.storage;
    const sub = String(d.sub || "");
    switch (d.op) {
      case "resumo": {
        return this.resumo(await this.reg(), await this.bloqueado(agora));
      }

      // ---------------------------------------------------- o aplicativo autenticador
      case "totp-iniciar": {
        if (!(await chaveMestra(this.env))) return { ok: false, erro: "indisponivel" };
        const r = await this.reg();
        if (r.totp) return { ok: false, erro: "ja_ligada" };
        const segredo = novoSegredoTotp();
        await s.put("pend-totp", { cifra: await cifrar(this.env, sub, segredo), ate: agora + PEND_S * 1000 });
        return { ok: true, segredo: base32(segredo) };
      }
      case "totp-ligar": {
        if (await this.bloqueado(agora)) return { ok: false, erro: "bloqueado" };
        const r = await this.reg();
        if (r.totp) return { ok: false, erro: "ja_ligada" };
        const pend = await s.get("pend-totp");
        if (!pend || pend.ate <= agora) return { ok: false, erro: "vencido" };
        const segredo = await decifrar(this.env, sub, pend.cifra);
        if (!segredo) return { ok: false, erro: "vencido" };
        const p = await conferirTotp(segredo, d.codigo, agora, -1);
        if (p < 0) return { ok: false, erro: (await this.errou(agora)) ? "bloqueado" : "codigo" };
        r.totp = { cifra: pend.cifra, desde: new Date(agora).toISOString(), ultimo: p };
        const codigos = r.rec ? null : await this.novosCodigosGuardados(r, sub, agora);
        await this.gravar(r);
        await s.delete("pend-totp");
        await this.acertou();
        return { ok: true, codigos, resumo: this.resumo(r) };
      }
      case "totp-desligar": {
        const r = await this.reg();
        if (!r.totp) return { ok: false, erro: "sem_totp" };
        const c = await this.conferirCodigo(r, sub, d, agora);
        if (!c.ok) return c;
        delete r.totp;
        if (!this.ativa(r)) delete r.rec;
        await this.gravar(r);
        return { ok: true, metodo: c.metodo, resumo: this.resumo(r) };
      }
      case "rec-gerar": {
        const r = await this.reg();
        if (!this.ativa(r)) return { ok: false, erro: "inativa" };
        const codigos = await this.novosCodigosGuardados(r, sub, agora);
        await this.gravar(r);
        return { ok: true, codigos, resumo: this.resumo(r) };
      }

      // ---------------------------------------------------- os desafios do WebAuthn (uso unico, 5 minutos)
      case "desafio": {
        await this.limpar(agora);
        const desafio = aleatorio(32);
        await s.put("ef:d:" + desafio, { fim: String(d.fim || ""), ate: agora + DESAFIO_S * 1000 });
        return { ok: true, desafio };
      }
      case "desafio-tomar": {
        const v = typeof d.desafio === "string" && d.desafio.length <= 200 ? await this.tomar("ef:d:" + d.desafio, agora) : null;
        return { ok: Boolean(v && v.fim === d.fim) };
      }

      // ---------------------------------------------------- as chaves de acesso
      case "chave-registrar": {
        const r = await this.reg();
        if ((r.chaves || []).length >= MAX_CHAVES) return { ok: false, erro: "muitas" };
        const desafio = desafioDe(d.credencial || {});
        const v = desafio ? await this.tomar("ef:d:" + desafio, agora) : null;
        if (!v || v.fim !== "registro") return { ok: false, erro: "desafio" };
        let c;
        try {
          c = await conferirCadastro(d.credencial, { desafio, rpId: d.rp, origem: d.origem });
        } catch (e) {
          if (!(e instanceof ErroWebAuthn)) throw e;
          return { ok: false, erro: "invalida", motivo: e.motivo };
        }
        if ((r.chaves || []).some((x) => x.id === c.id)) return { ok: false, erro: "repetida" };
        const nova = { id: c.id, nome: String(d.nome || "Chave de acesso").slice(0, 60), criada: new Date(agora).toISOString(), ultimo_uso: null, alg: c.alg,
          jwk: c.jwk, contador: c.contador, rp: d.rp, sincronizada: c.sincronizada, transportes: c.transportes };
        r.chaves = [...(r.chaves || []), nova];
        const codigos = r.rec ? null : await this.novosCodigosGuardados(r, sub, agora);
        await this.gravar(r);
        return { ok: true, chave: publicaDaChave(nova), codigos, resumo: this.resumo(r) };
      }
      case "chave-conferir": {
        // O "Entrar com chave de acesso": o desafio ja saiu do objeto "entrar" (quem chama confere e tira).
        const r = await this.reg();
        return this.conferirChave(r, d, String(d.desafio || ""), agora);
      }
      case "chave-remover": {
        const r = await this.reg();
        const antes = r.chaves || [];
        const c = antes.find((x) => x.id === d.id);
        if (!c) return { ok: false, erro: "nao_existe" };
        r.chaves = antes.filter((x) => x.id !== d.id);
        if (!this.ativa(r)) delete r.rec;
        await this.gravar(r);
        return { ok: true, nome: c.nome, resumo: this.resumo(r) };
      }

      // ---------------------------------------------------- a equipe da Atos (painel, Contas Atos; worker/admin-contas.js)
      case "equipe-zerar": {
        // O atendimento de quem perdeu o aplicativo, os codigos e as chaves: a equipe (so o dono, com o motivo, depois de
        // conferir a identidade fora do painel) desliga a verificacao em duas etapas. Sai tudo: o aplicativo, os codigos
        // de recuperacao, as chaves de acesso, o aplicativo pela metade, os erros e as etapas e desafios em andamento.
        const r = await this.reg();
        const tinha = { totp: Boolean(r.totp), codigos: r.rec ? r.rec.hashes.length : 0, chaves: (r.chaves || []).map((c) => ({ id: c.id, nome: c.nome })) };
        if (!this.ativa(r) && !r.rec) return { ok: false, erro: "inativa" };
        delete r.totp;
        delete r.rec;
        r.chaves = [];
        await this.gravar(r);
        await s.delete("pend-totp");
        await this.acertou();
        const efemeros = [...(await s.list({ prefix: "ef:" })).keys()];
        for (let i = 0; i < efemeros.length; i += 128) await s.delete(efemeros.slice(i, i + 128));
        return { ok: true, tinha, resumo: this.resumo(r) };
      }

      // ---------------------------------------------------- a segunda etapa do login
      case "etapa-criar": {
        await this.limpar(agora);
        const token = aleatorio(32);
        await s.put("ef:e:" + (await sha256(token)), { dados: d.dados, tentativas: 0, ate: agora + ETAPA_S * 1000 });
        return { ok: true, token };
      }
      case "etapa-ver": {
        const k = "ef:e:" + (await sha256(String(d.token || "")));
        const e = await s.get(k);
        if (!e || e.ate <= agora) return { ok: false, erro: "vencida" };
        const r = await this.reg();
        let publicKey = null;
        const chaves = (r.chaves || []).filter((c) => c.rp === d.rp);
        if (d.rp && chaves.length) {
          await this.limpar(agora);
          const desafio = aleatorio(32);
          await s.put("ef:d:" + desafio, { fim: k, ate: agora + DESAFIO_S * 1000 });
          publicKey = { desafio, chaves: chaves.map((c) => ({ id: c.id, transportes: c.transportes || [] })) };
        }
        return { ok: true, metodos: { otp: Boolean(r.totp), recuperacao: Boolean(r.rec && r.rec.hashes.length), chave: chaves.length > 0 }, publicKey, dados: e.dados };
      }
      case "etapa-concluir": {
        const k = "ef:e:" + (await sha256(String(d.token || "")));
        const e = await s.get(k);
        if (!e || e.ate <= agora) return { ok: false, erro: "vencida" };
        const r = await this.reg();
        let c;
        if (d.credencial) {
          const desafio = desafioDe(d.credencial);
          const v = desafio ? await this.tomar("ef:d:" + desafio, agora) : null;
          c = v && v.fim === k ? await this.conferirChave(r, d, desafio, agora) : { ok: false, erro: "desafio" };
        } else {
          c = await this.conferirCodigo(r, sub, d, agora);
        }
        if (c.ok) {
          await s.delete(k);
          return { ...c, dados: e.dados };
        }
        if (c.erro === "vazio") return c;
        e.tentativas = (e.tentativas || 0) + 1;
        if (e.tentativas >= ETAPA_TENTATIVAS || c.erro === "bloqueado") {
          await s.delete(k);
          return { ...c, morta: true };
        }
        await s.put(k, e);
        return c;
      }
      default:
        return { ok: false, erro: "op desconhecida" };
    }
  }
}
