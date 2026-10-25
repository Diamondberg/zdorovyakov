import pg from 'pg';
import { migrate } from '../db/migrate.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:5000, statement_timeout:30000});
try { console.log({applied:await migrate(pool)}); }
catch { console.error('Migration failed; inspect connection and migration ledger. No secrets logged.'); process.exitCode=1; }
finally { await pool.end(); }
