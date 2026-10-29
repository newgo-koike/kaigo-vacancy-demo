// ホーム画面のアプリ＋通知（2026-10-30 小池さん指示）。
// 「LINE や Slack のように、ホームのアイコンを押せばすぐチャットでき、新着は通知で届く」ための共通部品。
//   ・sw.js（通知専用の Service Worker）を登録する
//   ・通知をオンにした端末の宛先（PushSubscription）を Firestore pushSubs/{宛先のハッシュ} に保存する。送るのは Cloud Functions
//   ・状態に合わせて案内の帯を出す（iPhone で未追加→ホーム画面に追加のしかた／未設定→オンにする／拒否→設定の場所）
// 使い方：KaigoPush.init({ db, user, role, hospitalId, name, mount, toast }) / KaigoPush.setBadge(未読数) / KaigoPush.signOut(auth)
(function () {
  const VAPID_PUBLIC = 'BDkn9qlF4GH-s9dG06iBhU-xScv0kPAyEnvFhgiYT5RBG6nvrHSfT4SgX0_4LbKW3Rq0e2qo8qPQEjuSkCOV_Ms';
  const UA = navigator.userAgent;
  const IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const ANDROID = /Android/.test(UA);
  const MOBILE = IOS || ANDROID;
  const IN_LINE = /\sLine\//i.test(UA);
  const HIDE_KEY = 'kaigo_push_hide_until';
  const SAVED_KEY = 'kaigo_push_saved';   // 最後に保存した宛先と日時（開くたびに書き込まないため）
  let CTX = null, REG = null, MOUNT = null, PANEL = null, INSTALL_EVT = null, UNSUB_DEV = null;

  // Android の Chrome が「アプリとして追加できる」と知らせてくる合図。ページを開いてすぐ来るので、読み込み時点で受けておく
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); INSTALL_EVT = e; render(); });
  window.addEventListener('appinstalled', () => { INSTALL_EVT = null; render(); });

  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function b64ToBytes(s) {
    const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  }
  // 文書ID は宛先 URL のハッシュ（同じ端末を二重に登録しない。宛先そのものは推測できない長い URL）
  async function subId(endpoint) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
    return [...new Uint8Array(h)].slice(0, 20).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function deviceLabel() {
    const os = IOS ? (/iPhone/.test(UA) ? 'iPhone' : 'iPad') : ANDROID ? 'Android' : /Mac/.test(UA) ? 'Mac' : /Windows/.test(UA) ? 'Windows' : 'パソコン';
    if (standalone()) return os + '（ホーム画面のアプリ）';
    const br = /Edg\//.test(UA) ? 'Edge' : /CriOS|Chrome\//.test(UA) ? 'Chrome' : /FxiOS|Firefox\//.test(UA) ? 'Firefox' : /Safari\//.test(UA) ? 'Safari' : '';
    return os + (br ? `（${br}）` : '');
  }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function toast(msg) { if (CTX && CTX.toast) CTX.toast(msg); }

  function ready() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (!REG) REG = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(e => { console.warn('sw', e); return null; });
    return REG;
  }
  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await ready();
    return reg ? reg.pushManager.getSubscription().catch(() => null) : null;
  }

  // 'line' LINE の中 / 'install' iPhone でホーム画面に未追加 / 'unsupported' / 'denied' / 'off' / 'on'
  async function status() {
    if (IN_LINE) return 'line';
    if (IOS && !standalone()) return 'install';   // iPhone はホーム画面に追加したアプリでしか通知を受け取れない（iOS 16.4 以降）
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const sub = await currentSub();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  }

  async function save(sub, force, extra) {
    const id = await subId(sub.endpoint);
    const mark = `${id}:${CTX.user.uid}`;
    let last = null;
    try { last = JSON.parse(lsGet(SAVED_KEY) || 'null'); } catch (e) {}
    if (!force && last && last.mark === mark && Date.now() - last.at < 864e5) return id;
    const j = sub.toJSON();
    const data = Object.assign({
      uid: CTX.user.uid, role: CTX.role, name: CTX.name || '', device: deviceLabel(),
      endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, updatedAt: ts(),
    }, CTX.role === 'hospital' ? { hospitalId: CTX.hospitalId, hospitalName: CTX.hospitalName || '' } : {}, extra || {});
    await CTX.db.collection('pushSubs').doc(id).set(data);
    lsSet(SAVED_KEY, JSON.stringify({ mark, at: Date.now() }));
    return id;
  }

  async function enable() {
    if (!pushSupported()) throw new Error('この端末・ブラウザは通知に対応していません');
    // iPhone は「ボタンを押した直後」でないと許可を聞いてくれないので、ほかの待ち時間より先に聞く
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { render(); return false; }
    const reg = await ready();
    if (!reg) throw new Error('通知の準備に失敗しました');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
    await save(sub, true);
    render();
    return true;
  }
  async function disable() {
    const sub = await currentSub();
    if (sub) {
      await CTX.db.collection('pushSubs').doc(await subId(sub.endpoint)).delete().catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    lsSet(SAVED_KEY, null);
    render();
  }
  async function test() {
    const sub = await currentSub();
    if (!sub || Notification.permission !== 'granted') throw new Error('この端末の通知がオンになっていません');
    await save(sub, true, { testAt: ts() });   // testAt が変わると Cloud Functions がこの端末にだけテスト通知を送る
  }
  // ログアウト時はこの端末への通知も止める（共用のパソコンで、次にログインした人へ前の人の通知が届かないように）
  async function signOut(auth) {
    try {
      const sub = await currentSub();
      if (sub) {
        // init していない画面からでも、端末側の宛先を消せば次の送信で無効と分かり Cloud Functions が登録を消す
        if (CTX) await CTX.db.collection('pushSubs').doc(await subId(sub.endpoint)).delete().catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
    } catch (e) {}
    lsSet(SAVED_KEY, null);
    setBadge(0);
    await auth.signOut();
  }
  function setBadge(n) {
    try { if (navigator.setAppBadge) (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch (e) {}
  }

  // ── 案内の帯 ──
  const ICON_SHARE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="vertical-align:-3px"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_ADD = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="vertical-align:-3px"><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICON_BELL = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function who() { return CTX && CTX.role === 'admin' ? '病院からの新しい相談・返信' : 'Meets Medical からの返信'; }
  function deniedHelp() {
    if (IOS) return '「設定」アプリ →「通知」→「介護施設検索」でオンにできます。';
    if (ANDROID) return standalone() ? 'アイコンを長押し →「アプリ情報」→「通知」でオンにできます。' : 'Chrome の右上のメニュー →「設定」→「サイトの設定」→「通知」で許可できます。';
    return 'アドレスバー左のマーク（サイト情報）から「通知」を許可にできます。';
  }
  function bar(text, actions) {
    return `<div class="kp-bar" role="status"><span class="kp-ic">${ICON_BELL}</span><span class="kp-tx">${text}</span><span class="kp-act">${actions}</span>
      <button type="button" class="kp-x" onclick="KaigoPush.hideBar()" aria-label="この案内を閉じる">×</button></div>`;
  }
  async function render() {
    if (!CTX) return;
    let st = 'off';
    try { st = await status(); } catch (e) {}
    if (MOUNT) {
      const hidden = Number(lsGet(HIDE_KEY) || 0) > Date.now();
      const here = MOBILE ? 'このスマホ' : 'このパソコン';
      let html = '';
      if (hidden) html = '';
      else if (st === 'install') html = bar(`ホーム画面に追加すると、アプリのように開けて、${who()}が通知で届きます`, '<button type="button" class="kp-btn" onclick="KaigoPush.showGuide()">追加のしかた</button>');
      else if (st === 'line') html = bar('LINE の中で開いています。メニューの「ブラウザで開く」を選ぶと、ホーム画面への追加と通知の設定ができます', '');
      else if (st === 'off') html = bar(`${who()}を、${here}に通知で届けます`, `<button type="button" class="kp-btn" onclick="KaigoPush.enableFromUI(this)">通知をオンにする</button>`);
      else if (st === 'denied') html = bar('通知が「許可しない」になっています。' + deniedHelp(), '');
      else if (st === 'on' && ANDROID && INSTALL_EVT && !standalone()) html = bar('ホーム画面に追加すると、アプリのようにすぐ開けます', '<button type="button" class="kp-btn" onclick="KaigoPush.install()">ホーム画面に追加</button>');
      MOUNT.innerHTML = html;
    }
    if (PANEL) renderPanel(st);
  }
  function hideBar() { lsSet(HIDE_KEY, String(Date.now() + 14 * 864e5)); if (MOUNT) MOUNT.innerHTML = ''; }
  async function enableFromUI(btn) {
    if (btn) btn.disabled = true;
    try {
      const ok = await enable();
      toast(ok ? '通知をオンにしました。確認の通知を1通送ります' : '通知が許可されませんでした');
    } catch (e) { console.error(e); toast('通知をオンにできませんでした: ' + (e.message || e)); }
    finally { if (btn) btn.disabled = false; }
  }
  async function install() {
    if (!INSTALL_EVT) { showGuide(); return; }
    INSTALL_EVT.prompt();
    try { await INSTALL_EVT.userChoice; } catch (e) {}
    INSTALL_EVT = null;
    render();
  }
  function showGuide() {
    const steps = IOS ? [
      'Safari でこの画面を開きます（LINE などのアプリの中ではなく Safari）',
      `画面下の「共有」ボタン ${ICON_SHARE} を押します（見当たらないときは「…」を押すと出てきます）`,
      `「ホーム画面に追加」${ICON_ADD} を押し、右上の「追加」を押します（見当たらないときは下にスクロール）`,
      'ホーム画面にできた「介護施設検索」から開いて、ログインします（このアプリではログインしたままになります）',
      '「通知をオンにする」を押して、「許可」を選びます',
    ] : ANDROID ? [
      'Chrome でこの画面を開きます',
      '右上のメニュー（縦の3つの点）→「ホーム画面に追加」または「アプリをインストール」を押します',
      'ホーム画面にできた「介護施設検索」から開いて、ログインします',
      '「通知をオンにする」を押して、「許可」を選びます',
    ] : [
      'Chrome または Edge でこの画面を開きます',
      'アドレスバー右端の「インストール」マーク、またはメニューの「アプリをインストール」を押します',
      '「通知をオンにする」を押して、「許可」を選びます',
    ];
    const el = document.createElement('div');
    el.className = 'kp-modal';
    el.innerHTML = `<div class="kp-card" role="dialog" aria-modal="true" aria-labelledby="kp-ttl">
      <div class="kp-ttl" id="kp-ttl">ホーム画面に追加する${IOS ? '（iPhone）' : ANDROID ? '（Android）' : ''}</div>
      <p class="kp-lead">LINE のように、アイコンを押すとすぐチャットが開き、${who()}が通知で届くようになります。</p>
      <ol class="kp-steps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
      ${IOS ? '<p class="kp-note">iOS 16.4 以降が必要です（「設定」→「一般」→「情報」で確認できます）。</p>' : ''}
      <button type="button" class="kp-btn kp-close">閉じる</button></div>`;
    el.addEventListener('click', e => { if (e.target === el || e.target.classList.contains('kp-close')) el.remove(); });
    document.body.appendChild(el);
  }

  // ── 管理画面「通知先」の中の設定欄（この端末の状態・テスト・通知が届く端末の一覧） ──
  function renderPanel(st) {
    const label = { on: 'この端末：オン', off: 'この端末：オフ', denied: 'この端末：通知が「許可しない」になっています', install: 'この端末：iPhone はホーム画面に追加したアプリでオンにできます', line: 'この端末：LINE の中では設定できません', unsupported: 'この端末・ブラウザは通知に対応していません' }[st] || '';
    PANEL.querySelector('[data-kp=me]').textContent = label;
    PANEL.querySelector('[data-kp=on]').hidden = st !== 'off';
    PANEL.querySelector('[data-kp=test]').hidden = st !== 'on';
    PANEL.querySelector('[data-kp=off]').hidden = st !== 'on';
    PANEL.querySelector('[data-kp=guide]').hidden = st !== 'install';
    PANEL.querySelector('[data-kp=help]').textContent = st === 'denied' ? deniedHelp() : '';
  }
  function mountPanel(el) {
    PANEL = el;
    el.innerHTML = `<div class="kp-panel-row"><span data-kp="me" class="kp-me"></span>
      <button type="button" data-kp="on" class="kp-btn" onclick="KaigoPush.enableFromUI(this)" hidden>オンにする</button>
      <button type="button" data-kp="guide" class="kp-btn" onclick="KaigoPush.showGuide()" hidden>追加のしかた</button>
      <button type="button" data-kp="test" class="kp-btn kp-sub" onclick="KaigoPush.testFromUI(this)" hidden>テスト通知を送る</button>
      <button type="button" data-kp="off" class="kp-btn kp-sub" onclick="KaigoPush.disableFromUI(this)" hidden>この端末をオフ</button></div>
      <p data-kp="help" class="kp-help"></p>
      <div class="kp-dev-ttl">通知が届く端末</div><div data-kp="devices" class="kp-devs"><span class="kp-muted">読み込み中...</span></div>`;
    render();
    if (UNSUB_DEV) UNSUB_DEV();
    const q = CTX.role === 'admin' ? CTX.db.collection('pushSubs') : CTX.db.collection('pushSubs').where('uid', '==', CTX.user.uid);
    UNSUB_DEV = q.onSnapshot(s => renderDevices(s.docs.map(d => ({ id: d.id, ...d.data() }))), () => renderDevices(null));
  }
  function unmountPanel() { if (UNSUB_DEV) { UNSUB_DEV(); UNSUB_DEV = null; } PANEL = null; }
  async function renderDevices(list) {
    if (!PANEL) return;
    const box = PANEL.querySelector('[data-kp=devices]');
    if (!list) { box.innerHTML = '<span class="kp-muted">読み込めませんでした</span>'; return; }
    if (!list.length) { box.innerHTML = '<span class="kp-muted">まだありません（アプリやブラウザで「通知をオンにする」を押した端末がここに出ます）</span>'; return; }
    const sub = await currentSub();
    const mine = sub ? await subId(sub.endpoint) : '';
    const t = x => (x.updatedAt && x.updatedAt.toMillis) ? x.updatedAt.toMillis() : 0;
    const fmt = x => { const d = x.updatedAt && x.updatedAt.toDate ? x.updatedAt.toDate() : null; return d ? `${d.getMonth() + 1}/${d.getDate()}` : ''; };
    list.sort((a, b) => (a.role === b.role ? t(b) - t(a) : a.role === 'admin' ? -1 : 1));
    box.innerHTML = list.map(x => `<div class="kp-dev"><span class="kp-dev-who">${x.role === 'admin' ? 'Meets Medical' : esc(x.hospitalName || '病院')}${x.name ? '・' + esc(x.name) : ''}</span>
      <span class="kp-dev-what">${esc(x.device || '')}${x.id === mine ? '<b>（この端末）</b>' : ''}　${fmt(x)}</span>
      ${CTX.role === 'admin' ? `<button type="button" class="kp-dev-del" onclick="KaigoPush.removeDevice('${esc(x.id)}')">外す</button>` : ''}</div>`).join('');
  }
  async function removeDevice(id) {
    if (!confirm('この端末への通知を止めますか？（その端末でもう一度「通知をオンにする」を押せば戻せます）')) return;
    try { await CTX.db.collection('pushSubs').doc(id).delete(); toast('通知を止めました'); }
    catch (e) { toast('止められませんでした: ' + (e.message || e)); }
  }
  async function testFromUI(btn) {
    btn.disabled = true;
    try { await test(); toast('テスト通知を送りました（数秒で届きます）'); }
    catch (e) { toast(e.message || String(e)); }
    finally { btn.disabled = false; }
  }
  async function disableFromUI(btn) {
    btn.disabled = true;
    try { await disable(); toast('この端末への通知をオフにしました'); }
    finally { btn.disabled = false; }
  }

  const CSS = `
  .kp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px;padding:10px 12px;border:2px solid var(--kp-ink,#2b2b2b);border-radius:12px;background:var(--kp-bg,#e4f2fa);color:var(--kp-ink,#2b2b2b);font-size:13px;line-height:1.5;position:relative;}
  .kp-ic{color:var(--kp-accent,#2c7ba6);display:inline-flex;flex-shrink:0;}
  .kp-tx{flex:1 1 180px;font-weight:700;padding-right:18px;}
  .kp-act{display:flex;gap:6px;flex-wrap:wrap;}
  .kp-btn{border:2px solid var(--kp-ink,#2b2b2b);background:var(--kp-accent,#2c7ba6);color:#fff;border-radius:100px;padding:6px 14px;font-size:13px;font-weight:800;font-family:inherit;cursor:pointer;white-space:nowrap;}
  .kp-btn:disabled{opacity:.5;cursor:default;}
  .kp-btn.kp-sub{background:#fff;color:var(--kp-ink,#2b2b2b);}
  .kp-x{position:absolute;top:4px;right:6px;border:none;background:none;font-size:18px;line-height:1;color:#7a7a75;cursor:pointer;padding:4px;}
  .kp-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;}
  .kp-card{background:#fff;color:#2b2b2b;border:2px solid #2b2b2b;border-radius:16px;max-width:440px;width:100%;max-height:calc(100dvh - 32px);overflow-y:auto;padding:20px;}
  .kp-ttl{font-size:17px;font-weight:900;}
  .kp-lead{font-size:13px;color:#5f5f5a;margin:6px 0 12px;line-height:1.6;}
  .kp-steps{margin:0 0 12px 1.4em;padding:0;font-size:15px;line-height:1.7;list-style:decimal;}
  .kp-steps li{margin-bottom:8px;}
  .kp-note{font-size:12px;color:#7a7a75;margin-bottom:12px;}
  .kp-card .kp-close{display:block;margin-left:auto;}
  .kp-panel-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;}
  .kp-me{font-size:13px;font-weight:700;margin-right:4px;}
  .kp-help{font-size:12px;color:#7a7a75;margin-top:4px;}
  .kp-help:empty{display:none;}
  .kp-dev-ttl{font-size:12px;font-weight:700;color:#5f5f5a;margin-top:10px;}
  .kp-devs{margin-top:4px;border:1px solid #e7e7e3;border-radius:8px;background:#fff;padding:6px 8px;max-height:160px;overflow-y:auto;font-size:13px;}
  .kp-dev{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 0;border-bottom:1px solid #f1f1ee;}
  .kp-dev:last-child{border-bottom:none;}
  .kp-dev-who{font-weight:700;}
  .kp-dev-what{color:#7a7a75;font-size:12px;}
  .kp-dev-del{margin-left:auto;border:1px solid #cfcfca;background:#fff;border-radius:6px;font-size:12px;padding:2px 8px;cursor:pointer;font-family:inherit;}
  .kp-muted{color:#9a9a95;font-size:12px;}
  `;

  async function init(ctx) {
    CTX = ctx;
    MOUNT = ctx.mount || null;
    if (!document.getElementById('kp-css')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'kp-css', textContent: CSS }));
    if ('serviceWorker' in navigator) {
      // 通知を押したとき、すでに開いている画面ではページを読み直さずにその相談へ切り替える
      navigator.serviceWorker.addEventListener('message', ev => {
        if (!ev.data || ev.data.type !== 'kaigo-open') return;
        if (typeof window.kaigoOpenFromPush === 'function') window.kaigoOpenFromPush(ev.data.hash || '');
        else if (ev.data.hash) location.hash = ev.data.hash;
      });
    }
    // 通知をオンにした端末は、開くたびに宛先を確かめて保存し直す（端末側で宛先が変わることがあるため。1日1回まで）
    if (pushSupported() && !IN_LINE && !(IOS && !standalone())) {
      const sub = await currentSub();
      if (sub && Notification.permission === 'granted') save(sub, false).catch(e => console.warn('push save', e));
    }
    render();
  }

  window.KaigoPush = { init, enable, disable, test, signOut, setBadge, status, render, hideBar, enableFromUI, testFromUI, disableFromUI, install, showGuide, mountPanel, unmountPanel, removeDevice, isStandalone: standalone };
})();
