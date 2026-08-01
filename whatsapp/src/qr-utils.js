const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

async function generateQrDataUrl(text) {
  return qrcode.toDataURL(text);
}

async function generateQrPngBuffer(text) {
  return qrcode.toBuffer(text, { type: 'png', margin: 1, scale: 6 });
}

async function generateQrSvgBuffer(text) {
  return qrcode.toString(text, { type: 'svg', margin: 1, scale: 4 });
}

function printQrToTerminal(text) {
  qrcodeTerminal.generate(text, { small: true }, (qr) => {
    console.log('\n[Baileys QR]');
    console.log(qr);
  });
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
  generateQrPngBuffer,
  generateQrSvgBuffer,
  printQrToTerminal,
  resolvePublicUrl,
};
