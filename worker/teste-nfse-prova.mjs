// Prova técnica: o emissor de NFS-e do Padrão Nacional dentro do Worker.
//   node worker/teste-nfse-prova.mjs
//
// Compara com o emissor de referência em Python (paulus/legal/src/nfse), pelas
// fixtures de worker/nfse/fixtures (refazer com fixtures/gerar.py):
//   1. lerPfx: titular, documento (CN e otherName ICP-Brasil), validade, senha errada
//   2. assinatura XMLDSig: o XML assinado em JS é IDÊNTICO byte a byte ao do Python
//   3. gzip+base64: ida e volta, contra o gzip do Python
//   4. custo de CPU (process.cpuUsage) de cada passo e do DANFSe (NT 008)
// O limite do plano grátis do Worker é 10 ms de CPU por pedido.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIX = join(AQUI, "nfse", "fixtures");

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe)));
  if (!ok) falhas++;
};

// No Windows o process.cpuUsage anda em degraus de ~15,6 ms: uma chamada só
// não se mede por ele. A CPU vem da média de N chamadas (o cpuUsage é do
// processo inteiro, então conta também as threads do WebCrypto e do zlib);
// a 1ª chamada (fria) e a mediana vêm do relógio (performance.now), que
// numa máquina parada é ~ a CPU de uma operação síncrona.
const cpu = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };
async function medir(fn, n = 200) {
  let t = performance.now();
  await fn();
  const primeira = performance.now() - t;
  const tempos = [];
  const c0 = cpu();
  for (let i = 0; i < n; i++) {
    t = performance.now();
    await fn();
    tempos.push(performance.now() - t);
  }
  const media = (cpu() - c0) / n;
  tempos.sort((a, b) => a - b);
  return { primeira, media, mediana: tempos[Math.floor(n / 2)], p90: tempos[Math.floor(n * 0.9)] };
}
const fmt = (m) => `CPU média ${m.media.toFixed(2)} ms | relógio: 1ª ${m.primeira.toFixed(1)} ms, mediana ${m.mediana.toFixed(2)} ms, p90 ${m.p90.toFixed(2)} ms`;
const custos = {};

// Carga dos módulos (no Worker, isto é a partida do isolate, não o pedido).
let t = performance.now();
const { lerPfx, ErroCertificado } = await import("./nfse/pfx.js");
custos.carga_forge = performance.now() - t;
t = performance.now();
const { assinar, importarChave } = await import("./nfse/assinatura.js");
const { gzipB64, deGzipB64 } = await import("./nfse/gzip.js");
custos.carga_assinatura = performance.now() - t;
t = performance.now();
const { gerarDanfse } = await import("./nfse/danfse.js");
const NFSE = JSON.parse(readFileSync(join(FIX, "danfse.json"), "utf8")).casos[3].xml;
custos.carga_pdflib = performance.now() - t;

const dados = JSON.parse(readFileSync(join(FIX, "dps.json"), "utf8"));
const pfxCn = readFileSync(join(FIX, "a1-cn.pfx"));
const pfxLegado = readFileSync(join(FIX, "a1-legado.pfx"));

// ------------------------------------------------------------- 1. o .pfx
console.log("1. ler o .pfx");
const cert = lerPfx(pfxCn, dados.senha);
checar(cert.titular === "ESCRITORIO DE TESTE LTDA", "titular do CN, sem o \":CNPJ\"", cert.titular);
checar(cert.documento === dados.cnpj, "CNPJ do CN \"NOME:CNPJ\"", cert.documento);
checar(/^\d{4}-\d\d-\d\dT/.test(cert.validoAte) && Date.parse(cert.validoAte) > Date.now(), "validade (ISO, no futuro)", cert.validoAte);
checar(cert.certPem.startsWith("-----BEGIN CERTIFICATE-----") && Array.isArray(cert.cadeiaPem), "certificado em PEM e cadeia (vazia: autoassinado)");
checar(cert.chavePkcs8 instanceof Uint8Array && cert.chavePkcs8[0] === 0x30, "chave privada em PKCS#8 DER", cert.chavePkcs8.length);
const ecnpj = lerPfx(readFileSync(join(FIX, "a1-ecnpj.pfx")), dados.senha);
checar(ecnpj.documento === dados.cnpj && ecnpj.titular === "ESCRITORIO OID LTDA", "e-CNPJ: CNPJ do otherName 2.16.76.1.3.3", ecnpj);
const ecpf = lerPfx(readFileSync(join(FIX, "a1-ecpf.pfx")), dados.senha);
checar(ecpf.documento === dados.cpf, "e-CPF: CPF do otherName 2.16.76.1.3.1 (posições 9-19)", ecpf.documento);
const legado = lerPfx(pfxLegado, dados.senha);
checar(legado.documento === dados.cnpj, "pfx no formato do Windows (3DES, MAC SHA-1) também abre");
for (const [nome, bytes, senha] of [["senha errada", pfxCn, "errada"], ["senha vazia", pfxCn, ""], ["arquivo que não é pfx", new TextEncoder().encode("isto não é um certificado"), "x"]]) {
  let erro = null;
  try { lerPfx(bytes, senha); } catch (e) { erro = e; }
  checar(erro instanceof ErroCertificado && erro.message === "senha do certificado incorreta, ou arquivo inválido", `${nome}: erro claro`, erro && erro.message);
}

