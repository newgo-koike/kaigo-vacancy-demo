"""エリア追加データを Firestore facilities に「追加のみ」で取り込む汎用スクリプト。

260909（兵庫3市）の取り込みで使った4段方式を、データファイルを引数に取る形に汎用化した。
update / delete のコードパス自体を持たない（追加専用）。対象の市・件数・府県は
データファイルから自動で導出する。

使い方（リポジトリ直下で、この順に1ステップずつ）:
  python tools/kaigo_add_area.py backup tools/kaigo-import-data-XXXXXX.js
  python tools/kaigo_add_area.py dryrun tools/kaigo-import-data-XXXXXX.js
  python tools/kaigo_add_area.py apply  tools/kaigo-import-data-XXXXXX.js
  python tools/kaigo_add_area.py verify tools/kaigo-import-data-XXXXXX.js
  末尾に --append を付けると「既存の市への追記」モード（2026-10-01 北摂追加分から）。
  既定は新しい市を丸ごと追加するモードで、対象市に既存ドキュメントがあれば止まる。
  どちらのモードでも、名前＋住所の一致に加えて、住所の表記ゆれ（全角・漢数字の丁目・番・号）を
  吸収した上で「住所と種別が同じ」ものは重複として止める（ロ・スカーロあおまだにの二重登録の再発防止）。

事前に: gcloud auth application-default login → set-quota-project kaigo-link-dev-59bc5
実行環境: firebase-admin 入りの venv（無ければ python3 -m venv venv && venv/bin/pip install firebase-admin）
"""
import json
import os
import re
import sys
import unicodedata

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


def cmd_backup(js_path, append=False):
    docs = [{"id": d.id, "data": d.to_dict()} for d in db.collection("facilities").stream()]
    out = backup_path(js_path)
    json.dump(docs, open(out, "w", encoding="utf-8"), ensure_ascii=False, default=str)
    by_pref = {}
    for d in docs:
        p = d["data"].get("prefecture", "?")
        by_pref[p] = by_pref.get(p, 0) + 1
    print(f"バックアップ: {len(docs)}件 → {out}")
    print("府県別:", by_pref)


KANJI_NUM = {'一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10'}


def norm_addr(a):
    """住所を比較用に揃える：全角→半角、「三丁目4番5号」→「3-4-5」、建物名・部屋番号は見ない。(町名, 番地列) を返す"""
    s = unicodedata.normalize("NFKC", a or "")
    s = re.sub(r"[\s　]", "", s)
    s = re.sub(r"([一二三四五六七八九十])(?=丁目)", lambda m: KANJI_NUM[m.group(1)], s)
    s = re.sub(r"(\d+)丁目", r"\1-", s)
    s = re.sub(r"(\d+)番地?", r"\1-", s)
    s = re.sub(r"(\d+)号", r"\1", s)
    s = s.replace("の", "-")
    m = re.match(r"^(.*?[^\d-])(\d+(?:-\d+)*)", s)
    if not m:
        return s, ""
    return m.group(1), "-".join([x for x in m.group(2).split("-") if x][:3])


def checks(src, cities, live, append=False):
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
    # 表記ゆれを吸収した重複（住所と種別が同じ）。名前が少し違っても同じ施設
    live_norm = {(norm_addr(d["data"].get("address")), d["data"].get("type")) for d in live}
    near = [f["name"] for f in src
            if (f["name"], norm(f.get("address"))) not in live_keys and (norm_addr(f.get("address")), f.get("type")) in live_norm]
    if near:
        errs.append(f"既存施設と住所（表記ゆれ込み）・種別が一致（二重取り込み）: {near}")
    exists = [d for d in live if d["data"].get("city") in cities]
    if exists and not append:
        errs.append(f"対象市のドキュメントが既に存在（二重取り込みの疑い）: {len(exists)}件。既存の市に足すなら --append を付ける")
    if append:
        print(f"INFO: 追記モード（対象市の既存 {len(exists)}件はそのまま。重複は名前＋住所と、表記ゆれ込みの住所＋種別で判定）")
    return errs


def plan_summary(src, cities):
    by_city = {}
    for f in src:
        by_city[f["city"]] = by_city.get(f["city"], 0) + 1
    print(f"取り込み予定: {len(src)}件 / 市別: {by_city} / 対象市: {sorted(cities)}")


def cmd_dryrun(js_path, append=False):
    src, pref, cities = load_src(js_path)
    live = json.load(open(backup_path(js_path), encoding="utf-8"))
    print(f"既存: {len(live)}件（バックアップ基準）/ 府県: {pref}")
    plan_summary(src, cities)
    print(f"計画: 追加 {len(src)} / 更新 0 / 削除 0（このスクリプトに更新・削除のコードは存在しない）")
    errs = checks(src, cities, live, append)
    if errs:
        for e in errs:
            print("NG:", e)
        sys.exit(1)
    print("OK: 全チェック合格。apply に進めます")


def cmd_apply(js_path, append=False):
    src, pref, cities = load_src(js_path)
    live = json.load(open(backup_path(js_path), encoding="utf-8"))
    errs = checks(src, cities, live, append)
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


def cmd_verify(js_path, append=False):
    src, pref, cities = load_src(js_path)
    live_before = json.load(open(backup_path(js_path), encoding="utf-8"))
    live = [{"id": d.id, "data": d.to_dict()} for d in db.collection("facilities").stream()]
    # 追加分＝バックアップに無いID（既存の市に足す追記モードでも同じ判定で済む）
    before_ids = {b["id"] for b in live_before}
    added = [d for d in live if d["id"] not in before_ids]
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
    args = [a for a in sys.argv[1:] if a != "--append"]
    if len(args) != 2 or args[0] not in cmds:
        print(__doc__)
        sys.exit(1)
    cmds[args[0]](args[1], append="--append" in sys.argv)
