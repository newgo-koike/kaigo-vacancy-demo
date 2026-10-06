// 検証用の疑似 Firebase（本番に一切つながない）。compat SDK の代わりに読み込み、
// 検索・チャット・管理画面の動きを手元で確かめる。ページをまたいで確認できるよう
// 相談まわり（consultations / messages / meta）は localStorage に保存する（?reset=1 で消去）。
// ログインユーザー: ?as=hospital で病院担当者（H001 山田）、既定は管理者。
(function () {
  'use strict';
  // ?as=hospital / ?as=admin / ?as=none（未ログインから始め、ログイン画面でサインインする）。一度サインインしたら sessionStorage に覚える
  const AS = new URLSearchParams(location.search).get('as') || (function () { try { return sessionStorage.getItem('FAKE_AS'); } catch (e) { return null; } })();
  try { if (new URLSearchParams(location.search).get('as')) sessionStorage.setItem('FAKE_AS', AS); } catch (e) {}
  const USERS = {
    admin1: { role: 'admin', name: '小池雄悟', email: 'y-koike@yumematch.com' },
    hosp1:  { role: 'hospital', name: '山田', hospitalId: 'H001', hospitalName: 'テスト総合病院', loginId: 'H001-01', email: 'h001-01@meets-medical.jp' },
    hosp2:  { role: 'hospital', name: '', hospitalId: 'H002', hospitalName: '第二テスト病院', loginId: 'H002-01', email: 'h002-01@meets-medical.jp' },
  };
  const ME = AS === 'hospital' ? 'hosp1' : AS === 'none' ? null : 'admin1';
  const ARRAY_UNION = Symbol('arrayUnion'), SERVER_TS = Symbol('serverTimestamp'), INC = Symbol('increment'), DEL = Symbol('delete');
  let clock = Date.now();
  const ts = d => ({ toDate: () => d, toMillis: () => d.getTime(), seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 });
  const store = { users: {}, facilities: {}, consultations: {}, meta: {}, searchLogs: {}, corporations: {}, applications: {} };
  const sub = { messages: {} };   // sub.messages[consultationId][messageId]
  for (const [id, u] of Object.entries(USERS)) store.users[id] = { ...u, createdAt: ts(new Date('2026-07-01T00:00:00Z')) };
  window.FAKE = { store, sub, uploads: [], deleted: [], me: ME };

  // 施設は配信中の一覧ファイルから先頭30件を入れる（検索結果・管理画面の表示用）
  const ready = fetch('kaigo-facilities.json', { cache: 'reload' }).then(r => r.json()).then(j => {
    j.facilities.slice(0, 30).forEach(r => { const d = { ...r }; delete d.id; d.updatedAt = ts(new Date(r.updatedAt || Date.now())); store.facilities[r.id] = d; });
  }).catch(() => {});

  function docsOf(collPath) {
    if (collPath.includes('/')) { const [c, id, s] = collPath.split('/'); sub[s] = sub[s] || {}; sub[s][id] = sub[s][id] || {}; return sub[s][id]; }
    store[collPath] = store[collPath] || {}; return store[collPath];
  }
  function applyData(collPath, id, data, merge) {
    const cur = docsOf(collPath)[id] || {};
    const next = merge ? { ...cur } : {};
    for (const [k, v] of Object.entries(data)) {
      if (v && v[ARRAY_UNION]) next[k] = (Array.isArray(cur[k]) ? cur[k] : []).concat(v[ARRAY_UNION]);
      else if (v && v[INC] != null) next[k] = (cur[k] || 0) + v[INC];
      else if (v === SERVER_TS) next[k] = ts(new Date(clock += 1000));
      else if (v === DEL) delete next[k];
      else if (k.includes('.')) {   // 'conditions.detail' のようなドット区切りは入れ子の項目を更新する（本物の Firestore と同じ）
        const parts = k.split('.'); let o = next;
        for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = (o[parts[i]] && typeof o[parts[i]] === 'object') ? { ...o[parts[i]] } : {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = v;
      }
      else next[k] = v;
    }
    docsOf(collPath)[id] = next;
  }
  function runQuery(q) {
    let rows = Object.entries(docsOf(q.coll)).map(([id, d]) => ({ id, d }));
    q.wheres.forEach(([f, op, v]) => {
      rows = rows.filter(r => op === '==' ? r.d[f] === v : op === 'in' ? v.includes(r.d[f]) : op === '!=' ? r.d[f] !== v : true);
    });
    if (q.order) { const [f, dir] = q.order; const key = r => (r.d[f] && r.d[f].toMillis) ? r.d[f].toMillis() : (r.d[f] || 0); rows.sort((a, b) => dir === 'desc' ? key(b) - key(a) : key(a) - key(b)); }
    if (q.lim) rows = rows.slice(0, q.lim);
    const docs = rows.map(r => ({ id: r.id, exists: true, data: () => r.d, ref: docRef(q.coll, r.id) }));
    return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
  }
  // 相談まわりだけ localStorage に保存（ページをまたいで検証するため）
  const KEY = 'FAKE_STORE_v1';
  const rep = (k, v) => (v && typeof v.toMillis === 'function') ? { __ts: v.toMillis() } : v;
  const rev = (k, v) => (v && typeof v === 'object' && '__ts' in v) ? ts(new Date(v.__ts)) : v;
  function persist() { try { localStorage.setItem(KEY, JSON.stringify({ consultations: store.consultations, meta: store.meta, messages: sub.messages }, rep)); } catch (e) {} }
  try {
    if (new URLSearchParams(location.search).get('reset') === '1') localStorage.removeItem(KEY);
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null', rev);
    if (saved) { store.consultations = saved.consultations || {}; store.meta = saved.meta || {}; sub.messages = saved.messages || {}; }
  } catch (e) {}
  const listeners = [];
  function notifyAll() { persist(); listeners.forEach(l => { try { l.cb(l.q ? runQuery(l.q) : l.snap()); } catch (e) { console.error(e); } }); }

  function query(coll, wheres, order, lim) {
    const q = { coll, wheres: wheres || [], order, lim };
    return {
      where: (f, op, v) => query(coll, q.wheres.concat([[f, op, v]]), order, lim),
      orderBy: (f, dir) => query(coll, q.wheres, [f, dir || 'asc'], lim),
      limit: n => query(coll, q.wheres, order, n),
      get: async () => { await ready; return runQuery(q); },
      onSnapshot: (cb, err) => { const l = { q, cb }; listeners.push(l); ready.then(() => cb(runQuery(q))); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; },
      doc: id => docRef(coll, id || ('auto' + Math.random().toString(36).slice(2, 10))),
      add: async data => { const r = docRef(coll); applyData(coll, r.id, data, false); notifyAll(); return r; },
    };
  }
  function docRef(coll, id) {
    id = id || ('auto' + Math.random().toString(36).slice(2, 10));
    const snap = () => ({ exists: !!docsOf(coll)[id], id, data: () => docsOf(coll)[id], ref: docRef(coll, id) });
    return {
      id, _coll: coll, path: `${coll}/${id}`,
      get: async () => { await ready; return snap(); },
      update: async data => { if (!docsOf(coll)[id]) throw new Error('not found: ' + coll + '/' + id); applyData(coll, id, data, true); notifyAll(); },
      set: async (data, opts) => { applyData(coll, id, data, !!(opts && opts.merge)); notifyAll(); },
      delete: async () => { delete docsOf(coll)[id]; notifyAll(); },
      onSnapshot: cb => { const l = { snap, cb }; listeners.push(l); ready.then(() => cb(snap())); return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; },
      collection: name => query(`${coll}/${id}/${name}`),
    };
  }
  const db = {
    collection: name => query(name),
    batch: () => { const ops = []; return {
      update: (ref, data) => ops.push(['update', ref, data]),
      set: (ref, data, opts) => ops.push(['set', ref, data, !!(opts && opts.merge)]),
      delete: ref => ops.push(['delete', ref]),
      commit: async () => { ops.forEach(([op, ref, data, merge]) => { if (op === 'delete') delete docsOf(ref._coll)[ref.id]; else applyData(ref._coll, ref.id, data, op === 'update' ? true : merge); }); notifyAll(); },
    }; },
    enablePersistence: async () => {},
  };
  const firestore = () => db;
  firestore.FieldValue = { arrayUnion: (...xs) => ({ [ARRAY_UNION]: xs }), serverTimestamp: () => SERVER_TS, increment: n => ({ [INC]: n }), delete: () => DEL };
  firestore.Timestamp = { now: () => ts(new Date()), fromDate: d => ts(d) };

  const storage = () => ({ ref: path => ({
    put: (file, meta) => { window.FAKE.uploads.push({ path, name: file.name, size: file.size, meta }); let next, done; const total = file.size || 1;
      [0.3, 0.7, 1].forEach((p, i) => setTimeout(() => { next && next({ bytesTransferred: Math.round(total * p), totalBytes: total }); if (p === 1 && done) done(); }, 150 * (i + 1)));
      return { on: (ev, n, e, d) => { next = n; done = d; }, then: (fn) => new Promise(res => { done = () => res(fn && fn({ ref: { getDownloadURL: async () => 'fake://' + path } })); }) }; },
    getDownloadURL: async () => 'fake://' + path,
    delete: async () => { window.FAKE.deleted.push(path); },
  }) });

  const mkUser = id => ({ uid: id, email: USERS[id].email, getIdToken: async () => 'fake-token',
    reauthenticateWithCredential: async () => ({}), updatePassword: async (pw) => { window.FAKE.passwordChangedTo = pw; } });
  let me = ME ? mkUser(ME) : null;
  const authListeners = [];
  // ログイン検証用：サインインしたら病院担当者（hosp1）として扱う（管理者メールなら admin1）。パスワードは何でも通る
  const authObj = {
    get currentUser() { return me; },
    onAuthStateChanged: cb => { authListeners.push(cb); setTimeout(() => cb(me), 0); return () => {}; },
    signOut: async () => { me = null; try { sessionStorage.setItem('FAKE_AS', 'none'); } catch (e) {} authListeners.forEach(cb => cb(null)); },
    signInWithEmailAndPassword: async (email, pw) => {
      const id = /@meets-medical\.jp$/.test(email) ? 'hosp1' : 'admin1';
      me = mkUser(id); window.FAKE.signIn = { email, pw }; window.FAKE.me = id;
      try { sessionStorage.setItem('FAKE_AS', id === 'hosp1' ? 'hospital' : 'admin'); } catch (e) {}
      return { user: me };
    },
    setPersistence: async (p) => { window.FAKE.persistence = p; },
  };
  const auth = () => authObj;
  auth.Persistence = { LOCAL: 'local', SESSION: 'session', NONE: 'none' };
  auth.Auth = { Persistence: auth.Persistence };   // 本物は firebase.auth.Auth.Persistence.LOCAL の形
  auth.EmailAuthProvider = { credential: (e, p) => ({ e, p }) };
  window.firebase = { initializeApp: () => ({}), firestore, auth, storage, apps: [{}] };
})();
