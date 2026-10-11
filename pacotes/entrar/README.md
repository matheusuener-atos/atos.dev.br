# @atos/entrar

O **Entrar com Atos** (OpenID Connect) em JavaScript, no navegador e no Node 18 ou mais novo. Sem dependências: o PKCE e a conferência do `id_token` (ES256, pela JWKS da Atos) usam o WebCrypto da própria plataforma.

> Ainda não está publicado no npm. Enquanto não estiver, use o arquivo servido pela Atos, `https://atos.dev.br/pacotes/entrar/0.1.0/entrar.js` (é este `index.js`), ou copie `index.js` deste repositório.

Antes, cadastre o seu sistema em [atos.dev.br/conta/integracoes](https://atos.dev.br/conta/integracoes): o aplicativo, o acesso (o `client_id`) e o endereço de volta. Veja também [atos.dev.br/integracao](https://atos.dev.br/integracao/).

## Navegador (acesso público, sem segredo)

```js
import { entrarComAtos } from "./entrar.js";

const atos = entrarComAtos({
  clientId: "u-xxxxxxxxxx-yyyyyy",
  voltaPara: "https://seusistema.com.br/entrar/volta", // exatamente como cadastrada
});

// O botão: gera state, nonce e code_verifier, guarda em sessionStorage e vai à Atos.
botao.addEventListener("click", () => atos.entrar());

// Na página de volta.
try {
  const pessoa = await atos.retorno(); // null quando a página não é uma volta
  if (pessoa) console.log(pessoa.id, pessoa.nome, pessoa.email);
} catch (e) {
  if (e.codigo === "access_denied") mostrar(e.message); // a conta não tem acesso ou a pessoa não permitiu
  else throw e;
}
```

`retorno()` confere o `state` (e apaga o que estava guardado), o `iss` da volta, troca o código no `/oauth/token` e confere o `id_token`: a assinatura ES256 pela chave da JWKS escolhida pelo `kid`, `iss`, `aud` (e `azp`), `exp`, `iat` e `nonce`. Também tira o código da barra de endereço. A troca do código no navegador precisa da origem da página cadastrada no acesso.

## Servidor Node (acesso confidencial)

O segredo vem **só** da variável de ambiente `ATOS_CLIENT_SECRET` (passar o segredo nas opções lança erro). O pacote não guarda estado: `comecar()` devolve o que guardar na sessão de quem está entrando, e `concluir()` recebe de volta.

```js
const atos = entrarComAtos({ clientId: process.env.ATOS_CLIENT_ID, voltaPara: process.env.ATOS_REDIRECT_URI });

app.get("/entrar", async (req, res) => {
  const { url, guardar } = await atos.comecar();
  req.session.atos = guardar;
  res.redirect(url);
});

app.get("/auth/atos/retorno", async (req, res) => {
  const guardado = req.session.atos;
  delete req.session.atos;
  try {
    const pessoa = await atos.concluir(req.originalUrl, guardado);
    req.session.pessoa = { id: pessoa.id, nome: pessoa.nome, email: pessoa.email };
    res.redirect("/");
  } catch (e) {
    res.status(e.codigo === "access_denied" ? 403 : 400).send(e.message);
  }
});
```

Com `ATOS_CLIENT_SECRET` definido, a troca do código usa `client_secret_basic`; sem ele, o cliente é público (`client_id` no corpo). No navegador, nunca há segredo.

## A API

`entrarComAtos({ clientId, voltaPara, escopos?, emissor?, fetch? })`

- `escopos`: padrão `["openid", "email", "profile"]`; `openid` sempre vai.
- `emissor`: só para testes (padrão `https://atos.dev.br`). A descoberta precisa dizer exatamente esse emissor.

Devolve `{ entrar, retorno, comecar, concluir, sair }`:

| | |
|---|---|
| `entrar({ prompt?, dica? })` | navegador: vai à Atos. `prompt`: `"none"`, `"login"` ou `"consent"`; `dica`: o e-mail sugerido. |
| `retorno(endereco?)` | navegador: a pessoa, ou `null` se o endereço não é uma volta. |
| `comecar({ prompt?, dica? })` | servidor: `{ url, guardar }`. |
| `concluir(urlDaVolta, guardar)` | servidor: a pessoa. |
| `sair(accessToken)` | invalida o `access_token` na Atos (a sessão local é sua). |

A pessoa: `{ id, nome, email, emailVerificado, idToken, accessToken, expiraEm }`. Identifique-a por `id` (o `sub`, que não muda); o e-mail pode mudar. Os tokens valem 1 hora e não há `refresh_token`: para renovar, comece de novo (com `prompt: "none"` a volta é direta se a sessão na Atos estiver aberta).

Toda falha lança `ErroAtos`, com `codigo` (`access_denied`, `login_required`, `consent_required`, `state`, `iss`, `id_token`, `invalid_grant`, `invalid_client`, `rede`, `descoberta`, `configuracao`), `message` em português e, quando a Atos mandou, `descricao`. `access_denied` é a conta sem acesso ao aplicativo (quem pode entrar se decide no cadastro, na Atos) ou a pessoa que não permitiu.

## Testes

Contra a Atos de verdade: o Worker deste repositório em `wrangler dev`, com contas, sessões e um aplicativo fabricados no KV local (`teste/atos-local.mjs`). Cobrem o servidor com o segredo, o navegador (sessionStorage simulado), `access_denied`, `state` e `iss` trocados, o código usado duas vezes e `id_token` forjados (outra chave com o mesmo `kid`, corpo mexido, `alg: none` e `HS256`, `kid` desconhecido; e assinados pela chave certa, mas vencidos, com outro `aud`, `azp`, `iss` ou `nonce`).

    cd pacotes/entrar
    npm test

Testado no Node 24; o Node 18 usa o WebCrypto de `node:crypto` (o código cuida disso), mas não rodou aqui.

## Licença

MIT.
