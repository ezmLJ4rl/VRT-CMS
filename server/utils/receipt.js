const fs = require('fs');
const path = require('path');
const pool = require('../db/pg');
const { intlLocale, normalizeLocale, translator, enumLabel } = require('../i18n');
const { CHURCH_NAME, CHURCH_ADDRESS } = require('./brand');
const { qrSvg, qrPngBuffer } = require('./qr');
const { verificationHost, verificationUrl } = require('./verificationToken');

// Donor names are free text as typed by the front desk, so they are escaped
// before they go into markup rather than trusted.
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Official VRT roundel (vrt-logo.png) embedded so receipts carry the real
// brand in HTML (data URI) and PDF (raw image) form, never an approximation.
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'vrt-logo.png');
const LOGO_BASE64 = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH).toString('base64') : null;

/** The roundel as a data URI, for documents that are not the receipt itself. */
function logoDataUri() {
  return LOGO_BASE64 ? `data:image/png;base64,${LOGO_BASE64}` : null;
}

/**
 * Next receipt number for a given year: MAX(existing)+1 within the VR-YYYY-
 * prefix. The previous COUNT-based scheme produced duplicates (UNIQUE violation
 * -> failed recording) whenever anything was ever deleted, and skipped numbers
 * did not even free the space. MAX+1 reuses freed numbers and can never collide.
 *
 * Accepts an optional transaction client so a caller generating the number
 * inside a transaction reads on the same connection it will insert on.
 */
async function nextReceiptNo(date, client = null) {
  const runner = client || pool;
  const year = String(date).slice(0, 4);
  const prefix = `VR-${year}-`;
  const { rows } = await runner.query(
    'SELECT MAX(CAST(substr(receipt_number, LENGTH($1) + 1) AS INTEGER)) AS max_no FROM offerings WHERE receipt_number LIKE $2',
    [prefix, `${prefix}%`]
  );
  return `${prefix}${String((rows[0].max_no || 0) + 1).padStart(4, '0')}`;
}

/**
 * A receipt is a document handed to a donor, so it is written in the language of
 * the front desk that printed it (the caller's locale), not in a fixed one: the
 * amount, the date and the currency all follow the same locale as the labels, so
 * a Kiswahili receipt shows "TSh" beside "Risiti" rather than an English "TZS"
 * beside a translated word.
 */
function formatAmount(amount, currency, locale) {
  const code = currency || 'TZS';
  try {
    return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(amount);
  } catch (e) {
    return `${code} ${Number(amount).toLocaleString(intlLocale(locale))}`;
  }
}

function formatDate(dateISO, locale) {
  if (!dateISO) return '';
  const d = new Date(`${dateISO}T12:00:00`);
  return new Intl.DateTimeFormat(intlLocale(locale), { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

/**
 * The moment the gift was recorded: 'YYYY-MM-DD HH24:MI:SS' as the database
 * stores it, i.e. church local time.
 *
 * The parts are read out of the string and reformatted in UTC, so a receipt
 * carries the same time whichever timezone the server happens to run in (the
 * alternative: `new Date(timestamp)`: would shift the printed time by the
 * server's offset). Returns '' for a row with no timestamp rather than printing
 * an empty label.
 */
function formatDateTime(timestamp, locale) {
  if (!timestamp) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(timestamp));
  if (!m) return String(timestamp);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }).format(d);
}

/**
 * The verification block: the QR code, and what it is for.
 *
 * Rendered only when the row actually carries a verification token, so a
 * receipt-like document built from a bare row (a test fixture, a legacy record
 * that never had a receipt) simply has no block instead of a QR code pointing
 * nowhere. The block verifies THIS receipt: the token resolves to this one
 * offering, never to the day's audit chain (see routes/verification.js).
 */
function verificationBlockHtml(row, locale) {
  if (!row.verification_token) return '';
  const t = translator(locale);
  return `
    <div class="rule"></div>
    <div class="verify">
      <div class="verify-qr">${qrSvg(verificationUrl(row.verification_token), { size: 150 })}</div>
      <div class="verify-text">
        <p class="verify-title">${escapeHtml(t('receipt.scanToVerify'))}</p>
        <p class="verify-host">${escapeHtml(verificationHost())}</p>
      </div>
    </div>`;
}

