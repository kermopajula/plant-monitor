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

export function createNotifiers(cfg: { ntfyUrl: string; ntfyToken: string; webhookUrl: string }): Notifier[] {
  const list: Notifier[] = [];
  if (cfg.ntfyUrl) list.push(new NtfyNotifier(cfg.ntfyUrl, cfg.ntfyToken));
  if (cfg.webhookUrl) list.push(new WebhookNotifier(cfg.webhookUrl));
  return list;
}
