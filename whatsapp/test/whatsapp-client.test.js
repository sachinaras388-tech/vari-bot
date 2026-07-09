const test = require('node:test');
const assert = require('node:assert/strict');

const WhatsAppClient = require('../src/whatsapp-client');

test('sendText uses the phone number ID for the WhatsApp Cloud API endpoint', async () => {
  process.env.WHATSAPP_PHONE_NUMBER = '123456789';
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-number-id-123';
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = 'business-account-id-456';

  const client = new WhatsAppClient();
  client.connected = true;
  client.configReady = true;

  const requests = [];
  client.httpClient.post = async (url, body, config) => {
    requests.push({ url, body, config });
    return { data: { success: true } };
  };

  await client.sendText('+918660108587', 'hello');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://graph.facebook.com/v22.0/phone-number-id-123/messages');
  assert.equal(requests[0].body.to, '+918660108587');
});