/*
 * The Giver line on a receipt, always present.
 *
 * The caller passes the row already decorated by routes/offerings.js, which
 * exposes the decrypted name as `offererName`. Three cases, deliberately kept
 * distinct so a receipt can never paper over a data fault:
 *   named  -> the name
 *   anonymous (no ciphertext on the row) -> 'Anonymous'
 *   ciphertext that will not decrypt -> 'Name unavailable' (never 'Anonymous')
 */
function giverLine(row, locale) {
  const t = translator(locale);
  if (row.offererName) return row.offererName;
  if (row.offererNameUnavailable) return t('receipt.nameUnavailable');
  return t('receipt.anonymous');
}

/** Printable HTML receipt for in-browser printing. */
function renderReceiptHtml(row, locale) {
  const t = translator(locale);
  const category = row.category_name || row.category_key || t('receipt.fallbackCategory');
  return `<!doctype html>
<html lang="${normalizeLocale(locale)}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(t('receipt.number'))} ${escapeHtml(row.receipt_number)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #201E1A; margin: 0; padding: 40px; background: #F6F2E9; }
  .receipt { max-width: 620px; margin: 0 auto; background: #FDFBF6; border: 1px solid #E7E0CE; border-top: 6px solid #69B201; border-bottom: 6px solid #A70210; padding: 40px; }
  .logo { text-align: center; margin-bottom: 10px; }
  .logo img { width: 84px; height: auto; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: 1px; }
  .sub { color: #78716c; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 24px; }
  .rule { border-top: 1px solid #E7E0CE; margin: 16px 0; }
  .receipt-no { text-align: right; font-size: 13px; margin-bottom: 8px; }
  .receipt-no b { font-size: 15px; color: #A70210; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
  .row .label { color: #57534e; }
  .row .value { font-weight: bold; text-align: right; }
  .code-hint { font-size: 11px; color: #78716c; margin: 2px 0 6px; text-align: right; }
  .amount { font-size: 28px; color: #A70210; padding: 12px 0; }
  .footer { margin-top: 28px; font-size: 12px; color: #78716c; }
  .footer p { margin: 4px 0; }
  .verify { display: flex; align-items: center; gap: 16px; }
  .verify-qr { flex: none; line-height: 0; background: #fff; border: 1px solid #E7E0CE; padding: 6px; }
  .verify-text { min-width: 0; }
  .verify-title { font-size: 13px; font-weight: bold; margin: 0 0 2px; }
  .verify-host { font-size: 11px; color: #78716c; margin: 0; letter-spacing: 0.5px; }
  @media print { body { padding: 12px; background: #FDFBF6; } .receipt { border: 1px solid #d6d3d1; } }
</style>
</head>
<body>
  <div class="receipt">
    ${LOGO_BASE64 ? `<div class="logo"><img src="data:image/png;base64,${LOGO_BASE64}" alt="${escapeHtml(CHURCH_NAME)} logo" /></div>` : ''}
    <h1>${escapeHtml(CHURCH_NAME)}</h1>
    <p class="sub">${escapeHtml(t('receipt.docTitle'))}</p>
    <div class="receipt-no">${escapeHtml(t('receipt.number'))}: <b>${escapeHtml(row.receipt_number)}</b></div>
    <div class="row"><span class="label">${escapeHtml(t('receipt.date'))}</span><span class="value">${escapeHtml(formatDate(row.service_date, locale))}</span></div>
    ${row.timestamp ? `<div class="row"><span class="label">${escapeHtml(t('receipt.recordedAt'))}</span><span class="value">${escapeHtml(formatDateTime(row.timestamp, locale))}</span></div>` : ''}
    <div class="row"><span class="label">${escapeHtml(t('receipt.service'))}</span><span class="value">${escapeHtml(row.service_name)}</span></div>
    <div class="row"><span class="label">${escapeHtml(t('receipt.category'))}</span><span class="value">${escapeHtml(category)}</span></div>
    ${row.payment_method ? `<div class="row"><span class="label">${escapeHtml(t('receipt.paymentMethod'))}</span><span class="value">${escapeHtml(enumLabel(t, 'payment.method_', row.payment_method))}</span></div>` : ''}
    ${row.payment_reference ? `<div class="row"><span class="label">${escapeHtml(t('receipt.paymentReference'))}</span><span class="value">${escapeHtml(row.payment_reference)}</span></div>` : ''}
    <div class="row"><span class="label">${escapeHtml(t('receipt.giver'))}</span><span class="value">${escapeHtml(giverLine(row, locale))}</span></div>
    ${row.giver_member_no ? `<div class="row"><span class="label">${escapeHtml(t('receipt.givingCode'))}</span><span class="value">${escapeHtml(row.giver_member_no)}</span></div>
    <p class="code-hint">${escapeHtml(t('receipt.givingCodeHint'))}</p>` : ''}
    ${row.project_name ? `<div class="row"><span class="label">${escapeHtml(t('receipt.project'))}</span><span class="value">${escapeHtml(row.project_name)}</span></div>` : ''}
    ${row.reason ? `<div class="row"><span class="label">${escapeHtml(t('receipt.reason'))}</span><span class="value">${escapeHtml(row.reason)}</span></div>` : ''}
    <div class="rule"></div>
    <div class="row amount"><span class="label">${escapeHtml(t('receipt.amount'))}</span><span class="value">${escapeHtml(formatAmount(row.amount, row.currency, locale))}</span></div>
    ${row.notes ? `<div class="row"><span class="label">${escapeHtml(t('receipt.notes'))}</span><span class="value">${escapeHtml(row.notes)}</span></div>` : ''}
    <div class="row"><span class="label">${escapeHtml(t('receipt.recordedBy'))}</span><span class="value">${escapeHtml(row.recorded_by_name)}</span></div>${verificationBlockHtml(row, locale)}
    <div class="footer">
      <p>${escapeHtml(t('receipt.thanks'))}</p>
      <p>${escapeHtml(CHURCH_NAME)} · ${escapeHtml(CHURCH_ADDRESS)}</p>
    </div>
  </div>
</body>
</html>`;
}

