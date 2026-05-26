import { describe, it, expect } from 'vitest';
import {
  buildTranscript,
  collapseTurns,
  formatReply,
} from '../src/gemini/responder.js';
import type { MessageRow } from '../src/agentmeet/types.js';

function row(seq: number, sender: string | null, text: string, kind = 'chat'): MessageRow {
  return {
    id: `m_${seq}`,
    seq,
    hash: 'h',
    kind,
    body: { text },
    senderAgentId: sender,
    senderUserId: null,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}

describe('buildTranscript', () => {
  it('routes self messages to assistant and others to user', () => {
    const history = [
      row(1, 'agent_alice', 'hello there'),
      row(2, 'agent_me', 'hi back'),
      row(3, 'agent_alice', '@claude what do you think?'),
    ];
    const turns = buildTranscript({ history, selfAgentId: 'agent_me' });
    expect(turns).toHaveLength(3);
    expect(turns[0]?.role).toBe('user');
    expect(turns[1]?.role).toBe('assistant');
    expect(turns[1]?.content).toBe('hi back');
    expect(turns[2]?.role).toBe('user');
    expect(turns[2]?.content).toContain('@claude what do you think?');
  });

  it('drops non-chat kinds', () => {
    const history = [
      row(1, 'agent_alice', 'first'),
      row(2, 'agent_alice', 'task body', 'task'),
      row(3, 'agent_bob', 'second'),
    ];
    const turns = buildTranscript({ history, selfAgentId: null });
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.content)).not.toContain('task body');
  });

  it('respects windowSize', () => {
    const history = Array.from({ length: 50 }, (_, i) =>
      row(i + 1, 'agent_other', `msg-${i}`),
    );
    const turns = buildTranscript({ history, selfAgentId: null, windowSize: 5 });
    expect(turns).toHaveLength(5);
    expect(turns[0]?.content).toContain('msg-45');
  });

  it('drops malformed bodies', () => {
    const malformed: MessageRow = {
      id: 'm_x',
      seq: 9,
      hash: 'h',
      kind: 'chat',
      body: { not_text: 'oops' },
      senderAgentId: 'agent_alice',
      senderUserId: null,
      createdAt: new Date().toISOString(),
    };
    const turns = buildTranscript({ history: [malformed], selfAgentId: null });
    expect(turns).toHaveLength(0);
  });
});

describe('collapseTurns', () => {
  it('merges consecutive same-role turns', () => {
    const turns = [
      { role: 'user' as const, author: 'a', content: 'one' },
      { role: 'user' as const, author: 'a', content: 'two' },
      { role: 'assistant' as const, author: 'me', content: 'hi' },
    ];
    const out = collapseTurns(turns);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe('one\ntwo');
  });

  it('drops leading assistant turns', () => {
    const turns = [
      { role: 'assistant' as const, author: 'me', content: 'hi' },
      { role: 'user' as const, author: 'a', content: 'hey' },
    ];
    const out = collapseTurns(turns);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });
});

describe('formatReply', () => {
  it('returns trimmed text', () => {
    expect(formatReply({ raw: '  hello  ' })).toBe('hello');
  });

  it('truncates over the cap', () => {
    const raw = 'x'.repeat(5000);
    const out = formatReply({ raw, maxLength: 10 });
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back when empty', () => {
    expect(formatReply({ raw: '   ' })).toBe('(no reply)');
  });
});
