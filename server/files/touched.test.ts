import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, writeLines } from '../test/fixtures';
import { pathTokens, toSystemPath, touchedFiles, touchesOf } from './touched';

const line = (cwd: string, name: string, input: Record<string, unknown>, timestamp = '2026-01-01T00:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', cwd, timestamp, message: { content: [{ type: 'tool_use', id: 't', name, input }] } });

describe('arquivos do agente', () => {
  it('caminhos do Git Bash e do Windows viram caminhos do sistema; tokens ignoram URLs e curingas', () => {
    expect(toSystemPath('/c/Users/x/a.png', true)).toBe('C:\\Users\\x\\a.png');
    expect(toSystemPath('/c/Users/x', false)).toBe('/c/Users/x');
    expect(pathTokens('ffmpeg -i in.mov "C:\\out\\v.mp4" && curl https://x.dev/a.png > /dev/null; ls *.png', true)).toEqual(['in.mov', 'C:\\out\\v.mp4']);
    expect(pathTokens('cat /etc/hosts', false)).toEqual(['/etc/hosts']);
  });

  it('linha sem tool_use ou sem cwd não rende nada', () => {
    expect(touchesOf('{"type":"user"}')).toEqual([]);
    expect(touchesOf(JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }] } }))).toEqual([]);
  });

  it('mídia gravada na sessão e pastas fora do repositório, somando os subagentes', async () => {
    const tmp = tempDir();
    const repo = join(tmp.dir, 'repo');
    const out = join(tmp.dir, 'fora');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'));
    mkdirSync(out);
    writeFileSync(join(repo, 'novo.png'), 'x');
    writeFileSync(join(repo, 'velho.png'), 'x');
    utimesSync(join(repo, 'velho.png'), 1, 1);
    writeFileSync(join(out, 'video.mp4'), 'xx');
    writeFileSync(join(out, 'notas.txt'), 'x');
    const cwd = join(repo, 'src');
    const transcript = join(tmp.dir, 'sess.jsonl');
    writeLines(transcript, [
      line(cwd, 'Bash', { command: `magick ../novo.png && ffmpeg -o "${join(out, 'video.mp4')}" && cat /nao/existe/x.txt` }),
      line(cwd, 'Read', { file_path: join(repo, 'velho.png') }),
      line(cwd, 'Read', { file_path: join(repo, 'README.md') }),
    ]);
    mkdirSync(join(tmp.dir, 'sess', 'subagents'), { recursive: true });
    writeLines(join(tmp.dir, 'sess', 'subagents', 'agent-a1.jsonl'), [line(cwd, 'Write', { file_path: join(out, 'notas.txt'), content: 'C:\\nada\\aqui.png' })]);

    const f = await touchedFiles(transcript, true);
    expect(f.media.map((m) => m.name).sort()).toEqual(['novo.png', 'video.mp4']);
    expect(f.media.find((m) => m.name === 'video.mp4')).toMatchObject({ kind: 'video', size: 2 });
    // subir até a raiz do repositório (.git) não conta como fora; o que não existe no disco some
    expect(f.outside).toEqual([{ path: out, read: false, write: true, command: true, count: 2 }]);
    expect((await touchedFiles(transcript, false)).outside).toEqual([{ path: out, read: false, write: false, command: true, count: 1 }]);
    tmp.cleanup?.();
  });
});
