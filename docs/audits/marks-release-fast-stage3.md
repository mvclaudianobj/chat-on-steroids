# Stage 3 — Auditoria estática do release acelerado

Commit auditado `a5f71a3b8769863f129864f324a6e95687138752`, branch original `audit/marks-release-21421-stage2`; trabalho em worktree independente `audit/marks-release-21421-stage3-worker1`. Auditoria inicialmente **read-only**; depois da confirmação do defeito, o prime autorizou sua correção **somente nesta worktree**. Sem builds, execução do GitHub Actions, alteração de versão, tag ou publicação.

## Veredito

**Um defeito de cobertura comprovado (P2), corrigido localmente:** a aceleração separou `npm run verify:ci` em `contracts` (Windows x64, macOS arm64, Linux x64), mas removeu do job `package` os comandos `npm run typecheck` e `npm run verify:notices` antes obrigatórios nas outras três arquiteturas. Windows arm64, macOS x64 e Linux arm64 passaram a executar apenas `node scripts/verify-release-version.mjs --package-only` como verificação pré-empacotamento. Os smokes nativos do pacote continuaram intactos; a perda específica era a validação dos contratos/licenças sob dependências instaladas para cada arquitetura secundária. **Não foi demonstrado instalador defeituoso:** o defeito comprovado era o gate ausente.

Evidência reproduzível: `git show 6a64f151:.github/workflows/release.yml` contém `Verify source contracts (secondary architecture)` com os três comandos; `git show a5f71a3b:.github/workflows/release.yml` continha apenas `Verify package metadata` nos jobs de empacotamento. O teste original `test/marks-release-pipeline.test.ts` validava `contracts` e metadata sem exigir equivalência dos checks secundários.

**Correção aplicada nesta worktree isolada:** `release.yml` volta a exigir `npm run typecheck` e `npm run verify:notices` nos três alvos secundários antes de `Package`; `Verify package metadata` permanece em todos os seis alvos, cobrindo o comando original `node scripts/verify-release-version.mjs --package-only` sem duplicação. `contracts` e `assemble.needs` permanecem iguais. `test/marks-release-pipeline.test.ts` agora exige os três predicados de arquitetura, ambos os comandos e a ordem antes de `Package`. O custo extra se limita aos checks leves secundários; não há benchmark.

## Matriz de evidências

| Invariante | Evidência | Resultado |
| --- | --- | --- |
| Gates de publicação | `release.yml:377` `assemble.needs = [plan, package, sources, contracts]`; `publish.yml:72-75,131-138` exige preflight, candidate e assinatura Firefox; `publish.yml:230-238` verifica a publicação | **Preservado**; contratos falhos impedem assembly |
| Paralelismo | `contracts` independe de `package` e `sources`; `package.needs=plan`, matrices têm `fail-fast: false` | **Preservado**; aceleração possível, sem benchmark |
| Matriz nativa | `.github/release-targets.json`: seis pares únicos OS/arch, incluindo Intel macOS e Windows ARM; `release.yml:149-365` preserva prova do runner, smoke, DMG/ZIP, DEB e AppImage | **Preservado**; runner/smoke reais ainda precisam CI |
| Cobertura de fonte por arquitetura | Diff original `6a64f151` → `a5f71a3b` perde `Verify source contracts`; patch local repõe `typecheck` e `verify:notices` nos três secundários, com versão já verificada nos seis | **Regressão corrigida nesta worktree**, CI pendente |
| Cache | `release.yml:104-128`: somente downloads Electron e electron-builder, chave `runner.os` + `matrix.arch` + hash `package-lock.json`, action fixada por SHA | **Escopo coerente**; sem cache de `node_modules` nem binários publicados |
| Identidade de artefatos | Seis `matrix.artifact` distintos, dez pacotes de plataforma distintos; `sources` carrega `package-native-sources`; `assemble` baixa `package-*` do mesmo run com `merge-multiple`, exige os 12 arquivos planejados e calcula SHA256 | **Preservado na definição**; não há atestação de bytes instalados nesta auditoria |
| Publicação e proveniência | `release.yml:414-424` cria `chat-on-steroids-candidate-${{ github.run_id }}`; `publish.yml:173-201` baixa candidato e Firefox com mesmo ID de run e revisa hashes antes de anexar | **Preservado na definição** |
| Segurança e limites | Reuso de cache sem segredos declarados nesses caminhos; `verify:ci` não é omitido nos três OS primários; `npm ci --prefer-offline` mantém lockfile | **Sem desvio estático adicional confirmado**; cache hit e confiança nas dependências exigem CI/inspeção de logs |

## Verificações executadas

- `actionlint v1.7.11` em `release.yml`, `publish.yml` e `canary.yml`: **PASS** (sem diagnósticos).
- Script estático temporário, Python 3 + PyYAML 6, conferiu `assemble.needs`, `package.needs`, `fail-fast`, 3 OS de `contracts`, 6 targets e nomes únicos, 10 assets de plataforma + extensão/fontes, `download-artifact` (`pattern=package-*`, `merge-multiple=true`), upload, smoke nativo, checksum, cache e origem da lacuna via `git show 6a64f151`: **PASS, lacuna confirmada**.
- Após o patch: `npx vitest run test/marks-release-pipeline.test.ts test/packaging.test.ts`: **PASS (35/35)**; `npm run typecheck`: **PASS**; `actionlint v1.7.11` nos três workflows: **PASS**. Um segundo script estático em Python confirmou os três predicados de arquitetura secundária, ambos os comandos prévios ao pacote e a verificação de versão em todos os seis alvos. `npm ci --ignore-scripts --prefer-offline --no-fund --no-audit` somente para as dependências dos testes focados.
- `git status` e `git diff` iniciais: worktree nova limpa. Nenhuma suíte integral de 9 mil testes, build, instalador ou CI remoto foi executado.

**Limites**: análise de YAML/rotas de artefatos, não medição de tempo, nem reprodução nativa, nem prova de hit de cache. O ganho real depende de disponibilidade de runners e cache entre refs/tags. A correção local exige revisão do prime e nova execução GitHub Actions para validar as arquiteturas secundárias.
