'use strict';
/**
 * QR codes for printed documents.
 *
 * Two renderers, one code: the HTML receipt and the public verification page
 * embed `qrSvg()`, which draws the modules as vector paths, so the code stays
 * crisp at any print size and at any printer DPI, which a raster preview would
 * not, while the PDF receipt uses `qrPngBuffer()`, because pdfkit places
 * images, not SVG.
 *
 * Both call the same library (`qrcode`) with the same settings, so the code on
 * the screen is the code on the paper is the code in the PDF. The quiet zone is
 * the 4 modules the QR spec requires: without it a camera cannot find the code's
 * edges, however sharp the print is.
 */
const QRCode = require('qrcode');

/** Modules of white space around the code (the spec's minimum quiet zone). */
const QUIET_ZONE = 4;

// Mid-level error correction: enough tolerance for a slightly smudged laser
// print or a thumb over the corner, without inflating the module count a
// verification URL does not need (level H would make the same code denser and
// therefore smaller per module on the same paper).
const ERROR_CORRECTION = 'M';

const DARK = '#111111';
const LIGHT = '#ffffff';

/**
 * The QR code as an inline, self-contained SVG element.
 *
 * Synchronous on purpose: the receipt is rendered by `renderReceiptHtml()`
 * during a request and handed back as a string, so the code has to be built
 * without awaiting anything. Runs of dark modules are merged into horizontal
 * bars, which keeps the path small enough to embed in every receipt.
 */
function qrSvg(text, { size = 132, margin = QUIET_ZONE } = {}) {
  const qr = QRCode.create(String(text), { errorCorrectionLevel: ERROR_CORRECTION });
  const count = qr.modules.size;
  const total = count + margin * 2;

  let path = '';
  for (let y = 0; y < count; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= count; x += 1) {
      const dark = x < count && qr.modules.get(x, y);
      if (dark && runStart === -1) runStart = x;
      if (!dark && runStart !== -1) {
        path += `M${runStart + margin} ${y + margin}h${x - runStart}v1h-${x - runStart}z`;
        runStart = -1;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Verification QR code">` +
    `<rect width="${total}" height="${total}" fill="${LIGHT}"/>` +
    `<path d="${path}" fill="${DARK}"/>` +
    '</svg>'
  );
}

/**
 * The same QR code as a PNG buffer, for pdfkit.
 *
 * 480px across prints at roughly 40mm at 300dpi: comfortably above the size a
 * phone camera needs, and small enough not to take over an A4 page.
 */
function qrPngBuffer(text, { width = 480, margin = QUIET_ZONE } = {}) {
  return QRCode.toBuffer(String(text), {
    type: 'png',
    width,
    margin,
    errorCorrectionLevel: ERROR_CORRECTION,
    color: { dark: DARK, light: LIGHT },
  });
}

module.exports = { qrSvg, qrPngBuffer, QUIET_ZONE };
