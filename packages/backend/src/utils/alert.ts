import { logger } from './logger.js';
import {
  alertEmailFrom,
  alertEmailTo,
  alertWebhookFormat,
  alertWebhookUrl,
  resendApiKey,
  type AlertWebhookFormat,
} from './config.js';

// ============================================================
// Alerts
//
// sendAlert() always writes an ERROR log line starting with "ALERT". It can also:
//   - POST to a webhook (ALERT_WEBHOOK_URL, body shape from ALERT_WEBHOOK_FORMAT)
//   - send an email through Resend's HTTP API (RESEND_API_KEY + ALERT_EMAIL_TO)
// Each network call has a 10 s timeout. Every failure is swallowed and logged at
// WARN without the URL or the key (only the kind of failure). sendAlert never
// throws, and callers do not wait for it (fire and forget).
// ============================================================

export interface AlertMessage {
  title: string;
  body: string;
}

/** What the update cycle calls. Tests inject a fake. */
export type AlertSender = (alert: AlertMessage) => void | Promise<void>;

export const ALERT_TIMEOUT_MS = 10_000;
export const RESEND_URL = 'https://api.resend.com/emails';

/** Header values must be plain ASCII on one line. */
function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, ' ').trim();
}

/** The request body (and content type) for each webhook flavour. Pure. */
export function webhookRequest(
  format: AlertWebhookFormat,
  alert: AlertMessage,
): { headers: Record<string, string>; body: string } {
  switch (format) {
    case 'ntfy':
      return {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: headerSafe(alert.title) },
        body: alert.body,
      };
    case 'slack':
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${alert.title}*\n${alert.body}` }),
      };
    case 'discord':
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${alert.title}**\n${alert.body}` }),
      };
    default:
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: alert.title, body: alert.body }),
      };
  }
}

/** Describe a failure without leaking the URL (undici messages can contain it). */
function failureKind(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'network error';
}

async function post(
  what: string,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!res.ok) logger.warn(`Alert ${what} was not delivered (HTTP ${res.status})`);
  } catch (err) {
    logger.warn(`Alert ${what} was not delivered (${failureKind(err)})`);
  }
}

/** Log the alert, then try the optional webhook and email. Never throws. */
export async function sendAlert(alert: AlertMessage): Promise<void> {
  try {
    logger.error(`ALERT ${alert.title}: ${alert.body}`);

    const jobs: Promise<void>[] = [];

    const webhook = alertWebhookUrl();
    if (webhook) {
      const { headers, body } = webhookRequest(alertWebhookFormat(), alert);
      jobs.push(post('webhook', webhook, headers, body));
    }

    const key = resendApiKey();
    const to = alertEmailTo();
    if (key && to.length > 0) {
      jobs.push(
        post(
          'email',
          RESEND_URL,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          JSON.stringify({ from: alertEmailFrom(), to, subject: alert.title, text: alert.body }),
        ),
      );
    }

    await Promise.all(jobs); // post() never rejects
  } catch {
    logger.warn('Alert delivery failed unexpectedly');
  }
}
