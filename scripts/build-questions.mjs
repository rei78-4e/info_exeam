// questions/*.json を読み込み、Worker に同梱する src/generated/questions.ts を生成する。
// 内容の検証は Worker 側の validateSet（src/validate.ts）と `npm test` で行う。
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'questions');
const outDir = join(root, 'src', 'generated');

const sets = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`questions/${f}: JSONとして読めません: ${e.message}`);
    }
  });

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'questions.ts'),
  `// 自動生成ファイル（scripts/build-questions.mjs）。編集しないこと。\n` +
    `export const BUILTIN_SETS: unknown[] = ${JSON.stringify(sets, null, 2)};\n`,
);
console.log(`[build-questions] ${sets.length} set(s) bundled`);
