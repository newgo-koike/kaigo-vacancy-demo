#!/bin/bash
# public/ を「正」としてデプロイする（GitHub保存 + Firebase公開 を同時に完了）
#
# ※ 以前ここにあった「ルート直下のHTMLを public/ にコピー」する処理は削除した。
#   public/ の最新版（検索・施設詳細・データ投入など）を古いルートHTMLで
#   上書きして巻き戻す事故が起きるため。編集は public/ に対して直接行うこと。

cd "$(dirname "$0")"

# GitHub に保存（変更が無ければコミットはスキップして続行）
git add -A
git commit -m "更新: $(date '+%Y-%m-%d %H:%M')" || echo "（コミットする変更はありませんでした）"
git push

# Firebase Hosting に公開（public/ をそのまま配信）
firebase deploy --only hosting

echo ""
echo "✅ 完了！"
echo "公開URL: https://kaigo-link-dev-59bc5.web.app"
