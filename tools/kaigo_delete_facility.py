"""施設を1件だけ Firestore から削除する（削除前に必ずその1件をJSONへ退避）。

使い方（リポジトリ直下で）:
  tools/venv/bin/python tools/kaigo_delete_facility.py show   <docId>   # 内容確認（書き込みなし）
  tools/venv/bin/python tools/kaigo_delete_facility.py delete <docId>   # 退避→削除→消えたことを確認

退避先: facilities-deleted-<docId>-<日時>.json（復元は同じ内容を set し直す）
削除後は tools/run_refresh_list.sh で一覧ファイルを再生成・配信すること。
"""
import json
import os
import sys
from datetime import datetime

os.environ.setdefault("GRPC_DNS_RESOLVER", "native")

import firebase_admin
from firebase_admin import firestore

firebase_admin.initialize_app(options={"projectId": "kaigo-link-dev-59bc5"})
db = firestore.client()


def show(doc_id):
    snap = db.collection("facilities").document(doc_id).get()
    if not snap.exists:
        sys.exit(f"NG: 見つかりません: {doc_id}")
    d = snap.to_dict()
    print(f"{doc_id}: {d.get('name')} / {d.get('type')} / {d.get('prefecture')} {d.get('city')} / 賃料{d.get('rent')} 管理{d.get('managementFee')} 食費{d.get('mealFee')}")
    return d


def delete(doc_id):
    d = show(doc_id)
    out = f"facilities-deleted-{doc_id}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    json.dump({"id": doc_id, "data": d}, open(out, "w", encoding="utf-8"), ensure_ascii=False, default=str, indent=1)
    print(f"退避: {out}")
    db.collection("facilities").document(doc_id).delete()
    gone = not db.collection("facilities").document(doc_id).get().exists
    print("削除:", "完了（存在しないことを確認）" if gone else "NG: まだ存在します")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("show", "delete"):
        print(__doc__)
        sys.exit(1)
    (show if sys.argv[1] == "show" else delete)(sys.argv[2])
