// 空室相談（病院 → Meets Medical へのチャット形式の相談）の共通処理。
// 検索ページ（相談フォーム）、病院側の相談履歴ページ、管理画面の空室相談タブで共有する。
//
// データ構造（Firestore）
//   consultations/{cid}
//     hospitalId, hospitalName, createdBy(uid), createdByName, createdAt, updatedAt,
//     status: 'open'(新規) | 'working'(対応中) | 'answered'(回答済) | 'closed'(終了),
//     conditions: { care:[], areas:[], areaOther:'', budget:[], needs:[], detail:'' },
//     facilities: [{ id, name }]          … 検索結果でチェックしていた施設（「ここの情報を知りたい」）
//     lastMessageAt, lastMessageBy('hospital'|'admin'), lastMessageText, messageCount,
//     unreadForAdmin, unreadForHospital  … 相手の新着があるか（通知バッジ用）
//   consultations/{cid}/messages/{mid}
//     by('hospital'|'admin'), uid, name, text, createdAt
(function (global) {
  'use strict';

  // 兵頭さん指定の選択肢（2026-09-26）。すべて複数選択可
  const CARE   = ['要支援', '要介護1〜2', '要介護3〜5', '生活保護', '2人入居'];
  const BUDGET = ['初期費用なし', '月12万円以下', '月15万円以下', '月20万円以下', '月25万円以下', '月25万円以上可'];
  const NEEDS  = ['駅近', '24時間看護師', '24時間介護士常駐', '夫婦入居可・2人部屋あり', '認知症', '精神疾患', 'インスリン',
                  '在宅酸素療法', '胃ろうor経鼻', 'カテーテル・尿バルーン', 'たん吸引', 'ペースメーカー', '人工透析', '特になし'];
  const OTHER_AREA = 'その他';
  const STATUS = { open: '新規', working: '対応中', answered: '回答済', closed: '終了' };
  const STATUS_ORDER = ['open', 'working', 'answered', 'closed'];
  const DETAIL_NOTE = '※名前などの個人情報は記載しないでください。';
  const LABEL_HINT  = 'イニシャル（例：T.K）。本名は書かないでください';
  const LABEL_MAX   = 6;
  // イニシャルの表記ゆれを揃える：全角→半角、空白除去、大文字化、「・」「，」→「.」
  function normalizeInitials(s) {
    return String(s || '')
      .replace(/[Ａ-Ｚａ-ｚ．]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[・，,]/g, '.')
      .replace(/\s+/g, '')
      .toUpperCase();
  }
  const INITIALS_RE = /^[A-Z](\.?[A-Z]){0,3}\.?$/;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 希望エリアの選択肢：検索ページと同じ市の一覧（表示中の府県ぶん）＋その他
  function areaOptions(cityMap, shownPrefs) {
    const list = [];
    (shownPrefs || []).forEach(p => (cityMap[p] || []).forEach(c => list.push(c)));
    list.push(OTHER_AREA);
    return list;
  }

  function toDate(ts) {
    if (!ts) return null;
    if (ts.toDate) return ts.toDate();
    const d = new Date(ts);
    return isNaN(d) ? null : d;
  }
  function fmtDate(ts) {
    const d = toDate(ts);
    if (!d) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtShort(ts) {
    const d = toDate(ts);
    if (!d) return '';
    const now = new Date(), p = n => String(n).padStart(2, '0');
    return d.toDateString() === now.toDateString() ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // 入力チェック。必須：相談条件・希望エリア・費用・こだわり（「特になし」で可）。詳細は任意
  function validate(c) {
    const errs = [];
    const label = normalizeInitials(c.caseLabel);
    if (!label) errs.push('この方のイニシャルを入力してください（例：T.K）');
    else if (label.length > LABEL_MAX || !INITIALS_RE.test(label)) errs.push('イニシャルは英字で入力してください（例：T.K、A.S、K）');
    if (!c.care.length)   errs.push('相談条件を1つ以上選んでください');
    if (!c.areas.length)  errs.push('希望エリアを1つ以上選んでください');
    if (c.areas.includes(OTHER_AREA) && !String(c.areaOther || '').trim()) errs.push('希望エリア「その他」の内容を入力してください');
    if (!c.budget.length) errs.push('費用を1つ以上選んでください');
    if (!c.needs.length)  errs.push('こだわり・医療体制を1つ以上選んでください（該当なしは「特になし」）');
    if ((c.detail || '').length > 2000) errs.push('詳細は2000文字以内にしてください');
    return errs;
  }

  function areasText(c) {
    return c.areas.map(a => a === OTHER_AREA && c.areaOther ? `その他（${c.areaOther}）` : a).join('、');
  }

  // 最初のメッセージ本文（相談内容の要約）。管理画面・履歴の両方でそのまま読める形にする
  function firstMessageText(c, facilities) {
    const lines = [];
    if (normalizeInitials(c.caseLabel)) { lines.push('■ イニシャル：' + normalizeInitials(c.caseLabel)); lines.push(''); }
    if (facilities && facilities.length) {
      lines.push('■ この施設の情報を知りたいです');
      facilities.forEach(f => lines.push(`　・${f.name}`));
      lines.push('');
    }
    lines.push('■ 相談条件：' + c.care.join('、'));
    lines.push('■ 希望エリア：' + areasText(c));
    lines.push('■ 費用：' + c.budget.join('、'));
    lines.push('■ こだわり・医療体制：' + c.needs.join('、'));
    if ((c.detail || '').trim()) { lines.push('■ 詳細：'); lines.push(c.detail.trim()); }
    return lines.join('\n');
  }

  function shortText(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  // 相談を新規作成（相談本体＋最初のメッセージを同時に書く）
  async function create(db, user, c, facilities) {
    const fb = global.firebase;
    const now = fb.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('consultations').doc();
    const text = firstMessageText(c, facilities);
    const batch = db.batch();
    batch.set(ref, {
      hospitalId: user.hospitalId || '',
      hospitalName: user.hospitalName || '',
      createdBy: user.uid,
      createdByName: user.name || '',
      createdAt: now, updatedAt: now,
      status: 'open',
      caseLabel: normalizeInitials(c.caseLabel),
      conditions: { care: c.care, areas: c.areas, areaOther: c.areaOther || '', budget: c.budget, needs: c.needs, detail: (c.detail || '').trim() },
      facilities: (facilities || []).map(f => ({ id: f.id, name: f.name })),
      lastMessageAt: now, lastMessageBy: 'hospital', lastMessageText: shortText(text, 80), messageCount: 1,
      unreadForAdmin: true, unreadForHospital: false,
    });
    batch.set(ref.collection('messages').doc(), { by: 'hospital', uid: user.uid, name: user.name || user.hospitalName || '', text, createdAt: now });
    await batch.commit();
    return ref.id;
  }

  // 返信を追加。by='hospital' なら管理者側を未読に、'admin' なら病院側を未読にする
  async function send(db, cid, by, user, text, extra) {
    const fb = global.firebase;
    const now = fb.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('consultations').doc(cid);
    const upd = {
      lastMessageAt: now, lastMessageBy: by, lastMessageText: shortText(text, 80), updatedAt: now,
      messageCount: fb.firestore.FieldValue.increment(1),
    };
    if (by === 'admin') { upd.unreadForHospital = true; upd.unreadForAdmin = false; }
    else { upd.unreadForAdmin = true; upd.unreadForHospital = false; }
    Object.assign(upd, extra || {});
    const batch = db.batch();
    batch.set(ref.collection('messages').doc(), { by, uid: user.uid, name: user.name || user.hospitalName || '', text, createdAt: now });
    batch.update(ref, upd);
    await batch.commit();
  }

  async function markRead(db, cid, side) {
    const field = side === 'admin' ? 'unreadForAdmin' : 'unreadForHospital';
    await db.collection('consultations').doc(cid).update({ [field]: false });
  }

  async function setStatus(db, cid, status) {
    const fb = global.firebase;
    await db.collection('consultations').doc(cid).update({ status, updatedAt: fb.firestore.FieldValue.serverTimestamp() });
  }

  // 「誰の件か」の表示名（イニシャル＋さんの件）。イニシャルが無い古い相談は送信日で表す
  function caseName(d) {
    const l = String(d.caseLabel || '').trim();
    return l ? l + 'さんの件' : '相談（' + fmtShort(d.createdAt) + '）';
  }
  // 相談ごとの識別色（IDから決める。同じ相談はいつも同じ色）
  function caseColor(id) {
    let h = 0;
    for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h}, 55%, 48%)`;
  }

  // 相談内容の要約カード
  function conditionsHTML(d) {
    const c = d.conditions || { care: [], areas: [], budget: [], needs: [] };
    const chip = t => `<span class="cs-chip-ro">${esc(t)}</span>`;
    const row = (label, items) => `<div class="cs-row"><div class="cs-row-lbl">${label}</div><div class="cs-row-val">${items.length ? items.map(chip).join('') : '<span class="cs-none">—</span>'}</div></div>`;
    const areas = (c.areas || []).map(a => a === OTHER_AREA && c.areaOther ? `その他（${c.areaOther}）` : a);
    const facs = (d.facilities || []);
    return `<div class="cs-cond">
      ${(d.caseLabel || '').trim() ? `<div class="cs-row"><div class="cs-row-lbl">イニシャル</div><div class="cs-row-val"><span class="cs-chip-ro" style="border-color:${caseColor(d.id)};color:${caseColor(d.id)}">${esc(d.caseLabel)}さんの件</span></div></div>` : ''}
      ${facs.length ? `<div class="cs-row"><div class="cs-row-lbl">情報を知りたい施設</div><div class="cs-row-val">${facs.map(f => `<a class="cs-chip-ro cs-chip-link" href="kaigo-facility-view.html?id=${esc(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div></div>` : ''}
      ${row('相談条件', c.care || [])}
      ${row('希望エリア', areas)}
      ${row('費用', c.budget || [])}
      ${row('こだわり・医療体制', c.needs || [])}
      ${(c.detail || '').trim() ? `<div class="cs-row"><div class="cs-row-lbl">詳細</div><div class="cs-row-val cs-detail">${esc(c.detail)}</div></div>` : ''}
    </div>`;
  }

  // チャットの吹き出し。mySide は閲覧者の側（'hospital'|'admin'）
  function messagesHTML(msgs, mySide) {
    if (!msgs.length) return '<div class="cs-empty">まだメッセージはありません</div>';
    return msgs.map(m => {
      const mine = m.by === mySide;
      const who = m.by === 'admin' ? 'Meets Medical' : (m.name || '病院');
      return `<div class="cs-msg ${mine ? 'mine' : 'theirs'}">
        <div class="cs-msg-meta">${esc(who)}　${fmtDate(m.createdAt)}</div>
        <div class="cs-msg-body">${esc(m.text)}</div>
      </div>`;
    }).join('');
  }

  // 一覧・スレッド共通のCSS（各ページの <style> に混ぜて使う）
  const CSS = `
    .cs-cond { background:var(--g50,#fbfbf9); border:1px solid var(--g200,#e7e7e3); border-radius:12px; padding:12px 14px; margin-bottom:12px; }
    .cs-row { display:flex; gap:10px; padding:5px 0; border-bottom:1px dashed var(--g200,#e7e7e3); font-size:13px; }
    .cs-row:last-child { border-bottom:none; }
    .cs-row-lbl { flex:0 0 120px; color:var(--g500,#7a7a75); font-weight:700; font-size:12px; padding-top:3px; }
    .cs-row-val { flex:1; display:flex; flex-wrap:wrap; gap:4px; }
    .cs-chip-ro { font-size:12px; font-weight:700; padding:3px 9px; border-radius:100px; background:#fff; border:1px solid var(--g300,#cfcfca); color:var(--ink,#2b2b2b); }
    .cs-chip-link { color:var(--blue-d,#2c7ba6); border-color:var(--blue-d,#2c7ba6); background:var(--blue-l,#e4f2fa); text-decoration:none; }
    .cs-none { color:var(--g400,#9a9a95); }
    .cs-detail { white-space:pre-wrap; line-height:1.7; }
    .cs-msg { max-width:78%; margin:8px 0; }
    .cs-msg.mine { margin-left:auto; }
    .cs-msg-meta { font-size:11px; color:var(--g500,#7a7a75); margin:0 6px 3px; }
    .cs-msg.mine .cs-msg-meta { text-align:right; }
    .cs-msg-body { white-space:pre-wrap; line-height:1.7; font-size:14px; padding:10px 14px; border-radius:14px; border:1.5px solid var(--ink,#2b2b2b); background:#fff; }
    .cs-msg.mine .cs-msg-body { background:var(--blue-l,#e4f2fa); }
    .cs-empty { color:var(--g400,#9a9a95); font-size:13px; text-align:center; padding:20px; }
    .cs-status { font-size:11px; font-weight:800; padding:2px 8px; border-radius:100px; border:1px solid; white-space:nowrap; }
    .cs-status.open { color:#b91c1c; border-color:#fca5a5; background:#fee2e2; }
    .cs-status.working { color:#92400e; border-color:#fcd34d; background:#fef3c7; }
    .cs-status.answered { color:#1d5c8a; border-color:#9ccfec; background:#e4f2fa; }
    .cs-status.closed { color:#6b7280; border-color:#d1d5db; background:#f3f4f6; }
    .cs-unread { display:inline-block; min-width:18px; height:18px; padding:0 5px; border-radius:100px; background:#e88494; color:#fff; font-size:11px; font-weight:800; line-height:18px; text-align:center; }
  `;

  function statusBadge(status) {
    const s = STATUS[status] ? status : 'open';
    return `<span class="cs-status ${s}">${STATUS[s]}</span>`;
  }

  global.KaigoConsult = { CARE, BUDGET, NEEDS, OTHER_AREA, STATUS, STATUS_ORDER, DETAIL_NOTE, LABEL_HINT, LABEL_MAX, CSS,
    esc, areaOptions, validate, firstMessageText, areasText, fmtDate, fmtShort, shortText, caseName, caseColor, normalizeInitials,
    create, send, markRead, setStatus, conditionsHTML, messagesHTML, statusBadge };
})(window);
