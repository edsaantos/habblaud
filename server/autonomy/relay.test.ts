import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAutonomy, AgentInfo } from '../../shared/types';
import { HAS_POSIX_MODES, L, tempDir, writeLines } from '../test/fixtures';
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

function setup(maxRelays = 3, dir?: string) {
  let clock = 1_000;
  const agents: AgentInfo[] = [agent('m1')];
  const sent: string[] = [];
  const launched: string[] = [];
  const view = new Map<string, AgentAutonomy | undefined>();
  const notices: string[] = [];
  const ctx = { reply: undefined as string | undefined, canSend: true, canLaunch: true };
  const relay = new Relay({
    agents: () => agents,
    send: (_id, text) => (ctx.canSend ? sent.push(text) > 0 : false),
    lastReply: () => ctx.reply,
    launch: (_a, prompt) => {
      if (!ctx.canLaunch) throw new Error('sem terminal');
      launched.push(prompt);
      return `m${launched.length + 1}`;
    },
    publish: (id, a, n) => {
      view.set(id, a);
      if (n) notices.push(n.text);
    },
    threshold: 150_000,
    maxRelays,
    dir,
    now: () => clock,
  });
  /** O agente respondeu: o turno acabou depois da mensagem. */
  const answer = (id: string, reply: string) => {
    clock += 5_000;
    ctx.reply = reply;
    agents.find((a) => a.id === id)!.statusSince = clock;
    relay.tick();
  };
  /** O texto entre as marcas que o pedido deu (a marca de cada pedido tem um id aleatório). */
  const mark = (text: string) => {
    const tag = /<(continuidade[\w-]*)>/.exec(sent[0] ?? '')?.[1] ?? 'continuidade';
    return `<${tag}>${text}</${tag}>`;
  };
  return { relay, agents, sent, launched, view, notices, ctx, answer, mark, advance: (ms: number) => (clock += ms) };
}

