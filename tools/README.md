# tools/ — 管理者用の取り込みツール（本番には公開されない）

`firebase.json` の `hosting.public` は `public/` なので、**このディレクトリはデプロイされない**。
施設データを一括で書き換える破壊的なツールを本番URLに置かないため、あえてここに分離している。

## kaigo-xlsx-import.html — 介護情報リスト取り込み（260712・5市版）

`kaigo-import-data-260712.js` に埋め込んだ476件（豊中・吹田・茨木・池田・箕面）を
Firestore の `facilities` に反映する。2026-07-14 に実行済み。

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
