// Modo autônomo: revezamento de sessões para o contexto não crescer sem fim.
// Ligado por agente (principal). Quando o contexto da sessão passa do limite, o Habblaud manda uma mensagem pedindo
// para concluir o que está em andamento, encerrar o que roda em segundo plano e devolver o prompt de continuidade
// entre <continuidade> e </continuidade>; com a resposta em mãos, abre uma sessão nova na mesma pasta (terminal
// interativo) com esse prompt. A sessão antiga fica aberta e parada. Nada aqui encerra processos: quem encerra é o
// próprio agente, e o revezamento só acontece depois de o escritório não ver mais nada dele rodando.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { tr } from '../../shared/i18n';
import type { AgentAutonomy, AgentInfo, NoticeLevel } from '../../shared/types';

/** Sem resposta com o prompt de continuidade nesse tempo: o modo para (não fica pedindo de novo). */
export const REPLY_TIMEOUT_MS = 30 * 60_000;
/** Sessão recém-aberta que ainda não apareceu no escritório: espera esse tempo antes de esquecê-la. */
const MISSING_MS = 3 * 60_000;
/** O prompt vai como argumento do `claude`: fica bem abaixo do limite da linha de comando do Windows. */
export const PROMPT_MAX = 12_000;

const TAG = /<continuidade>([\s\S]*?)<\/continuidade>/g;

/** O prompt de continuidade da resposta do agente (a última marcação vale), ou undefined. */
export function extractPrompt(reply: string | undefined): string | undefined {
  const all = [...(reply ?? '').matchAll(TAG)];
  const text = all.at(-1)?.[1].trim();
  return text && text.length >= 40 ? text.slice(0, PROMPT_MAX) : undefined;
}

const thousands = (n: number) => String(Math.round(n / 1000));

export function handoffText(contextTokens: number): string {
  return tr(
    '[Habblaud · modo autônomo] O contexto desta sessão chegou a {0} mil tokens e cada turno está ficando caro. 1) Conclua ou deixe num ponto seguro o que está em andamento, sem começar tarefas novas. 2) Encerre os subagentes e os processos em segundo plano que você iniciou. 3) Termine a resposta com o prompt de continuidade para uma sessão nova nesta mesma pasta, entre as marcas <continuidade> e </continuidade>: objetivo, o que já foi feito, o que falta, arquivos e comandos importantes e decisões já tomadas, em até 6.000 caracteres. A sessão nova não verá esta conversa.',
    [thousands(contextTokens)],
  );
}

/** O que o escritório ainda vê rodando por conta do agente: shells em segundo plano e subagentes ocupados. */
export function stillRunning(agent: AgentInfo, all: readonly AgentInfo[]): string[] {
  const shells = (agent.shells ?? []).filter((s) => s.background).map((s) => s.label);
  const subs = all.filter((a) => a.parentId === agent.id && (a.status === 'working' || a.status === 'shell' || a.status === 'waiting')).map((a) => a.name);
  return [...shells, ...subs];
}

/** Texto da última resposta do agente escrita depois de `since` (lê só o fim do transcript). */
export function lastAssistantText(path: string, since: number): string | undefined {
  const size = statSync(path).size;
  const len = Math.min(size, 1_000_000);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    try {
      const j = JSON.parse(lines[i]) as { timestamp?: string; message?: { content?: { type?: string; text?: string }[] } };
      if (!(Date.parse(j.timestamp ?? '') > since)) return undefined;
      const text = (j.message?.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
      if (text) return text;
    } catch {
      // linha cortada no começo do trecho lido
    }
  }
  return undefined;
}

export interface RelayDeps {
  agents: () => AgentInfo[];
  /** Manda a mensagem ao agente (POST /api/messages por dentro). False = não deu (sem o plugin, fila cheia...). */
  send: (agentId: string, text: string) => boolean;
  /** Última resposta do agente depois de `since` (lastAssistantText no transcript dele). */
  lastReply: (agentId: string, since: number) => string | undefined;
  /** Abre a sessão nova na pasta do agente e devolve o id dela no escritório. Lança se não conseguir. */
  launch: (agent: AgentInfo, prompt: string) => string;
  /** Publica o estado no agente (Office.setAutonomy), com um aviso opcional. */
  publish: (agentId: string, autonomy: AgentAutonomy | undefined, notice?: { level: NoticeLevel; text: string }) => void;
  /** Limite de contexto, em tokens. */
  threshold: number;
  /** Máximo de revezamentos seguidos de uma cadeia de sessões. */
  maxRelays: number;
  now?: () => number;
}

interface State {
  phase: AgentAutonomy['phase'];
  relays: number;
  /** Quando a última mensagem foi mandada. */
  at: number;
  seenAt: number;
  prompt?: string;
  note?: string;
}

