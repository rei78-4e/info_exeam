// AP診断クイズ フロントエンド（ビルド不要の素のJS）
const CONF = { sure: '自信あり', unsure: '迷った', guess: '勘' };
const ACTIVE_KEY = 'apq.active';
const FLUSH_INTERVAL_MS = 3000;
const MAX_BATCH = 500;

const app = document.getElementById('app');

// ---------- 汎用 ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtDateTime = (ms) => {
  const d = new Date(ms);
  return `${fmtDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const sec = (ms) => Math.round(ms / 1000);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

const store = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
    } catch {
      return null;
    }
  },
  save(v) {
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(v));
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(ACTIVE_KEY);
    } catch {}
  },
};

// ---------- 解答中の状態とイベントログ ----------

/** @type {null | {sessionId:string,setId:string,title:string,startedAt:number,questions:any[],answers:Record<string,string>,conf:Record<string,string>,index:number,seq:number,queue:any[]}} */
let quiz = store.load();
let viewing = null; // 現在「表示中」として view を記録した問題ID（リロードで必ずリセット）
let flushing = false;
let flushTimer = null;

const save = () => quiz && store.save(quiz);

function log(type, questionId, value = null) {
  if (!quiz) return;
  quiz.queue.push({ seq: quiz.seq++, type, question_id: questionId, value, ts: Date.now() });
  save();
  if (!flushTimer) flushTimer = setTimeout(() => flush(), FLUSH_INTERVAL_MS);
}

function startViewing() {
  if (!quiz || viewing) return;
  viewing = quiz.questions[quiz.index].id;
  log('view', viewing);
}

function stopViewing() {
  if (!quiz || !viewing) return;
  log('leave', viewing);
  viewing = null;
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!quiz || flushing || !quiz.queue.length) return;
  flushing = true;
  const q = quiz;
  const batch = q.queue.slice(0, MAX_BATCH);
  try {
    await api(`/sessions/${q.sessionId}/events`, { method: 'POST', body: JSON.stringify({ events: batch }) });
    const maxSeq = batch[batch.length - 1].seq;
    q.queue = q.queue.filter((e) => e.seq > maxSeq);
    if (q === quiz) save();
  } catch (e) {
    console.warn('イベント送信に失敗（後で再送）', e);
  } finally {
    flushing = false;
  }
  if (quiz && quiz.queue.length && !flushTimer) flushTimer = setTimeout(() => flush(), FLUSH_INTERVAL_MS);
}

async function flushAll() {
  while (flushing) await new Promise((r) => setTimeout(r, 50));
  while (quiz && quiz.queue.length) {
    const before = quiz.queue.length;
    await flush();
    if (quiz.queue.length >= before) throw new Error('ログを送信できませんでした。通信状態を確認してください');
  }
}

// ページを閉じる・バックグラウンドに回るときは sendBeacon で送る（重複はサーバ側で seq により無視される）
function beaconFlush() {
  if (!quiz || !quiz.queue.length) return;
  const body = new Blob([JSON.stringify({ events: quiz.queue.slice(0, MAX_BATCH) })], { type: 'application/json' });
  navigator.sendBeacon?.(`/api/sessions/${quiz.sessionId}/events`, body);
}

document.addEventListener('visibilitychange', () => {
  if (route().name !== 'quiz' || !quiz) return;
  if (document.visibilityState === 'hidden') {
    stopViewing();
    beaconFlush();
  } else {
    startViewing();
  }
});
window.addEventListener('pagehide', () => {
  stopViewing();
  beaconFlush();
});

// ---------- ルーティング ----------

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, arg] = h.split('/');
  return { name: name || 'home', arg };
}

let currentRoute = null;
async function render() {
  const r = route();
  if (currentRoute === 'quiz' && r.name !== 'quiz') {
    stopViewing();
    flush();
  }
  currentRoute = r.name;
  window.scrollTo(0, 0);
  try {
    if (r.name === 'quiz') renderQuiz();
    else if (r.name === 'result' && r.arg) await renderResult(r.arg);
    else if (r.name === 'history') await renderHistory();
    else if (r.name === 'sets') await renderSets();
    else await renderHome();
  } catch (e) {
    app.innerHTML = `<div class="card"><p class="ng">${esc(e.message)}</p><a href="#/">ホームへ戻る</a></div>`;
  }
}
window.addEventListener('hashchange', render);

// ---------- ホーム ----------

async function renderHome() {
  document.body.classList.remove('in-quiz');
  const { sets } = await api('/sets');
  const resume = quiz
    ? `<div class="card">
        <div class="row spread">
          <div><strong>解答途中</strong><div class="muted small">${esc(quiz.title)}・${Object.keys(quiz.answers).length}/${quiz.questions.length}問回答済み</div></div>
          <a class="btn primary" href="#/quiz">続きから</a>
        </div>
      </div>`
    : '';
  app.innerHTML = `
    ${resume}
    <h1>問題セット</h1>
    ${sets
      .map(
        (s) => `<div class="card row spread">
          <div><strong>${esc(s.title)}</strong>
            <div class="muted small">${esc(s.set_id)}・${s.count}問・${s.source === 'builtin' ? '組み込み' : '追加'}</div></div>
          <button class="primary" data-start="${esc(s.set_id)}">開始</button>
        </div>`,
      )
      .join('') || '<p class="muted">問題セットがありません。</p>'}
  `;
  app.querySelectorAll('[data-start]').forEach((b) =>
    b.addEventListener('click', () => startQuiz(b.dataset.start, b)),
  );
}

async function startQuiz(setId, btn) {
  if (quiz && !confirm('解答途中のセッションがあります。破棄して新しく始めますか？（途中のログは履歴に「未完了」として残ります）')) return;
  btn.disabled = true;
  try {
    if (quiz) {
      stopViewing();
      await flush().catch(() => {});
    }
    const s = await api('/sessions', { method: 'POST', body: JSON.stringify({ set_id: setId }) });
    quiz = {
      sessionId: s.session_id,
      setId: s.set_id,
      title: s.title,
      startedAt: s.started_at,
      questions: s.questions,
      answers: {},
      conf: {},
      index: 0,
      seq: 0,
      queue: [],
    };
    viewing = null;
    save();
    location.hash = '#/quiz';
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

// ---------- 解答画面 ----------

const isComplete = (q) => !!(quiz.answers[q.id] && quiz.conf[q.id]);

function goTo(i) {
  if (i === quiz.index) return;
  stopViewing();
  quiz.index = i;
  save();
  startViewing();
  drawQuiz();
  window.scrollTo(0, 0);
}

function renderQuiz() {
  if (!quiz) {
    location.hash = '#/';
    return;
  }
  document.body.classList.add('in-quiz');
  if (document.visibilityState === 'visible') startViewing();
  drawQuiz();
}

function drawQuiz() {
  const qs = quiz.questions;
  const q = qs[quiz.index];
  const last = quiz.index === qs.length - 1;
  const remaining = qs.filter((x) => !isComplete(x)).length;
  const canNext = isComplete(q);

  app.innerHTML = `
    <div class="row spread small muted"><span>${esc(quiz.title)}</span><span>${quiz.index + 1} / ${qs.length}</span></div>
    <nav class="palette" aria-label="問題一覧">
      ${qs
        .map((x, i) => {
          const cls = [isComplete(x) ? 'done' : quiz.answers[x.id] || quiz.conf[x.id] ? 'partial' : '', i === quiz.index ? 'current' : '']
            .join(' ')
            .trim();
          return `<button class="${cls}" data-go="${i}" aria-label="問${i + 1}">${i + 1}</button>`;
        })
        .join('')}
    </nav>
    <div class="card">
      <span class="tag">${esc(q.field)}</span>
      <p class="prompt">${esc(q.prompt)}</p>
      <div class="options" role="radiogroup" aria-label="選択肢">
        ${q.options
          .map(
            (o) => `<button class="option" role="radio" aria-checked="${quiz.answers[q.id] === o.id}" data-opt="${esc(o.id)}">
              <span class="key">${esc(o.id)}</span><span>${esc(o.text)}</span></button>`,
          )
          .join('')}
      </div>
      <div class="conf-label">自信度（必須）</div>
      <div class="conf" role="radiogroup" aria-label="自信度">
        ${Object.entries(CONF)
          .map(([k, v]) => `<button role="radio" aria-checked="${quiz.conf[q.id] === k}" data-conf="${k}">${v}</button>`)
          .join('')}
      </div>
    </div>
    <div class="bottombar">
      <div class="hint">${
        !canNext ? '選択肢と自信度を選ぶと次へ進めます' : last && remaining ? `未完了の問題が ${remaining} 問あります` : '&nbsp;'
      }</div>
      <div class="inner">
        <button data-prev ${quiz.index === 0 ? 'disabled' : ''}>← 前へ</button>
        ${
          last
            ? `<button class="primary" data-finish ${remaining ? 'disabled' : ''}>採点する</button>`
            : `<button class="primary" data-next ${canNext ? '' : 'disabled'}>次へ →</button>`
        }
      </div>
    </div>
  `;

  app.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => goTo(Number(b.dataset.go))));
  app.querySelectorAll('[data-opt]').forEach((b) =>
    b.addEventListener('click', () => {
      log('select', q.id, b.dataset.opt);
      quiz.answers[q.id] = b.dataset.opt;
      save();
      drawQuiz();
    }),
  );
  app.querySelectorAll('[data-conf]').forEach((b) =>
    b.addEventListener('click', () => {
      log('confidence', q.id, b.dataset.conf);
      quiz.conf[q.id] = b.dataset.conf;
      save();
      drawQuiz();
    }),
  );
  app.querySelector('[data-prev]')?.addEventListener('click', () => goTo(quiz.index - 1));
  app.querySelector('[data-next]')?.addEventListener('click', () => goTo(quiz.index + 1));
  app.querySelector('[data-finish]')?.addEventListener('click', (ev) => finishQuiz(ev.currentTarget));
}

async function finishQuiz(btn) {
  if (!confirm('採点します。採点後は回答を変更できません。よろしいですか？')) return;
  btn.disabled = true;
  stopViewing();
  log('finish', null);
  try {
    await flushAll();
    const id = quiz.sessionId;
    await api(`/sessions/${id}/finish`, { method: 'POST', body: JSON.stringify({ events: [] }) });
    quiz = null;
    store.clear();
    location.hash = `#/result/${id}`;
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

