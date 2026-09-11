"""エリア追加データを Firestore facilities に「追加のみ」で取り込む汎用スクリプト。

260909（兵庫3市）の取り込みで使った4段方式を、データファイルを引数に取る形に汎用化した。
update / delete のコードパス自体を持たない（追加専用）。対象の市・件数・府県は
データファイルから自動で導出する。

使い方（リポジトリ直下で、この順に1ステップずつ）:
  python tools/kaigo_add_area.py backup tools/kaigo-import-data-XXXXXX.js
  python tools/kaigo_add_area.py dryrun tools/kaigo-import-data-XXXXXX.js
  python tools/kaigo_add_area.py apply  tools/kaigo-import-data-XXXXXX.js
  python tools/kaigo_add_area.py verify tools/kaigo-import-data-XXXXXX.js

事前に: gcloud auth application-default login → set-quota-project kaigo-link-dev-59bc5
実行環境: firebase-admin 入りの venv（無ければ python3 -m venv venv && venv/bin/pip install firebase-admin）
"""
import json
import os
import re
import sys

# macOS で gRPC 標準の DNS 解決（c-ares）が Firestore への接続で無応答になることがある
# （2026-09-11 に backup 段でハング）。native 解決にすると即応答する。grpc 読み込み前に設定が必要。
os.environ.setdefault("GRPC_DNS_RESOLVER", "native")

import firebase_admin
from firebase_admin import firestore

firebase_admin.initialize_app(options={"projectId": "kaigo-link-dev-59bc5"})
db = firestore.client()


def load_src(js_path):
    raw = open(js_path, encoding="utf-8").read()
    m = re.search(r"window\.(\w+)\s*=\s*(\[.*\])\s*;\s*$", raw, re.S)
    src = json.loads(m.group(2))
    prefs = {f.get("prefecture") for f in src}
    if len(prefs) != 1:
        sys.exit(f"NG: 府県が単一でない: {prefs}")
    cities = {f.get("city") for f in src}
    return src, prefs.pop(), cities


def backup_path(js_path):
    tag = re.search(r"kaigo-import-data-(\w+)\.js", os.path.basename(js_path)).group(1)
    return f"facilities-backup-{tag}.json"


def cmd_backup(js_path):
    docs = [{"id": d.id, "data": d.to_dict()} for d in db.collection("facilities").stream()]
    out = backup_path(js_path)
    json.dump(docs, open(out, "w", encoding="utf-8"), ensure_ascii=False, default=str)
    by_pref = {}
    for d in docs:
        p = d["data"].get("prefecture", "?")
        by_pref[p] = by_pref.get(p, 0) + 1
    print(f"バックアップ: {len(docs)}件 → {out}")
    print("府県別:", by_pref)


def checks(src, cities, live):
    errs = []
    for f in src:
        for k in ("name", "address", "type", "city", "prefecture", "rent", "mealFee", "managementFee", "feeNotes"):
            if k not in f:
                errs.append(f"必須フィールド欠落 {k}: {f.get('name')}")
    # 施設の同一性は「名前＋住所」で判定する。グループホーム等は同名の別施設が普通にある
    # （例: グループホームひより＝豊中と高槻に別々に存在）ので、名前だけで止めると正当な追加を弾く
    norm = lambda s: (s or "").replace(" ", "").replace("　", "")
    live_keys = {(d["data"].get("name"), norm(d["data"].get("address"))) for d in live}
    live_names = {d["data"].get("name") for d in live}
    dup = [f["name"] for f in src if (f["name"], norm(f.get("address"))) in live_keys]
    if dup:
        errs.append(f"既存施設と名前・住所が一致（二重取り込み）: {dup}")
    homonym = [f"{f['name']}({f['city']})" for f in src
               if f["name"] in live_names and (f["name"], norm(f.get("address"))) not in live_keys]
    if homonym:
        print(f"INFO: 同名だが住所が異なる施設（別施設として追加）: {homonym}")
    exists = [d for d in live if d["data"].get("city") in cities]
    if exists:
        errs.append(f"対象市のドキュメントが既に存在（二重取り込みの疑い）: {len(exists)}件")
    return errs


def plan_summary(src, cities):
    by_city = {}
    for f in src:
        by_city[f["city"]] = by_city.get(f["city"], 0) + 1
    print(f"取り込み予定: {len(src)}件 / 市別: {by_city} / 対象市: {sorted(cities)}")


