// 空室相談（病院 → Meets Medical へのチャット形式の相談）の共通処理。
// 検索ページ（相談フォーム）、病院側の相談履歴ページ、管理画面の空室相談タブで共有する。
//
// データ構造（Firestore）
//   consultations/{cid}
//     hospitalId, hospitalName, createdBy(uid), createdByName, createdAt, updatedAt,
//     status: 'open'(新規) | 'working'(対応中) | 'answered'(回答済) | 'closed'(終了) | 'withdrawn'(取り下げ：病院側が取り下げた),
//     conditions: { care:[], areas:[], areaOther:'', budget:[], needs:[], detail:'' },
//     facilities: [{ id, name }]          … 検索結果でチェックしていた施設（「ここの情報を知りたい」）
//     lastMessageAt, lastMessageBy('hospital'|'admin'), lastMessageText, messageCount,
//     unreadForAdmin, unreadForHospital  … 相手の新着があるか（通知バッジ用）
//   consultations/{cid}/messages/{mid}
//     by('hospital'|'admin'), uid, name, text, createdAt,
//     editedAt（直したとき）, deleted/deletedAt（取り消したとき。text は空にする）, kind:'conditions'（条件修正の記録）
//   meta/consultSettings
//     autoReply … 相談直後に Meets Medical 役で常に表示する自動返信の文面（管理画面で変更）
(function (global) {
  'use strict';

  // 兵頭さん指定の選択肢（2026-09-26）。すべて複数選択可
  const CARE   = ['要支援', '要介護1〜2', '要介護3〜5', '生活保護', '2人入居'];
  const BUDGET = ['初期費用なし', '月12万円以下', '月15万円以下', '月20万円以下', '月25万円以下', '月25万円以上可'];
  const NEEDS  = ['駅近', '24時間看護師', '24時間介護士常駐', '夫婦入居可・2人部屋あり', '認知症', '精神疾患', 'インスリン',
                  '在宅酸素療法', '胃ろうor経鼻', 'カテーテル・尿バルーン', 'たん吸引', 'ペースメーカー', '人工透析'];   // 任意（兵頭さん 2026-09-26）
  const OTHER_AREA = 'その他';
  const STATUS = { open: '新規', working: '対応中', answered: '回答済', closed: '終了', withdrawn: '取り下げ' };
  const STATUS_ORDER = ['open', 'working', 'answered', 'closed', 'withdrawn'];
  const DETAIL_NOTE = '※名前などの個人情報は記載しないでください。';
  // 件名の「名前」（任意・2026-10-01 小池さん指示で復活、文言は兵頭さん 2026-10-02）：苗字かイニシャル。入れなくても送れる
  const LABEL_HINT  = '苗字もしくはイニシャルでお願いします。（例：T.K、田中）';
  const LABEL_NOTE  = '※記載なしでも次に進めます。';   // 赤字で添える
  // 送信後の案内（兵頭さん 2026-09-27）：サマリー・診療情報提供書は FAX で
  const FAX = '06-7635-8813';
  const SENT_NOTE = 'サマリーや診療情報提供書（診情）がある場合は、FAX ' + FAX + ' へお送りください。';
  // 取り消したメッセージの代わりに出す文
  const DELETED_TEXT = 'メッセージを取り消しました';
  const WITHDRAWN_TEXT = 'この相談を取り下げました。';
  // 自動返信の既定文。実際に保存はせず、相談の最初のメッセージの直後に画面上で常に表示する（文面は管理画面で変更できる）
  const AUTO_REPLY_DEFAULT = '受け付けました。担当者が確認して、ここに返信します。\nサマリーや診療情報提供書（診情）がある場合は、FAX ' + FAX + ' へお送りください。';
  const SETTINGS_DOC = 'consultSettings';
  const settings = { autoReply: AUTO_REPLY_DEFAULT, loaded: false };
  const LABEL_MAX   = 10;
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

  // 入力チェック。必須：相談条件・希望エリア・費用。こだわり・医療体制と詳細は任意（兵頭さん 2026-09-26）
  function cleanLabel(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function validate(c) {
    const errs = [];
    if (cleanLabel(c.caseLabel).length > LABEL_MAX) errs.push(`名前は${LABEL_MAX}文字以内にしてください`);
    if (!c.care.length)   errs.push('相談条件を1つ以上選んでください');
    if (!c.areas.length)  errs.push('希望エリアを1つ以上選んでください');
    if (c.areas.includes(OTHER_AREA) && !String(c.areaOther || '').trim()) errs.push('希望エリア「その他」の内容を入力してください');
    if (!c.budget.length) errs.push('費用を1つ以上選んでください');
    if ((c.detail || '').length > 2000) errs.push('詳細は2000文字以内にしてください');
    return errs;
  }

  function areasText(c) {
    return c.areas.map(a => a === OTHER_AREA && c.areaOther ? `その他（${c.areaOther}）` : a).join('、');
  }

  // 最初のメッセージ本文（相談内容の要約）。管理画面・履歴の両方でそのまま読める形にする
  function firstMessageText(c, facilities) {
    const lines = [];
    if (facilities && facilities.length) {
      lines.push('■ この施設の情報を知りたいです');
      facilities.forEach(f => lines.push(`　・${f.name}`));
      lines.push('');
    }
    if (cleanLabel(c.caseLabel)) lines.push('■ 名前：' + cleanLabel(c.caseLabel));
    lines.push('■ 相談条件：' + c.care.join('、'));
    lines.push('■ 希望エリア：' + areasText(c));
    lines.push('■ 費用：' + c.budget.join('、'));
    lines.push('■ こだわり・医療体制：' + (c.needs.length ? c.needs.join('、') : '特になし'));
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
      caseLabel: cleanLabel(c.caseLabel),
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

  // 自動返信などの設定を読む。未設定・読めないときは既定文で動く
  async function loadSettings(db) {
    try {
      const s = await db.collection('meta').doc(SETTINGS_DOC).get();
      const d = (s && s.exists && s.data()) || {};
      settings.autoReply = String(d.autoReply || '').trim() || AUTO_REPLY_DEFAULT;
    } catch (e) { settings.autoReply = AUTO_REPLY_DEFAULT; }
    settings.loaded = true;
    return settings;
  }
  async function saveSettings(db, user, patch) {
    const fb = global.firebase;
    const autoReply = String(patch.autoReply || '').trim() || AUTO_REPLY_DEFAULT;
    await db.collection('meta').doc(SETTINGS_DOC).set({ autoReply, updatedAt: fb.firestore.FieldValue.serverTimestamp(), updatedBy: user.uid }, { merge: true });
    settings.autoReply = autoReply;
    return settings;
  }

  // 自分のメッセージの本文を直す。最新のメッセージなら一覧の「最後のメッセージ」も直し、相手側を未読にして変更に気づけるようにする
  async function editMessage(db, cid, mid, by, text, isLast) {
    const fb = global.firebase;
    const now = fb.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('consultations').doc(cid);
    const upd = { updatedAt: now, [by === 'admin' ? 'unreadForHospital' : 'unreadForAdmin']: true };
    if (isLast) upd.lastMessageText = shortText(text, 80);
    const batch = db.batch();
    batch.update(ref.collection('messages').doc(mid), { text, editedAt: now });
    batch.update(ref, upd);
    await batch.commit();
  }
  // メッセージを取り消す。本文は消して「取り消しました」の印だけ残す（相手の画面からも本文が消える）
  async function withdrawMessage(db, cid, mid, by, isLast) {
    const fb = global.firebase;
    const now = fb.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('consultations').doc(cid);
    const upd = { updatedAt: now, [by === 'admin' ? 'unreadForHospital' : 'unreadForAdmin']: true };
    if (isLast) upd.lastMessageText = DELETED_TEXT;
    const batch = db.batch();
    batch.update(ref.collection('messages').doc(mid), { text: '', deleted: true, deletedAt: now });
    batch.update(ref, upd);
    await batch.commit();
  }
  // 相談条件の修正（病院側）。条件を書き換え、修正後の内容をメッセージとして残す（Meets Medical 側に新着が付く）
  async function updateConditions(db, cid, user, c, facilities) {
    const fb = global.firebase;
    const now = fb.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('consultations').doc(cid);
    const cond = { care: c.care, areas: c.areas, areaOther: c.areaOther || '', budget: c.budget, needs: c.needs, detail: (c.detail || '').trim() };
    const text = '相談条件を修正しました。\n' + firstMessageText({ ...cond, caseLabel: c.caseLabel }, facilities || []);
    const batch = db.batch();
    batch.set(ref.collection('messages').doc(), { by: 'hospital', uid: user.uid, name: user.name || user.hospitalName || '', text, kind: 'conditions', createdAt: now });
    batch.update(ref, {
      conditions: cond, caseLabel: cleanLabel(c.caseLabel), updatedAt: now,
      lastMessageAt: now, lastMessageBy: 'hospital', lastMessageText: shortText(text, 80),
      messageCount: fb.firestore.FieldValue.increment(1), unreadForAdmin: true, unreadForHospital: false,
    });
    await batch.commit();
  }
  // 相談の取り下げ（病院側）。ステータスを「取り下げ」にし、記録のメッセージを残す（Meets Medical 側に新着が付く）。以後は病院側から返信・修正できない
  async function withdrawConsultation(db, cid, user) {
    const fb = global.firebase;
    const now = fb.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('consultations').doc(cid);
    const batch = db.batch();
    batch.set(ref.collection('messages').doc(), { by: 'hospital', uid: user.uid, name: user.name || user.hospitalName || '', text: WITHDRAWN_TEXT, kind: 'withdrawn', createdAt: now });
    batch.update(ref, {
      status: 'withdrawn', updatedAt: now,
      lastMessageAt: now, lastMessageBy: 'hospital', lastMessageText: WITHDRAWN_TEXT,
      messageCount: fb.firestore.FieldValue.increment(1), unreadForAdmin: true, unreadForHospital: false,
    });
    await batch.commit();
  }
  function isLastMessage(msgs, mid) { return !!msgs.length && msgs[msgs.length - 1].id === mid; }
  // 編集・取り消しができるメッセージか：自分側の通常メッセージだけ（最初の相談内容と、条件修正・取り下げの記録は対象外）
  function canEditMessage(m, mySide, index) { return !!m && m.by === mySide && !m.deleted && !m.kind && index > 0; }

  // 「どの件か」の表示名＝送信日時（兵頭さん 2026-09-26：送信時間が分かればよい）。例「9/26 13:35 の相談」
  function fmtShortDT(ts) {
    const d = toDate(ts);
    if (!d) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // 目印（イニシャルか苗字）があれば「田中（9/26 13:35）」、無ければ「9/26 13:35 の相談」
  function caseName(d) {
    const t = fmtShortDT(d.createdAt), l = cleanLabel(d.caseLabel);
    if (l) return `${l}（${t || '送信中'}）`;
    return t ? t + ' の相談' : '送信中の相談';
  }
  // 同じ分に複数送られた場合だけ ②③… を付けて区別する（id → 表示名）
  function uniqueCaseNames(items) {
    const byName = {};
    const sorted = [...items].sort((a, b) => {
      const t = x => (x.createdAt && x.createdAt.toMillis) ? x.createdAt.toMillis() : 0;
      return t(a) - t(b);
    });
    sorted.forEach(x => { const n = caseName(x); (byName[n] = byName[n] || []).push(x.id); });
    const out = {};
    const circ = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
    Object.entries(byName).forEach(([n, ids]) => ids.forEach((id, i) => { out[id] = ids.length > 1 ? `${n} ${circ[i + 1] || '(' + (i + 1) + ')'}` : n; }));
    return out;
  }
  // 丸いアイコンに入れる短い印：目印があればその先頭（3文字まで）、無ければ月/日
  function caseMark(d) {
    const l = cleanLabel(d.caseLabel);
    if (l) return l.length <= 3 ? l : l.slice(0, 2);
    const x = toDate(d.createdAt);
    return x ? `${x.getMonth() + 1}/${x.getDate()}` : '…';
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
      ${cleanLabel(d.caseLabel) ? row('名前', [cleanLabel(d.caseLabel)]) : ''}
      ${facs.length ? `<div class="cs-row"><div class="cs-row-lbl">情報を知りたい施設</div><div class="cs-row-val">${facs.map(f => `<a class="cs-chip-ro cs-chip-link" href="kaigo-facility-view.html?id=${esc(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div></div>` : ''}
      ${row('相談条件', c.care || [])}
      ${row('希望エリア', areas)}
      ${row('費用', c.budget || [])}
      ${row('こだわり・医療体制', c.needs || [])}
      ${(c.detail || '').trim() ? `<div class="cs-row"><div class="cs-row-lbl">詳細</div><div class="cs-row-val cs-detail">${esc(c.detail)}</div></div>` : ''}
    </div>`;
  }

  // 吹き出しの本文（取り消し済みなら印だけ）
  function messageBodyHTML(m) {
    return m.deleted ? `<span class="cs-deleted">${DELETED_TEXT}</span>` : esc(m.text);
  }
  // 自動返信の文面（FAX番号だけ太字にする）。text 省略時は設定の文面
  function autoReplyHTML(text) {
    return esc(text == null ? settings.autoReply : text).split(FAX).join('<b>' + FAX + '</b>');
  }
  function editedMark(m) { return (m.editedAt && !m.deleted) ? '<span class="cs-edited">編集済み</span>' : ''; }
  // 「編集」「取り消し」ボタン。使うページ側で <fn>Edit(mid) / <fn>Withdraw(mid) を用意する
  function messageActionsHTML(mid, fn) {
    return `<div class="cs-msg-act"><button type="button" onclick="${fn}Edit('${esc(mid)}')">編集</button><button type="button" onclick="${fn}Withdraw('${esc(mid)}')">取り消し</button></div>`;
  }
  // 吹き出しの中で直す入力欄。使うページ側で <fn>Draft(text) / <fn>Save(mid) / <fn>Cancel() を用意する
  function messageEditorHTML(mid, text, fn) {
    return `<div class="cs-msg-edit"><textarea rows="3" id="cs-edit-ta" oninput="${fn}Draft(this.value)">${esc(text)}</textarea>
      <div class="cs-msg-edit-act"><button type="button" class="cancel" onclick="${fn}Cancel()">やめる</button><button type="button" class="save" onclick="${fn}Save('${esc(mid)}')">保存する</button></div></div>`;
  }

  // チャットの吹き出し。mySide は閲覧者の側（'hospital'|'admin'）
  // opts.fn を渡すと自分側のメッセージに編集・取り消しボタンが付く。opts.autoReply を渡すと最初のメッセージの直後に自動返信を出す
  function messagesHTML(msgs, mySide, opts) {
    opts = opts || {};
    if (!msgs.length) return '<div class="cs-empty">まだメッセージはありません</div>';
    return msgs.map((m, i) => {
      const mine = m.by === mySide;
      const who = m.by === 'admin' ? 'Meets Medical' : (m.name || '病院');
      const editing = !!(opts.editingId && m.id === opts.editingId);
      const body = editing
        ? messageEditorHTML(m.id, opts.editingText != null ? opts.editingText : m.text, opts.fn)
        : `<div class="cs-msg-body">${messageBodyHTML(m)}</div>`;
      const act = (!editing && opts.fn && canEditMessage(m, mySide, i)) ? messageActionsHTML(m.id, opts.fn) : '';
      const auto = (i === 0 && opts.autoReply)
        ? `<div class="cs-msg ${mySide === 'admin' ? 'mine' : 'theirs'} auto"><div class="cs-msg-meta">Meets Medical（自動返信）　${fmtDate(m.createdAt)}</div><div class="cs-msg-body">${autoReplyHTML(opts.autoReply)}</div></div>`
        : '';
      return `<div class="cs-msg ${mine ? 'mine' : 'theirs'}${m.deleted ? ' deleted' : ''}">
        <div class="cs-msg-meta">${esc(who)}　${fmtDate(m.createdAt)}${editedMark(m)}</div>${body}${act}
      </div>` + auto;
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
    .cs-msg.mine .cs-msg-body { background:var(--pink-l,#fbe7ea); }
    .cs-empty { color:var(--g400,#9a9a95); font-size:13px; text-align:center; padding:20px; }
    .cs-status { font-size:11px; font-weight:800; padding:2px 8px; border-radius:100px; border:1px solid; white-space:nowrap; }
    .cs-status.open { color:#b91c1c; border-color:#fca5a5; background:#fee2e2; }
    .cs-status.working { color:#92400e; border-color:#fcd34d; background:#fef3c7; }
    .cs-status.answered { color:#1d5c8a; border-color:#9ccfec; background:#e4f2fa; }
    .cs-status.closed { color:#6b7280; border-color:#d1d5db; background:#f3f4f6; }
    .cs-status.withdrawn { color:#6b7280; border-color:#9ca3af; border-style:dashed; background:#f3f4f6; }
    .cs-unread { display:inline-block; min-width:18px; height:18px; padding:0 5px; border-radius:100px; background:#e88494; color:#fff; font-size:11px; font-weight:800; line-height:18px; text-align:center; }
    .cs-msg.auto .cs-msg-body { background:#fff; border-style:dashed; border-color:var(--g400,#9a9a95); color:var(--g700,#454541); }
    .cs-msg.deleted .cs-msg-body { background:var(--g100,#f1f1ee); border-style:dashed; border-color:var(--g300,#cfcfca); }
    .cs-deleted { color:var(--g500,#7a7a75); }
    .cs-edited { font-size:11px; color:var(--g500,#7a7a75); margin-left:6px; }
    .cs-msg-act { display:flex; gap:10px; margin:2px 6px 0; }
    .cs-msg.mine .cs-msg-act { justify-content:flex-end; }
    .cs-msg-act button { background:none; border:none; padding:2px; font-family:inherit; font-size:12px; color:var(--g500,#7a7a75); cursor:pointer; text-decoration:underline; }
    .cs-msg-act button:hover { color:var(--ink,#2b2b2b); }
    .cs-msg-edit { border:1.5px solid var(--pink-d,#e0707f); border-radius:14px; padding:8px; background:#fff; }
    .cs-msg-edit textarea { width:100%; font-family:inherit; font-size:14px; line-height:1.6; padding:8px 10px; border:1.5px solid var(--g300,#cfcfca); border-radius:10px; resize:vertical; box-sizing:border-box; }
    .cs-msg-edit-act { display:flex; justify-content:flex-end; gap:8px; margin-top:6px; }
    .cs-msg-edit-act button { font-family:inherit; font-size:13px; font-weight:800; padding:7px 14px; border-radius:100px; border:2px solid var(--ink,#2b2b2b); background:#fff; cursor:pointer; }
    .cs-msg-edit-act button.save { background:var(--pink,#e88494); color:#fff; }
  `;

  function statusBadge(status) {
    const s = STATUS[status] ? status : 'open';
    return `<span class="cs-status ${s}">${STATUS[s]}</span>`;
  }

  global.KaigoConsult = { CARE, BUDGET, NEEDS, OTHER_AREA, STATUS, STATUS_ORDER, DETAIL_NOTE, LABEL_HINT, LABEL_NOTE, LABEL_MAX, FAX, SENT_NOTE, DELETED_TEXT, WITHDRAWN_TEXT, AUTO_REPLY_DEFAULT, CSS, settings,
    esc, areaOptions, validate, cleanLabel, firstMessageText, areasText, fmtDate, fmtShort, fmtShortDT, shortText, caseName, uniqueCaseNames, caseMark, caseColor, normalizeInitials,
    create, send, markRead, setStatus, loadSettings, saveSettings, editMessage, withdrawMessage, updateConditions, withdrawConsultation, isLastMessage, canEditMessage,
    conditionsHTML, messagesHTML, messageBodyHTML, autoReplyHTML, editedMark, messageActionsHTML, messageEditorHTML, statusBadge };
})(window);
