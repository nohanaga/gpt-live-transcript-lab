import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}static/vendor`, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['frontend/grouper-entry.ts'],
  outfile: 'static/vendor/grouper.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  legalComments: 'inline',
  banner: {
    js: '/*! OpenAI TranscriptGrouper · openai-node@5d258e4e82d7655fa82a4688fc04c53359417d27 · Apache-2.0 · see LICENSE.openai-node */',
  },
});
await copyFile(`${root}vendor/openai-node/LICENSE`, `${root}static/vendor/LICENSE.openai-node`);
console.log('Built static/vendor/grouper.js from pinned, unmodified official TypeScript sources.');
