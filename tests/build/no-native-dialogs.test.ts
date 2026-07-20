import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendSourceDir = path.join(rootDir, 'frontend', 'src');

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  }));
  return files.flat();
}

describe('frontend feedback', () => {
  it('does not use blocking browser-native dialogs', async () => {
    const files = await listTypeScriptFiles(frontendSourceDir);
    const violations: string[] = [];
    const nativeDialogCall = /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/g;

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (nativeDialogCall.test(source)) {
        violations.push(path.relative(rootDir, file));
      }
      nativeDialogCall.lastIndex = 0;
    }

    expect(violations).toEqual([]);
  });
});
