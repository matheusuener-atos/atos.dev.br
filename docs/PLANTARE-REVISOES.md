# Operação dos pagamentos Plantare em revisão

Implementação em ambiente de teste, sobre o checkout e o faturamento M2.
A seção **Atos → Pagamentos Plantare** usa a sessão do painel com equipe,
segunda etapa, login recente e área Atos. Suporte consulta; dono e financeiro
podem consultar a ordem no gateway e registrar a conferência.

## Roteiro da equipe

1. Abrir a compra em revisão. A lista percorre páginas de até 50 compras;
   uma página sem revisões pode ter continuação. O ID permite consultar
   diretamente uma compra e suas últimas 100 conferências.
2. Localizar a ordem no provedor pela referência `plantare-cmp-UUID`. Informar
   o ID da ordem e uma justificativa de 10 a 1.000 caracteres.
3. Usar **Consultar gateway e registrar**. A Atos faz um GET autenticado ao
   gateway; o formulário não fornece estado, valor, conta ou resposta de pagamento.
4. Conferir o resultado e o histórico. Uma alteração concorrente pede atualização
   da compra. Um erro de rede permite repetir a mesma ação com a mesma chave.

Sem ID conhecido ou com ordem não encontrada, não se declara ausência de
pagamento: a revisão e a reserva permanecem. A equipe deve localizar a ordem
ou esclarecer o caso com o provedor; esta entrega não oferece liberação manual
de reserva por suposição nem cria outro Pix para a mesma compra.

## Recuperação e casos tardios

Uma ordem pendente recuperada retoma a consulta automática do mesmo ID, sem
outro POST de criação. Pagamento confirmado segue o consumo de cupom, histórico,
direito, outbox de eventos e faturamento existentes. Cancelamento ou expiração
confirmados para uma compra ainda aguardando liberam a reserva.

Pagamento observado depois de cancelamento/expiração continua em revisão e
sem acesso. Como a campanha já pode ter sido reservada por outra compra,
esta versão não aceita o pagamento tardio para conceder direitos. A equipe
confere e realiza a devolução no provedor, depois consulta novamente pela Atos.
O botão não realiza devolução financeira.

Devolução integral ou contestação confirmada pelo gateway encerra o caso como
`devolvida`, conserva acesso bloqueado e registra uma ocorrência
`compensacao:<compra>` com autor e data. Essa ocorrência não recria consumo de
campanha nem remove reserva de outra compra. Incrementa uma vez o histórico
financeiro da pessoa, conservando o marcador de histórico legado conferido ou
pendente. Uma devolução parcial tardia permanece em revisão até esclarecimento
e devolução integral. `pago_em` representa a data de observação registrada pela
Atos, conforme o contrato atual; não é uma data bancária importada.

O faturamento recebe a versão devolvida pela outbox compartilhada. A
[conciliação fiscal](PLANTARE-FATURAMENTO.md) continua separada: conferir o
pagamento não cancela documento fiscal.

## Consistência e auditoria

A consulta exige ID, referência, valor, moeda, Pix e ambiente compatíveis com
a compra. Ordens já vinculadas não podem ser trocadas. Um token do estado
operacional é conferido antes e depois da consulta externa; um webhook ou
outra ação concorrente invalida a resposta antiga.

Compra, cupom, histórico, compensação, auditoria, outboxes e confirmação
idempotente são gravados na mesma transação SQLite. Cada conferência aceita
conserva autor confiável da sessão, justificativa, ordem, estado do gateway,
resultado e versão. Repetição com mesma chave e conteúdo retorna a confirmação
anterior; conteúdo ou autor diferente com a mesma chave é conflito. Falhas de
rede/validação não encerram a revisão nem geram registro de conferência aceita.

API do painel, com `cache-control: no-store`:

- `GET /api/admin/plantare-pagamentos?cursor=<cmp-id>`
- `GET /api/admin/plantare-pagamentos/<cmp-id>`
- `POST /api/admin/plantare-pagamentos/<cmp-id>/consultar`, com Origin da
  própria aplicação, `Idempotency-Key` e JSON `{token, order_id, justificativa}`.

Não há nova classe de Durable Object ou migração remota. A listagem limitada
consulta as próprias compras, incluindo revisões criadas antes desta entrega.

## Verificação e próximos passos

Em 26/10/2026, 16 testes novos cobrem recuperação, falhas, dados divergentes,
reservas, pagamentos tardios, compensação repetida, concorrência, rollback,
paginação, histórico recente e autenticação completa do painel. As chamadas
de gateway são simuladas; transações usam SQLite real.

Runtime Cloudflare local e Edge validaram a interface real em desktop e 390 px,
recuperação, pagamento tardio e devolução com auditoria. O harness preparou
sinteticamente a revisão sem ID e usou identidade administrativa e gateway
fictícios; o prazo de entrada em revisão e as permissões foram testados nas
suítes. Não é homologação externa, pagamento real ou publicação em produção.

A medição preexistente de emissão fiscal abaixo de 10 ms de CPU falhou nesta
máquina nas primeiras execuções e também na branch anterior sem esta mudança.
Na execução final completa, passou com média de 6,25 ms. A suíte essencial
terminou com 141 resultados aprovados, incluindo os 16 novos testes.
O reinício real do runtime local preservou a compra e as três conferências.

Próximo passo: M3, receptor/projeção de direitos e downloads no Plantare,
preservando o legado; depois M4, gateway real de teste e dois Workers.
A autorização de ativar produção quando pertinente permanece registrada.
Checkout e revisões seguem limitados a teste até concluir essas entregas.
