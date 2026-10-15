import type { QuestionSet } from './types';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** 問題セットJSONを検証し、正規化した値を返す。エラーがあれば日本語メッセージの配列を返す。 */
export function validateSet(input: unknown): { ok: true; set: QuestionSet } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const obj = input as Record<string, unknown>;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['ルートはオブジェクトである必要があります'] };
  }
  if (!isStr(obj.set_id) || !ID_RE.test(obj.set_id)) errors.push('set_id は英数字・_・- の1〜64文字で指定してください');
  if (!isStr(obj.title)) errors.push('title が空です');
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    errors.push('questions は1問以上の配列である必要があります');
    return { ok: false, errors };
  }

  const seenQ = new Set<string>();
  const questions = obj.questions.map((raw, i) => {
    const q = (raw ?? {}) as Record<string, unknown>;
    const at = `questions[${i}]`;
    if (!isStr(q.id) || !ID_RE.test(q.id)) errors.push(`${at}.id が不正です`);
    else if (seenQ.has(q.id)) errors.push(`${at}.id "${q.id}" が重複しています`);
    else seenQ.add(q.id);
    if (!isStr(q.field)) errors.push(`${at}.field が空です`);
    if (!isStr(q.prompt)) errors.push(`${at}.prompt が空です`);
    if (q.explanation !== undefined && typeof q.explanation !== 'string') errors.push(`${at}.explanation は文字列にしてください`);

    const seenO = new Set<string>();
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length < 2) errors.push(`${at}.options は2つ以上必要です`);
    options.forEach((o, j) => {
      const opt = (o ?? {}) as Record<string, unknown>;
      if (!isStr(opt.id) || !ID_RE.test(opt.id)) errors.push(`${at}.options[${j}].id が不正です`);
      else if (seenO.has(opt.id)) errors.push(`${at}.options[${j}].id "${opt.id}" が重複しています`);
      else seenO.add(opt.id);
      if (!isStr(opt.text)) errors.push(`${at}.options[${j}].text が空です`);
    });
    if (!isStr(q.answer) || !seenO.has(q.answer)) errors.push(`${at}.answer が options のIDと一致しません`);

    return {
      id: String(q.id),
      field: String(q.field),
      prompt: String(q.prompt),
      options: options.map((o: any) => ({ id: String(o?.id), text: String(o?.text) })),
      answer: String(q.answer),
      explanation: typeof q.explanation === 'string' ? q.explanation : '',
    };
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, set: { set_id: String(obj.set_id), title: String(obj.title), questions } };
}
