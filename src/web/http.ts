// Tiny router on top of node:http — enough for a handful of JSON endpoints and static files.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY = 64 * 1024;

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:(\w+)/g, (_, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  /** Returns false if no route matched. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readJson(req);
        const result = await r.handler({ req, res, params, query: url.searchParams, body });
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Requiring a JSON content type means cross-site form posts (CSRF) are rejected:
  // browsers cannot send application/json cross-origin without a CORS preflight.
  // (DELETE/PUT always need a preflight cross-origin, so they may omit the body.)
  const type = req.headers['content-type'] ?? '';
  const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || !!req.headers['transfer-encoding'];
  if (!type.startsWith('application/json')) {
    if (req.method !== 'POST' && !hasBody) return {};
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export async function sendFile(res: ServerResponse, file: string, cacheSeconds = 0): Promise<boolean> {
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': s.size,
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}
