// O botaoEntrarComAtos do @atos.dev.br/entrar: o HTML do botao oficial (as classes da folha botao.css, os tres textos, o
// icone, o escape do href e as recusas), e que o "A" e a folha sao os mesmos de public/marca/. Sem rede.
//   node --test teste/botao.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { botaoEntrarComAtos, ErroAtos } from "../index.js";

const MARCA = new URL("../../../public/marca/", import.meta.url);

test("o padrão: claro, médio, Entrar com Atos, sem estilo inline nem script", () => {
  const h = botaoEntrarComAtos({ href: "/entrar" });
  assert.match(h, /^<a class="atos-entrar atos-entrar--claro atos-entrar--medio" href="\/entrar">/);
  assert.match(h, /<span class="atos-entrar__texto">Entrar com Atos<\/span><\/a>$/);
  assert.match(h, /aria-hidden="true"/);
  assert.doesNotMatch(h, /style=|<script|on[a-z]+=/i);
});

test("os temas, os tamanhos e os textos", () => {
  for (const tema of ["claro", "escuro", "neutro"]) for (const tamanho of ["grande", "medio", "pequeno"]) {
    const h = botaoEntrarComAtos({ tema, tamanho, href: "/x" });
    assert.ok(h.includes("atos-entrar--" + tema + " atos-entrar--" + tamanho), tema + " " + tamanho);
  }
  assert.ok(botaoEntrarComAtos({ texto: "continuar" }).includes(">Continuar com Atos<"));
  assert.ok(botaoEntrarComAtos({ texto: "criar-conta" }).includes(">Criar conta com Atos<"));
  const icone = botaoEntrarComAtos({ icone: true, largo: true });
  assert.ok(icone.includes("atos-entrar--icone") && !icone.includes("atos-entrar--largo") && icone.includes(">Entrar com Atos<"), "o ícone guarda o texto para leitores de tela");
  assert.ok(botaoEntrarComAtos({ largo: true }).includes("atos-entrar--largo"));
});

test("o href e o id saem escapados; javascript: é recusado", () => {
  const h = botaoEntrarComAtos({ href: '/entrar?a=1&b="2"', id: "x\"y" });
  assert.ok(h.includes('href="/entrar?a=1&amp;b=&quot;2&quot;"') && h.includes('id="x&quot;y"'));
  for (const href of ["javascript:alert(1)", " JavaScript:x", "data:text/html,x", "vbscript:x"]) {
    assert.throws(() => botaoEntrarComAtos({ href }), (e) => e instanceof ErroAtos && e.codigo === "configuracao", href);
  }
});

test("tema, tamanho e texto fora da lista são recusados", () => {
  for (const o of [{ tema: "azul" }, { tamanho: "enorme" }, { texto: "Entrar com Google" }, { texto: "toString" }]) {
    assert.throws(() => botaoEntrarComAtos(o), (e) => e instanceof ErroAtos && e.codigo === "configuracao", JSON.stringify(o));
  }
});

test("o A e a folha são os mesmos de atos.dev.br/marca/", async () => {
  const marca = await readFile(new URL("atos-marca.svg", MARCA), "utf8");
  const d = /<path[^>]* d="([^"]+)"/.exec(marca)[1];
  assert.ok(botaoEntrarComAtos().includes('d="' + d + '"'), "o caminho do A");
  const css = await readFile(new URL("botao.css", MARCA), "utf8");
  assert.equal(await readFile(new URL("../botao.css", import.meta.url), "utf8"), css, "pacotes/entrar/botao.css = public/marca/botao.css");
  assert.ok(css.includes('d="' + d + '"'), "o exemplo da folha usa o mesmo A");
  assert.doesNotMatch(css, /url\(|@import|border-radius:\s*[1-9]/, "sem dependência e com cantos retos");
});
