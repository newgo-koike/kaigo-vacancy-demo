# Cloud Functions（空室相談の通知）

病院がチャットで相談・返信・条件修正・取り下げを送った瞬間に、Meets Medical（兵頭さん）へ LINE を送る（メールは使わない。2026-10-01 小池さん判断）。
送り先は管理画面「チャット（空室相談）」→「通知先」で変える（Firestore `meta/notifySettings`）。

| 関数 | 役割 |
|---|---|
| `notifyOnHospitalMessage` | `consultations/{cid}/messages/{mid}` の作成を監視。`by=hospital` のときだけ LINE。同じ件への連投は1分間まとめる（`consultations.notify.lastAt`） |
| `lineWebhook` | LINE 公式アカウントの Webhook。友だち追加・「登録」メッセージ・グループ招待を受けて `meta/lineUsers` に名前と ID を登録（管理画面の「通知先」に並ぶ） |

## 初回セットアップ（小池さんの操作が要るところ）

1. LINE 公式アカウント（Messaging API）のチャネルアクセストークン（長期）とチャネルシークレットを控える
2. 秘密情報を登録（値はターミナルで聞かれたときに貼り付ける。Git には入らない）

```bash
firebase functions:secrets:set LINE_CHANNEL_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET
```

3. デプロイ：`firebase deploy --only functions`
4. LINE Developers コンソールで Webhook URL に `lineWebhook` の URL を設定し「Webhook の利用」をオン。応答設定の「あいさつメッセージ」「応答メッセージ」はオフ推奨
5. 受け取る人が公式アカウントを友だち追加して「登録」と送る → 管理画面「通知先」で選んで保存

## 確認方法

テスト病院（9815-01）でログインして相談を1件送る → 通知先に選んだ LINE に届く。
Functions のログ：`firebase functions:log --only notifyOnHospitalMessage`。
`consultations/<id>.notify.last` に「LINE 1件」のように結果が残る。

## 費用

Blaze の無料枠内（月200万回まで無料）。LINE は公式アカウントの無料枠（月200通。送り先1人につき1通）。
