"""チャットde介護のロゴ一式を public/brand/ と public/ のアイコンに書き出す（2026-11-06 ロゴ D 案「ふたつの吹き出し」で決定）。

文字は Zen Maru Gothic を Chrome で PDF にし、pdftocairo で輪郭（図形）にした SVG にする。
フォントの入っていない端末でも同じ形に見せるため。アイコンの PNG も Chrome のスクリーンショットで作る。
使い方: python3 tools/brand/build_brand.py
"""
import pathlib, re, subprocess, tempfile, shutil

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "brand"
PUB = ROOT / "public"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

INK, WHITE, SUB_INK, SUB_WHITE = "#2b2b2b", "#ffffff", "#6f757a", "#c3cad0"
PINK, PINK_D, BLUE = "#e88494", "#e0707f", "#5fb0de"
FONTS = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@700;900&display=swap">'

BLUE_PATH = "M14 6h22a10 10 0 0 1 10 10v8a10 10 0 0 1-10 10H18l-9 7 2-7.5A10 10 0 0 1 4 24v-8A10 10 0 0 1 14 6z"
PINK_PATH = "M28 26h22a10 10 0 0 1 10 10v8.5a10 10 0 0 1-10 10L52 62l-9-7.5H28a10 10 0 0 1-10-10V36a10 10 0 0 1 10-10z"
HEART = "M39 48s-7-4.2-7-9a3.8 3.8 0 0 1 7-2 3.8 3.8 0 0 1 7 2c0 4.8-7 9-7 9z"


def mark_svg(uid="m", size=None):
    # 重なりのすき間は白線ではなく「切り抜き」にする。黒いヘッダーの上でも縁取りに見えないように
    wh = f' width="{size}" height="{size}"' if size else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"{wh}>'
            f'<defs><mask id="{uid}-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            f'<rect width="64" height="64" fill="#fff"/><path d="{PINK_PATH}" fill="#000" stroke="#000" stroke-width="5" stroke-linejoin="round"/></mask></defs>'
            f'<g mask="url(#{uid}-cut)"><path d="{BLUE_PATH}" fill="{BLUE}"/>'
            f'<circle cx="17" cy="20" r="2" fill="#fff"/><circle cx="25" cy="20" r="2" fill="#fff"/><circle cx="33" cy="20" r="2" fill="#fff"/></g>'
            f'<path d="{PINK_PATH}" fill="{PINK}"/><path d="{HEART}" fill="#fff"/></svg>')


def text_html(color, sub_color, with_sub):
    sub = f'<div class="sub" style="color:{sub_color}">チャットで介護施設さがし</div>' if with_sub else ""
    return f"""<!doctype html><html><head><meta charset="utf-8">{FONTS}<style id="pg"></style><style>
html,body{{margin:0;padding:0;background:transparent}}
#t{{display:inline-block;font-family:'Zen Maru Gothic';line-height:1.15;padding:2px 2px 4px}}
.wm{{font-weight:900;font-size:100px;letter-spacing:.02em;white-space:nowrap;color:{color}}}
.sk{{margin:0 -.07em}} .de{{font-size:.8em;margin:0 .06em;color:{PINK_D}}}
.sub{{font-weight:700;font-size:38px;letter-spacing:.04em;white-space:nowrap;margin-top:2px}}
</style></head><body><div id="t"><div class="wm">チ<span class="sk">ャ</span><span class="sk">ッ</span>ト<span class="de">de</span>介護</div>{sub}</div>
<script>document.fonts.ready.then(()=>{{const r=document.getElementById('t').getBoundingClientRect();
document.getElementById('pg').textContent=`@page{{size:${{Math.ceil(r.width)}}px ${{Math.ceil(r.height)}}px;margin:0}}`;}});</script></body></html>"""


