import postgres from 'postgres';
import { env } from './env';

declare global { var __t360sql: ReturnType<typeof postgres> | undefined; }

/* One pooled connection per server instance. `prepare: false` keeps it compatible with
   Supabase's transaction-mode pooler (port 6543). */
export function db() {
  if (!env.databaseUrl) throw new Error('DATABASE_URL is not configured.');
  if (!globalThis.__t360sql) {
    globalThis.__t360sql = postgres(env.databaseUrl, { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} });
  }
  return globalThis.__t360sql;
}
