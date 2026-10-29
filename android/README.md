# Chat Marks para Android — fonte de cliente QA

Este projeto Android **não é o app.asar do Electron** nem o APK do TwinDesk. É um cliente WebView opcional que se conecta exclusivamente ao painel móvel existente do Chat Marks, no computador.

## Capacidades reais

- Configuração explícita da origem HTTPS do PC, com bloqueio de HTTP, URL com credenciais ou parâmetros, conteúdo fora da origem e erros TLS.
- Login no painel com código efêmero digitado na própria página; nenhum token é salvo pelo código Java.
- Sessões recentes, estado da Empresa e cartões de aprovação disponíveis pela interface existente. Uma decisão é encaminhada ao Chat Marks para o **cartão exato**, mas não representa autorização comprovada pelo host.
- Sem shell remoto, execução arbitrária, Bluetooth, gravação de áudio, localização, SMS, publicidade, armazenamento offline de mensagens ou permissões adicionais. Notificações push, conteúdo integral das conversas e sessões TwinDesk remotas **não estão implementadas**.

## Build reproduzível

Requer JDK 17, Android SDK Platform 35 e Android Gradle Plugin 8.7.3, com Gradle 8.9 disponível e suas dependências resolvíveis. Não inclua credenciais reais no APK.

```sh
cd android
gradle --no-daemon :app:assembleDebug
```

Artefato previsto **somente após um build bem-sucedido**: `android/app/build/outputs/apk/debug/app-debug.apk`. Para validar: `aapt dump badging`, `apksigner verify --verbose`, `sha256sum`, instalação isolada com `adb install` e teste real de TLS, conexão/revogação e login. O ambiente de desenvolvimento atual não confirmou JDK, Gradle, SDK, Android build-tools ou dispositivo Android; nenhum APK é declarado produzido.

## Conectar ao Chat Marks

Ative explicitamente o painel móvel no PC com `CHAT_MARKS_MOBILE_PANEL=1`, um endereço IP local em `CHAT_MARKS_MOBILE_HOST` e **certificado/chave TLS** correspondentes em `CHAT_MARKS_MOBILE_TLS_CERT` e `CHAT_MARKS_MOBILE_TLS_KEY`. Sem TLS, o Chat Marks recusa ligação pela rede local. Consulte `docs/mobile/PAINEL-MOBILE-TESTE.md`.

O Android exige CA confiável instalada no aparelho e o endereço exato `https://IP-DO-PC:17893/`. Não desabilite validação TLS nem encaminhe a porta ao público. O painel fica desligado por padrão e não expõe as APIs internas do Electron. Desconectar limpa sessão WebView; tokens são rotacionados no computador a cada inicialização do painel.

## Limites de homologação

Compilação e verificação estrutural de APK, instalação e comunicação real com celular são etapas distintas. Sem ferramentas e aparelho testado, não há certificação física. Este cliente não deve ser distribuído como versão estável até revisão de UX, notificações, recuperação de conexão e teste HTTPS em telefone real.
