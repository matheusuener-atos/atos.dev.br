// Roda os exemplos de cada linguagem contra a Atos de verdade (o Worker de C:\atos em `wrangler dev`, com contas,
// sessoes e o aplicativo fabricados no KV local: pacotes/entrar/teste/atos-local.mjs) e confere, como um navegador:
//   /entrar -> a Atos (com a sessao de joao, liberado) -> a volta -> o exemplo troca o codigo, confere o id_token e le
//   o userinfo -> a pagina mostra o sub, o nome e o e-mail; e com pedro (nao liberado) -> error=access_denied -> 403.
//
//   node exemplos/entrar-com-atos/testar.mjs --python <python do venv com authlib e flask> --dotnet <EntrarComAtos.dll>
//     --node <pasta com express e express-session>
// So roda as linguagens passadas. As dependencias ficam onde quem roda escolher (um venv, o NUGET_PACKAGES).
import { spawn, spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { subirAtos, portaLivre, PESSOAS } from "../../pacotes/entrar/teste/atos-local.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((l, a, i, t) => (a.startsWith("--") ? [...l, [a.slice(2), t[i + 1]]] : l), []));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const LINGUAGENS = {
  python: (porta) => ({
    caminho: "/retorno",
    cmd: [args.python, [join(AQUI, "python", "app.py")]],
    env: { FLASK_SECRET_KEY: "chave-do-teste-" + porta },
  }),
  // --node: uma pasta com express e express-session instalados; o servidor.mjs e o entrar.js (o pacote) sao copiados para la.
  node: (porta) => ({
    caminho: "/auth/atos/retorno",
    cmd: [process.execPath, [join(args.node, "servidor.mjs")]],
    env: { SESSION_SECRET: "sessao-do-teste-" + porta },
    antes: async () => {
      await copyFile(join(AQUI, "node", "servidor.mjs"), join(args.node, "servidor.mjs"));
      await copyFile(join(AQUI, "..", "..", "pacotes", "entrar", "index.js"), join(args.node, "entrar.js"));
    },
  }),
  dotnet: (porta) => ({
    caminho: "/signin-oidc",
    cmd: ["dotnet", [args.dotnet, "--urls", "http://127.0.0.1:" + porta]],
    env: { ASPNETCORE_ENVIRONMENT: "Production", DOTNET_NOLOGO: "1" },
  }),
};
const escolhidas = Object.keys(LINGUAGENS).filter((l) => args[l]);
if (!escolhidas.length) {
  console.log("Passe ao menos uma: --python <exe>, --dotnet <dll>, --node <pasta>");
  process.exit(2);
}

/* Um navegador minimo: os cookies de cada site e os redirecionamentos, um a um. */
function navegador() {
  const potes = new Map();
  return async function ir(url, { seguir = true, max = 10 } = {}) {
    let atual = url;
    for (let i = 0; i <= max; i++) {
      const u = new URL(atual);
      const pote = potes.get(u.host) || new Map();
      potes.set(u.host, pote);
      const r = await fetch(atual, { redirect: "manual", headers: { cookie: [...pote].map(([k, v]) => k + "=" + v).join("; ") } });
      for (const c of r.headers.getSetCookie()) {
        const [par] = c.split(";");
        const k = par.slice(0, par.indexOf("=")).trim();
        const v = par.slice(par.indexOf("=") + 1);
        if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === "") pote.delete(k); else pote.set(k, v);
      }
      const destino = r.headers.get("location");
      if (!seguir || !destino || r.status < 300 || r.status >= 400) return { r, url: atual, corpo: await r.text() };
      atual = new URL(destino, atual).toString();
    }
    throw new Error("redirecionamentos demais");
  };
}

