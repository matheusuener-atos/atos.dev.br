// O DANFSe do Worker (worker/nfse/danfse.js) contra o do PAULUS em Python.
//   node worker/teste-nfse-danfse.mjs
//
// 1. dadosDoXml == nfse.danfse.dados_do_xml, campo a campo, nas NFS-e de
//    worker/nfse/fixtures/danfse.json (refazer com fixtures/gerar_danfse.py)
// 2. a matriz do QR Code == a do reportlab (QrCodeWidget), módulo a módulo,
//    e o endereço == url_qr
// 3. o PDF: uma página A4, os textos do leiaute, o mesmo XML dá o mesmo PDF
// 4. CPU (process.cpuUsage): a 1ª chamada (processo novo) e a média quente;
//    a meta é < 8 ms quente (o pedido do PDF é separado da emissão; o
//    limite é 10 ms)
// A conferência visual (página contra página) é fixtures/comparar_danfse.py.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inflateSync } from "node:zlib";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(AQUI, "nfse", "fixtures", "danfse.json"), "utf8"));

let falhas = 0;
const checar = (ok, descricao, detalhe) => {
  console.log((ok ? "  ok   " : "  FALHA ") + descricao + (ok || detalhe === undefined ? "" : " -> " + JSON.stringify(detalhe).slice(0, 600)));
  if (!ok) falhas++;
};
const cpu = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };

let t0 = performance.now();
const { dadosDoXml, gerarDanfse, urlQr } = await import("./nfse/danfse.js");
const { matrizQr } = await import("./nfse/qr.js");
const carga = performance.now() - t0;

// ------------------------------------------------------------- 1. dados
console.log("1. dadosDoXml == dados_do_xml (Python)");
for (const c of FIX.casos) {
  const js = dadosDoXml(c.xml);
  const dif = Object.keys(c.dados).filter((k) => !isDeepStrictEqual(js[k], c.dados[k]));
  checar(dif.length === 0 && Object.keys(js).length === Object.keys(c.dados).length, c.nome,
    dif.map((k) => ({ campo: k, js: js[k], py: c.dados[k] })));
}
checar(dadosDoXml(new TextEncoder().encode(FIX.casos[0].xml)).chave === FIX.casos[0].dados.chave, "aceita o XML em bytes");
let erro = "";
try {
  dadosDoXml("<?xml version='1.0'?><DPS xmlns=\"http://www.sped.fazenda.gov.br/nfse\"><infDPS/></DPS>");
} catch (e) {
  erro = e.message;
}
checar(/não é de uma NFS-e/.test(erro), "XML que não é NFS-e: erro claro", erro);

// ------------------------------------------------------------- 2. QR
console.log("2. QR Code == reportlab");
const linhas = (q) => Array.from({ length: q.n }, (_, r) => Array.from(q.modulos.slice(r * q.n, (r + 1) * q.n)).join(""));
let qrOk = 0;
for (const c of FIX.casos) if (isDeepStrictEqual(linhas(matrizQr(urlQr(c.dados.chave))), c.qr)) qrOk++;
checar(qrOk === FIX.casos.length, `a matriz do QR da consulta pública é a do Python (${qrOk}/${FIX.casos.length} notas)`);
for (const e of FIX.qr_extras) {
  const q = matrizQr(e.texto);
  checar(isDeepStrictEqual(linhas(q), e.matriz), `QR de "${e.texto.slice(0, 30)}${e.texto.length > 30 ? "..." : ""}" (versão ${q.versao}, máscara ${q.mascara})`);
}
checar(urlQr("123") === "https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=123", "urlQr == url_qr");

