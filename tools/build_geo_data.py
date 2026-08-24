"""施設住所を国土地理院APIでジオコーディングして public/kaigo-geo-data.js を生成する。

使い方:
  python3 tools/build_geo_data.py

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
    src_file = sorted(glob.glob("tools/kaigo-import-data-*.js"))[-1]
    raw = io.open(src_file, encoding="utf-8").read()
    m = re.search(r"window\.\w+\s*=\s*(\[.*\])\s*;?\s*$", raw, re.S)
    data = json.loads(m.group(1))
    print(f"入力: {src_file} / {len(data)}件")

    geo, fails = {}, []
    for i, d in enumerate(data):
        addr = norm(d.get("address"))
        if not addr or addr in geo:
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
    print(f"出力: public/kaigo-geo-data.js（{len(geo)}住所）")
    if fails:
        print(f"ジオコーディング失敗 {len(fails)}件:")
        for f in fails:
            print("  -", f)

if __name__ == "__main__":
    main()
