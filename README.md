# 勤怠管理システム（Supabase 版）

画面は HTML/JS のみ（ビルド不要）、データ・ログイン・権限は Supabase で管理します。

## 構成
```
index.html            画面
css/style.css         見た目
.env                  Supabase の接続情報・アクセストークン（★ここに入力）
scripts/setup.sh      .env を読んで DB セットアップ ＋ js/config.js を生成
scripts/deploy.sh     GitHub Pages に公開（更新）
js/config.js          ブラウザ用の接続設定（setup.sh が自動生成）
js/app.js             アプリ本体
supabase/schema.sql   DB（テーブル・権限・トリガー・Realtime）
```

## セットアップ（初回だけ）
1. https://supabase.com でプロジェクトを作成
2. `.env` に値を入れる
   - `SUPABASE_PROJECT_REF`：Project Settings → General の Project ID
   - `SUPABASE_ACCESS_TOKEN`：https://supabase.com/dashboard/account/tokens で発行
   - `SUPABASE_ADMIN_EMAIL`：最初の管理者のメールアドレス
3. ターミナルでこのフォルダに移動して実行
   ```
   sh scripts/setup.sh
   ```
   次の作業が自動で行われます。
   - DB 作成
   - 「Confirm email」のオフ
   - anon キーの取得
   - `js/config.js` の生成
4. `index.html` をブラウザで開く

### アクセストークンを使わない場合（手動）
1. SQL Editor に `supabase/schema.sql` を貼り付けて Run
2. Authentication → Sign In / Providers → Email で「Confirm email」をオフ
3. `.env` に `SUPABASE_PROJECT_REF` と `SUPABASE_ANON_KEY`（Project Settings → API の anon キー）を入れる
4. `sh scripts/setup.sh` を実行（`js/config.js` だけが生成されます）

※ `.env` のアクセストークンは秘密情報です。`.gitignore` 済みで、ブラウザ用の `js/config.js` にも書き出されません。
　service_role / secret キーを入れた場合、スクリプトがエラーにして止めます。

## ログインとアカウント（招待制）
- **登録できるのは、管理者に招待された人だけ**です（招待されたメールアドレス＋招待コードが必要）
- 最初の管理者は `.env` の `SUPABASE_ADMIN_EMAIL` に書いておくと、`setup.sh` が招待コードを発行します
- 招待のしかた：管理者 →「ユーザー・ロール管理」→「＋ ユーザーを招待」
  - 名前・メール・ロール・時給・有給日数を入れると、招待コードと案内文が出ます。それを本人に送ってください
  - まだ登録していない人は「招待中」に一覧で出ます。そこからコードの再確認や取消ができます
- 招待された人の初回ログイン：ログイン画面の「はじめての方」を開いて招待コードを入力し、招待されたメールアドレスと、自分で決めたパスワード（6文字以上）でログインします
- 2回目以降は、メールアドレスとパスワードだけでログインできます
- 管理者は、ロール変更・時給や有給日数の設定・無効化もできます
  - 無効化された人はログインできず、API を直接使ってもデータを読み書きできません
- 管理者自身を間違って社員にしてしまった場合などは、SQL Editor で次を実行すると戻せます
  `update profiles set role = 'admin' where email = 'xxx@example.com';`

## 公開（GitHub Pages）
```
sh scripts/deploy.sh
```
- `gh`（GitHub CLI）でログイン済みであれば、リポジトリの作成・アップロード・Pages の有効化までまとめて行います
- 更新したときも同じコマンドを実行してください。変更したファイルだけがアップロードされます
- `.env` はアップロードされません
- アクセストークンなどの秘密情報がファイルに混ざっていた場合は、公開を中止します

## 申請 → 承認 → 一覧反映 の確認手順
ログイン状態はタブごとに別なので、タブを2つ並べると確認しやすいです（公開URLなら、別の PC やスマホからでも OK）。

1. タブA：社員でログイン →「シフト申請」でカレンダーの日付をクリックして申請（有給も同様）
2. タブB：管理者でログイン →「申請の承認」→「承認」または「却下」
3. タブA：再読み込みしなくても自動で更新され、カレンダーや「みんなのシフト」に反映される

## セキュリティ（DB 側で強制していること）
- 社員は、承認・却下、ロール変更、時給や有給日数の変更、他人の勤怠の閲覧ができない
- 打刻時刻はサーバーの時計で記録する（端末の時計をずらしても不正できない）。打刻の修正は管理者だけ
- 有給の日数はサーバーで計算し、残日数を超える申請や承認はエラーになる
- 同じ日にシフトを2件申請できない。最後の管理者を社員に変更することもできない
- 無効化されたユーザーはログインも申請もできない

## 補足
- 請求書 PDF は、ネットにつながっていれば直接ダウンロードされます。オフラインのときは印刷ダイアログで「PDF として保存」を選んでください
- パスワードを忘れた場合のリセット画面はまだありません。Supabase ダッシュボードの Authentication → Users から対応してください
