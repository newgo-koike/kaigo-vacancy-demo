// Cloud Functions の通知処理を本番につながずに確かめる（firebase-admin・web-push・fetch を差し替える）。
// 使い方（リポジトリ直下で）: NODE_PATH=functions/node_modules node tools/testharness/functions-test.js
const Module = require('module');
const path = require('path');
let MODE = {};
const sent = { line: [], push: [], deleted: [] };
const store = {};
const ts = ms => ({ toMillis: () => ms, toDate: () => new Date(ms), isEqual: o => !!o && o.toMillis() === ms });
const docSnap = p => ({ exists: !!store[p], data: () => store[p], ref: docRef(p), id: p.split('/').pop() });
function docRef(p) { return { path: p, get: async () => docSnap(p), update: async () => {}, delete: async () => { sent.deleted.push(p); delete store[p]; }, set: async () => {} }; }
const rows = (coll, filters) => Object.keys(store).filter(k => k.startsWith(coll + '/') && k.split('/').length === 2 && filters.every(([f, v]) => store[k][f] === v));
function query(coll, filters) {
  return {
    where: (f, op, v) => query(coll, [...filters, [f, v]]),
    get: async () => { if (MODE.queryThrows && coll === 'pushSubs') throw new Error('query failed'); const docs = rows(coll, filters).map(docSnap); return { docs, empty: !docs.length }; },
    count: () => ({ get: async () => ({ data: () => ({ count: rows(coll, filters).length }) }) }),
  };
}
const stubs = {
  'firebase-functions/v2': { setGlobalOptions: () => {} },
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => h, onDocumentWritten: (o, h) => h },
  'firebase-functions/v2/https': { onRequest: (o, h) => h },
  'firebase-functions/params': { defineSecret: n => ({ value: () => 'secret-' + n }) },
  'firebase-functions/logger': { info: () => {}, warn: () => {}, error: () => {} },
  'firebase-admin/app': { initializeApp: () => {} },
  'firebase-admin/firestore': { getFirestore: () => ({ doc: docRef, collection: c => query(c, []), runTransaction: async () => {} }), FieldValue: { increment: n => n, serverTimestamp: () => 'TS' }, Timestamp: { now: () => ts(Date.now()) } },
  'web-push': { setVapidDetails: () => {}, sendNotification: async (sub, body) => { if (MODE.pushThrows) { const e = new Error('push'); e.statusCode = MODE.pushThrows; throw e; } sent.push.push([sub.endpoint, JSON.parse(body)]); } },
};
const origLoad = Module._load;
Module._load = function (req) { return stubs[req] || origLoad.apply(this, arguments); };
global.fetch = async (url, opt) => { sent.line.push(JSON.parse(opt.body).messages[0].text); return { ok: true, text: async () => '' }; };
const fns = require(path.resolve(__dirname, '../../functions/index.js'));

function reset(mode) {
  MODE = mode || {}; sent.line = []; sent.push = []; sent.deleted = [];
  for (const k of Object.keys(store)) delete store[k];
  store['meta/notifySettings'] = { enabled: true, lineUserIds: ['U1'], cooldownSec: 60 };
  store['consultations/c1'] = { hospitalId: 'H1', hospitalName: 'テスト病院', caseNo: 14, createdAt: ts(Date.parse('2026-10-29T13:14:00Z')), messageCount: 1, unreadForAdmin: true };
}
const sub = (id, extra) => { store['pushSubs/' + id] = Object.assign({ uid: 'u-' + id, endpoint: 'https://push.example/' + id, keys: {} }, extra); };
const ev = (by, extra) => ({ params: { cid: 'c1', mid: 'm1' }, data: { data: () => Object.assign({ by, text: '本文です' }, extra || {}) } });
(async () => {
  let ok = true; const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) ok = false; };
  reset(); await fns.notifyOnHospitalMessage(ev('hospital'));
  check('LINE は1通・見出しはサービス名', sent.line.length === 1 && sent.line[0] === '【チャットde介護】新しい相談\n病院：テスト病院\n件名：No.14（10/29 22:14）\n\nこの相談を開いて返信：https://kaigo.meetsmedical.com/kaigo-master.html?openExternalBrowser=1#consult/c1');
  check('端末0台ならアプリ通知は0件', sent.push.length === 0);
  // アプリ通知（Web Push）がまだ入っていない版（main）では、ここから先は確かめない
  if (!fns.notifyOnAdminMessage) { console.log(ok ? '\nALL PASS（LINE のみ）' : '\nSOME FAILED'); process.exit(ok ? 0 : 1); }
  reset({ queryThrows: true }); await fns.notifyOnHospitalMessage(ev('hospital'));
  check('端末の読み込みが失敗しても LINE は送る', sent.line.length === 1);
  reset({ pushThrows: 500 }); sub('a1', { role: 'admin' }); await fns.notifyOnHospitalMessage(ev('hospital'));
  check('アプリ送信が失敗しても LINE は送る', sent.line.length === 1);
  reset({ pushThrows: 410 }); sub('a1', { role: 'admin' }); await fns.notifyOnHospitalMessage(ev('hospital'));
  check('届かなくなった端末（410）は登録を消す', sent.deleted.includes('pushSubs/a1'));
  reset(); sub('a1', { role: 'admin' }); sub('h1', { role: 'hospital', hospitalId: 'H1' }); await fns.notifyOnHospitalMessage(ev('hospital'));
  check('病院の書き込み→管理者の端末だけ', sent.push.length === 1 && sent.push[0][0].endsWith('/a1') && sent.push[0][1].url === 'kaigo-master.html#consult/c1' && sent.push[0][1].badge === 1);
  check('通知に本文は既定で載せない', !String(sent.push[0][1].body).includes('本文です'));
  reset(); store['meta/notifySettings'].enabled = false; sub('a1', { role: 'admin' }); await fns.notifyOnHospitalMessage(ev('hospital'));
  check('「通知を送る」オフなら何も送らない', sent.line.length === 0 && sent.push.length === 0);
  reset(); sub('h1', { role: 'hospital', hospitalId: 'H1' }); sub('h2', { role: 'hospital', hospitalId: 'H2' });
  await fns.notifyOnAdminMessage(ev('admin'));
  check('Meets の返信→その病院の端末だけ', sent.push.length === 1 && sent.push[0][0].endsWith('/h1') && sent.push[0][1].url === 'kaigo-consult.html#c1');
  sent.push = []; await fns.notifyOnAdminMessage(ev('hospital')); await fns.notifyOnAdminMessage(ev('admin', { kind: 'conditions' }));
  check('病院の書き込み・記録メッセージでは病院向けは動かない', sent.push.length === 0);
  reset(); const a = { role: 'admin', uid: 'u', endpoint: 'https://push.example/a1', keys: {} };
  const wev = (b, x) => ({ params: { sid: 'a1' }, data: { before: { exists: !!b, data: () => b }, after: { exists: !!x, data: () => x, ref: docRef('pushSubs/a1') } } });
  await fns.pushSubCheck(wev(null, a)); check('オン直後に確認の通知', sent.push.length === 1 && sent.push[0][1].title === '通知がオンになりました');
  sent.push = []; await fns.pushSubCheck(wev(a, Object.assign({}, a, { updatedAt: 1 }))); check('開くたびの保存では送らない', sent.push.length === 0);
  await fns.pushSubCheck(wev(a, Object.assign({}, a, { testAt: ts(5) }))); check('テスト通知', sent.push.length === 1 && sent.push[0][1].title === 'テスト通知');
  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
