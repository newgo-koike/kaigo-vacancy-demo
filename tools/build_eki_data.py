"""近畿4府県（大阪・兵庫・京都・奈良）の駅座標マスター public/kaigo-eki-data.js を生成する。

使い方:
  python3 tools/build_eki_data.py                    # Overpass APIから取得
  python3 tools/build_eki_data.py <raw.json>         # 取得済みの生JSONから生成（Overpassは連投で504になりやすい）

データ源: OpenStreetMap（Overpass API・無料）。railway=station/halt のノードを取得する。
最寄駅検索の「車で約15分圏」判定はこのマスターを最優先で引き、無い駅名のみ
HeartRails APIに問い合わせる（2026-09-09にHeartRailsが502で全面停止し、外部API
依存の危うさが露呈したため静的マスター方式に切り替えた）。

駅名は「駅」なし表記・空白除去で正規化して格納する（kaigo-search.html の normEki と同じ規則）。
同名駅は座標を配列で全部持つ（検索側が施設ごとに最小距離を取るので同名遠方駅は無害）。
"""
import json, re, urllib.request, urllib.parse

QUERY = '[out:json][timeout:60];area["ISO3166-2"~"^JP-(26|27|28|29)$"]->.a;node["railway"~"^(station|halt)$"](area.a);out;'

def norm(s):
    return re.sub(r"[\s　]+", "", s or "").rstrip()

def main():
    import sys
    if len(sys.argv) > 1:
        els = json.load(open(sys.argv[1]))["elements"]
    else:
        req = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=("data=" + urllib.parse.quote(QUERY)).encode(),
            headers={"User-Agent": "kaigo-vacancy-demo/1.0"})
        with urllib.request.urlopen(req, timeout=120) as r:
            els = json.load(r)["elements"]

    eki = {}
    for e in els:
        name = norm(e.get("tags", {}).get("name", ""))
        if name.endswith("駅"):
            name = name[:-1]
        if not name:
            continue
        pt = [round(e["lat"], 5), round(e["lng"] if "lng" in e else e["lon"], 5)]
        pts = eki.setdefault(name, [])
        # 同一駅の重複ノード（出口・ホーム別など）は300m以内なら1点に集約
        if not any(abs(p[0]-pt[0]) < 0.003 and abs(p[1]-pt[1]) < 0.003 for p in pts):
            pts.append(pt)

    # 施設データ・利用者の表記とOSM表記のズレを別名で吸収する
    # （JR茨木=通称でOSMは「茨木」、鶯の森はOSMが異体字「鴬の森」）
    ALIASES = {"JR茨木": "茨木", "鶯の森": "鴬の森"}
    for alias, real in ALIASES.items():
        if real in eki and alias not in eki:
            eki[alias] = eki[real]

    out = "// tools/build_eki_data.py が生成（OpenStreetMap由来）。手で編集しない。\n"
    out += "// 駅名（「駅」なし・空白除去）→ [[緯度,経度],...]。同名駅は全座標を持つ。\n"
    out += "window.KAIGO_EKI = " + json.dumps(eki, ensure_ascii=False, separators=(",", ":")) + ";\n"
    with open("public/kaigo-eki-data.js", "w", encoding="utf-8") as f:
        f.write(out)
    print(f"駅数: {len(eki)} / ファイルサイズ: {len(out.encode())/1024:.0f}KB")

if __name__ == "__main__":
    main()
