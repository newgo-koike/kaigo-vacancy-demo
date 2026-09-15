#!/bin/zsh
# 検索用の施設一覧ファイル（public/kaigo-facilities.json）を本番 Firestore から作り直して配信する。
# 管理画面や施設側で施設データを変更したあとに実行する（エリア追加は run_add_area.sh が自動で呼ぶ）。
# 使い方: tools/run_refresh_list.sh
set -e
cd "$(dirname "$0")/.."
export GRPC_DNS_RESOLVER=native
V=tools/venv/bin/python
if [ ! -x "$V" ]; then
  echo "=== 初回のみ: 実行環境を作成 ==="
  python3 -m venv tools/venv
  tools/venv/bin/pip install -q firebase-admin
fi
echo "=== 一覧ファイルを再生成 ==="
"$V" tools/build_facilities_json.py
echo ""
echo "=== 配信（Firebase Hosting） ==="
firebase deploy --only hosting 2>&1 | grep -E "Deploy complete|Error|error" || true
echo ""
echo "=== 完了 === 反映確認: https://kaigo.meetsmedical.com/kaigo-facilities.json の count を見る"
