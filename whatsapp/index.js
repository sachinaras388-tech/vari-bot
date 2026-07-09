const express = require('express');
const { getEnv, getIntEnv } = require('./src/config');
const logger = require('./src/logger');
const WhatsAppClient = require('./src/whatsapp-client');
const { generateQrDataUrl, resolvePublicUrl } = require('./src/qr-utils');

const app = express();
app.use(express.json());

const PORT = getIntEnv('PORT', 10000);
const host = getEnv('HOST', '0.0.0.0');
const client = new WhatsAppClient();
let server;

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-webhook', mode: 'cloud-api' });
});

app.get('/health', (req, res) => {
  const snapshot = client.getHealthSnapshot();
  res.json({ status: 'ok', uptime: process.uptime(), ...snapshot });
});

app.get('/readyz', (req, res) => {
  const snapshot = client.getHealthSnapshot();
  res.status(snapshot.ready ? 200 : 503).json(snapshot);
});

app.get('/qr', async (req, res) => {
  try {
    const publicUrl = resolvePublicUrl(req, getEnv('PUBLIC_BASE_URL', ''));
    const qrDataUrl = await generateQrDataUrl(publicUrl || 'https://example.com');
    res.json({ qrDataUrl, publicUrl, status: client.status });
  } catch (error) {
    logger.error({ err: error?.message || error }, 'QR endpoint failed');
    res.status(500).json({ status: 'error' });
  }
});

app.get('/qr/device', async (req, res) => {
  try {
    await client.start();
    const snapshot = client.getHealthSnapshot();
    res.json({
      status: snapshot.status,
      qrDataUrl: snapshot.qrDataUrl || '',
      qrCode: snapshot.qrCode || '',
      ready: snapshot.ready,
      authenticated: snapshot.authenticated,
    });
  } catch (error) {
    logger.error({ err: error?.message || error }, 'Device QR endpoint failed');
    res.status(500).json({ status: 'error' });
  }
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
    const result = await client.handleIncomingWebhook?.(req.body);
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
    await client.start();
    server = app.listen(PORT, host, () => {
      logger.info({ port: PORT, host, mode: 'webhook' }, 'WhatsApp webhook service listening');
      logger.info({ configured: client.configReady }, 'WhatsApp connection status ready');
    });
  } catch (error) {
    logger.error({ err: error?.message || error, stack: error?.stack }, 'Failed to start WhatsApp service');
    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down WhatsApp service gracefully');
  try {
    await client.stop();
  } finally {
    if (server) {
      server.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
  }
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error({ err: error?.message || error }, 'SIGTERM shutdown failed');
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error({ err: error?.message || error }, 'SIGINT shutdown failed');
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection captured');
});

process.on('uncaughtException', (error) => {
  logger.error({ err: error?.message || error, stack: error?.stack }, 'Uncaught exception captured');
});

main();
