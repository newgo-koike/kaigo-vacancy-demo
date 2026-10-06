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
  // 「名前」欄は 2026-10-06 に廃止（兵頭さん：個人情報の入口をなくす）。件は Cloud Functions が付ける相談番号 caseNo で区別する
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
    const text = '相談条件を修正しました。\n' + firstMessageText(cond, facilities || []);
    const batch = db.batch();
    batch.set(ref.collection('messages').doc(), { by: 'hospital', uid: user.uid, name: user.name || user.hospitalName || '', text, kind: 'conditions', createdAt: now });
    batch.update(ref, {
      conditions: cond, updatedAt: now,
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
  // 管理者が相手（病院）のメッセージも含めて本文を消す（個人情報が書かれてしまったとき）。最初の相談内容なら補足欄も消す。
  // 未読フラグは触らない（相手に「新着」を付ける用途ではない）
  async function purgeMessage(db, cid, mid, isFirst, isLast) {
    const fb = global.firebase;
    const now = fb.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('consultations').doc(cid);
    const upd = { updatedAt: now };
    if (isLast) upd.lastMessageText = DELETED_TEXT;
    if (isFirst) upd['conditions.detail'] = '';
    const batch = db.batch();
    batch.update(ref.collection('messages').doc(mid), { text: '', deleted: true, deletedAt: now, purged: true });
    batch.update(ref, upd);
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
  // 相談番号（Cloud Functions が採番）があれば「No.12（9/26 13:35）」、採番前・旧データは「9/26 13:35 の相談」
  function caseName(d) {
    const t = fmtShortDT(d.createdAt);
    if (d.caseNo) return `No.${d.caseNo}（${t || '送信中'}）`;
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
  // 丸いアイコンに入れる短い印：相談番号があれば「No.12」、無ければ月/日
  function caseMark(d) {
    if (d.caseNo) return `No.${d.caseNo}`;
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
      ${facs.length ? `<div class="cs-row"><div class="cs-row-lbl">情報を知りたい施設</div><div class="cs-row-val">${facs.map(f => `<a class="cs-chip-ro cs-chip-link" href="kaigo-facility-view.html?id=${esc(f.id)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div></div>` : ''}
      ${row('相談条件', c.care || [])}
      ${row('希望エリア', areas)}
      ${row('費用', c.budget || [])}
      ${row('こだわり・医療体制', c.needs || [])}
      ${(c.detail || '').trim() ? `<div class="cs-row"><div class="cs-row-lbl">詳細</div><div class="cs-row-val cs-detail">${esc(c.detail)}</div></div>` : ''}
    </div>`;
  }

  // ── 個人情報らしき記述の検知（送信前の確認。2026-10-06 兵頭さん要望、10/6 夜に「田中はじめさん」の見逃しで拡張） ──
  // 止めるのではなく「修正する／このまま送る」を選ばせる。AI は使わず、文字の並び（パターン）だけで判定する
  // 名前の判定は3段構え：(a) 敬称付き（田中はじめさん・はじめさん・ヤマダ様・太郎くん）
  //                    (b) よくある苗字＋名前（田中はじめ・佐藤太郎。敬称なしでも拾う）
  //                    (c) よくある苗字だけ＋助詞（鈴木が・田中は）
  // 「たくさん」「みなさん」「患者さん」「池田市」「山田南」のような一般語・地名は除く
  const PII_SAFE_NAMES = ['患者','利用者','本人','家族','奥','旦那','客','皆','看護師','先生','職員','担当者','担当','相談員','ケアマネ','息子','娘','母','父','兄','姉','弟','妹','孫','嫁','婿','祖母','祖父','医師','病院','施設','業者','入居者','お母','お父','各位','関係者','主人','医者','赤','おじい','おばあ','お兄','お姉','お子','子供','こども','みな','みんな','たく','よろ','ちゃん','皆様','仲人','先方','相手','皆さま'];
  const PII_STOP_FULL = ['たくさん','みなさん','みんなさん','皆さん','皆様','皆さま','お母さん','お父さん','お母様','お父様','お母さま','お父さま','患者さん','患者様','ご家族様','ご家族さん','家族さん','ケアマネさん','看護師さん','お客さん','お客様','業者さん','職員さん','娘さん','息子さん','奥さん','奥様','奥さま','旦那さん','旦那様','お兄さん','お姉さん','おじいさん','おばあさん','お孫さん','お嫁さん','お医者さん','ご本人様','本人さん','利用者さん','利用者様','入居者さん','入居者様','関係者様','相談員さん','担当者さん','担当さん','ご主人様','ご主人さん','赤ちゃん','お子さん','お子様','子供さん','よろしくさん'];
  // 日本でよくある苗字（2文字以上。1文字の苗字は地名・一般語と区別できないので敬称付きのときだけ拾う）
  const PII_SURNAMES = '佐藤 鈴木 高橋 田中 伊藤 渡辺 山本 中村 小林 加藤 吉田 山田 佐々木 山口 松本 井上 木村 斎藤 清水 山崎 池田 橋本 阿部 石川 山下 中島 石井 小川 前田 岡田 長谷川 藤田 後藤 近藤 村上 遠藤 青木 坂本 斉藤 福田 太田 西村 藤井 金子 岡本 藤原 中野 三浦 原田 中川 松田 竹内 小野 田村 中山 和田 石田 上田 森田 柴田 酒井 工藤 横山 宮崎 宮本 内田 高木 安藤 島田 谷口 大野 高田 丸山 今井 河野 藤本 村田 武田 上野 杉山 増田 小島 平野 大塚 千葉 久保 松井 岩崎 桜井 野口 松尾 野村 木下 菊地 佐野 大西 杉本 新井 浜田 菅原 市川 水野 小松 島崎 古川 小山 高野 渡部 菊池 荒木 服部 佐久間 熊谷 永井 松岡 川口 川崎 大久保 岩田 平田 吉川 片山 本田 早川 横田 三宅 松下 飯田 内藤 栗原 川上 西田 北村 望月 星野 安田 五十嵐 石原 篠原 小池 奥村 大石 松村 坂口 秋山 吉岡 川村 中西 伊東 松浦 田口 黒田 樋口 高山 福島 岩本 荒井 大橋 長田 須藤 平井 岡崎 落合 堀内 山内 前川 榎本 小田 根本 森本 西川 松原 大島 片岡 宮田 野田 畠山 大谷 松山 江口 田辺 本間 塚本 上原 北川 石橋 山中 川島 小泉 大沢 坂井 福井 広瀬 岸本 田島 中田 村山 山岸 西山 大森 堀田 尾崎 森下 吉村 神田 高石 鶴田 寺田 戸田 沢田 高瀬 牧野 土屋 田代 角田 岡部 小西 柳沢 平山 安部 竹田 成田 大山 福本 長島 宮下 西岡 今村 小森 白石 日高 浅野 関口 細川 小泉 水谷 土井 窪田 鈴村 井口 金井 岩井 大内 荻野 久保田 江藤 相馬 石塚 三好 吉野 石黒 米田 宇野 岩瀬 黒木 高島 入江 藤野 井田 中原 向井 奥田 大平 河村 兵頭 岡村 藤沢 北野 大村 西野 今野 真田 栗田 筒井 日野 南 東 北 西'.split(' ').filter(w => w.length >= 2);
  // 後読み（?<!）は iOS 16.3 以前の Safari で正規表現ごと読み込みに失敗するため使わない。直前の1文字を捕捉して判定する
  const PII_SURNAME_RE = new RegExp('(^|[^一-龥々])(' + PII_SURNAMES.join('|') + ')(?:([ぁ-ん]{2,4})|([一-龥]{1,3}))?(?=[がはをにでともへのやか、。・（）「」:：\\s]|$)', 'g');
  const PII_PLACE_SUFFIX = /(市|区|町|村|郡|駅|県|府|院|会|社|店|荘|苑|園|館|寮|校|局|署|線|橋|山|川|池|丘|台|野|原|島|崎|浜|港|口|前|東|西|南|北|中央|通|丁目|番地)$/;
  function piiNamePart(token) {
    // 敬称の直前の「漢字かカタカナの連なり＋続くひらがな」を名前とみなす（「件で田中はじめ」→「田中はじめ」、「ケアマネの木村」→「木村」）。
    // 助詞で切ると「はじめ」「のぶお」のような名前の中の文字まで切ってしまうので、文字種で切る
    const m = token.match(/[一-龥々〆ァ-ヶー]+[ぁ-ん]*$/);
    if (m) return m[0];
    // ひらがなだけ：先頭が助詞らしく、外しても3文字以上残るときだけ外す（「のひろし」→「ひろし」。「はじめ」はそのまま）
    const h = token.match(/^[のがはをにでともへやか](.{3,})$/);
    return h ? h[1] : token;
  }
  function detectPII(text) {
    const raw = String(text || '');
    if (!raw.trim()) return [];
    const t = raw.normalize('NFKC');
    const hits = [];
    // 同じ箇所を二重に出さない（「〒564-0001」と「564-0001」、「生年月日 昭和20年5月1日」と「昭和20年5月1日」）
    const add = (label, m) => { const v = String(m).trim(); if (v && !hits.some(h => h.text.includes(v))) hits.push({ label, text: v }); };
    for (const m of t.matchAll(/(^|[^\d-])(0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?![\d-])/g)) add('電話番号', m[2]);
    for (const m of t.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add('メールアドレス', m[0]);
    for (const m of t.matchAll(/〒\s?\d{3}-?\d{4}/g)) add('郵便番号', m[0]);
    for (const m of t.matchAll(/(^|[^\d-])(\d{3}-\d{4})(?![\d-])/g)) add('郵便番号', m[2]);
    for (const m of t.matchAll(/(?:生年月日|誕生日|生まれ)[^\n。]{0,12}/g)) add('生年月日', m[0]);
    for (const m of t.matchAll(/(?:昭和|平成|S|H)\s?\d{1,2}\s?[年/.-]\s?\d{1,2}\s?[月/.-]\s?\d{1,2}\s?日?/g)) add('生年月日らしき日付', m[0]);
    for (const m of t.matchAll(/(^|\D)(19\d{2}\s?[年/.-]\s?\d{1,2}\s?[月/.-]\s?\d{1,2}\s?日?)/g)) add('生年月日らしき日付', m[2]);
    for (const m of t.matchAll(/(^|\D)(\d{8,})(?!\d)/g)) add('番号（8桁以上）', m[2]);
    for (const m of t.matchAll(/(?:氏名|お名前|名前)\s*[:：]\s*\S{1,12}/g)) add('氏名の記載', m[0]);
    // (a) 敬称付き。名前部分は漢字・カタカナ・ひらがなの混在を許す。くん・君・ちゃんは漢字かカタカナを含むときだけ
    for (const m of t.matchAll(/([一-龥々〆ァ-ヶーぁ-ん]{2,14})\s?(様|さま|氏|さん|殿|くん|君|ちゃん)(?![一-龥])/g)) {
      const hon = m[2];
      const name = piiNamePart(m[1]);
      if (!name) continue;
      if (PII_STOP_FULL.some(w => (name + hon).endsWith(w))) continue;
      if (PII_SAFE_NAMES.some(w => name === w || name.endsWith(w))) continue;
      const hiraOnly = /^[ぁ-ん]+$/.test(name);
      if (hiraOnly && (name.length < 3 || /^(くん|君|ちゃん)$/.test(hon))) continue;
      if (!hiraOnly && name.length < 2) continue;
      if (/^(くん|君|ちゃん)$/.test(hon) && /[ぁ-ん]$/.test(name)) continue;   // 「確認をちゃんと」のような助詞＋ちゃん
      add('名前（敬称付き）', name + hon);
    }
    // (b)(c) よくある苗字＋名前、苗字だけ＋助詞
    for (const m of t.matchAll(PII_SURNAME_RE)) {
      const sur = m[2], hira = m[3] || '', kan = m[4] || '';
      const after = t[m.index + m[0].length] || '';
      if (hits.some(h => h.text.includes(sur + hira + kan) || (h.label === '名前（敬称付き）' && h.text.startsWith(sur)))) continue;   // 敬称付きで拾った分と重複させない
      if (kan && PII_PLACE_SUFFIX.test(kan)) continue;                // 池田市・山田南・鈴木病院
      if (!hira && !kan) {                                            // 苗字だけ：「が・は・を・も・へ・と・に」が続くときだけ（「の」は地名の可能性）
        if (!/[がはをもへとに]/.test(after)) continue;
        if (sur.length < 2 || ['南','東','北','西'].includes(sur)) continue;
        add('名前らしき苗字', sur);
        continue;
      }
      add('名前（苗字＋名前）', sur + hira + kan);
    }
    return hits;
  }
  function ensurePiiStyle() {
    if (document.getElementById('cs-pii-style')) return;
    const st = document.createElement('style');
    st.id = 'cs-pii-style';
    st.textContent = `
      .cs-pii-bg { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px; }
      .cs-pii-box { background:#fff; border:2px solid #2b2b2b; border-radius:16px; padding:22px 22px 18px; max-width:460px; width:100%; box-shadow:6px 6px 0 #2b2b2b; font-family:inherit; }
      .cs-pii-ttl { font-size:17px; font-weight:900; color:#b91c1c; margin-bottom:8px; }
      .cs-pii-msg { font-size:14px; line-height:1.7; color:#454541; }
      .cs-pii-list { margin:10px 0 12px; padding:10px 12px; background:#fef2f2; border:1px solid #fca5a5; border-radius:10px; font-size:14px; line-height:1.8; }
      .cs-pii-list b { color:#b91c1c; }
      .cs-pii-act { display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap; }
      .cs-pii-act button { font-family:inherit; font-size:14px; font-weight:800; padding:10px 18px; border-radius:100px; border:2px solid #2b2b2b; background:#fff; cursor:pointer; }
      .cs-pii-act button.fix { background:#2b2b2b; color:#fff; }
    `;
    document.head.appendChild(st);
  }
  // 検知結果を見せて選ばせる。true＝このまま送る、false＝修正する
  function confirmPII(hits) {
    ensurePiiStyle();
    return new Promise(resolve => {
      const bg = document.createElement('div');
      bg.className = 'cs-pii-bg';
      bg.innerHTML = `<div class="cs-pii-box" role="dialog" aria-label="個人情報の確認">
        <div class="cs-pii-ttl">個人情報が含まれていませんか？</div>
        <div class="cs-pii-msg">次の記載が、名前や連絡先などの個人情報にあたる可能性があります。</div>
        <div class="cs-pii-list">${hits.map(h => `<div><b>${esc(h.label)}</b>：${esc(h.text)}</div>`).join('')}</div>
        <div class="cs-pii-msg">このチャットには名前・電話番号・生年月日などを書かず、必要な場合は電話や FAX でお伝えください。</div>
        <div class="cs-pii-act" style="margin-top:14px"><button type="button" class="send">このまま送る</button><button type="button" class="fix">修正する</button></div>
      </div>`;
      const done = v => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') done(false); };
      bg.querySelector('.fix').onclick = () => done(false);
      bg.querySelector('.send').onclick = () => done(true);
      bg.addEventListener('click', e => { if (e.target === bg) done(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(bg);
      bg.querySelector('.fix').focus();
    });
  }
  // 送る前の確認。何も検知しなければ true
  async function checkPII(text) {
    const hits = detectPII(text);
    return hits.length ? confirmPII(hits) : true;
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
      let act = (!editing && opts.fn && canEditMessage(m, mySide, i)) ? messageActionsHTML(m.id, opts.fn) : '';
      // 管理者向け：相手のメッセージ（最初の相談内容・条件修正の記録を含む）に「個人情報を消す」
      if (!act && opts.purge && !m.deleted && m.by !== mySide) act = `<div class="cs-msg-act"><button type="button" onclick="${opts.purge}('${esc(m.id)}')">個人情報を消す</button></div>`;
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

  global.KaigoConsult = { CARE, BUDGET, NEEDS, OTHER_AREA, STATUS, STATUS_ORDER, DETAIL_NOTE, LABEL_MAX, FAX, SENT_NOTE, DELETED_TEXT, WITHDRAWN_TEXT, AUTO_REPLY_DEFAULT, CSS, settings,
    esc, areaOptions, validate, cleanLabel, firstMessageText, areasText, fmtDate, fmtShort, fmtShortDT, shortText, caseName, uniqueCaseNames, caseMark, caseColor, normalizeInitials,
    create, send, markRead, setStatus, loadSettings, saveSettings, editMessage, withdrawMessage, updateConditions, withdrawConsultation, isLastMessage, canEditMessage,
    detectPII, confirmPII, checkPII, purgeMessage,
    conditionsHTML, messagesHTML, messageBodyHTML, autoReplyHTML, editedMark, messageActionsHTML, messageEditorHTML, statusBadge };
})(window);