// ---------- 結果画面 ----------

function buildExportText(d) {
  const s = d.session;
  const cell = (v) => String(v ?? '-').replace(/\|/g, '\\|');
  const lines = [
    `# 解答結果 ${s.set_id} / ${fmtDate(s.started_at)} / 正解 ${s.correct}/${s.total}`,
    '| 問 | 分野 | 最初 | 最終 | 正誤 | 変更回数 | 自信度 | 時間(秒) |',
    '|---|---|---|---|---|---|---|---|',
    ...d.results.map(
      (r) =>
        `| ${cell(r.question_id)} | ${cell(r.field)} | ${cell(r.first_answer)} | ${cell(r.final_answer)} | ${
          r.is_correct ? '○' : '×'
        } | ${r.change_count} | ${CONF[r.confidence] ?? '-'} | ${sec(r.dwell_ms)} |`,
    ),
    '',
    '## 回答変更の履歴',
  ];
  const changed = d.results.filter((r) => r.change_count > 0);
  if (!changed.length) lines.push('なし');
  for (const r of changed) {
    lines.push(`${r.question_id}: ${r.path.map((p) => `${p.answer}(${sec(p.at_ms)}s)`).join(' → ')}`);
  }
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

async function renderResult(id) {
  document.body.classList.remove('in-quiz');
  const d = await api(`/sessions/${encodeURIComponent(id)}`);
  const s = d.session;
  const qmap = new Map(d.questions.map((q) => [q.id, q]));
  const confidentWrong = d.results.filter((r) => r.confidence === 'sure' && !r.is_correct).length;

  app.innerHTML = `
    <div class="card">
      <div class="muted small">${esc(s.set_title)}（${esc(s.set_id)}）・${fmtDateTime(s.started_at)}</div>
      <div class="score">${s.correct} / ${s.total} <span class="muted small">（${pct(s.correct, s.total)}%）</span></div>
      <div class="muted small">迷わず不正解：${confidentWrong} 問</div>
      <div class="row" style="margin-top:.75rem">
        <button class="primary" data-copy>AI用にコピー</button>
        <a class="btn" href="/api/sessions/${esc(s.id)}/export" download>JSONダウンロード</a>
      </div>
    </div>

    <div class="card table-wrap">
      <table>
        <thead><tr><th>問</th><th>分野</th><th>最初</th><th>最終</th><th>正誤</th><th class="num">変更</th><th>自信度</th><th class="num">秒</th></tr></thead>
        <tbody>
          ${d.results
            .map(
              (r) => `<tr>
                <td><a href="#q-${esc(r.question_id)}" data-jump="${esc(r.question_id)}">${esc(r.question_id)}</a></td>
                <td>${esc(r.field)}</td><td>${esc(r.first_answer ?? '-')}</td><td>${esc(r.final_answer ?? '-')}</td>
                <td class="${r.is_correct ? 'ok' : 'ng'}">${r.is_correct ? '○' : '×'}</td>
                <td class="num">${r.change_count}</td><td>${CONF[r.confidence] ?? '-'}</td><td class="num">${sec(r.dwell_ms)}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <h2>解説</h2>
    ${d.results
      .map((r, i) => {
        const q = qmap.get(r.question_id);
        if (!q) return '';
        return `<div class="card result-card ${r.is_correct ? 'ok-card' : 'ng-card'}" id="q-${esc(r.question_id)}">
          <div class="row spread">
            <span><strong>問${i + 1}</strong> <span class="tag">${esc(q.field)}</span></span>
            <span class="${r.is_correct ? 'ok' : 'ng'}">${r.is_correct ? '○ 正解' : '× 不正解'}</span>
          </div>
          <p class="prompt">${esc(q.prompt)}</p>
          ${q.options
            .map((o) => {
              const cls = o.id === q.answer ? 'correct' : o.id === r.final_answer ? 'wrong' : '';
              const mark = o.id === q.answer ? ' ✓正解' : o.id === r.final_answer ? ' ←あなたの回答' : '';
              return `<div class="opt ${cls}"><strong>${esc(o.id)}</strong>　${esc(o.text)}<span class="small">${mark}</span></div>`;
            })
            .join('')}
          <div class="small muted" style="margin-top:.4rem">
            自信度：${CONF[r.confidence] ?? '-'}・滞在 ${sec(r.dwell_ms)} 秒
            ${r.path.length ? `・推移：${r.path.map((p) => `${esc(p.answer)}(${sec(p.at_ms)}s)`).join(' → ')}` : ''}
          </div>
          ${q.explanation ? `<div class="explanation">${esc(q.explanation)}</div>` : ''}
        </div>`;
      })
      .join('')}
  `;

  app.querySelector('[data-copy]').addEventListener('click', async () => {
    await copyText(buildExportText(d));
    toast('コピーしました');
  });
  app.querySelectorAll('[data-jump]').forEach((a) =>
    a.addEventListener('click', (ev) => {
      ev.preventDefault(); // ハッシュルーティングを壊さないようにスクロールだけ行う
      document.getElementById(`q-${a.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth' });
    }),
  );
}

