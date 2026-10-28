# Plantare: ensaio remoto de 28/10/2026

Esta entrega publica somente `atos-teste`, com KV isolado, e liga seus eventos
ao `plantare-atos-teste`. Não houve publicação do Worker `atos` ou ativação de
cobrança central em produção.

## Alterações

- Pix de teste pode incluir `payer.first_name=APRO` por opção explícita
  `MP_PIX_TESTE_APRO=1`, somente em `AMBIENTE=teste`. O payload congelado e a
  referência original permanecem nas retentativas. A opção fica fora da produção.
- O KV de `env.teste` foi separado do namespace compartilhado da produção.
  Dados antigos não foram removidos; o ensaio usa contas e sessões sintéticas
  no novo namespace. Isso não migra credenciais de contas reais para teste.
- `homologacao/wrangler.json` publica o entry point exclusivo do ensaio,
  sem domínios de produção, PAVLVS ou mTLS fiscal produtivo. O validador de
  configuração verifica esses limites e integra a suíte de testes.
- O controlador `/__homologacao` exige ambiente de teste, flag e token próprio,
  recusa Origin e só prepara fixtures com identificador `hmg-UUID`. Não recebe
  SQL, endpoint arbitrário ou credencial de gateway do chamador. Replay consulta
  o evento imutável do coordenador e preserva seu corpo, ID e versão.

O entry point normal `worker/index.js` não importa o controlador. Ao encerrar
o ensaio, `PLANTARE_HOMOLOG_ATIVO=0` foi publicado e o endpoint retornou 404,
inclusive com o token correto. Segredos ficaram no serviço/armazenamento
privado do operador, sem valores no Git ou nos relatórios.

## Evidência remota

O diagnóstico autenticado da API `/users/me` confirmou vendedor de teste.
Nenhum token foi lido pelo cliente ou incluído na saída. Foram observados:

| Cenário | Resultado |
| --- | --- |
| Intenção repetida | Mesmo ID de compra, uma fatura |
| Pix de R$ 188,40 | Aprovação automática na API de teste real do Mercado Pago |
| Atos → Plantare | Evento assinado efetivamente gravado no inbox D1 remoto |
| Entrega | 41 arquivos; KML, KMZ, GeoJSON e CSV conferidos por conteúdo/assinatura |
| Devolução integral | API do gateway aceitou; compra devolvida, download HTTP 403 |
| Devolução parcial de R$ 10 | Compra revogada; repetição de evento antigo não restaurou acesso |
| Cortesia | Sem Pix, CSV permitido; dono, hash e camadas divergentes bloqueados |
| Último uso de cupom | Duas contas concorrentes: uma reserva aceita, outra recusada |
| Rollback do Plantare | Compra existente confirmou Pix; novas intenções bloqueadas sem fallback |

As confirmações do gateway foram lidas pela API; não foi comprovado neste
ensaio que um webhook enviado pelo Mercado Pago, sozinho, atualiza o estado.
Eventos Atos → Plantare foram reais, através de service bindings e com HMAC.
Sessões/perfis foram preparados por fixture autenticada; não é prova de login
OIDC remoto completo. A Sefin remota não foi exercitada nesta rodada.

Reembolsos de fixture exigem vendedor/credencial de teste comprovado, referência
igual à compra, mesmo dono sintético e valor de até R$ 500. Não há operação de
reembolso no controlador de produção. Pedidos pagos do ensaio foram devolvidos;
registros e auditoria foram preservados.

## Verificação e continuação

Suíte Atos: 145 resultados aprovados (8 conta, 110 cobrança, 27 integração).
A medição antiga de CPU oscilou localmente e passou na execução final com
7,28 ms; seu limite não foi alterado. Os testes novos verificam APRO, payload
congelado, bloqueio de produção, autenticação do controlador e escopo do replay.

O ensaio reproduzível, backup/restauração e as pendências de corte estão no
repositório Plantare, `homologacao/executar.mjs` e `docs/ATOS-M4-REMOTO.md`.
Ainda faltam importação idempotente do histórico/campanhas, congelamento/delta,
prova do webhook do gateway e login real no ambiente isolado antes do corte.
A autorização do dono de ativar quando pertinente permanece válida.

Referências oficiais consultadas:

- [Pix de teste e APRO](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix).
- [Reembolso de order](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-api/refund-order/post).
- [Migração e configuração de notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/resources/migrate-payments-to-orders).
