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

Nenhuma alteração de produção, instalação, pacote, perfil real, push ou merge foi feita nesta worktree.
