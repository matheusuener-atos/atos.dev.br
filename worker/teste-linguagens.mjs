// Teste do "Entrar com Atos" em cada linguagem (public/assets/integrar-linguagens.js) e do emissor local:
//   - a pagina /integracao/, os exemplos testados (exemplos/entrar-com-atos/) e o entrar.js servido pela Atos estao
//     iguais a fonte (tools/integracao-linguagens.mjs --conferir);
//   - o emissor e sempre https://atos.dev.br, menos com ATOS_EMISSOR_LOCAL num endereco desta maquina (o `wrangler dev`
//     dos testes do pacote e dos exemplos); a descoberta e o iss da volta seguem o mesmo;
//   - os trechos e os comandos do .env: sem segredo, aspas seguras, sem estilo ou script inline no HTML. Sem rede.
//   node worker/teste-linguagens.mjs
// (Os comandos do .env rodam de verdade em exemplos/entrar-com-atos/testar-env.mjs; os exemplos, em testar.mjs; o pacote,
// em pacotes/entrar: npm test.)
import worker from "./index.js";
import { EMISSOR, emissorDe, sha256 } from "./comum.js";
import { diferentes, MARCADORES } from "../tools/integracao-linguagens.mjs";

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 600)));
  if (!ok) falhas++;
};
const L = globalThis.IntegrarLinguagens;

console.log("a fonte unica");
const fora = await diferentes();
checar(fora.length === 0, "a página, os exemplos testados e o entrar.js servido estão iguais à fonte (rode node tools/integracao-linguagens.mjs)", fora);

console.log("o emissor");
checar(emissorDe({}) === EMISSOR && EMISSOR === "https://atos.dev.br", "sem a var: https://atos.dev.br");
checar(emissorDe({ ATOS_EMISSOR_LOCAL: "http://127.0.0.1:8787" }) === "http://127.0.0.1:8787" && emissorDe({ ATOS_EMISSOR_LOCAL: "http://localhost:51234" }) === "http://localhost:51234",
  "com a var num endereço desta máquina: ele");
for (const ruim of ["https://outro.example", "http://127.0.0.1", "http://127.0.0.1:8787/", "http://127.0.0.2:8787", "http://127.0.0.1.evil.com:80", "https://127.0.0.1:8787", "javascript:alert(1)"]) {
  checar(emissorDe({ ATOS_EMISSOR_LOCAL: ruim }) === EMISSOR, "outro valor é ignorado: " + ruim);
}

const guardados = new Map();
const CONTAS = {
  get: async (k, tipo) => { const v = guardados.get(k) ?? null; return v !== null && tipo === "json" ? JSON.parse(v) : v; },
  put: async (k, v) => { guardados.set(k, v); },
  delete: async (k) => { guardados.delete(k); },
};
globalThis.fetch = async (u) => { throw new Error("fetch inesperado: " + u); };
const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", par.privateKey)), kid: "k" };
const LOCAL = "http://127.0.0.1:8787";
const envProd = { CONTAS, ATOS_CHAVE: JSON.stringify(jwk), ASSETS: { fetch: async () => new Response("x") } };
const envLocal = { ...envProd, ATOS_EMISSOR_LOCAL: LOCAL };
const descoberta = async (env, base) => (await worker.fetch(new Request(base + "/.well-known/openid-configuration"), env)).json();
let d = await descoberta(envProd, "https://atos.dev.br");
checar(d.issuer === EMISSOR && d.token_endpoint === EMISSOR + "/oauth/token", "a descoberta de produção diz https://atos.dev.br", d);
d = await descoberta(envLocal, LOCAL);
checar(d.issuer === LOCAL && d.jwks_uri === LOCAL + "/oauth/jwks" && d.authorization_endpoint === LOCAL + "/entrar", "no wrangler dev com a var: a descoberta diz o endereço local", d);

// O iss da volta e o do id_token seguem o emissor (o cliente fixo do PAVLVS, loopback, com a sessao fabricada).
const email = "ana@exemplo.test";
guardados.set("id:conta:" + email, JSON.stringify({ sub: "sub-ana", nome: "Ana" }));
guardados.set("atos:sessao:" + (await sha256("s-ana")), JSON.stringify({ sub: "sub-ana", email, auth_time: Math.floor(Date.now() / 1000) }));
const verifier = "v".repeat(43);
const desafio = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
const volta = "http://127.0.0.1:5000/retorno";
const consulta = new URLSearchParams({ client_id: "pavlvs-app", redirect_uri: volta, response_type: "code", scope: "openid email", state: "st", nonce: "nn",
  code_challenge: desafio, code_challenge_method: "S256" }).toString();
