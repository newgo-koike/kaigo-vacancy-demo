# tools/ — 管理者用の取り込みツール（本番には公開されない）

`firebase.json` の `hosting.public` は `public/` なので、**このディレクトリはデプロイされない**。
施設データを一括で書き換える破壊的なツールを本番URLに置かないため、あえてここに分離している。

## kaigo-xlsx-import-260723.html — 介護情報リスト取り込み（260723・5市データ更新版）

`kaigo-import-data-260723.js` に埋め込んだ476件（豊中・吹田・茨木・池田・箕面）を
Firestore の `facilities` に反映する。260712版からの更新分。**2026-07-23 に実行済み**
（2026-07-27 に本番の facilities 476件を実データ照合して確認。この行は当初「未実行」のままだったが実際には反映されていた）。

260712版からの主な変更点：
- **入居時費用の内訳（入居一時金／敷金）が廃止され「初期費用合計」1本になった。** 合計額を丸ごと `initialFeeAmount` に格納し、
  旧 `depositAmount` は取り込み時に自動削除される（既存ロジックがそのまま対応：Excel側にdepositAmount列が無いので削除扱いになる）。
  施設詳細ページの内訳表示では「敷金」が一律0円になるが、合計額（＝月額目安の計算に使う値）は変わらない。
- 吹田市の1件、Excel上の名称が「ｆ」に化けていた（住所・種別・賃料等から旧データの「メルヴェイユ吹田」と同一施設と確認済み）。
  取り込みデータでは元の施設名「メルヴェイユ吹田」に補正済み（`tools/build_import_data.py` 相当のロジックで対応、施設名以外は新Excelの値をそのまま使用）。
- 費用に関する注意書き列が施設ごとの個別文言から、初期費用の有無で2パターンの定型文に統一されている（データ側の仕様変更、要修正ではない）。
  - **2026-07-27 追記（兵頭さん依頼）**：うち **特養・老健の97件（特養68／老健29・5市全て）だけ** K列の注意書きを新文言に差し替えた
    （食費の日額×30日換算・水道光熱費の扱い・負担限度額認定の段階・介護報酬改定の但し書きを追記した5行）。
    元Excel（`/Users/yugo/Desktop/*介護情報リスト.xlsx`）と本リポジトリ直下の `260727*介護情報リスト.xlsx`、
    および `kaigo-import-data-260723.js` を更新済み。**Firestoreへの反映は取り込みツールの実行が必要。**
- 豊中市の住所が3行に折り返されているセルで、旧データにあった行末の余分な空白（例：「豊中市西緑丘3-15- 10」）が解消された（28件）。
- 施設名・市の組み合わせでの照合は476件全件が旧データと1:1一致（追加0件・削除0件）。差分は上記のほかレント1件・初期費用5件の実額更新のみ。

### 使い方

```bash
# リポジトリ直下でサーバを起動（public/ と tools/ の両方が見える必要がある）
cd <このリポジトリ>
python3 -m http.server 5055

# 1) 管理者ログイン
open http://localhost:5055/public/kaigo-login.html
# 2) ツールを開く
open http://localhost:5055/tools/kaigo-xlsx-import-260723.html
```

① バックアップ → ② ドライラン → ③ 適用（**安全マージ**を推奨。リスト外0件のため完全同期との実害差はないが、
空室数・写真・プラン・連絡先等の既存入力を確実に保持できる） → ④ 検証 の順に進む。

## kaigo-xlsx-import.html — 介護情報リスト取り込み（260712・5市版）

`kaigo-import-data-260712.js` に埋め込んだ476件（豊中・吹田・茨木・池田・箕面）を
Firestore の `facilities` に反映する。2026-07-14 に実行済み（履歴として保持）。

### 使い方

```bash
# リポジトリ直下でサーバを起動（public/ と tools/ の両方が見える必要がある）
cd <このリポジトリ>
python3 -m http.server 5055

# 1) 管理者ログイン
open http://localhost:5055/public/kaigo-login.html
# 2) ツールを開く
open http://localhost:5055/tools/kaigo-xlsx-import.html
```

① バックアップ → ② ドライラン → ③ 適用 → ④ 検証 の順に進む。①を実行するまで③には進めない。

### 設計上の要点（次に触る人へ）

