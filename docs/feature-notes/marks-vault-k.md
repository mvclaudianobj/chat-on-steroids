# Chat Marks Vault — backlog K (candidate for dev homologation)

## Trust boundaries

- `marks-vault.json` is a versioned portable AES-256-GCM envelope (`chat-marks-vault`, version 1). The random 256-bit data key is encrypted separately with a master-password key (`scrypt`, N=32768/r=8/p=1) and stored independently in the existing encrypted OS `secrets.bin` as `marks:vaultKey`. The OS-backed daily path deliberately refuses Electron's insecure Linux fallback; a locked or lost keyring fails closed. A master-password recovery action can restore the OS copy. Admin creation, edits, deletion, reveal, export/import and rotation require a master password; ordinary chat operations do not.
- The encrypted export contains its password-protected recovery wrap; it omits the OS key. A portable import requires an empty Chat Marks vault and the correct master password to avoid overwriting user data.
- Names, an optional exact HTTPS origin and an HTTP header name are metadata *inside ciphertext*. Ordinary `list` reveals names and origins only to the authenticated app window. An administrative reveal puts a value into a password input temporarily and never into application state or chat output.
- The model-facing `vault_use` requires the existing command capability, verified session/conversation identity, a bounded GET/POST path, and a human approval. Approval is once or for the same `(conversationId, secretName)` until this app process exits; it is never persisted. Its destination is the exact administrator-configured HTTPS origin, and redirects are refused. The response contains only the HTTP status and `[secret:name]`, never the secret or remote response body. Errors are generic.
- The main process loads active secret values into a private redaction registry after successful account admission, using the OS-backed decrypt path. Tool/command replies, stored tool histories and application logs replace matching plaintext with `[secret:name]`. If the system key is unavailable, the broker fails closed rather than using the secret. The registry is never sent to a renderer or provider.
- The approval list in General Settings and a floating notification have only names/IDs/operation, no values. The renderer cannot directly request `vault_use` or filesystem access. All administrative IPC methods check the exact trusted main-frame Electron window. Pending and granted approvals are revoked when the owning chat is deleted; a resumed or changed chat must authorize its own use. Session identity and capability are checked again after an approval wait.
- The GPG adapter uses `spawn(gpg)` without shell, never puts passphrases in command arguments or log messages, bounds ciphertext/plaintext/time, and supports decrypted JSON `{entries:[{name,value,origin?,header?}]}` or `{secrets:{name:value}}`. **Compatibility with the actual GPG serialization of work-orchestrator still needs a fixture from that project.** No user's actual GPG secrets were opened or copied during development.

## Integration seams

- Item L can reuse the vault's main-process approval and secret-use policy with `~/.ssh/marks-key-mestra` and MarksCode SSH profiles, but **no SSH identity or profile is read or changed by K**. The master's *password* and the SSH private key are distinct credentials and must never be automatically conflated.
- Item I (Central de Notificações) can subscribe to `vaultApprovals()` or later explicit events to report pending requests; **the item I implementation is not included here**. Secrets never travel through notification payloads.

## Known limitations before broader acceptance

- The first supported chat operation is a fixed-origin authenticated HTTPS GET/POST request, with status-only response. It is intentionally **not** an arbitrary command environment-injection mechanism; SSH and other adapters will require separate narrowly-scoped operations.
- Validate exact work-orchestrator GPG file formats using a synthetic fixture before declaring seamless migration. No real credentials are required for this test.
- This branch is not installed in the current Chat Marks release. Homologate the new settings section and approval banner in dev, then run native Windows/Linux validation before publication.
