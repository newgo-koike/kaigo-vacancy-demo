'use strict';
// 空室相談（チャット）の通知（2026-10-01 小池さん指示）。
// 病院がメッセージを書き込んだ瞬間に、Meets Medical（兵頭さん）へ LINE で知らせる。
// メールはやめて LINE だけにした（小池さん 2026-10-01。送信元アカウントの管理を増やさないため）
//
//   notifyOnHospitalMessage … consultations/{cid}/messages/{mid} の作成を監視（by=hospital のときだけ送る）
//   lineWebhook             … LINE 公式アカウントの Webhook。友だち追加・メッセージ・グループ招待を受けて
//                             送り先候補（meta/lineUsers）に登録する。管理画面「通知先」で選ぶ
//   notifyOnAdminMessage    … Meets 側の返信を、その病院でアプリの通知をオンにした端末へ送る（2026-10-30）
//   pushSubCheck            … 端末が通知をオンにした直後と「テスト通知」のときに、その端末へ確認の通知を送る
//
// アプリの通知（2026-10-30 小池さん指示：ホーム画面のアプリに LINE のように届ける）は Web Push。
// 宛先は Firestore pushSubs（端末がオンにしたとき自分で登録）。鍵は VAPID（公開鍵はページ側 kaigo-push.js と同じもの）
//
// 設定（Firestore meta/notifySettings、管理画面から編集）: { enabled, lineUserIds:[], cooldownSec }
// 秘密情報（Secret Manager）: LINE_CHANNEL_TOKEN / LINE_CHANNEL_SECRET（LINE 公式アカウントの Messaging API）／VAPID_PRIVATE_KEY（アプリの通知）
const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');
const webpush = require('web-push');

initializeApp();
setGlobalOptions({ region: 'asia-northeast1', maxInstances: 5 });
const db = getFirestore();

const LINE_CHANNEL_TOKEN = defineSecret('LINE_CHANNEL_TOKEN');
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_PUBLIC_KEY = 'BDkn9qlF4GH-s9dG06iBhU-xScv0kPAyEnvFhgiYT5RBG6nvrHSfT4SgX0_4LbKW3Rq0e2qo8qPQEjuSkCOV_Ms';

const ADMIN_URL = 'https://kaigo.meetsmedical.com/kaigo-master.html';
// 通知のリンクはその相談を直接開く（#consult/相談ID）。LINE の中のブラウザだとログインし直しになりスマホで返信しづらかったため、
// openExternalBrowser=1（LINE の仕様）で端末の標準ブラウザ（ログインしたまま）で開かせる（2026-10-29）
function adminUrl(cid) { return `${ADMIN_URL}?openExternalBrowser=1#consult/${cid}`; }
const DEFAULTS = { enabled: true, lineUserIds: [], cooldownSec: 60 };

async function loadSettings() {
  const s = await db.doc('meta/notifySettings').get();
  const d = (s.exists && s.data()) || {};
  return {
    enabled: d.enabled !== false,
    lineUserIds: Array.isArray(d.lineUserIds) ? d.lineUserIds.filter(Boolean) : [],
    cooldownSec: Number.isFinite(d.cooldownSec) ? d.cooldownSec : DEFAULTS.cooldownSec,
    includeBody: d.includeBody === true,   // 本文の冒頭を通知に入れるか（個人情報が LINE 側にも残るため既定はオフ。管理画面「通知先」で変更）
  };
}

// 日本時間の「10/1 14:07」
function fmtJst(ts) {
  const d = ts && ts.toDate ? ts.toDate() : null;
  if (!d) return '';
  const p = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}
