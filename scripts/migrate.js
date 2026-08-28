import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(root, 'migrations');
const acceptedLegacyChecksums = new Map([
    // The Replit development database applied migration 008 with these two
    // execution-time portability fixes before the checked-in file was corrected.
    ['008_call_outcomes.sql', new Set(['b546ba0d258570fdf5ab3783fe7b6b74fc4408b616406de93d02579d2926623b'])],
]);

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required to apply PostgreSQL migrations.');
    process.exitCode = 1;
} else {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS) || 5000,
    });

    try {
        await client.connect();
        await client.query("select pg_advisory_lock(hashtext('communications-service-migrations'))");
        if (process.env.LEGACY_TENANT_ID) {
            await client.query("select set_config('app.legacy_tenant_id', $1, false)", [process.env.LEGACY_TENANT_ID.trim()]);
        }
        await client.query(`
            create table if not exists public.schema_migrations (
                filename text primary key,
                checksum text not null,
                applied_at timestamptz not null default now()
            )
        `);

        const filenames = (await readdir(migrationsDirectory))
            .filter((filename) => /^\d{3}_.+\.sql$/.test(filename))
            .sort();
        const applied = await client.query('select filename, checksum from public.schema_migrations');
        const checksums = new Map(applied.rows.map((row) => [row.filename, row.checksum]));

        for (const filename of filenames) {
            const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
            const checksum = createHash('sha256').update(sql).digest('hex');
            const previous = checksums.get(filename);
            if (previous) {
                if (previous !== checksum) {
                    const accepted = acceptedLegacyChecksums.get(filename)?.has(previous) === true;
                    if (!accepted) throw new Error(`Applied migration changed: ${filename}`);
                    const reconciled = await client.query(
                        'update public.schema_migrations set checksum=$1 where filename=$2 and checksum=$3',
                        [checksum, filename, previous],
                    );
                    if (reconciled.rowCount !== 1) throw new Error(`Could not reconcile migration checksum: ${filename}`);
                    console.warn(`Reconciled checksum for ${filename}`);
                    continue;
                }
                console.log(`Already applied ${filename}`);
                continue;
            }

            console.log(`Applying ${filename}`);
            await client.query(sql);
            await client.query(
                'insert into public.schema_migrations(filename, checksum) values ($1, $2)',
                [filename, checksum],
            );
        }

        console.log(`Database is current (${filenames.length} migrations).`);
    } catch (error) {
        console.error(`Migration failed: ${error.message}`);
        process.exitCode = 1;
    } finally {
        try {
            await client.query("select pg_advisory_unlock(hashtext('communications-service-migrations'))");
        } catch {
            // The connection may have failed before the lock was acquired.
        }
        await client.end().catch(() => {});
    }
}
