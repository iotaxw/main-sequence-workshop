import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(appRoot, 'dist');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const entry of ['index.html', 'styles.css', 'src', 'icons']) {
  fs.cpSync(path.join(appRoot, entry), path.join(output, entry), { recursive: true });
}
console.log(`Built static planner at ${output}`);
