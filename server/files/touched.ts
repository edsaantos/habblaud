// Arquivos de um agente, lidos sob demanda do transcript dele (e dos subagentes da sessão):
// mídia criada ou alterada durante a sessão e pastas acessadas fora do repositório.
// Só local (GET /api/agents/:id/files, com a trava do terminal); nada daqui vai ao Habblaud World.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { MediaKind, TouchedFiles } from '../../shared/types';
import { listSubagentFiles, sessionDirOf } from '../sources/subagents';

const MEDIA: Record<string, MediaKind> = {};
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']) MEDIA[`.${e}`] = 'image';
for (const e of ['mp4', 'mov', 'webm', 'mkv', 'avi']) MEDIA[`.${e}`] = 'video';
for (const e of ['mp3', 'wav', 'ogg', 'flac', 'm4a']) MEDIA[`.${e}`] = 'audio';
MEDIA['.pdf'] = 'pdf';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DIR_TOOLS = new Set(['Glob', 'Grep', 'LS']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
const MAX_ITEMS = 200;
/** Varredura das pastas citadas em comandos: níveis abaixo da pasta e teto de entradas lidas por consulta. */
const SCAN_DEPTH = 3;
const SCAN_ENTRIES = 5_000;

type Op = 'read' | 'write' | 'command';

/** Um caminho citado numa chamada de ferramenta, já absoluto. */
export interface Touch {
  path: string;
  op: Op;
  /** O caminho já é uma pasta (Glob, Grep, LS). */
  dir: boolean;
  cwd: string;
  /** Veio de texto livre (comando ou parâmetro qualquer): só vale se existir no disco. */
  guess: boolean;
}

/** `/c/Users/x` (Git Bash) e `~/x` viram caminhos do sistema. */
export function toSystemPath(p: string, win = process.platform === 'win32'): string {
  if (/^~[\\/]/.test(p)) return join(homedir(), p.slice(2));
  const drive = win ? /^\/([a-zA-Z])\/(.*)$/.exec(p) : null;
  return drive ? `${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, '\\')}` : p;
}

const isAbs = (p: string, win: boolean): boolean => /^~[\\/]/.test(p) || (win ? /^[a-zA-Z]:[\\/]/.test(p) || /^\/[a-zA-Z]\//.test(p) : p.startsWith('/'));

/** Pedaços de um texto livre que parecem caminhos: absolutos, ou com extensão de mídia. */
export function pathTokens(text: string, win = process.platform === 'win32'): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s"'`|;&<>()=,]+/)) {
    const t = raw.replace(/[.:]+$/, '');
    if (t.length < 3 || t.length > 400 || t.includes('://') || /[*?$%{}]/.test(t)) continue;
    if (isAbs(t, win) || extname(t).toLowerCase() in MEDIA) out.push(t);
  }
  return out;
}

/** Caminhos citados nas chamadas de ferramenta de uma linha do transcript. */
export function touchesOf(line: string, win = process.platform === 'win32'): Touch[] {
  if (!line.includes('"tool_use"')) return [];
  let j: { cwd?: unknown; message?: { content?: unknown } };
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  const cwd = typeof j.cwd === 'string' ? j.cwd : '';
  const content = j.message?.content;
  if (!cwd || !Array.isArray(content)) return [];
  const abs = (p: string) => resolve(cwd, toSystemPath(p, win));
  const out: Touch[] = [];
  for (const b of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (b?.type !== 'tool_use' || !b.input || typeof b.name !== 'string') continue;
    const direct = b.input.file_path ?? b.input.notebook_path ?? b.input.path;
    const shell = SHELL_TOOLS.has(b.name);
    if (typeof direct === 'string' && direct && !shell) {
      out.push({ path: abs(direct), op: WRITE_TOOLS.has(b.name) ? 'write' : 'read', dir: DIR_TOOLS.has(b.name), cwd, guess: false });
    }
    for (const [key, v] of Object.entries(b.input)) {
      if (typeof v !== 'string' || v === direct || v.length > 20_000) continue;
      // fora do shell, só interessa a mídia citada em parâmetros curtos (ex.: `filename` de um print)
      if (!shell && (v.length > 400 || key === 'content' || key === 'old_string' || key === 'new_string')) continue;
      for (const t of pathTokens(v, win)) out.push({ path: abs(t), op: 'command', dir: false, cwd, guess: true });
    }
  }
  return out;
}

const roots = new Map<string, string>();

/** Raiz do repositório de uma pasta: o ancestral mais próximo com `.git`; sem git, a própria pasta. */
export function repoRoot(cwd: string): string {
  let root = roots.get(cwd);
  if (root) return root;
  root = cwd;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  roots.set(cwd, root);
  return root;
}

function outside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel.startsWith('..') || isAbsolute(rel);
}

