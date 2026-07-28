// 施設1件分の「資料（印刷／PDF用シート）」を生成・表示する共通ロジック。
// 検索結果で施設1件を選んで「資料出力」した時と、施設詳細ページの「印刷」ボタンで
// まったく同じ体裁のシートを出すために両ページから使う。
(function (global) {
  'use strict';

  // Firestore doc → 表示用オブジェクトへ変換（検索ページの mapDoc と同一仕様）
  function mapDoc(doc) {
    const d = doc.data();
    const upd = d.updatedAt ? d.updatedAt.toDate() : new Date();
    const daysAgo = Math.floor((new Date() - upd) / 86400000);

    const rentYen  = d.rent          ?? null;
    const mgmtYen  = d.managementFee ?? null;
    const mealYen  = d.mealFee       ?? null;
    const otherYen = d.otherFee      ?? null;
    const hasBreakdown = rentYen !== null || mgmtYen !== null || mealYen !== null;
    const w = v => v != null ? Math.round(v / 10000 * 10) / 10 : null;
    const monthlyTotalYen = hasBreakdown
      ? (rentYen || 0) + (mgmtYen || 0) + (mealYen || 0) + (otherYen || 0)
      : (d.monthlyFee ?? null);
    const monthlyTotal = monthlyTotalYen != null ? Math.round(monthlyTotalYen / 10000 * 10) / 10 : null;

    return {
      id: doc.id,
      name: d.name || '',
      type: d.type || '',
      addr: d.address || '',
      area: d.area || '',
      city: d.city || '',
      stationSearch: [
        d.station, d.stationLine, d.stationDistance,
        ...(d.stations || []).flatMap(s => [s.line, s.name, s.walk ? `徒歩${s.walk}分` : '']),
        ...(d.buses || []).flatMap(b => [b.route, b.stop, b.walk ? `徒歩${b.walk}分` : '']),
      ].filter(Boolean).join(' '),
      vacancy: typeof d.vacancy === 'number' ? d.vacancy : 0,
      vacancyNotes: d.vacancyNotes || '',
      features: d.features || [],
      seikatsuHogo: d.seikatsuHogo || '',
      mimonHosho: d.mimonHosho || '',
      kaigoNintei: d.kaigoNintei || '',
      feeNotes: d.feeNotes || '',
      sourceUrl: d.sourceUrl || '',
      campaign: d.campaign || '',
      contactName: d.contactName || '',
      contactTel: d.contactTel || '',
      initialFeeAmountYen: d.initialFeeAmount ?? null,
      depositAmountYen: d.depositAmount ?? null,
      rentYen, mgmtYen, mealYen, otherYen,
      monthlyTotal,
      monthlyTotalYen,
    };
  }

  // feeNotes（\n区切り・※始まりの注意書き）を箇条書きHTMLに変換
  function feeNotesListHtml(notes) {
    const lines = String(notes || '').split(/\n/).flatMap(line => line.split(/(?=※)/)).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    return `<ul style="margin:0;padding-left:16px;">${lines.map(l => `<li style="margin-bottom:2px;">${l}</li>`).join('')}</ul>`;
  }

  // 施設1件の資料HTML（A4縦・白黒印刷対応・月額を中央ヒーロー表示）
  function facilitySheetHTML(f, vacInquiry) {
    const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    const fmtYen = v => v != null ? Number(v).toLocaleString('ja-JP') : null;
    const totalInitYen = (f.initialFeeAmountYen || 0) + (f.depositAmountYen || 0);
    const init = totalInitYen > 0 ? fmtYen(totalInitYen) + '円' : '0円';
    const vac = vacInquiry ? '要問い合わせ' : f.vacancy === 0 ? '満室' : f.vacancy + '室空き';
    const stStr = (f.stationSearch || '').split(' ').slice(0, 5).filter(Boolean).join('  ') || '—';
    // 施設種別ごとの目安は画面の「その他かかる費用の目安」と同じ共通データを使う（kaigo-cost-data.js）
    const cat = global.KaigoCost.get(f.type);
    const _mn = f.monthlyTotal;
    const estMin = _mn ? Math.round((_mn + cat.careMin + cat.medMin + cat.lifeMin) * 10) / 10 : null;
    const estMax = _mn ? Math.round((_mn + cat.careMax + cat.medMax + cat.lifeMax) * 10) / 10 : null;

    const detailRows = [
      ['特徴・タグ', (f.features && f.features.length) ? f.features.join('・') : ''],
      ['生活保護',   f.seikatsuHogo],
      ['身元保証',   f.mimonHosho],
      ['介護認定',   f.kaigoNintei],
      ['空室補足',   f.vacancyNotes],
      ['キャンペーン', f.campaign],
      ['費用の詳細', f.feeNotes],
      ['連絡先担当', f.contactName],
      ['連絡先TEL', f.contactTel],
    ].filter(([, v]) => v != null && String(v).trim() !== '');
    const detailTable = detailRows.length ? `
    <table style="width:100%;border-collapse:collapse;font-size:9.5pt;margin-bottom:12px;">
      <tbody>
        ${detailRows.map(([label, v]) => `<tr>
          <td style="padding:6px 10px;font-weight:700;border:1px solid #ccc;background:#f5f5f5;white-space:nowrap;width:20%;vertical-align:top;">${label}</td>
          <td style="padding:6px 10px;border:1px solid #ccc;color:#333;font-size:9pt;line-height:1.6;word-break:break-all;">${label === '費用の詳細' ? feeNotesListHtml(v) : v}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : '';

    const body = `
    <!-- ヘッダー：施設名 -->
    <div style="border-bottom:2.5px solid #000;padding-bottom:8px;margin-bottom:12px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
      <div style="font-size:22pt;font-weight:900;letter-spacing:-.4px;line-height:1.1">${f.name}</div>
      <div style="font-size:10pt;border:1.5px solid #000;padding:2px 8px;border-radius:3px;font-weight:700;white-space:nowrap">${f.type}</div>
      <div style="margin-left:auto;font-size:10pt;font-weight:700;white-space:nowrap">空室: ${vac}</div>
    </div>

    <!-- アクセス（コンパクト1行） -->
    <div style="font-size:9.5pt;color:#333;margin-bottom:14px;display:flex;gap:16px;flex-wrap:wrap;">
      <span>住所: ${f.addr || f.city || '—'}</span>
      ${stStr !== '—' ? `<span>最寄り: ${stStr}</span>` : ''}
      <span>入居時費用: ${init}</span>
    </div>

    <!-- HERO：月々の合計費用（最大強調・中央） -->
    <div style="border:4px solid #000;border-radius:6px;padding:30px 20px 26px;margin-bottom:14px;text-align:center;">
      <div style="font-size:10pt;font-weight:700;letter-spacing:.1em;margin-bottom:18px;">月々の合計費用（目安・すべて含む）</div>
      ${estMin ? `
        <div style="font-size:86pt;font-weight:900;line-height:1;letter-spacing:-4px;text-align:center;">${Math.round(estMin)}<span style="font-size:40pt;letter-spacing:-1px;">〜${Math.round(estMax)}</span></div>
        <div style="font-size:30pt;font-weight:900;margin-top:4px;text-align:center;">万円</div>
        <div style="font-size:8pt;color:#555;margin-top:14px;">施設費用 ＋ 介護費用 ＋ 医療費 ＋ その他生活費</div>
      ` : f.monthlyTotalYen != null ? `
        <div style="font-size:8pt;color:#888;margin-bottom:8px;">（介護費・医療費等は含まず、施設費用のみ）</div>
        <div style="font-size:72pt;font-weight:900;line-height:1;letter-spacing:-3px;text-align:center;">${fmtYen(f.monthlyTotalYen)}</div>
        <div style="font-size:26pt;font-weight:900;margin-top:4px;text-align:center;">円</div>
      ` : `
        <div style="font-size:32pt;font-weight:900;color:#666;line-height:1;">─</div>
        <div style="font-size:8.5pt;color:#999;margin-top:8px;">費用データなし（施設にお問い合わせください）</div>
      `}
    </div>

    <!-- 施設費用（施設への直接支払い分） -->
    ${f.monthlyTotalYen != null ? `
    <table style="width:100%;border-collapse:collapse;font-size:10.5pt;margin-bottom:12px;">
      <tbody>
        <tr>
          <td style="padding:7px 10px;font-weight:700;border:1px solid #ccc;background:#f5f5f5;width:22%;white-space:nowrap;">施設費用</td>
          <td style="padding:7px 10px;border:1px solid #ccc;font-size:9.5pt;color:#333;">家賃・食費・管理費など（施設への直接支払い）</td>
          <td style="padding:7px 10px;text-align:right;font-weight:800;font-size:12pt;border:1px solid #ccc;white-space:nowrap;width:22%;">${fmtYen(f.monthlyTotalYen)} 円</td>
        </tr>
      </tbody>
    </table>` : ''}

    <!-- その他かかる費用の目安（施設詳細ページと同一の内容・施設種別ごと） -->
    <div style="font-size:10pt;font-weight:700;margin-bottom:5px;">その他かかる費用の目安</div>
    <table style="width:100%;border-collapse:collapse;font-size:10.5pt;margin-bottom:6px;">
      <thead>
        <tr style="background:#e8e8e8;">
          <th style="padding:5px 10px;text-align:left;border:1px solid #999;width:22%;font-size:9pt;">項目</th>
          <th style="padding:5px 10px;text-align:left;border:1px solid #999;font-size:9pt;">内容</th>
          <th style="padding:5px 10px;text-align:right;border:1px solid #999;white-space:nowrap;font-size:9pt;width:22%;">月額目安</th>
        </tr>
      </thead>
      <tbody>
        <tr style="background:#f5f5f5;">
          <td style="padding:6px 10px;font-weight:700;border:1px solid #ccc;">介護費用</td>
          <td style="padding:6px 10px;border:1px solid #ccc;font-size:9.5pt;color:#333;">${cat.careDesc}<br><span style="font-size:8pt;color:#666;">${cat.careSub}</span></td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;border:1px solid #ccc;white-space:nowrap;">${cat.careDisplay}<br><span style="font-size:7.5pt;font-weight:400;color:#666;">${cat.careNote}</span></td>
        </tr>
        <tr>
          <td style="padding:6px 10px;font-weight:700;border:1px solid #ccc;">医療費</td>
          <td style="padding:6px 10px;border:1px solid #ccc;font-size:9.5pt;color:#333;">${cat.medDesc}<br><span style="font-size:8pt;color:#666;">${cat.medSub}</span></td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;border:1px solid #ccc;white-space:nowrap;">${cat.medDisplay}</td>
        </tr>
        <tr style="background:#f5f5f5;">
          <td style="padding:6px 10px;font-weight:700;border:1px solid #ccc;">その他生活費</td>
          <td style="padding:6px 10px;border:1px solid #ccc;font-size:9.5pt;color:#333;">${cat.lifeDesc}<br><span style="font-size:8pt;color:#666;">${cat.lifeSub}</span></td>
          <td style="padding:6px 10px;text-align:right;font-weight:700;border:1px solid #ccc;white-space:nowrap;">${cat.lifeDisplay}</td>
        </tr>
      </tbody>
    </table>
    <div style="font-size:8pt;color:#666;margin-bottom:12px;">※ 介護度・負担割合・生活スタイルにより変動します</div>

    ${detailTable}
    <div style="font-size:8pt;color:#666;padding-top:6px;border-top:1px solid #ccc;">※ 月々の目安は介護度・負担割合・生活スタイルにより変動します。空室状況は Meets Medical へお問い合わせください。</div>`;

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>介護施設 資料出力 ${today}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700;900&display=swap');
    @page { size:A4 portrait; margin:0; }
    * { box-sizing:border-box; margin:0; padding:0; }
    html, body { width:100%; height:100%; }
    body { font-family:'Noto Sans JP',sans-serif; color:#000; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .sheet { width:210mm; min-height:297mm; padding:10mm 12mm; margin:0 auto; }
    .hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:6mm; border-bottom:1px solid #ccc; padding-bottom:4mm; }
    .hdr h1 { font-size:10pt; font-weight:700; color:#000; }
    .hdr .meta { font-size:8pt; color:#555; text-align:right; }
    .print-btn { background:#000; color:#fff; border:none; padding:5px 14px; border-radius:4px; font-size:11px; font-weight:700; cursor:pointer; font-family:inherit; }
    @media print { .print-btn { display:none !important; } }
  </style>
</head>
<body>
  <div class="sheet">
    <div class="hdr">
      <div>
        <h1>介護施設 資料 — 1件</h1>
      </div>
      <div class="meta">出力日：${today}<br>Meets Medical 介護施設検索システム</div>
      <button class="print-btn" onclick="window.print()">印刷・PDF</button>
    </div>
    ${body}
  </div>
</body>
</html>`;
  }

  // 施設1件の資料を別タブで開く。docOrF は Firestore doc でも mapDoc 済みオブジェクトでも可。
  function printFacilitySheet(docOrF, opts) {
    opts = opts || {};
    const f = (docOrF && typeof docOrF.data === 'function') ? mapDoc(docOrF) : docOrF;
    const html = facilitySheetHTML(f, opts.vacancyInquiry);
    const win = window.open('', '_blank');
    if (!win) { if (typeof opts.onBlocked === 'function') opts.onBlocked(); return; }
    win.document.write(html);
    win.document.close();
  }

  global.KaigoPrint = { mapDoc, facilitySheetHTML, printFacilitySheet, feeNotesListHtml };
})(window);
