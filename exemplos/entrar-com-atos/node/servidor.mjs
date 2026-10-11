// Servidor Node com Express (cliente confidencial). entrar.js: o pacote @atos.dev.br/entrar.
// O segredo fica só em ATOS_CLIENT_SECRET (o pacote lê de lá). Rode com: node --env-file=.env servidor.mjs
import express from "express";
import session from "express-session";
import { entrarComAtos } from "./entrar.js";

const atos = entrarComAtos({
  clientId: process.env.ATOS_CLIENT_ID,
  voltaPara: process.env.ATOS_REDIRECT_URI,
  emissor: process.env.ATOS_ISSUER, // vazio: https://atos.dev.br
});
const app = express();
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: "lax" } }));

app.get("/", (req, res) => {
  const p = req.session.pessoa;
  res.type("text").send(p ? "Olá, " + p.nome + " (" + p.email + "). id: " + p.id : "Entre em /entrar");
});

app.get("/entrar", async (req, res) => {
  const { url, guardar } = await atos.comecar(); // state, nonce e code_verifier
  req.session.atos = guardar;
  res.redirect(url);
});

app.get(new URL(atos.voltaPara).pathname, async (req, res) => {
  const guardado = req.session.atos;
  delete req.session.atos;
  try {
    const pessoa = await atos.concluir(req.originalUrl, guardado); // confere tudo e troca o código
    req.session.pessoa = { id: pessoa.id, nome: pessoa.nome, email: pessoa.email };
    res.redirect("/");
  } catch (e) {
    // access_denied: a conta não tem acesso ou a pessoa não permitiu
    res.status(e.codigo === "access_denied" ? 403 : 400).type("text").send(e.message);
  }
});

app.listen(Number(new URL(atos.voltaPara).port) || 3000);
