import { getDb } from './connection.js';

export interface GenericHook {
  name: string;
  agent_group_id: string;
  mg_id: string;
  header_validator: string | null;
  created_at: string;
}

export function getGenericHook(name: string): GenericHook | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM generic_hooks WHERE name = ?').get(name) as GenericHook | undefined) ?? null;
}

export function createGenericHook(hook: Omit<GenericHook, 'created_at'>): GenericHook {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO generic_hooks (name, agent_group_id, mg_id, header_validator, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(hook.name, hook.agent_group_id, hook.mg_id, hook.header_validator ?? null, now);
  return { ...hook, created_at: now };
}

export function deleteGenericHook(name: string): void {
  getDb().prepare('DELETE FROM generic_hooks WHERE name = ?').run(name);
}

export function listGenericHooks(): GenericHook[] {
  return getDb().prepare('SELECT * FROM generic_hooks ORDER BY created_at').all() as GenericHook[];
}
