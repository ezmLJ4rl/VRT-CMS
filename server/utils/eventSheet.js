const { enumLabel, normalizeLocale, translator } = require('../i18n');
const { CHURCH_NAME } = require('./brand');

/**
 * The event announcement sheet: plain text (print or post as-is), branded HTML,
 * and a server-side PDF. All three say the same thing in the reader's language:
 * every label, the event's kind and what will be collected are catalog keys, so a
 * Kiswahili sheet never shows a raw enum ("choir") or an English heading.
 *
 * The church's own name is the one string left untranslated: it is the church's
 * name, not a word.
 */

function kindLabel(t, kind) {
  return enumLabel(t, 'events.kind_', kind);
}

function collectionLabel(t, type) {
  return enumLabel(t, 'events.collection_', type);
}

function eventRows(t, event) {
  const dt = String(event.starts_at || '').replace('T', ' ').slice(0, 16);
  const end = event.ends_at ? String(event.ends_at).replace('T', ' ').slice(0, 16) : '';
  return [
    [t('sheet.event'), event.title],
    [t('sheet.when'), `${dt}${end ? ` ${t('sheet.rangeTo')} ${end}` : ''}`],
    [t('sheet.where'), event.location || '-'],
    [t('sheet.kind'), kindLabel(t, event.kind)],
    [t('sheet.collection'), collectionLabel(t, event.collection_type)],
  ];
}

function plainTextSheet(event, locale) {
  const t = translator(locale);
  return [
    CHURCH_NAME.toUpperCase(),
    t('sheet.heading').toUpperCase(),
    '',
    ...eventRows(t, event).map(([label, value]) => `${label}: ${value}`),
    '',
    `${t('sheet.details')}:`,
    event.description || '-',
    '',
    t('sheet.plainNote'),
  ].join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Printable HTML sheet for in-browser printing (same brand style as receipts). */
function htmlSheet(event, locale) {
  const t = translator(locale);
  const rows = eventRows(t, event)
    .map(([label, value]) => `    <div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`)
    .join('\n');
  return `<!doctype html>
<html lang="${normalizeLocale(locale)}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(event.title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #201E1A; margin: 0; padding: 40px; background: #F6F2E9; }
  .sheet { max-width: 620px; margin: 0 auto; background: #FDFBF6; border: 1px solid #E7E0CE; border-top: 6px solid #69B201; border-bottom: 6px solid #A70210; padding: 40px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: 1px; }
  .sub { color: #78716c; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; }
  .rule { border-top: 1px solid #E7E0CE; margin: 16px 0; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
  .row .label { color: #57534e; }
  .row .value { font-weight: bold; text-align: right; }
  .details { margin-top: 18px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; }
  .note { margin-top: 28px; border-top: 1px dashed #d6d3d1; padding-top: 12px; font-size: 11px; color: #78716c; }
  @media print { body { padding: 12px; background: #FDFBF6; } .sheet { border: 1px solid #d6d3d1; } }
</style>
</head>
<body>
  <div class="sheet">
    <h1>${escapeHtml(CHURCH_NAME.toUpperCase())}</h1>
    <p class="sub">${escapeHtml(t('sheet.heading'))}</p>
${rows}
    <div class="rule"></div>
    <div class="details"><strong>${escapeHtml(t('sheet.details'))}:</strong>
${escapeHtml(event.description || '-')}</div>
    <div class="note">${escapeHtml(t('sheet.note'))}</div>
  </div>
</body>
</html>`;
}

/** Server-side PDF event sheet via pdfkit (VRT brand, same rails as receipts). */
function pdfSheet(event, locale) {
  const t = translator(locale);
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const write = () => {
    const brand = '#A70210';
    const green = '#69B201';
    const paper = '#FDFBF6';
    const ink = '#201E1A';
    const muted = '#57534e';

    const pageBottom = doc.page.margins.bottom;
    doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(paper).restore();
    doc.save().rect(0, 0, doc.page.width, 8).fill(green).restore();
    doc.save().rect(0, doc.page.height - pageBottom / 2 - 4, doc.page.width, 8).fill(brand).restore();

    doc.font('Helvetica-Bold').fontSize(24).fillColor(brand).text(CHURCH_NAME.toUpperCase(), { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor(green).text(t('sheet.heading').toUpperCase(), { align: 'center', characterSpacing: 2 });
    doc.moveDown(1.6);

    for (const [label, value] of eventRows(t, event)) {
      doc.font('Helvetica').fontSize(11).fillColor(muted).text(`${label}:`, 56, doc.y, { continued: true, width: 170 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(`  ${value}`);
      doc.moveDown(0.5);
    }

    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(brand).text(t('sheet.details'), 56, doc.y);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(11).fillColor(ink).text(event.description || '-', 56, doc.y, { width: doc.page.width - 112 });

    doc.moveDown(1.6);
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(
      t('sheet.note'),
      56,
      doc.y,
      { width: doc.page.width - 112 }
    );
    doc.end();
  };

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      write();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { plainTextSheet, htmlSheet, pdfSheet, collectionLabel, kindLabel };
