#!/bin/bash
# ファイルを更新したらこれを実行するだけ
# → GitHubに保存 + ネットに公開 が同時に完了

cd "$(dirname "$0")"

# public/ フォルダを最新ファイルで同期
cp kaigo-search.html kaigo-manage.html kaigo-facility-view.html kaigo-seed.html index.html public/

# GitHub に保存
git add .
git commit -m "更新: $(date '+%Y-%m-%d %H:%M')"
git push

# Firebase Hosting に公開
firebase deploy --only hosting

echo ""
echo "✅ 完了！"
echo "公開URL: https://kaigo-link-dev-59bc5.web.app"
