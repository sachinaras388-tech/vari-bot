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
    return res.status(200).send(String(verification.challenge));
  }
  return res.status(403).send('Forbidden');
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const result = await client.handleIncomingWebhook(req.body);
    if (result?.status === 'success') {
      const phone = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (phone && result.reply) {
        await client.sendText(phone, result.reply);
      }
      return res.status(200).json({ status: 'ok' });
    }

    if (result?.status === 'ignored') {
      return res.status(200).json({ status: 'ok', reason: result.reason });
    }

    return res.status(200).json({ status: 'ok', reason: result?.reason || 'handled' });
  } catch (error) {
    logger.error({ err: error?.message || error }, 'Webhook processing failed');
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
      logger.info({ port: PORT, host }, 'WhatsApp webhook service listening');
    });
  } catch (error) {
    logger.error({ err: error?.message || error }, 'Failed to start WhatsApp service');
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
