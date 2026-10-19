# Comandos locais reproduzíveis (executar a partir da worktree nova)

Os comandos da Skill ficam em `.agents/skills/marks-community-merge/scripts/`. Adaptar caminhos e SHAs à release conferida.

```sh
# Fora da worktree original: atualizar refs sem substituir tags do fork.
git fetch marks main
git fetch --no-tags upstream refs/tags/v2.1.42:refs/remotes/upstream/releases/v2.1.42
MARKS_SHA=$(git rev-parse refs/remotes/marks/main^{commit})
UPSTREAM_SHA=$(git rev-parse refs/remotes/upstream/releases/v2.1.42^{commit})
git worktree add -b integration/marks-community-2.1.42 .tmp/community-2.1.42 "$MARKS_SHA"
cd .tmp/community-2.1.42

# Registrar evidência em caminho privado fora da worktree; o arquivo nunca é sobrescrito.
node .agents/skills/marks-community-merge/scripts/merge-guard.mjs preflight \
  --marks "$MARKS_SHA" --upstream "$UPSTREAM_SHA" \
  --ref refs/remotes/upstream/releases/v2.1.42 --record ../preflight-community-2.1.42.json

# Somente depois do preflight: merge manual, resolução consciente de conflitos e commits.
git merge --no-ff --no-commit refs/remotes/upstream/releases/v2.1.42
```

**Atenção:** a worktree alvo deve ter os remotes `marks` e `upstream` com URLs oficiais; os scripts nunca os criam.

## Verificar SHAs e pacotes

```sh
node .agents/skills/marks-community-merge/scripts/merge-guard.mjs compare-sha \
  --ref HEAD --expected <SHA_EXATO_DO_COMMIT_REVISADO>

node .agents/skills/marks-community-merge/scripts/merge-guard.mjs compare-sha \
  --ref refs/tags/v2.1.42.1 --expected <SHA_EXATO_DA_TAG> \
  --directory /caminho/release --sums /caminho/release/SHA256SUMS.txt
```

O segundo comando verifica os hashes dos arquivos listados por `SHA256SUMS.txt`. Validar separadamente se todos os alvos exigidos estão presentes com `node scripts/verify-release-assets.mjs /caminho/release v2.1.42.1`. Nem o manifesto nem `SHA256SUMS.txt` provam a origem dos binários por si só; usar o SHA do run GitHub e a revisão/tag correspondente. Recusar uma tag já publicada ou misturar artefatos de dois runs.

## Retornar a uma base segura sem perder trabalho

```sh
node .agents/skills/marks-community-merge/scripts/merge-guard.mjs recovery \
  --record /caminho/privado/preflight-community-2.1.42.json \
  --destination /caminho/novo/recovery-community-2.1.42 \
  --branch recovery/community-2.1.42

# Somente após confirmar destino/branch/SHA na saída anterior:
node .agents/skills/marks-community-merge/scripts/merge-guard.mjs recovery \
  --record /caminho/privado/preflight-community-2.1.42.json \
  --destination /caminho/novo/recovery-community-2.1.42 \
  --branch recovery/community-2.1.42 --execute yes
```

O rollback cria outra worktree em um commit Marks conhecido; a tentativa problemática continua intacta. Destino existente, branch ocupada, baseline alterada ou snapshot de outra worktree causam recusa. Para recuperar uma tentativa já com conflitos, manter seus arquivos enquanto inspeciona a nova base. A remoção posterior de uma worktree deve ser explícita, após arquivamento/revisão.

## Gate de build/release local

```sh
# Lista os comandos sem executá-los (padrão):
node .agents/skills/marks-community-merge/scripts/local-release.mjs \
  --head <SHA_DO_COMMIT_INTEGRADO> --level build --test test/packaging.test.ts

# Executa checks e bundle apenas com HEAD idêntico e worktree limpa:
node .agents/skills/marks-community-merge/scripts/local-release.mjs \
  --head <SHA_DO_COMMIT_INTEGRADO> --level build --test test/packaging.test.ts --execute yes

# Pacote nativo desta plataforma, com publicação desabilitada no owner existente:
 # Nesta worktree isolada, instalar dependências próprias antes do pacote:
 # node_modules NÃO pode ser symlink para outra worktree; electron-builder omite
 # dependências transitivas e smoke rejeita os instaladores incompletos.
npm ci --prefer-offline
node .agents/skills/marks-community-merge/scripts/local-release.mjs \
  --head <SHA_DO_COMMIT_INTEGRADO> --level package --platform linux --arch x64 --execute yes
```

`--level check` executa apenas a auditoria das versões e typecheck (mais testes explicitamente escolhidos). `--level build` acrescenta `npm run build`. `--level package` acrescenta `node scripts/package.mjs`, que prepara recursos nativos por arquitetura e roda o smoke atual. Use a plataforma real do host. Em todas as modalidades, não criar tag, chamar workflow, publicar nem instalar automaticamente. A auditoria de versões exige release notes atuais e o workflow remoto é um gate posterior independente.
