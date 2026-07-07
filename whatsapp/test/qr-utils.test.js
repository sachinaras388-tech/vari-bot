const test = require('node:test');
const assert = require('node:assert/strict');
const { generateQrDataUrl, resolvePublicUrl } = require('../src/qr-utils');

test('generateQrDataUrl returns a PNG data URL', async () => {
  const dataUrl = await generateQrDataUrl('https://example.com');
  assert.match(dataUrl, /^data:image\/png;base64,/);
});

test('resolvePublicUrl uses the request host when no explicit URL is supplied', () => {
  const url = resolvePublicUrl({ protocol: 'https', get: () => 'example.com' }, 'https://fallback.example');
  assert.equal(url, 'https://example.com');
});