// --------------------------------------------------------- 2. assinatura
console.log("2. assinar a DPS (byte a byte com o Python)");
for (const c of dados.dps) {
  const chave = await importarChave(cert.chavePkcs8, c.algoritmo);
  const js = new TextEncoder().encode(await assinar(Buffer.from(c.xml_b64, "base64"), chave, cert.certDer, c.id, c.algoritmo));
  const py = Buffer.from(c.assinado_b64, "base64");
  const iguais = Buffer.compare(Buffer.from(js), py) === 0;
  checar(iguais, `DPS caso ${c.caso} (${c.algoritmo}): ${js.length} bytes, idêntica à do Python`, iguais ? undefined : { js: js.length, py: py.length });
}
// Assinar de novo um XML já assinado troca a Signature (como o Python).
{
  const c = dados.dps[0];
  const chave = await importarChave(cert.chavePkcs8, "sha1");
  const de_novo = await assinar(Buffer.from(c.assinado_b64, "base64"), chave, cert.certDer, c.id, "sha1");
  checar(Buffer.from(de_novo).equals(Buffer.from(c.assinado_b64, "base64")), "reassinar um XML assinado dá o mesmo XML (a Signature velha sai)");
  let erro = null;
  try { await assinar(Buffer.from(c.xml_b64, "base64"), chave, cert.certDer, "DPSnaoexiste"); } catch (e) { erro = e; }
  checar(erro && /único elemento com Id/.test(erro.message), "Id inexistente: erro claro", erro && erro.message);
  erro = null;
  try { await assinar("<?xml version='1.0'?><!DOCTYPE x [<!ENTITY a 'b'>]><x Id='1'>&a;</x>", chave, cert.certDer, "1"); } catch (e) { erro = e; }
  checar(erro && /DOCTYPE/.test(erro.message), "DOCTYPE/entidade recusado (como resolve_entities=False)", erro && erro.message);
}

// ------------------------------------------------------- 3. gzip+base64
console.log("3. gzip + base64");
for (const c of dados.dps) {
  const xml = Buffer.from(c.assinado_b64, "base64");
  const js = await gzipB64(xml);
  checar(gunzipSync(Buffer.from(js, "base64")).equals(xml), `caso ${c.caso}: o gzip do JS abre no zlib e devolve o XML`);
  checar(Buffer.from(await deGzipB64(c.gzip_b64_python)).equals(xml), `caso ${c.caso}: o gzip do Python abre no JS`);
}
checar(Buffer.from(await deGzipB64(dados.resposta_gzip_b64)).equals(Buffer.from(dados.resposta_xml_b64, "base64")), "resposta embrulhada pelo Python desembrulha igual");
// Conferência cruzada no próprio Python (se o venv estiver na máquina).
const PY = "C:/coryphaeus/paulus/legal/venv/Scripts/python.exe";
if (existsSync(PY)) {
  const xml = Buffer.from(dados.dps[1].assinado_b64, "base64");
  const arq = join(tmpdir(), "paulus-gzip-js.txt");
  writeFileSync(arq, await gzipB64(xml));
  const r = spawnSync(PY, ["-c", `import sys,hashlib;sys.path.insert(0,r'${"C:/coryphaeus/paulus/legal/src"}');from nfse.cliente import de_gzip_b64;print(hashlib.sha256(de_gzip_b64(open(r'${arq}').read())).hexdigest())`], { encoding: "utf8" });
  const { createHash } = await import("node:crypto");
  checar(r.stdout.trim() === createHash("sha256").update(xml).digest("hex"), "cliente.de_gzip_b64 (Python) abre o gzip do JS", r.stderr.slice(-300));
}

