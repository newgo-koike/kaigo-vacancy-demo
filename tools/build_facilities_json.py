"""本番 Firestore の facilities から検索用の静的ファイル public/kaigo-facilities.json を生成する。

検索ページ（kaigo-search.html）はまずこのファイルを読み、Firestore のデータベース読み取りを
発生させない（無料プランの 1日5万読み取り上限への根本対策）。ファイルが取れない環境だけ
従来どおり Firestore から読む。

使い方（リポジトリ直下で）:
  tools/venv/bin/python tools/build_facilities_json.py        # 生成して件数を表示
  → そのあと firebase deploy --only hosting で配信

再生成が必要なタイミング:
  - エリア追加・データ再取り込みのあと（run_add_area.sh が自動で呼ぶ）
  - 管理画面や施設側で施設情報を変更したあと（変更は再生成＋デプロイまで検索に反映されない）

事前に: gcloud auth application-default login → set-quota-project kaigo-link-dev-59bc5
"""
import json
import os
import sys
from datetime import datetime, timezone

os.environ.setdefault("GRPC_DNS_RESOLVER", "native")   # macOS の gRPC DNS ハング対策

import firebase_admin
from firebase_admin import firestore

OUT = "public/kaigo-facilities.json"

firebase_admin.initialize_app(options={"projectId": "kaigo-link-dev-59bc5"})
db = firestore.client()


def plain(v):
    """Firestore の型を JSON に落とす（Timestamp → ISO文字列、それ以外はそのまま）。"""
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [plain(x) for x in v]
    return v


def main():
    docs = []
    for d in db.collection("facilities").stream():
        rec = plain(d.to_dict())
        rec["id"] = d.id                      # 詳細ページ（kaigo-facility-view.html?id=）のリンク用
        docs.append(rec)
    docs.sort(key=lambda r: (r.get("prefecture", ""), r.get("city", ""), r.get("name", "")))
    by_pref = {}
    for r in docs:
        by_pref[r.get("prefecture", "?")] = by_pref.get(r.get("prefecture", "?"), 0) + 1
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(docs),
        "facilities": docs,
    }
    if len(docs) < 100:
        sys.exit(f"NG: 件数が少なすぎる（{len(docs)}件）。認証や接続先を確認。ファイルは更新していません")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"出力: {OUT}  {len(docs)}件  {size/1024:.0f}KB  府県別: {by_pref}")
    print("次: firebase deploy --only hosting で配信")


if __name__ == "__main__":
    main()
