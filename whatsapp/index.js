const express = require('express');
const axios = require('axios');
const { getEnv, getIntEnv, getBoolEnv } = require('./src/config');
const logger = require('./src/logger');
const WhatsAppClient = require('./src/whatsapp-client');
const { generateQrDataUrl, resolvePublicUrl } = require('./src/qr-utils');

const app = express();
app.use(express.json());

const PORT = getIntEnv('PORT', 10000);
const host = getEnv('HOST', '0.0.0.0');
const useQr = getBoolEnv('USE_QR', false);
const usePairing = getBoolEnv('USE_PAIRING_CODE', false);
const mode = useQr || usePairing ? 'whatsapp-web' : 'cloud-api';
const client = new WhatsAppClient();
let server;

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-webhook', mode, qrEnabled: useQr, pairingEnabled: usePairing });
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
    const snapshot = client.getHealthSnapshot();
    if (snapshot.authExpired) {
      return res.status(410).json({ status: 'expired', message: 'QR expired. Restart the service to generate a new QR.' });
    }

    if (!snapshot.qrAvailable) {
      return res.status(404).json({ status: 'idle', message: 'QR code not available' });
    }

    const publicUrl = resolvePublicUrl(req, getEnv('PUBLIC_BASE_URL', ''));
    const qrDataUrl = snapshot.qrDataUrl || (snapshot.qrCode ? await generateQrDataUrl(snapshot.qrCode) : '');
    return res.json({ status: 'ok', qrDataUrl, qrCode: snapshot.qrCode, publicUrl });
  } catch (error) {
    logger.error({ err: error?.message || error }, 'QR endpoint failed');
    return res.status(500).json({ status: 'error', message: 'QR endpoint failed' });
  }
});

app.get('/qr.png', async (req, res) => {
  try {
    const snapshot = client.getHealthSnapshot();
    if (snapshot.authExpired) {
      return res.status(410).type('text/plain').send('QR expired. Restart the service to generate a new QR.');
    }

    if (!snapshot.qrCode) {
      return res.status(404).type('text/plain').send('QR code not available');
    }

    const buffer = await require('./src/qr-utils').generateQrPngBuffer(snapshot.qrCode);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (error) {
    logger.error({ err: error?.message || error }, 'PNG QR endpoint failed');
    return res.status(500).type('text/plain').send('QR endpoint failed');
  }
});

app.get('/qr.svg', async (req, res) => {
  try {
    const snapshot = client.getHealthSnapshot();
    if (snapshot.authExpired) {
      return res.status(410).type('text/plain').send('QR expired. Restart the service to generate a new QR.');
    }

    if (!snapshot.qrCode) {
      return res.status(404).type('text/plain').send('QR code not available');
    }

    const svg = await require('./src/qr-utils').generateQrSvgBuffer(snapshot.qrCode);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(svg);
  } catch (error) {
    logger.error({ err: error?.message || error }, 'SVG QR endpoint failed');
    return res.status(500).type('text/plain').send('QR endpoint failed');
  }
});

app.get('/qr/device', async (req, res) => {
  try {
    await client.start();
    const snapshot = client.getHealthSnapshot();
    return res.json({ status: 'ok', ...snapshot });
  } catch (error) {
    logger.error({ err: error?.message || error }, 'Device QR endpoint failed');
    return res.status(500).json({ status: 'error', message: 'Device QR endpoint failed' });
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

// Internal endpoint used by the backend to request outbound media/text sends
app.post('/internal/send_media', async (req, res) => {
  try {
    const body = req.body || {};
    const to = body.to;
    if (!to) {
      return res.status(400).json({ status: 'error', message: 'missing to' });
    }

    if (body.text) {
      await client.sendText(to, String(body.text));
      return res.json({ status: 'ok' });
    }

    if (!body.media_url) {
      return res.status(400).json({ status: 'error', message: 'missing media_url' });
    }

    const mediaType = body.media_type || 'video';
    const filename = body.filename || null;
    const caption = body.caption || '';
    if (typeof client.sendMedia !== 'function') {
      return res.status(500).json({ status: 'error', message: 'client does not support media send' });
    }

    await client.sendMedia(to, body.media_url, { mediaType, filename, caption });
    // Attempt to notify backend to delete the temporary file (if present)
    try {
      const backendBase = (process.env.FASTAPI_URL || 'http://localhost:8000').replace(/\/$/, '');
      const parsed = new URL(body.media_url);
      const parts = parsed.pathname.split('/');
      const downloadsIdx = parts.indexOf('downloads');
      if (downloadsIdx >= 0 && parts.length > downloadsIdx + 1) {
        const downloadId = parts[downloadsIdx + 1];
        try {
          await axios.post(`${backendBase}/api/v1/whatsapp/downloads/${downloadId}/complete`, {}, { timeout: 5000 });
        } catch (err) {
          logger.warn({ err: err?.message || err }, 'Failed to notify backend for cleanup');
        }
      }
      const ttsIdx = parts.indexOf('tts');
      if (ttsIdx >= 0 && parts.length > ttsIdx + 1) {
        const filename = parts[ttsIdx + 1];
        try {
          await axios.post(`${backendBase}/api/v1/whatsapp/tts/${encodeURIComponent(filename)}/complete`, {}, { timeout: 5000 });
        } catch (err) {
          logger.warn({ err: err?.message || err }, 'Failed to notify backend for TTS cleanup');
        }
      }
    } catch (err) {
      logger.warn({ err: err?.message || err }, 'Failed to parse media_url for cleanup');
    }

    return res.json({ status: 'ok' });
  } catch (error) {
    logger.error({ err: error?.message || error, body: req.body }, 'Internal send_media failed');
    return res.status(500).json({ status: 'error', message: 'send_media failed' });
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
      logger.info({ port: PORT, host, mode, qrEnabled: useQr, pairingEnabled: usePairing }, 'WhatsApp webhook service listening');
      logger.info({ configured: client.configReady, mode }, 'WhatsApp connection status ready');
      if (useQr || usePairing) {
        logger.info({ qrEndpoint: `http://${host}:${PORT}/qr` }, 'QR mode enabled; use the /qr endpoint to retrieve the QR code URL');
      }
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
