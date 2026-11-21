// Creates / updates the Task360 schema (idempotent).  Usage: DATABASE_URL=... npm run db:migrate
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL (Supabase → Project settings → Database → connection string).'); process.exit(1); }
const file = join(dirname(fileURLToPath(import.meta.url)), '../../db/schema.sql');
const sql = postgres(url, { prepare: false, onnotice: () => {} });
try {
  await sql.unsafe(readFileSync(file, 'utf8'));
  console.log('Schema task360 is up to date.');
} catch (e) {
  console.error('Migration failed:', e.message);
  process.exitCode = 1;
} finally { await sql.end(); }
