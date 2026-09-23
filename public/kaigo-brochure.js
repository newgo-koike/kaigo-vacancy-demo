// 施設パンフレット（PDF）の共通処理。
// 置き場所は Firebase Storage の brochures/<施設ID>/<日時>_<ファイル名>.pdf。
// 施設ドキュメント（facilities/<id>.brochures）を正本にしつつ、検索ページが1回の読み取りで
// 全施設分を引けるよう索引ドキュメント meta/brochures（施設ID → 配列）にも同じ内容を持つ。
// 管理画面（kaigo-master.html）・施設編集（kaigo-manage.html）・検索（kaigo-search.html）・
// 施設詳細（kaigo-facility-view.html）・資料出力（kaigo-print.js）がこれを共有する。
(function (global) {
  'use strict';

  const BUCKET     = 'kaigo-link-dev-59bc5.firebasestorage.app';
  const MAX_MB     = 20;                      // 1ファイルの上限（storage.rules と同じ値にする）
  const INDEX_COLL = 'meta';
  const INDEX_DOC  = 'brochures';

  // 公開URL。storage.rules で brochures/** は誰でも読めるので、ダウンロードトークン無しで開ける
  function url(entry) {
    return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(entry.path)}?alt=media`;
  }

  function list(d) {
    return Array.isArray(d && d.brochures) ? d.brochures.filter(b => b && b.path) : [];
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB';
  }

  function isPdf(file) {
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  }

  // Storage のオブジェクト名に使えない文字（/ # ? [ ] * 制御文字）を除き、長すぎる名前は切る
  function safeName(name) {
    const base = String(name || 'file.pdf').split(/[\\/]/).pop();
    let s = base.replace(/[#?\[\]*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
    if (!/\.pdf$/i.test(s)) s += '.pdf';
    if (s.length > 80) s = s.slice(0, 76) + '.pdf';
    return s;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function shortName(name, n) {
    const s = String(name || '').replace(/\.pdf$/i, '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function checkFile(file) {
    if (!isPdf(file)) throw new Error(`「${file.name}」はPDFではありません（PDFだけ登録できます）`);
    if (file.size > MAX_MB * 1024 * 1024) throw new Error(`「${file.name}」は${MAX_MB}MBを超えています（${fmtSize(file.size)}）`);
  }

  // 施設 fid に files（FileList か File の配列）を追加する。1ファイルずつ Storage へ上げ、
  // 完了ごとに施設ドキュメントと索引の両方へ追記する（途中で失敗しても、済んだ分は反映済み）。
  // onProgress(file, 0〜1) で進捗を返す。戻り値は追加したエントリの配列。
  async function upload(fid, files, onProgress) {
    const fb = global.firebase;
    if (!fb || !fb.storage) throw new Error('Storage SDK が読み込まれていません');
    if (!/^[A-Za-z0-9_-]+$/.test(fid)) throw new Error('施設IDが不正です: ' + fid);
    const storage = fb.storage(), db = fb.firestore();
    const arr = Array.from(files || []);
    arr.forEach(checkFile);
    const added = [];
    for (const file of arr) {
      const path = `brochures/${fid}/${Date.now()}_${safeName(file.name)}`;
      const task = storage.ref(path).put(file, {
        contentType: 'application/pdf',
        // ブラウザで開いたときにその場で表示し、保存時は元のファイル名になるように
        contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        cacheControl: 'public, max-age=3600',
      });
      await new Promise((resolve, reject) => task.on('state_changed',
        s => { if (onProgress) onProgress(file, s.totalBytes ? s.bytesTransferred / s.totalBytes : 0); },
        reject, resolve));
      const entry = { name: file.name, path, size: file.size, at: fb.firestore.Timestamp.now() };
      const batch = db.batch();
      batch.update(db.collection('facilities').doc(fid), { brochures: fb.firestore.FieldValue.arrayUnion(entry) });
      batch.set(db.collection(INDEX_COLL).doc(INDEX_DOC), { [fid]: fb.firestore.FieldValue.arrayUnion(entry) }, { merge: true });
      await batch.commit();
      added.push(entry);
      if (onProgress) onProgress(file, 1);
    }
    return added;
  }

  // 施設 fid から path のPDFを外す（Storage のファイルも消す）。残りの配列を返す
  async function remove(fid, path) {
    const fb = global.firebase;
    const storage = fb.storage(), db = fb.firestore();
    const facRef = db.collection('facilities').doc(fid);
    const snap = await facRef.get();
    const rest = list(snap.data()).filter(b => b.path !== path);
    const batch = db.batch();
    batch.update(facRef, { brochures: rest });
    batch.set(db.collection(INDEX_COLL).doc(INDEX_DOC), { [fid]: rest }, { merge: true });
    await batch.commit();
    // Storage 側の削除は最後に。既に無い場合（二重削除）はエラーにしない
    try { await storage.ref(path).delete(); }
    catch (e) { if (!e || e.code !== 'storage/object-not-found') throw e; }
    return rest;
  }

  // 検索ページ用：索引を1回だけ読む（施設ID → エントリ配列）。無ければ空
  async function loadIndex(db) {
    const s = await db.collection(INDEX_COLL).doc(INDEX_DOC).get();
    return s.exists ? (s.data() || {}) : {};
  }

  global.KaigoBrochure = { BUCKET, MAX_MB, INDEX_COLL, INDEX_DOC, url, list, fmtSize, isPdf, safeName, shortName, esc, checkFile, upload, remove, loadIndex };
})(window);
