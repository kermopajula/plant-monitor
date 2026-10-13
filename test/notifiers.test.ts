import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createNotifiers, ResendNotifier, type NotifierConfig } from '../src/lib/notifiers';

const empty: NotifierConfig = { ntfyUrl: '', ntfyToken: '', webhookUrl: '', resendApiKey: '', resendFrom: '', resendTo: '' };

/** Starts a server that records one request and answers with `status`. */
async function fakeApi(status = 200) {
  const seen: { url?: string; headers?: IncomingHttpHeaders; body?: any } = {};
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      Object.assign(seen, { url: req.url, headers: req.headers, body: JSON.parse(b) });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 200 ? '{"id":"abc"}' : '{"message":"invalid from address"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => server.close() };
}

describe('ResendNotifier', () => {
  it('posts an email to the Resend API', async () => {
    const api = await fakeApi();
    try {
      const n = new ResendNotifier('re_test', 'Plants <plants@example.com>', ['a@example.com', 'b@example.com'], api.url);
      await n.send({ kind: 'problem', title: '🪴 Fern: Too dark', message: 'Too dark: 900 lx <b>\nsecond line', url: 'http://pi:3000' });
      assert.equal(api.seen.url, '/emails');
      assert.equal(api.seen.headers?.authorization, 'Bearer re_test');
      assert.deepEqual(api.seen.body.to, ['a@example.com', 'b@example.com']);
      assert.equal(api.seen.body.from, 'Plants <plants@example.com>');
      assert.equal(api.seen.body.subject, '🪴 Fern: Too dark');
      assert.match(api.seen.body.text, /Dashboard: http:\/\/pi:3000/);
      assert.match(api.seen.body.html, /900 lx &lt;b&gt;<br>second line/);
    } finally {
      api.close();
    }
  });

  it('rejects when Resend returns an error', async () => {
    const api = await fakeApi(422);
    try {
      const n = new ResendNotifier('re_test', 'x@example.com', ['a@example.com'], api.url);
      await assert.rejects(n.send({ kind: 'test', title: 't', message: 'm' }), /422.*invalid from/);
    } finally {
      api.close();
    }
  });
});

describe('createNotifiers', () => {
  it('creates nothing without configuration', () => {
    assert.deepEqual(createNotifiers(empty), []);
  });
  it('adds Resend with comma-separated recipients', () => {
    const list = createNotifiers({ ...empty, resendApiKey: 're_x', resendFrom: 'p@example.com', resendTo: 'a@example.com, b@example.com' });
    assert.deepEqual(list.map((n) => n.name), ['resend']);
  });
  it('skips Resend with a warning when sender or recipients are missing', () => {
    const warnings: string[] = [];
    const list = createNotifiers({ ...empty, resendApiKey: 're_x', resendTo: ' , ' }, (m) => warnings.push(m));
    assert.deepEqual(list, []);
    assert.equal(warnings.length, 1);
  });
  it('combines channels', () => {
    const list = createNotifiers({ ...empty, ntfyUrl: 'https://ntfy.sh/t', webhookUrl: 'https://hooks.example/x', resendApiKey: 're', resendFrom: 'p@e.com', resendTo: 'a@e.com' });
    assert.deepEqual(list.map((n) => n.name), ['ntfy', 'webhook', 'resend']);
  });
});
