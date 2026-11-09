# Stage 3 — tempos observados da release v2.1.42.1

**Coleta:** 2026-10-19. **Escopo:** auditoria estritamente de leitura de GitHub Actions; nenhum workflow, build, teste, tag ou release disparado. Horários UTC; durações são diferenças entre `started_at` e `completed_at` das APIs, arredondadas aos segundos. A execução comparada usa exatamente o SHA da tag; os runs históricos têm SHAs e versões diferentes e são somente amostras observacionais, não benchmarks controlados.

## Fontes reproduzíveis e identidade

- Publicação analisada: [run 39252109483](https://github.com/mvclaudianobj/chat-on-steroids/actions/runs/39252109483), workflow `.github/workflows/publish.yml`, tag `v2.1.42.1`, `head_sha=6a64f1518d523adb75304ad2d5e9e40c5cdf66d7`, evento `push`, `run_attempt=2` e conclusão final `success`. API: `gh api repos/mvclaudianobj/chat-on-steroids/actions/runs/39252109483`.
- Jobs por tentativa: `gh api 'repos/mvclaudianobj/chat-on-steroids/actions/runs/39252109483/attempts/1/jobs?per_page=100'` e `/attempts/2/jobs?per_page=100`. **Na tentativa 2 a API inclui jobs bem-sucedidos reutilizados da primeira**, cujos `started_at`/`completed_at` são anteriores à reexecução; seus novos `created_at` não são tempos reais de espera.
- Etapas/runner macOS x64: `gh api repos/mvclaudianobj/chat-on-steroids/actions/jobs/118058359513` (tentativa 1, falha) e `.../118074390521` (tentativa 2, sucesso); logs: `gh api repos/mvclaudianobj/chat-on-steroids/actions/jobs/<JOB_ID>/logs`.
- Amostras históricas bem-sucedidas da mesma família `release.yml`, runner `macos-15-intel` e alvos DMG+ZIP: [run 39182317456](https://github.com/mvclaudianobj/chat-on-steroids/actions/runs/39182317456), SHA `4fcc4e7df1dc5aa639350b0e4be1a282d40ee128`, job `117837524493`; [run 39087713537](https://github.com/mvclaudianobj/chat-on-steroids/actions/runs/39087713537), SHA `88e7083debdc9ee6d05d7e0c3f742cdd74ba45f6`, job `117557702733`. Ambos são `workflow_dispatch`, no ramo `integration/marks-community-2.1.40`, e não publicações da v2.1.42.1.
- A [release pública](https://github.com/mvclaudianobj/chat-on-steroids/releases/tag/v2.1.42.1) foi publicada às **13:35:32Z** e tem **15 assets** (incluindo seis famílias de instaladores, fontes nativas, extensões, manifesto Firefox e `SHA256SUMS.txt`), conforme `gh release view v2.1.42.1 --json assets,publishedAt`. Asset publicado não substitui smoke de instalação no computador do usuário.

## A distinção crucial: houve uma falha e uma reexecução

| Ponto do ciclo | Início (UTC) | Fim (UTC) | Duração / observação |
| --- | --- | --- | --- |
| Run criado → fim da **tentativa 1** | 12:26:45 | 12:57:41 | **30min56s**; macOS x64 falhou; assemble, publish e verify ficaram `skipped` |
| Intervalo até reexecutar | 12:57:41 | 13:03:18 | **5min37s** sem execução do novo job; não é fila de runner |
| **Tentativa 2** (`run_started_at`) → conclusão | 13:03:18 | 13:36:30 | **33min12s**; reexecutou macOS x64, assemblou, publicou e verificou |
| Run criado → sucesso público | 12:26:45 | 13:36:30 | **69min45s** de tempo de parede total, incluindo primeira falha e pausa |

**Fila efetivamente observada:** macOS x64 da tentativa 1 foi criado às 12:27:10 e começou às 12:28:46 (**1min36s**). Na segunda, `created_at=13:03:21` e `started_at=13:03:27`: **6s**. O aparente atraso de ~36 minutos entre criação do *run* e novo job decorre de `run_attempt=2`; não é fila de 36 minutos do macOS Intel.

O macOS x64 da primeira tentativa falhou após **18min41s** (12:28:46–12:47:27); sua etapa `Package` terminou com `failure` após **17min32s** (12:29:51–12:47:23). O log, às **12:47:22Z**, registra `HTTPError: Response code 500 (Internal Server Error)` na biblioteca HTTP `got`, após começar as produções ZIP/DMG. **O URL/serviço que respondeu 500 não está identificado nesse trecho de log**: evidência de erro HTTP remoto, não prova de causa GitHub, limite de taxa, cache ou defeito do código. Uma reexecução sem novo SHA terminou com sucesso, compatível com falha transitória, mas insuficiente para provar a causa.

## Métricas dos jobs macOS x64 — comparação responsável

| Run (resultado) | Job `started_at` → `completed_at` | Job total | Gate Verify no job | Step Package | Verificar arquivos DMG/ZIP | Upload |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 39087713537 (`success`) | 2026-10-18 01:47:05 → 02:35:28 | **48min23s** | **22min20s** (`Verify`) | **20min28s** | 3min01s | 31s |
| 39182317456 (`success`) | 2026-10-19 00:47:12 → 01:33:48 | **46min36s** | **24min09s** (`Verify`) | **17min23s** | 2min32s | 30s |
| 39252109483, tentativa 1 (`failure`) | 2026-10-19 12:28:46 → 12:47:27 | **18min41s** | 18s (`Verify source contracts`) | **17min32s**, **falhou** | não executado | não executado |
| 39252109483, tentativa 2 (`success`) | 2026-10-19 13:03:27 → 13:31:38 | **28min11s** | **12s** (`Verify source contracts`) | **22min56s** | 2min42s | 24s |

Na segunda tentativa, `npm ci` consumiu **44s** (13:03:45–13:04:29); auditoria de bundle 29s; smoke nativo 2s; lançamento do aplicativo 15s; pós-job alguns segundos. O tempo de `Package` corresponde a cerca de **81%** do job de macOS x64 concluído. Em relação aos jobs históricos, o job diminuiu **18min25s (~39,5%)** vs 39182317456 e **20min12s (~41,8%)** vs 39087713537, **mas o `Package` piorou** respectivamente **5min33s** e **2min28s**. Não se pode atribuir a redução total a cache ou compressão mais rápida.

**Causa observável da diferença de job:** os dois históricos executaram a suíte `Verify` inteira no macOS x64 por 22–24min. A tag v2.1.42.1 usa o gate `Verify source contracts (secondary architecture)` em macOS x64 (12s), deixando a suíte nativa extensa para macOS arm64. No run 392, o macOS arm64 executou `Verify OS contracts (primary architecture)` por **15min57s** e `Package` por **9min35s**, terminando o job em **28min29s** (12:29:11–12:57:40, tentativa 1). Isso é redistribuição da verificação entre arquiteturas, com smoke real de todas as seis plataformas mantido, e não desaparecimento de todos os checks. Uma falha no contrato do macOS arm64 continuaria bloqueando a montagem.

**Comparação fim a fim:** os candidatos históricos, ambos de uma única tentativa, levaram **48min42s** (39182317456: 00:46:54–01:35:36) e **50min23s** (39087713537: 01:46:50–02:37:13) do início do run à montagem; na segunda tentativa do run 392 foram **30min12s** (13:03:18–13:33:30) até montagem, mas com artefatos bem-sucedidos reutilizados da tentativa 1. Assim, esta diferença **não é um benchmark justo de rebuild completo**. O ciclo total da publicação v2.1.42.1, com falha e reexecução, foi 69min45s; os runs históricos citados nem sequer incluíam os jobs extras de Publish/Verify.

## Gargalo macOS x64: etapa Package, arquivos e rede

O log da **tentativa 2** mostra eventos reais do build:

| Evento no log | UTC | Evidência / interpretação limitada |
| --- | --- | --- |
| Início do passo `Package` | 13:04:41 | Job API; bundle e preparação de binários nativos se iniciam |
| `Downloading Electron binary...` | 13:04:42 | Mensagem genérica; **não delimita todo o tempo de download**, pois o build e a preparação continuam entre eventos |
| Electron concluído / extraído | 13:06:26 / 13:06:35 | `electron-builder` marca progresso 100% e extração concluída; sem bytes/tempo líquido da requisição |
| `icons-bundle` baixado | 13:07:08 | Download de ferramenta do builder confirmado |
| `dmgbuild-bundle` e `7zip` baixados | 13:07:31 | Dependências de empacotamento disponíveis antes do longo intervalo |
| DMG block-map gerado | 13:09:58 | Log do builder; ZIP/DMG são montados em paralelo |
| ZIP block-map gerado | 13:27:14 | **17min16s** após o evento DMG; esse intervalo inclui processamento paralelo de ZIP/DMG, sem evidência de atribuição integral à geração do block-map |
| Step `Package` termina | 13:27:37 | **22min56s** no total |
| Verificação de arquivos DMG/ZIP | 13:28:08–13:30:50 | **2min42s** de `hdiutil verify`, `unzip -tq`, extração e smoke de arquivo |

Nos históricos, o intervalo entre os dois eventos de block-map era **11min26s** (39182317456, 01:18:05→01:29:31) e **15min12s** (39087713537, 02:14:57→02:30:09). O intervalo atual de 17min16s reforça que a fase tardia de arquivamento/compressão merece perfilamento, **mas não demonstra** se a causa é CPU, I/O, tamanho de recursos ou condições do runner. Não há telemetria de CPU/disco nem métrica isolada por transferências na API de Actions; tampouco há benchmark repetido em mesmo hardware e cache.

### Cache observado (não presumido)

- O build final v2.1.42.1 registra **`npm cache is not found`** no macOS Intel; ao final salva `node-cache-macOS-x64-npm-69623b...`. Na tentativa 1 também faltava o cache npm; o histórico 39087713537 começou frio e salvou uma chave diferente `...1e1c016...`, enquanto o histórico 39182317456 teve **cache npm hit** dessa chave. Portanto a redução de tempo da tentativa 2 **não pode ser atribuída ao acerto de cache npm**.
- O binário Node foi encontrado no `hostedtoolcache`, o que é diferente do cache npm. Electron, icons, 7zip e dmgbuild tiveram mensagens de download durante `Package`, porém o log não oferece duração líquida nem taxa de transferência para cada recurso.
- A revisão publicada (`git show v2.1.42.1:.github/workflows/release.yml`) contém apenas `actions/setup-node` com `cache: npm`, **sem** um passo `actions/cache` específico de `ELECTRON_CACHE`/`ELECTRON_BUILDER_CACHE`. A otimização posterior da Stage 1 (`8838dabf`, jobs de contratos paralelos e cache explícito de downloads Electron) **não fazia parte do SHA publicado `6a64f151`**, e nenhum ganho do run 392 pode ser creditado a ela. Não inferir hits ou misses de caches que não foram configurados nessa tag.

## Caminhos de fallback e decisão operacional

| Condição verificada | Próximo passo seguro proposto | Condição de liberação |
| --- | --- | --- |
| HTTP 500 durante o build macOS x64, demais alvos concluídos | Inspecionar log do job e **reexecutar só os jobs que falharam** no mesmo workflow/SHA, após autorização; limitar novas tentativas e registrar o endpoint real se falhar novamente. A segunda tentativa deste run demonstrou sucesso sem mudar o commit. Se uma falha futura ocorrer **depois** de Publish, inspecionar a release já existente antes de considerar qualquer rerun; nunca sobrescrever tag/assets. | GitHub Actions precisa revalidar assemble, SHA256SUMS, Publish e Verify; preservar versão/ref original e checksum final |
| Cache npm miss / binários Electron sem cache explícito | Medir primeiro `npm ci`, downloads e compressão em canaries sem publicação; avaliar cache de download por OS/arch+lockfile e verificar integridade dos conteúdos. Essa mudança cabe ao proprietário de `release.yml` (worker-1). | Nenhum cache de `node_modules`/instaladores prontos; não pular checks nativos; medir várias execuções equivalentes antes de declarar ganho |
| Archive ZIP/DMG permanece lento em macOS Intel | Instrumentar opcionalmente duração e tamanho de ZIP, DMG e suas block-maps em canary; comparar CPUs/runner e armazenamento, sem trocar a arquitetura ou remover smoke. | Compilação e validação de ambos os formatos mantidas, SHA e smoke de payload preservados |
| macOS Intel runner indisponível ou falhando continuamente | Marcar candidato incompleto e aguardar runner macOS Intel compatível ou usar runner nativo substituto auditado; não declarar pacote macOS x64 testado por build em outro SO. | Seis destinos e gates obrigatórios aprovados antes da publicação completa |
| Reexecução reaproveita jobs concluídos da tentativa anterior | Examinar **attempts/1** e **attempts/2**, verificar `head_sha` igual e conferir SHA256SUMS após o assemble, sem confundir reused jobs com execução iniciada em attempt 2. | Proveniência idêntica do commit/tag, artefatos verificados e jobs atuais de assemble/publish pós-rerun aprovados |

**Próxima medição útil:** em um candidato futuro permitido pelo prime, comparar **mesma versão, matriz, cache e runner** em builds repetidos, com tempos das etapas e logs de acerto de cache; um único run com alterações simultâneas e um HTTP 500 não fornece estimativa causal confiável. Nada disso foi disparado nesta auditoria.
