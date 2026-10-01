"""261001 取り込みの後追い修正（2026-10-01、小池さん指示）。1回限りの更新スクリプト。
  1. 既存「新大阪ケアコミュニティそよ風」（介護付有料）の名前に種別を付ける（グループホーム側は別途 --append で追加）
  2. 吹田の特養4件の住所が町名までしか無いので、兵頭さんの Excel の住所に直す
更新前に対象ドキュメントを facilities-backup-fix-261001-<日時>.json へ退避し、現在値が想定どおりのときだけ書き換える。
使い方: tools/venv/bin/python tools/fix_261001_followup.py [--apply]   （--apply 無しは確認のみ）
"""
import json, os, sys
from datetime import datetime
os.environ.setdefault("GRPC_DNS_RESOLVER", "native")
import firebase_admin
from firebase_admin import firestore
firebase_admin.initialize_app(options={"projectId": "kaigo-link-dev-59bc5"})
db = firestore.client()

# (docId, 確認する現在値 {field: value}, 書き換え {field: value})
FIXES = [
    ("Xg8tUBqAmtSNijMkDdjo", {"name": "新大阪ケアコミュニティそよ風", "type": "介護付有料"}, {"name": "新大阪ケアコミュニティそよ風（介護付有料老人ホーム）"}),
    ("AavvMzRLGbxBTOIokG6Z", {"name": "地域密着型特別養護老人ホーム陽翠苑", "address": "吹田市南吹田"}, {"address": "吹田市南吹田1-1-22"}),
    ("5emJqjokmHbV13Xk8G47", {"name": "特別養護老人ホームハピネスさんあいNext", "address": "吹田市幸町"}, {"address": "吹田市幸町25番1号"}),
    ("kSqNyFI8yAYzkittzldn", {"name": "地域密着型特別養護老人ホーム憩〜北千里〜", "address": "吹田市古江台"}, {"address": "吹田市古江台3丁目9番2号"}),
    ("SmDKseqVb0bXUKiCFNuh", {"name": "地域密着型特別養護老人ホーム憩〜江坂〜", "address": "吹田市江坂町"}, {"address": "吹田市江坂町2-14-22"}),
]

def main():
    apply = "--apply" in sys.argv
    snaps = {doc_id: db.collection("facilities").document(doc_id).get() for doc_id, _, _ in FIXES}
    for doc_id, expect, patch in FIXES:
        s = snaps[doc_id]
        if not s.exists:
            sys.exit(f"NG: 見つかりません {doc_id}")
        d = s.to_dict()
        for k, v in expect.items():
            if d.get(k) != v:
                sys.exit(f"NG: {doc_id} の {k} が想定と違う: {d.get(k)!r} != {v!r}（書き換えていません）")
        print(f"{d.get('name')}: " + ", ".join(f"{k} {d.get(k)!r} → {v!r}" for k, v in patch.items()))
    if not apply:
        print("確認のみ（--apply で書き換え）"); return
    out = f"facilities-backup-fix-261001-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    json.dump([{"id": i, "data": snaps[i].to_dict()} for i, _, _ in FIXES], open(out, "w", encoding="utf-8"), ensure_ascii=False, default=str)
    print("退避:", out)
    batch = db.batch()
    for doc_id, _, patch in FIXES:
        batch.update(db.collection("facilities").document(doc_id), {**patch, "updatedAt": firestore.SERVER_TIMESTAMP})
    batch.commit()
    for doc_id, _, patch in FIXES:
        d = db.collection("facilities").document(doc_id).get().to_dict()
        ok = all(d.get(k) == v for k, v in patch.items())
        print(("OK " if ok else "NG ") + d.get("name"))

if __name__ == "__main__":
    main()
