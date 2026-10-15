# AP診断クイズ

応用情報技術者試験の練習問題を解き、正誤に加えて「迷い」（回答の変更・自信度・滞在時間）を記録する個人用Webアプリ。
結果は「AI用にコピー」でMarkdownテキストにして、AIチャットに貼り付けて弱点分析に使う。

- Cloudflare Workers（Static Assets でフロントを配信）
- API：Hono + TypeScript（`src/`）
- DB：Cloudflare D1（`schema.sql`）
- フロント：ビルド不要の素の HTML/CSS/JS（`public/`）

## 構成

```
questions/*.json          組み込み問題セット（1ファイル＝1セット）
scripts/build-questions.mjs  questions/*.json を src/generated/questions.ts に取り込む（wrangler が自動実行）
src/index.ts              API（/api/*）
src/aggregate.ts          イベントログ → 問題ごとの集計
src/validate.ts           問題セットJSONの検証
public/                   フロントエンド
schema.sql                D1 テーブル定義
test/                     ユニットテスト（vitest）
```

## ローカル起動

Node.js 20 以上が必要。

```sh
npm install
npm run db:init:local   # ローカルD1（.wrangler/state）にテーブルを作成
npm run dev             # http://localhost:8787
```

`wrangler.toml` の `database_id` はダミーのままでもローカルでは動く。
`questions/` 内のJSONを編集すると `wrangler dev` が自動で再ビルドする。

テストと型チェック：

```sh
npm test
npm run typecheck
```

## 問題セットの追加

次のどちらか。

1. `questions/<set_id>.json` を置く（組み込みセット。デプロイ時に Worker に同梱される）
2. 画面の「問題追加」でJSONを貼り付ける（D1 の `question_sets` に保存。同じ `set_id` は上書き）

形式は `questions/diag-01.json` を参照。`explanation` は省略可。選択肢は2つ以上、`answer` は選択肢の `id` と一致させる。

## 記録されるデータ

| テーブル | 内容 |
|---|---|
| `sessions` | 解答セッション。開始時に問題セットのスナップショットを保存する |
| `events` | `view`（問題表示）/ `leave`（離脱）/ `select`（選択肢クリック）/ `confidence`（自信度変更）/ `finish` をクライアント時刻付きで保存 |
| `results` | 採点時にイベントから算出した問題ごとの集計 |

集計ルール：

- 滞在時間：`view` から `leave`（または別問題の `view`・`finish`）までを問題ごとに合算。タブを裏に回した時間は含めない
- 回答の推移：直前と異なる選択肢を選んだときだけ記録（同じ選択肢の再クリックは変更扱いしない）。`a→c→a` は変更回数2
- 推移の秒数（`c(12s)`）は、その問題に滞在した累計時間のうち何秒目に選んだか
- 「迷わず不正解」＝自信度「自信あり」で不正解

イベントは数秒おきにまとめて送信し、ページを閉じるときは `sendBeacon` で送る。解答途中の状態はブラウザの localStorage に保存されるため、リロードしても続きから再開できる。

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/sets` | 問題セット一覧 |
| POST | `/api/sets` | 問題セットを追加（D1） |
| DELETE | `/api/sets/:id` | 追加した問題セットを削除 |
| POST | `/api/sessions` | `{ "set_id" }` でセッション開始（正解・解説は返さない） |
| GET | `/api/sessions` | セッション一覧 |
| POST | `/api/sessions/:id/events` | `{ "events": [...] }` イベント送信（`seq` で重複排除） |
| POST | `/api/sessions/:id/finish` | 採点 |
| GET | `/api/sessions/:id` | 採点結果・解説 |
| GET | `/api/sessions/:id/export` | 結果＋生イベントのJSONダウンロード |
| DELETE | `/api/sessions/:id` | セッション削除 |
| GET | `/api/stats` | 分野別の正答率・迷わず不正解の件数 |

## デプロイ手順（参考）

```sh
npx wrangler login

# 1. D1 を作成し、出力された database_id を wrangler.toml に書く
npx wrangler d1 create ap-quiz

# 2. 本番 D1 にテーブルを作成（マイグレーション）
npm run db:init:remote

# 3. wrangler.toml の routes のコメントを外す（ap.rei78.cc をカスタムドメインとして割り当て）
# 4. デプロイ
npm run deploy
```

`schema.sql` は `CREATE TABLE IF NOT EXISTS` なので、再実行しても既存データは消えない。
将来テーブルを変更する場合は `wrangler d1 migrations create ap-quiz <name>` で `migrations/` 管理に移行する。

`wrangler.toml` では `workers_dev = false` と `preview_urls = false` を設定している。
`*.workers.dev` やプレビューURLが有効だと Cloudflare Access を経由せずにアクセスできるため、無効のままにする。

## アクセス制限（Cloudflare Access）

アプリ自体に認証はない。Cloudflare Access（Zero Trust）で ap.rei78.cc 全体を保護する。
**デプロイ前に設定すること**（先にデプロイすると、設定するまで誰でもアクセスできる）。

1. Cloudflare ダッシュボード → **Zero Trust** を開く（初回はチーム名とプラン選択。Free プランで可）
2. **Access → Applications → Add an application → Self-hosted** を選ぶ
3. Application 設定
   - Application name：`AP診断クイズ`
   - Session Duration：任意（例：1 week）
   - Public hostname：Subdomain `ap`、Domain `rei78.cc`、Path は空（サイト全体を保護）
4. Policy を追加
   - Policy name：`owner`
   - Action：**Allow**
   - Include → Selector **Emails** → 自分のメールアドレス
5. Login methods は既定の **One-time PIN**（メールに届くコードでログイン）で足りる。GitHub/Google ログインを使う場合は Settings → Authentication で追加する
6. 保存後、シークレットウィンドウで https://ap.rei78.cc を開き、Access のログイン画面が出ることを確認する

補足：

- `/api/*` も同じホスト名なので一緒に保護される。`sendBeacon`・`fetch` は同一オリジンのため Access の Cookie がそのまま送られる
- さらに堅くする場合は、Worker 側で `Cf-Access-Jwt-Assertion` ヘッダの JWT を検証する（今回は未実装）
