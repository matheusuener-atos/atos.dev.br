# @atos.dev.br/entrar

O **Entrar com Atos** (OpenID Connect) em JavaScript, no navegador e no Node 18 ou mais novo. Sem dependências: o PKCE e a conferência do `id_token` (ES256, pela JWKS da Atos) usam o WebCrypto da própria plataforma.

```
npm install @atos.dev.br/entrar
```

Sem npm (uma página sem empacotador): o mesmo código num arquivo só, servido pela Atos, `https://atos.dev.br/pacotes/entrar/0.3.0/entrar.js`; importe de `"./entrar.js"`.

Antes, ative o [Atos Workspace](https://atos.dev.br/workspace/) (gratuito) e cadastre o seu sistema em [atos.dev.br/workspace/integracoes](https://atos.dev.br/workspace/integracoes): o aplicativo, o acesso (o `client_id`) e o endereço de volta. Veja também [atos.dev.br/integracao](https://atos.dev.br/integracao/).

## Navegador (acesso público, sem segredo)

```js
import { entrarComAtos } from "@atos.dev.br/entrar";

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

## Criar conta (0.2.0)

Para um botão "Criar conta" ao lado do "Entrar com Atos", passe `criarConta: true`: a ida leva `prompt=create` ([Initiating User Registration via OpenID Connect 1.0](https://openid.net/specs/openid-connect-prompt-create-1_0.html)) e a Atos abre direto em "Criar a conta Atos". A pessoa cria a conta (com o código que chega no e-mail), permite e volta; a volta é igual à do login (`retorno()` ou `concluir()`). Lá mesmo, "Já tem conta? Entrar" continua o mesmo pedido, e quem já está com a sessão aberta na Atos vai direto para a permissão (ou a volta).

```js
botaoCriar.addEventListener("click", () => atos.entrar({ criarConta: true }));      // navegador
app.get("/criar-conta", async (req, res) => {                                       // servidor
  const { url, guardar } = await atos.comecar({ criarConta: true });
  req.session.atos = guardar;
  res.redirect(url);
});
```

`criarConta` não combina com `prompt` (lança `ErroAtos` com `codigo: "configuracao"`). Uma Atos cuja descoberta não anuncia `create` em `prompt_values_supported` recebe a ida sem `prompt` (a tela de entrar, que também tem "Criar conta"). Quem entra depende do modo do aplicativo na Atos: com "Qualquer Conta Atos", a conta nova entra; com "Só as pessoas liberadas", a conta é criada, mas quem não está na lista volta com `access_denied`.

## Avisos ao seu sistema (0.3.0)

Em Atos Workspace › Integrações, cada aplicativo pode ter um endereço https do seu sistema para os avisos da Atos (webhooks). A Atos manda ali um `POST` JSON quando:

| `tipo` | quando | `dados` |
|---|---|---|
| `acesso.revogado` | a pessoa tirou a permissão do seu aplicativo em Minha conta | `{ sub }` |
| `liberado.adicionado` | você liberou e-mails na lista do aplicativo | `{ pessoas: [{ email, sub? }] }` |
| `liberado.removido` | você tirou um e-mail da lista | `{ pessoas: [{ email, sub? }] }` |
| `aviso.teste` | o botão "Mandar um aviso de teste" | `{}` |

O `sub` das pessoas da lista só vem de quem já permitiu o seu aplicativo (o seu sistema já o recebeu no login); de quem nunca entrou, só o e-mail. O corpo é `{ id, tipo, criado, app, dados }`, com os cabeçalhos `Atos-Evento` (o `id`) e `Atos-Assinatura: t=<segundos>,v1=<HMAC-SHA256 hex de "<t>.<corpo>">`, assinado com o segredo que a Atos mostra uma vez ao cadastrar. Responda 2xx: senão a Atos tenta de novo em 1 min, 5 min, 30 min, 2 h e 12 h (o mesmo `id`). Ela não segue redirecionamentos e espera até 10 s.

```js
import express from "express";
import { verificarAviso } from "@atos.dev.br/entrar";

app.post("/atos/avisos", express.text({ type: "application/json" }), async (req, res) => {
  let aviso;
  try {
    aviso = await verificarAviso(req.body, req.get("atos-assinatura"), process.env.ATOS_AVISOS_SEGREDO);
  } catch {
    return res.sendStatus(401); // assinatura errada ou aviso velho (mais de 5 minutos)
  }
  if (await jaApliquei(aviso.id)) return res.sendStatus(200);
  if (aviso.tipo === "acesso.revogado") await encerrarSessoesDe(aviso.dados.sub);
  res.sendStatus(200);
});
```

Passe o corpo **cru** (o texto, antes do `JSON.parse`): a assinatura é sobre os bytes que chegaram. `verificarAviso` devolve o aviso já lido ou lança `ErroAtos` com `codigo: "aviso"`.

## A API

`entrarComAtos({ clientId, voltaPara, escopos?, emissor?, fetch? })`

- `escopos`: padrão `["openid", "email", "profile"]`; `openid` sempre vai.
- `emissor`: só para testes (padrão `https://atos.dev.br`). A descoberta precisa dizer exatamente esse emissor.

Devolve `{ entrar, retorno, comecar, concluir, sair }`. E, à parte, `verificarAviso(corpo, cabecalho, segredo, { agora? })` (acima).



| | |
|---|---|
| `entrar({ prompt?, dica?, criarConta? })` | navegador: vai à Atos. `prompt`: `"none"`, `"login"` ou `"consent"`; `dica`: o e-mail sugerido; `criarConta: true`: abre em "Criar a conta Atos" (veja abaixo). |
| `retorno(endereco?)` | navegador: a pessoa, ou `null` se o endereço não é uma volta. |
| `comecar({ prompt?, dica?, criarConta? })` | servidor: `{ url, guardar }`. |
| `concluir(urlDaVolta, guardar)` | servidor: a pessoa. |
| `sair(accessToken)` | invalida o `access_token` na Atos (a sessão local é sua). |

A pessoa: `{ id, nome, email, emailVerificado, idToken, accessToken, expiraEm }`. Identifique-a por `id` (o `sub`, que não muda); o e-mail pode mudar. Os tokens valem 1 hora e não há `refresh_token`: para renovar, comece de novo (com `prompt: "none"` a volta é direta se a sessão na Atos estiver aberta).

Toda falha lança `ErroAtos`, com `codigo` (`access_denied`, `login_required`, `consent_required`, `state`, `iss`, `id_token`, `invalid_grant`, `invalid_client`, `rede`, `descoberta`, `configuracao`), `message` em português e, quando a Atos mandou, `descricao`. `access_denied` é a conta sem acesso ao aplicativo (quem pode entrar se decide no cadastro, na Atos) ou a pessoa que não permitiu.

## Testes

Contra a Atos de verdade: o Worker deste repositório em `wrangler dev`, com contas, sessões e um aplicativo fabricados no KV local (`teste/atos-local.mjs`). Cobrem o servidor com o segredo, o navegador (sessionStorage simulado), o `criarConta` (`prompt=create`, a Atos abrindo no cadastro, a recusa com `prompt` e a Atos sem `create` na descoberta), `access_denied`, `state` e `iss` trocados, o código usado duas vezes e `id_token` forjados (outra chave com o mesmo `kid`, corpo mexido, `alg: none` e `HS256`, `kid` desconhecido; e assinados pela chave certa, mas vencidos, com outro `aud`, `azp`, `iss` ou `nonce`).

    cd pacotes/entrar
    npm test

O `verificarAviso` tem os próprios testes (`teste/aviso.test.mjs`, sem a Atos: assinatura certa, errada, de outro segredo, corpo mexido, velha e fora do formato).

Testado no Node 24; o Node 18 usa o WebCrypto de `node:crypto` (o código cuida disso), mas não rodou aqui.

## Licença

MIT.
