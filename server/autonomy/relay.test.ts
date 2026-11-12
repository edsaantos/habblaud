import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAutonomy, AgentInfo } from '../../shared/types';
import { L, tempDir, writeLines } from '../test/fixtures';
import { extractPrompt, lastAssistantText, Relay, REPLY_TIMEOUT_MS, stillRunning } from './relay';

const PROMPT = 'Objetivo: terminar o módulo X. Feito: A e B. Falta: C. Arquivos: src/x.ts.';

function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId: '/p',
    name: id,
    look: 0,
    role: '',
    sessionId: id,
    account: 'a',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, contextTokens: 200_000 },
    seed: 1,
    ...extra,
  } as AgentInfo;
}

function setup(maxRelays = 3) {
  let clock = 1_000;
  const agents: AgentInfo[] = [agent('m1')];
  const sent: string[] = [];
  const launched: string[] = [];
  const view = new Map<string, AgentAutonomy | undefined>();
  const notices: string[] = [];
  const ctx = { reply: undefined as string | undefined, canSend: true };
  const relay = new Relay({
    agents: () => agents,
    send: (_id, text) => (ctx.canSend ? sent.push(text) > 0 : false),
    lastReply: () => ctx.reply,
    launch: (_a, prompt) => {
      launched.push(prompt);
      return `m${launched.length + 1}`;
    },
    publish: (id, a, n) => {
      view.set(id, a);
      if (n) notices.push(n.text);
    },
    threshold: 150_000,
    maxRelays,
    now: () => clock,
  });
  /** O agente respondeu: o turno acabou depois da mensagem. */
  const answer = (id: string, reply: string) => {
    clock += 5_000;
    ctx.reply = reply;
    agents.find((a) => a.id === id)!.statusSince = clock;
    relay.tick();
  };
  return { relay, agents, sent, launched, view, notices, ctx, answer, advance: (ms: number) => (clock += ms) };
}

describe('modo autônomo', () => {
  it('extrai o prompt da última marcação e ignora resposta sem ela', () => {
    expect(extractPrompt(`ok <continuidade>curto</continuidade> e <continuidade>\n${PROMPT}\n</continuidade>`)).toBe(PROMPT);
    expect(extractPrompt('terminei tudo')).toBeUndefined();
    expect(extractPrompt(undefined)).toBeUndefined();
  });

  it('só liga em agente principal do Claude Code', () => {
    const c = setup();
    c.agents.push(agent('s1', { kind: 'sub', parentId: 'm1' }), agent('cx', { provider: 'codex' }));
    expect(c.relay.set('s1', true)).toBe(false);
    expect(c.relay.set('cx', true)).toBe(false);
    expect(c.relay.set('nada', true)).toBe(false);
    expect(c.relay.set('m1', true)).toBe(true);
    expect(c.view.get('m1')).toMatchObject({ phase: 'armed', relays: 0, threshold: 150_000 });
    c.relay.set('m1', false);
    expect(c.view.get('m1')).toBeUndefined();
  });

  it('abaixo do limite ou esperando você: não pede nada', () => {
    const c = setup();
    c.relay.set('m1', true);
    c.agents[0].stats.contextTokens = 100_000;
    c.relay.tick();
    c.agents[0].stats.contextTokens = 200_000;
    c.agents[0].status = 'waiting';
    c.relay.tick();
    expect(c.sent).toEqual([]);
  });

  it('passou do limite: pede o prompt, espera a resposta com a marcação e abre a sessão nova, que herda o modo', () => {
    const c = setup();
    c.relay.set('m1', true);
    c.relay.tick();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toContain('200 mil tokens');
    expect(c.view.get('m1')!.phase).toBe('asked');
    c.relay.tick();
    expect(c.sent).toHaveLength(1);
    // o turno anterior acabou (a mensagem estava na fila): ainda não é a resposta
    c.answer('m1', 'Pronto, terminei a tarefa.');
    expect(c.launched).toEqual([]);
    c.answer('m1', `Fechei tudo.\n<continuidade>${PROMPT}</continuidade>`);
    expect(c.launched).toHaveLength(1);
    expect(c.launched[0]).toContain(PROMPT);
    expect(c.view.get('m1')).toMatchObject({ phase: 'done' });
    // a sessão nova aparece no escritório já com o modo ligado e um revezamento na conta
    c.agents.push(agent('m2', { stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, contextTokens: 10_000 } }));
    c.relay.tick();
    expect(c.view.get('m2')).toMatchObject({ phase: 'armed', relays: 1 });
    expect(c.sent).toHaveLength(1);
  });

  it('algo rodando em segundo plano: pede para encerrar uma vez; se continuar, para sem abrir a sessão', () => {
    const c = setup();
    c.agents[0].shells = [{ id: 'b1', label: 'npm run dev', startedAt: 0, background: true, kind: 'shell' }];
    c.agents.push(agent('s1', { kind: 'sub', parentId: 'm1', status: 'working', name: 'Beto' }));
    expect(stillRunning(c.agents[0], c.agents)).toEqual(['npm run dev', 'Beto']);
    c.relay.set('m1', true);
    c.relay.tick();
    c.answer('m1', `<continuidade>${PROMPT}</continuidade>`);
    expect(c.launched).toEqual([]);
    expect(c.sent[1]).toContain('npm run dev, Beto');
    expect(c.view.get('m1')!.phase).toBe('cleaning');
    c.answer('m1', 'ok');
    expect(c.view.get('m1')).toMatchObject({ phase: 'paused' });
    expect(c.launched).toEqual([]);
  });

  it('encerrou o que rodava: abre a sessão com o prompt guardado', () => {
    const c = setup();
    c.agents[0].shells = [{ id: 'b1', label: 'npm run dev', startedAt: 0, background: true, kind: 'shell' }];
    c.relay.set('m1', true);
    c.relay.tick();
    c.answer('m1', `<continuidade>${PROMPT}</continuidade>`);
    delete c.agents[0].shells;
    c.answer('m1', 'ok');
    expect(c.launched[0]).toContain(PROMPT);
  });

  it('para no teto de revezamentos, sem resposta em 30 min e quando não dá para mandar mensagem só anota', () => {
    const top = setup(0);
    top.relay.set('m1', true);
    top.relay.tick();
    expect(top.view.get('m1')!.phase).toBe('paused');
    expect(top.sent).toEqual([]);

    const quiet = setup();
    quiet.relay.set('m1', true);
    quiet.relay.tick();
    quiet.advance(REPLY_TIMEOUT_MS + 1);
    quiet.relay.tick();
    expect(quiet.view.get('m1')!.phase).toBe('paused');

    const mute = setup();
    mute.ctx.canSend = false;
    mute.relay.set('m1', true);
    mute.relay.tick();
    expect(mute.view.get('m1')).toMatchObject({ phase: 'armed' });
    expect(mute.view.get('m1')!.note).toBeTruthy();
  });

  it('lê do transcript a última resposta escrita depois da mensagem', () => {
    const tmp = tempDir();
    const path = join(tmp.dir, 's.jsonl');
    writeLines(path, [L.prompt('oi'), L.assistant([L.text('primeira')], { stop: 'end_turn' }), L.assistant([L.tool('t1', 'Read', { file_path: 'a' })]), L.assistant([L.text('última')], { stop: 'end_turn' })]);
    expect(lastAssistantText(path, 0)).toBe('última');
    expect(lastAssistantText(path, Date.now() + 60_000)).toBeUndefined();
    tmp.cleanup();
  });
});
