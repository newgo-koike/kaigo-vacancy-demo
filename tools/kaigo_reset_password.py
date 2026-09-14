"""病院ユーザーのパスワードを管理者側で初期化する（パスワードを忘れた病院への対応）。

病院IDのメールは内部ダミー（{loginId}@meets-medical.jp）で実在しないため、Firebase の
再設定メール方式は使えない。管理者が Admin SDK で直接上書きする。

使い方（リポジトリ直下で。tools/venv は run_add_area.sh が作ったものを使う）:
  tools/venv/bin/python tools/kaigo_reset_password.py find 病院名の一部     # 対象のログインIDを探す
  tools/venv/bin/python tools/kaigo_reset_password.py reset 7185-01           # 初期パスワード（=ID）に戻す
  tools/venv/bin/python tools/kaigo_reset_password.py reset 7185-01 新PW      # 任意のパスワードにする

事前に: gcloud auth application-default login → gcloud auth application-default set-quota-project kaigo-link-dev-59bc5
初期パスワード規則: ログインIDと同じ文字列。数字のみで6桁未満の場合は先頭ゼロ埋め（kaigo-login.html と同じ規則）。
"""
import os
import sys

os.environ.setdefault("GRPC_DNS_RESOLVER", "native")   # macOS の gRPC DNS ハング対策

import firebase_admin
from firebase_admin import auth, firestore

DOMAIN = "meets-medical.jp"
firebase_admin.initialize_app(options={"projectId": "kaigo-link-dev-59bc5"})
db = firestore.client()


def initial_password(login_id):
    pw = login_id
    if pw.isdigit() and len(pw) < 6:
        pw = pw.zfill(6)
    return pw


def cmd_find(keyword):
    hits = []
    for d in db.collection("users").where("role", "==", "hospital").stream():
        u = d.to_dict()
        hay = f"{u.get('hospitalName','')} {u.get('name','')} {u.get('loginId','')}"
        if keyword in hay:
            hits.append(u)
    if not hits:
        print("該当なし:", keyword)
        return
    hits.sort(key=lambda u: u.get("loginId", ""))
    for u in hits:
        print(f"{u.get('loginId',''):10}  {u.get('hospitalName','')}  担当者: {u.get('name','')}")


def cmd_reset(login_id, new_pw=None):
    email = f"{login_id}@{DOMAIN}"
    pw = new_pw or initial_password(login_id)
    if len(pw) < 6:
        sys.exit("NG: パスワードは6文字以上（Firebase の下限）")
    try:
        user = auth.get_user_by_email(email)
    except auth.UserNotFoundError:
        sys.exit(f"NG: {login_id} のアカウントが見つかりません（find で確認を）")
    doc = db.collection("users").document(user.uid).get().to_dict() or {}
    auth.update_user(user.uid, password=pw)
    label = "初期パスワード（IDと同じ）" if new_pw is None else "指定のパスワード"
    print(f"完了: {login_id}（{doc.get('hospitalName','')} / {doc.get('name','')}）を{label}に再設定しました")
    print("案内文: ログインID " + login_id + " ／ パスワード " + pw + "（ログイン後、担当者管理から変更できます）")


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "find":
        cmd_find(" ".join(a[1:]))
    elif len(a) in (2, 3) and a[0] == "reset":
        cmd_reset(a[1], a[2] if len(a) == 3 else None)
    else:
        print(__doc__)
        sys.exit(1)
