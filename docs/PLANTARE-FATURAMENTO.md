# Plantare: faturamento e fila fiscal compartilhados

Extensão de M2, disponível somente com o checkout de teste habilitado. A compra
`cmp-UUID` conserva o mesmo identificador no coordenador Plantare, nas faturas
da Minha conta e no emissor de NFS-e da Atos.

## Fluxo e recuperação

A gravação da compra agenda uma outbox financeira na mesma transação SQLite.
O alarme entrega a versão corrente ao `ClienteCobranca` da conta e, para valores
positivos com pagamento registrado, ao `EmissorNFSe`. A confirmação de uma
versão antiga não apaga uma atualização mais recente. Leituras de compras
anteriores à integração recuperam a outbox sem alterar sua versão pública.

Cada destino valida identidade, valor e transições, ignora versões antigas e
rejeita conteúdo divergente na mesma versão. A entrega percorre até 16 itens
por rodada, com rodízio e repetição entre um minuto e uma hora. Uma falha de
entrega não desfaz o pagamento já registrado.

O histórico do cliente usa armazenamento durável. O emissor mantém um registro
financeiro forte em SQLite; o KV serve como projeção e índice de descoberta.
A ausência ou desatualização dessa projeção não autoriza outra DPS. Qualquer
nota original anterior, inclusive cancelada ou descartada, impede gerar outra
original pela repetição da compra; substituição segue o fluxo fiscal existente.
As tabelas `plantare_financeiro` e `plantare_conciliacoes` são aditivas no emissor
existente e não criam outra classe de Durable Object.

Compras pendentes aparecem no faturamento; cortesias não geram cobrança nem
nota fiscal. Emissão automática depende da configuração fiscal e dos dados
completos do cliente. Falhas e dados faltantes ficam na fila para recuperação.
Além da trava do checkout, a emissão Plantare exige `producao_restrita` no
prestador. Esta entrega não libera emissão ou checkout em produção.

## Devoluções e conferência fiscal

Uma devolução anterior à emissão impede uma nova DPS. Se a nota já existe,
o documento é preservado e aparece uma pendência de conciliação no painel
fiscal, mesmo que esteja emitido. Dono e financeiro podem registrar uma
justificativa para a versão corrente; suporte apenas consulta. O registro
conserva autor e data, aceita repetição idêntica e rejeita versão desatualizada
ou justificativa conflitante. Essa ação registra a conferência: não cancela
nota fiscal, não transfere dinheiro e não restaura direitos no Plantare.

## Evidências e próximos passos

Validação de 26/10/2026: 125 resultados na suíte essencial, incluindo 19 novos
testes de faturamento com SQLite real, cliente e emissor reais e Sefin simulada.
Os cenários cobrem confirmação perdida, reinício do emissor, KV indisponível,
versões concorrentes, dados fiscais incompletos, devolução durante a preparação
da emissão, proteção contra segunda DPS e auditoria da conciliação.

No runtime Cloudflare local, três Durable Objects reais e KV local executaram
compra, faturamento, emissão simulada e devolução. Edge/Playwright validou o
componente real do painel, justificativa e registro da conciliação. Gateway,
Sefin, credenciais e identidade administrativa desse harness eram sintéticos;
isso não substitui homologação com serviços externos ou entre dois Workers.

M2 continua aberto para a operação de tentativas de pagamento em revisão.
Depois seguem M3 (receptor, projeção de direitos, downloads e legado no
Plantare) e M4 (gateway real de teste e integração entre os Workers). A
autorização de 24/10/2026 para ativar produção quando pertinente permanece
registrada; essas entregas e um corte reversível devem preceder a ativação.
