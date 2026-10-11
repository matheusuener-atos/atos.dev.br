# Loja da Maria (site de exemplo)

Um site fictício, mínimo, com o **Entrar com Atos**: Node com Express e o pacote [`@atos.dev.br/entrar`](https://www.npmjs.com/package/@atos.dev.br/entrar), num acesso confidencial (servidor com segredo). É o exemplo do passo a passo "Na prática" de [atos.dev.br/integracao](https://atos.dev.br/integracao/#na-pratica).

- `/`: a vitrine com os botões "Entrar com Atos" e "Criar conta"; depois do login, "Olá, <nome>" com o e-mail.
- `/entrar`: manda a pessoa para a Atos (`comecar()`).
- `/criar-conta`: o mesmo, com a Atos abrindo direto em "Criar a conta Atos" (`comecar({ criarConta: true })`, que pede `prompt=create`). Lá, "Já tem conta? Entrar" continua o mesmo pedido; quem já está com a sessão aberta na Atos vai direto para a permissão.
- `/auth/atos/retorno`: a volta (`concluir()`); com `access_denied`, vai para `/sem-acesso`.

## Quem pode entrar: o modo do aplicativo

Na Atos, cada aplicativo tem um modo em "Quem pode entrar":

- **Qualquer Conta Atos**: o modo de uma loja aberta a clientes. O cliente novo clica em "Criar conta", cria a Conta Atos (com o código que chega no e-mail), permite e volta à loja já logado. Ninguém precisa liberar nada.
- **Só as pessoas liberadas** (o padrão): o modo de um sistema fechado (a equipe, um painel interno). Só os e-mails da lista entram. Quem cria a Conta Atos pelo "Criar conta" sem estar na lista fica com a conta criada, mas a Atos mostra "Sem acesso a este aplicativo" e a loja recebe `access_denied` (a página `/sem-acesso`). Nesse modo, o "Criar conta" só serve a quem você já liberou e ainda não tem Conta Atos.

## "Criar conta" e a versão do pacote

A opção `criarConta` é do `@atos.dev.br/entrar` **0.2.0**. Enquanto o `package.json` daqui pede `^0.1.0`, o `npm install` traz o 0.1, que ignora a opção: o botão "Criar conta" leva à tela de entrar da Atos de sempre, que tem o link "Não tem conta? Criar conta" (um clique a mais, nada quebra). Com o 0.2.0 no npm, atualize:

```
npm install @atos.dev.br/entrar@^0.2.0
```

## Rodar contra a Atos

Precisa do Node 20.6 ou mais novo (por causa do `--env-file`).

1. Em [atos.dev.br/conta/integracoes](https://atos.dev.br/conta/integracoes), cadastre um aplicativo (o nome, o site, a política de privacidade e os termos) e crie um **acesso confidencial** com o endereço de volta `http://127.0.0.1:3000/auth/atos/retorno`. Guarde o segredo, que aparece uma vez só.
2. Em "Quem pode entrar", escolha o modo (veja acima): "Qualquer Conta Atos" para a loja aberta. Para ver o "sem acesso", deixe "Só as pessoas liberadas", libere um e-mail seu e entre com outra Conta Atos que não está na lista.
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

6. Abra `http://127.0.0.1:3000` e clique em "Entrar com Atos" ou em "Criar conta".

O `.env` fica fora do Git (`.gitignore`). Num site publicado, cadastre a volta `https://` dele e use o mesmo endereço no `ATOS_REDIRECT_URI`. Com `https`, o cookie da sessão sai com `Secure`.

Tudo aqui é fictício: a loja, os produtos e as pessoas.
