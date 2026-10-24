# Jarvis no ChatGPT normal — P0 de descoberta da interface

Base verificada: `d076125a` (candidata técnica 2.1.45.3). O envio por voz em ChatGPT normal já estava implementado, mas as instruções de Configurações ainda diziam que CLIProxy era obrigatório; com Jarvis desligado, o microfone do chat também ficava oculto.

## Comportamento

- A tela Configurações → Jarvis explica explicitamente ChatGPT normal (Chat Marks GPT), mostra a conversa ativa, o modelo observado (quando disponível) e oferece retorno ao chat selecionado.
- No compositor de uma conversa ChatGPT normal, o microfone Jarvis aparece mesmo antes da ativação, desabilitado e com o botão **Set up Jarvis**. O botão abre as configurações, sem solicitar microfone por conta própria.
- A tela informa separadamente falta de STT, ausência de consentimento por sessão e TTS desligado ou indisponível. CLIProxy é uma rota opcional para chat e também pode fornecer STT; g4f.space continua exclusivamente provedor de áudio.
- A captura PTT, os limites de gravação, a liberação de tracks, cancelamento e correlação `inputId`/turno antes de TTS continuam sob o controlador de voz existente.
- Todos os textos novos estão nos 12 catálogos; o destaque de Novidades da versão 2.1.45.3 passa a descrever o ChatGPT normal.

## QA sintética e limites

- Fail-first em `test/jarvis-native-ux.test.ts` e `test/jarvis-conversation.test.ts`: quatro verificações de descoberta e ausência de CLIProxy obrigatório falharam antes do patch.
- Vitest: 10 arquivos/139 testes passaram na rodada com i18n, voz e STT/TTS; após adicionar a negativa de permissão do sistema, `jarvis-conversation` + `jarvis-native-ux` passaram 21/21. Typecheck, build, notices, privacy e `git diff --check` passaram.
- `scripts/verify-jarvis-native-gpt-ui.cjs`: Electron com BrowserWindow offscreen, perfil temporário, API/bridge simuladas e MediaRecorder/getUserMedia/STT/TTS falsos; exercita selecionar conversa normal → abrir Jarvis pelo compositor → ativar/consentir → PTT → `sendInput` nativo → user_message confirmado → resposta de mesmo turno → reprodução TTS. Rejeita a resposta de outro turno e confirma stop do track.
- O script Electron substitui `window.api` por fixture; portanto comprova o renderer Chromium, o contrato de envio e os estados de UI, mas não uma chamada IPC efetiva até o Electron main/preload. A homologação no pacote integrado ainda deve conferir esse boundary, além de conta ChatGPT real, g4f.space real e microfone físico mediante consentimento humano.

## Gate multiprocesso real de IPC (continuação do worker-6)

Novo script: `scripts/verify-jarvis-native-ipc-electron.cjs`. Usa uma única janela Chromium Electron **offscreen**, com `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` e o **preload de produção compilado** (`out/preload/index.js`), sem trocar `window.api` no renderer. O processo main executa o **handler original** `registerJarvisAudioIpc()` compilado isoladamente de `src/main/jarvis-audio.ts`, com `configureJarvisVoiceForTests()` injetando respostas de provedor exclusivamente em memória. `HOME`, diretórios XDG e `app.userData` são descartáveis, removidos no encerramento; `navigator.mediaDevices`, `MediaRecorder` e playback no renderer são falsos e não pedem o microfone físico.

O teste `PASS` observa **1** transcrição que atravessa renderer → preload → `ipcMain.handle('jarvis:audio')` → implementação real STT, **1** entrada `sessions:send` através do preload, **1** fala processada no handler real de TTS streaming e **0** falas da resposta de outro turno. A tentativa primária responde HTTP 503 sintético e a chave de fallback sintética é aceita: há retries nas rotas de transcrição e fala. Outro PTT com **ambas** as credenciais recusadas HTTP 503 faz o STT falhar fechado: o total de mensagens permanece 1. A UI mostra a conversa ChatGPT e o modelo, exige consentimento e deixa o microfone visível; o track fake é encerrado após o PTT.

**Limite exato de confiança:** o `sessions:send` recebe um **handler sintético de main** que devolve um recibo e insere eventos `user_message` (`inputDelivery=offered`/`confirmed`, `inputId` idêntico) e respostas de turnos distintos. Portanto o teste exercita o **canal IPC da ponte e seu preload real**, mas **não** chama o `sendDesktopInput()`/`registerIpc()` completo em `src/main/ipc.ts`, nem um browser bridge real, extensão ChatGPT ou uma sessão autenticada. Tampouco executa o Electron main inteiro de `src/main/index.ts`, o processo de instalação Debian ou a política real de permissão do SO. O fallback validado é **entre as duas credenciais do mesmo provedor de voz**; mudança automática para CLIProxy STT permanece apenas na suíte sintética do renderer. Esses subsistemas ainda precisam de homologação própria antes de declarar fluxo externo de produção integralmente verificado.

Nenhuma alteração de produção, instalação, pacote, perfil real, push ou merge foi feita nesta worktree.
