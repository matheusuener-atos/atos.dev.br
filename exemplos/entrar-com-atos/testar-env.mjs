// Roda de verdade os comandos que gravam o .env (os do cartao "Como integrar"; public/assets/integrar-linguagens.js,
// comandoEnv) em cada shell que existir nesta maquina: Windows PowerShell 5.1, PowerShell 7 e bash (o do Git, no
// Windows). Numa pasta temporaria por caso: .env que nao existe, .env com outras chaves (e com CRLF), rodar duas
// vezes, o segredo que ja estava, git com e sem o .env no .gitignore, a descoberta de outro emissor e o acesso
// publico. A descoberta vem de um servidor local que responde como a Atos; com --real, tambem contra
// https://atos.dev.br (so le a descoberta).
//   node exemplos/entrar-com-atos/testar-env.mjs [--real]
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

await import("../../public/assets/integrar-linguagens.js");
const L = globalThis.IntegrarLinguagens;

const SHELLS = [];
if (process.platform === "win32") {
  const ps51 = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(ps51)) SHELLS.push({ nome: "Windows PowerShell 5.1", tipo: "ps", exe: ps51 });
  const pwsh = spawnSync("where", ["pwsh"], { encoding: "utf8" });
  if (pwsh.status === 0) SHELLS.push({ nome: "PowerShell 7", tipo: "ps", exe: pwsh.stdout.split(/\r?\n/)[0].trim() });
  for (const b of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) if (existsSync(b)) { SHELLS.push({ nome: "bash (Git)", tipo: "sh", exe: b }); break; }
} else {
  SHELLS.push({ nome: "bash", tipo: "sh", exe: "bash" });
  if (spawnSync("pwsh", ["-v"]).status === 0) SHELLS.push({ nome: "PowerShell 7", tipo: "ps", exe: "pwsh" });
}

// Uma "Atos" que so responde a descoberta (como a de verdade: JSON com 2 espacos).
let emissorFalso = "";
let issuerDaDescoberta = "";
const servidor = createServer((req, res) => {
  if (req.url === "/.well-known/openid-configuration") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ issuer: issuerDaDescoberta, authorization_endpoint: issuerDaDescoberta + "/entrar" }, null, 2));
  } else { res.writeHead(404); res.end(); }
});
await new Promise((ok) => servidor.listen(0, "127.0.0.1", ok));
emissorFalso = "http://127.0.0.1:" + servidor.address().port;
issuerDaDescoberta = emissorFalso;

let falhas = 0;
const checar = (ok, texto, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + texto + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 900)));
  if (!ok) falhas++;
};

