/**
 * Checks for URLs that receive a secret (an API key in a header) and the room
 * transcript. Such a URL must be https, with one exception: plain http to this
 * machine, which is how local model servers (Ollama and similar) are reached.
 */

// Hostnames as the WHATWG URL parser reports them (IPv6 keeps its brackets).
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Returns null when `raw` is safe to send credentials to, otherwise a short
 * reason. The reason never repeats the URL, which may itself contain a secret.
 */
export function serviceUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a valid absolute URL';
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return 'must not contain credentials (user:password@host)';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return 'must use https:// (plain http:// is accepted only for localhost, 127.0.0.1 or [::1])';
}