// ------------------------------------------------------------- 4. custos
console.log("4. custo de CPU");
const c0 = dados.dps[1];
const xml0 = Buffer.from(c0.xml_b64, "base64");
custos.lerPfx_aes_pbkdf2_20000 = await medir(() => lerPfx(pfxCn, dados.senha), 10);
custos.lerPfx_3des_2048 = await medir(() => lerPfx(pfxLegado, dados.senha), 40);
custos.importKey = await medir(() => importarChave(cert.chavePkcs8, "sha1"));
const chaveSha1 = await importarChave(cert.chavePkcs8, "sha1");
custos.assinar = await medir(() => assinar(xml0, chaveSha1, cert.certDer, c0.id, "sha1"));
custos.importKey_e_assinar = await medir(async () => assinar(xml0, await importarChave(cert.chavePkcs8, "sha1"), cert.certDer, c0.id, "sha1"));
const assinado0 = Buffer.from(c0.assinado_b64, "base64");
custos.gzipB64 = await medir(() => gzipB64(assinado0));
custos.deGzipB64 = await medir(() => deGzipB64(c0.gzip_b64_python));
let pdf;
custos.danfse = await medir(async () => { pdf = await gerarDanfse(NFSE); }, 100);
checar(pdf.length > 1000 && Buffer.from(pdf.slice(0, 5)).toString() === "%PDF-", `DANFSe (NT 008): PDF de ${pdf.length} bytes`);
writeFileSync(join(tmpdir(), "danfse-nt008.pdf"), pdf);

console.log(`  carga dos módulos (partida do isolate): forge ${custos.carga_forge.toFixed(1)} ms, assinatura+gzip ${custos.carga_assinatura.toFixed(1)} ms, pdf-lib ${custos.carga_pdflib.toFixed(1)} ms`);
for (const k of ["lerPfx_aes_pbkdf2_20000", "lerPfx_3des_2048", "importKey", "assinar", "importKey_e_assinar", "gzipB64", "deGzipB64", "danfse"]) {
  console.log(`  ${k.padEnd(26)} ${fmt(custos[k])}`);
}
const pedidoEmitir = custos.importKey_e_assinar.media + custos.gzipB64.media + custos.deGzipB64.media;
console.log(`  emitir (importKey+assinar+gzip+degzip), CPU média: ${pedidoEmitir.toFixed(2)} ms de CPU`);
console.log(`  emitir + DANFSe, CPU média: ${(pedidoEmitir + custos.danfse.media).toFixed(2)} ms de CPU`);

// ------------------------------------- 5. no workerd (opcional, local)
// Com --workerd <url> (npx wrangler dev worker/nfse/entrada-prova.js), o
// mesmo caminho roda no runtime do Worker: confere SHA-1/SHA-256 no
// crypto.subtle de lá, o CompressionStream e o pdf-lib.
const iw = process.argv.indexOf("--workerd");
if (iw > 0) {
  const base = process.argv[iw + 1];
  console.log(`5. no workerd (${base})`);
  for (const [arquivo, c] of [["a1-cn.pfx", dados.dps[0]], ["a1-legado.pfx", dados.dps[1]], ["a1-cn.pfx", dados.dps[3]]]) {
    const pfx = readFileSync(join(FIX, arquivo));
    const r = await fetch(`${base}/api/nfse-prova`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pfx_b64: pfx.toString("base64"), senha: dados.senha, xml_b64: c.xml_b64, id: c.id, algoritmo: c.algoritmo, nfse_b64: Buffer.from(NFSE).toString("base64") }),
    });
    const d = await r.json();
    // O legado tem a MESMA chave do a1-cn (gerar.py reembrulha), então a assinatura também é a mesma.
    checar(d.assinado_b64 === c.assinado_b64, `workerd, ${arquivo}, caso ${c.caso} (${c.algoritmo}): assinado idêntico ao do Python`, d.erro || d.assinado_b64?.length);
    checar(d.volta_ok && gunzipSync(Buffer.from(d.gzip_b64 || "", "base64")).equals(Buffer.from(c.assinado_b64, "base64")), `workerd: gzip ida e volta`);
    checar(d.pdf_bytes > 1000 && d.documento === dados.cnpj, `workerd: DANFSe (${d.pdf_bytes} bytes) e documento do certificado`);
  }
  const r = await fetch(`${base}/api/nfse-prova`, { method: "POST", body: JSON.stringify({ pfx_b64: pfxCn.toString("base64"), senha: "errada", xml_b64: "", id: "x" }) });
  checar(r.status === 400 && (await r.json()).erro === "senha do certificado incorreta, ou arquivo inválido", "workerd: senha errada, erro claro");
}

console.log(falhas ? `\n  ${falhas} falha(s)` : "\n  prova do emissor no Worker: todos os testes passaram");
// exitCode em vez de process.exit: no Windows, sair à força com o fetch do
// undici aberto derruba o node numa asserção da libuv.
process.exitCode = falhas ? 1 : 0;
