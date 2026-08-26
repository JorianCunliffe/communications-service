import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function fastifyRoutes(source, prefix = '') {
    const routePattern = /fastify\.(?:get|post|all)\(\s*['"]([^'"]+)['"]/g;
    return [...source.matchAll(routePattern)].map((match) => `${prefix}${match[1]}`);
}

describe('documentation stays aligned with the implemented HTTP surface', () => {
    const readme = read('../Readme.md');
    const reference = read('../docs/API_REFERENCE.md');
    const implementedRoutes = [
        ...fastifyRoutes(read('../index.js')),
        ...fastifyRoutes(read('../v1.js'), '/v1'),
        ...fastifyRoutes(read('../api.js'), '/api'),
    ];

    test('the README links to the checked-in API reference', () => {
        assert.match(readme, /docs\/API_REFERENCE\.md/);
        assert.doesNotMatch(readme, /claude\.ai\/code\/artifact/i);
    });

    test('the API reference names every implemented HTTP route', () => {
        const missing = [...new Set(implementedRoutes)].filter((route) => !reference.includes(route));
        assert.deepEqual(missing, [], `Undocumented routes: ${missing.join(', ')}`);
    });

    test('the README documents the core runtime configuration', () => {
        for (const name of ['API_KEY', 'OPENAI_API_KEY', 'PUBLIC_URL', 'PERSISTENCE_PROVIDER', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
            assert.ok(readme.includes(name), `README is missing ${name}`);
        }
    });

    test('the test console supplies an idempotency key for outbound actions', () => {
        const consolePage = read('../console.html');
        assert.match(consolePage, /['"]Idempotency-Key['"]\s*:/);
        assert.match(consolePage, /crypto\.randomUUID\(\)/);
    });

    test('the production deployment applies migrations before starting the API', () => {
        const packageJson = JSON.parse(read('../package.json'));
        const replit = read('../.replit');
        assert.equal(packageJson.scripts['start:production'], 'node scripts/migrate.js && node index.js');
        assert.match(replit, /run = \["npm", "run", "start:production"\]/);
    });
});
