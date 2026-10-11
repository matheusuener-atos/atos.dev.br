// Gera, a partir de public/assets/integrar-linguagens.js (a fonte unica dos trechos de cada linguagem):
//   - a secao "Na sua linguagem" de public/integracao/index.html (entre <!-- linguagens:inicio --> e <!-- linguagens:fim -->);
//   - os exemplos testados de exemplos/entrar-com-atos/ (python/app.py, dotnet/Program.cs, node/servidor.mjs);
//   - a copia do pacote servida pela Atos: public/pacotes/entrar/0.1.0/entrar.js (= pacotes/entrar/index.js).
//
//   node tools/integracao-linguagens.mjs            grava
//   node tools/integracao-linguagens.mjs --conferir so confere (worker/teste-linguagens.mjs faz o mesmo)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await import("../public/assets/integrar-linguagens.js");
const L = globalThis.IntegrarLinguagens;

const INICIO = "<!-- linguagens:inicio -->";
const FIM = "<!-- linguagens:fim -->";
// Os marcadores da pagina publica (quem le troca pelos dados do proprio acesso).
export const MARCADORES = { clientId: "SEU_CLIENT_ID", volta: "https://seusistema.com.br/retorno", ambos: true };

const lf = (s) => String(s).replace(/\r\n/g, "\n");

/* {caminho relativo: conteudo esperado} */
export async function arquivosGerados() {
  const l = L.lista({ confidencial: true });
  const codigo = (id) => l.find((x) => x.id === id).codigo || l.find((x) => x.id === id).codigos[0].texto;
  const pagina = lf(await readFile(join(RAIZ, "public/integracao/index.html"), "utf8"));
  const i = pagina.indexOf(INICIO);
  const f = pagina.indexOf(FIM);
  if (i < 0 || f < i) throw new Error("public/integracao/index.html sem os marcadores " + INICIO + " e " + FIM);
  const secao = INICIO + "\n" + L.linguagensHtml(MARCADORES, "pg-ling") + "\n" + FIM;
  return {
    "public/integracao/index.html": pagina.slice(0, i) + secao + pagina.slice(f + FIM.length),
    "exemplos/entrar-com-atos/python/app.py": codigo("python"),
    "exemplos/entrar-com-atos/dotnet/Program.cs": codigo("dotnet"),
    // O exemplo testado roda com a copia do pacote ao lado (testar.mjs), sem npm install: o import aponta para ela.
    "exemplos/entrar-com-atos/node/servidor.mjs": codigo("js").replace('from "@atos.dev.br/entrar"', 'from "./entrar.js"'),
    "public/pacotes/entrar/0.1.0/entrar.js": lf(await readFile(join(RAIZ, "pacotes/entrar/index.js"), "utf8")),
  };
}

/* Os que estao diferentes do esperado (ou faltam). */
export async function diferentes() {
  const fora = [];
  for (const [rel, esperado] of Object.entries(await arquivosGerados())) {
    let atual = null;
    try { atual = lf(await readFile(join(RAIZ, rel), "utf8")); } catch { atual = null; }
    if (atual !== esperado) fora.push(rel);
  }
  return fora;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--conferir")) {
    const fora = await diferentes();
    console.log(fora.length ? "fora de dia: " + fora.join(", ") : "tudo em dia");
    process.exit(fora.length ? 1 : 0);
  }
  for (const [rel, conteudo] of Object.entries(await arquivosGerados())) {
    await mkdir(dirname(join(RAIZ, rel)), { recursive: true });
    await writeFile(join(RAIZ, rel), conteudo);
    console.log("gravado " + rel);
  }
}
