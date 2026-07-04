const express = require('express');
const { getEnv, getIntEnv } = require('./src/config');
const logger = require('./src/logger');
const WhatsAppClient = require('./src/whatsapp-client');

const app = express();
app.use(express.json());

const PORT = getIntEnv('PORT', 10000);
const host = getEnv('HOST', '0.0.0.0');
const client = new WhatsAppClient();

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-webhook', mode: 'cloud-api' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), connected: client.connected });
});

app.get('/webhook/whatsapp', (req, res) => {
  const verification = client.verifyWebhook(req.query || {});
  if (verification.ok && verification.challenge) {
    logger.info({ mode: req.query['hub.mode'] }, 'WhatsApp webhook verification succeeded');
    return res.status(200).send(String(verification.challenge));
  }
  logger.warn({ query: req.query }, 'WhatsApp webhook verification failed');
  return res.status(403).send('Forbidden');
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    logger.info('Incoming WhatsApp webhook request received');
    const result = await client.handleIncomingWebhook(req.body);
    if (result?.status === 'success') {
      const phone = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (phone && result.reply) {
        logger.info({ to: phone }, 'Sending bot reply to WhatsApp');
        await client.sendText(phone, result.reply);
      }
      logger.info({ to: phone || 'unknown' }, 'WhatsApp webhook processed successfully');
      return res.status(200).json({ status: 'ok' });
    }

    if (result?.status === 'ignored') {
      logger.info({ reason: result.reason }, 'WhatsApp webhook ignored');
      return res.status(200).json({ status: 'ok', reason: result.reason });
    }

    logger.warn({ reason: result?.reason || 'handled' }, 'WhatsApp webhook completed with warning');
    return res.status(200).json({ status: 'ok', reason: result?.reason || 'handled' });
  } catch (error) {
    logger.error({ err: error?.message || error, stack: error?.stack }, 'Webhook processing failed');
    return res.status(500).json({ status: 'error', message: 'Webhook processing failed' });
  }
});

app.post('/webhook/verify', (req, res) => {
  const mode = getEnv('WHATSAPP_WEBHOOK_VERIFY_MODE', 'subscribe');
  res.json({ status: 'ok', mode });
});

async function main() {
  try {
    client.start();
    app.listen(PORT, host, () => {
      logger.info({ port: PORT, host, mode: 'webhook' }, 'WhatsApp webhook service listening');
      logger.info({ configured: client.configReady }, 'WhatsApp connection status ready');
    });
  } catch (error) {
    logger.error({ err: error?.message || error, stack: error?.stack }, 'Failed to start WhatsApp service');
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  client.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  client.stop();
  process.exit(0);
});

main();
