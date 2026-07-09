const qrcode = require('qrcode');

async function generateQrDataUrl(text) {
  return qrcode.toDataURL(text);
}

function resolvePublicUrl(req, fallbackUrl) {
  if (req?.protocol && req?.get) {
    const host = req.get('host');
    if (host) {
      return `${req.protocol}://${host}`;
    }
  }

  return fallbackUrl || '';
}

module.exports = {
  generateQrDataUrl,
  resolvePublicUrl,
};
