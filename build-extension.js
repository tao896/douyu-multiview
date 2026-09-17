import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, 'extension');
const output = path.join(root, 'dist', 'chrome-extension');

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.cp(path.join(root, 'public'), output, { recursive: true });
await fs.cp(source, output, {
  recursive: true,
  filter: (entry) => !entry.endsWith(`${path.sep}icon.svg`),
});
await fs.mkdir(path.join(output, 'vendor'), { recursive: true });
await fs.copyFile(
  path.join(root, 'node_modules', 'mpegts.js', 'dist', 'mpegts.js'),
  path.join(output, 'vendor', 'mpegts.js')
);

const manifest = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
manifest.version = packageJson.version;
await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Chrome extension built at ${output}`);