/** Junta os caminhos: confere no disco o que veio de texto livre e a data da mídia. */
export function summarize(touches: readonly Touch[], sessionStart: number): TouchedFiles {
  const media = new Map<string, TouchedFiles['media'][number]>();
  const dirs = new Map<string, TouchedFiles['outside'][number]>();
  const stats = new Map<string, ReturnType<typeof statSync> | null>();
  const stat = (p: string) => {
    if (!stats.has(p)) {
      try {
        stats.set(p, statSync(p));
      } catch {
        stats.set(p, null);
      }
    }
    return stats.get(p) ?? null;
  };
  // mídia: existe e foi gravada depois do início da sessão (ler uma imagem antiga não conta)
  const addMedia = (path: string) => {
    const kind = MEDIA[extname(path).toLowerCase()];
    const st = kind && !media.has(path) ? stat(path) : null;
    if (kind && st?.isFile() && Number(st.mtimeMs) >= sessionStart) {
      media.set(path, { path, name: basename(path), kind, size: Number(st.size), at: Number(st.mtimeMs), created: Number(st.birthtimeMs) >= sessionStart });
    }
  };
  const scanned = new Set<string>();
  let budget = SCAN_ENTRIES;
  // Pasta citada num comando ou gravada: o programa costuma receber só a pasta de saída, então a mídia nova
  // dentro dela (até SCAN_DEPTH níveis) também conta. A raiz do repositório e o que a contém ficam de fora.
  const scan = (dir: string, depth: number) => {
    if (scanned.has(dir) || budget <= 0) return;
    scanned.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget <= 0) return;
      if (e.isFile()) addMedia(join(dir, e.name));
      else if (e.isDirectory() && depth < SCAN_DEPTH && !e.name.startsWith('.') && e.name !== 'node_modules') scan(join(dir, e.name), depth + 1);
    }
  };
  for (const t of touches) {
    const st = extname(t.path).toLowerCase() in MEDIA || t.guess || t.dir ? stat(t.path) : null;
    addMedia(t.path);
    const broad = [repoRoot(t.cwd), homedir(), tmpdir()].some((p) => !outside(p, t.path)); // contém o repositório, a pasta do usuário ou a temporária
    if (st?.isDirectory() && t.op !== 'read' && !broad) scan(t.path, 0);
    if (t.guess && !st) continue;
    if (!outside(t.path, repoRoot(t.cwd))) continue;
    // o `path` do Grep pode ser um arquivo: aí vale a pasta dele
    const dir = st?.isDirectory() || (t.dir && !st?.isFile()) ? t.path : dirname(t.path);
    if (dirname(dir) === dir) continue; // raiz do disco: não diz nada
    const at = Number(stat(dir)?.mtimeMs) || undefined;
    const d = dirs.get(dir) ?? { path: dir, read: false, write: false, command: false, count: 0, ...(at ? { at } : {}) };
    d[t.op] = true;
    d.count++;
    dirs.set(dir, d);
  }
  return {
    media: [...media.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS),
    outside: [...dirs.values()].sort((a, b) => Number(b.write) - Number(a.write) || b.count - a.count).slice(0, MAX_ITEMS),
  };
}

/**
 * Abre a pasta no gerenciador de arquivos, ou a mídia no programa padrão. Só para caminhos que estão na lista
 * do agente (quem chama confere): abrir um arquivo qualquer seria executar o que o agente escreveu.
 */
export function openInSystem(path: string): void {
  const bin = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  // sem shell; o explorer.exe devolve código 1 mesmo quando abre
  // (sem windowsHide: com ele a janela da pasta abre escondida)
  execFile(bin, [path], () => undefined);
}

/** O caminho é um item da lista (mídia ou pasta de fora)? */
export function listed(files: TouchedFiles, path: string): boolean {
  return files.media.some((m) => m.path === path) || files.outside.some((d) => d.path === path);
}

interface Parsed {
  size: number;
  mtimeMs: number;
  touches: Touch[];
  firstAt?: number;
}

const cache = new Map<string, Parsed>();

async function parseFile(path: string): Promise<Parsed | undefined> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return undefined;
  }
  const hit = cache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  // shortcut: relê o arquivo inteiro quando ele muda; passar a ler só o trecho novo se a gaveta ficar lenta em sessões enormes
  const lines = (await readFile(path, 'utf8')).split('\n');
  const parsed: Parsed = { size: st.size, mtimeMs: st.mtimeMs, touches: [] };
  for (const line of lines) {
    if (parsed.firstAt === undefined) {
      const m = /"timestamp":"([^"]+)"/.exec(line);
      if (m && Date.parse(m[1])) parsed.firstAt = Date.parse(m[1]);
    }
    for (const t of touchesOf(line)) parsed.touches.push(t);
  }
  cache.set(path, parsed);
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return parsed;
}

/** Arquivos de um transcript; com `withSubs`, soma os subagentes da sessão (inclusive os que já saíram). */
export async function touchedFiles(transcriptPath: string, withSubs: boolean): Promise<TouchedFiles> {
  const main = await parseFile(transcriptPath);
  if (!main) return { media: [], outside: [] };
  const touches = [...main.touches];
  if (withSubs && existsSync(sessionDirOf(transcriptPath))) {
    for (const f of listSubagentFiles(sessionDirOf(transcriptPath))) touches.push(...((await parseFile(f.path))?.touches ?? []));
  }
  return summarize(touches, main.firstAt ?? 0);
}
