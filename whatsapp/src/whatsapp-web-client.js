const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { getEnv, getIntEnv, getBoolEnv } = require('./config');
const logger = require('./logger');
const { generateQrDataUrl } = require('./qr-utils');

class WhatsAppWebClient {
  constructor() {
    this.client = null;
    this.ready = false;
    this.authenticated = false;
    this.qrCode = '';
    this.qrDataUrl = '';
    this.status = 'stopped';
    this.lastSeen = null;
    this.pendingQr = null;
    this.sessionPath = getEnv('WHATSAPP_SESSION_PATH', './.wwebjs-auth');
    this.headless = getBoolEnv('WHATSAPP_HEADLESS', true);
    this.puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--single-process',
    ];
  }

  async start() {
    if (this.client) {
      return this.client;
    }

    this.status = 'starting';
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: 'wbot', dataPath: this.sessionPath }),
      puppeteer: {
        headless: this.headless,
        args: this.puppeteerArgs,
      },
      takeoverOnConflict: false,
      restartOnAuthFail: true,
      qrTimeout: getIntEnv('WHATSAPP_QR_TIMEOUT_MS', 60000),
    });

    this.client.on('qr', async (qr) => {
      this.qrCode = qr;
      this.qrDataUrl = await generateQrDataUrl(qr);
      this.pendingQr = qr;
      this.status = 'qr_required';
      logger.info({ qrLength: qr.length }, 'WhatsApp QR code received');
    });

    this.client.on('ready', () => {
      this.ready = true;
      this.authenticated = true;
      this.status = 'ready';
      this.lastSeen = new Date().toISOString();
      logger.info('WhatsApp Web client is ready');
    });

    this.client.on('auth_failure', (message) => {
      this.ready = false;
      this.authenticated = false;
      this.status = 'auth_failed';
      logger.error({ message }, 'WhatsApp Web authentication failed');
    });

    this.client.on('change_state', (state) => {
      logger.info({ state }, 'WhatsApp Web client state changed');
    });

    this.client.on('disconnected', (reason) => {
      this.ready = false;
      this.authenticated = false;
      this.status = 'disconnected';
      logger.warn({ reason }, 'WhatsApp Web client disconnected');
      this.restart();
    });

    await this.client.initialize();
    return this.client;
  }

  async restart() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (error) {
        logger.warn({ err: error?.message || error }, 'Whatsapp client destroy failed');
      }
    }

    this.client = null;
    this.ready = false;
    this.authenticated = false;
    this.status = 'restarting';
    await this.start();
  }

  async stop() {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (error) {
        logger.warn({ err: error?.message || error }, 'Whatsapp client shutdown failed');
      }
    }

    this.client = null;
    this.ready = false;
    this.authenticated = false;
    this.status = 'stopped';
  }

  getHealthSnapshot() {
    return {
      ready: this.ready,
      authenticated: this.authenticated,
      status: this.status,
      qrAvailable: Boolean(this.qrDataUrl),
      qrCode: this.qrCode,
      lastSeen: this.lastSeen,
    };
  }

  async sendText(to, text) {
    if (!this.client || !this.ready) {
      throw new Error('WhatsApp Web client is not ready');
    }
    return this.client.sendMessage(to, text);
  }

  async getChatById(chatId) {
    if (!this.client || !this.ready) {
      throw new Error('WhatsApp Web client is not ready');
    }
    return this.client.getChatById(chatId);
  }
}

module.exports = WhatsAppWebClient;
