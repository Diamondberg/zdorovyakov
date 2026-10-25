import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'README.md', 'PROGRESS.md', 'HANDOFF.md', '.env.example', '.gitignore',
  'docs/project/MASTER_SPEC.md', 'docs/project/ARCHITECTURE.md',
  'docs/project/DATABASE.md', 'docs/project/DECISIONS.md',
  'docs/project/PROGRESS.md', 'docs/project/BACKLOG.md',
  'docs/project/ISSUES.md', 'docs/project/CHANGELOG.md',
  'docs/project/HANDOFF.md', 'docs/reports/STAGE_01_REPORT.md',
  'apps/api/README.md', 'apps/admin/README.md', 'apps/storefront/README.md',
  'apps/worker/README.md', 'packages/contracts/README.md',
  'db/migrations/README.md', 'infra/README.md', 'tests/README.md',
];
for (const name of required) {
  assert(existsSync(resolve(root, name)), `Missing ${name}`);
  assert(readFileSync(resolve(root, name), 'utf8').trim().length > 0, `Empty ${name}`);
}
const env = readFileSync(resolve(root, '.env.example'), 'utf8');
for (const key of ['DATABASE_URL', 'SESSION_SECRET', 'EMAIL_CODE_SECRET', 'SMTP_PASSWORD']) {
  assert(env.split(/\r?\n/).includes(`${key}=`), `Example must leave ${key} empty`);
}
assert(env.includes('EMAIL_TRANSPORT=disabled'));
assert(env.includes('PROMOTION_ENABLED=false'));
const ignores = readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/);
for (const item of ['.env', '.env.*', '!.env.example', 'node_modules/', 'backups/']) {
  assert(ignores.includes(item), `Missing ignore ${item}`);
}
console.log(`PASS: ${required.length} required project files; safe configuration defaults and ignore rules.`);
console.log('Scope: scaffold checks only; API/database tests run separately. UI and email are not tested here.');
