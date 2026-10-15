import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { aggregate } from './aggregate';
import { BUILTIN_SETS } from './generated/questions';
import { EVENT_TYPES, type EventType, type QuestionSet, type QuizEvent } from './types';
import { validateSet } from './validate';

type Env = { Bindings: { DB: D1Database; ASSETS: Fetcher } };

const MAX_EVENTS_PER_REQUEST = 500;

// 組み込みセット（questions/*.json）は起動時に検証し、不正なものは除外してログに出す
const builtinSets = new Map<string, QuestionSet>();
for (const raw of BUILTIN_SETS) {
  const r = validateSet(raw);
  if (r.ok) builtinSets.set(r.set.set_id, r.set);
  else console.error('invalid builtin set', (raw as any)?.set_id, r.errors);
}

const app = new Hono<Env>().basePath('/api');

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

const fail = (status: 400 | 404 | 409, message: string): never => {
  throw new HTTPException(status, { message });
};

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return fail(400, 'JSONとして解釈できません');
  }
}

async function loadSet(db: D1Database, setId: string): Promise<QuestionSet | null> {
  const builtin = builtinSets.get(setId);
  if (builtin) return builtin;
  const row = await db.prepare('SELECT data FROM question_sets WHERE set_id = ?').bind(setId).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as QuestionSet) : null;
}

/** 解答中に返す問題（正解・解説を含めない） */
const publicQuestions = (set: QuestionSet) =>
  set.questions.map(({ id, field, prompt, options }) => ({ id, field, prompt, options }));

function parseEvents(raw: unknown, set: QuestionSet): QuizEvent[] {
  if (!Array.isArray(raw)) return fail(400, 'events は配列である必要があります');
  if (raw.length > MAX_EVENTS_PER_REQUEST) fail(400, `events は1回あたり${MAX_EVENTS_PER_REQUEST}件までです`);
  const qids = new Set(set.questions.map((q) => q.id));
  return raw.map((e: any, i) => {
    const ok =
      e &&
      Number.isSafeInteger(e.seq) && e.seq >= 0 &&
      Number.isSafeInteger(e.ts) && e.ts > 0 &&
      EVENT_TYPES.includes(e.type) &&
      (e.type === 'finish' ? true : typeof e.question_id === 'string' && qids.has(e.question_id)) &&
      (e.value == null || (typeof e.value === 'string' && e.value.length <= 64));
    if (!ok) fail(400, `events[${i}] が不正です`);
    return {
      seq: e.seq,
      question_id: e.type === 'finish' ? null : e.question_id,
      type: e.type as EventType,
      value: e.value ?? null,
      ts: e.ts,
    };
  });
}

async function insertEvents(db: D1Database, sessionId: string, events: QuizEvent[]) {
  if (!events.length) return;
  const now = Date.now();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO events (session_id, seq, question_id, type, value, ts, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  await db.batch(events.map((e) => stmt.bind(sessionId, e.seq, e.question_id, e.type, e.value, e.ts, now)));
}

interface SessionRow {
  id: string;
  set_id: string;
  set_title: string;
  set_data: string;
  started_at: number;
  finished_at: number | null;
  total: number;
  correct: number | null;
}

async function getSession(db: D1Database, id: string): Promise<SessionRow> {
  const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<SessionRow>();
  return row ?? fail(404, 'セッションが見つかりません');
}

async function sessionResult(db: D1Database, s: SessionRow) {
  const set = JSON.parse(s.set_data) as QuestionSet;
  const { results } = await db
    .prepare('SELECT * FROM results WHERE session_id = ? ORDER BY position')
    .bind(s.id)
    .all<Record<string, any>>();
  return {
    session: {
      id: s.id,
      set_id: s.set_id,
      set_title: s.set_title,
      started_at: s.started_at,
      finished_at: s.finished_at,
      total: s.total,
      correct: s.correct,
    },
    questions: set.questions,
    results: results.map((r) => ({ ...r, is_correct: !!r.is_correct, path: JSON.parse(r.path) })),
  };
}

// ---------- 問題セット ----------

app.get('/sets', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT set_id, title, data, updated_at FROM question_sets ORDER BY updated_at DESC',
  ).all<{ set_id: string; title: string; data: string; updated_at: number }>();
  return c.json({
    sets: [
      ...[...builtinSets.values()].map((s) => ({
        set_id: s.set_id,
        title: s.title,
        count: s.questions.length,
        source: 'builtin',
      })),
      ...results
        .filter((r) => !builtinSets.has(r.set_id))
        .map((r) => ({
          set_id: r.set_id,
          title: r.title,
          count: (JSON.parse(r.data) as QuestionSet).questions.length,
          source: 'custom',
          updated_at: r.updated_at,
        })),
    ],
  });
});

