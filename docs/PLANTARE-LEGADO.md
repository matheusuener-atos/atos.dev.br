# Importador privado de histórico Plantare

Em 28/10/2026, `worker/cobranca/plantare/legado.js` implementa importação
transacional do manifesto `plantare-legado/v1` produzido pelo exportador Plantare.
O objetivo é conferir primeira compra e preservar consumo de campanhas, sem
recriar compras, pagamentos, faturamento, notas ou grants de download.

A função exige `AMBIENTE=teste` e `PLANTARE_LEGADO_IMPORTAR=1`, sem rota HTTP.
Não foi ligada ao coordenador remoto nem publicada. O ensaio
`node homologacao/ensaiar-legado.mjs manifesto.json estado.sqlite [--aplicar]`
opera somente SQLite local privado. Sem `--aplicar`, não escreve registros de
domínio; o arquivo e sua tabela técnica podem ser criados. Não usar caminhos Git
para manifestos/estado. A saída mostra somente digest e contagens.

Repetição exata é idempotente; delta completo referencia digest anterior, não
pode remover pagamentos/usos ou alterar regras. Incrementos legados preservam
compras centrais posteriores. Consumos, reservas e capacidade de cupom central
são conservados; colisão de dono/talhão bloqueia. Qualquer conflito ou falha de
escrita reverte a transação inteira. Histórico perdido ou pré-conferido sem marco
exige revisão. Limite de manifesto: 100.000 bytes, sem paginação nesta etapa.

O catálogo de regras ainda deve ser conferido e configurado no corte: importar
consumos não publica `PLANTARE_CUPONS`. O manifesto completo é privado e o digest
não substitui autenticação. O backup real anterior (uma conta, uma compra paga e
três campanhas) foi exportado, simulado e importado em SQLite isolado; repetição
após reinício e delta sem alterações mantiveram as contagens. Não é prova de
delta produtivo nem importação no DO remoto.

Cinco testes novos cobrem gates, simulação, concorrência, idempotência, delta com
histórico central, rollback por falha, conflitos e efeitos no reservador real.
A suíte fiscal antiga excedeu localmente seu limite de CPU de 10 ms; o limite
foi preservado e a execução CI deve ser conferida antes de integrar.

Procedimento completo: `docs/ATOS-M4-LEGADO.md` no PR correspondente Plantare.
Continuam pendentes aplicação remota isolada, congelamento/delta/coorte, dreno,
webhook originado no Mercado Pago e login OIDC remoto. Nenhum corte nesta etapa.
