#!/usr/bin/env python3
"""
北摂病院リストの136件を Firebase Auth + Firestore(users) に一括登録する。

  ドライラン（鍵なしで作成内容を確認）:
      python3 create_hospital_users.py --csv hospital_ids.csv

  本実行（サービスアカウント鍵を指定）:
      python3 create_hospital_users.py --csv hospital_ids.csv --key /path/to/serviceAccountKey.json --execute

再実行しても安全（既存メールはスキップし、Firestore doc は merge 更新）。
"""
import argparse, csv, sys

ROLE = "hospital"   # 検索する病院側アカウント

def load(csv_path):
    rows = []
    with open(csv_path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append({
                "no":    r["No"].strip(),
                "name":  r["医療機関名称"].strip(),
                "area":  r["エリア"].strip(),
                "id":    r["ID"].strip(),
                "pass":  r["Pass"].strip(),
                "email": r["メール"].strip(),
            })
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--key", help="Firebase サービスアカウント鍵(JSON)")
    ap.add_argument("--execute", action="store_true", help="指定時のみ実際に作成")
    args = ap.parse_args()

    rows = load(args.csv)
    print(f"対象 {len(rows)} 件\n")

    if not args.execute:
        print("=== ドライラン（実際には作成しません） ===")
        for r in rows[:3] + rows[-1:]:
            print(f"  {r['id']:6s} / pass={r['pass']} / {r['email']}  role={ROLE}  {r['name']}")
        print("  ...")
        print("\n本実行するには --key <鍵.json> --execute を付けてください。")
        return

    import firebase_admin
    from firebase_admin import credentials, auth, firestore
    PROJECT = "kaigo-link-dev-59bc5"
    if args.key:
        firebase_admin.initialize_app(credentials.Certificate(args.key), {"projectId": PROJECT})
    else:
        # gcloud ADC（Application Default Credentials）で管理者認証（鍵不要）
        firebase_admin.initialize_app(options={"projectId": PROJECT})
    db = firestore.client()

    created = skipped = failed = 0
    for r in rows:
        try:
            try:
                u = auth.get_user_by_email(r["email"])
                uid = u.uid; skipped += 1; tag = "skip(exists)"
            except auth.UserNotFoundError:
                u = auth.create_user(email=r["email"], password=r["pass"], display_name=r["name"])
                uid = u.uid; created += 1; tag = "created"
            db.collection("users").document(uid).set({
                "role":    ROLE,
                "name":    r["name"],
                "loginId": r["id"],
                "area":    r["area"],
            }, merge=True)
            print(f"  [{tag}] {r['id']} {r['name']}")
        except Exception as e:
            failed += 1
            print(f"  [FAIL] {r['id']} {r['name']} -> {e}")

    print(f"\n完了: 作成 {created} / 既存スキップ {skipped} / 失敗 {failed}")

if __name__ == "__main__":
    main()
