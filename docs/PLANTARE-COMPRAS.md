# Registro de compras Plantare — primeira parte de M2

Implementa a base durável da [issue #8](https://github.com/matheusuener-atos/atos.dev.br/issues/8),
sobre os [orçamentos de M1](PLANTARE-ORCAMENTOS.md). Esta página descreve a
primeira parte. O [checkout M2](PLANTARE-CHECKOUT.md) estende o registro com
pagamento, direitos e eventos em ambiente de teste; M2 segue em homologação.

O orçamento pode originar **um rascunho de compra por intenção**, recuperável
após concorrência, reinício ou perda da resposta. O preço e o escopo são
copiados do orçamento persistido. O pedido não aceita preço, direito, URL de
retorno ou referência do gateway. Essa API é de servidor; o Plantare deve
obter o `sub` da sessão autenticada, como em M1.

## Configuração e rotas

Requer a configuração de M1 e `PLANTARE_COMPRAS_ATIVAS="1"`. A nova flag não
está habilitada no Wrangler versionado. Usa a mesma classe e objeto de M1,
sem nova migration. Os registros são aditivos e isolados por ambiente.

Prefixo `/api/cobranca/v1/plantare`, Bearer exclusivo, HTTPS, sem Origin,
sem CORS, corpos limitados a 4096 bytes e respostas `no-store`, como M1.

| Método/rota | Resposta |
| --- | --- |
| `POST /checkouts` | 200 com `{compra, checkout_disponivel: false, checkout_url: null}` |
| `GET /intencoes/{id}?sub=…` | Agora inclui o snapshot em `compra` quando há rascunho |
| `GET /compras/{id}?sub=…` | Snapshot público da compra pertencente à conta |
| `GET /compras?sub=…&limite=25&cursor=…` | `{compras, proximo_cursor}` |

Com a flag desligada, as novas rotas retornam 404. A consulta de intenções
continua preservando o registro de compras que já existirem.

O POST exige `Idempotency-Key`, com as mesmas regras de M1, e somente:

```json
{
  "schema": "plantare-checkout/v1",
  "sub": "sub-exemplo",
  "intent_id": "int-exemplo-001",
  "orcamento_id": "orc-00000000-0000-4000-8000-000000000001"
}
```

É preciso usar um orçamento real da mesma intenção e conta, ainda vigente
na criação inicial. Orçamento diferente retorna 409; conta/intenção ausente,
404; orçamento vencido sem compra, 410. O retry de um rascunho já registrado
recupera o mesmo snapshot mesmo após vencer o orçamento: isso **não** renova
a validade nem autoriza começar um pagamento com aquele orçamento vencido.

Chave é isolada por operação e conta. Mesma chave com outra intenção retorna
409. Chaves diferentes da mesma intenção recuperam a mesma compra. Registro,
ponteiro da intenção, idempotência, contador e índice são gravados em uma única
transação. A referência estável `plantare-<id da compra>` fica somente no
registro interno, preparada para o gateway da próxima etapa.

## Snapshot e paginação

O snapshot `plantare-compra/v1` contém `id`, `produto`, `sub`, `intent_id`,
`orcamento_id`, `versao`, `estado`, `area_hash`, `area_cent_ha`, `camadas`,
`moeda`, `centavos`, `tarifa_versao`, `cupom`, `criado_em`, `pago_em`,
`baixar_ate` e `direito_ativo`. Nesta etapa, versão é 1, estado é
`aguardando`, pagamento/prazo são nulos e direito é falso, **inclusive para
orçamento de cortesia**. O rascunho não constitui pagamento ou concessão.

A listagem usa índice por conta, em ordem de criação e limite de 1 a 100
(padrão 25). Não varre compras de outras contas. O cursor deve ser devolvido
sem alteração: vincula a conta, a última posição e o teto de inserções visto
na primeira página. Compras criadas depois não entram naquela sequência;
uma nova consulta sem cursor as encontra. Alterações futuras de estado não
serão congeladas pelo cursor; ele não representa snapshot transacional de
toda a coleção. Não se filtram estados na listagem.

Consulta com outro `sub` retorna 404 sem expor a compra. A API autentica o
produto, não confere a sessão da pessoa; a validação da sessão na página
de checkout da Atos ainda será implementada.

## Limites e continuação de M2

Na primeira parte, não há página de checkout, Pix, chamada ao Mercado Pago, evento, fatura ou
concessão nesta etapa. A reserva de cupom mantém a validade original do
orçamento. O rascunho não a consome nem prolonga; não pode iniciar pagamento
depois da validade ou com reserva liberada. Antes de conectar o gateway:

1. Vincular a página à sessão Atos do mesmo `sub`; oferecer página/aba como
   alternativa ao pop-up. A proposta de incorporação continua registrada na
   issue #8 e nos contratos, sem mudar a proteção global de frames.
2. Transacionar promoção/revalidação da reserva e fase do pagamento antes
   do efeito externo, com a referência já persistida. Retentar timeout sem
   gerar outro Pix. Rascunho vencido exige nova intenção explícita.
3. Implementar cortesia, confirmação, expiração, devolução e revogação com
   versão crescente, histórico e consumo de cupom; conservar estados revogados.
4. Persistir e reentregar `compra.atualizada` assinada, com recuperação de
   falhas; homologar o gateway e o receptor Plantare em ambiente de teste.

A issue #8 permanece aberta; nenhum critério ponta a ponta foi dado como
concluído só pela existência deste registro. Não habilitar cobrança de produção.

## Verificação

`npm test` inclui `compras.test.mjs`: concorrência, perda da resposta,
reinício do objeto, rollback em cada uma das cinco escritas, adulteração,
isolamento, cortesia sem concessão, vencimento, limites e paginação com
inserções concorrentes. O armazenamento de testes usa SQLite em memória;
os testes proíbem chamadas externas. Isso não homologa o Mercado Pago.