// 件名の表示は画面側（kaigo-consult.js の caseName）と同じ形：相談番号があれば「No.12（10/6 09:30）」
function caseName(c) {
  const t = fmtJst(c.createdAt);
  if (c.caseNo) return `No.${c.caseNo}（${t || '送信中'}）`;
  return t ? `${t} の相談` : '相談';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kindLabel(m, c) {
  if (m.kind === 'conditions') return '相談条件の修正';
  if (m.kind === 'withdrawn') return '取り下げ';
  if ((c.messageCount || 0) <= 1) return '新しい相談';
  return '返信';
}
const short = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

async function sendLine(settings, text) {
  if (!settings.lineUserIds.length) return 'LINE 送り先なし';
  const token = LINE_CHANNEL_TOKEN.value();
  if (!token) return 'LINE 未設定';
  // 1人なら push、複数なら multicast（どちらも送り先1人につき1通として数える）
  const ids = settings.lineUserIds;
  const url = ids.length === 1 ? 'https://api.line.me/v2/bot/message/push' : 'https://api.line.me/v2/bot/message/multicast';
  const body = ids.length === 1 ? { to: ids[0], messages: [{ type: 'text', text }] } : { to: ids, messages: [{ type: 'text', text }] };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`LINE ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return `LINE ${ids.length}件`;
}

// アプリの通知（Web Push）。届かなくなった端末（404/410）は登録を消す。
// url は通知を押したときに開く画面（Service Worker の場所からの相対。確認用 URL で入れたアプリでもそのサイトが開く）
async function sendPush(docs, payload) {
  if (!docs.length) return 'アプリ 0台';
  const key = VAPID_PRIVATE_KEY.value();
  if (!key) return 'アプリ 未設定';
  webpush.setVapidDetails('https://kaigo.meetsmedical.com', VAPID_PUBLIC_KEY, key);
  let ok = 0, gone = 0, ng = 0;
  await Promise.all(docs.map(async d => {
    const s = d.data();
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 86400, urgency: 'high' });
      ok++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { gone++; await d.ref.delete().catch(() => {}); }
      else { ng++; logger.warn('push failed', { id: d.id, status: e.statusCode, body: String(e.body || e.message || e).slice(0, 200) }); }
    }
  }));
  return `アプリ ${ok}台` + (gone ? `（無効${gone}台を削除）` : '') + (ng ? `（失敗${ng}台）` : '');
}
// ホーム画面のアイコンに出す未読の相談数（数えられなければ付けない）
async function countOf(q) {
  try { return (await q.count().get()).data().count; } catch (e) { logger.warn('count', e.message || e); return undefined; }
}

exports.notifyOnHospitalMessage = onDocumentCreated(
  { document: 'consultations/{cid}/messages/{mid}', secrets: [LINE_CHANNEL_TOKEN, VAPID_PRIVATE_KEY] },
  async (event) => {
    const m = event.data && event.data.data();
    if (!m || m.by !== 'hospital') return;   // Meets 側の返信は通知しない（病院側はアプリ内のバッジ）
    const cid = event.params.cid;
    const cref = db.doc(`consultations/${cid}`);
    const csnap = await cref.get();
    if (!csnap.exists) return;
    let c = csnap.data();
    for (let i = 0; i < 8 && !c.caseNo && (c.messageCount || 0) <= 1; i++) {   // 採番（assignCaseNo）を最大4秒待つ
      await sleep(500);
      c = (await cref.get()).data() || c;
    }
    const settings = await loadSettings();
    if (!settings.enabled) { logger.info('notify disabled'); return; }

    // 同じ件への連投は cooldownSec の間まとめる（最初の1通で「管理画面で確認」と案内済み）
    const lastAt = c.notify && c.notify.lastAt && c.notify.lastAt.toMillis ? c.notify.lastAt.toMillis() : 0;
    if (lastAt && Date.now() - lastAt < settings.cooldownSec * 1000) {
      logger.info('cooldown skip', { cid });
      await cref.update({ 'notify.skipped': FieldValue.increment(1) });
      return;
    }

    const kind = kindLabel(m, c);
    const hosp = c.hospitalName || c.hospitalId || '病院';
    const body = settings.includeBody ? `\n\n${short(m.text, 100)}` : '';
    const line = `【空室相談】${kind}\n病院：${hosp}\n件名：${caseName(c)}${body}\n\nこの相談を開いて返信：${adminUrl(cid)}`;

    const results = {};
    const pushJob = (async () => {
      const [subs, badge] = await Promise.all([db.collection('pushSubs').where('role', '==', 'admin').get(), countOf(db.collection('consultations').where('unreadForAdmin', '==', true))]);
      return sendPush(subs.docs, {
        title: `${kind}：${hosp}`,
        body: settings.includeBody ? short(m.text, 100) : `${caseName(c)}　押すと開いて返信できます`,
        url: `kaigo-master.html#consult/${cid}`, tag: `consult-${cid}`, badge,
      });
    })();
    try { results.line = await sendLine(settings, line); } catch (e) { results.line = 'エラー: ' + (e.message || e); logger.error('line', e); }
    try { results.push = await pushJob; } catch (e) { results.push = 'エラー: ' + (e.message || e); logger.error('push', e); }
    logger.info('notified', { cid, kind, ...results });
    await cref.update({ notify: { lastAt: Timestamp.now(), last: `${results.line} / ${results.push}` } });
  });

// Meets 側の返信を病院へ（アプリの通知をオンにした、その病院の端末だけ）。LINE は病院側には送らない
exports.notifyOnAdminMessage = onDocumentCreated(
  { document: 'consultations/{cid}/messages/{mid}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const m = event.data && event.data.data();
    if (!m || m.by !== 'admin' || m.kind) return;
    const cid = event.params.cid;
    const csnap = await db.doc(`consultations/${cid}`).get();
    const c = csnap.exists ? csnap.data() : null;
    if (!c || !c.hospitalId) return;
    const subs = await db.collection('pushSubs').where('role', '==', 'hospital').where('hospitalId', '==', c.hospitalId).get();
    if (subs.empty) return;
    const settings = await loadSettings();
    const badge = await countOf(db.collection('consultations').where('hospitalId', '==', c.hospitalId).where('unreadForHospital', '==', true));
    const r = await sendPush(subs.docs, {
      title: 'Meets Medical から返信',
      body: settings.includeBody ? short(m.text, 100) : `${caseName(c)}　押すと開きます`,
      url: `kaigo-consult.html#${cid}`, tag: `consult-${cid}`, badge,
    });
    logger.info('notified hospital', { cid, push: r });
  });

