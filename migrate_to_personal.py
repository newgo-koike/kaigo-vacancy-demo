#!/usr/bin/env python3
"""既存の病院単位アカウント(例 1001)を、各病院の1人目の個人アカウント(1001-01)に移行する。

  loginId : 1001            -> 1001-01
  email   : 1001@...        -> 1001-01@...
  password: 001001          -> 1001-01
  + hospitalId(1001), hospitalName(病院名) を付与（病院ごとの区別用）

Admin SDK(ADC)で実行。再実行しても安全（冪等）。
    <venv>/bin/python migrate_to_personal.py
"""
import csv
import firebase_admin
from firebase_admin import auth, firestore

PROJECT = "kaigo-link-dev-59bc5"
DOMAIN  = "meets-medical.jp"
CSVPATH = "/Users/yugo/Dropbox/Obsidian/obsidian_all/YUMEMATCH/AI業務効率化/兵頭さん/介護施設関連/hospital_ids.csv"

firebase_admin.initialize_app(options={"projectId": PROJECT})
db = firestore.client()

def main():
    rows = []
    with open(CSVPATH, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append({"code": r["ID"].strip(), "name": r["医療機関名称"].strip(), "area": r["エリア"].strip()})
    print("対象", len(rows), "件")

    done = fail = 0
    for r in rows:
        code, name, area = r["code"], r["name"], r["area"]
        old_email = f"{code}@{DOMAIN}"
        new_login = f"{code}-01"
        new_email = f"{new_login}@{DOMAIN}"
        new_pass  = new_login
        try:
            try:
                u = auth.get_user_by_email(old_email)
            except auth.UserNotFoundError:
                u = auth.get_user_by_email(new_email)   # 既に移行済み
            uid = u.uid
            auth.update_user(uid, email=new_email, password=new_pass)
            db.collection("users").document(uid).set({
                "role": "hospital", "name": name, "loginId": new_login,
                "hospitalId": code, "hospitalName": name, "area": area, "email": new_email,
            }, merge=True)
            done += 1
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {code} {name} -> {e}")

    print(f"完了: 移行 {done} / 失敗 {fail}")

if __name__ == "__main__":
    main()