const portas = Object.fromEntries(await Promise.all(escolhidas.map(async (l) => [l, await portaLivre()])));
const SEGREDOS = Object.fromEntries(escolhidas.map((l) => [l, "segredo-" + l + "-" + Math.random().toString(36).slice(2)]));
const sufixo = { python: "python", dotnet: "dotnet", node: "nodejs" };
const atos = await subirAtos({
  clientes: Object.fromEntries(escolhidas.map((l) => [sufixo[l], { tipo: "confidencial", voltas: ["http://127.0.0.1:" + portas[l] + LINGUAGENS[l](portas[l]).caminho], segredo: SEGREDOS[l] }])),
});

let falhas = 0;
const checar = (ok, texto, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + texto + (ok || detalhe === undefined ? "" : " -> " + String(detalhe).slice(0, 600)));
  if (!ok) falhas++;
};

try {
  for (const l of escolhidas) {
    const porta = portas[l];
    const def = LINGUAGENS[l](porta);
    const base = "http://127.0.0.1:" + porta;
    console.log(l + " (" + base + ")");
    const env = {
      ...process.env, ...def.env,
      ATOS_ISSUER: atos.emissor, ATOS_CLIENT_ID: atos.ids[sufixo[l]], ATOS_CLIENT_SECRET: SEGREDOS[l], ATOS_REDIRECT_URI: base + def.caminho,
    };
    if (def.antes) await def.antes();
    const filho = spawn(def.cmd[0], def.cmd[1], { env, stdio: ["ignore", "pipe", "pipe"] });
    let saida = "";
    filho.stdout.on("data", (d) => { saida += d; });
    filho.stderr.on("data", (d) => { saida += d; });
    try {
      const limite = Date.now() + 60000;
      for (;;) {
        try { if ((await fetch(base + "/", { redirect: "manual" })).status < 500) break; } catch { /* subindo */ }
        if (filho.exitCode !== null || Date.now() > limite) throw new Error("o exemplo nao subiu:\n" + saida);
        await esperar(300);
      }
      // joao, liberado
      let ir = navegador();
      let r = await ir(base + "/entrar", { seguir: false });
      const ida = new URL(r.r.headers.get("location") || "", base);
      checar(r.r.status === 302 && ida.origin + ida.pathname === atos.emissor + "/entrar", "/entrar leva à Atos", r.r.status + " " + ida);
      checar(ida.searchParams.get("code_challenge_method") === "S256" && /^[A-Za-z0-9_-]{43}$/.test(ida.searchParams.get("code_challenge") || "") &&
        ida.searchParams.get("nonce") && ida.searchParams.get("state") && ida.searchParams.get("response_type") === "code", "com PKCE S256, state, nonce e response_type=code", ida.search);
      const volta = await atos.navegador(ida.toString(), "joao");
      r = await ir(volta);
      const p = PESSOAS.joao;
      checar(r.r.status === 200 && r.corpo.includes(p.sub) && r.corpo.includes(p.email) && r.corpo.includes(p.nome), "joão entra: o sub, o e-mail e o nome chegam", r.r.status + " " + r.corpo + "\n" + saida.slice(-1500));
      // pedro, nao liberado: a Atos volta com access_denied e o exemplo mostra a mensagem
      ir = navegador();
      r = await ir(base + "/entrar", { seguir: false });
      const voltaNegada = await atos.navegador(new URL(r.r.headers.get("location"), base).toString(), "pedro");
      checar(new URL(voltaNegada).searchParams.get("error") === "access_denied", "pedro: a Atos volta com error=access_denied", voltaNegada);
      r = await ir(voltaNegada);
      checar(r.r.status === 403 && /não tem acesso/.test(r.corpo), "pedro: o exemplo mostra que a conta não tem acesso (403)", r.r.status + " " + r.corpo + "\n" + saida.slice(-1500));
    } catch (e) {
      checar(false, l + " rodou até o fim", e.stack);
    } finally {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(filho.pid), "/T", "/F"], { stdio: "ignore" });
      else filho.kill();
    }
  }
} finally {
  await atos.parar();
}
console.log(falhas ? falhas + " falha(s)" : "tudo ok");
process.exit(falhas ? 1 : 0);
