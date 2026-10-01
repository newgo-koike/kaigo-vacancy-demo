'use strict';
// 空室相談（チャット）の通知（2026-10-01 小池さん指示）。
// 病院がメッセージを書き込んだ瞬間に、Meets Medical（兵頭さん）へメールと LINE で知らせる。
//
//   notifyOnHospitalMessage … consultations/{cid}/messages/{mid} の作成を監視（by=hospital のときだけ送る）
//   lineWebhook             … LINE 公式アカウントの Webhook。友だち追加・メッセージ・グループ招待を受けて
//                             送り先候補（meta/lineUsers）に登録する。管理画面「通知先」で選ぶ
//
// 設定（Firestore meta/notifySettings、管理画面から編集）: { enabled, emails:[], lineUserIds:[], cooldownSec }
// 秘密情報（Secret Manager）: SMTP_USER / SMTP_PASS（送信元メールとアプリパスワード）、
//                            LINE_CHANNEL_TOKEN / LINE_CHANNEL_SECRET（LINE 公式アカウントの Messaging API）
const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

initializeApp();
setGlobalOptions({ region: 'asia-northeast1', maxInstances: 5 });
const db = getFirestore();

const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const LINE_CHANNEL_TOKEN = defineSecret('LINE_CHANNEL_TOKEN');
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');

const ADMIN_URL = 'https://kaigo.meetsmedical.com/kaigo-master.html#consult';
const DEFAULTS = { enabled: true, emails: ['hyodo@meetsmedical.com'], lineUserIds: [], cooldownSec: 180 };

async function loadSettings() {
  const s = await db.doc('meta/notifySettings').get();
  const d = (s.exists && s.data()) || {};
  return {
    enabled: d.enabled !== false,
    emails: Array.isArray(d.emails) ? d.emails.filter(Boolean) : DEFAULTS.emails,
    lineUserIds: Array.isArray(d.lineUserIds) ? d.lineUserIds.filter(Boolean) : [],
    cooldownSec: Number.isFinite(d.cooldownSec) ? d.cooldownSec : DEFAULTS.cooldownSec,
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
// 件名の表示は画面側（kaigo-consult.js の caseName）と同じ形
function caseName(c) {
  const t = fmtJst(c.createdAt), l = String(c.caseLabel || '').trim();
  if (l) return `${l}（${t || '送信中'}）`;
  return t ? `${t} の相談` : '相談';
}
function kindLabel(m, c) {
  if (m.kind === 'conditions') return '相談条件の修正';
  if (m.kind === 'withdrawn') return '取り下げ';
  if ((c.messageCount || 0) <= 1) return '新しい相談';
  return '返信';
}
const short = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

async function sendMail(settings, subject, text) {
  if (!settings.emails.length) return 'メール送り先なし';
  const user = SMTP_USER.value(), pass = SMTP_PASS.value();
  if (!user || !pass) return 'SMTP 未設定';
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port: Number(process.env.SMTP_PORT || 465), secure: true,
    auth: { user, pass },
  });
  await transporter.sendMail({ from: `介護施設検索システム <${user}>`, to: settings.emails.join(', '), subject, text });
  return `メール ${settings.emails.length}件`;
}
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

exports.notifyOnHospitalMessage = onDocumentCreated(
  { document: 'consultations/{cid}/messages/{mid}', secrets: [SMTP_USER, SMTP_PASS, LINE_CHANNEL_TOKEN] },
  async (event) => {
    const m = event.data && event.data.data();
    if (!m || m.by !== 'hospital') return;   // Meets 側の返信は通知しない（病院側はアプリ内のバッジ）
    const cid = event.params.cid;
    const cref = db.doc(`consultations/${cid}`);
    const csnap = await cref.get();
    if (!csnap.exists) return;
    const c = csnap.data();
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
    const title = `【空室相談】${kind}：${hosp}　${caseName(c)}`;
    const bodyText = short(m.text, 600);
    const mail = `${hosp} から${kind}が届きました。\n\n件名：${caseName(c)}\n担当：${c.createdByName || '（担当者名なし）'}\n\n${bodyText}\n\n管理画面で返信する：${ADMIN_URL}\n（このメールは自動送信です）`;
    const line = `【空室相談】${kind}\n病院：${hosp}\n件名：${caseName(c)}\n\n${short(m.text, 300)}\n\n管理画面：${ADMIN_URL}`;

    const results = {};
    try { results.mail = await sendMail(settings, title, mail); } catch (e) { results.mail = 'エラー: ' + (e.message || e); logger.error('mail', e); }
    try { results.line = await sendLine(settings, line); } catch (e) { results.line = 'エラー: ' + (e.message || e); logger.error('line', e); }
    logger.info('notified', { cid, kind, ...results });
    await cref.update({ notify: { lastAt: Timestamp.now(), last: `${results.mail} / ${results.line}` } });
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