// 端末が通知をオンにした直後（新しく登録・別の人がログインし直した）と「テスト通知を送る」のときに、その端末へ1通送る。
// 「オンにしたのに届かない」をその場で確かめられるように
exports.pushSubCheck = onDocumentWritten(
  { document: 'pushSubs/{sid}', secrets: [VAPID_PRIVATE_KEY] },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const isNew = !before || before.uid !== after.uid || before.endpoint !== after.endpoint;
    const isTest = !!after.testAt && !(before && before.testAt && before.testAt.isEqual && before.testAt.isEqual(after.testAt));
    if (!isNew && !isTest) return;
    const home = after.role === 'admin' ? 'kaigo-master.html#consult' : 'kaigo-consult.html';
    const r = await sendPush([event.data.after], isTest
      ? { title: 'テスト通知', body: 'この端末に通知が届いています。新しいメッセージもこのように届きます。', url: home, tag: 'kaigo-test' }
      : { title: '通知がオンになりました', body: after.role === 'admin' ? '病院からの新しい相談・返信がこの端末に届きます。' : 'Meets Medical からの返信がこの端末に届きます。', url: home, tag: 'kaigo-test' });
    logger.info('push check', { sid: event.params.sid, isNew, isTest, push: r });
  });

// 相談番号の採番（2026-10-06 兵頭さん要望：名前欄をやめて自動番号で区別する）。
// 全病院を通した連番を meta/counters.consultNo でトランザクション採番し、相談に caseNo を付ける。病院側からは書き換えられない（rules）
exports.assignCaseNo = onDocumentCreated({ document: 'consultations/{cid}' }, async (event) => {
  const cref = db.doc(`consultations/${event.params.cid}`);
  const counter = db.doc('meta/counters');
  await db.runTransaction(async (tx) => {
    const [cs, ks] = await Promise.all([tx.get(cref), tx.get(counter)]);
    if (!cs.exists || cs.data().caseNo) return;
    const next = ((ks.exists && ks.data().consultNo) || 0) + 1;
    tx.set(counter, { consultNo: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.update(cref, { caseNo: next });
  });
  logger.info('caseNo assigned', { cid: event.params.cid });
});

// LINE 公式アカウントの Webhook：友だち追加・メッセージ・グループ参加を受けて送り先候補を登録する
exports.lineWebhook = onRequest({ secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_TOKEN], cors: false }, async (req, res) => {
  if (req.method !== 'POST') { res.status(200).send('ok'); return; }
  const secret = LINE_CHANNEL_SECRET.value();
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from('')).digest('base64');
  if (!secret || req.get('x-line-signature') !== expected) { res.status(403).send('bad signature'); return; }
  const token = LINE_CHANNEL_TOKEN.value();
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  for (const ev of (req.body && req.body.events) || []) {
    const src = ev.source || {};
    try {
      if (src.type === 'user' && src.userId && (ev.type === 'follow' || ev.type === 'message')) {
        const prof = await fetch(`https://api.line.me/v2/bot/profile/${src.userId}`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null);
        await db.doc('meta/lineUsers').set({ [src.userId]: { type: 'user', displayName: (prof && prof.displayName) || '', at: FieldValue.serverTimestamp() } }, { merge: true });
        if (ev.replyToken && (ev.type === 'follow' || /登録|通知/.test(String(ev.message && ev.message.text || '')))) {
          await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers, body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: `登録を受け付けました（${(prof && prof.displayName) || 'お名前未取得'}）。\n管理画面「チャット（空室相談）」→「通知先」でこの LINE を選ぶと、病院からの相談・返信がここに届きます。` }] }) });
        }
      } else if ((src.type === 'group' || src.type === 'room') && (ev.type === 'join' || ev.type === 'message')) {
        const id = src.groupId || src.roomId;
        let name = src.type === 'group' ? 'グループ' : 'トークルーム';
        if (src.type === 'group') { const g = await fetch(`https://api.line.me/v2/bot/group/${id}/summary`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null); if (g && g.groupName) name = g.groupName; }
        await db.doc('meta/lineUsers').set({ [id]: { type: src.type, displayName: name, at: FieldValue.serverTimestamp() } }, { merge: true });
      }
    } catch (e) { logger.error('webhook event', e); }
  }
  res.status(200).send('ok');
});
