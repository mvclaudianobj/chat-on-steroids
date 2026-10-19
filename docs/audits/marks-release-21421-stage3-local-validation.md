# Etapa 3 — ensaio local do release rápido (19/10/2026)

## Escopo e identidade

Ensaio local no Linux x64 em worktree isolada, branch `validation/marks-release-21421-stage3`, sem publicar ou instalar pacotes. A primeira execução partiu do commit de auditoria `a5f71a3b`; a segunda, com guarda de dependências incorporada, usou `966819f2cddaad1d1108007f5cdda40f83c4b9f2`. Os commits posteriores deste branch só mudam workflow, testes e documentos; **os bytes locais são evidência do SHA 966819f2, não de um novo run GitHub**. Nenhum asset foi reutilizado para sobrescrever a tag pública.

## Execuções locais medidas

| Execução | Dependências | Tempo real | Resultado |
| --- | --- | ---: | --- |
| Primeira, `local-release --level package` | `node_modules` apontava simbolicamente à árvore principal | 3m54,06s | **Falha correta no smoke**: faltou `detect-libc` no `sharp` empacotado, embora AppImage/DEB tivessem sido produzidos |
| Segunda, após proteção no CLI e `npm ci --prefer-offline` local | `node_modules` diretório real instalado nesta worktree | 1m58,61s | **PASS**: empacotamento Linux x64 e smoke runtime; smoke repetido PASS |

A comparação entre as duas execuções NÃO é benchmark controlado de speedup: a primeira inclui um erro de dependência e a segunda aproveita downloads/cache do sistema. O segundo tempo é medida do caminho válido nesta máquina, não previsão de Windows/macOS.

## Correções e evidências

- `local-release.mjs` agora bloqueia empacotamento com `node_modules` ausente, arquivo ou symlink para outra árvore. Teste de regressão em `test/marks-community-merge-guard.test.ts` (5/5 PASS); mantém o veto a HEAD não pinado ou worktree Git dirty.
- `npm ci --prefer-offline` local gerou dependências próprias. `THIRD-PARTY-NOTICES.txt` gerado durante o pacote é derivado e pode variar por opcionais/plataforma; nenhuma variação derivada ficou no commit final.
- O pipeline acelerado inicialmente perdeu `typecheck` e `verify:notices` nos três runners secundários. Corrigido por `ea75f3b3`, mantendo checks obrigatórios nos seis alvos e `verify:ci` por SO em paralelo com os pacotes. `npm run typecheck`, 40/40 testes focados e validações actionlint do worker passaram; **o novo workflow ainda não foi executado no GitHub**.
- Linux AppImage e DEB gerados: `Chat-Marks-Linux-x64.AppImage` (ELF x86-64) SHA256 `4b298bfb488cdfc52741a5388695827fb23636c321389d8f25d317b161466681`; `Chat-Marks-Linux-x64.deb` SHA256 `1b8fc42e9037f019a8960678d9dcea3cc279323bb2ea5fce780f20e0ebece026`. DEB `Package: chat-on-steroids`, `Version: 2.1.42.1-1`, `Architecture: amd64`.
- `app.asar/package.json` declara `2.1.42.1`; DEB contém `/opt/Chat Marks/chat-marks`, desktop entry e ícone `chat-marks.png`; `smoke-packaged-runtime.mjs --platform linux --arch x64` passou novamente. Avisos GLib de ambiente gráfico local não alteraram o exit 0 do smoke. Nenhum teste de instalação real DEB/AppImage foi feito.
- A release GitHub já publicada `v2.1.42.1` contém 15 assets e SHA256SUMS. O fluxo novo não é o mesmo SHA da tag publicada: nunca misturar os artefatos desta validação com essa release.

## Tempo real do GitHub e gargalo

Ver `marks-release-21421-stage3-actions-timings.md` para dados verificados pela API. Em síntese: tentativa 1 do publish falhou por HTTP 500 externo no macOS Intel; rerun seletivo passou. Ciclo total 69m45s; segunda tentativa 33m12s. O macOS x64 na segunda tentativa levou 28m11s, com `Package` 22m56s. Anteriores comparáveis: jobs Intel de 46m36s e 48m23s, redução observada de ~39,5–41,8% por deslocar Verify para macOS ARM64, **não** atribuível a cache. O novo cache Electron da Etapa 1 só poderá ser medido após CI da branch revisada.

## Comandos próximos merges e fallback

```sh
# Worktree nova, commit integrado revisado, sem node_modules compartilhado:
npm ci --prefer-offline
HEAD_SHA=$(git rev-parse HEAD)
node .agents/skills/marks-community-merge/scripts/local-release.mjs --head "$HEAD_SHA" --level check --test test/marks-merge-preservation.test.ts --execute yes
node .agents/skills/marks-community-merge/scripts/local-release.mjs --head "$HEAD_SHA" --level package --platform linux --arch x64 --execute yes
node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64
sha256sum release/Chat-Marks-Linux-x64.AppImage release/Chat-Marks-Linux-x64.deb
```

Se o comando impedir a execução por symlink, instalar dependências reais **na worktree isolada**; não remover arquivos da árvore compartilhada. Se o smoke falhar, não aprovar o pacote mesmo que o AppImage/DEB exista. Para outros SOs, usar runners reais (Windows/macOS) no workflow `release.yml`; `publish.yml` apenas com tag e aprovação de publicação, mantendo preflight, checksum, build+smoke de cada alvo. Em falha transitória, reexecutar somente jobs falhos na mesma tag/SHA, inspecionando jobs/artefatos. Mudança de fonte exige **nova revisão/tag**, nunca reescrever a publicada. Consulte o `references/commands.md` da Skill para preflight, proteção de origem e rollback em nova worktree.

## Limites de aprovação

Esta etapa valida em runtime local somente Linux x64. O instalador não foi aplicado à máquina host; não há benchmark de cache GitHub novo, Windows/macOS executáveis novos nem prova de autoatualização da instalação do usuário. Esses gates permanecem explícitos antes de uma futura publicação.
