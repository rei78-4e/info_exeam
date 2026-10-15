-- 画面から追加した問題セット（questions/*.json の組み込みセットはここに入らない）
CREATE TABLE IF NOT EXISTS question_sets (
  set_id     TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  data       TEXT NOT NULL,            -- 問題セットJSON全体
  created_at INTEGER NOT NULL,         -- epoch ms
  updated_at INTEGER NOT NULL
);

-- 解答セッション。問題セットはスナップショットを保持し、後でセットが変わっても結果を再現できるようにする
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL,
  set_title   TEXT NOT NULL,
  set_data    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,                 -- NULL = 未完了
  total       INTEGER NOT NULL,
  correct     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at DESC);

-- 生イベントログ。seq はクライアント採番の連番で、再送時の重複を (session_id, seq) で排除する
CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  question_id TEXT,
  type        TEXT NOT NULL CHECK (type IN ('view', 'leave', 'select', 'confidence', 'finish')),
  value       TEXT,                    -- select: 選択肢ID / confidence: sure|unsure|guess
  ts          INTEGER NOT NULL,        -- クライアント時刻 epoch ms
  received_at INTEGER NOT NULL,        -- サーバ受信時刻 epoch ms
  PRIMARY KEY (session_id, seq)
);

-- 問題ごとの集計結果（終了時にイベントから算出）
CREATE TABLE IF NOT EXISTS results (
  session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL,
  position       INTEGER NOT NULL,
  field          TEXT NOT NULL,
  first_answer   TEXT,
  final_answer   TEXT,
  correct_answer TEXT NOT NULL,
  is_correct     INTEGER NOT NULL,     -- 0 / 1
  change_count   INTEGER NOT NULL,
  confidence     TEXT,                 -- sure | unsure | guess
  dwell_ms       INTEGER NOT NULL,
  path           TEXT NOT NULL,        -- JSON: [{"answer":"c","at_ms":12000}, ...]
  PRIMARY KEY (session_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_results_field ON results (field);
