# 手元の検証環境（本番につながない）

`fake-firebase.js` が Firebase compat SDK の代わりになり、検索・チャット管理・管理画面を手元で動かせる。
本番の Firestore / Storage / Auth には一切つながない。

使い方（リポジトリ直下で）:

```bash
python3 tools/testharness/make_stubs.py      # public/ の3ページから stub を生成（dist/ 配下）
python3 -m http.server 5179 --directory tools/testharness/dist
```

- http://localhost:5179/search-test.html?as=hospital&reset=1 … 病院担当者（H001 山田）として検索ページ。`reset=1` で相談データを消去
- http://localhost:5179/consult-test.html?as=hospital … チャット管理（病院側）
- http://localhost:5179/master-test.html#consult … 管理画面（管理者）
- 相談・メッセージ・自動返信の設定は localStorage に残るので、3ページをまたいで同じデータを確認できる
- 施設は配信中の一覧（public/kaigo-facilities.json）の先頭30件

`dist/` は生成物なので Git に入れない（.gitignore）。
