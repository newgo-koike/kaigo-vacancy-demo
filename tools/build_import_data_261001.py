# 261001 北摂エリア追加施設（兵頭さん提供 Excel 1ファイル・複数市混在）から取り込みデータを生成する。
# 形式は260723版（11列）と同一。違いは市・府県を住所から決める点（大阪府と兵庫県が混在し、
# kaigo_add_area.py が1ファイル1府県の前提なので、府県ごとに別ファイルに分けて書き出す）。
import json
import re
import sys
import openpyxl

SRC = '/Users/yugo/Downloads/北摂エリア追加施設_介護情報リスト (2).xlsx'
TAG = '261001'
TYPE_MAP = {'介護付': '介護付有料', '住宅型': '住宅型有料', 'GH': 'グループホーム', 'サ高住': 'サ高住', '特養': '特養', '老健': '老健'}
PREFS = ('大阪府', '兵庫県', '京都府')
# 大阪市は区までを city にする（2026-09-11 の運用ルール）
CITY_RE = re.compile(r'^(大阪市[^\d０-９\s　]+?区|[^\d０-９\s　]+?市|[^\d０-９\s　]+?郡[^\d０-９\s　]+?町)')
ACCESS_RE = re.compile(r'^(?P<line>.+?)[　 ](?P<station>.+?)駅(?P<sep>〜|発・|より|から)?(?P<distword>徒歩|バス|車)約?(?P<mins>\d+)?分.*$')


def parse_address(raw):
    lines = [l.strip() for l in str(raw).split('\n') if l.strip()]
    if lines and lines[0].startswith('〒'):
        lines = lines[1:]
    addr = ''.join(lines)
    pref = next((p for p in PREFS if addr.startswith(p)), None)
    if not pref:
        raise ValueError(f'府県が分からない住所: {addr!r}')
    addr = addr[len(pref):]
    m = CITY_RE.match(addr)
    if not m:
        raise ValueError(f'市が分からない住所: {addr!r}')
    return pref, m.group(1), addr


def parse_access(raw, warnings, name):
    if not raw:
        return None, None, None, []
    stations = []
    for line in str(raw).split('\n'):
        line = line.strip()
        if not line:
            continue
        m = ACCESS_RE.match(line)
        if not m:
            warnings.append(f'{name}: アクセスを読めない行（駅情報なしで登録）→ {line!r}')
            continue
        mins = m.group('mins')
        if m.group('distword') == '徒歩':
            dist_text = f'徒歩約{mins}分' if mins else '徒歩'
            entry = {'line': m.group('line'), 'name': m.group('station'), 'walk': int(mins)} if mins else {'line': m.group('line'), 'name': m.group('station')}
        else:
            word = m.group('distword')
            dist_text = f'{word}約{mins}分' if mins else word
            entry = {'line': m.group('line'), 'name': m.group('station')}
        stations.append({'entry': entry, 'dist_text': dist_text})
    if not stations:
        return None, None, None, []
    first = stations[0]
    return first['entry']['line'], first['entry']['name'], first['dist_text'], [s['entry'] for s in stations]


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    ws = wb.worksheets[0]
    facilities, warnings = [], []
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row[1] is None:
            continue
        no, name, ftype, addr_raw, access_raw, init_total, rent, meal, mgmt, monthly_total, notes = row[:11]
        name = re.sub(r'\s+', ' ', str(name)).strip()
        pref, city, addr = parse_address(addr_raw)
        if ftype not in TYPE_MAP:
            raise ValueError(f'unknown type {ftype!r} for {name}')
        station_line, station, station_dist, stations = parse_access(access_raw, warnings, name)
        rent_i, meal_i, mgmt_i = int(rent or 0), int(meal or 0), int(mgmt or 0)
        if monthly_total is not None and int(monthly_total) != rent_i + meal_i + mgmt_i:
            warnings.append(f'{name}: 月額合計{int(monthly_total)} != 家賃{rent_i}+食費{meal_i}+管理費{mgmt_i}')
        rec = {'name': name, 'type': TYPE_MAP[ftype], 'prefecture': pref, 'city': city, 'address': addr}
        if station_line:
            rec.update(stationLine=station_line, station=station, stationDistance=station_dist, stations=stations)
        rec['rent'] = rent_i
        rec['mealFee'] = meal_i
        rec['managementFee'] = mgmt_i
        init_total = int(init_total or 0)
        rec['initialFee'] = init_total > 0
        if init_total > 0:
            rec['initialFeeAmount'] = init_total
        rec['feeNotes'] = (notes or '').strip()
        facilities.append(rec)

    keys = [f['name'] + '|' + re.sub(r'[\s　]', '', f['address']) for f in facilities]
    dups = {k for k in keys if keys.count(k) > 1}
    if dups:
        warnings.append(f'ファイル内で重複: {dups}')

    by_pref = {}
    for f in facilities:
        by_pref.setdefault(f['prefecture'], []).append(f)
    for i, (pref, items) in enumerate(sorted(by_pref.items(), key=lambda kv: -len(kv[1]))):   # 件数の多い府県を無印に
        suffix = '' if i == 0 else 'b'
        out_path = f'tools/kaigo-import-data-{TAG}{suffix}.js'
        cities = {}
        for f in items:
            cities[f['city']] = cities.get(f['city'], 0) + 1
        with open(out_path, 'w', encoding='utf-8') as fo:
            fo.write(f'// {TAG}{suffix} 北摂エリア追加施設（{pref}：{"・".join(f"{c}{n}" for c, n in sorted(cities.items()))}）→ Firestore facilities 追加分\n')
            fo.write('// 兵頭さん提供の Excel（北摂エリア追加施設_介護情報リスト）から生成。金額は【円】。種別は TYPES に合わせて正規化済み。\n')
            fo.write(f'window.NEW_FACILITIES_{TAG}{suffix} = ')
            json.dump(items, fo, ensure_ascii=False)
            fo.write(';\n')
        print(f'wrote {out_path}: {pref} {len(items)}件 {cities}')
    print(f'total: {len(facilities)}件')
    for w in warnings:
        print('WARN:', w)


if __name__ == '__main__':
    main()
