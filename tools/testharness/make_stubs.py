"""public/ の3ページから、Firebase SDK を fake-firebase.js に差し替えた検証用ページを tools/testharness/dist/ に作る。"""
import re, shutil, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
PUB, HERE, DIST = ROOT / "public", pathlib.Path(__file__).resolve().parent, pathlib.Path(__file__).resolve().parent / "dist"
DIST.mkdir(exist_ok=True)
for src, dst in [("kaigo-search.html", "search-test.html"), ("kaigo-consult.html", "consult-test.html"), ("kaigo-master.html", "master-test.html"), ("kaigo-login.html", "login-test.html"), ("kaigo-hospital-members.html", "members-test.html")]:
    html = (PUB / src).read_text(encoding="utf-8")
    tags = re.findall(r'<script[^>]*gstatic\.com/firebasejs[^>]*></script>\s*', html)
    html = html.replace(tags[0], '<script src="fake-firebase.js"></script>\n', 1)
    for t in tags[1:]:
        html = html.replace(t, '', 1)
    (DIST / dst).write_text(html, encoding="utf-8")
    (DIST / src).write_text(html, encoding="utf-8")   # ページ間のリンク（kaigo-search.html 等）がそのまま動くよう、本来の名前でも置く
for f in ["kaigo-consult.js", "kaigo-brochure.js", "kaigo-print.js", "kaigo-facilities.json", "kaigo-geo-data.js", "kaigo-eki-data.js", "kaigo-cost-data.js", "logo.png"]:
    if (PUB / f).exists():
        shutil.copy(PUB / f, DIST / f)
shutil.copy(HERE / "fake-firebase.js", DIST / "fake-firebase.js")
print("stubs:", ", ".join(p.name for p in sorted(DIST.iterdir())))
