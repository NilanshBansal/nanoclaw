import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: '016-generic-hooks',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS generic_hooks (
        name             TEXT PRIMARY KEY,
        agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
        mg_id            TEXT NOT NULL REFERENCES messaging_groups(id),
        header_validator TEXT,
        created_at       TEXT NOT NULL
      );
    `);
  },
};
