/**
 * Tests for POST /hooks/<name> generic webhook endpoint.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-hooks' };
});

const TEST_DIR = '/tmp/nanoclaw-test-hooks';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { getDb } from './db/connection.js';
import { handleGenericHook } from './webhook-server.js';
import { inboundDbPath, resolveSession } from './session-manager.js';

function now(): string {
  return new Date().toISOString();
}

let testServer: http.Server;
let port: number;

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'webhook',
    platform_id: 'webhook:test',
    name: 'Test Hook MG',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });

  testServer = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const hookMatch = url.match(/^\/hooks\/([^/?]+)/);
    if (hookMatch) {
      await handleGenericHook(req, res, hookMatch[1]);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
  port = (testServer.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => testServer.close(() => resolve()));
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('POST /hooks/<name>', () => {
  it('returns 404 for unknown hook name', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/no-such-hook`, {
      method: 'POST',
      body: 'payload',
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 for missing or wrong bearer token', async () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO generic_hooks (name, agent_group_id, mg_id, header_validator, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('secured-hook', 'ag-1', 'mg-1', 'topsecret', now());

    const missingAuth = await fetch(`http://127.0.0.1:${port}/hooks/secured-hook`, {
      method: 'POST',
      body: 'data',
    });
    expect(missingAuth.status).toBe(401);

    const wrongAuth = await fetch(`http://127.0.0.1:${port}/hooks/secured-hook`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrongtoken' },
      body: 'data',
    });
    expect(wrongAuth.status).toBe(401);
  });

  it('returns 200 and enqueues message when name matches and bearer is correct', async () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO generic_hooks (name, agent_group_id, mg_id, header_validator, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('my-hook', 'ag-1', 'mg-1', 'correcttoken', now());

    const res = await fetch(`http://127.0.0.1:${port}/hooks/my-hook`, {
      method: 'POST',
      headers: { Authorization: 'Bearer correcttoken', 'Content-Type': 'text/plain' },
      body: 'hello from webhook',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });

    // Verify message was written to the session's inbound DB
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const dbPath = inboundDbPath(session.agent_group_id, session.id);
    const inDb = new Database(dbPath);
    const rows = inDb.prepare('SELECT * FROM messages_in WHERE kind = ?').all('webhook') as Array<{
      kind: string;
      content: string;
      trigger: number;
    }>;
    inDb.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('webhook');
    expect(rows[0].trigger).toBe(1);
    const content = JSON.parse(rows[0].content) as { text: string };
    expect(content.text).toBe('hello from webhook');
  });
});
