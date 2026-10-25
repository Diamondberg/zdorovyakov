import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

export async function migrate(pool: Pool, directory = migrationsDir): Promise<string[]> {
  const names = (await readdir(directory)).filter(n => /^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  if (!names.length) throw new Error('No SQL migrations found');
  // One transaction and connection: lock, checksum check, DDL, ledger and commit.
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('zdorovyakov:migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{name: string; checksum: string}>('SELECT name, checksum FROM schema_migrations ORDER BY name');
    for (const row of applied.rows) {
      if (!names.includes(row.name)) throw new Error(`Applied migration missing: ${row.name}`);
    }
    const changes: string[] = [];
    for (const name of names) {
      const sql = await readFile(join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
      const previous = applied.rows.find(row => row.name === name);
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      if (applied.rows.some(row => row.name > name)) throw new Error(`Out of order migration: ${name}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      changes.push(name);
    }
    return changes;
  });
}
