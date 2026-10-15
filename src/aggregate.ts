import { CONFIDENCES, type Confidence, type Question, type QuestionResult, type QuizEvent } from './types';

interface State {
  dwell: number;
  path: { answer: string; at_ms: number }[];
  last: string | null;
  confidence: Confidence | null;
}

/**
 * イベントログから問題ごとの集計値を算出する。
 * - 滞在時間: view〜(leave | 別問題の view | finish) の区間を問題ごとに合算
 * - 回答の推移: select のうち直前と異なる選択肢だけを記録（同じ選択肢の再クリックは変更扱いしない）
 * - 変更回数: 推移の長さ − 1（a→c→a なら 2）
 */
export function aggregate(questions: Question[], events: QuizEvent[], finishedAt: number): QuestionResult[] {
  const states = new Map<string, State>();
  for (const q of questions) states.set(q.id, { dwell: 0, path: [], last: null, confidence: null });
  const optionIds = new Map(questions.map((q) => [q.id, new Set(q.options.map((o) => o.id))]));

  let open: { q: string; since: number } | null = null;
  const close = (ts: number) => {
    if (!open) return;
    states.get(open.q)!.dwell += Math.max(0, ts - open.since);
    open = null;
  };

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    if (e.type === 'finish') {
      close(e.ts);
      continue;
    }
    const st = e.question_id ? states.get(e.question_id) : undefined;
    if (!st || !e.question_id) continue;

    switch (e.type) {
      case 'view':
        close(e.ts);
        open = { q: e.question_id, since: e.ts };
        break;
      case 'leave':
        if (open?.q === e.question_id) close(e.ts);
        break;
      case 'select': {
        if (!e.value || !optionIds.get(e.question_id)!.has(e.value) || e.value === st.last) break;
        const running = open?.q === e.question_id ? Math.max(0, e.ts - open.since) : 0;
        st.path.push({ answer: e.value, at_ms: st.dwell + running });
        st.last = e.value;
        break;
      }
      case 'confidence':
        if (CONFIDENCES.includes(e.value as Confidence)) st.confidence = e.value as Confidence;
        break;
    }
  }
  close(finishedAt);

  return questions.map((q, i) => {
    const st = states.get(q.id)!;
    return {
      question_id: q.id,
      position: i,
      field: q.field,
      first_answer: st.path[0]?.answer ?? null,
      final_answer: st.last,
      correct_answer: q.answer,
      is_correct: st.last === q.answer,
      change_count: Math.max(0, st.path.length - 1),
      confidence: st.confidence,
      dwell_ms: st.dwell,
      path: st.path,
    };
  });
}
