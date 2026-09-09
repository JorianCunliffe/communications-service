// Local-only acceptance fixture. No provider adapters are called.
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import Fastify from 'fastify';
import { createPostgresClient } from '../../database.js';
import v1Routes from '../../v1.js';
export async function createPhase02Database(tenantId, key, options = {}) {
  process.env.API_KEY = key;
  process.env.LEGACY_TENANT_ID = tenantId;
  process.env.PERSISTENCE_PROVIDER = 'none';
  const sql = new PGlite({ extensions: { pg_trgm } });
  if(options.serverRoles)await sql.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await sql.query("select set_config('app.legacy_tenant_id',$1,false)", [tenantId]);
  const root = new URL('../../migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()) {
    await sql.exec((await readFile(new URL(file, root), 'utf8')).replace(/create extension if not exists pgcrypto;/i, '-- built-in gen_random_uuid'));
  }
  const app = Fastify();
  await app.register(v1Routes, { prefix: '/v1', database: createPostgresClient(sql) });
  return { app, sql, close: async () => { await app.close(); await sql.close(); } };
}