const r = await worker.fetch(new Request(LOCAL + "/api/autorizar", { method: "POST", headers: { origin: LOCAL, cookie: "__Host-atos=s-ana", "content-type": "application/json" },
  body: JSON.stringify({ consulta, permitir: true }) }), envLocal);
const ir = new URL((await r.json()).ir);
checar(ir.searchParams.get("iss") === LOCAL && ir.searchParams.get("code"), "a volta traz iss = o emissor local", ir.toString());
const t = await (await worker.fetch(new Request(LOCAL + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: ir.searchParams.get("code"), redirect_uri: volta, client_id: "pavlvs-app", code_verifier: verifier }).toString() }), envLocal)).json();
const corpo = t.id_token ? JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url")) : {};
checar(corpo.iss === LOCAL, "o id_token traz iss = o emissor local", t);

console.log("os trechos");
const v = { emissor: EMISSOR, clientId: "u-abcdefghij-klmnop", volta: "https://seusistema.com.br/retorno", confidencial: true };
const lista = L.lista(v);
checar(lista.map((l) => l.id).join(",") === "js,python,dotnet,php,java,go,ruby", "as sete linguagens, as testadas primeiro", lista.map((l) => l.id));
checar(lista.filter((l) => l.testado).map((l) => l.id).join(",") === "js,python,dotnet", "testadas: JavaScript, Python e C#/.NET; as outras dizem que não", lista.map((l) => [l.id, l.testado]));
checar(lista.filter((l) => !l.testado).every((l) => /Não testado aqui/.test(l.nota) && /Não testado aqui/.test(l.codigo)), "as não testadas dizem isso na nota e no próprio código");
checar(lista.every((l) => !/npm install @atos\/entrar(?!\))/.test(l.instalar.replace(/em breve: npm install @atos\/entrar\)/, ""))), "ninguém manda npm install @atos/entrar como se já existisse");
checar(/em breve/.test(lista[0].instalar) && lista[0].instalar.includes(L.PACOTE), "o JavaScript diz 'em breve no npm' e onde baixar o arquivo", lista[0].instalar);
const pub = L.lista({ clientId: 'u-x"y', volta: "https://a/b", confidencial: false })[0].codigos[0].texto;
checar(pub.includes('clientId: "u-x\\"y"') && pub.includes("atos.entrar()"), "o de navegador põe o client_id com aspas seguras", pub);
const html = L.linguagensHtml(MARCADORES, "t") + L.envHtml(v, "t2");
checar(!/\sstyle=|<script|\son[a-z]+=/i.test(html), "o HTML das abas sem estilo, script ou evento inline");
checar((html.match(/role="tabpanel"/g) || []).length === 9 && (html.match(/ hidden>/g) || []).length === 7, "7 + 2 painéis, só o primeiro de cada grupo aberto");
checar((html.match(/não testado<\/span>/g) || []).length === 4, "quatro abas marcadas 'não testado'");

console.log("o comando do .env");
for (const tipo of ["ps", "sh"]) {
  const c = L.comandoEnv(v, tipo);
  checar(c.includes("ATOS_ISSUER") && c.includes("ATOS_CLIENT_ID") && c.includes("ATOS_REDIRECT_URI") && c.includes("ATOS_CLIENT_SECRET=") && c.includes(".gitignore"),
    tipo + ": grava as três, a linha vazia do segredo e confere o .gitignore");
  checar(!/(curl|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)[^\n]*\|\s*(sh|bash|iex|Invoke-Expression)/i.test(c) && !/Invoke-Expression|\biex\b|\beval\b|source /.test(c), tipo + ": não executa nada baixado");
  checar(!/ATOS_CLIENT_SECRET=[^'"\s)]/.test(c), tipo + ": nunca põe um valor de segredo");
  const semConf = L.comandoEnv({ ...v, confidencial: false }, tipo);
  checar(semConf.includes(tipo === "ps" ? "$confidencial = $false" : "conf=0"), tipo + ": acesso público com a linha do segredo desligada");
}
const aspas = { ...v, volta: "https://a/b'; rm -rf ~; echo '" };
checar(L.comandoEnv(aspas, "sh").includes("volta='https://a/b'\\''; rm -rf ~; echo '\\'''"), "sh: aspa simples na volta fica dentro das aspas");
checar(L.comandoEnv(aspas, "ps").includes("ATOS_REDIRECT_URI = 'https://a/b''; rm -rf ~; echo '''"), "ps: aspa simples na volta fica dentro das aspas");

console.log(falhas ? "\n" + falhas + " FALHA(S)" : "\ntudo ok");
process.exit(falhas ? 1 : 0);
