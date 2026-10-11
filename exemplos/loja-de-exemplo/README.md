# Loja da Maria (site de exemplo)

Um site fictício, mínimo, com o **Entrar com Atos**: Node com Express e o pacote [`@atos.dev.br/entrar`](https://www.npmjs.com/package/@atos.dev.br/entrar), num acesso confidencial (servidor com segredo). É o exemplo do passo a passo "Na prática" de [atos.dev.br/integracao](https://atos.dev.br/integracao/#na-pratica).

- `/`: a vitrine com o botão "Entrar com Atos"; depois do login, "Olá, <nome>" com o e-mail.
- `/entrar`: manda a pessoa para a Atos (`comecar()`).
- `/auth/atos/retorno`: a volta (`concluir()`); com `access_denied`, vai para `/sem-acesso`.

## Rodar contra a Atos

Precisa do Node 20.6 ou mais novo (por causa do `--env-file`).

1. Em [atos.dev.br/conta/integracoes](https://atos.dev.br/conta/integracoes), cadastre um aplicativo (o nome, o site, a política de privacidade e os termos) e crie um **acesso confidencial** com o endereço de volta `http://127.0.0.1:3000/auth/atos/retorno`. Guarde o segredo, que aparece uma vez só.
2. Em "Quem pode entrar", deixe "Só as pessoas liberadas" e libere um e-mail seu. Para ver o "sem acesso", entre com outra Conta Atos que não está na lista.
3. Nesta pasta, rode o comando do cartão **Como integrar** daquele acesso (PowerShell ou Linux/macOS). Ele grava no `.env` o `ATOS_ISSUER`, o `ATOS_CLIENT_ID` e o `ATOS_REDIRECT_URI`.
4. Complete o `.env` com o segredo e uma chave para a sessão (veja `.env.exemplo`):

   ```
   ATOS_CLIENT_SECRET=o segredo do passo 1
   SESSION_SECRET=um texto aleatório e comprido
   ```

5. Instale e suba:

   ```
   npm install
   npm start
   ```

6. Abra `http://127.0.0.1:3000` e clique em "Entrar com Atos".

O `.env` fica fora do Git (`.gitignore`). Num site publicado, cadastre a volta `https://` dele e use o mesmo endereço no `ATOS_REDIRECT_URI`. Com `https`, o cookie da sessão sai com `Secure`.

Tudo aqui é fictício: a loja, os produtos e as pessoas.
