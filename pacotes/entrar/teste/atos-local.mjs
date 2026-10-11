// A Atos de verdade numa porta desta maquina, para os testes do @atos.dev.br/entrar e dos exemplos de cada linguagem
// (exemplos/entrar-com-atos/testar.mjs): o Worker de C:\atos em `wrangler dev`, com o KV num diretorio temporario e,
// nele, as contas, as sessoes e um aplicativo de terceiro fabricados como os testes do worker/ fazem. A chave que
// assina os id_token e gerada aqui (os testes a usam para forjar tokens validos com campos errados).
//
//   const atos = await subirAtos({ clientes: { publico: {...}, confidencial: {...} } });
//   atos.emissor                    http://127.0.0.1:<porta>
//   await atos.navegador(url, "joao")  faz o que a pagina /entrar faz com a sessao de joao e devolve o endereco de volta
//   await atos.parar()
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const APP_ID = "u-exemplo001";
export const PESSOAS = {
  maria: { email: "maria@exemplo.test", nome: "Maria Exemplo", sub: "sub-maria-exemplo" }, // a dona do aplicativo
  joao: { email: "joao@exemplo.test", nome: "João Exemplo", sub: "sub-joao-exemplo" }, // liberado
  pedro: { email: "pedro@exemplo.test", nome: "Pedro Exemplo", sub: "sub-pedro-exemplo" }, // NAO liberado
};

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (t) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export function portaLivre() {
  return new Promise((ok, falha) => {
    const s = createServer();
    s.once("error", falha);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

/* npx e um .cmd no Windows: precisa do shell, com a linha ja montada (os argumentos aqui sao caminhos e opcoes, sem aspas). */
const linhaNpx = (args) => (process.platform === "win32" ? ["npx " + args.map((a) => '"' + a + '"').join(" "), []] : ["npx", args]);
function npx(args, opcoes = {}) {
  const [cmd, resto] = linhaNpx(args);
  return spawn(cmd, resto, { cwd: RAIZ, shell: process.platform === "win32", ...opcoes });
}

/**
 * clientes: { <sufixo de 6 letras>: { tipo: "publico"|"confidencial", voltas?: [..], loopback?: bool, origens?: [..], segredo?: "..." } }
 * O client_id fica APP_ID + "-" + sufixo.
 */
export async function subirAtos({ clientes, liberados = [PESSOAS.joao.email], acesso = "liberados" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "atos-local-"));
  const porta = await portaLivre();
  const emissor = "http://127.0.0.1:" + porta;

  const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const chave = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "atos-local-" + porta };

  const agoraS = Math.floor(Date.now() / 1000);
  const kv = [];
  const cookies = {};
  for (const [quem, p] of Object.entries(PESSOAS)) {
    kv.push({ key: "id:conta:" + p.email, value: JSON.stringify({ sub: p.sub, nome: p.nome, email: p.email }) });
    const segredo = "sessao-" + quem + "-" + hex(crypto.getRandomValues(new Uint8Array(16)));
    kv.push({ key: "atos:sessao:" + (await sha256(segredo)), value: JSON.stringify({ sub: p.sub, email: p.email, auth_time: agoraS }) });
    cookies[quem] = "__Host-atos=" + segredo;
  }
  const ids = {};
  const doApp = {};
  for (const [suf, c] of Object.entries(clientes || {})) {
    const id = APP_ID + "-" + suf;
    ids[suf] = id;
    doApp[id] = { tipo: c.tipo, voltas: c.voltas || [], loopback: c.loopback === true, origens: c.origens || [], ativo: true, criado: new Date((agoraS - 60) * 1000).toISOString() };
    if (c.tipo === "confidencial") kv.push({ key: "atos:oidc:segredo:" + id, value: JSON.stringify({ hash: await sha256(c.segredo), quando: new Date().toISOString(), por: PESSOAS.maria.email }) });
  }
  const app = {
    id: APP_ID, nome: "Sistema de Exemplo", descricao: "o exemplo dos testes", site: "https://exemplo.test", privacidade: "https://exemplo.test/privacidade",
    termos: "https://exemplo.test/termos", icone: "", criado: new Date((agoraS - 60) * 1000).toISOString(), dono: { sub: PESSOAS.maria.sub, email: PESSOAS.maria.email },
    acesso, liberados, bloqueado: null, clientes: doApp,
  };
  kv.push({ key: "atos:oidc:app:" + APP_ID, value: JSON.stringify(app) });
  kv.push({ key: "atos:oidc:dono:" + PESSOAS.maria.sub, value: JSON.stringify([APP_ID]) });
  const origens = Object.values(doApp).flatMap((c) => c.origens);
  kv.push({ key: "atos:oidc:terceiros", value: JSON.stringify({ [APP_ID]: { nome: app.nome, email: PESSOAS.maria.email, origens, bloqueado: false } }) });

  const arquivoKv = join(dir, "kv.json");
  await writeFile(arquivoKv, JSON.stringify(kv));
  const arquivoEnv = join(dir, "vars.env");
  await writeFile(arquivoEnv, "ATOS_CHAVE='" + JSON.stringify(chave) + "'\nATOS_EMISSOR_LOCAL=" + emissor + "\n");
  const estado = join(dir, "estado");
  // A configuracao do Worker de C:tos (o mesmo codigo e as mesmas paginas), sem o limite por endereco (os testes
  // trocam mais de 10 codigos por minuto), sem os Workers auxiliares e sem o Cron, com um KV so local.
  const original = await readFile(join(RAIZ, "wrangler.jsonc"), "utf8");
  const config = {
    name: "atos-local", main: join(RAIZ, "worker", "index.js"), compatibility_date: /"compatibility_date":\s*"([^"]+)"/.exec(original)[1],
    assets: { directory: join(RAIZ, "public"), binding: "ASSETS", html_handling: "auto-trailing-slash", not_found_handling: "none", run_worker_first: true },
    kv_namespaces: [{ binding: "CONTAS", id: "atos-local-contas" }],
    durable_objects: { bindings: [{ name: "CLIENTES", class_name: "ClienteCobranca" }, { name: "EMISSOR_NFSE", class_name: "EmissorNFSe" }] },
    migrations: [{ tag: "v1-clientes-cobranca", new_sqlite_classes: ["ClienteCobranca"] }, { tag: "v2-emissor-nfse", new_sqlite_classes: ["EmissorNFSe"] }],
    vars: { APP_URL: "https://atos.dev.br" },
  };
  const arquivoConfig = join(dir, "wrangler.json");
  await writeFile(arquivoConfig, JSON.stringify(config, null, 2));

  const put = spawnSync(...linhaNpx(["wrangler", "kv", "bulk", "put", arquivoKv, "--binding", "CONTAS", "--local", "--persist-to", estado, "--config", arquivoConfig]), { cwd: RAIZ, shell: process.platform === "win32", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  if (put.status !== 0) throw new Error("wrangler kv bulk put falhou: " + put.stderr + put.stdout);

  const filho = npx(["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(porta), "--persist-to", estado, "--config", arquivoConfig, "--env-file", arquivoEnv,
    "--show-interactive-dev-session=false", "--log-level", "warn"], { stdio: ["ignore", "pipe", "pipe"] });
  let saida = "";
  filho.stdout.on("data", (d) => { saida += d; });
  filho.stderr.on("data", (d) => { saida += d; });

  async function parar() {
    if (filho.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(filho.pid), "/T", "/F"], { stdio: "ignore" });
      else filho.kill("SIGTERM");
    }
    for (let i = 0; i < 20; i++) {
      try { await rm(dir, { recursive: true, force: true }); return; } catch { await esperar(250); }
    }
  }

  const limite = Date.now() + 120000;
  for (;;) {
    try {
      const r = await fetch(emissor + "/.well-known/openid-configuration");
      if (r.ok && (await r.json()).issuer === emissor) break;
    } catch { /* ainda subindo */ }
    if (filho.exitCode !== null || Date.now() > limite) {
      await parar();
      throw new Error("o wrangler dev nao subiu:\n" + saida);
    }
    await esperar(500);
  }

  /* O que a pagina /entrar faz com a sessao de `quem` (o pedido e, na primeira vez, o permitir): o endereco de volta. */
  async function navegador(urlDeIda, quem, { permitir = true } = {}) {
    const u = new URL(urlDeIda);
    if (u.origin + u.pathname.replace(/\/$/, "") !== emissor + "/entrar") throw new Error("a ida nao e para a Atos: " + urlDeIda);
    const consulta = u.search.slice(1);
    const chamar = async (caminho, corpo) => {
      const r = await fetch(emissor + caminho, { method: "POST", headers: { origin: emissor, cookie: cookies[quem], "content-type": "application/json" }, body: JSON.stringify(corpo) });
      return { status: r.status, d: await r.json() };
    };
    let r = await chamar("/api/pedido", { consulta });
    if (r.d.ir) return r.d.ir;
    if (r.d.negado) return r.d.voltar; // a pagina mostra "sem acesso" e o botao de voltar ao aplicativo
    if (r.status !== 200) throw new Error("/api/pedido " + r.status + " " + JSON.stringify(r.d));
    r = await chamar("/api/autorizar", { consulta, permitir });
    if (r.d.ir) return r.d.ir;
    if (r.d.voltar) return r.d.voltar;
    throw new Error("/api/autorizar " + r.status + " " + JSON.stringify(r.d));
  }

  /* Assina um JWT com a chave da Atos local (para forjar tokens validos com campos errados). */
  async function assinar(corpo, cab = { alg: "ES256", typ: "JWT", kid: chave.kid }, chavePrivada = par.privateKey) {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const dados = b(cab) + "." + b(corpo);
    const s = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chavePrivada, new TextEncoder().encode(dados));
    return dados + "." + Buffer.from(s).toString("base64url");
  }

  return { emissor, porta, ids, cookies, chave, navegador, assinar, parar, saida: () => saida };
}