async function rodar(shell, v, dir) {
  const cmd = L.comandoEnv(v, shell.tipo);
  let r;
  if (shell.tipo === "ps") {
    // O que se cola no console vira um .ps1 (com BOM: o 5.1 le o arquivo sem BOM como ANSI).
    const arq = join(dir, "..", "colar-" + Math.random().toString(36).slice(2) + ".ps1");
    await writeFile(arq, "\uFEFF" + cmd + "\n", "utf8");
    r = await executar(shell.exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", arq], dir);
    await rm(arq, { force: true });
  } else {
    r = await executar(shell.exe, ["-c", cmd], dir);
  }
  return r;
}
/* Sem bloquear: o servidor da descoberta roda neste mesmo processo. */
function executar(exe, args, cwd) {
  return new Promise((ok) => {
    const f = spawn(exe, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let saida = "";
    f.stdout.on("data", (d) => { saida += d; });
    f.stderr.on("data", (d) => { saida += d; });
    const t = setTimeout(() => f.kill(), 60000);
    f.on("close", (status) => { clearTimeout(t); ok({ status, saida }); });
  });
}
const ler = async (dir) => (existsSync(join(dir, ".env")) ? readFile(join(dir, ".env"), "utf8") : null);
const git = (dir, ...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
const AVISO = /no \.gitignore/; // a saida do PowerShell vem na pagina de codigo do console: so o trecho sem acento

const base = await mkdtemp(join(tmpdir(), "atos-env-"));
const CONF = { emissor: emissorFalso, clientId: "u-exemplo001-servid", volta: "https://seusistema.com.br/retorno", confidencial: true };
try {
  for (const sh of SHELLS) {
    console.log(sh.nome + " (" + sh.exe + ")");
    let n = 0;
    const pasta = async () => { const d = join(base, sh.tipo + "-" + SHELLS.indexOf(sh) + "-" + n++); await import("node:fs/promises").then((f) => f.mkdir(d)); return d; };
    issuerDaDescoberta = emissorFalso;

    // 1. sem .env, sem git, sem .gitignore
    let d = await pasta();
    let r = await rodar(sh, CONF, d);
    let t = await ler(d);
    const esperado = ["ATOS_ISSUER=" + emissorFalso, "ATOS_CLIENT_ID=u-exemplo001-servid", "ATOS_REDIRECT_URI=https://seusistema.com.br/retorno"];
    const linhas = (t || "").split(/\r?\n/);
    checar(r.status === 0 && esperado.every((l) => linhas.includes(l)) && linhas.includes("ATOS_CLIENT_SECRET=") && /^# ATOS_CLIENT_SECRET: cole/m.test(t) && t.endsWith("\n") && !t.startsWith("\uFEFF"),
      ".env que não existia: as três chaves, o comentário e ATOS_CLIENT_SECRET= vazio (UTF-8 sem BOM)", { r, t });
    checar(/segredo do acesso u-exemplo001-servid \(a Atos o mostra uma vez só\)/.test(t), "os acentos do comentário chegam inteiros ao .env", t);
    checar(AVISO.test(r.saida), "avisa que o .env não está no .gitignore (sem git)", r.saida);
    // rodar de novo: nada muda
    r = await rodar(sh, CONF, d);
    checar(r.status === 0 && (await ler(d)) === t, "rodar duas vezes não duplica nem muda nada", { r, depois: await ler(d), t });

    // 2. .env com outras chaves, CRLF, o client_id antigo e o segredo ja colado; .gitignore com .env
    d = await pasta();
    const antes = ["# do projeto", "DATABASE_URL=postgres://x", "export ATOS_CLIENT_ID=antigo", "ATOS_CLIENT_SECRET=ja-colado", "OUTRA=1"].join("\r\n") + "\r\n";
    await writeFile(join(d, ".env"), antes);
    await writeFile(join(d, ".gitignore"), "node_modules/\n.env\n");
    r = await rodar(sh, CONF, d);
    t = await ler(d);
    const l2 = t.split("\r\n");
    checar(r.status === 0 && t.includes("DATABASE_URL=postgres://x\r\n") && t.includes("OUTRA=1\r\n") && t.startsWith("# do projeto\r\n") &&
      l2.includes("export ATOS_CLIENT_ID=u-exemplo001-servid") && !t.includes("antigo") && l2.includes("ATOS_CLIENT_SECRET=ja-colado") &&
      (t.match(/ATOS_CLIENT_SECRET=/g) || []).length === 1 && (t.match(/ATOS_CLIENT_ID=/g) || []).length === 1 && !/^# ATOS_CLIENT_SECRET/m.test(t) &&
      !/[^\r]\n/.test(t), ".env com outras chaves: mantém as outras e o segredo, atualiza o client_id no lugar, não duplica e mantém o CRLF", { r, t });
    checar(!AVISO.test(r.saida), "com .env no .gitignore, não avisa", r.saida);
    r = await rodar(sh, CONF, d);
    checar((await ler(d)) === t, "de novo: igual", await ler(d));

    // 3. num repositorio git: sem o .env ignorado avisa; com, nao
    d = await pasta();
    git(d, "init", "-q");
    r = await rodar(sh, CONF, d);
    checar(r.status === 0 && AVISO.test(r.saida), "git sem .env no .gitignore: avisa", r.saida);
    await writeFile(join(d, ".gitignore"), ".env*\n");
    r = await rodar(sh, CONF, d);
    checar(r.status === 0 && !AVISO.test(r.saida), "git com .env* no .gitignore: não avisa", r.saida);

    // 4. a descoberta diz outro emissor: nada gravado
    d = await pasta();
    issuerDaDescoberta = "https://outro.example";
    r = await rodar(sh, CONF, d);
    checar((await ler(d)) === null && /Nada foi gravado/.test(r.saida), "descoberta de outro emissor: nada gravado e diz por quê", { r });
    issuerDaDescoberta = emissorFalso;
    // e a Atos fora do ar
    d = await pasta();
    r = await rodar(sh, { ...CONF, emissor: "http://127.0.0.1:9" }, d);
    checar((await ler(d)) === null && /Nada foi gravado/.test(r.saida), "Atos fora do ar: nada gravado", { r });

    // 5. acesso publico: sem a linha do segredo
    d = await pasta();
    r = await rodar(sh, { ...CONF, clientId: "u-exemplo001-pagina", confidencial: false }, d);
    t = await ler(d);
    checar(r.status === 0 && t.includes("ATOS_CLIENT_ID=u-exemplo001-pagina") && !t.includes("ATOS_CLIENT_SECRET"), "acesso público: sem ATOS_CLIENT_SECRET", { r, t });

    // 6. contra a Atos de verdade (so a descoberta)
    if (process.argv.includes("--real")) {
      d = await pasta();
      r = await rodar(sh, { ...CONF, emissor: "https://atos.dev.br" }, d);
      t = await ler(d);
      checar(r.status === 0 && (t || "").includes("ATOS_ISSUER=https://atos.dev.br"), "contra https://atos.dev.br: grava", { r, t });
    }
  }
} finally {
  servidor.close();
  await rm(base, { recursive: true, force: true });
}
console.log(falhas ? falhas + " falha(s)" : "tudo ok (" + SHELLS.map((s) => s.nome).join(", ") + ")");
process.exit(falhas ? 1 : 0);
