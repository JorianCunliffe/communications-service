import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(root, 'migrations');

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
                if (previous !== checksum) throw new Error(`Applied migration changed: ${filename}`);
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
