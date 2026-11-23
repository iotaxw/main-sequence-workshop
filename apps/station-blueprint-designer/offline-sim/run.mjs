import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(dir, '..');
const args = process.argv.slice(2);
const writeReport = args.includes('--report');
const bpIdx = args.indexOf('--bp');
const customBp = bpIdx >= 0 && args[bpIdx + 1] ? path.resolve(args[bpIdx + 1]) : undefined;

const env = {
  ...process.env,
  ...(writeReport ? { SIM_WRITE_REPORT: '1' } : {}),
  ...(customBp ? { SIM_BP_PATH: customBp } : {}),
};

const res = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'offline-sim/offline-sim.test.ts'],
  { cwd: appRoot, env, stdio: 'inherit', shell: process.platform === 'win32' }
);
process.exit(res.status ?? 1);
