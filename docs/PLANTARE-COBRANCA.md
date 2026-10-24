# Plantare na cobrança Atos — contrato proposto v1

Estado: **desenho técnico para implementação**, em 24/10/2026. Nenhuma rota,
migração, flag ou tipo de evento novo descrito aqui existe por efeito deste
documento. A entrega é o contrato e a sequência de implementação da
[issue Plantare #2](https://github.com/matheusuener-atos/plantare-maps/issues/2).

## Diagnóstico do código atual

| Atos | Plantare |
| --- | --- |
| `worker/cobranca/catalogo.js` resolve preços de catálogo | `pix-worker/src/preco.js` calcula preço por área e camadas |
| `api.js:pagar` recebe um ID de preço e cria uma compra | `index.js:criarCobranca` cria diretamente uma order Pix |
| `cliente.js:retrato` resume plano/período por produto | Uma compra libera só um `area_hash` e suas camadas |
| `eventos.js` entrega `direito.atualizado` e `credito.adicionado` | `/atos/avisos` trata revogação de acesso, não pagamento |
| Compras têm referência Atos e valores em centavos | `compras.id` é a order legada ou `CORT-…`; valor é REAL |
| A consulta atual de direitos não lista cada compra | `/pacote` confere dono/chave, pagamento, talhão e prazo |

Cadastrar Plantare no catálogo não implementa a integração. Não representar
um talhão como plano mensal nem como crédito de tokens. O retrato atual de
direitos e a lista limitada de créditos não substituem um registro durável
consultável por compra. A devolução/revogação também precisa de fluxo próprio.

## Autoridade sobre os dados

| Dado/operação | Responsável no destino |
| --- | --- |
| Identidade (`sub`) e perfil fiscal das novas compras | Atos |
| Geometria, projeto, plano, formatos e geração dos arquivos | Plantare |
| Validação do polígono, área e identidade do talhão | Plantare, no servidor |
| Versão da tarifa, cálculo final, cupons e orçamento monetário | Atos |
| Pagamento, referência do gateway, devolução, fatura e nota | Atos |
| Direito por compra, estado e versão | Atos, com projeção local no Plantare |
| Downloads e contador operacional | Plantare |
| Pedidos e cupons anteriores ao corte | Plantare, preservados como legados |

A Atos recebe área medida, camadas e hash, não precisa receber o contorno,
o projeto ou arquivos. O navegador nunca determina `sub`, valor, direito,
data do pagamento ou prazo de download. O Worker Plantare resolve o `sub`
pela sessão e sua conta, não pelo corpo do pedido.

Proposta de escopo v1: novas compras centralizadas exigem Conta Atos. As
compras antigas de visitantes continuam acessíveis pela chave original;
não são vinculadas a uma conta só porque o e-mail coincide. Venda nova sem
conta será uma evolução separada. Essa mudança de fluxo deve ser mostrada
antes do checkout e validada na homologação.

## Orçamento, preço e idempotência

1. O Plantare valida o polígono, incluindo o limite atual de 50.000 ha,
   calcula área geodésica e `area_hash`, e normaliza camadas sem duplicatas.
   Preservar o algoritmo atual de hash: coordenadas arredondadas a sete
   casas e arrays na ordem recebida. Ele não é uma identidade geométrica
   invariável a rotação, orientação ou reordenação de anéis.
2. Uma intenção persistida no Plantare fixa dono, talhão e camadas, com
   `intent_id` e provedor de cobrança. Repetir a mesma intenção não cria
   uma segunda compra. Mudar parâmetros exige nova intenção explícita.
3. O servidor envia `area_cent_ha` (hectares em centésimos), camadas e hash
   à Atos. A Atos aplica a tarifa versionada e devolve um orçamento imutável,
   ligado a `sub`, produto e intenção, com validade proposta de 15 minutos.
4. O usuário vê o orçamento retornado pela Atos e confirma no checkout dela.
   O checkout exige sessão do mesmo `sub`; uma conta diferente não paga
   silenciosamente um orçamento emitido para outra pessoa.
5. Uma intenção e um orçamento só podem originar uma compra central.
   Registrar a compra antes da chamada ao gateway e usar sua referência
   estável como chave idempotente no gateway. Timeout não autoriza nova
   cobrança nem fallback automático para o Mercado Pago legado.

Tarifa inicial proposta: preservar os valores atuais (AB 500, bordadura 200,
percurso 200 e manobras 100 centavos/ha; mínimo 600 centavos/ha). Descontos
progressivos só sobre a área de cada faixa: até 300 ha, 0%; até 600, 20%;
até 1.000, 30%; excedente, 40%. Um talhão de 93,50 ha com todas as camadas
custa 93.500 centavos; 575 ha custam 520.000 centavos antes de cupom.

Usar inteiros para área comercial, centavos e pontos-base. Arredondar cada
faixa para centavos, somar e só depois aplicar o cupom. O teste de paridade
com a implementação atual é obrigatório, incluindo limites e arredondamentos;
qualquer diferença de centavo bloqueia o corte até decisão registrada.
O snapshot guarda a versão da tarifa, quantidades e memória do cálculo;
alterar o catálogo não reprecifica orçamento aceito ou pedido já criado.

Cupons preservam percentual, fixo limitado ao preço normal e cortesia, além
de validade, primeira compra, área mínima, usos e uso por pessoa/talhão.
Não basta copiar o cadastro: importar consumo e reservas ainda válidas.
A Atos deve serializar limites globais por campanha, inclusive reservas
concorrentes; o objeto por cliente sozinho não garante esse limite.
Reservar o cupom com identidade estável da intenção, confirmar no pagamento
e liberar somente após cancelamento/expiração confirmado. Se houver falha
entre objetos/serviços, recuperar pela intenção persistida e compensar a
reserva, sem pressupor transação distribuída. Devolução não restitui uso do
cupom automaticamente. Cortesia gera direito auditado, sem cobrança no gateway.

## API proposta entre servidores

Todas as rotas abaixo são **novas**, ainda a implementar. Prefixo proposto:
`/api/cobranca/v1/plantare`. TLS, `Cache-Control: no-store`, limites de
tamanho e autenticação de produto com escopo exclusivo Plantare.
Preferir service binding quando possível; nas chamadas HTTP, Bearer com
segredo próprio, separado de login OIDC e assinatura de eventos. Não colocar
segredos nem tokens em URLs ou no navegador. Separar ambientes e credenciais.

| Método/rota no prefixo | Entrada principal | Resultado |
| --- | --- | --- |
| `POST /orcamentos` | intenção, `sub`, hash, área, camadas, cupom | snapshot monetário e validade |
| `POST /checkouts` | `orcamento_id`, intenção | ID da compra e URL Atos permitida |
| `GET /intencoes/{id}?sub=…` | intenção estável e dono | orçamento/compra já associados, para recuperar timeout sem conhecer o ID central |
| `GET /compras/{id}?sub=…` | identidade resolvida pelo Worker | snapshot completo da compra |
| `GET /compras?sub=…&cursor=…` | identidade e cursor | compras paginadas, inclusive alterações/revogações |

Nos POST, `Idempotency-Key` é obrigatório e vinculado a produto, `sub`,
operação e digest do corpo. Mesma chave/corpo retorna o mesmo resultado;
chave reutilizada com outro corpo retorna 409. Não descartar o vínculo
idempotente enquanto houver compra/reserva pendente ou registro financeiro
retido. Após timeout, consultar a intenção; não gerar chave nova por tentativa.

Exemplo de corpo do orçamento, gerado pelo Worker, com valores ilustrativos:

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

Aceitar apenas schema conhecido, hash hexadecimal de 64 caracteres, área
inteira positiva dentro do limite e camadas do conjunto fechado. Identidade
e intenção têm limites de tamanho definidos no contrato executável M1. A
resposta inclui os campos acima, `orcamento_id`, `tarifa_versao`, `moeda: BRL`,
`centavos: 93500`, memória do cálculo e `valido_ate` UTC. Erros propostos:
400 para entrada inválida, 401 para produto não autenticado, 403 para dono
incompatível, 409 para conflito idempotente ou reserva, 410 para orçamento
vencido e 503 para dependência temporariamente indisponível. Não retornar
campos de preço parcial como se o orçamento tivesse sido confirmado.

`worker/index.js` hoje exige Origin igual à Atos nos POST de cobrança.
As novas rotas precisam de despacho autenticado de servidor específico,
preservando a proteção das rotas de navegador; não liberar Origin globalmente
nem considerar Origin uma credencial de produto.

O checkout hospedado proposto fica em `/plantare/assinar`. Aceita somente o
ID opaco do orçamento e retorno em allowlist. O redirecionamento de volta,
o QR e os parâmetros da URL nunca confirmam pagamento. Valor zero usa a
rota de cortesia, não uma order de Pix. Valores positivos abaixo do mínimo
operacional atual de R$ 1,00 são recusados, sem arredondar para cima em silêncio.

## Snapshot de compra e eventos

Campos mínimos persistidos na Atos e projetados no Plantare:

| Campo | Regra |
| --- | --- |
| `schema` | `plantare-compra/v1` |
| `id`, `intent_id`, `orcamento_id` | IDs estáveis, nunca ID informado como autoridade pelo navegador |
| `produto`, `sub` | `plantare` e dono da compra |
| `versao` | inteiro crescente por compra; também cresce em devolução/revogação |
| `estado` | `aguardando`, `paga`, `concedida`, `cancelada`, `expirada`, `devolvida` |
| `area_hash`, `area_cent_ha`, `camadas` | escopo imutável do direito |
| `moeda`, `centavos`, `tarifa_versao`, `cupom` | snapshot monetário auditável, BRL |
| `pago_em`, `baixar_ate`, `direito_ativo` | UTC; prazo absoluto, `null` apenas para direito sem vencimento |

O ID do gateway fica na Atos e não é requisito para o Plantare gerar arquivos.
`paga` e `concedida` podem ativar direito; `devolvida` o revoga. A Atos consulta
o gateway antes de registrar uma transição financeira. Notificações repetidas
ou antigas não devem ressuscitar um direito devolvido. Implementar transições
verificadas e reconciliação; uma ordenação numérica arbitrária de estados
não resolve pagamento tardio ou pagamento/devolução fora de ordem.

Evento novo proposto: `compra.atualizada`, produto `plantare`, envelope
atual (`id`, `tipo`, `produto`, `criado`, `conta`, `dados`). `dados` leva o
snapshot completo, não só o valor ou um delta. Não usar `credito.adicionado`
para representar esse direito e não confundir com `acesso.revogado` do Workspace.

Reutilizar a assinatura de cobrança: `Atos-Evento`, `Atos-Assinatura`,
HMAC-SHA256 de `t.corpo` e janela de 300 segundos, com segredo exclusivo do
produto. Cada tentativa renova o timestamp, preservando ID e snapshot.
O Plantare verifica o corpo bruto antes de interpretar, confere schema,
produto, dono, versão e igualdade entre ID do cabeçalho/envelope.

Inbox e projeção devem ser gravadas na mesma transação local. Retornar 2xx
só após persistir; duplicata ou versão antiga válida retorna 2xx sem reaplicar.
Versão maior atualiza; mesma versão com conteúdo diferente deve gerar erro
de integridade e investigação. Evento inválido é recusado. Sem segredo ou
armazenamento, falhar para permitir reentrega.

Eventos não recriam contas apagadas nem vinculam compras por e-mail. Definir
tombstone de exclusão e tratamento de eventos tardios: preservar o registro
financeiro necessário na Atos sem reabrir acesso a dados/projetos no Plantare.

O transporte atual tenta novamente em 1 min, 5 min, 30 min, 2 h e 12 h.
Depois marca falha: a integração deve ter consulta de recuperação por compra,
reconciliação periódica e reenvio administrativo. O retrato agregado atual
`GET /direitos` não recupera o direito de cada talhão.

## Downloads e indisponibilidade

O Plantare continua gerando os arquivos e verifica dono, `area_hash`, camadas,
estado e prazo. Uma compra não libera todo o produto. Para compras centrais,
usar `baixar_ate` do snapshot, não recalcular pelo `REBAIXAR_DIAS` vigente.
Para o legado, preservar a regra atual de 365 dias e o comportamento da
configuração existente, sem alterar IDs ou datas durante a migração.

Proposta conservadora v1: antes de entregar uma compra central, consultar o
snapshot na Atos e atualizar a projeção de forma transacional. Se a Atos
estiver indisponível, responder indisponibilidade temporária; não interpretar
falha como não pagamento nem criar outra cobrança. Isso evita prometer
revogação imediata com cache desatualizado. Cache offline com tolerância de
risco exigirá decisão posterior. Compras legadas seguem seu caminho atual.

Recuperar inbox ou projeção do Plantare não gera pagamento, nota ou cupom
novamente. Restaurar backups não pode reduzir versão financeira nem trocar
o provedor persistido de uma compra.

## Migração, corte e reversão

1. **Inventário e backup:** exportar compras, usos/reservas de cupom e
   configuração do legado; conferir contagens por estado e valores, guardar
   referência do backup e testar restauração em ambiente separado. Não
   copiar dados fiscais automaticamente nem anexar dados reais em issues.
2. **Esquema aditivo:** criar intenções, projeções centrais e inbox em novas
   tabelas. Não renomear `compras`, reescrever IDs de orders ou mudar
   `acesso_hash`. Novas tabelas guardam dono por `sub`, ID central e versão.
3. **Cupons:** preparar snapshot inicial de regras/consumo, suspender novas
   reservas durante o corte e reconciliar o delta de Pix pendentes. Só um
   serviço aceita novas reservas da mesma campanha em cada momento. Pedidos
   antigos podem liquidar depois: esse consumo deve chegar à Atos antes de
   aceitar outro uso conflitante.
4. **Homologação:** ativar somente em ambiente isolado, com credenciais de
   teste. O receptor interno de teste da Atos não prova a projeção no Plantare;
   a homologação precisa de entrega real ao Worker Plantare de teste.
5. **Corte por intenção/coorte:** uma flag proposta escolhe apenas a criação
   de novas intenções. O provedor fica persistido e não muda por alteração da
   flag. Adaptar o app e manter `/status`, `/pacote` e chaves antigas.
6. **Pendências antigas:** manter credenciais e `/webhook` legados enquanto
   houver orders a reconciliar e pelo período operacional definido para
   pós-pagamento/devolução. Confirmar que desligá-los não afeta downloads
   antigos. Não recriar compra antiga ou emitir nova nota pela importação.
7. **Reversão:** parar novas intenções centrais; continuar entregando e
   reconciliando as já criadas pela Atos. Novas intenções só voltam ao legado
   após exclusividade de cupons e ausência de compra central conflitante
   serem verificadas. Não converter timeout em segundo Pix. Reverter código
   sem remover dados novos, inbox, eventos ou as rotas necessárias ao dreno.

## Entregas e critérios de aceite

| Entrega | Critério verificável |
| --- | --- |
| M1 — contrato executável e orçamento | Validação de payload, política versionada, paridade de preço/faixas/cupons, autenticação e idempotência; nenhum gateway de produção |
| M2 — checkout e direito por compra | Intenção persistida antes do gateway; timeout recuperável, cortesia, pagamento, devolução, evento e consulta completa sem afetar PAVLVS/Workspace |
| M3 — Plantare, projeção e compatibilidade | Inbox transacional, rejeição de adulteração, duplicata/ordem, consulta na entrega, contas e visitantes legados intactos; flag só para novas intenções |
| M4 — homologação e corte reversível | Dois Workers de teste, falhas de rede, pagamento tardio, cupom concorrente, devolução, restauração e reversão sem dupla cobrança; checklist com evidências antes de produção |

Pré-requisitos: integrar os PRs de CI [Atos #5](https://github.com/matheusuener-atos/atos.dev.br/pull/5)
e [Plantare #4](https://github.com/matheusuener-atos/plantare-maps/pull/4).
Para cada entrega, registrar testes executados, dados simulados e limites.
Esta proposta não habilita vendas centrais nem altera o tratamento fiscal
atual. Emissão, conciliação e devolução precisam de homologação no fluxo final.
