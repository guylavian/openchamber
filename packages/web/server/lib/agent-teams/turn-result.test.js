import { describe, expect, it } from 'vitest';

import { readTurnResult } from './turn-result.js';

const answer = (text, extra = {}) => ({ type: 'assistant', content: [{ type: 'text', text }], ...extra });

describe('turn result', () => {
  it('returns the newest answer with text after a successful turn', () => {
    expect(readTurnResult([
      { type: 'idle', outcome: 'succeeded' },
      { type: 'assistant', content: [{ type: 'tool', name: 'bash' }] },
      answer('Final plan'),
      answer('Earlier thought'),
    ])).toEqual({ ok: true, output: 'Final plan' });
  });

  it('reports a model error from the newest answer', () => {
    expect(readTurnResult([
      { type: 'idle', outcome: 'failed' },
      answer('', { error: { type: 'ProviderAuthError', message: 'Invalid API key' } }),
    ])).toEqual({ ok: false, error: 'Invalid API key' });
  });

  it('reports a failed or interrupted turn', () => {
    expect(readTurnResult([{ type: 'idle', outcome: 'failed' }, answer('partial')]).ok).toBe(false);
    expect(readTurnResult([{ type: 'idle', outcome: 'interrupted' }]).error).toMatch(/interrupted/);
  });

  it('treats a turn with no text as done with empty output', () => {
    expect(readTurnResult([{ type: 'idle', outcome: 'succeeded' }])).toEqual({ ok: true, output: '' });
  });
});
