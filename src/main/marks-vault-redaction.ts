/**
 * Main-process redaction registry. It is never exposed to the renderer or exported.
 * The vault hydrates it from authenticated ciphertext at startup and after every edit.
 * No logger or recorder reads the vault: those sinks must stay synchronous and must
 * not initiate a keyring prompt in the middle of a tool result.
 */
const secretNames = new Map<string, string>();

export function replaceVaultRedactionEntries(entries: ReadonlyArray<{ name: string; value: string }>): void {
  secretNames.clear();
  for (const entry of entries) if (entry.value) secretNames.set(entry.name, entry.value);
}

export function redactVaultText(text: string): string {
  if (!secretNames.size || !text) return text;
  const ordered = [...secretNames.entries()].sort((a, b) => b[1].length - a[1].length);
  let result = text;
  for (const [name, value] of ordered) {
    if (value && result.includes(value)) result = result.split(value).join(`[secret:${name}]`);
  }
  return result;
}

/** Redact arbitrary model-facing JSON/text objects, not media/binary payloads. */
export function redactVaultValues<T>(value: T): T {
  if (secretNames.size === 0) return value;
  if (typeof value === 'string') return redactVaultText(value) as T;
  if (Array.isArray(value)) {
    const items = value.map(redactVaultValues);
    return (items.some((item, index) => item !== value[index]) ? items : value) as T;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    const items = entries.map(([key, item]) => [key, redactVaultValues(item)] as const);
    return (items.some(([, item], index) => item !== entries[index]![1]) ? Object.fromEntries(items) : value) as T;
  }
  return value;
}