- **施設ドキュメントIDは維持する。** 既存施設は「施設名の完全一致」で照合して `update` する。
  削除→再作成をすると `users.facilityId`（施設ログイン）・配布済みQR・施設詳細URL・
  Cloud Storage の写真パス（`facilities/{docId}/photo.*`）が全部切れる。
- **金額は「円」で保存する。** `kaigo-register.html` / `kaigo-csv-import.html` のUIは
  「万円」ラベルだが保存は生値。読み取り側（`kaigo-search.html` の `mapDoc`）は円前提で 1/10000 する。
- **種別は検索UIの `TYPES` と完全一致させる。** `kaigo-search.html:816` が `types.includes(f.type)` で
  絞り込むため、Excelの略記（介護付 / 住宅型 / GH）はそのまま入れてはいけない。
  → `介護付有料` / `住宅型有料` / `グループホーム` に変換すること。
- **`prefecture` を明示的に入れる。** `mapDoc` の `isOsaka` フィルタで落ちる。
  Excelの住所は茨木・豊中で「大阪府」が省略されている。

### 次回、別の市を取り込むとき

`managementId`（介護事業所番号）が全件に入っているので、本来はこれを照合キーにするのが正しい。
今回は Excel 側に事業所番号の列が無かったため施設名で照合した。
Excelに事業所番号の列を足してもらえるなら、照合キーを `managementId` に変えると
施設名の表記ゆれに強くなる。

## build_geo_data.py — 施設座標データの生成（最寄駅検索・所在地地図用）

`public/kaigo-geo-data.js`（住所→座標）を国土地理院APIから生成する。
最寄駅検索の「車で約15分圏」判定と施設詳細ページの地図はこのファイルに依存する。

```bash
# リポジトリ直下で
python3 tools/build_geo_data.py
```

- 入力は `tools/kaigo-import-data-*.js` の最新ファイル。
- **施設データを再インポートしたら必ず再実行**すること。座標が無い施設は
  距離判定から漏れ（登録駅の一致では出る）、詳細ページの地図が非表示になる。
- 番地で見つからない住所は丁目までに落として再試行する。実行末尾に失敗一覧が出る。

## kaigo-xlsx-import-260909.html — 兵庫3市（伊丹・川西・宝塚）追加取り込み

180件の**追加専用**ツール（2026-09-09）。完全同期は封印してあり安全マージのみ。
照合は兵庫3市の既存ドキュメントに限定しているため、大阪5市の476件には触れない。
データ生成は `python3 tools/build_import_data_260909.py`（入力: Desktopのxlsx 3ファイル）。
使い方は260723版と同じ（リポジトリ直下で `python3 -m http.server 5055` → 管理者ログイン → ツールを開く）。

## build_eki_data.py — 駅座標マスターの生成（最寄駅検索用）

`public/kaigo-eki-data.js`（近畿4府県1,150駅・OpenStreetMap由来）を生成する。
最寄駅検索の円域判定はこのマスターを最優先で引き、無い駅名だけHeartRails APIに落ちる。

```bash
python3 tools/build_eki_data.py            # Overpass APIから取得（連投すると504になるので注意）
python3 tools/build_eki_data.py raw.json   # 取得済み生JSONから生成
```

エリアを近畿の外へ広げるときはスクリプト内の QUERY の県コードを増やして再生成する。
表記ゆれは ALIASES（JR茨木・鶯の森など）で吸収する。

※ `build_geo_data.py` は2026-09-09から**全 `kaigo-import-data-*.js` を統合**して座標化する
（最新ファイルだけだと他エリアの座標が消えるため）。エリア追加後は必ず再実行すること。

## kaigo_add_area.py — エリア追加の汎用取り込み（2026-09-11〜、推奨）

エリア追加はブラウザツールを複製せず、これ1本で行う。追加専用（更新・削除のコードパスなし）。

```bash
# リポジトリ直下で。事前に gcloud auth application-default login → set-quota-project kaigo-link-dev-59bc5
venv/bin/python tools/kaigo_add_area.py backup tools/kaigo-import-data-XXXXXX.js
venv/bin/python tools/kaigo_add_area.py dryrun tools/kaigo-import-data-XXXXXX.js
venv/bin/python tools/kaigo_add_area.py apply  tools/kaigo-import-data-XXXXXX.js   # 本番書き込み（要・人の実行）
venv/bin/python tools/kaigo_add_area.py verify tools/kaigo-import-data-XXXXXX.js
```

