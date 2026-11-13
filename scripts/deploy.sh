#!/bin/sh
# =========================================================
# GitHub Pages に公開（更新）する
#   使い方:  sh scripts/deploy.sh [リポジトリ名]   （省略時: kintai-kanri）
#   必要なもの: gh コマンド（gh auth login 済み）
#   ※ .env は絶対にアップロードしない。秘密情報が混ざっていたら中止する。
# =========================================================
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NAME="${1:-kintai-kanri}"

# 公開するファイル（.env は含めない）
FILES="index.html css/style.css js/app.js js/config.js .nojekyll README.md supabase/schema.sql scripts/setup.sh scripts/deploy.sh .env.example .gitignore"
[ -f .nojekyll ] || : > .nojekyll

command -v gh >/dev/null || { echo "✗ gh コマンドがありません" >&2; exit 1; }
OWNER="$(gh api user --jq .login)"
REPO="$OWNER/$NAME"

# ---- 秘密情報チェック ----
if grep -q "YOUR-" js/config.js; then
  echo "✗ js/config.js が未設定です。先に sh scripts/setup.sh を実行してください" >&2; exit 1
fi
secrets=""
if [ -f .env ]; then
  for key in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; do
    v="$(sed -n "s/^$key=//p" .env | tail -n 1)"
    [ -n "$v" ] && secrets="$secrets
$v"
  done
fi
for f in $FILES; do
  [ -f "$f" ] || { echo "✗ $f がありません" >&2; exit 1; }
  if grep -Eq 'sbp_[0-9a-f]{40}|sb_secret_[A-Za-z0-9_-]{10,}|service_role["]' "$f"; then
    echo "✗ $f にアクセストークンや secret キーらしき文字列があります。公開を中止しました" >&2; exit 1
  fi
  printf '%s\n' "$secrets" | while IFS= read -r v; do
    [ -n "$v" ] && grep -qF -- "$v" "$f" && { echo "✗ $f に .env の秘密情報が含まれています。公開を中止しました" >&2; exit 1; }
    :
  done
done
echo "✓ 秘密情報チェック OK（.env はアップロードしません）"

# ---- リポジトリ作成（なければ） ----
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$NAME" --public --description "勤怠管理システム（Supabase + GitHub Pages）" >/dev/null
  echo "✓ リポジトリを作成しました: https://github.com/$REPO"
fi

# ---- ファイルをアップロード（変更があるものだけ） ----
for f in $FILES; do
  sha="$(gh api "repos/$REPO/contents/$f" --jq .sha 2>/dev/null || true)"
  local_sha="$(printf 'blob %s\0' "$(wc -c < "$f" | tr -d ' ')" | cat - "$f" | shasum -a 1 | cut -d' ' -f1)"
  if [ "$sha" = "$local_sha" ]; then continue; fi
  F="$f" SHA="$sha" ruby -rjson -rbase64 -e '
    b = { message: "Update #{ENV["F"]}", content: Base64.strict_encode64(File.binread(ENV["F"])) }
    b[:sha] = ENV["SHA"] unless ENV["SHA"].to_s.empty?
    print JSON.generate(b)' | gh api -X PUT "repos/$REPO/contents/$f" --input - >/dev/null
  echo "  ↑ $f"
done
echo "✓ アップロード完了"

# ---- GitHub Pages を有効化（初回のみ） ----
if ! gh api "repos/$REPO/pages" >/dev/null 2>&1; then
  gh api -X POST "repos/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null
  echo "✓ GitHub Pages を有効にしました"
fi
URL="$(gh api "repos/$REPO/pages" --jq .html_url)"
echo "公開URL: $URL"
echo "（反映まで1〜2分かかることがあります）"
