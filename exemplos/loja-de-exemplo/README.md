# Loja da Maria (site de exemplo)

Um site fictício, mínimo, com o **Entrar com Atos**: Node com Express e o pacote [`@atos.dev.br/entrar`](https://www.npmjs.com/package/@atos.dev.br/entrar), num acesso confidencial (servidor com segredo). É o exemplo do passo a passo "Na prática" de [atos.dev.br/integracao](https://atos.dev.br/integracao/#na-pratica).

- `/`: a vitrine com os botões oficiais "Entrar com Atos" e "Criar conta com Atos"; depois do login, "Olá, <nome>" com o e-mail. No topo, o menu de conta da Atos (abaixo).
- `/entrar`: manda a pessoa para a Atos (`comecar()`).
- `/criar-conta`: o mesmo, com a Atos abrindo direto em "Criar a conta Atos" (`comecar({ criarConta: true })`, que pede `prompt=create`). Lá, "Já tem conta? Entrar" continua o mesmo pedido; quem já está com a sessão aberta na Atos vai direto para a permissão.
- `/auth/atos/retorno`: a volta (`concluir()`); com `access_denied`, vai para `/sem-acesso`.
- `/fedcm/comecar` e `/fedcm/concluir`: o "Continuar como" (abaixo).

## "Continuar como" (FedCM)

No Chrome e no Edge, o `publico/fedcm.js` troca o texto dos botões para "Continuar com Atos" e, no clique, o navegador mostra a Conta Atos aberta nele ("Continuar como <nome>"), sem sair da loja. Na primeira vez, a Atos abre uma janela com a permissão do aplicativo (a mesma tela do login de sempre). O código que o navegador entrega vai ao servidor (`/fedcm/concluir`), que o troca com o segredo e o PKCE (`concluirFedCM()`). No Firefox e no Safari, que não têm FedCM, o botão continua o link para `/entrar`; se a pessoa fecha a janela do navegador, também vai para `/entrar`. Quem não está liberado vai para `/sem-acesso`.

O FedCM não precisa de cadastro a mais na Atos: a origem da loja (`http://127.0.0.1:3000`) sai do endereço de volta do acesso.

## Quem pode entrar: o modo do aplicativo

Na Atos, cada aplicativo tem um modo em "Quem pode entrar":

- **Qualquer Conta Atos**: o modo de uma loja aberta a clientes. O cliente novo clica em "Criar conta", cria a Conta Atos (com o código que chega no e-mail), permite e volta à loja já logado. Ninguém precisa liberar nada.
- **Só as pessoas liberadas** (o padrão): o modo de um sistema fechado (a equipe, um painel interno). Só os e-mails da lista entram. Quem cria a Conta Atos pelo "Criar conta" sem estar na lista fica com a conta criada, mas a Atos mostra "Sem acesso a este aplicativo" e a loja recebe `access_denied` (a página `/sem-acesso`). Nesse modo, o "Criar conta" só serve a quem você já liberou e ainda não tem Conta Atos.

## O botão e a versão do pacote

Os botões “Entrar com Atos” e “Criar conta com Atos” são os oficiais do kit da Atos ([atos.dev.br/marca](https://atos.dev.br/marca/)): o HTML sai do `botaoEntrarComAtos()` do pacote e a folha (`/atos/botao.css`) é a do próprio pacote, a mesma de `https://atos.dev.br/marca/botao.css`.

O `botaoEntrarComAtos()` é do `@atos.dev.br/entrar` 0.4.0 e o menu de conta da **0.5.0**, que ainda não estão no npm: por isso o `package.json` daqui aponta para a cópia do repositório (`file:../../pacotes/entrar`). Quando a 0.5.0 estiver no npm, troque por `"^0.5.0"`. Fora deste repositório, use o arquivo servido pela Atos (`https://atos.dev.br/pacotes/entrar/0.5.0/entrar.js`).

## O menu de conta

O topo usa o menu de conta do pacote (`menuContaAtos()` no servidor, `ligarMenuContaAtos()` em `publico/menu.js`, a folha `/atos/menu.css`): "Entrar" antes do login; depois, o e-mail, e o clique abre o menu com Sair. O Sair faz o POST para `/sair`, que apaga a sessão da Loja (a Conta Atos continua aberta na Atos), depois da caixa "Sair da conta?" (`confirmarSair: true`; Esc, Cancelar ou o clique fora fecham sem sair). Quem entrou e é o dono do aplicativo na Atos (o claim `atos_dono`, em `pessoa.dono`) vê também Minha conta e Workspace, os atalhos da Atos (`atalhosDoDono: true`); os clientes veem só o e-mail e Sair.

## Rodar contra a Atos

Precisa do Node 20.6 ou mais novo (por causa do `--env-file`).

1. Ative o [Atos Workspace](https://atos.dev.br/workspace/) (gratuito) e, em [atos.dev.br/workspace/integracoes](https://atos.dev.br/workspace/integracoes), cadastre um aplicativo (o nome, o site, a política de privacidade e os termos) e crie um **acesso confidencial** com o endereço de volta `http://127.0.0.1:3000/auth/atos/retorno`. Guarde o segredo, que aparece uma vez só.
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
