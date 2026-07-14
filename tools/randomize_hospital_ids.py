#!/usr/bin/env python3
"""病院コードを連番からランダム4桁に置き換える。

現状: 病院コードが連番でエリア順（1001, 1002... 10001...）。桁数も4桁と5桁が混在し、
      コードから病院数・エリアが推測できてしまう。
変更: 重複しないランダム4桁（1000〜9999）に付け替える。

  ログインID : 1001-01      -> 7412-01
  メール     : 1001-01@...  -> 7412-01@...
  パスワード : 1001-01      -> 7412-01   （初期パスワード = ログインID の設計を維持）
  hospitalId : 1001         -> 7412

先頭ゼロ（0001 等）は使わない。CSV や Excel で配布一覧を扱うときに
先頭ゼロが落ちて別IDになる事故を防ぐため。

【重要】ログインIDを変えると、その病院の既存の認証情報は使えなくなる。
        病院にIDを配布したあとは実行しないこと。

  ドライラン（何も書き換えず、新旧の対応表だけ出力）:
      <venv>/bin/python tools/randomize_hospital_ids.py

  本実行:
      gcloud auth application-default login   # 先に一度だけ
      <venv>/bin/python tools/randomize_hospital_ids.py --execute

再実行しても安全（冪等ではないので、実行前に必ずバックアップJSONを取る）。
"""
import argparse, csv, json, random, re, sys, datetime
from collections import defaultdict

import firebase_admin
from firebase_admin import auth, firestore

PROJECT = "kaigo-link-dev-59bc5"
DOMAIN  = "meets-medical.jp"
OUTDIR  = "/Users/yugo/Dropbox/Obsidian/obsidian_all/YUMEMATCH/AI業務効率化/兵頭さん/介護施設関連"

def seq_of(login_id: str) -> int:
    """1001-02 -> 2"""
    m = re.search(r"-(\d+)$", login_id or "")
    return int(m.group(1)) if m else 1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true", help="指定時のみ実際に書き換える")
    ap.add_argument("--seed", type=int, help="乱数シード（再現したいときだけ）")
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    firebase_admin.initialize_app(options={"projectId": PROJECT})
    db = firestore.client()

    # ── 現状を読み込む ────────────────────────────────────────
    docs = list(db.collection("users").where("role", "==", "hospital").stream())
    users = [dict(d.to_dict(), uid=d.id) for d in docs]
    if not users:
        sys.exit("病院アカウントが1件も見つかりません。認証を確認してください。")

    by_hospital = defaultdict(list)
    for u in users:
        by_hospital[str(u.get("hospitalId") or "")].append(u)
    for members in by_hospital.values():
        members.sort(key=lambda u: seq_of(u.get("loginId", "")))

    old_codes = sorted(by_hospital.keys())
    print(f"病院数 {len(old_codes)} / アカウント数 {len(users)}")

    # ── 新しいランダム4桁を割り当てる（重複なし・先頭ゼロなし）──
    pool = random.sample(range(1000, 10000), len(old_codes))
    new_code_of = {old: str(pool[i]) for i, old in enumerate(old_codes)}
    assert len(set(new_code_of.values())) == len(old_codes), "新コードが重複"

    # ── 対応表 ────────────────────────────────────────────────
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    rows = []
    for old in old_codes:
        members = by_hospital[old]
        h = members[0]
        for m in members:
            s = seq_of(m.get("loginId", ""))
            rows.append({
                "病院名":   h.get("hospitalName") or h.get("name") or "",
                "エリア":   h.get("area") or "",
                "旧ID":     m.get("loginId", ""),
                "新ID":     f"{new_code_of[old]}-{s:02d}",
                "パスワード": f"{new_code_of[old]}-{s:02d}",   # 初期パスワード = ログインID
                "担当者名": m.get("name") or "",
                "uid":      m["uid"],
                "旧コード": old,
                "新コード": new_code_of[old],
            })

    if not args.execute:
        # バックアップは本実行時のみ。ここでは対応表の下見だけ。
        print("\n=== ドライラン（1件も書き換えません） ===")
        for r in rows[:5]:
            print(f"  {r['旧ID']:>10s} -> {r['新ID']:<8s}  {r['病院名']}")
        print(f"  ... 計 {len(rows)} アカウント")
        print(f"\n新コードの桁数: すべて4桁（1000-9999）/ 先頭ゼロなし")
        print("本実行するには --execute を付けてください。")
        return

    # ── 本実行：まずバックアップ ──────────────────────────────
    backup_path = f"{OUTDIR}/hospital-users-backup-{stamp}.json"
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=2, default=str)
    print(f"✅ バックアップ: {backup_path}")

    # ── 書き換え ──────────────────────────────────────────────
    done = fail = 0
    failures = []
    for r in rows:
        uid, new_login = r["uid"], r["新ID"]
        new_email = f"{new_login}@{DOMAIN}"
        try:
            # 認証（メール＝ログインID、パスワード＝ログインID）
            auth.update_user(uid, email=new_email, password=new_login)
            # Firestore
            db.collection("users").document(uid).set({
                "loginId":    new_login,
                "hospitalId": r["新コード"],
                "email":      new_email,
            }, merge=True)
            done += 1
        except Exception as e:
            fail += 1
            failures.append((r["旧ID"], new_login, str(e)))
            print(f"  [FAIL] {r['旧ID']} -> {new_login}: {e}")

    print(f"\n完了: 更新 {done} / 失敗 {fail}")
    if failures:
        print("⚠ 失敗した分は旧IDのままです。バックアップJSONと突き合わせてください。")

    # ── 配布用CSV ─────────────────────────────────────────────
    csv_path = f"{OUTDIR}/hospital-login-ids-{stamp}.csv"
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["病院名", "エリア", "新ID", "パスワード", "担当者名", "旧ID"],
                           extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"✅ 配布用CSV: {csv_path}")

    # ── 検証 ──────────────────────────────────────────────────
    print("\n=== 検証 ===")
    after = [dict(d.to_dict(), uid=d.id)
             for d in db.collection("users").where("role", "==", "hospital").stream()]
    ok_fmt = sum(bool(re.fullmatch(r"\d{4}-\d{2}", u.get("loginId", ""))) for u in after)
    codes  = {u.get("hospitalId") for u in after}
    ok_mail = sum(u.get("email") == f"{u.get('loginId')}@{DOMAIN}" for u in after)
    print(f"  loginId が 4桁-2桁 形式: {ok_fmt}/{len(after)} {'✅' if ok_fmt == len(after) else '❌'}")
    print(f"  病院コードが4桁ユニーク: {len(codes)}種 {'✅' if all(re.fullmatch(r'\d{4}', c or '') for c in codes) else '❌'}")
    print(f"  email と loginId が一致: {ok_mail}/{len(after)} {'✅' if ok_mail == len(after) else '❌'}")

if __name__ == "__main__":
    main()
