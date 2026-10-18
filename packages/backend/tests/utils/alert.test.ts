// sendAlert: log line, optional webhook (4 formats), optional Resend email.
// fetch is replaced at the global seam: no network. Failures must be swallowed.

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { RESEND_URL, sendAlert, webhookRequest } from '../../src/utils/alert.js';
import { alertEmailFrom, alertEmailTo, alertWebhookFormat } from '../../src/utils/config.js';

const ENV_KEYS = [
  'ALERT_WEBHOOK_URL',
  'ALERT_WEBHOOK_FORMAT',
  'RESEND_API_KEY',
  'ALERT_EMAIL_FROM',
  'ALERT_EMAIL_TO',
] as const;

const ALERT = { title: 'OrbitWatch: test alert', body: 'All 5 attempts failed. Last error: HTTP 500.' };
const SECRET_URL = 'https://hooks.example.test/secret-path-123';
const SECRET_KEY = 're_secret_key_456';

interface Call {
  url: string;
  init: RequestInit;
}

describe('sendAlert', () => {
  let saved: Record<string, string | undefined>;
  let calls: Call[];
  let logs: string[];
  let fetchImpl: (url: string, init: RequestInit) => Promise<Response>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    calls = [];
    logs = [];
    fetchImpl = async () => new Response('ok', { status: 200 });
    mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return fetchImpl(String(url), init);
    });
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    mock.method(console, 'log', capture);
    mock.method(console, 'warn', capture);
    mock.method(console, 'error', capture);
  });

  afterEach(() => {
    mock.restoreAll();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('always logs at ERROR with the ALERT prefix, and with nothing configured makes no request', async () => {
    await sendAlert(ALERT);
    assert.equal(calls.length, 0);
    const line = logs.find((l) => l.includes('ALERT'));
    assert.ok(line, 'an ALERT line');
    assert.ok(line.includes('ERROR'));
    assert.ok(line.includes('ALERT OrbitWatch: test alert'));
    assert.ok(line.includes('All 5 attempts failed'));
  });

  it('webhook, default format json: {title, body}', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    await sendAlert(ALERT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, SECRET_URL);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { title: ALERT.title, body: ALERT.body });
    assert.equal((calls[0].init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.ok(calls[0].init.signal, 'has a timeout signal');
  });

  it('webhook format ntfy: plain-text body and a Title header', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    process.env.ALERT_WEBHOOK_FORMAT = 'ntfy';
    await sendAlert(ALERT);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(calls[0].init.body, ALERT.body);
    assert.equal(headers.Title, ALERT.title);
    assert.match(headers['Content-Type'], /^text\/plain/);
  });

  it('webhook format slack: {text}', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    process.env.ALERT_WEBHOOK_FORMAT = 'slack';
    await sendAlert(ALERT);
    const body = JSON.parse(String(calls[0].init.body)) as { text: string };
    assert.deepEqual(Object.keys(body), ['text']);
    assert.ok(body.text.includes(ALERT.title) && body.text.includes(ALERT.body));
  });

  it('webhook format discord: {content}', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    process.env.ALERT_WEBHOOK_FORMAT = 'DISCORD';
    await sendAlert(ALERT);
    const body = JSON.parse(String(calls[0].init.body)) as { content: string };
    assert.deepEqual(Object.keys(body), ['content']);
    assert.ok(body.content.includes(ALERT.title) && body.content.includes(ALERT.body));
  });

  it('an unknown format falls back to json', () => {
    process.env.ALERT_WEBHOOK_FORMAT = 'carrier-pigeon';
    assert.equal(alertWebhookFormat(), 'json');
    assert.deepEqual(JSON.parse(webhookRequest('json', ALERT).body), { title: ALERT.title, body: ALERT.body });
  });

  it('the ntfy Title header is stripped to plain ASCII', () => {
    const req = webhookRequest('ntfy', { title: 'Satellite — café\nalert', body: 'x' });
    assert.equal(/[^\x20-\x7e]/.test(req.headers.Title), false);
  });

  it('email goes to Resend with a Bearer key, the default sender, and plain text', async () => {
    process.env.RESEND_API_KEY = SECRET_KEY;
    process.env.ALERT_EMAIL_TO = 'me@example.test';
    await sendAlert(ALERT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, RESEND_URL);
    assert.equal(RESEND_URL, 'https://api.resend.com/emails');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET_KEY}`);
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      from: 'OrbitWatch <onboarding@resend.dev>',
      to: ['me@example.test'],
      subject: ALERT.title,
      text: ALERT.body,
    });
  });

  it('email uses ALERT_EMAIL_FROM and splits several recipients', async () => {
    process.env.RESEND_API_KEY = SECRET_KEY;
    process.env.ALERT_EMAIL_TO = ' a@example.test, b@example.test ,';
    process.env.ALERT_EMAIL_FROM = 'Ops <ops@example.test>';
    assert.equal(alertEmailFrom(), 'Ops <ops@example.test>');
    assert.deepEqual(alertEmailTo(), ['a@example.test', 'b@example.test']);
    await sendAlert(ALERT);
    const sent = JSON.parse(String(calls[0].init.body)) as { from: string; to: string[] };
    assert.equal(sent.from, 'Ops <ops@example.test>');
    assert.deepEqual(sent.to, ['a@example.test', 'b@example.test']);
  });

  it('email is sent only when BOTH the key and the recipient are set', async () => {
    process.env.RESEND_API_KEY = SECRET_KEY;
    await sendAlert(ALERT);
    delete process.env.RESEND_API_KEY;
    process.env.ALERT_EMAIL_TO = 'me@example.test';
    await sendAlert(ALERT);
    assert.equal(calls.length, 0);
  });

  it('webhook and email both fire when both are configured', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    process.env.RESEND_API_KEY = SECRET_KEY;
    process.env.ALERT_EMAIL_TO = 'me@example.test';
    await sendAlert(ALERT);
    assert.deepEqual(calls.map((c) => c.url).sort(), [RESEND_URL, SECRET_URL].sort());
  });

  it('a network error is swallowed and logged at WARN without the URL or the key', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    process.env.RESEND_API_KEY = SECRET_KEY;
    process.env.ALERT_EMAIL_TO = 'me@example.test';
    fetchImpl = async (url) => {
      throw new TypeError(`fetch failed for ${url} with key ${SECRET_KEY}`);
    };
    await assert.doesNotReject(sendAlert(ALERT));
    const warns = logs.filter((l) => l.includes('WARN'));
    assert.equal(warns.length, 2);
    const all = logs.join('\n');
    assert.equal(all.includes('secret-path-123'), false);
    assert.equal(all.includes(SECRET_KEY), false);
    assert.equal(all.includes('hooks.example.test'), false);
  });

  it('an HTTP error answer is a WARN with the status only', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    fetchImpl = async () => new Response('nope', { status: 500 });
    await sendAlert(ALERT);
    const warn = logs.find((l) => l.includes('WARN'));
    assert.ok(warn?.includes('HTTP 500'), warn);
    assert.equal(logs.join('\n').includes('secret-path-123'), false);
  });

  it('a timeout is a WARN, not an exception', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    fetchImpl = async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    };
    await assert.doesNotReject(sendAlert(ALERT));
    assert.ok(logs.some((l) => l.includes('WARN') && l.includes('timeout')));
  });

  it('one failing channel does not stop the other', async () => {
    process.env.ALERT_WEBHOOK_URL = SECRET_URL;
    process.env.RESEND_API_KEY = SECRET_KEY;
    process.env.ALERT_EMAIL_TO = 'me@example.test';
    fetchImpl = async (url) => {
      if (url === SECRET_URL) throw new Error('boom');
      return new Response('ok', { status: 200 });
    };
    await sendAlert(ALERT);
    assert.equal(calls.length, 2);
  });
});
