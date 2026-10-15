import { describe, expect, it } from 'vitest';
import { aggregate } from '../src/aggregate';
import type { Question, QuizEvent } from '../src/types';

const q = (id: string, answer: string): Question => ({
  id,
  field: 'F',
  prompt: 'p',
  options: ['a', 'b', 'c', 'd'].map((o) => ({ id: o, text: o })),
  answer,
  explanation: '',
});

let seq = 0;
const ev = (type: QuizEvent['type'], question_id: string | null, ts: number, value: string | null = null): QuizEvent => ({
  seq: seq++,
  type,
  question_id,
  value,
  ts,
});

describe('aggregate', () => {
  it('滞在時間の合算・回答推移・変更回数を算出する', () => {
    seq = 0;
    const t = 1_000_000;
    const events = [
      ev('view', 'q1', t),
      ev('select', 'q1', t + 12_000, 'c'),
      ev('confidence', 'q1', t + 14_000, 'sure'),
      ev('leave', 'q1', t + 20_000),
      ev('view', 'q2', t + 20_000),
      ev('select', 'q2', t + 25_000, 'a'),
      ev('select', 'q2', t + 26_000, 'a'), // 同じ選択肢の再クリックは変更扱いしない
      ev('confidence', 'q2', t + 27_000, 'guess'),
      ev('leave', 'q2', t + 30_000),
      ev('view', 'q1', t + 30_000), // 戻って変更
      ev('select', 'q1', t + 40_000, 'a'),
      ev('select', 'q1', t + 58_000, 'b'),
      ev('confidence', 'q1', t + 59_000, 'unsure'),
      ev('finish', null, t + 60_000), // leave なしで終了しても区間を閉じる
    ];
    const [r1, r2] = aggregate([q('q1', 'b'), q('q2', 'c')], events, t + 60_000);

    expect(r1).toMatchObject({
      first_answer: 'c',
      final_answer: 'b',
      is_correct: true,
      change_count: 2,
      confidence: 'unsure',
      dwell_ms: 50_000,
    });
    expect(r1.path).toEqual([
      { answer: 'c', at_ms: 12_000 },
      { answer: 'a', at_ms: 30_000 },
      { answer: 'b', at_ms: 48_000 },
    ]);
    expect(r2).toMatchObject({ first_answer: 'a', final_answer: 'a', is_correct: false, change_count: 0, dwell_ms: 10_000 });
  });

  it('未回答の問題は不正解・回答なしとして扱う', () => {
    seq = 0;
    const [r] = aggregate([q('q1', 'a')], [ev('view', 'q1', 0), ev('leave', 'q1', 5_000)], 5_000);
    expect(r).toMatchObject({ first_answer: null, final_answer: null, is_correct: false, change_count: 0, dwell_ms: 5_000 });
  });

  it('seq順に処理し、存在しない選択肢は無視する', () => {
    seq = 0;
    const a = ev('view', 'q1', 0);
    const b = ev('select', 'q1', 1_000, 'z');
    const c = ev('select', 'q1', 2_000, 'd');
    const [r] = aggregate([q('q1', 'd')], [c, b, a], 3_000);
    expect(r).toMatchObject({ final_answer: 'd', change_count: 0, dwell_ms: 3_000 });
  });
});
