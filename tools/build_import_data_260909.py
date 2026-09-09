# 260909 兵庫3市（伊丹・川西・宝塚）データ追加版: Desktopのxlsxから kaigo-import-data-260909.js を生成する。
# 形式は260723版（11列）と同一。違いは住所が「兵庫県」始まりで prefecture='兵庫県' になる点のみ。
# 生成物は kaigo-xlsx-import-260909.html から window.NEW_FACILITIES_260909 として読み込まれる。
import json
import re
import openpyxl

TYPE_MAP = {
    '介護付': '介護付有料',
    '住宅型': '住宅型有料',
    'GH': 'グループホーム',
    'サ高住': 'サ高住',
    '特養': '特養',
    '老健': '老健',
}

CITY_FILES = [
    ('伊丹市', '/Users/yugo/Desktop/伊丹市の介護施設データ.xlsx'),
    ('川西市', '/Users/yugo/Desktop/川西市介護施設.xlsx'),
    ('宝塚市', '/Users/yugo/Desktop/宝塚市の介護施設データ.xlsx'),
]

PREFECTURE = '兵庫県'

ACCESS_RE = re.compile(
    r'^(?P<line>.+?)[　 ](?P<station>.+?)駅(?P<sep>〜|発・)(?P<distword>徒歩|バス)約?(?P<mins>\d+)?分.*$'
)


def parse_address(raw):
    lines = [l.strip() for l in str(raw).split('\n') if l.strip()]
    if lines and lines[0].startswith('〒'):
        lines = lines[1:]
    addr = ''.join(lines)
    if addr.startswith(PREFECTURE):
        addr = addr[len(PREFECTURE):]
    return addr


def parse_access(raw):
    if not raw:
        return None, None, None, []
    stations = []
    for line in str(raw).split('\n'):
        line = line.strip()
        if not line:
            continue
        m = ACCESS_RE.match(line)
        if not m:
            raise ValueError(f'unparsed access line: {line!r}')
        station_line = m.group('line')
        station_name = m.group('station')
        distword = m.group('distword')
        mins = m.group('mins')
        if distword == '徒歩':
            dist_text = f'徒歩約{mins}分' if mins else '徒歩約'
            entry = {'line': station_line, 'name': station_name, 'walk': int(mins)} if mins else {'line': station_line, 'name': station_name}
        else:
            dist_text = f'バス約{mins}分' if mins else 'バス約'
            entry = {'line': station_line, 'name': station_name}
        stations.append({'entry': entry, 'dist_text': dist_text})
    first = stations[0]
    return (
        first['entry']['line'],
        first['entry']['name'],
        first['dist_text'],
        [s['entry'] for s in stations],
    )


def main():
    facilities = []
    warnings = []
    for city, path in CITY_FILES:
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb.worksheets[0]
        count = 0
        for row in ws.iter_rows(min_row=2, values_only=True):
            if row[1] is None:
                continue
            no, name, ftype, addr_raw, access_raw, init_total, rent, meal, mgmt, monthly_total, notes = row
            name = str(name).strip()
            addr = parse_address(addr_raw)
            if not addr.startswith(city):
                warnings.append(f'{name}: 住所が{city}で始まらない → {addr[:20]}')
            if ftype not in TYPE_MAP:
                raise ValueError(f'unknown type {ftype!r} for {name}')
            station_line, station, station_dist, stations = parse_access(access_raw)

            rent_i, meal_i, mgmt_i = int(rent or 0), int(meal or 0), int(mgmt or 0)
            if monthly_total is not None and int(monthly_total) != rent_i + meal_i + mgmt_i:
                warnings.append(f'{name}: 月額合計{int(monthly_total)} != 家賃{rent_i}+食費{meal_i}+管理費{mgmt_i}')

            rec = {
                'name': name,
                'type': TYPE_MAP[ftype],
                'prefecture': PREFECTURE,
                'city': city,
                'address': addr,
            }
            if station_line:
                rec['stationLine'] = station_line
                rec['station'] = station
                rec['stationDistance'] = station_dist
                rec['stations'] = stations
            rec['rent'] = rent_i
            rec['mealFee'] = meal_i
            rec['managementFee'] = mgmt_i
            init_total = int(init_total or 0)
            rec['initialFee'] = init_total > 0
            if init_total > 0:
                rec['initialFeeAmount'] = init_total
            rec['feeNotes'] = (notes or '').strip()
            facilities.append(rec)
            count += 1
        print(f'{city}: {count}件')

    names = [f['name'] + '|' + f['address'] for f in facilities]
    dups = {n for n in names if names.count(n) > 1}
    if dups:
        warnings.append(f'重複疑い: {dups}')

    print(f'total facilities: {len(facilities)}')
    for w in warnings:
        print('WARN:', w)

    out_path = 'tools/kaigo-import-data-260909.js'
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('// 260909 兵庫3市（伊丹・川西・宝塚）→ Firestore facilities 追加分\n')
        f.write('// Excel 3ファイルから生成。金額はすべて【円】。種別は kaigo-search.html の TYPES に合わせて正規化済み。\n')
        f.write('// 初期費用は「初期費用合計」1本を initialFeeAmount に格納（260723版と同じ方針）。\n')
        f.write('window.NEW_FACILITIES_260909 = ')
        json.dump(facilities, f, ensure_ascii=False)
        f.write(';\n')
    print('wrote', out_path)


if __name__ == '__main__':
    main()
