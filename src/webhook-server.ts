/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *   /hooks/{name}          → generic named webhook endpoint
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance.
 */
import http from 'http';

import type { Chat } from 'chat';

import { getDb, hasTable } from './db/connection.js';
import type { GenericHook } from './db/generic-hooks.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';

const DEFAULT_PORT = 3000;

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

const routes = new Map<string, WebhookEntry>();
let server: http.Server | null = null;

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/** Handle POST /hooks/{name} — generic named webhook. */
export async function handleGenericHook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hookName: string,
): Promise<void> {
  const db = getDb();
  if (!hasTable(db, 'generic_hooks')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const hook = db.prepare('SELECT * FROM generic_hooks WHERE name = ?').get(hookName) as GenericHook | undefined;
  if (!hook) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (hook.header_validator) {
    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    if (auth !== `Bearer ${hook.header_validator}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  try {
    const { session } = resolveSession(hook.agent_group_id, hook.mg_id, null, 'shared');
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'webhook',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: rawBody }),
      trigger: 1,
    });

    const freshSession = getSession(session.id);
    if (freshSession) {
      await wakeContainer(freshSession);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log.error('Generic hook enqueue error', { hook: hookName, err });
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string): void {
  routes.set(adapterName, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${adapterName}` });
}

function ensureServer(): void {
  if (server) return;

  const port = parseInt(process.env.WEBHOOK_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // Route: /hooks/{name} — generic webhook
    const hookMatch = url.match(/^\/hooks\/([^/?]+)/);
    if (hookMatch) {
      await handleGenericHook(req, res, hookMatch[1]);
      return;
    }

    // Route: /webhook/{adapterName}
    const match = url.match(/^\/webhook\/([^/?]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const adapterName = match[1];
    const entry = routes.get(adapterName);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Unknown adapter: ${adapterName}`);
      return;
    }

    try {
      const webReq = await toWebRequest(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
      const handler = webhooks[entry.adapterName];
      const webRes = await handler(webReq, {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
      });
      await fromWebResponse(webRes, res);
    } catch (err) {
      log.error('Webhook handler error', { adapter: adapterName, url: req.url, err });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    log.info('Webhook server stopped');
  }
}
