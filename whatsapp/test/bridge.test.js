const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMessageDeduper,
  normalizeMessagePayload,
  shouldProcessMessage,
  isTransientFailure,
  getBackoffDelay,
} = require('../src/bridge-utils');
const FastApiClient = require('../src/fastapi');
const WhatsAppWebClient = require('../src/whatsapp-web-client');

test('normalizeMessagePayload maps a web.js message into the bridge contract', () => {
  const message = {
    id: { _serialized: 'msg-1' },
    from: '919999999999@c.us',
    body: 'nezuko hello',
    type: 'chat',
    timestamp: 1710000000,
    fromMe: false,
    isStatus: false,
    isBroadcast: false,
    hasMedia: false,
    quotedMsg: {
      body: 'quoted text',
    },
  };

  const normalized = normalizeMessagePayload(message);

  assert.equal(normalized.platform_id, '919999999999@c.us');
  assert.equal(normalized.phone_number, '919999999999');
  assert.equal(normalized.chat_id, '919999999999@c.us');
  assert.equal(normalized.message, 'nezuko hello');
  assert.equal(normalized.quoted_text, 'quoted text');
  assert.equal(normalized.message_type, 'chat');
  assert.equal(normalized.is_group, false);
});

test('message deduper ignores duplicate ids and allows new ones', () => {
  const deduper = createMessageDeduper(10, 1000);

  assert.equal(deduper.shouldProcess('msg-1'), true);
  assert.equal(deduper.shouldProcess('msg-1'), false);
  assert.equal(deduper.shouldProcess('msg-2'), true);
});

test('status and own messages are ignored before processing', () => {
  assert.equal(shouldProcessMessage({ fromMe: true, isStatus: false, isBroadcast: false }), false);
  assert.equal(shouldProcessMessage({ fromMe: false, isStatus: true, isBroadcast: false }), false);
  assert.equal(shouldProcessMessage({ fromMe: false, isStatus: false, isBroadcast: true }), false);
  assert.equal(shouldProcessMessage({ fromMe: false, isStatus: false, isBroadcast: false }), true);
});

test('transient failures are retried and timeouts use backoff', () => {
  assert.equal(isTransientFailure({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientFailure({ response: { status: 429 } }), true);
  assert.equal(isTransientFailure({ response: { status: 500 } }), true);
  assert.equal(isTransientFailure({ response: { status: 400 } }), false);
  assert.equal(getBackoffDelay(1), 250);
  assert.equal(getBackoffDelay(3), 1000);
});

test('FastApiClient retries transient failures before falling back', async () => {
  const client = new FastApiClient();
  let attempts = 0;

  client.client.post = async () => {
    attempts += 1;
    if (attempts < 3) {
      throw { code: 'ECONNRESET' };
    }

    return { data: { status: 'success', reply: 'ok' } };
  };

  const result = await client.forward({ message: 'hello' });

  assert.equal(attempts, 3);
  assert.equal(result.status, 'success');
  assert.equal(result.reply, 'ok');
});

test('FastApiClient returns the fallback reply after repeated timeouts', async () => {
  const client = new FastApiClient();
  client.client.post = async () => {
    throw { code: 'ECONNABORTED', message: 'timeout' };
  };

  const result = await client.forward({ message: 'hello' });

  assert.equal(result.status, 'error');
  assert.equal(result.reply, client.fallbackReply);
});

test('Puppeteer config avoids unsupported single-process flag', () => {
  const client = new WhatsAppWebClient();
  const config = client.getPuppeteerConfig();

  assert.equal(config.headless, true);
  assert.ok(config.args.includes('--no-sandbox'));
  assert.equal(config.args.includes('--single-process'), false);
});
