# Checkout Plantare — M2 em homologação

Continuação da [issue #8](https://github.com/matheusuener-atos/atos.dev.br/issues/8)
sobre o [registro de compras](PLANTARE-COMPRAS.md). Implementa página Atos,
sessão, Pix, cortesia, ciclo de direitos e eventos por compra. A cobrança real
do Plantare e seus downloads continuam no fluxo legado até M3/M4.

## Disponibilidade e configuração

O checkout é exclusivo de `AMBIENTE="teste"` nesta versão. Requer também
`PLANTARE_ORCAMENTOS_ATIVOS="1"`, `PLANTARE_COMPRAS_ATIVAS="1"`,
`PLANTARE_CHECKOUT_ATIVO="1"` e o binding `PLANTARE_ORCAMENTOS` de M1.
As flags não foram ativadas no `wrangler.jsonc` e nenhuma migration nova é
necessária. Mesmo uma flag isolada em produção não inicia este checkout.

Para homologar em ambiente isolado:

- `PLANTARE_COBRANCA_TOKEN`: segredo S2S de M1; nunca fornecer ao navegador.
- `PLANTARE_CHECKOUT_ORIGEM`: origem exata `https://atos-teste.<subdomínio>.workers.dev`.
  Desenvolvimento permite `http(s)://127.0.0.1:<porta>` ou `localhost`.
  Não aceita host, caminho ou URL de retorno vindos do pedido.
- `MP_ACCESS_TOKEN`: credencial **de teste** da aplicação Mercado Pago. Não
  inferir ambiente pelo prefixo: a documentação atual também usa `APP_USR`
  para credenciais de teste. Conferir a origem no painel do provedor.
- `MP_PAGADOR_TESTE`: comprador de teste; sem ele, o e-mail da sessão Atos.
- `CLIENTES`: o registro fiscal compartilhado da Atos. O perfil é conferido
  pelas mesmas regras de CPF/CNPJ/endereço do checkout existente.
- `EVENTOS_SEGREDO_PLANTARE`: segredo exclusivo de assinatura, mínimo 32 caracteres.
- `PLANTARE_EVENTOS_TESTE`: service binding para o Worker receptor de teste
  do Plantare, ainda a integrar em M3/M4. A entrega chama
  `https://plantare.test/api/atos/eventos` pelo binding, não por DNS público.

Sem receptor/segredo, a outbox permanece pendente. Não substituir o binding
por um receptor interno que apenas responde 200 para dar a homologação por
concluída. Nenhum segredo de teste deve ser copiado para o Git ou documentação.

Referências do provedor: [Pix/Orders](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/websites/pix),
[notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications),
[status](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-management/status/order-status)
e [compra Pix de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test/pix).

## Página, identidade e interface

`POST /api/cobranca/v1/plantare/checkouts` conserva o corpo e idempotência
do registro de compras. Quando o checkout está habilitado e a origem é
permitida, retorna `checkout_disponivel: true` e URL com apenas o ID opaco da
compra. Sem essa configuração, mantém `false` e URL nula. Não cria Pix no POST S2S.

| Rota | Autenticação e efeito |
| --- | --- |
| `GET /plantare/assinar?compra=cmp-…` | Cookie de sessão Atos; sem sessão, login com volta para a mesma compra |
| `GET /api/plantare-checkout/{id}` | Sessão do dono; consulta situação/QR e recupera tentativa já iniciada |
| `POST /api/plantare-checkout/{id}/pagar` | Sessão do dono + Origin da Atos; corpo `{}`; inicia ou recupera a mesma tentativa |
| `POST /api/mp/aviso?type=order&data.id=…` | HMAC do Mercado Pago; busca a order e só confirma Plantare após commit |

`/plantare/assinar/` e `/plantare/assinar/index.html` usam a mesma proteção.
Métodos e parâmetros extras são recusados. Outro dono recebe 404, não os dados
da compra. O Bearer de produto não autentica as rotas do navegador. Elas não
aceitam preço, dono, documento ou estado de pagamento como parâmetros.

A página usa os estilos existentes da Atos e scripts locais, CSP da conta,
`no-store`, `no-referrer` e `frame-ancestors 'none'`/`X-Frame-Options: DENY`.
Não há SDK de cartão, script inline, CORS ou alteração global de proteção.
Dados fiscais ausentes levam à seção Dados da Atos, em outra aba.

Pode abrir como página/aba ou pop-up. A página segue funcional sem `opener`;
abrir, fechar ou trocar mensagens com uma janela não concede direitos. O
lançador dentro do Plantare pertence a M3. Iframe/injeção não foi habilitado:
é uma opção futura registrada nos contratos, e requer análise própria.

## Início do pagamento e recuperação

O primeiro POST exige orçamento vigente e perfil fiscal válido. Na mesma
transação, promove a reserva, congela pagador/corpo da order e registra trabalho
pendente. A referência privada `plantare-<id da compra>` já existia no rascunho
e é usada como `external_reference` e `X-Idempotency-Key`. Nenhuma chamada ao
gateway ocorre dentro da transação ou antes do commit.

O Pix usa `/v1/orders`, modo automático, uma transação, BRL e validade de um
dia. O valor vem exclusivamente dos centavos do orçamento. A validade vai
na transação, não como `expiration_time` da order automática. Retry não muda
pagador/corpo, nem se os dados fiscais forem editados depois.

Lease persistido de 30 segundos impede duas criações simultâneas. A consulta
é limitada a uma chamada por compra a cada dez segundos; falha tenta novamente
após um minuto. Timeout, HTTP 400/409 ou resposta incompleta não provam que
nenhum Pix foi criado: preservamos referência, fase e reserva.

Sem ID confirmado, a recuperação automática por POST fica limitada aos
primeiros 15 minutos da tentativa. Não se presume retenção eterna da chave
no provedor. Após isso, fase interna `revisao` mantém a reserva e impede nova
cobrança. Conferir a referência no provedor e reentregar o webhook autenticado
da order encontrada permite recuperar o registro. Não inventar outro ID ou
liberar a reserva sem conciliar a tentativa. Não há liberação administrativa
automática nesta versão.

Depois de obter o ID, a recuperação usa GET da mesma order. Criação assíncrona
sem QR permanece em processamento e continua consultando, sem oferecer outro
Pix. Um alarme do Durable Object retoma pagamentos mesmo com a janela fechada;
cada rodada processa até 16 registros, com cursor para não abandonar os demais.

## Cupons e estados do direito

Reserva promovida recebe `compra_id` e não é removida ao vencer o orçamento.
Primeira compra exige histórico conferido de M1/M3. Uma trava por conta impede
iniciar simultaneamente campanhas de primeira compra ou misturá-las com outro
pagamento em andamento. Cupons ilimitados conservam a exceção do legado.

| Confirmação | Estado e efeito |
| --- | --- |
| Orçamento zero + confirmação pela sessão do dono | `concedida`; consome cupom e concede sem gateway |
| Order/Pix creditado e valor pago integral conferido | `paga`; consome reserva/histórico uma única vez |
| Cancelamento/expiração/falha terminal consultada | `cancelada`/`expirada`; libera reserva ainda não consumida |
| Devolução total/parcial ou contestação consultada | `devolvida`; revoga, preservando consumo e histórico |
| Pagamento contraditório após cancelamento/expiração já confirmado | Revisão; não recria cupom nem concede silenciosamente |

ID, referência, total, moeda/país (quando presentes), transação única, tipo Pix
e valor pago são conferidos. Uma resposta marcada `live_mode: true` é recusada.
Status ou QR enviados pelo navegador/webhook não são autoridade; o webhook
apenas dispara GET no gateway. Para Plantare, falha ao persistir retorna 503
para reentrega. O fluxo legado dos demais produtos continua disponível.

Cada alteração do snapshot incrementa `versao`; repetição não altera datas,
consumo ou prazo. Devolução é terminal para concessão e vence respostas antigas
em voo. O prazo inicial é **365 dias absolutos**, como o padrão atual do
Plantare; futuras configurações não reescrevem compras existentes. Ao consultar
uma compra cujo prazo venceu, `direito_ativo` passa a falso, com nova versão;
a data original do pagamento permanece. O produto também deve conferir
`baixar_ate` em cada entrega, inclusive se nenhum evento de vencimento chegou.

## Outbox e receptor

Alteração do snapshot, histórico de versão e `compra.atualizada` são gravados
na mesma transação. Envelope: `id`, `tipo`, `produto`, `criado`, `conta` e
`dados` (snapshot integral). Reentrega conserva ID/corpo e renova o timestamp
da assinatura `Atos-Assinatura`, usando o protocolo existente de cobrança.

O alarme entrega até 16 eventos por rodada, com cursor, backoff de um minuto
até uma hora e sem descartar evento pendente após erro. Falha depois de o
receptor persistir pode gerar duplicata; a inbox transacional de M3 deve
aceitá-la sem reaplicar. Eventos já entregues e snapshots de versões ficam
registrados para auditoria. Consultas individuais/paginadas continuam incluindo
estados sem direito, inclusive devolvidos.

## Validação executada e ativação

- `npm test` inclui 27 testes novos de checkout: sessão, Origin, adulteração,
  concorrência, lease/reinício, falha antes/depois do gateway, cupons, primeira
  compra, valor pago, cortesia, devolução, resposta antiga, outbox, webhook,
  prazo e rodízio acima de 16 registros.
- Runtime Cloudflare local com Durable Object/SQLite e **gateway/receptor
  fictícios locais**: criação, confirmação, devolução, cortesia e entrega dos
  três eventos por alarme real. Reinício com armazenamento persistido conservou
  a devolução; avanço do relógio no harness verificou expiração com snapshot,
  outbox e alarme na transação do runtime.
- Edge/Playwright em desktop, viewport móvel de 390 px e pop-up: sessão
  fictícia pelo cookie conferida pelo código Atos, preço, Pix copia e cola,
  atualização, cortesia, CSP e ausência de rolagem horizontal/erro de página.
- Build em `wrangler deploy --dry-run`, sem publicação. Testes complementares
  de Workspace/login também aprovados.

Isso **não é** homologação com Mercado Pago real ou com um Worker Plantare
de teste. O dono autorizou em 24/10/2026 ativar produção quando pertinente;
essa autorização não depende de nova confirmação. Antes da ativação, concluir
receptor/projeção/downloads de M3, preservar/importar legado, testar gateway e
dois Workers em M4 e concluir a operação de tentativas de pagamento em revisão.
O [faturamento compartilhado](PLANTARE-FATURAMENTO.md) espelha as compras nas
faturas da Minha conta e na fila fiscal, com recuperação e conciliação auditada.

A trava de ambiente deve ser revista junto com essas provas e o corte
reversível, não removida isoladamente para liberar uma cobrança ainda sem
entrega no produto. O PR não fecha a issue #8 nem autoriza considerar M3/M4
concluídas.