// ---------- 履歴画面 ----------

async function renderHistory() {
  document.body.classList.remove('in-quiz');
  const [{ sessions }, { fields }] = await Promise.all([api('/sessions'), api('/stats')]);
  const totals = fields.reduce(
    (a, f) => ({ total: a.total + f.total, correct: a.correct + f.correct, cw: a.cw + f.confident_wrong }),
    { total: 0, correct: 0, cw: 0 },
  );

  app.innerHTML = `
    <h1>分野別</h1>
    <div class="card table-wrap">
      ${
        fields.length
          ? `<table class="wrap">
        <thead><tr><th>分野</th><th class="num">解答</th><th class="num">正答率</th><th class="num">迷わず×</th><th class="num">迷・勘</th></tr></thead>
        <tbody>
          ${fields
            .map(
              (f) => `<tr>
                <td>${esc(f.field)}</td><td class="num">${f.total}</td>
                <td class="num">${pct(f.correct, f.total)}%<div class="bar"><span style="width:${pct(f.correct, f.total)}%"></span></div></td>
                <td class="num ${f.confident_wrong ? 'ng' : ''}">${f.confident_wrong}</td>
                <td class="num">${f.hesitant}</td>
              </tr>`,
            )
            .join('')}
          <tr><th>合計</th><th class="num">${totals.total}</th><th class="num">${pct(totals.correct, totals.total)}%</th><th class="num">${totals.cw}</th><th></th></tr>
        </tbody>
      </table>
      <p class="small muted">迷わず×：自信ありで不正解　迷・勘：自信度が「迷った」「勘」</p>`
          : '<p class="muted">まだ採点済みのセッションがありません。</p>'
      }
    </div>

    <h2>セッション</h2>
    <div class="card table-wrap">
      ${
        sessions.length
          ? `<table>
        <thead><tr><th>日時</th><th>セット</th><th class="num">正答率</th><th></th></tr></thead>
        <tbody>
          ${sessions
            .map((s) =>
              s.finished_at
                ? `<tr class="link" data-open="${esc(s.id)}">
                    <td>${fmtDateTime(s.started_at)}</td><td>${esc(s.set_title)}</td>
                    <td class="num">${s.correct}/${s.total}（${pct(s.correct, s.total)}%）</td><td></td></tr>`
                : `<tr>
                    <td>${fmtDateTime(s.started_at)}</td><td>${esc(s.set_title)}</td>
                    <td class="num muted">${quiz?.sessionId === s.id ? '解答中' : '未完了'}</td>
                    <td><button class="danger small" data-del="${esc(s.id)}">削除</button></td></tr>`,
            )
            .join('')}
        </tbody>
      </table>`
          : '<p class="muted">履歴はありません。</p>'
      }
    </div>
  `;

  app.querySelectorAll('[data-open]').forEach((tr) =>
    tr.addEventListener('click', () => (location.hash = `#/result/${tr.dataset.open}`)),
  );
  app.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('この未完了セッションとログを削除しますか？')) return;
      await api(`/sessions/${b.dataset.del}`, { method: 'DELETE' });
      if (quiz?.sessionId === b.dataset.del) {
        quiz = null;
        viewing = null;
        store.clear();
      }
      renderHistory();
    }),
  );
}

