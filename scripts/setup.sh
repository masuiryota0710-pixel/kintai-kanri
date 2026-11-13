#!/bin/sh
# =========================================================
# .env を読み込んで Supabase をセットアップし、js/config.js を生成する
#   使い方:  sh scripts/setup.sh            （全部）
#            sh scripts/setup.sh --config   （js/config.js の生成だけ）
# =========================================================
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
API="https://api.supabase.com/v1"
CONFIG_ONLY=0
[ "${1:-}" = "--config" ] && CONFIG_ONLY=1

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ .env がありません。.env.example をコピーして値を入れてください:  cp .env.example .env" >&2
  exit 1
fi

# .env 読み込み（KEY=VALUE 形式のみ。前後の空白・引用符を除去）
read_env() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
REF="$(read_env SUPABASE_PROJECT_REF)"
TOKEN="$(read_env SUPABASE_ACCESS_TOKEN)"
URL="$(read_env SUPABASE_URL)"
ANON="$(read_env SUPABASE_ANON_KEY)"
ADMIN_EMAIL="$(read_env SUPABASE_ADMIN_EMAIL)"

[ -z "$URL" ] && [ -n "$REF" ] && URL="https://$REF.supabase.co"
[ -z "$REF" ] && [ -n "$URL" ] && REF="$(printf '%s' "$URL" | sed -n 's#^https://\([^.]*\)\.supabase\.co.*#\1#p')"

# Management API 呼び出し（ステータスコードを確認し、本文を返す）
api() { # method path [json-body]
  tmp="$(mktemp)"
  if [ $# -ge 3 ]; then
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$1" "$API$2" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "$3")
  else
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$1" "$API$2" -H "Authorization: Bearer $TOKEN")
  fi
  body="$(cat "$tmp")"; rm -f "$tmp"
  case "$code" in
    2*) printf '%s' "$body" ;;
    401) echo "✗ アクセストークンが無効です（401）" >&2; return 1 ;;
    403|404) echo "✗ プロジェクトが見つからないか権限がありません（${code}）。SUPABASE_PROJECT_REF を確認してください" >&2; return 1 ;;
    *) echo "✗ Supabase API エラー（${code}）: $body" >&2; return 1 ;;
  esac
}

# JSON 文字列化（macOS 標準の ruby を使用）
json_query() { ruby -rjson -e 'print JSON.generate({ "query" => STDIN.read })' < "$1"; }

if [ "$CONFIG_ONLY" -eq 0 ] && [ -n "$TOKEN" ]; then
  [ -z "$REF" ] && { echo "✗ SUPABASE_PROJECT_REF を入れてください" >&2; exit 1; }

  echo "→ データベースを作成しています（supabase/schema.sql）…"
  api POST "/projects/$REF/database/query" "$(json_query "$ROOT/supabase/schema.sql")" > /dev/null
  echo "✓ テーブル・権限・トリガーを作成しました"

  echo "→ 「Confirm email」をオフにしています…"
  api PATCH "/projects/$REF/config/auth" '{"mailer_autoconfirm":true}' > /dev/null
  echo "✓ メール確認なしで登録できるようにしました（登録は招待コード必須）"

  # 最初の管理者の招待（管理者がまだ1人もいないときだけ）
  if [ -n "$ADMIN_EMAIL" ]; then
    sql="$(ADMIN_EMAIL="$ADMIN_EMAIL" ruby -rjson -e '
      e = ENV["ADMIN_EMAIL"].strip.downcase.gsub("\x27", "\x27\x27")
      print JSON.generate(query: <<~SQL)
        with ins as (
          insert into public.invitations (email, role, hourly_rate)
          select $$#{e}$$, $$admin$$, 0
          where not exists (select 1 from public.profiles where role = $$admin$$)
          on conflict (email) do update set role = $$admin$$ where public.invitations.used_at is null
          returning email, code
        )
        select email, code from ins
        union all
        select email, code from public.invitations
         where email = $$#{e}$$ and used_at is null and not exists (select 1 from ins)
      SQL
    ')"
    res="$(api POST "/projects/$REF/database/query" "$sql")"
    INVITE_CODE="$(printf '%s' "$res" | ruby -rjson -e 'r = JSON.parse(STDIN.read); print(r.first ? r.first["code"].to_s : "")')"
    if [ -n "$INVITE_CODE" ]; then
      echo "✓ 管理者の招待を作成しました"
      echo "    メール: $ADMIN_EMAIL"
      echo "    招待コード: $INVITE_CODE   ← 初回ログイン時に入力してください"
    else
      echo "✓ 管理者はすでに登録済みです（招待は不要）"
    fi
  fi

  if [ -z "$ANON" ]; then
    echo "→ anon キーを取得しています…"
    keys="$(api GET "/projects/$REF/api-keys?reveal=true")"
    ANON="$(printf '%s' "$keys" | ruby -rjson -e '
      ks = JSON.parse(STDIN.read)
      k = ks.find { |x| x["name"] == "anon" } || ks.find { |x| x["type"] == "publishable" }
      print(k ? k["api_key"].to_s : "")')"
    [ -z "$ANON" ] && { echo "✗ anon キーを取得できませんでした。.env の SUPABASE_ANON_KEY に手で入れてください" >&2; exit 1; }
    echo "✓ anon キーを取得しました"
  fi
elif [ "$CONFIG_ONLY" -eq 0 ]; then
  echo "! SUPABASE_ACCESS_TOKEN が空なので、DB作成は行いません（SQL Editor で supabase/schema.sql を実行してください）"
fi

# js/config.js 生成（ブラウザに渡すのは URL と anon キーだけ）
[ -z "$URL" ] && { echo "✗ SUPABASE_PROJECT_REF か SUPABASE_URL を入れてください" >&2; exit 1; }
[ -z "$ANON" ] && { echo "✗ SUPABASE_ANON_KEY を入れるか、SUPABASE_ACCESS_TOKEN を入れて自動取得してください" >&2; exit 1; }
case "$ANON" in
  sb_secret_*) echo "✗ secret キーはブラウザに置けません。anon / publishable キーを使ってください" >&2; exit 1 ;;
esac
if printf '%s' "$ANON" | grep -q '^eyJ' && printf '%s' "$ANON" | cut -d. -f2 | tr '_-' '/+' | base64 -D 2>/dev/null | grep -q 'service_role'; then
  echo "✗ service_role キーはブラウザに置けません。anon キーを使ってください" >&2; exit 1
fi

cat > "$ROOT/js/config.js" <<EOF
// このファイルは scripts/setup.sh が .env から自動生成しています（手で編集しても次回上書きされます）
window.SUPABASE_URL = '$URL';
window.SUPABASE_ANON_KEY = '$ANON';
EOF
echo "✓ js/config.js を生成しました（${URL}）"
echo "完了！ index.html をブラウザで開いてください。"