エリア追加の全手順: ①Excel→`build_import_data_XXXXXX.py`（既存版を複製して市とファイルパスを差し替え）
②名前衝突チェック ③`kaigo-search.html` の SHOWN_PREFS / CITY_MAP ④`build_geo_data.py` 再実行
⑤（近畿外なら）`build_eki_data.py` の QUERY 拡張 ⑥スタブ検証 ⑦kaigo_add_area.py の4段 ⑧デプロイ

## 260911b — 大阪5エリア（西淀川区・摂津市・高槻市・東淀川区・淀川区）322件（2026-09-11）

変換: `python3 tools/build_import_data_260911b.py` → `kaigo-import-data-260911b.js`（`window.NEW_FACILITIES_260911b`）。
取り込み: `kaigo_add_area.py` の4段（backup→dryrun→apply→verify）。

**大阪市の区の扱い**: `city` は「大阪市西淀川区」のように市＋区のフル表記で入れる（区ごとに絞り込めるようにするため）。
`kaigo-search.html` の CITY_MAP と mapDoc の市判定リストにも同じ表記で列挙する。mapDoc の判定リストでは
区名を「大阪市」より**前**に置くこと（先に「大阪市」が一致すると区が潰れる）。

**同一施設の判定は「名前＋住所」**（2026-09-11 に kaigo_add_area.py を厳密化）。グループホーム等は同名の別施設が
普通にある（例: グループホームひより＝豊中と高槻）。名前だけで止めると正当な追加を弾くため、
名前＋住所が一致したときだけ二重取り込みとして中止し、同名別住所は INFO 表示のうえ追加する。

**元Excelの整合警告**: 変換時に「月額合計 != 家賃+食費+管理費」が2件（グループホームみのり 350円差、
大冠カームグループホーム 500円差）。システムは内訳を保存し合計は計算表示するので取り込みには影響しない。
元データの修正は提供元（兵頭さん）に確認。

**build_geo_data.py の再利用キャッシュ（2026-09-11）**: 既存の `kaigo-geo-data.js` にある住所は再利用し、
新規住所だけGSIに問い合わせる（全件やり直しは `--refresh`）。1,000住所超で毎回6分以上かかり
一時障害で失敗しやすかったため。

## kaigo_reset_password.py — 病院のパスワード初期化（忘れた時の対応）

病院IDのメールはダミーなので再設定メールは使えない。管理者がこのスクリプトで上書きする。

```bash
# リポジトリ直下で。事前に gcloud auth application-default login → set-quota-project kaigo-link-dev-59bc5
tools/venv/bin/python tools/kaigo_reset_password.py find こだま        # 病院名・担当者名・IDの一部で検索
tools/venv/bin/python tools/kaigo_reset_password.py reset 6569-01       # 初期パスワード（=ID）に戻す
tools/venv/bin/python tools/kaigo_reset_password.py reset 6569-01 新PW  # 任意のパスワードにする
```

運用: 病院→兵頭さん→小池さんの順で連絡が来たら reset を実行し、出力された案内文をそのまま返す。
病院は再ログイン後「担当者管理」の「自分のパスワードを変更」で好きなものに変えられる。

## build_facilities_json.py — 検索用の一覧ファイル生成（無料枠対策・2026-09-15〜）

検索ページは `public/kaigo-facilities.json` を最優先で読み、Firestore の読み取りを発生させない。
本番 Firestore から生成し、デプロイで配信する。**施設データを変えたら必ず再生成＋デプロイ**
（run_add_area.sh は自動で再生成する。管理画面・施設側での個別変更後は手動で）。

```bash
tools/venv/bin/python tools/build_facilities_json.py   # 生成（要ADC）
firebase deploy --only hosting                          # 配信
```

ファイルが取れない環境では従来どおり Firestore から読む（自動フォールバック）。

## run_refresh_list.sh — 一覧ファイルの再生成＋配信を1コマンドで

```bash
tools/run_refresh_list.sh     # 生成（要ADC）→ firebase deploy（要 firebase login）
```
管理画面で施設を直したあと・施設側が情報を更新したあとに実行する。認証が切れていれば
`gcloud auth application-default login` → `set-quota-project kaigo-link-dev-59bc5`、`firebase login --reauth`。
