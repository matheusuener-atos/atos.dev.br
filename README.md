# Atos · atos.dev.br

O site da Atos e a **conta Atos** ("Entrar com Atos"), num Worker da Cloudflare.

- `public/` – o site (landing, `/entrar`, `/conta`, `/privacidade`, `/termos`).
- `worker/` – a conta (e-mail e senha, sessão) e o provedor OpenID Connect com consentimento.
- `index.html` + `CNAME` na raiz – só o GitHub Pages de matheusuener.com.br, que leva a atos.dev.br.

## Entrar com Atos (OpenID Connect)

Descoberta: `https://atos.dev.br/.well-known/openid-configuration`.
Código de autorização com PKCE S256 obrigatório para todos, clientes públicos ou confidenciais (client_secret_basic ou client_secret_post), id_token ES256.
Os aplicativos e clientes: os fixos em `worker/oidc.js` (`APPS`, `CLIENTES`, os do PAVLVS) e os cadastrados no painel, seção Login Atos (`worker/oidc-painel.js`, no KV em `atos:oidc:registro`; só o dono, pela fila).

## Rodar os testes e publicar

    node worker/teste.mjs
    node worker/teste-oauth.mjs
    node worker/teste-admin.mjs
    npx wrangler deploy

Segredos: `ATOS_CHAVE` (`node tools/gerar-chave.mjs`) e `RESEND_API_KEY`.
