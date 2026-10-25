# Orçamentos Plantare — M1

Implementação da [issue #7](https://github.com/matheusuener-atos/atos.dev.br/issues/7),
baseada no [contrato proposto no PR #6](https://github.com/matheusuener-atos/atos.dev.br/pull/6).
M1 persiste intenções e orçamentos e reserva cupons. Não cria Pix,
checkout, fatura, nota, pagamento, evento financeiro ou direito de download.

## Rotas implementadas

Prefixo: `/api/cobranca/v1/plantare`.

| Método/rota | Comportamento |
| --- | --- |
| `POST /orcamentos` | Valida, calcula e persiste orçamento de 15 minutos; retorna 200 |
| `GET /intencoes/{id}?sub=…` | Recupera snapshot, `expirado` e `compra: null`; retorna 200 mesmo se o orçamento venceu |

O [registro de compras da primeira parte de M2](PLANTARE-COMPRAS.md) estende
essas rotas com uma flag própria e inclui o snapshot em `compra` quando há
rascunho. Sem essa flag, as rotas novas de checkout/compra retornam 404.
Todas as respostas são `no-store`. Não há CORS para o navegador. A rota
autentica o **sistema Plantare**, não uma sessão individual: é responsabilidade
do Worker Plantare extrair o `sub` da sessão da pessoa e medir o talhão.
O token de servidor não deve chegar ao HTML ou a uma janela de checkout.

## Configuração e isolamento

O código vem desabilitado. Para um ambiente isolado, é preciso fornecer:

- `PLANTARE_ORCAMENTOS_ATIVOS="1"`.
- `PLANTARE_COBRANCA_TOKEN`: segredo de pelo menos 32 caracteres, exclusivo
  desta API. É diferente de OIDC, avisos e eventos de cobrança.
- Binding `PLANTARE_ORCAMENTOS`, classe `PlantareOrcamentos`.
- `PLANTARE_LIMITE`: rate limiter configurado em 60 pedidos/minuto; o runtime
  local de teste pode omiti-lo. O limite é do produto, não por pessoa.
- `PLANTARE_CUPONS`: catálogo JSON opcional, vazio por padrão.

O binding, limiter e declaração de migration `v6-plantare-orcamentos` estão
em `wrangler.jsonc`; nenhuma migration remota foi aplicada nesta entrega.
O objeto único é nomeado por ambiente (`producao:` ou `teste:`). A mesma
coordenadora transacional serializa reservas globais de campanha entre contas.
Esse desenho inicial privilegia consistência; reavaliar vazão antes de escalar.

A autenticação é `Authorization: Bearer <segredo>`. Origin de navegador é
recusado, inclusive o da Atos; cookies não autenticam essa API. A proteção
Origin das rotas de páginas permanece. HTTPS é obrigatório, com exceção de
`localhost`/`127.0.0.1` para desenvolvimento. Não cadastrar segredo ou habilitar
o recurso em produção como parte de um teste local.

## Corpo e idempotência

```json
{
  "schema": "plantare-orcamento/v1",
  "intent_id": "int-exemplo-001",
  "sub": "sub-exemplo",
  "area_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "area_cent_ha": 9350,
  "camadas": ["linhas_ab", "bordadura", "percurso", "manobras"],
  "cupom": null
}
```

Exige `Content-Type: application/json`, no máximo 4096 bytes efetivamente
lidos, e `Idempotency-Key` de 8–128 caracteres ASCII de identificador. Intenção:
8–80 caracteres alfanuméricos, `_` ou `-`; sub: 1–200 caracteres alfanuméricos,
`.`, `_`, `:`, `-`. Hash hexadecimal de 64 caracteres. Área inteira entre 1 e
5.000.000 centésimos de hectare. Camadas válidas, não vazias e sem duplicatas.
Campos extras, inclusive preço e produto, são recusados.

O digest usa o corpo normalizado: ordem de campos/camadas e caixa do hash
ou cupom não geram outra intenção. Chave é isolada por produto, sub e
operação. Mesma chave ou intenção com parâmetros diferentes retorna 409.
Outra chave com a mesma intenção e conteúdo retorna o mesmo snapshot.

Intenção, orçamento, chave e reserva são gravados na mesma transação do
Durable Object. Se a resposta se perder depois do commit, consultar a intenção
ou repetir o POST recupera o mesmo ID. Não há efeito externo entre essas
gravações. Reiniciar o objeto não elimina o registro persistido.

Depois de 15 minutos, repetir o POST retorna 410 sem renovar ou apagar o
snapshot; o GET permite consultar o que aconteceu. Uma nova cotação exige
uma intenção nova e explícita. O retorno nunca confirma compra ou pagamento.

## Versão de preço e paridade

A tarifa é `plantare-legado-js-2026-10-v1`, preservando a tabela e a ordem
de cálculo de `plantare-maps` no commit `c18adbd`. Área comercial, taxas,
descontos e valores persistidos usam centésimos de ha, pontos-base e centavos.
A resposta inclui memória por faixa e snapshot do cupom.

**Decisão de compatibilidade:** internamente, a versão inicial conserva as
operações e o `Math.round` do JavaScript legado. Substituir diretamente por
arredondamento decimal exato altera alguns meios-centavos: por exemplo,
600,25 ha com AB/bordadura resultam em 378.122 centavos no legado e 378.123
com decimal exato. Preservar o primeiro evita reprecificar uma migração.
Essa é uma precisão ao desenho inicial do contrato; um cálculo decimal
diferente exige outra versão e decisão de preço, não uma correção silenciosa.

Os testes comparam mais de 100 mil combinações contra uma referência congelada
do código original em `test/fixtures/preco-legado.js`. Essa fixture não entra
no cálculo de produção. Casos ilustrativos: 93,50 ha/todas as camadas = 93.500
centavos; 575 ha/todas = 520.000 centavos. Valor positivo abaixo de 100 centavos
é recusado; cortesia retorna orçamento zero, sem gateway.

## Cupons e limites desta etapa

Exemplo de catálogo exclusivamente para ambiente de teste:

```json
{
  "CAMPO10": {
    "versao": "v1",
    "tipo": "percentual",
    "desconto_bps": 1000,
    "usos_max": 10,
    "ativo": true
  }
}
```

Tipos: `percentual` (1–9000 pontos-base), `fixo` (centavos positivos, nunca
acima do preço normal) ou `cortesia`. Regras opcionais: `valido_ate` UTC,
`area_min_cent_ha`, `usos_max`, `so_primeira`, `ilimitado`, `ativo`.
Definição inválida falha sem produzir orçamento. Alterar definição de cupom
já registrada exige nova versão; versões não apagam reservas ou consumo.

Reservas contam para o limite global e impedem outro uso da pessoa ou do
talhão enquanto vigentes. Expiram com o orçamento e são limpas da lista ativa
na próxima tentativa, preservando os snapshots. Há limite operacional de
128 reservas simultâneas por campanha; saturação retorna 503, não outro preço.
`ilimitado` conserva a exceção legada às restrições de uso/primeira compra,
mas ainda respeita validade, área mínima e versão.

Histórico ausente não significa primeira compra. `so_primeira` retorna 503
até existir histórico conferido. Os testes preparam registros de histórico
e consumo para verificar o contrato, mas não há API administrativa/importador
entregue aqui. Migração do consumo/reservas legados, confirmação/liberação por
pagamento e proteção de reservas durante gateway pendente pertencem a M2/M3.
Não habilitar cupons de produção antes dessa migração.

## Verificação e próximas etapas

`npm test` inclui testes de preço, API e transações em SQLite. Eles cobrem
concorrência, isolamento, adulteração, timeout, rollback, expiração e paridade,
além das regressões de conta/cobrança existentes. O build também foi conferido
com `wrangler deploy --dry-run`; esse comando não publica nem aplica migration.

O runtime local pode ser exercitado com uma configuração Wrangler temporária:
binding só desta classe, migration SQLite, flag ativa, token fictício e
catálogo de teste. Não usar a configuração de produção para homologar.
Registre os resultados de runtime/CI efetivamente executados na issue #7.

Próxima entrega: M2, checkout e direito por compra. Ela deverá manter o
snapshot desta etapa e promover reservas de forma segura antes de qualquer
gateway. O pop-up ou checkout incorporado permanece uma opção futura de
interface, não uma funcionalidade de M1.
