#!/bin/zsh
# エリア追加データを本番 Firestore に取り込む（backup→dryrun→apply→verify を順に実行）。
# 使い方: tools/run_add_area.sh tools/kaigo-import-data-XXXXXX.js
# 途中の段でNGが出た時点で止まる（apply 前なら1件も書き込まれない）。
set -e
cd "$(dirname "$0")/.."
export GRPC_DNS_RESOLVER=native   # Firestore SDK のハング対策（kaigo_add_area.py 側にも同設定）
[ -n "$1" ] || { echo "使い方: tools/run_add_area.sh tools/kaigo-import-data-XXXXXX.js"; exit 1; }

# 実行環境（firebase-admin 入り venv）は再起動で消える scratchpad ではなく repo 内に持つ
V=tools/venv/bin/python
if [ ! -x "$V" ]; then
  echo "=== 初回のみ: 実行環境を作成 ==="
  python3 -m venv tools/venv
  tools/venv/bin/pip install -q firebase-admin
fi

for step in backup dryrun apply verify; do
  echo ""
  echo "=== $step : $1 ==="
  "$V" tools/kaigo_add_area.py "$step" "$1"
done
echo ""
echo "=== 検索用の一覧ファイルを再生成（静的配信用） ==="
"$V" tools/build_facilities_json.py
echo ""
echo "=== 完了: $1 ===（このあと firebase deploy --only hosting で一覧ファイルを配信）"
