# Atos · atos.dev.br

O site da Atos e a **conta Atos** ("Entrar com Atos"), num Worker da Cloudflare.

- `public/` – o site (landing, `/entrar`, `/conta`, `/privacidade`, `/termos`).
- `worker/` – a conta (e-mail e senha, sessão) e o provedor OpenID Connect com consentimento.
- `index.html` + `CNAME` na raiz – só o GitHub Pages de matheusuener.com.br, que leva a atos.dev.br.

## Entrar com Atos (OpenID Connect)

Descoberta: `https://atos.dev.br/.well-known/openid-configuration`.
Código de autorização com PKCE S256 obrigatório para todos, clientes públicos ou confidenciais (client_secret_basic ou client_secret_post), id_token ES256.
Os aplicativos e clientes: os fixos em `worker/oidc.js` (`APPS`, `CLIENTES`, os do PAVLVS) e os cadastrados no painel, seção Login Atos (`worker/oidc-painel.js`, no KV em `atos:oidc:registro`; só o dono, pela fila).

Para quem integra: `pacotes/entrar/` (o pacote JavaScript `@atos.dev.br/entrar`, ainda não publicado no npm; a cópia servida fica em `public/pacotes/entrar/<versão>/entrar.js`) e `exemplos/entrar-com-atos/` (Python, C#/.NET e Node, testados contra o Worker local). Os trechos de cada linguagem e os comandos que gravam o `.env` vêm de `public/assets/integrar-linguagens.js`; depois de mudar ali (ou no pacote), rode `node tools/integracao-linguagens.mjs` (a página /integracao/, os exemplos e a cópia do pacote).

No `wrangler dev`, a var `ATOS_EMISSOR_LOCAL=http://127.0.0.1:<porta>` faz a descoberta e os tokens dizerem o endereço local (só aceita 127.0.0.1 ou localhost); sem ela, o emissor é sempre `https://atos.dev.br`.

## Rodar os testes e publicar

A API de [orçamentos Plantare M1](docs/PLANTARE-ORCAMENTOS.md) usa autenticação
de servidor e vem desabilitada. O [registro de compras, primeira parte de
M2](docs/PLANTARE-COMPRAS.md), adiciona rascunhos e consultas por conta, com
flag própria. O [checkout M2](docs/PLANTARE-CHECKOUT.md) implementa sessão,
Pix, cortesia, direitos e eventos apenas em ambiente de teste, desabilitado
por padrão. A integração de produção com o Plantare ainda depende de M3/M4.

Com Node.js 24 ou mais recente, a verificação essencial roda na raiz, sem
instalar dependências nem configurar segredos:

    npm test

O mesmo comando roda no GitHub Actions em Linux e Windows nos pull requests
e na `main`. Para executar só uma área: `npm run test:conta`,
`npm run test:cobranca` ou `npm run test:integracao`.
Veja [a cobertura, os requisitos e os limites da validação](docs/QUALIDADE.md).

Testes complementares e publicação (com os ambientes preparados):

    npm test --prefix pacotes/entrar                   # o pacote completo, contra o Worker em wrangler dev
    node exemplos/entrar-com-atos/testar.mjs --python <python com authlib e flask> --dotnet <EntrarComAtos.dll> --node <pasta com express>
    node exemplos/entrar-com-atos/testar-env.mjs        # os comandos do .env no PowerShell 5.1/7 e no bash
    npx wrangler deploy

Segredos: `ATOS_CHAVE` (`node tools/gerar-chave.mjs`) e `RESEND_API_KEY`.

O [faturamento Plantare](docs/PLANTARE-FATURAMENTO.md) integra as compras à
Minha conta e à fila fiscal compartilhada, com recuperação e conciliação de devoluções.

O painel inclui a [operação das revisões de pagamento Plantare](docs/PLANTARE-REVISOES.md),
com recuperação por ordem do gateway e histórico de conferências.
