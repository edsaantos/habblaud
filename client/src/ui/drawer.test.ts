import { describe, expect, it } from 'vitest';
import type { AgentAutonomy, AgentInfo } from '../../../shared/types';
import { autonomyLine } from './drawer';

const agent = (autonomy?: AgentAutonomy) => ({ stats: { contextTokens: 120_000 }, autonomy }) as AgentInfo;

describe('gaveta: linha do modo autônomo', () => {
  it('diz a situação de cada fase, com a nota e os revezamentos da cadeia', () => {
    expect(autonomyLine(agent())).toBe('Desligado.');
    expect(autonomyLine(agent({ phase: 'armed', relays: 0, threshold: 200_000 }))).toMatch(/^Ligado: contexto em .*120.* de .*200.*\.$/);
    expect(autonomyLine(agent({ phase: 'armed', relays: 0, threshold: 200_000, note: 'sem como mandar mensagem' }))).toMatch(/\. sem como mandar mensagem\.$/);
    expect(autonomyLine(agent({ phase: 'paused', relays: 2, threshold: 200_000, note: 'limite de 2 revezamentos seguidos' }))).toBe(
      'Parado: limite de 2 revezamentos seguidos. Desligue e ligue para tentar de novo. Revezamentos desta cadeia: 2.',
    );
    expect(autonomyLine(agent({ phase: 'done', relays: 1, threshold: 200_000 }))).toMatch(/^Passou o trabalho para uma sessão nova\..* Revezamentos desta cadeia: 1\.$/);
  });
});