describe('modo autônomo', () => {
  it('extrai o prompt da última marcação e ignora resposta sem ela', () => {
    expect(extractPrompt(`ok <continuidade>curto</continuidade> e <continuidade>\n${PROMPT}\n</continuidade>`)).toBe(PROMPT);
    // o agente repete a frase do pedido depois do prompt: a marcação curta (" e ") não vale
    expect(extractPrompt(`<continuidade>${PROMPT}</continuidade> Pronto, o prompt está entre <continuidade> e </continuidade>.`)).toBe(PROMPT);
    expect(extractPrompt('terminei tudo')).toBeUndefined();
    expect(extractPrompt(undefined)).toBeUndefined();
  });

  it('marcador imitado: um bloco <continuidade> que o agente já escrevia no turno em curso não vira o prompt', () => {
    const c = setup();
    // pedido urgente, no meio de um turno (contexto 50% acima do limite), de um agente trabalhando no próprio Habblaud
    c.agents[0].status = 'working';
    c.agents[0].stats.contextTokens = 230_000;
    c.relay.set('m1', true);
    c.relay.tick();
    expect(c.sent).toHaveLength(1);
    c.agents[0].status = 'idle';
    c.answer('m1', `Documentei o formato: <continuidade>${'texto de exemplo da documentação, e não o prompt. '.repeat(2)}</continuidade>`);
    expect(c.launched).toEqual([]);
    expect(c.view.get('m1')!.phase).toBe('asked');
    // a resposta ao pedido, com a marca que o pedido deu
    c.answer('m1', c.mark(PROMPT));
    expect(c.launched).toHaveLength(1);
    expect(c.launched[0]).toContain(PROMPT);
    expect(c.launched[0]).not.toContain('texto de exemplo');
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
    c.answer('m1', `Fechei tudo.\n${c.mark(PROMPT)}`);
    expect(c.launched).toHaveLength(1);
    expect(c.launched[0]).toContain(PROMPT);
    expect(c.view.get('m1')).toMatchObject({ phase: 'done' });
    // a sessão nova aparece no escritório já com o modo ligado e um revezamento na conta
    c.agents.push(agent('m2', { stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, contextTokens: 10_000 } }));
    c.relay.tick();
    expect(c.view.get('m2')).toMatchObject({ phase: 'armed', relays: 1, from: 'm1' });
    expect(c.view.get('m1')).toMatchObject({ phase: 'done', next: 'm2' });
    expect(c.sent).toHaveLength(1);
  });

  it('trocar o limite numa sessão que já passou o trabalho ou parou só troca as opções: não rearma nem zera o teto', () => {
    const c = setup(1);
    c.relay.set('m1', true);
    c.relay.tick();
    c.answer('m1', c.mark(PROMPT));
    expect(c.relay.set('m1', true, 299_999, true)).toBe(true);
    expect(c.view.get('m1')).toMatchObject({ phase: 'done', threshold: 299_999, subs: true });
    c.relay.tick();
    c.relay.tick();
    expect([c.sent.length, c.launched.length]).toEqual([1, 1]);
    // a sessão nova chega ao teto e para; mexer nas opções dela não a rearma
    c.agents.push(agent('m2'));
    c.relay.tick();
    expect(c.view.get('m2')).toMatchObject({ phase: 'paused', relays: 1 });
    c.relay.set('m2', true, 500_000);
    c.relay.tick();
    expect(c.view.get('m2')).toMatchObject({ phase: 'paused', relays: 1, threshold: 500_000 });
    expect([c.sent.length, c.launched.length]).toEqual([1, 1]);
    // desligar e ligar é o que rearma
    c.relay.set('m2', false);
    c.relay.set('m2', true, 500_000);
    expect(c.view.get('m2')).toMatchObject({ phase: 'armed', relays: 0 });
  });

  it('agente que sumiu do escritório: depois do prazo o estado some e a etiqueta sai', () => {
    const c = setup();
    c.relay.set('m1', true);
    c.agents[0].status = 'offline';
    c.relay.tick();
    expect(c.view.get('m1')).toBeDefined();
    c.advance(4 * 60_000);
    c.relay.tick();
    expect(c.view.get('m1')).toBeUndefined();
  });

  it('sessão nova que não aparece no escritório: avisa na anterior', () => {
    const c = setup();
    c.relay.set('m1', true);
    c.relay.tick();
    c.answer('m1', c.mark(PROMPT));
    c.advance(4 * 60_000);
    c.relay.tick();
    expect(c.notices.at(-1)).toContain('não apareceu');
    expect(c.view.get('m1')!.next).toBeUndefined();
  });

  it('algo rodando em segundo plano: pede para encerrar uma vez; se continuar, para sem abrir a sessão', () => {
    const c = setup();
    c.agents[0].shells = [{ id: 'b1', label: 'npm run dev', startedAt: 0, background: true, kind: 'shell' }];
    c.agents.push(agent('s1', { kind: 'sub', parentId: 'm1', status: 'working', name: 'Beto' }));
    expect(stillRunning(c.agents[0], c.agents)).toEqual(['npm run dev', 'Beto']);
    c.relay.set('m1', true);
    c.relay.tick();
    c.answer('m1', c.mark(PROMPT));
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
    c.answer('m1', c.mark(PROMPT));
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

  it('ponto seguro: no meio de um turno só pede com o contexto muito acima do limite; o limite pode ser do agente', () => {
    const c = setup();
    c.agents[0].status = 'working';
    c.relay.set('m1', true);
    c.relay.tick();
    expect(c.sent).toEqual([]);
    c.agents[0].stats.contextTokens = 230_000;
    c.relay.tick();
    expect(c.sent).toHaveLength(1);

    const own = setup();
    own.relay.set('m1', true, 300_000);
    own.relay.tick();
    expect(own.sent).toEqual([]);
    expect(own.view.get('m1')!.threshold).toBe(300_000);
    own.relay.set('m1', true, 180_000);
    own.relay.tick();
    expect(own.sent).toHaveLength(1);
  });

  it('vigiando os subagentes: avisa o principal uma vez por subagente acima do limite', () => {
    const c = setup();
    c.agents[0].stats.contextTokens = 10_000;
    c.agents.push(agent('s1', { kind: 'sub', parentId: 'm1', status: 'working', name: 'Beto' }), agent('s2', { kind: 'sub', parentId: 'outro', status: 'working' }));
    c.relay.set('m1', true);
    c.relay.tick();
    expect(c.sent).toEqual([]);
    c.relay.set('m1', true, undefined, true);
    c.relay.tick();
    c.relay.tick();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toContain('Beto');
    expect(c.view.get('m1')).toMatchObject({ phase: 'armed', subs: true });
  });

  it('abertura falhou: guarda o prompt, e "abrir a sessão nova" tenta de novo; o estado sobrevive a um reinício', () => {
    const tmp = tempDir();
    const c = setup(3, tmp.dir);
    c.ctx.canLaunch = false;
    c.relay.set('m1', true);
    c.relay.tick();
    c.answer('m1', c.mark(PROMPT));
    expect(c.view.get('m1')).toMatchObject({ phase: 'paused', retry: true });
    expect(readdirSync(join(tmp.dir, 'prompts'))).toHaveLength(1);
    // gravação por temporário + rename (nada sobra) e só para o dono
    expect(readdirSync(tmp.dir).sort()).toEqual(['prompts', 'state.json']);
    if (HAS_POSIX_MODES) expect(statSync(join(tmp.dir, 'state.json')).mode & 0o777).toBe(0o600);

    // Habblaud reiniciou: o estado volta do disco
    const again = setup(3, tmp.dir);
    again.relay.tick();
    expect(again.view.get('m1')).toMatchObject({ phase: 'paused', retry: true });
    expect(again.relay.retry('m1')).toBe(true);
    expect(again.launched[0]).toContain(PROMPT);
    expect(again.view.get('m1')).toMatchObject({ phase: 'done', next: 'm2' });
    expect(again.relay.retry('m1')).toBe(false);
    tmp.cleanup();
  });

  it('lê do transcript tudo o que o agente escreveu depois da mensagem (o prompt pode vir antes de uma ferramenta)', () => {
    const tmp = tempDir();
    const path = join(tmp.dir, 's.jsonl');
    writeLines(path, [
      L.prompt('oi', { at: 1_000 }),
      L.assistant([L.text('antes da mensagem')], { stop: 'end_turn', at: 2_000 }),
      L.assistant([L.text(`<continuidade>${PROMPT}</continuidade>`)], { at: 4_000 }),
      L.assistant([L.tool('t1', 'Read', { file_path: 'a' })], { at: 5_000 }),
      L.assistant([L.text('Pronto.')], { stop: 'end_turn', at: 6_000 }),
    ]);
    expect(lastAssistantText(path, 3_000)).toBe(`<continuidade>${PROMPT}</continuidade>\nPronto.`);
    expect(extractPrompt(lastAssistantText(path, 3_000))).toBe(PROMPT);
    expect(lastAssistantText(path, 5_500)).toBe('Pronto.');
    expect(lastAssistantText(path, Date.now() + 60_000)).toBeUndefined();
    tmp.cleanup();
  });
});