/** Server-side PDF receipt via pdfkit. */
function renderReceiptPdf(row, locale) {
  const t = translator(locale);
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const category = row.category_name || row.category_key || t('receipt.fallbackCategory');
  // The one part of a receipt that cannot be drawn synchronously: pdfkit places
  // an IMAGE, so the QR arrives as a PNG buffer (see utils/qr.js). Everything
  // before it is laid out exactly as before.
  const write = async () => {
    // VRT palette (logo-derived): green #69B201 / red #A70210 / cream paper / charcoal ink.
    const brand = '#A70210';
    const green = '#69B201';
    const paper = '#FDFBF6';
    const ink = '#201E1A';
    const muted = '#78716c';

    // Cream document base, then the green→red brand rails.
    const pageBottom = doc.page.margins.bottom;
    doc.save()
      .rect(0, 0, doc.page.width, doc.page.height)
      .fill(paper)
      .restore();
    doc.save().rect(0, 0, doc.page.width, 8).fill(green).restore();
    doc.save().rect(0, doc.page.height - pageBottom / 2 - 4, doc.page.width, 8).fill(brand).restore();

    if (LOGO_BASE64) {
      doc.image(Buffer.from(LOGO_BASE64, 'base64'), { width: 84, align: 'center' });
    }
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(brand).text(CHURCH_NAME, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor(green).text(t('receipt.pdfTitle'), { align: 'center', characterSpacing: 2 });
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(11).fillColor(brand);
    doc.fontSize(12).text(`${t('receipt.number')}: ${row.receipt_number}`, { align: 'right' });
    doc.moveDown(0.5);

    const rowsRight = [
      [t('receipt.date'), formatDate(row.service_date, locale)],
      [t('receipt.service'), row.service_name],
      [t('receipt.category'), category],
      // How the gift was paid, printed beside the offering it belongs to. Both
      // lines are conditional: an offering recorded without one says nothing
      // rather than printing an empty or inferred value (see utils/payments.js).
      ...(row.payment_method ? [[t('receipt.paymentMethod'), enumLabel(t, 'payment.method_', row.payment_method)]] : []),
      ...(row.payment_reference ? [[t('receipt.paymentReference'), row.payment_reference]] : []),
      [t('receipt.giver'), giverLine(row, locale)],
      // The member's giving code, printed only when the gift is attributed to a
      // member: a cash gift signed for by hand has no code, and inventing one
      // would be inventing an identity. The line under it says what it is FOR,
      // which is the whole point of printing it: the member keeps the receipt.
      ...(row.giver_member_no ? [[t('receipt.givingCode'), row.giver_member_no]] : []),
      ...(row.project_name ? [[t('receipt.project'), row.project_name]] : []),
      ...(row.reason ? [[t('receipt.reason'), row.reason]] : []),
    ];
    for (const [label, value] of rowsRight) {
      doc.font('Helvetica').fontSize(10).fillColor(muted).text(label, 56, doc.y, { continued: true, width: 160 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(`: ${value}`);
      doc.moveDown(0.35);
    }

    if (row.giver_member_no) {
      doc.font('Helvetica').fontSize(8).fillColor(muted).text(t('receipt.givingCodeHint'), { align: 'right' });
      doc.moveDown(0.4);
    }

    doc.moveDown(1.2);
    if (doc.y > 620) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(24).fillColor(brand).text(
      formatAmount(row.amount, row.currency, locale),
      { align: 'right' }
    );
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(`(${row.currency})`, { align: 'right' });

    doc.moveDown(1.2);
    if (row.notes) {
      doc.font('Helvetica').fontSize(10).fillColor(ink).text(`${t('receipt.notes')}: ${row.notes}`);
      doc.moveDown(0.5);
    }
    doc.font('Helvetica').fontSize(10).fillColor(ink).text(`${t('receipt.recordedBy')}: ${row.recorded_by_name}`);

    // Verification block: the QR code and what it is for, in a bordered box so
    // it reads as the document's own seal rather than as decoration.
    if (row.verification_token) {
      // 520px across, drawn at 108pt (38mm): ~11 px per module at 300dpi, and
      // ~0.85mm per module on paper: comfortably above what a phone camera
      // needs, which is what "scannable at receipt size" has to mean.
      const qr = await qrPngBuffer(verificationUrl(row.verification_token), { width: 520 });
      if (doc.y > 600) doc.addPage();
      doc.moveDown(1.2);
      const boxWidth = doc.page.width - 112;
      const boxHeight = 128;
      const boxTop = doc.y;
      doc.save().roundedRect(56, boxTop, boxWidth, boxHeight, 6).stroke('#E7E0CE').restore();
      const qrSize = 108;
      doc.image(qr, 70, boxTop + (boxHeight - qrSize) / 2, { width: qrSize, height: qrSize });
      const textX = 70 + qrSize + 18;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(ink)
        .text(t('receipt.scanToVerify'), textX, boxTop + 43, { width: boxWidth - (textX - 56) - 12 });
      doc.font('Helvetica').fontSize(9).fillColor(muted)
        .text(verificationHost(), textX, boxTop + 61, { width: boxWidth - (textX - 56) - 12, characterSpacing: 0.5 });
      doc.y = boxTop + boxHeight;
    }

    doc.moveDown(2.5);
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(
      t('receipt.thanks'),
      { align: 'center' }
    );
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(`${CHURCH_NAME} · ${CHURCH_ADDRESS}`, { align: 'center' });
    doc.end();
  };

  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // `write` is async because the QR code is generated inside it; a rejection
    // (the QR library refusing a value, pdfkit refusing an image) has to reach
    // the caller instead of leaving the response hanging forever.
    write().catch(reject);
  });
}

module.exports = {
  nextReceiptNo,
  formatAmount,
  formatDate,
  formatDateTime,
  escapeHtml,
  logoDataUri,
  renderReceiptHtml,
  renderReceiptPdf,
  giverLine,
};
