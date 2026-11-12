// 生成 Chrome 扩展：public/ 共享前端 + extension/ 扩展专用文件（同名覆盖）+ mpegts.js。
// 默认直接输出到仓库根目录的 chrome-extension/，该目录完全由本脚本生成，不要手工修改。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT = path.join(root, 'chrome-extension');

export async function buildExtension({ output = DEFAULT_OUTPUT } = {}) {
  const target = path.resolve(output);
  // 输出目录会被整个清空，防止误传仓库根目录或源码目录。
  const protectedDirs = [root, path.join(root, 'public'), path.join(root, 'extension')];
  if (protectedDirs.includes(target)) throw new Error(`拒绝输出到 ${target}`);

  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  await fs.cp(path.join(root, 'public'), target, { recursive: true });
  await fs.cp(path.join(root, 'extension'), target, {
    recursive: true,
    filter: (entry) => !entry.endsWith(`${path.sep}icon.svg`),
  });
  await fs.mkdir(path.join(target, 'vendor'), { recursive: true });
  await fs.copyFile(
    path.join(root, 'node_modules', 'mpegts.js', 'dist', 'mpegts.js'),
    path.join(target, 'vendor', 'mpegts.js')
  );

  const manifestPath = path.join(target, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  manifest.version = packageJson.version;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return target;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  // 可选参数：node build-extension.js <输出目录>
  const output = await buildExtension({ output: process.argv[2] || DEFAULT_OUTPUT });
  console.log(`Chrome extension built at ${output}`);
}
