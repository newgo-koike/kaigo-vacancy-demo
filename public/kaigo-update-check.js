// 更新のお知らせ（2026-10-07 兵頭さん要望）。
// ブラウザから「アプリとして入れた」窓には更新ボタンが無く、こちらで新しい版を配信しても古い画面のまま残る。
// そこで、このページと読み込んでいる自前の JS について配信サーバーの ETag（内容の指紋）を HEAD で取り、
// 読み込んだときと違っていれば画面の下に「新しい版があります」を出し、「更新する」で読み直す。
// 確認は 90 秒ごとと、窓に戻ってきたとき。通信は小さな HEAD だけで、ページの中身は取らない。
(function () {
  'use strict';
  if (!window.fetch || !window.URL) return;
  const INTERVAL = 90 * 1000;
  const LATER = 10 * 60 * 1000;   // 「あとで」を押したら 10 分は出さない
  const page = location.pathname.endsWith('/') ? location.pathname + 'index.html' : location.pathname;
  const files = [page];
  document.querySelectorAll('script[src]').forEach(s => {
    const src = s.getAttribute('src');
    if (!src || /^(https?:)?\/\//.test(src) || src.startsWith('data:')) return;
    const path = new URL(src, location.href).pathname;
    if (!files.includes(path)) files.push(path);
  });
  const base = {};
  let shown = false, checking = false, laterUntil = 0;

  async function sig(path) {
    try {
      const r = await fetch(path, { method: 'HEAD', cache: 'no-store' });
      if (!r.ok) return null;
      return r.headers.get('etag') || r.headers.get('last-modified') || null;
    } catch (e) { return null; }
  }
  async function snapshot() { for (const f of files) { const s = await sig(f); if (s) base[f] = s; } }
  async function check() {
    if (shown || checking || Date.now() < laterUntil || document.visibilityState === 'hidden') return false;
    checking = true;
    try {
      for (const f of files) {
        if (!base[f]) continue;
        const s = await sig(f);
        if (s && s !== base[f]) { show(); return true; }
      }
      return false;
    } finally { checking = false; }
  }
  function show() {
    if (shown) return;
    shown = true;
    if (!document.getElementById('kaigo-update-style')) {
      const st = document.createElement('style');
      st.id = 'kaigo-update-style';
      st.textContent = `
        .kaigo-update { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:9990; display:flex; align-items:center; gap:12px; flex-wrap:wrap; justify-content:center;
          max-width:calc(100% - 24px); padding:12px 16px 12px 18px; background:#2b2b2b; color:#fff; border-radius:14px; box-shadow:0 8px 24px rgba(0,0,0,.25); font-family:-apple-system,'Hiragino Sans',Arial,sans-serif; font-size:14px; line-height:1.5; }
        .kaigo-update b { font-size:15px; }
        .kaigo-update button { font-family:inherit; font-weight:900; font-size:14px; padding:9px 18px; border-radius:100px; border:2px solid #fff; background:#fff; color:#2b2b2b; cursor:pointer; }
        .kaigo-update button.later { background:transparent; color:#fff; font-weight:700; }
        @media print { .kaigo-update { display:none; } }`;
      document.head.appendChild(st);
    }
    const bar = document.createElement('div');
    bar.className = 'kaigo-update';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span><b>新しい版があります。</b>更新すると最新の画面になります。</span>'
      + '<button type="button" class="go">更新する</button><button type="button" class="later">あとで</button>';
    bar.querySelector('.go').onclick = () => { location.reload(); };
    bar.querySelector('.later').onclick = () => { bar.remove(); shown = false; laterUntil = Date.now() + LATER; };
    document.body.appendChild(bar);
  }
  function start() { snapshot(); setInterval(check, INTERVAL); }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('focus', () => { check(); });
  window.KaigoUpdate = { check, files, base, show };
})();