// ------------------------------------------------------------- 3. o PDF
console.log("3. o PDF");
const caso = FIX.casos[3];
const pdf = await gerarDanfse(caso.xml);
const texto = Buffer.from(pdf).toString("latin1");
checar(texto.startsWith("%PDF-") && (texto.match(/\/Type \/Page\b/g) || []).length === 1, `PDF de uma página (${pdf.length} bytes)`);
checar(/\/MediaBox \[ 0 0 595\.27\d* 841\.88\d* \]/.test(texto), "A4 retrato");
checar(/\/BaseFont \/Helvetica\b/.test(texto) && /\/BaseFont \/Helvetica-Bold\b/.test(texto) && !/FontFile/.test(texto), "fontes padrão do PDF (Helvetica), nada embutido");
// o conteúdo da página, com os textos em hex WinAnsi
let conteudo = texto;
const m = /stream\r?\n([\s\S]*?)endstream/g;
for (const x of texto.matchAll(m)) if (x[1].includes(" Tj")) conteudo = x[1];
if (/FlateDecode/.test(texto) && !conteudo.includes(" Tj")) conteudo = inflateSync(Buffer.from(conteudo, "latin1")).toString("latin1");
const escritos = [...conteudo.matchAll(/<([0-9a-f]*)> Tj/g)].map((x) => Buffer.from(x[1], "hex").toString("latin1"));
for (const esperado of ["DANFSe v2.0", "NFS-e SEM VALIDADE JURÍDICA", caso.dados.chave, "PRESTADOR / FORNECEDOR", "TRIBUTAÇÃO IBS / CBS",
  caso.dados.total.liquido, caso.dados.tomador.nome, "17.14.01 / -", "R$ 75,00", "Federal 13,45%"]) {
  checar(escritos.some((e) => e.includes(esperado)), `o DANFSe traz "${esperado}"`);
}
const prod = FIX.casos.find((c) => !c.dados.homologacao);
const escritosProd = Buffer.from(await gerarDanfse(prod.xml)).toString("latin1");
checar(!escritosProd.includes(Buffer.from("NFS-e SEM VALIDADE JUR\xcdDICA", "latin1").toString("hex")) && escritosProd.includes(Buffer.from("Produção", "latin1").toString("hex")),
  "em produção, sem o \"SEM VALIDADE JURÍDICA\"");
checar(Buffer.compare(Buffer.from(await gerarDanfse(caso.xml)), Buffer.from(pdf)) === 0, "o mesmo XML dá o mesmo PDF (data da nota, não a de agora)");
const semTomador = FIX.casos.find((c) => c.dados.tomador === null);
checar(Buffer.from(await gerarDanfse(semTomador.xml)).toString("latin1").includes(Buffer.from("TOMADOR/ADQUIRENTE DA OPERA\xc7\xc3O N\xc3O IDENTIFICADO NA NFS-e", "latin1").toString("hex")),
  "sem tomador: o aviso da NT 008");

// ------------------------------------------------------------- 4. CPU
console.log("4. CPU (o pedido do PDF é separado da emissão; limite de 10 ms)");
const xmls = FIX.casos.map((c) => c.xml);
// A 1ª chamada roda num processo novo (isolate frio): o relógio dela.
const { spawnSync } = await import("node:child_process");
const frio = spawnSync(process.execPath, ["--input-type=module", "-e", `
  const { gerarDanfse } = await import(${JSON.stringify(new URL("./nfse/danfse.js", import.meta.url).href)});
  const xml = ${JSON.stringify(caso.xml)};
  const c = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const t = performance.now(); const c0 = c();
  await gerarDanfse(xml);
  console.log(JSON.stringify({ relogio: performance.now() - t, cpu: c() - c0 }));`], { encoding: "utf8" });
const primeira = JSON.parse(frio.stdout || "{}");
const N = 400;
for (let i = 0; i < 50; i++) await gerarDanfse(xmls[i % xmls.length]);
const tempos = [];
const c0 = cpu();
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await gerarDanfse(xmls[i % xmls.length]);
  tempos.push(performance.now() - t);
}
const media = (cpu() - c0) / N;
tempos.sort((a, b) => a - b);
console.log(`  carga do módulo (partida do isolate): ${carga.toFixed(1)} ms`);
console.log(`  1ª chamada (processo novo): relógio ${primeira.relogio?.toFixed(1)} ms`);
console.log(`  quente: CPU média ${media.toFixed(2)} ms | relógio mediana ${tempos[N >> 1].toFixed(2)} ms, p90 ${tempos[Math.floor(N * 0.9)].toFixed(2)} ms`);
checar(media < 8, "DANFSe quente abaixo de 8 ms de CPU (média, nesta máquina)", media);
// A 1ª chamada de um isolate novo roda no interpretador (compilação
// preguiçosa): ~11-13 ms de relógio no node desta máquina, contra ~26 ms do
// esqueleto anterior (pdf-lib com embedFont). Só acontece no 1º PDF de cada
// isolate, num pedido que não é o da emissão.
checar(primeira.relogio < 25, "a 1ª chamada (isolate frio) abaixo de 25 ms de relógio", primeira);

console.log(falhas ? `\n  DANFSe: ${falhas} FALHA(S)` : "\n  DANFSe: todos os testes passaram");
process.exitCode = falhas ? 1 : 0;
