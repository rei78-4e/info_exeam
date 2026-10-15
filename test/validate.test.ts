import { describe, expect, it } from 'vitest';
import { BUILTIN_SETS } from '../src/generated/questions';
import { validateSet } from '../src/validate';

describe('validateSet', () => {
  it('questions/*.json はすべて妥当', () => {
    expect(BUILTIN_SETS.length).toBeGreaterThan(0);
    for (const s of BUILTIN_SETS) {
      const r = validateSet(s);
      expect(r.ok ? [] : r.errors).toEqual([]);
    }
  });

  it('正解が選択肢にない・IDの重複を検出する', () => {
    const r = validateSet({
      set_id: 'x',
      title: 't',
      questions: [
        { id: 'q1', field: 'f', prompt: 'p', options: [{ id: 'a', text: '1' }, { id: 'a', text: '2' }], answer: 'z' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/重複[\s\S]*answer/);
  });
});
