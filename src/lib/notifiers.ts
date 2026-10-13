// Pluggable notification channels. Add a new one by implementing `Notifier`
// and registering it in `createNotifiers`.

export interface Notification {
  title: string;
  message: string;
  /** "problem" or "resolved"; channels may map it to priority/tags. */
  kind: 'problem' | 'resolved' | 'test';
  url?: string;
}

export interface Notifier {
  readonly name: string;
  /** Digest channels get one aggregated message per day instead of one per alert. */
  readonly digest?: boolean;
  send(n: Notification): Promise<void>;
}

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000), ...init });
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

/** ntfy.sh (or a self-hosted ntfy). `url` is the full topic URL, e.g. https://ntfy.sh/my-plants-abc123 */
export class NtfyNotifier implements Notifier {
  readonly name = 'ntfy';
  constructor(
    private readonly url: string,
    private readonly token = '',
  ) {}

  send(n: Notification) {
    const headers: Record<string, string> = {
      // HTTP headers must be ASCII; ntfy decodes RFC 2047 encoded words.
      Title: `=?UTF-8?B?${Buffer.from(n.title).toString('base64')}?=`,
      Tags: n.kind === 'resolved' ? 'white_check_mark' : n.kind === 'test' ? 'test_tube' : 'potted_plant,warning',
      Priority: n.kind === 'problem' ? '4' : '3',
    };
    if (n.url) headers.Click = n.url;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return post(this.url, { headers, body: n.message });
  }
}

/** Generic JSON webhook, compatible with Slack incoming webhooks (`{"text": ...}`). */
export class WebhookNotifier implements Notifier {
  readonly name = 'webhook';
  constructor(private readonly url: string) {}

  send(n: Notification) {
    const text = `*${n.title}*\n${n.message}${n.url ? `\n${n.url}` : ''}`;
    return post(this.url, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title: n.title, message: n.message, kind: n.kind }),
    });
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Email via Resend (https://resend.com), sent as a daily digest.
 * `from` must use a domain verified in Resend.
 */
export class ResendNotifier implements Notifier {
  readonly name = 'resend';
  readonly digest = true;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly to: string[],
    private readonly baseUrl = 'https://api.resend.com',
  ) {}

  send(n: Notification) {
    const text = `${n.message}${n.url ? `\n\nDashboard: ${n.url}` : ''}`;
    const html =
      `<p>${escapeHtml(n.message).replace(/\n/g, '<br>')}</p>` +
      (n.url ? `<p><a href="${escapeHtml(n.url)}">Open the dashboard</a></p>` : '');
    return post(`${this.baseUrl}/emails`, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: this.to, subject: n.title, text, html }),
    });
  }
}

export interface NotifierConfig {
  ntfyUrl: string;
  ntfyToken: string;
  webhookUrl: string;
  resendApiKey: string;
  resendFrom: string;
  resendTo: string;
}

export function createNotifiers(cfg: NotifierConfig, warn: (msg: string) => void = console.warn): Notifier[] {
  const list: Notifier[] = [];
  if (cfg.ntfyUrl) list.push(new NtfyNotifier(cfg.ntfyUrl, cfg.ntfyToken));
  if (cfg.webhookUrl) list.push(new WebhookNotifier(cfg.webhookUrl));
  if (cfg.resendApiKey) {
    const to = cfg.resendTo
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!cfg.resendFrom || !to.length) warn('RESEND_API_KEY is set but RESEND_FROM or RESEND_TO is missing: email alerts disabled');
    else list.push(new ResendNotifier(cfg.resendApiKey, cfg.resendFrom, to));
  }
  return list;
}
