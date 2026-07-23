# 260723 5市データ更新版: Desktopの介護情報リストxlsxから kaigo-import-data-260723.js を生成する。
# 生成物は kaigo-xlsx-import-260723.html から window.NEW_FACILITIES_260723 として読み込まれる。
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
    ('茨木市', '/Users/yugo/Desktop/茨木市介護情報リスト.xlsx'),
    ('吹田市', '/Users/yugo/Desktop/吹田市介護情報リスト.xlsx'),
    ('池田市', '/Users/yugo/Desktop/池田市介護情報リスト.xlsx'),
    ('箕面市', '/Users/yugo/Desktop/箕面市介護情報リスト.xlsx'),
    ('豊中市', '/Users/yugo/Desktop/豊中市介護情報リスト .xlsx'),
]

# 新ファイルで名称が「ｆ」に化けている行（旧データ・住所・種別・賃料等から同一施設と確認済み）
NAME_FIXES = {
    ('吹田市', '岸部南1-4-24'): 'メルヴェイユ吹田',
}

ACCESS_RE = re.compile(
    r'^(?P<line>.+?)[　 ](?P<station>.+?)駅(?P<sep>〜|発・)(?P<distword>徒歩|バス)約?(?P<mins>\d+)?分.*$'
)


def parse_address(raw):
    lines = [l.strip() for l in str(raw).split('\n') if l.strip()]
    if lines and lines[0].startswith('〒'):
        lines = lines[1:]
    addr = ''.join(lines)
    if addr.startswith('大阪府'):
        addr = addr[len('大阪府'):]
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
        else:  # バス
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
    name_fix_hits = []
    for city, path in CITY_FILES:
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb.worksheets[0]
        for row in ws.iter_rows(min_row=2, values_only=True):
            if row[1] is None:
                continue
            no, name, ftype, addr_raw, access_raw, init_total, rent, meal, mgmt, monthly_total, notes = row
            name = str(name).strip()
            addr = parse_address(addr_raw)

            fix_key = (city, addr[-14:] if len(addr) >= 14 else addr)
            for (fcity, faddr_frag), fixed_name in NAME_FIXES.items():
                if city == fcity and faddr_frag in addr:
                    name_fix_hits.append((name, fixed_name, addr))
                    name = fixed_name

            if ftype not in TYPE_MAP:
                raise ValueError(f'unknown type {ftype!r} for {name}')
            station_line, station, station_dist, stations = parse_access(access_raw)

            rec = {
                'name': name,
                'type': TYPE_MAP[ftype],
                'prefecture': '大阪府',
                'city': city,
                'address': addr,
            }
            if station_line:
                rec['stationLine'] = station_line
                rec['station'] = station
                rec['stationDistance'] = station_dist
                rec['stations'] = stations
            rec['rent'] = int(rent or 0)
            rec['mealFee'] = int(meal or 0)
            rec['managementFee'] = int(mgmt or 0)
            init_total = int(init_total or 0)
            rec['initialFee'] = init_total > 0
            if init_total > 0:
                rec['initialFeeAmount'] = init_total
            rec['feeNotes'] = (notes or '').strip()
            facilities.append(rec)

    print(f'total facilities: {len(facilities)}')
    print('name fixes applied:', name_fix_hits)

    out_path = '/Users/yugo/Dropbox/Obsidian/obsidian_all/YUMEMATCH/AI業務効率化/兵頭さん/介護施設関連/tools/kaigo-import-data-260723.js'
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('// 260723 介護情報リスト（茨木・吹田・池田・箕面・豊中）→ Firestore facilities\n')
        f.write('// Excel 5ファイルから生成。金額はすべて【円】。種別は kaigo-search.html の TYPES に合わせて正規化済み。\n')
        f.write('// 介護付→介護付有料 / 住宅型→住宅型有料 / GH→グループホーム\n')
        f.write('// 260712版との違い: 「入居一時金」「敷金」の内訳が廃止され「初期費用合計」1本になったため、\n')
        f.write('// 全額を initialFeeAmount に格納し depositAmount は使用しない（既存施設の古い depositAmount は取り込みツール側で自動削除される）。\n')
        f.write('window.NEW_FACILITIES_260723 = ')
        json.dump(facilities, f, ensure_ascii=False)
        f.write(';\n')
    print('wrote', out_path)


if __name__ == '__main__':
    main()