export class Relay {
  private readonly states = new Map<string, State>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: RelayDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 2_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Liga ou desliga o modo num agente principal. False = agente desconhecido ou que não pode (subagente, Codex). */
  set(agentId: string, enabled: boolean): boolean {
    const a = this.deps.agents().find((x) => x.id === agentId);
    if (!a || a.kind !== 'main' || a.provider === 'codex') return false;
    if (enabled) this.states.set(agentId, { phase: 'armed', relays: 0, at: 0, seenAt: this.now() });
    else this.states.delete(agentId);
    this.publish(agentId);
    return true;
  }

  private publish(id: string, notice?: { level: NoticeLevel; text: string }): void {
    const s = this.states.get(id);
    const view: AgentAutonomy | undefined = s && { phase: s.phase, relays: s.relays, threshold: this.deps.threshold, ...(s.note ? { note: s.note } : {}) };
    this.deps.publish(id, view, notice);
  }

  private pause(id: string, s: State, agent: AgentInfo, note: string): void {
    s.phase = 'paused';
    s.note = note;
    this.publish(id, { level: 'warn', text: tr('⏸️ Modo autônomo de {0} parou: {1}', [agent.name, note]) });
  }

  tick(): void {
    const all = this.deps.agents();
    const now = this.now();
    for (const [id, s] of [...this.states]) {
      const a = all.find((x) => x.id === id);
      if (!a || a.status === 'offline') {
        if (now - s.seenAt > MISSING_MS) this.states.delete(id);
        continue;
      }
      s.seenAt = now;
      try {
        if (s.phase === 'armed') this.watch(id, s, a, now);
        else if (s.phase === 'asked' || s.phase === 'cleaning') this.collect(id, s, a, all, now);
      } catch (err) {
        this.pause(id, s, a, err instanceof Error ? err.message : String(err));
      }
      // sessão que acabou de entrar no escritório (ou qualquer mudança): mantém o estado visível nela
      if (this.states.has(id)) this.publish(id);
    }
  }

  private watch(id: string, s: State, a: AgentInfo, now: number): void {
    const context = a.stats.contextTokens ?? 0;
    // esperando você (permissão ou pergunta): a mensagem só atrapalharia
    if (context < this.deps.threshold || a.status === 'waiting') return;
    if (s.relays >= this.deps.maxRelays) return this.pause(id, s, a, tr('limite de {0} revezamentos seguidos', [this.deps.maxRelays]));
    if (!this.deps.send(id, handoffText(context))) {
      s.note = tr('sem como mandar mensagem a esta sessão (plugin habblaud-mensagens)');
      return;
    }
    s.phase = 'asked';
    s.at = now;
    delete s.note;
    this.publish(id, { level: 'info', text: tr('🔁 Modo autônomo: {0} passou de {1} mil tokens de contexto; pedi o prompt de continuidade.', [a.name, thousands(this.deps.threshold)]) });
  }

  private collect(id: string, s: State, a: AgentInfo, all: readonly AgentInfo[], now: number): void {
    if (now - s.at > REPLY_TIMEOUT_MS) return this.pause(id, s, a, tr('o agente não devolveu o prompt de continuidade'));
    // só com o turno encerrado depois da mensagem
    if (a.status !== 'idle' || a.statusSince <= s.at) return;
    // (a mensagem pode ter esperado na fila o turno anterior acabar: resposta sem a marcação = ainda não é a nossa)
    s.prompt ??= extractPrompt(this.deps.lastReply(id, s.at));
    if (!s.prompt) return;
    const running = stillRunning(a, all);
    if (running.length) {
      if (s.phase === 'cleaning') return this.pause(id, s, a, tr('ainda há algo rodando em segundo plano: {0}', [running.join(', ')]));
      if (!this.deps.send(id, tr('[Habblaud · modo autônomo] Antes de eu abrir a sessão nova, encerre o que ainda roda em segundo plano: {0}. Responda só "ok" quando terminar.', [running.join(', ')]))) return;
      s.phase = 'cleaning';
      s.at = now;
      return;
    }
    const relays = s.relays + 1;
    const next = this.deps.launch(a, tr('[Habblaud · modo autônomo] Continuação da sessão anterior desta pasta (revezamento {0}).', [relays]) + '\n\n' + s.prompt);
    s.phase = 'done';
    this.states.set(next, { phase: 'armed', relays, at: 0, seenAt: now });
    this.publish(id, { level: 'success', text: tr('🔁 {0} passou o trabalho para uma sessão nova (revezamento {1} de {2}).', [a.name, relays, this.deps.maxRelays]) });
  }
}
