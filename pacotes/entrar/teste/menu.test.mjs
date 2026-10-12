// O menu de conta do @atos.dev.br/entrar (0.5.0): o HTML de menuContaAtos em cada estado (antes de entrar, com menu, sem
// menu, links), as marcas, os atalhos so para o dono, o Sair (POST do site, nunca da Atos), o escape e as recusas, e que a
// folha e a coroa sao as mesmas de atos.dev.br/marca/. O comportamento (setas, Esc, confirmacao) e conferido no navegador.
//   node --test teste/menu.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { menuContaAtos, ligarMenuContaAtos, botaoEntrarComAtos, ErroAtos } from "../index.js";

const MARCA = new URL("../../../public/marca/", import.meta.url);
const semInline = (h) => assert.doesNotMatch(h, /style=|<script|\son[a-z]+=/i);

test("antes de entrar: só o botão Entrar, com a marca", () => {
  const h = menuContaAtos({ entrar: "/entrar" });
  assert.match(h, /^<div class="atos-menu atos-menu--claro atos-menu--menu" data-atos-menu><a class="atos-menu__entrar" href="\/entrar">/);
  assert.ok(h.includes('<span class="atos-menu__rotulo">Entrar</span>') && h.includes("atos-menu__marca"));
  assert.ok(!h.includes("Sair") && !h.includes('role="menu"'));
  semInline(h);
  // Sem menu, antes de entrar, é o mesmo Entrar.
  assert.ok(menuContaAtos({ menu: false }).includes(">Entrar</span>"));
});

test("com menu: o e-mail no botão e o menu com Sair (POST para o sair do site)", () => {
  const h = menuContaAtos({ email: "ana@exemplo.com", sair: "/sair", tema: "escuro", id: "m1" });
  assert.ok(h.includes('aria-haspopup="menu" aria-expanded="false" aria-controls="m1"'));
  assert.ok(h.includes('<span class="atos-menu__email">ana@exemplo.com</span>'));
  assert.ok(h.includes('id="m1" role="menu"') && h.includes(" hidden>"));
  assert.ok(h.includes('<form class="atos-menu__form" method="post" action="/sair" role="none"><button type="submit" class="atos-menu__item atos-menu__item--sair" data-atos-sair role="menuitem" tabindex="-1">Sair</button></form>'));
  assert.ok(!h.includes("Minha conta") && !h.includes("Workspace") && !h.includes("atos.dev.br"), "no site de terceiro: só o e-mail e Sair");
  assert.ok(h.includes("atos-menu--escuro"));
  semInline(h);
});

test("os atalhos Minha conta e Workspace só ao dono, e só se o site pedir", () => {
  const dono = menuContaAtos({ email: "d@x.com", dono: true, atalhosDoDono: true });
  assert.ok(dono.includes('href="https://atos.dev.br/conta/">Minha conta</a>') && dono.includes('href="https://atos.dev.br/workspace/">Workspace</a>'));
  assert.ok(dono.indexOf("Workspace") < dono.indexOf("Sair"), "antes do Sair");
  assert.ok(!menuContaAtos({ email: "d@x.com", dono: false, atalhosDoDono: true }).includes("Workspace"), "quem não é o dono não vê");
  assert.ok(!menuContaAtos({ email: "d@x.com", dono: "true", atalhosDoDono: true }).includes("Workspace"), "só dono === true");
  assert.ok(!menuContaAtos({ email: "d@x.com", dono: true }).includes("Workspace"), "o site não pediu");
  assert.ok(menuContaAtos({ email: "d@x.com", dono: true, atalhosDoDono: true, links: true }).includes(">Workspace</a>"), "também nos links");
});

test("sem menu: um botão Sair só, sem e-mail; links: os itens soltos e Sair", () => {
  const b = menuContaAtos({ menu: false, email: "ana@exemplo.com", sair: "/sair" });
  assert.ok(b.includes("atos-menu--botao") && b.includes("atos-menu__entrar--sair") && b.includes(">Sair</span>"));
  assert.ok(!b.includes("ana@exemplo.com") && !b.includes('role="menu"'));
  const l = menuContaAtos({ links: true, email: "ana@exemplo.com", itens: [{ rotulo: "Pedidos", href: "/pedidos" }] });
  assert.match(l, /^<nav class="atos-menu atos-menu--claro atos-menu--links" data-atos-menu aria-label="Conta">/);
  assert.ok(l.includes('<a class="atos-menu__link" href="/pedidos">Pedidos</a>') && l.includes("atos-menu__link--sair"));
});

