// scripts/i18n-check.ts: as chaves que o conferidor tira do código.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectKeys } from '../../scripts/i18n-check';
import { tempDir } from './fixtures';

describe('i18n-check', () => {
  it('a chave de uma template string de várias linhas é a mesma com o arquivo em LF ou em CRLF (checkout Windows)', () => {
    const tmp = tempDir();
    try {
      for (const d of ['client/src', 'shared', 'server', 'scripts']) mkdirSync(join(tmp.dir, d), { recursive: true });
      const source = "const a = tr(`Uso: x\n\n  --y  faz z`);\nconst b = tr('uma linha {0}', [1]);\n";
      writeFileSync(join(tmp.dir, 'scripts', 'lf.ts'), source);
      writeFileSync(join(tmp.dir, 'server', 'crlf.ts'), source.replaceAll('\n', '\r\n'));
      const keys = collectKeys(tmp.dir);
      expect([...keys.keys()].sort()).toEqual(['Uso: x\n\n  --y  faz z', 'uma linha {0}']);
      // a linha citada continua certa nos dois arquivos
      expect(keys.get('uma linha {0}')!.map((at) => at.replace(/\\/g, '/')).sort()).toEqual(['scripts/lf.ts:4', 'server/crlf.ts:4']);
    } finally {
      tmp.cleanup();
    }
  });
});
