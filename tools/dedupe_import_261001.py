# 261001 取り込み候補を既存データ（本番 Firestore）と表記ゆれを吸収して照合し、
# 「新規として取り込む分」だけを kaigo-import-data-261001*.js に残す。除外理由は dedupe-report-261001.md に書く。
# 判定：住所を正規化（全角→半角、丁目/番/号→ハイフン、建物名は無視）して同じ ＆ 種別も同じ → 既存と同一（除外）
#       住所が同じで種別が違う → 同じ建物の別サービス（取り込む）
#       名前の中身（施設種別の語を除いた部分）が同じ ＆ 種別も市も同じ ＆ 住所が違う → 同一施設の住所違いの疑い（除外・要確認）
import json, re, sys, unicodedata, pathlib, time, urllib.request, urllib.parse

KANJI = {'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10'}
TYPE_WORDS = ['介護付有料老人ホーム','住宅型有料老人ホーム','有料老人ホーム','サービス付き高齢者向け住宅','サ高住','地域密着型特別養護老人ホーム','特別養護老人ホーム','介護老人福祉施設','介護老人保健施設','認知症高齢者グループホーム','認知症対応型共同生活介護','グループホーム','社会福祉法人','医療法人','株式会社']

def norm_addr(a):
    s = unicodedata.normalize('NFKC', a or '')
    s = re.sub(r'[\s　]', '', s)
    s = re.sub(r'([一二三四五六七八九十])(?=丁目)', lambda m: KANJI[m.group(1)], s)
    s = re.sub(r'(\d+)丁目', r'\1-', s)
    s = re.sub(r'(\d+)番地?', r'\1-', s)
    s = re.sub(r'(\d+)号', r'\1', s)
    s = s.replace('の', '-')
    m = re.match(r'^(.*?[^\d-])(\d+(?:-\d+)*)', s)   # 町名＋先頭の番地列（建物名・部屋番号は見ない）
    if not m:
        return s, ''
    nums = [x for x in m.group(2).split('-') if x][:3]
    return m.group(1), '-'.join(nums)

def core_name(n):
    s = unicodedata.normalize('NFKC', n or '')
    s = re.sub(r'[\s　]', '', s).replace('〜', '~').replace('～', '~')
    for w in TYPE_WORDS:
        s = s.replace(w, '')
    return s

def main():
    cfg = json.load(open(pathlib.Path.home()/'.config/configstore/firebase-tools.json'))
    tok = cfg['tokens']; access = tok.get('access_token')
    if not access or tok.get('expires_at', 0)/1000 < time.time() + 60:
        body = urllib.parse.urlencode({'client_id':'563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com','client_secret':'j9iVZfS8kkCEFUPaAeJV0sAi','refresh_token':tok['refresh_token'],'grant_type':'refresh_token'}).encode()
        access = json.load(urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token', body)))['access_token']
    base = 'https://firestore.googleapis.com/v1/projects/kaigo-link-dev-59bc5/databases/(default)/documents'
    req = urllib.request.Request(base+':runQuery', data=json.dumps({'structuredQuery':{'from':[{'collectionId':'facilities'}],'select':{'fields':[{'fieldPath':f} for f in ('name','address','city','type')]}}}).encode(), headers={'Authorization':'Bearer '+access,'Content-Type':'application/json'})
    live = [{k:v.get('stringValue','') for k,v in r['document']['fields'].items()} | {'id': r['document']['name'].split('/')[-1]} for r in json.load(urllib.request.urlopen(req)) if 'document' in r]
    by_addr, by_core = {}, {}
    for d in live:
        d['na'] = norm_addr(d['address']); d['core'] = core_name(d['name'])
        by_addr.setdefault(d['na'], []).append(d); by_core.setdefault((d['core'], d['city']), []).append(d)

    files = sorted(pathlib.Path('tools').glob('kaigo-import-data-261001*.js'))
    report = ['# 261001 北摂エリア追加施設の照合結果', '', f'既存 {len(live)}件と照合。', '']
    keep_total = skip_total = 0
    for f in files:
        raw = f.read_text(encoding='utf-8')
        head = raw[:raw.index('window.')]
        var = re.search(r'window\.(\w+)', raw).group(1)
        src = json.loads(re.search(r'=\s*(\[.*\])\s*;\s*$', raw, re.S).group(1))
        keep, rows = [], []
        for x in src:
            na, core = norm_addr(x['address']), core_name(x['name'])
            same_addr = by_addr.get(na, [])
            dup = [d for d in same_addr if d['type'] == x['type']]
            if dup:
                rows.append(('除外', x, dup[0], '住所・種別が同じ（表記違い）')); continue
            samename = [d for d in by_core.get((core, x['city']), []) if d['type'] == x['type']]
            # 町名まで違えば別の建物（例：ふるる＝小曽根と浜の2号館）とみなして取り込む。町名が同じで番地だけ違うものは同一施設の表記違いとして除外
            if samename and any(d['na'][0] == na[0] for d in samename):
                rows.append(('除外・要確認', x, next(d for d in samename if d['na'][0] == na[0]), '名前・種別・市・町名が同じで番地の表記が違う')); continue
            if samename:
                rows.append(('取り込む', x, None, '同名の既存施設あり（町名が違うので別の建物と判断）: ' + '／'.join(f"{d['name']}（{d['address']}）" for d in samename))); keep.append(x); continue
            note = '同住所に別種別の既存施設あり: ' + '／'.join(d['name'] for d in same_addr) if same_addr else ''
            rows.append(('取り込む', x, None, note)); keep.append(x)
        f.write_text(head + f'window.{var} = ' + json.dumps(keep, ensure_ascii=False) + ';\n', encoding='utf-8')
        keep_total += len(keep); skip_total += len(src) - len(keep)
        report += [f'## {f.name}: {len(src)}件中 {len(keep)}件を取り込み、{len(src)-len(keep)}件を除外', '', '| 判定 | 追加候補 | 既存 | 理由・備考 |', '|---|---|---|---|']
        for st, x, d, why in rows:
            report.append(f"| {st} | {x['name']}（{x['type']}・{x['address']}） | {d['name'] + '（' + d['address'] + '）' if d else '—'} | {why} |")
        report.append('')
        print(f'{f.name}: 取り込む {len(keep)} / 除外 {len(src)-len(keep)}')
    pathlib.Path('tools/dedupe-report-261001.md').write_text('\n'.join(report), encoding='utf-8')
    print(f'合計: 取り込む {keep_total} / 除外 {skip_total} → tools/dedupe-report-261001.md')

if __name__ == '__main__':
    main()
