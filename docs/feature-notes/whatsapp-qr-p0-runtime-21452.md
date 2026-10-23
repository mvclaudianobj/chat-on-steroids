# WhatsApp Web QR: investigação P0 do runtime Linux 2.1.45.2-3

## Evidência da candidata existente

Base desta correção: `1f67bcfe` (Empresa O4 integrada, mantendo QR+SMTP anterior `a33a8b02`). O código QR da O4 não difere do código da candidata QR+SMTP: `git diff a33a8b02..1f67bcfe -- src/main/notification-whatsapp-web.ts src/main/notification-ipc.ts src/renderer/notification-center.ts` retornou **0 linhas**.

O pacote candidato já existente `Chat-Marks-Linux-x64.deb` tem metadados Debian `chat-on-steroids 2.1.45.2-3 amd64`. O `app.asar` lido **diretamente do .deb**, por streaming do tar Debian, tem SHA-256 `5168fbdabdc4111692d5fbc0d7ea2ea92726e5caa749733eaceac515b91b368b`, idêntico ao `app.asar` do `linux-unpacked` dessa candidata. Foram localizados os arquivos de `@whiskeysockets/baileys` (7.0.0-rc14), `ws`, `qrcode` (1.5.4), `whatsapp-rust-bridge` e `pino` no asar.

Através do binário Linux empacotado, o carregamento CJS, importação ESM dinâmica e criação de socket Baileys com transporte fake passaram (nenhum acesso a WhatsApp). Um segundo probe opt-in criou uma autenticação totalmente descartável fora de qualquer perfil existente; **o Baileys do pacote recebeu um evento `qr` por WebSocket**, sem pareamento, envio de mensagem, impressão de QR nem persistência de conta. O probe sanitizado retornou apenas `{state:"qr",qrSeen:true,disconnectStatusCode:null,proxyConfigured:false}` com exit 0. A ausência de proxy foi observada **somente no ambiente efêmero**, não no perfil instalado do CEO.

Também foi testado um IPC Electron verdadeiro, passando por `BrowserWindow` com `sandbox:true`, preload isolado, `marksNotify:request`, serviço compilado real e socket Baileys falso; retornou `data:image/png;base64,...` e uma única conexão fake, sem imprimir o payload do QR. `verify-ui notification-center` valida a interface com dados sintéticos. O `smoke-packaged-runtime` anterior passou com os avisos GLib conhecidos, sem alterar o pacote.

## Bugs comprovados por regressão primeiro vermelha

1. **Retry bloqueado por backoff.** Uma queda pré-QR agendava reconexão; clicar novamente em Conectar mantinha o estado anterior, esperando o temporizador. Agora o retry manual cancela o temporizador, inicia imediatamente e usa uma única operação compartilhada para chamadas concorrentes; o backoff automático é limitado a 30 s.
2. **Leitura concorrente dos arquivos de autenticação.** Um `creds.update` podia estar gravando quando o socket anterior caía. Um retry já executava `useMultiFileAuthState` antes do término da gravação. Teste antes do patch observou duas leituras de autenticação enquanto a primeira gravação estava bloqueada (`expected 1, received 2`). Agora a inicialização aguarda gravações em andamento, com timeout. Os arquivos existentes são preservados.
3. **Polling obsoleto sobrescrevia falhas novas.** Um `wa-status` pendente podia retornar `connected` depois que o usuário tentava novamente e recebia uma falha de armazenamento. O teste inicialmente falhou ao exibir `WhatsApp connected.`; agora cada tentativa usa geração própria, descarta respostas antigas e remove timers quando a tela é reconstruída.

Também foram incluídos timeout de 12 s em operações de armazenamento/autenticação, tratamento seguro de `ws.close` assíncrono, recusa de diretório de sessão por symlink, cancelamento de esperas no encerramento e código técnico fixo de diagnóstico na UI, como `WA-storage_unavailable / storage`. O processo principal envia somente enums de causa/etapa, jamais mensagem de exceção, caminho, QR, token ou identificador da sessão. Somente a ação Desconectar apaga arquivos de autenticação; nenhuma recuperação remove ou renomeia uma sessão real automaticamente.

## Limites e uso de diagnóstico

**Não há prova de que uma dessas três races causou o problema específico do perfil instalado do CEO.** O pacote é capaz de emitir QR em perfil limpo, e isso não valida autenticação existente, keyring do CEO, network policy, proxy ou condição persistente de uma sessão particular. Por instrução de privacidade, nada disso foi inspecionado. A próxima homologação deve conferir apenas o **código e etapa de diagnóstico** apresentados ao clicar em Conectar e, se não houver QR, retornar esses dois identificadores à equipe. Não enviar QR, arquivos de autenticação, logs brutos, tokens ou screenshots com QR válido.

Comandos seguros de teste ficam em `scripts/probe-whatsapp-packaged.cjs` (transporte fake) e `scripts/verify-whatsapp-qr-runtime.cjs` (Electron IPC real com fixture). O probe de contato efêmero `scripts/probe-whatsapp-qr-ephemeral.cjs` exige `MARKS_EPHEMERAL_QR_PROBE=enabled` e um pacote de homologação explícito. Ele não pareia nem envia mensagens; não o executar contra perfis existentes.

Nenhum pacote foi montado, instalado ou publicado por esta frente. A confirmação de que uma conta real conecta depende de scan autorizado pelo CEO em ambiente de homologação.
