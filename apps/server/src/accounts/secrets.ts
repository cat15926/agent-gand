/** Values are held only in this server's memory, never in public configuration or traces. */
const values = new Set<string>();
export function rememberSecret(value: string | null | undefined): void { if (value && value.length >= 8) values.add(value); }
for (const [name, value] of Object.entries(process.env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) rememberSecret(value);
export function redactSecrets(value: string): string {
  for (const secret of values) value = value.split(secret).join('[redacted]');
  return value.replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(Bearer\s+)[^"'\s,}\]]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|device[_-]?code|user[_-]?code|authorization)["']?\s*[=:]\s*["']?)[^"'\s,}\]]+/gi, '$1[redacted]');
}
export function secretSafeDelta(forward?: (value: string) => void) {
  let pending = '';
  return { push(value: string) {
    pending += value;
    const hold = Math.max(0, ...[...values].map((secret) => secret.length - 1));
    let boundary = Math.max(0, pending.length - hold);
    // Do not split a complete secret at the flushing boundary.
    for (const secret of values) { const index = pending.lastIndexOf(secret, boundary); if (index >= 0 && index < boundary && index + secret.length > boundary) boundary = index; }
    if (boundary) { forward?.(redactSecrets(pending.slice(0, boundary))); pending = pending.slice(boundary); }
  }, finish() { if (pending) forward?.(redactSecrets(pending)); pending = ''; } };
}

/** Streaming snapshots must also hide suffixes that could become a known secret. */
export function redactSnapshot(value: string): string {
  let boundary = value.length;
  for (const secret of values) for (let length = Math.min(secret.length - 1, value.length); length > 0; length--) {
    if (value.endsWith(secret.slice(0, length))) { boundary = Math.min(boundary, value.length - length); break; }
  }
  return redactSecrets(value.slice(0, boundary)) + (boundary < value.length ? '[redacted]' : '');
}