def cmd_dryrun(js_path):
    src, pref, cities = load_src(js_path)
    live = json.load(open(backup_path(js_path), encoding="utf-8"))
    print(f"既存: {len(live)}件（バックアップ基準）/ 府県: {pref}")
    plan_summary(src, cities)
    print(f"計画: 追加 {len(src)} / 更新 0 / 削除 0（このスクリプトに更新・削除のコードは存在しない）")
    errs = checks(src, cities, live)
    if errs:
        for e in errs:
            print("NG:", e)
        sys.exit(1)
    print("OK: 全チェック合格。apply に進めます")


def cmd_apply(js_path):
    src, pref, cities = load_src(js_path)
    live = json.load(open(backup_path(js_path), encoding="utf-8"))
    errs = checks(src, cities, live)
    if errs:
        for e in errs:
            print("NG:", e)
        sys.exit("中止しました（1件も書き込んでいません）")
    if len(src) > 450:
        sys.exit("NG: 450件超は1バッチに収まらない。分割方針を決めてから実行する")
    ts = firestore.SERVER_TIMESTAMP
    batch = db.batch()   # 500未満なので1バッチ＝全成功か全失敗のどちらかにしかならない
    for f in src:
        data = dict(f)
        # ブラウザ版取り込みツールの「新規」と同じ付与フィールド
        data.update({"vacancy": 0, "vacancyNotes": "", "plan": "free", "approved": True,
                     "createdAt": ts, "updatedAt": ts})
        batch.set(db.collection("facilities").document(), data)
    batch.commit()
    print(f"完了: {len(src)}件を追加しました（更新0・削除0）")


def cmd_verify(js_path):
    src, pref, cities = load_src(js_path)
    live_before = json.load(open(backup_path(js_path), encoding="utf-8"))
    live = [{"id": d.id, "data": d.to_dict()} for d in db.collection("facilities").stream()]
    added = [d for d in live if d["data"].get("city") in cities]
    by_city = {}
    for d in added:
        c = d["data"].get("city", "?")
        by_city[c] = by_city.get(c, 0) + 1
    src_by_city = {}
    for f in src:
        src_by_city[f["city"]] = src_by_city.get(f["city"], 0) + 1
    print(f"総数: {len(live_before)} → {len(live)}（期待: +{len(src)}）")
    print(f"対象市: {by_city}（期待: {src_by_city}）")
    ok = len(live) == len(live_before) + len(src) and by_city == src_by_city
    src_by_name = {f["name"]: f for f in src}
    field_ng = 0
    for d in added:
        f = src_by_name.get(d["data"].get("name"))
        if not f:
            field_ng += 1
            continue
        for k in ("address", "type", "city", "rent", "mealFee", "managementFee"):
            if d["data"].get(k) != f.get(k):
                field_ng += 1
                print(f"  相違 {d['data'].get('name')}.{k}: {d['data'].get(k)!r} != {f.get(k)!r}")
                break
        for k in ("vacancy", "plan", "approved"):
            if k not in d["data"]:
                field_ng += 1
                print(f"  付与フィールド欠落 {d['data'].get('name')}.{k}")
                break
    live_by_id = {d["id"]: d["data"] for d in live}
    touched = 0
    for b in live_before:
        cur = live_by_id.get(b["id"])
        if cur is None:
            touched += 1
            print(f"  ★既存ドキュメント消失: {b['id']} {b['data'].get('name')}")
            continue
        for k in ("name", "address", "city", "rent", "vacancy", "plan"):
            if str(cur.get(k)) != str(b["data"].get(k)):
                touched += 1
                print(f"  ★既存ドキュメント変化: {b['data'].get('name')}.{k}")
                break
    print(f"既存 {len(live_before)}件の消失・変化: {touched}件（期待: 0）")
    print("全照合合格" if ok and field_ng == 0 and touched == 0
          else f"NG: count_ok={ok} field_ng={field_ng} touched={touched}")


if __name__ == "__main__":
    cmds = {"backup": cmd_backup, "dryrun": cmd_dryrun, "apply": cmd_apply, "verify": cmd_verify}
    if len(sys.argv) != 3 or sys.argv[1] not in cmds:
        print(__doc__)
        sys.exit(1)
    cmds[sys.argv[1]](sys.argv[2])
