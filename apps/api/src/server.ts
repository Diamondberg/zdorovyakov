import pg from 'pg';
import { buildApp } from './app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; see .env.example');
const port = Number(process.env.API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API_PORT');
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL, max:10, connectionTimeoutMillis:5000, statement_timeout:10000});
pool.on('error', () => { console.error('Database connection failed'); });
const app = await buildApp(pool,{logger:true});
const shutdown = async () => { await app.close(); await pool.end(); };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try { await app.listen({port,host:process.env.API_HOST ?? '127.0.0.1'}); }
catch { console.error('API startup failed'); await shutdown(); process.exitCode=1; }
