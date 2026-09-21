import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const files = readdirSync(new URL('../test/', import.meta.url))
    .filter(file => file.endsWith('.test.js') && file !== 'suite.test.js')
    .sort().map(file => `test/${file}`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=spec', ...files], {
    cwd: new URL('../', import.meta.url),
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PERSISTENCE_PROVIDER: 'none', DOTENV_CONFIG_PATH: '/dev/null' },
    stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
