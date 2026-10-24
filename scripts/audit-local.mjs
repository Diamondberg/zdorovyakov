import { execFileSync } from 'node:child_process';
import { platform, release, arch } from 'node:os';

// Read-only, no credentials, environment dump, network or project mutations.
console.log(JSON.stringify({ os: platform(), release: release(), arch: arch(), node: process.version }));
for (const command of ['git', 'docker', 'psql', 'nginx', 'caddy', 'ssh']) {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      stdio: 'pipe', timeout: 5000,
    });
    console.log(`${command}: available in PATH`);
  } catch {
    console.log(`${command}: not found in PATH (does not prove absent on host)`);
  }
}
