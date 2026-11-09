# Auditoria npm da base Marks — 2026-10-19

**Base imutável:** `marks/main` = `6a64f1518d523adb75304ad2d5e9e40c5cdf66d7`, versão npm `2.1.42+1` / produto `2.1.42.1`. A análise e as alterações foram feitas exclusivamente na worktree `audit/marks-main-npm-security-worker2`, criada diretamente dessa base. Não houve atualização da árvore compartilhada, instalação/release, edição de workflows, versões de produto, tags ou outros branches.

**Metodologia:** npm `10.9.9`, Node `22.23.3`, consulta ao registry em 2026-10-19. `npm audit --json` no lock original: **14 entradas, 6 high e 8 moderate**, sem critical. `npm audit --omit=dev --json`: **4 high de produção**, nenhuma moderate. O npm contabiliza dependências afetadas e seus ancestrais separadamente; 14 entradas **não representam 14 falhas independentes**. A coluna de ambiente se baseia no lockfile (`dev`) e nos importadores efetivos, não apenas na severidade atribuída pelo registry.

## Correções aplicadas (sem mudanças de APIs ou majors)

| Pacote | Antes → depois | Alcance e motivação |
| --- | --- | --- |
| `@modelcontextprotocol/client` (dependência direta) | `2.1.0` → `2.2.0`; mínimo de `^2.1.0` → `^2.2.0` | **Produção/alto**. Corrige [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h), OAuth potencialmente enviando credenciais a authorization server escolhido pelo MCP remoto. Os usos efetivos são `src/main/plugins/manager.ts`, `plugins/oauth.ts` e `plugins/installer.ts`. O client traz seu `@modelcontextprotocol/core@2.2.0` aninhado; o server continua com core `2.1.0`. Mantido o contrato sem mudança forçada de server/node. |
| `http-cache-semantics` (transitiva, `dev: true`) | `4.2.0` → `4.3.0`, só lock | **Infraestrutura de build/alto**. Corrige [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp), interpretação de `max-stale` com possível exposição de resposta em cache entre usuários. Caminho: `electron-builder → app-builder-lib → @electron/get@3.1.0 → got → cacheable-request → http-cache-semantics`. Upgrade permitido no range transitivo; não altera o empacotador. |
| `source-map-js` (transitiva, `dev: true`) | `1.2.1` → `1.2.2`, só lock | **Ferramentas de desenvolvimento/alto**. Corrige [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), DoS por offsets de seções de sourcemap. Caminhos: `vite → postcss → source-map-js` e `jsdom → css-tree → source-map-js`. |

Somente `package.json` e `package-lock.json` foram modificados para instalar as versões corrigidas; o npm manteve lockfile v3 e integrities do registry. Não foram usados `npm audit fix --force`, versões principais novas, `overrides` para contornar advisories ou downgrade de empacotador. A instalação reproduzível na worktree ocorreu por `npm ci --no-audit`, com scripts do pacote executados normalmente.

## Matriz residual: 11 avisos (3 high e 8 moderate)

