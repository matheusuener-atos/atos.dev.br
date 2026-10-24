# Verificação de conta e cobrança

O ponto de entrada da verificação essencial da plataforma é `npm test`, na
raiz do repositório, com Node.js 24 ou mais recente. Os testes selecionados
usam apenas o Node e os arquivos versionados: não exigem `npm install`,
credenciais, Wrangler, acesso a contas de produção ou serviços externos.

## Comandos e cobertura

| Comando | Arquivos executados | O que verifica |
| --- | --- | --- |
| `npm run test:conta` | `worker/teste.mjs`, `teste-oauth.mjs`, `teste-seguranca.mjs`, `teste-avisos.mjs`, `teste-admin.mjs`, `teste-admin-workspace.mjs` | Cadastro, sessões, OpenID Connect/PKCE, permissões, segunda etapa, chaves de acesso, revogação, avisos assinados e operações administrativas |
| `npm run test:cobranca` | `worker/cobranca/teste.mjs`, `worker/teste-nfse-atos.mjs`, `teste-nfse-emissor.mjs`, `teste-nfse-semente.mjs` | Assinaturas, Pix, direitos, isolamento de contas, idempotência, reentrega de eventos e fluxo do emissor fiscal com respostas simuladas |
| `npm run test:integracao` | `worker/teste-linguagens.mjs` e `pacotes/entrar/teste/{aviso,botao,fedcm,menu}.test.mjs` | Sincronização dos exemplos e arquivos publicados, assinatura dos avisos, botões, menu e contrato FedCM com Worker simulado |
| `npm test` | Os três grupos acima, nesta ordem | Verificação essencial completa; para no primeiro grupo reprovado |

O runner nativo do Node executa cada arquivo em processo isolado, com limite
de dois minutos por arquivo. Os testes antigos do Worker imprimem suas
checagens e encerram com código diferente de zero quando há falha; o runner
reporta esses arquivos como testes, e não cada checagem interna separadamente.
Os testes do pacote usam `node:test` e aparecem individualmente no relatório.

O workflow `.github/workflows/ci.yml` executa o mesmo comando em Linux e
Windows, no Node 24, em pull requests e alterações da `main`. Também pode ser
iniciado manualmente no Actions. Não faz deploy, não configura infraestrutura
e não usa segredos. Uma falha de asserção, importação, processo ou timeout
reprova o job. Ao corrigir uma falha, execute o grupo correspondente e depois
`npm test` antes de enviar a alteração.

## Verificações complementares

Esta é a base essencial, não a totalidade dos testes existentes. As suítes
`worker/teste-{alias,email-atos,entradas,fedcm,formularios,integracoes,links,plano,portfolio,status,workspace,workspace-entrar}.mjs`
podem ser executadas individualmente com `node <arquivo>` para mudanças
nessas áreas. Elas não estão incluídas neste primeiro workflow.

- **SDK contra o runtime local:** `npm test --prefix pacotes/entrar` inclui
  `entrar.test.mjs`, que inicia o Wrangler e um servidor local. Exige Wrangler
  disponível e portas locais; a preparação está em `pacotes/entrar/teste/atos-local.mjs`.
  A base essencial executa somente os quatro arquivos sem esse requisito.
- **Exemplos completos:** `exemplos/entrar-com-atos/testar.mjs` exercita as
  aplicações Python, .NET e Node contra o Worker local. As dependências de
  cada exemplo e o Wrangler devem estar preparados; veja os argumentos no
  README. `testar-env.mjs` também depende dos shells usados para os comandos.
- **Provas fiscais e desempenho:** `worker/teste-nfse-prova.mjs` compara
  fixtures e possui uma comparação opcional com Python em caminho local do
  Coryphaeus; `worker/teste-nfse-danfse.mjs` inclui medições de CPU. São
  verificações complementares, não um critério de desempenho portátil do CI.

## Limites e validação antes de publicar

Os doubles em memória e as respostas simuladas não comprovam comportamento
do KV ou Durable Objects reais, entrega de e-mails, pagamento aceito pelo
Mercado Pago, emissão fiscal homologada, nem a interface em navegadores.

Para uma alteração nessas integrações, registrar na issue ou no PR o roteiro
executado no ambiente de teste: login e revogação, transação de teste e
repetição do webhook, direitos recebidos pelo produto e emissão em
homologação quando aplicável. Usar apenas credenciais do ambiente de teste,
sem copiá-las para o Git ou para o relatório. O resultado deve distinguir
teste simulado, teste de integração e confirmação humana.

O workflow é uma verificação disponível no PR. Torná-lo obrigatório para
merge exige configurar as regras da branch separadamente.