// ---------- 問題セット追加画面 ----------

const SAMPLE_JSON = `{
  "set_id": "my-set-01",
  "title": "自作セット1",
  "questions": [
    {
      "id": "q1",
      "field": "基礎理論",
      "prompt": "問題文",
      "options": [{ "id": "a", "text": "選択肢A" }, { "id": "b", "text": "選択肢B" }],
      "answer": "b",
      "explanation": "解説"
    }
  ]
}`;

async function renderSets() {
  document.body.classList.remove('in-quiz');
  const { sets } = await api('/sets');
  const custom = sets.filter((s) => s.source === 'custom');

  app.innerHTML = `
    <h1>問題セットを追加</h1>
    <div class="card">
      <p class="small muted">問題セットのJSONを貼り付けて保存します。同じ set_id の追加セットは上書きされます。</p>
      <textarea id="json" spellcheck="false" placeholder="${esc(SAMPLE_JSON)}"></textarea>
      <ul class="errors" id="errors"></ul>
      <div class="row">
        <button class="primary" id="save">保存</button>
        <label class="btn">ファイルから読込<input type="file" id="file" accept=".json,application/json" hidden></label>
      </div>
    </div>

    <h2>追加済みのセット</h2>
    ${
      custom
        .map(
          (s) => `<div class="card row spread">
            <div><strong>${esc(s.title)}</strong><div class="muted small">${esc(s.set_id)}・${s.count}問</div></div>
            <button class="danger" data-del="${esc(s.set_id)}">削除</button>
          </div>`,
        )
        .join('') || '<p class="muted">なし</p>'
    }
  `;

  const ta = app.querySelector('#json');
  const errors = app.querySelector('#errors');
  app.querySelector('#file').addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (f) ta.value = await f.text();
  });
  app.querySelector('#save').addEventListener('click', async () => {
    errors.innerHTML = '';
    let body;
    try {
      body = JSON.parse(ta.value);
    } catch (e) {
      errors.innerHTML = `<li>JSONの構文エラー：${esc(e.message)}</li>`;
      return;
    }
    try {
      const r = await api('/sets', { method: 'POST', body: JSON.stringify(body) });
      toast(`「${r.title}」（${r.count}問）を保存しました`);
      renderSets();
    } catch (e) {
      const list = e.data?.details?.length ? e.data.details : [e.message];
      errors.innerHTML = list.map((m) => `<li>${esc(m)}</li>`).join('');
    }
  });
  app.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`「${b.dataset.del}」を削除しますか？（解答済みの結果は残ります）`)) return;
      await api(`/sets/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      renderSets();
    }),
  );
}

render();
