# Handoff verificável: Chat Marks WhatsApp ↔ upstream v2.1.46

## Integração identificada — somente leitura

- Checkout responsável: `ecosystem/systems/chat-on-steroids/.tmp/community-2.1.46`, branch `integration/marks-community-2.1.46`, HEAD observado `f39a79a2da1e1b8f3e2c40e24093245f2e11b00e`.
- Havia **24 arquivos com conflitos não resolvidos**, incluindo `src/main/index.ts`, `src/main/config.ts`, preload, 12 locales, testes, changelog e renderer. Esta frente **não modificou** o checkout de integração.
- `f39a79a2` não possui módulos `src/main/whatsapp-duplex.ts`, `src/main/notification-whatsapp-web.ts`, `src/main/whatsapp-resume-on-green.ts` ou `src/main/mobile-panel.ts`. Não considerar WhatsApp operacional integrado.
- A worktree desta frente (`feat/marks-wa-duplex-31`) permanece separada. A candidata `2.1.45.3-36` foi preservada em Downloads; a instalada observada foi `2.1.45.3-34`. Nenhum restart, logout ou acesso a segredos nesta coordenação.

## Sequência funcional a preservar

Base cronológica do WhatsApp: `89dbad14` → `25286b2e` → `08797913` → `f283f1d7` → `c88708dd` → `d7897793` → `73f131d9` → `cdc98e1e` → **`d6136fce`**.

- `c88708dd`: seleção explícita e espelhamento de respostas finalizadas, aprovações de um cartão com `/aprovar 1`/`/negar 1`, referências temporárias; **não** concede autorizações permanentes.
- `d7897793`: múltiplas respostas concluídas entre polls, marcador persistente; revisar corretude de associação `turnId`/finalObservado em históricos reais.
- `73f131d9`: bloqueia retomada antiga da sessão depois de shutdown.
- `d6136fce` (equivalente ao patch isolado `c4b1ec48`): se a primeira reconexão falhar transitoriamente, agenda outra tentativa; testes fail-first incluídos.
- `cdc98e1e` altera número de build para a candidata -36; **não** transportar o buildNumber -36 para uma release upstream sem revisar estratégia de versão.

Preferir portar seletivamente módulos/testes e reconciliar `src/main/index.ts`, notificação/UI, i18n e dependências com a nova upstream. Não aplicar cherry-pick em série no checkout atualmente em conflito nem sobrescrever as modificações de outro prime.

## QA e gates

- A candidata -36, antes do patch de retry adicional, passou 77/77 testes de 7 suítes, typecheck, avisos/licenças, privacidade, build e smoke empacotado. `SHA256: 4c36ba61e332de1db1a1f68a39a6ae40fc35b32032870908d8a89ec33a10cded`.
- Verificar novamente regressões WA, storage, listener, mobile, notificações, 12 locales, aprovações e Electron no resultado combinado. Executar teste de dispositivo real após instalação aprovada.
- O usuário comprovou WA → Chat Marks (`/menu`, `/usar 1`, texto) na -33/-34. **Ainda sem confirmação de Chat Marks → telefone, ack real do destinatário, escopos permanentes do host, painel celular HTTPS e MP3 Jarvis/TTS.**
- `sendMessage` do Baileys pode confirmar aceitação local pelo transporte, não leitura/entrega ao aparelho. O mecanismo de aprovação do host só suporta permitir uma vez/negar; não produzir grants permanentes locais por imitação.

## Coordenação

Foi localizado um prime de integração da v2.1.46 em família de agente estacionada. Tentativas de mensagem direta entre famílias retornaram bloqueio pela camada de segurança; **não há prova de entrega do handoff ao destinatário**. Este arquivo é um artefato versionável na worktree WhatsApp e pode ser encaminhado pelo integrador legitimamente proprietário. A revisão e integração final exigem o owner do checkout de integração.