def outline(html, tmp, name):
    src = tmp / f"{name}.html"
    pdf = tmp / f"{name}.pdf"
    svg = tmp / f"{name}.svg"
    src.write_text(html, encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=10000",
                    f"--print-to-pdf={pdf}", src.as_uri()], check=True, capture_output=True)
    subprocess.run(["pdftocairo", "-svg", "-f", "1", "-l", "1", str(pdf), str(svg)], check=True)
    s = svg.read_text(encoding="utf-8")
    # 複数ページの形（pageSet/page）はブラウザが描かないので外す。座標は小数2桁で十分（ファイルを軽くする）
    s = re.sub(r"</?(pageSet|page)>", "", s)
    s = re.sub(r"(\d+\.\d{2})\d+", r"\1", s)
    # 同じファイルに2つ並べても id がぶつからないように接頭辞を付ける
    s = re.sub(r'id="([^"]+)"', rf'id="{name}-\1"', s)
    s = re.sub(r'(xlink:href|href)="#([^"]+)"', rf'\1="#{name}-\2"', s)
    s = re.sub(r'url\(#([^)]+)\)', rf'url(#{name}-\1)', s)
    vb = re.search(r'viewBox="([^"]+)"', s).group(1).split()
    return s, float(vb[2]), float(vb[3])


def inner(svg_text):
    body = re.search(r"<svg[^>]*>(.*)</svg>", svg_text, re.S).group(1)
    return re.sub(r'<rect[^>]*fill="rgb\(100%, ?100%, ?100%\)"[^>]*/>', "", body, count=1)


def compose(parts, w, h):
    return f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {w:.1f} {h:.1f}" width="{w:.0f}" height="{h:.0f}">{"".join(parts)}</svg>\n'


def nested(svg_text, x, y, w, h, vw, vh):
    return f'<svg x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" viewBox="0 0 {vw:.1f} {vh:.1f}" overflow="visible">{inner(svg_text)}</svg>'


def icon_png(path, px, ratio):
    with tempfile.TemporaryDirectory() as d:
        html = pathlib.Path(d) / "icon.html"
        m = round(px * ratio)
        html.write_text(f'<!doctype html><html><body style="margin:0;background:#fff;width:{px}px;height:{px}px;display:grid;place-items:center">{mark_svg("i", m)}</body></html>', encoding="utf-8")
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size={px},{px}",
                        f"--screenshot={path}", html.as_uri()], check=True, capture_output=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "chatde-mark.svg").write_text(mark_svg("mk", 64) + "\n", encoding="utf-8")
    with tempfile.TemporaryDirectory() as d:
        tmp = pathlib.Path(d)
        for suffix, color, sub_color in [("", INK, SUB_INK), ("-white", WHITE, SUB_WHITE)]:
            word, ww, wh = outline(text_html(color, sub_color, False), tmp, f"wm{suffix.replace('-', '')}")
            (OUT / f"chatde-wordmark{suffix}.svg").write_text(compose([inner(word)], ww, wh), encoding="utf-8")
            full, fw, fh = outline(text_html(color, sub_color, True), tmp, f"lk{suffix.replace('-', '')}")
            ms = fh * 0.98   # 記号の高さは文字ブロック（名前＋副題）とそろえる
            gap = ms * 0.16
            mark = nested(mark_svg(f"lk{suffix.replace('-', '')}m"), 0, (fh - ms) / 2, ms, ms, 64, 64)
            text = nested(full, ms + gap, 0, fw, fh, fw, fh)
            (OUT / f"chatde-logo{suffix}.svg").write_text(compose([mark, text], ms + gap + fw, fh), encoding="utf-8")
    # ホーム画面・通知のアイコン。iPhone は角を自動で丸めるので四角いまま、Android の maskable は丸く切られても欠けない大きさ
    icon_png(PUB / "icon-192.png", 192, 0.74)
    icon_png(PUB / "icon-512.png", 512, 0.74)
    icon_png(PUB / "apple-touch-icon.png", 180, 0.74)
    icon_png(PUB / "icon-maskable-512.png", 512, 0.58)
    icon_png(OUT / "favicon-64.png", 64, 0.92)
    for f in sorted(OUT.iterdir()):
        print(f.name, f.stat().st_size)


if __name__ == "__main__":
    main()
