# Empresa O7 — contrato de identidade e recibos do broker local

## Contrato HTTP observado no código de 2026-10-24

O listener de controle local autentica chamadas por token de inicialização e exige
`controlApi.enabled`, `controlApi.allowActions`, `multiAgent.enabled` e o perfil
de conexão corrente. `ownerId` no caminho seleciona uma família local do broker;
não identifica o CEO nem concede direito sobre outra família. Rotas concretas:

| Método e rota | Identidade/retorno atualmente observado |
| --- | --- |
| `POST /v1/workers/{ownerId}/spawn` | Corpo `workers[].{label,task}`; resposta `runId,workers[].{id,label,state}` sob a família local do owner |
| `GET /v1/workers/{ownerId}?runId=...` | `runId,workers[].{id,runId,label,state,conversationId,sessionId,revivable,pending,awaitingAck,contextTokens,result}`. O `label` é atribuído pelo requisitante; `conversationId` é observado/bindado pelo broker e só é prova local |
| `GET /v1/workers/{ownerId}/reports?runId=...` | `messages[].{id,runId,from,time,text,origin}`; `origin` é `authenticated-worker-message` apenas para mensagem enviada a partir do caller de uma conversa worker reconhecida; a conclusão gerada pelo próprio broker recebe `broker-event` |
| `POST /v1/workers/{ownerId}/ack` | `runId,messageIds` → `acknowledged[]` dos receipts realmente aceitos. ACK persiste no snapshot do broker; o recebedor deve verificar o ID devolvido |
| `POST /v1/workers/{ownerId}/message` | Mensagens endereçadas a worker e recibos de fila; nenhuma alegação de presença externa |

**Atestação externa ausente:** não há `GET /v1/workers/{ownerId}/attestation` nem retorno assinado
que ligue `ownerId + runId + workerId + conversationId + marksN + grant epoch/TTL/revoke`
a um principal externo validado pelo provedor. `GET /attestation` responde HTTP 404 na fixture HTTP.
`status` não traz campos `attestation`, `signature` ou `seat`; a cadeira só aparece dentro
do label de atribuição `marksN:<ticketId>`, que não é certificação externa.
O `origin` de report comprova a classificação feita no broker local, não uma assinatura do ChatGPT.
O token bearer protege a API loopback, não prova a identidade de um COO externo.

As delegações O7 continuam em modo **manual** por padrão. A regra local de
`internal-triage` usa grant explícito, `scope`, `epoch`, TTL de cinco minutos,
revogação e auditoria durável; não transforma um papel `marks-coo` sem identidade
atestada em aprovador automático. O tamanho de `marks1..N` define apenas cadeiras.

## Garantias implementadas para o ciclo normal de ticket

O fluxo de ticket iniciado pelo CEO usa o mesmo broker local com autorização
explícita: reservar → spawn exatamente uma vez → bind owner/run/worker → verificar
`conversationId` não vazio para entrar em `working` → observar resultado
terminal da mesma conversa → exigir `broker-event` gerado pelo servidor, com
receipt exato → revalidar a conversa e resultado após buscar o report → registrar
em `review` → `ack` do mesmo receipt → revisão humana para `done`.

Um worker recém-admitido em estado `invited`/`waking` pode ainda não ter
`conversationId`; fica pendente e **não** é exibido como trabalhando.
O ID da conversa é guardado no ticket quando verificado e reavaliado em consultas
posteriores, inclusive após restart. Substituição, ID ausente, run estranho,
cadeira/label incompatível e `authenticated-worker-message` contendo texto que
imita mensagem de conclusão são recusados. O painel de observabilidade segue
a mesma guarda e degrada para desconectado/erro quando falta identidade.

Se o relatório foi registrado e o ACK falhou, outra consulta tenta confirmar
**apenas** aquele ID já persistido, sem gerar uma segunda conclusão no Company.
Esse protocolo dá idempotência local; não afirma transação distribuída atômica
entre o broker e o arquivo Company. Uma autorização aceita ainda não garante que
o navegador, conta ou modelo externo de fato executaram a tarefa.

## Evidência e limite de homologação

`test/control-api-workers.test.ts` usa servidor HTTP loopback verdadeiro, bearer
**sintético** no perfil HOME efêmero, ciclo completo de ticket, conversation binding
injetado pela fixture de `agents`, reports e ACK, isolamento de owner e 404 de
atestação. `test/company-broker.test.ts` testa ausência/troca de conversa entre
status e reports, report falsificado, reexecução de ACK após falha e relatório
idempotente. `test/company-observability.test.ts` cobre apresentação de worker
sem conversa ou com conversa trocada. Tudo ocorre em processo de teste; **nenhum
worker externo ChatGPT nem principal CEO foi autenticado ou acionado**.

Um futuro contrato real de provedor precisa incluir atestado emitido/validado
por fonte independente, audiência/principal, binding de conversa e worker, nonce
ou revisão de emissão, epoch, TTL e revogação. Até isso existir e ser homologado,
nenhum status local ou texto do modelo autoriza elevar permissões de COO.