| Grupo e caminhos confirmados | Ambiente / risco real | Remediação e pendência |
| --- | --- | --- |
| **HIGH:** `sharp@0.35.4`, [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), librsvg, potencial use-after-free. | **Produção**. Sharp interpreta imagens e possui binários nativos incorporados; dados de imagem não confiáveis podem alcançar o decodificador. Esse aviso merece prioridade alta, apesar da indisponibilidade de prova de exploit local. | `0.35.5` é patch disponível **sem salto de versão principal**, mas altera os pacotes opcionais `@img/sharp-*` de `0.35.4` para `0.35.5` e `@img/sharp-libvips-*` de `1.3.3` para `1.3.4`. O projeto impõe inventário/licenças/fontes de origem exata (`docs/licenses/native/sources.json`, `COMPONENT-NOTICES.txt`, `SOURCE-BUILD.md`, `scripts/package-native-sources.mjs`) com **730 arquivos e patches pinados**. Alterar só o lock quebraria o gate e a correspondência entre os fontes distribuídos e os binários. **Não aplicar em uma correção parcial**: fazer atualização nativa dedicada com URLs/SHA dos novos fontes, notices, auditoria LGPL/MPL e smoke das seis arquiteturas antes de publicar. |
| **HIGH:** `@anthropic-ai/mcpb@2.1.2 → node-forge@1.4.0`, [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv); contabiliza **2** entradas npm. | **Dependências de produção instaladas.** Assinatura RSA PKCS#1 v1.5 com DigestAlgorithm ASN.1 extra pode passar na verificação. No pacote, `node-forge` é importado por `@anthropic-ai/mcpb/dist/node/sign.js`. O app usa principalmente `@anthropic-ai/mcpb/browser` para manifestos; não foi reproduzida uma chamada de verificação PKCS#7 pelo fluxo do app, logo **exposição operacional menor que a flag de produção sugere**, sem classificá-la como inexistente. | Registry retorna `node-forge@1.4.0` como a versão mais recente e `fixAvailable=false`. A última versão de `mcpb` é `2.1.2`; não há correção publicada no caminho atual. Acompanhar advisory, upstream ou eventual substituição da biblioteca de verificação assinada. Não introduzir override para versão inexistente. |
| **MODERATE:** `electron-builder@26.17.0`, `app-builder-lib@26.17.0`, `dmg-builder@26.17.0`, `electron-builder-squirrel-windows@26.17.0`, `@electron/get@3.1.0`, `global-agent@3.0.0`, `roarr@2.15.4`, `sprintf-js@1.1.3`. | **Oito entradas concentradas na infraestrutura `dev: true`, não no runtime do app.** A cadeia `app-builder-lib → @electron/get → global-agent → roarr → sprintf-js` sinaliza [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), DoS por precisão sem limite, propagado pelos ancestrais. O empacotador, contudo, manipula downloads, pacotes, assinaturas/instaladores e pode executar com permissões de CI: **risco relevante para integridade/disponibilidade do processo de distribuição**, embora não seja uma exposição direta a usuário final do app. | A versão mais nova de `sprintf-js` informada pelo registry permanece `1.1.3`. O `npm audit` sugere `electron-builder@26.5.0` como `isSemVerMajor:true`, **downgrade fora do range `^26.17.0` e da versão verificada pela release**. Não é um patch compatível, e forçar a alteração pode introduzir regressões de NSIS/DMG. Aguardar versão corrigida da cadeia ou auditar uma substituição específica em trabalho próprio com smoke nativo e checksums. |

**Infraestrutura também é segurança.** `dev: true` indica que o pacote não integra a árvore normal de dependências em produção, mas não significa risco zero: `electron-builder` opera na cadeia que constrói e publica binários, podendo interagir com tokens, mirrors e scripts. Proteger a pipeline e não processar entrada não confiável nesses passos continua relevante. Os dois avisos altos de dev foram corrigidos no mesmo lock.

## Resultado auditável e validação

| Auditoria | Baseline | Após patch |
| --- | ---: | ---: |
| Todos os pacotes — high | 6 | **3** |
| Todos os pacotes — moderate | 8 | **8** |
| Todos os pacotes — total | 14 | **11** |
| `npm audit --omit=dev --json` — high | 4 | **3** |

Comandos realizados nesta worktree, após as alterações:

- `npm ci --no-audit`: **PASS** (`535 packages`, instalação local limpa).
- `npm test -- --run test/plugins-oauth.test.ts test/plugins-manager.test.ts test/plugins-exposure.test.ts test/plugins-installer.test.ts test/plugins-live-proxy.test.ts test/packaging.test.ts test/third-party-notices.test.ts`: **6 arquivos aprovados, 1 skipped; 143 testes aprovados, 2 skipped** (teste de proxy live opcional não executado).
- `npm run typecheck`: **PASS**.
- `npm run verify:notices`: **PASS**; licenças de **163 pacotes de produção**, sete entradas de catálogo e **730 fontes nativas** verificadas contra o inventário ainda pinado (Sharp permanece 0.35.4).
- `npm run build`: **PASS** (Electron/Vite produzidos no host Linux).
- `npm audit --json` e `npm audit --omit=dev --json`: retornam exit **1 esperado**, pois existem advisories residuais; os números acima vêm do conteúdo estruturado, não de um código de saída interpretado como sucesso.
- `git diff --check`: **PASS**.

**Limites:** compilação local e testes unitários não comprovam funcionamento instalado nem comportamento de macOS/Windows, não reproduzem as vulnerabilidades do registry e não constituem autorização de publicação. Nenhum instalador, workflow de release, tag ou push foi gerado. Upgrade nativo de Sharp exige trabalho dedicado; a cadeia MCPB/node-forge e o agrupamento electron-builder devem continuar monitorados por versão, advisory e caminho de execução efetivo. Para revalidar as contagens em outro dia, executar `npm audit --json`/`npm audit --omit=dev --json` sobre o mesmo `package-lock.json` e registrar data/registry porque a base pública de advisories muda.