test("as marcas: o A, a coroa (a mesma do kit) e nenhuma", async () => {
  const coroa = await readFile(new URL("atos-coroa.svg", MARCA), "utf8");
  const d = /<path[^>]* d="([^"]+)"/.exec(coroa)[1];
  const h = menuContaAtos({ marca: "coroa", email: "a@b.c" });
  assert.ok(h.includes('d="' + d + '"') && h.includes('fill="currentColor"'), "a coroa de atos.dev.br/marca/atos-coroa.svg");
  const escura = await readFile(new URL("atos-coroa-escura.svg", MARCA), "utf8");
  assert.equal(/<path[^>]* d="([^"]+)"/.exec(escura)[1], d, "a escura é a mesma coroa");
  const a = await readFile(new URL("atos-marca.svg", MARCA), "utf8");
  assert.ok(menuContaAtos({}).includes('d="' + /<path[^>]* d="([^"]+)"/.exec(a)[1] + '"'), "o A");
  const sem = menuContaAtos({ marca: "nenhuma", email: "a@b.c" });
  assert.ok(!sem.includes("atos-menu__marca") && sem.includes("atos-menu--sem-marca"));
});

test("escape e recusas", () => {
  const h = menuContaAtos({ email: '<b>"x"@y.z', sair: '/sair?a=1&b="2"', itens: [{ rotulo: "<i>", href: "/a?b=<c>" }] });
  assert.ok(h.includes("&lt;b&gt;&quot;x&quot;@y.z") && h.includes('action="/sair?a=1&amp;b=&quot;2&quot;"') && h.includes("&lt;i&gt;"));
  for (const o of [{ marca: "b" }, { tema: "neutro" }, { entrar: "javascript:alert(1)" }, { email: "a@b.c", sair: " JavaScript:x" },
    { email: "a@b.c", itens: [{ rotulo: "x", href: "data:text/html,x" }] }, { email: "a@b.c", itens: [{ href: "/x" }] }]) {
    assert.throws(() => menuContaAtos(o), (e) => e instanceof ErroAtos && e.codigo === "configuracao", JSON.stringify(o));
  }
  // sair como funcao: o form sem action (o ligarMenuContaAtos chama a funcao).
  assert.ok(menuContaAtos({ email: "a@b.c", sair: () => {} }).includes('<form class="atos-menu__form" method="post" role="none">'));
});

test("ligarMenuContaAtos fora do navegador avisa", () => {
  assert.throws(() => ligarMenuContaAtos(null, {}), (e) => e instanceof ErroAtos && e.codigo === "configuracao");
});

test("o texto curto do botão: só Entrar", () => {
  assert.ok(botaoEntrarComAtos({ texto: "curto" }).includes('<span class="atos-entrar__texto">Entrar</span>'));
});

test("a folha do menu é a mesma de atos.dev.br/marca/menu.css, sem dependência e com cantos retos", async () => {
  const css = await readFile(new URL("menu.css", MARCA), "utf8");
  assert.equal(await readFile(new URL("../menu.css", import.meta.url), "utf8"), css, "pacotes/entrar/menu.css = public/marca/menu.css");
  assert.doesNotMatch(css, /url\(|@import|border-radius:\s*[1-9]/);
});

test("o kit tem os SVG do texto curto e a coroa, e o arquivos.json lista", async () => {
  const lista = JSON.parse(await readFile(new URL("arquivos.json", MARCA), "utf8"));
  for (const tema of ["claro", "escuro", "neutro"]) for (const tam of ["grande", "medio", "pequeno"]) {
    const nome = "atos-curto-" + tema + "-" + tam + ".svg";
    const svg = await readFile(new URL(nome, MARCA), "utf8");
    assert.ok(svg.includes("<title>Entrar</title>") && Array.isArray(lista[nome]), nome);
  }
  assert.deepEqual(lista["atos-coroa.svg"], [64, 64]);
  assert.deepEqual(lista["atos-coroa-escura.svg"], [64, 64]);
});