// 画面からの追加。同じ set_id の追加セットは上書き、組み込みセットとの重複は拒否
app.post('/sets', async (c) => {
  const r = validateSet(await readJson(c));
  if (!r.ok) return c.json({ error: '問題セットの形式が不正です', details: r.errors }, 400);
  if (builtinSets.has(r.set.set_id)) fail(409, `set_id "${r.set.set_id}" は組み込みセットと重複しています`);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO question_sets (set_id, title, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (set_id) DO UPDATE SET title = excluded.title, data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(r.set.set_id, r.set.title, JSON.stringify(r.set), now, now)
    .run();
  return c.json({ set_id: r.set.set_id, title: r.set.title, count: r.set.questions.length }, 201);
});

app.delete('/sets/:id', async (c) => {
  const id = c.req.param('id');
  if (builtinSets.has(id)) fail(409, '組み込みセットは削除できません（questions/ から削除してください）');
  const res = await c.env.DB.prepare('DELETE FROM question_sets WHERE set_id = ?').bind(id).run();
  if (!res.meta.changes) fail(404, '問題セットが見つかりません');
  return c.json({ ok: true });
});

// ---------- セッション ----------

app.post('/sessions', async (c) => {
  const body = await readJson(c);
  const set = typeof body?.set_id === 'string' ? await loadSet(c.env.DB, body.set_id) : null;
  if (!set) return fail(404, '問題セットが見つかりません');
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, set_id, set_title, set_data, started_at, total) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, set.set_id, set.title, JSON.stringify(set), startedAt, set.questions.length)
    .run();
  return c.json(
    { session_id: id, set_id: set.set_id, title: set.title, started_at: startedAt, questions: publicQuestions(set) },
    201,
  );
});

app.get('/sessions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, set_id, set_title, started_at, finished_at, total, correct
     FROM sessions ORDER BY started_at DESC LIMIT 200`,
  ).all();
  return c.json({ sessions: results });
});

app.post('/sessions/:id/events', async (c) => {
  const s = await getSession(c.env.DB, c.req.param('id'));
  if (s.finished_at) fail(409, 'このセッションは終了しています');
  const body = await readJson(c);
  await insertEvents(c.env.DB, s.id, parseEvents(body?.events, JSON.parse(s.set_data)));
  return c.json({ ok: true });
});

app.post('/sessions/:id/finish', async (c) => {
  const db = c.env.DB;
  const s = await getSession(db, c.req.param('id'));
  if (s.finished_at) return c.json(await sessionResult(db, s));

  const set = JSON.parse(s.set_data) as QuestionSet;
  const body = await readJson(c);
  await insertEvents(db, s.id, parseEvents(body?.events ?? [], set));

  const { results: rows } = await db
    .prepare('SELECT seq, question_id, type, value, ts FROM events WHERE session_id = ? ORDER BY seq')
    .bind(s.id)
    .all<QuizEvent>();
  const finishTs = rows.filter((e) => e.type === 'finish').at(-1)?.ts ?? rows.at(-1)?.ts ?? Date.now();
  const results = aggregate(set.questions, rows, finishTs);
  const correct = results.filter((r) => r.is_correct).length;

  const ins = db.prepare(
    `INSERT OR REPLACE INTO results (session_id, question_id, position, field, first_answer, final_answer,
       correct_answer, is_correct, change_count, confidence, dwell_ms, path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch([
    ...results.map((r) =>
      ins.bind(
        s.id, r.question_id, r.position, r.field, r.first_answer, r.final_answer, r.correct_answer,
        r.is_correct ? 1 : 0, r.change_count, r.confidence, r.dwell_ms, JSON.stringify(r.path),
      ),
    ),
    db.prepare('UPDATE sessions SET finished_at = ?, correct = ? WHERE id = ?').bind(Date.now(), correct, s.id),
  ]);
  return c.json(await sessionResult(db, await getSession(db, s.id)));
});

app.get('/sessions/:id', async (c) => {
  const s = await getSession(c.env.DB, c.req.param('id'));
  if (!s.finished_at) fail(409, 'このセッションはまだ終了していません');
  return c.json(await sessionResult(c.env.DB, s));
});

// JSONダウンロード用：集計結果＋生イベント
app.get('/sessions/:id/export', async (c) => {
  const db = c.env.DB;
  const s = await getSession(db, c.req.param('id'));
  const { results: events } = await db
    .prepare('SELECT seq, question_id, type, value, ts, received_at FROM events WHERE session_id = ? ORDER BY seq')
    .bind(s.id)
    .all();
  const data = s.finished_at ? await sessionResult(db, s) : { session: { id: s.id, set_id: s.set_id } };
  c.header('Content-Disposition', `attachment; filename="ap-quiz-${s.set_id}-${s.id.slice(0, 8)}.json"`);
  return c.json({ ...data, events });
});

app.delete('/sessions/:id', async (c) => {
  const db = c.env.DB;
  const s = await getSession(db, c.req.param('id'));
  // 外部キーの CASCADE に依存せず明示的に消す
  await db.batch([
    db.prepare('DELETE FROM events WHERE session_id = ?').bind(s.id),
    db.prepare('DELETE FROM results WHERE session_id = ?').bind(s.id),
    db.prepare('DELETE FROM sessions WHERE id = ?').bind(s.id),
  ]);
  return c.json({ ok: true });
});

// ---------- 統計 ----------

// 分野別の正答率と「迷わず不正解」（自信ありで不正解）の件数
app.get('/stats', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT field,
            COUNT(*)                                                         AS total,
            SUM(is_correct)                                                  AS correct,
            SUM(CASE WHEN confidence = 'sure' AND is_correct = 0 THEN 1 ELSE 0 END) AS confident_wrong,
            SUM(CASE WHEN confidence IN ('unsure', 'guess') THEN 1 ELSE 0 END)      AS hesitant
     FROM results
     GROUP BY field
     ORDER BY CAST(SUM(is_correct) AS REAL) / COUNT(*) ASC, field`,
  ).all();
  return c.json({ fields: results });
});

export default app;
