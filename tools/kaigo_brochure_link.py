"""Storage を使わずに、URLで指すPDF（Hosting 直置き・Google Drive 共有リンク等）を施設のパンフレットとして登録・解除する。

通常の登録は管理画面のドロップ（Storage）で行う。これは Storage が使えない間の暫定登録や、外部URLのPDFを載せたいときに使う。
施設ドキュメント facilities/<id>.brochures と索引 meta/brochures の両方を同時更新する（kaigo-brochure.js と同じ形）。

使い方（リポジトリ直下で）:
  tools/venv/bin/python tools/kaigo_brochure_link.py show   <施設ID>
  tools/venv/bin/python tools/kaigo_brochure_link.py add    <施設ID> <URL> --name "パンフレット.pdf" [--size バイト数]
  tools/venv/bin/python tools/kaigo_brochure_link.py remove <施設ID> <URL>

事前に: gcloud auth application-default login → set-quota-project kaigo-link-dev-59bc5
"""
import argparse
import os
import sys
from datetime import datetime, timezone

os.environ.setdefault("GRPC_DNS_RESOLVER", "native")

import firebase_admin
from firebase_admin import firestore

firebase_admin.initialize_app(options={"projectId": "kaigo-link-dev-59bc5"})
db = firestore.client()
INDEX = db.collection("meta").document("brochures")


def current(fid):
    snap = db.collection("facilities").document(fid).get()
    if not snap.exists:
        sys.exit(f"NG: 施設が見つかりません: {fid}")
    d = snap.to_dict()
    arr = [b for b in (d.get("brochures") or []) if isinstance(b, dict) and (b.get("path") or b.get("url"))]
    return d, arr


def show(fid):
    d, arr = current(fid)
    print(f"{fid}: {d.get('name')} / PDF {len(arr)}件")
    for b in arr:
        print("  -", b.get("name"), b.get("url") or b.get("path"), b.get("size"))
    return arr


def write(fid, arr):
    batch = db.batch()
    batch.update(db.collection("facilities").document(fid), {"brochures": arr})
    batch.set(INDEX, {fid: arr}, merge=True)
    batch.commit()


def add(fid, url, name, size):
    d, arr = current(fid)
    if any((b.get("url") or b.get("path")) == url for b in arr):
        sys.exit("NG: 同じURLが登録済みです")
    arr.append({"name": name, "url": url, "size": size, "at": datetime.now(timezone.utc)})
    write(fid, arr)
    print(f"登録: {d.get('name')} に「{name}」を追加（計{len(arr)}件）")
    show(fid)


def remove(fid, url):
    d, arr = current(fid)
    rest = [b for b in arr if (b.get("url") or b.get("path")) != url]
    if len(rest) == len(arr):
        sys.exit("NG: そのURLは登録されていません")
    write(fid, rest)
    print(f"解除: {d.get('name')} から外しました（残り{len(rest)}件）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["show", "add", "remove"])
    ap.add_argument("fid")
    ap.add_argument("url", nargs="?")
    ap.add_argument("--name")
    ap.add_argument("--size", type=int, default=None)
    a = ap.parse_args()
    if a.cmd == "show":
        show(a.fid)
    elif a.cmd == "add":
        if not a.url or not a.name:
            sys.exit("add には URL と --name が必要です")
        add(a.fid, a.url, a.name, a.size)
    else:
        if not a.url:
            sys.exit("remove には URL が必要です")
        remove(a.fid, a.url)
