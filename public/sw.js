// 通知専用の Service Worker（2026-10-30 小池さん指示：ホーム画面のアプリに LINE のように通知を届ける）。
// 2026-10-07 に「Service Worker は入れない」としたのは、ページの保存（キャッシュ）で更新が遅れるのを避けるため。
// ここでは fetch を扱わない＝ページは今まで通り毎回サーバーから読むので、その心配はない。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const jobs = [self.registration.showNotification(d.title || '介護施設検索', {
    body: d.body || '新しいメッセージがあります',
    tag: d.tag || 'kaigo',
    renotify: true,
    icon: 'icon-192.png',
    data: { url: d.url || 'kaigo-login.html' },
  })];
  // ホーム画面のアイコンの数字（未読の相談数）。iPhone はアプリを開いていなくても、ここで付ける必要がある
  const nav = self.navigator;
  if (typeof d.badge === 'number' && nav && nav.setAppBadge) jobs.push((d.badge > 0 ? nav.setAppBadge(d.badge) : nav.clearAppBadge()).catch(() => {}));
  e.waitUntil(Promise.all(jobs));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || 'kaigo-login.html', self.registration.scope);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 同じ画面が開いていれば前に出してその相談に切り替える（画面をもう一枚開かない）
    for (const w of wins) {
      const u = new URL(w.url);
      if (u.origin === url.origin && u.pathname === url.pathname) {
        await w.focus();
        w.postMessage({ type: 'kaigo-open', hash: url.hash });
        return;
      }
    }
    for (const w of wins) {
      if (new URL(w.url).origin !== url.origin || !('navigate' in w)) continue;
      try { const nw = await w.navigate(url.href); if (nw) { await nw.focus(); return; } } catch (_) {}
    }
    await self.clients.openWindow(url.href);
  })());
});
