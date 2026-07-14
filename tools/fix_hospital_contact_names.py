#!/usr/bin/env python3
"""病院アカウントの name（担当者名）から、病院名が入ってしまっているものを外す。

現状: 病院リストから一括発行した -01 アカウントは name にも病院名が入っている。
      あとから追加した担当者は name が個人名。同じ「担当者名」の欄に病院名と
      個人名が混在していて、一覧でもログイン後のヘッダーでも意味が通らない。

変更: name == hospitalName の場合、name を空にする（担当者名は未設定という状態にする）。
      hospitalName は触らないので、病院名の情報は失われない。

      before: { hospitalName: "近藤病院", name: "近藤病院" }
      after : { hospitalName: "近藤病院", name: "" }

担当者名は、判明した時点で管理者ダッシュボードから入力する。

  ドライラン:
      <venv>/bin/python tools/fix_hospital_contact_names.py

  本実行:
      <venv>/bin/python tools/fix_hospital_contact_names.py --execute
"""
import argparse, datetime, json, sys

import firebase_admin
from firebase_admin import firestore

PROJECT = "kaigo-link-dev-59bc5"
OUTDIR  = "/Users/yugo/Dropbox/Obsidian/obsidian_all/YUMEMATCH/AI業務効率化/兵頭さん/介護施設関連"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true", help="指定時のみ実際に書き換える")
    args = ap.parse_args()

    firebase_admin.initialize_app(options={"projectId": PROJECT})
    db = firestore.client()

    docs  = list(db.collection("users").where("role", "==", "hospital").stream())
    users = [dict(d.to_dict(), uid=d.id) for d in docs]
    if not users:
        sys.exit("病院アカウントが1件も見つかりません。認証を確認してください。")

    targets = [u for u in users
               if (u.get("name") or "").strip() and u.get("name") == u.get("hospitalName")]
    keep    = [u for u in users if u not in targets]

    print(f"病院アカウント {len(users)}件")
    print(f"  担当者名に病院名が入っている（=空にする）: {len(targets)}件")
    print(f"  個人名が入っている（そのまま）          : {len(keep)}件")
    for u in keep:
        print(f"    {u.get('loginId')}  {u.get('name')}  @ {u.get('hospitalName')}")

    # hospitalName が無いものがあると、空にした瞬間に病院名が消える。必ず事前に弾く。
    broken = [u for u in targets if not (u.get("hospitalName") or "").strip()]
    if broken:
        sys.exit(f"❌ hospitalName が空のアカウントが {len(broken)}件あります。中止します。")

    if not args.execute:
        print("\n=== ドライラン（1件も書き換えません） ===")
        for u in targets[:5]:
            print(f"  {u.get('loginId'):>8s}  name: '{u.get('name')}' -> ''   （hospitalName は維持）")
        print(f"  ... 計 {len(targets)}件")
        print("\n本実行するには --execute を付けてください。")
        return

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{OUTDIR}/hospital-users-backup-{stamp}.json"
    with open(backup, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=2, default=str)
    print(f"\n✅ バックアップ: {backup}")

    batch, n = db.batch(), 0
    for u in targets:
        batch.set(db.collection("users").document(u["uid"]), {"name": ""}, merge=True)
        n += 1
        if n % 400 == 0:
            batch.commit(); batch = db.batch()
    batch.commit()
    print(f"✅ 更新 {len(targets)}件")

    print("\n=== 検証 ===")
    after = [d.to_dict() for d in db.collection("users").where("role", "==", "hospital").stream()]
    dup     = sum(1 for u in after if (u.get("name") or "") and u.get("name") == u.get("hospitalName"))
    no_hosp = sum(1 for u in after if not (u.get("hospitalName") or "").strip())
    named   = sum(1 for u in after if (u.get("name") or "").strip())
    print(f"  担当者名＝病院名 のまま残っている: {dup}件 {'✅' if dup == 0 else '❌'}")
    print(f"  hospitalName が空: {no_hosp}件 {'✅' if no_hosp == 0 else '❌'}")
    print(f"  担当者名が入っている: {named}/{len(after)}件（残りは未設定＝管理画面から入力）")

if __name__ == "__main__":
    main()
