import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isLoopbackHost, serviceUrlProblem } from '../src/url-safety.js';
import { parseEnv } from '../src/config.js';
import { GeminiResponder } from '../src/gemini/responder.js';

describe('serviceUrlProblem', () => {
  it.each([
    'https://generativelanguage.googleapis.com',
    'https://your-gateway.example.com/v1',
    'https://gateway.example.com:8443/gemini/v1/',
    'https://localhost/v1',
    'http://localhost:8080/v1',
    'http://LOCALHOST:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.0.0.1/v1',
    'http://[::1]:8080/v1',
  ])('accepts %s', (url) => {
    expect(serviceUrlProblem(url)).toBeNull();
  });

  it.each([
    // plain http to anything that is not this machine
    'http://generativelanguage.googleapis.com',
    'http://llm-gw.internal/v1',
    'http://192.168.1.20:8080/v1',
    'http://10.0.0.5/v1',
    'http://0.0.0.0:8080/v1',
    'http://host.docker.internal:8080/v1',
    // hosts that only look like loopback
    'http://localhost.evil.test/v1',
    'http://127.0.0.1.evil.test/v1',
    'http://localhost.:8080/v1',
    'http://127.0.0.2/v1',
    'http://[::ffff:127.0.0.1]/v1',
    // other schemes
    'ftp://example.com/v1',
    'ws://localhost:8080/v1',
    'file:///etc/passwd',
    'javascript:alert(1)',
  ])('rejects %s (not https, not loopback)', (url) => {
    expect(serviceUrlProblem(url)).toMatch(/must use https/);
  });

  it.each([
    'https://user:pass@gateway.example.com/v1',
    'https://user@gateway.example.com/v1',
    'https://:pass@gateway.example.com/v1',
    'http://user:pass@localhost:8080/v1',
    // "localhost" here is a username; the real host is evil.test
    'http://localhost@evil.test/v1',
    'https://generativelanguage.googleapis.com@evil.test/v1',
  ])('rejects embedded credentials in %s', (url) => {
    expect(serviceUrlProblem(url)).toMatch(/must not contain credentials/);
  });

  it.each([
    '',
    'not a url',
    'generativelanguage.googleapis.com/v1',
    '//generativelanguage.googleapis.com/v1',
    'https://',
  ])('rejects %j (not an absolute URL)', (url) => {
    expect(serviceUrlProblem(url)).toMatch(/not a valid absolute URL/);
  });

  it('never repeats the URL (or a secret inside it) in the reason', () => {
    for (const url of [
      'https://user:s3cr3t-value@gateway.example.com/v1',
      'http://gateway.example.com/v1?key=s3cr3t-value',
      's3cr3t-value',
    ]) {
      const problem = serviceUrlProblem(url) ?? '';
      expect(problem.length).toBeGreaterThan(0);
      expect(problem).not.toContain('s3cr3t-value');
      expect(problem).not.toContain('gateway.example.com');
    }
  });
});

describe('isLoopbackHost', () => {
  it('matches exactly localhost, 127.0.0.1 and [::1]', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

// GEMINI_BASE_URL is the kit's own override. The other two are read by the
// @google/genai SDK straight from the environment when the kit passes no base
// URL, so they go through the same check.
const BASE_URL_VARS = ['GEMINI_BASE_URL', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL'] as const;

describe.each(BASE_URL_VARS)('%s validation at startup', (name) => {
  const base = { GEMINI_API_KEY: 'test-key', AGENTMEET_BEARER_TOKEN: 'test-token' };

  it('is optional: unset or blank means the default Gemini endpoint', () => {
    expect(parseEnv(base)[name]).toBe('');
    expect(parseEnv({ ...base, [name]: '' })[name]).toBe('');
  });

  it.each([
    'https://your-gateway.example.com/v1',
    'http://localhost:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
  ])('accepts %s', (url) => {
    expect(parseEnv({ ...base, [name]: url })[name]).toBe(url);
  });

  it.each([
    ['http://llm-gw.internal/v1', 'must use https://'],
    ['http://192.168.1.20:8080/v1', 'must use https://'],
    ['http://localhost@evil.test/v1', 'must not contain credentials'],
    ['https://user:pass@gateway.example.com/v1', 'must not contain credentials'],
    ['gateway.example.com/v1', 'is not a valid absolute URL'],
  ])(`refuses to start with ${name}=%s`, (url, message) => {
    expect(() => parseEnv({ ...base, [name]: url })).toThrow(`${name} ${message}`);
  });

  it('does not put the rejected URL into the error', () => {
    let message = '';
    try {
      parseEnv({ ...base, [name]: 'https://user:s3cr3t-value@gateway.example.com/v1' });
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(`${name} must not contain credentials`);
    expect(message).not.toContain('s3cr3t-value');
  });
});

describe('GeminiResponder base URL', () => {
  // fetch is stubbed: no request leaves the process.
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.GEMINI_BASE_URL;
  let requested: string[] = [];

  beforeEach(() => {
    requested = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({
          candidates: [
            { index: 0, content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.GEMINI_BASE_URL;
    else process.env.GEMINI_BASE_URL = originalEnv;
  });

  const turns = [{ role: 'user' as const, author: 'a', content: 'a: hi' }];

  it('sends requests to the base URL it was given', async () => {
    const responder = new GeminiResponder({
      apiKey: 'test-key',
      model: 'test-model',
      persona: 'p',
      baseUrl: 'http://127.0.0.1:9',
    });
    await responder.respond(turns);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.startsWith('http://127.0.0.1:9/')).toBe(true);
  });

  it('does not read GEMINI_BASE_URL from the environment behind the validated config', async () => {
    process.env.GEMINI_BASE_URL = 'http://unvalidated.invalid';
    const responder = new GeminiResponder({ apiKey: 'test-key', model: 'test-model', persona: 'p' });
    await responder.respond(turns);
    expect(requested).toHaveLength(1);
    expect(requested[0]).not.toContain('unvalidated.invalid');
  });
});
