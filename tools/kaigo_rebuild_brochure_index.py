"""パンフレット索引 meta/brochures を facilities から作り直す（正本は facilities/<id>.brochures）。

通常は kaigo-brochure.js がアップロード・削除のたびに両方を同時更新するので不要。
何かの拍子に食い違ったとき（途中でブラウザを閉じた等）や、確認したいときに使う。

使い方（リポジトリ直下で）:
  tools/venv/bin/python tools/kaigo_rebuild_brochure_index.py show      # 施設doc と索引の差分を表示（書き込みなし）
  tools/venv/bin/python tools/kaigo_rebuild_brochure_index.py rebuild   # 施設doc の内容で索引を丸ごと書き直す

事前に: gcloud auth application-default login → set-quota-project kaigo-link-dev-59bc5
"""
import os
import sys

os.environ.setdefault("GRPC_DNS_RESOLVER", "native")

import firebase_admin
from firebase_admin import firestore

firebase_admin.initialize_app(options={"projectId": "kaigo-link-dev-59bc5"})
db = firestore.client()
INDEX = db.collection("meta").document("brochures")


def from_facilities():
    idx = {}
    for d in db.collection("facilities").stream():
        arr = [b for b in (d.to_dict().get("brochures") or []) if isinstance(b, dict) and b.get("path")]
        if arr:
            idx[d.id] = arr
    return idx


def paths(arr):
    return sorted(b.get("path") for b in arr)


def show():
    want = from_facilities()
    snap = INDEX.get()
    have = {k: v for k, v in (snap.to_dict() or {}).items() if v} if snap.exists else {}
    print(f"施設docにPDFあり: {len(want)}施設 / {sum(len(v) for v in want.values())}件")
    print(f"索引にPDFあり:   {len(have)}施設 / {sum(len(v) for v in have.values())}件")
    diff = [k for k in set(want) | set(have) if paths(want.get(k, [])) != paths(have.get(k, []))]
    print("差分のある施設:", len(diff), diff[:10])
    return want, diff


def rebuild():
    want, diff = show()
    if not diff:
        print("差分なし。書き込みは行いません")
        return
    INDEX.set(want)
    print(f"索引を書き直しました: {len(want)}施設")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("show", "rebuild"):
        print(__doc__)
        sys.exit(1)
    (show if sys.argv[1] == "show" else rebuild)()
