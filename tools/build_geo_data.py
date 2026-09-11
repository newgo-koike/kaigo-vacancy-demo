"""施設住所を国土地理院APIでジオコーディングして public/kaigo-geo-data.js を生成する。

使い方:
  python3 tools/build_geo_data.py            # 新規住所だけGSIに問い合わせ（既存座標は再利用）
  python3 tools/build_geo_data.py --refresh  # 全住所を取り直す

入力: tools/kaigo-import-data-*.js の最新ファイル（window.NEW_FACILITIES_*）
出力: public/kaigo-geo-data.js — window.KAIGO_GEO = { "住所(空白除去)": [lat, lng], ... }

施設データを再インポートしたら、このスクリプトも再実行して座標を作り直すこと。
座標が無い施設は「最寄駅から検索」の距離判定から漏れる（登録駅の一致では出る）。
"""
import glob, io, json, re, sys, time, urllib.parse, urllib.request

BASE = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="

def norm(addr):
    return re.sub(r"[\s　]", "", addr or "")

def geocode(q):
    url = BASE + urllib.parse.quote(q)
    with urllib.request.urlopen(url, timeout=15) as r:
        hits = json.load(r)
    if not hits:
        return None
    lng, lat = hits[0]["geometry"]["coordinates"]
    return [round(lat, 6), round(lng, 6)], hits[0]["properties"]["title"]

def main():
    # すべての取り込みデータを統合する（260723=大阪5市、260909=兵庫3市…とエリアが分かれているため、
    # 最新ファイルだけ読むと他エリアの座標が失われる）。同一住所は後のファイルが優先。
    data, seen = [], set()
    for src_file in sorted(glob.glob("tools/kaigo-import-data-*.js")):
        raw = io.open(src_file, encoding="utf-8").read()
        m = re.search(r"window\.\w+\s*=\s*(\[.*\])\s*;?\s*$", raw, re.S)
        part = json.loads(m.group(1))
        print(f"入力: {src_file} / {len(part)}件")
        data.extend(part)
    print(f"統合: {len(data)}件")

    # 既に座標化済みの住所は前回の出力から再利用する（毎回全件をGSIに問い合わせると
    # 1,000住所超で6分以上かかり、途中の一時障害で失敗しやすい）。--refresh で全件やり直し。
    cache = {}
    if "--refresh" not in sys.argv:
        try:
            prev = io.open("public/kaigo-geo-data.js", encoding="utf-8").read()
            m = re.search(r"window\.KAIGO_GEO\s*=\s*(\{.*\})\s*;", prev, re.S)
            cache = json.loads(m.group(1)) if m else {}
        except Exception:
            cache = {}
    reused = 0
    geo, fails = {}, []
    for i, d in enumerate(data):
        addr = norm(d.get("address"))
        if not addr or addr in geo:
            continue
        if addr in cache:
            geo[addr] = cache[addr]
            reused += 1
            continue
        pref = d.get("prefecture") or ""
        q = addr if addr.startswith(pref) else pref + addr
        try:
            res = geocode(q)
        except Exception as e:
            res = None
        if res is None:
            # 番地で見つからないときは丁目までに落として再試行
            short = re.sub(r"(丁目).*$", r"\1", q)
            try:
                res = geocode(short) if short != q else None
            except Exception:
                res = None
        if res:
            geo[addr] = res[0]
        else:
            fails.append(q)
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(data)} ...")
        time.sleep(0.12)   # 国土地理院APIへの礼儀

    out = "// tools/build_geo_data.py が生成。手で編集しない。\n"
    out += "// 施設住所（空白除去）→ [緯度, 経度]。再インポート後は必ず再生成すること。\n"
    out += "window.KAIGO_GEO = " + json.dumps(geo, ensure_ascii=False, separators=(",", ":")) + ";\n"
    io.open("public/kaigo-geo-data.js", "w", encoding="utf-8").write(out)
    print(f"出力: public/kaigo-geo-data.js（{len(geo)}住所 / 再利用 {reused} / 新規取得 {len(geo) - reused}）")
    if fails:
        print(f"ジオコーディング失敗 {len(fails)}件:")
        for f in fails:
            print("  -", f)

if __name__ == "__main__":
    main()
