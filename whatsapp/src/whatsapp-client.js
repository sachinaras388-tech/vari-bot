const axios = require('axios');
const { getEnv, getIntEnv, getBoolEnv } = require('./config');
const logger = require('./logger');
const FastApiClient = require('./fastapi');

class WhatsAppClient {
  constructor() {
    this.phoneNumber = getEnv('WHATSAPP_PHONE_NUMBER', '');
    this.accessToken = getEnv('WHATSAPP_ACCESS_TOKEN', '');
    this.businessAccountId = getEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', '');
    this.verifyToken = getEnv('WHATSAPP_VERIFY_TOKEN', '');
    this.apiVersion = getEnv('WHATSAPP_API_VERSION', 'v22.0');
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.reconnectDelayMs = getIntEnv('RECONNECT_DELAY_MS', 5000);
    this.maxReconnectAttempts = getIntEnv('MAX_RECONNECT_ATTEMPTS', 10);
    this.recoveryEnabled = getBoolEnv('WHATSAPP_RECOVERY_ENABLED', true);
    this.httpClient = axios.create({ timeout: getIntEnv('WHATSAPP_HTTP_TIMEOUT_MS', 10000) });
    this.fastApi = new FastApiClient();
    this.connected = false;
    this.configReady = false;
    this.connectionStatus = 'stopped';
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.lastActivityAt = Date.now();
    this.messageCache = new Map();
  }

  validateConfig() {
    const missing = [];
    if (!this.phoneNumber) missing.push('WHATSAPP_PHONE_NUMBER');
    if (!this.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
    if (!this.businessAccountId) missing.push('WHATSAPP_BUSINESS_ACCOUNT_ID');

    if (missing.length) {
      logger.warn({ missing }, 'WhatsApp Cloud API config is incomplete; outbound replies will be unavailable until configured');
      this.configReady = false;
      this.connectionStatus = 'config_incomplete';
      return false;
    }

    this.configReady = true;
    return true;
  }

  start() {
    this.validateConfig();
    this.connected = true;
    this.connectionStatus = this.configReady ? 'ready' : 'ready_with_warnings';
    this.lastActivityAt = Date.now();
    logger.info(
      {
        phoneNumber: this.phoneNumber,
        configured: this.configReady,
        connectionStatus: this.connectionStatus,
      },
      'WhatsApp webhook client initialized'
    );
    this.startHealthCheck();
    return Promise.resolve();
  }

  stop() {
    this.clearReconnectTimer();
    this.clearHealthCheck();
    this.connected = false;
    this.connectionStatus = 'stopped';
    logger.info('WhatsApp webhook client stopped');
  }

  async handleIncomingWebhook(payload) {
    this.markActivity();
    logger.info({ payloadReceived: Boolean(payload) }, 'Received WhatsApp webhook payload');

    const normalized = this.normalizePayload(payload);
    if (!normalized) {
      logger.warn('Ignoring incoming WhatsApp webhook because the payload was invalid');
      return { status: 'ignored', reason: 'invalid_payload' };
    }

    const messageBody = normalized.message || '';
    const shouldProcess = /nezuko/i.test(messageBody) || normalized.quoted_text?.match(/nezuko/i);
    if (!shouldProcess) {
      logger.info({ from: normalized.phone_number }, 'Ignoring WhatsApp message because it did not trigger the bot');
      return { status: 'ignored', reason: 'no_trigger' };
    }

    logger.info({ from: normalized.phone_number, isGroup: normalized.is_group }, 'Processing WhatsApp message');

    const cacheKey = `${normalized.platform_id}:${normalized.message}:${normalized.is_group}`;
    if (this.messageCache.has(cacheKey)) {
      logger.info({ from: normalized.phone_number }, 'Ignored duplicate WhatsApp message');
      return { status: 'ignored', reason: 'duplicate_message' };
    }
    this.messageCache.set(cacheKey, true);
    setTimeout(() => this.messageCache.delete(cacheKey), 120000);

    const apiResult = await this.fastApi.forward(normalized);
    if (!apiResult || apiResult.status !== 'success') {
      const fallback = apiResult?.reply || this.fastApi.fallbackReply;
      logger.error({ from: normalized.phone_number, reason: 'fastapi_unavailable' }, 'FastAPI bot response failed');
      return { status: 'error', reason: 'fastapi_unavailable', reply: fallback };
    }

    logger.info({ from: normalized.phone_number }, 'WhatsApp message processed successfully');
    return { status: 'success', reply: apiResult.reply || '' };
  }

  normalizePayload(payload) {
    const entry = payload?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const metadata = value?.metadata;
    const message = value?.messages?.[0];
    if (!message || !metadata) {
      return null;
    }

    const from = message?.from;
    const type = message?.type;
    const text = type === 'text' ? message?.text?.body || '' : '';
    const quotedText = message?.context?.text || null;
    const isGroup = Boolean(message?.context?.from);
    const chatId = `${from}@s.whatsapp.net`;
    const platformId = `${from}`;
    const timestamp = Number(message?.timestamp || Date.now() / 1000);

    return {
      platform_id: platformId,
      phone_number: from,
      sender_name: '',
      profile_name: '',
      chat_id: chatId,
      group_id: isGroup ? chatId : null,
      group_name: isGroup ? chatId : null,
      message: text,
      quoted_message: quotedText,
      media: null,
      location: null,
      sticker: null,
      voice: null,
      timestamp,
      message_type: type,
      is_group: isGroup,
      quoted_text: quotedText,
    };
  }

  verifyWebhook(query = {}) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token && token === this.verifyToken) {
      return { ok: true, challenge };
    }

    return { ok: false, challenge: null };
  }

  async sendText(to, text) {
    if (!this.connected) {
      throw new Error('WhatsApp client is not connected');
    }

    if (!this.configReady) {
      throw new Error('WhatsApp Cloud API is not configured');
    }

    const url = `${this.baseUrl}/${this.businessAccountId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    };

    try {
      await this.httpClient.post(url, body, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });
      logger.info({ to, messageLength: text.length }, 'WhatsApp outbound message sent successfully');
    } catch (error) {
      logger.error({ to, err: error?.message || error }, 'Failed to send WhatsApp outbound message');
      throw error;
    }
  }

  async sendTemplate(to, templateName, languageCode = 'en_US') {
    const url = `${this.baseUrl}/${this.businessAccountId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    };

    try {
      await this.httpClient.post(url, body, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });
      logger.info({ to, templateName }, 'WhatsApp template message sent successfully');
    } catch (error) {
      logger.error({ to, templateName, err: error?.message || error }, 'Failed to send WhatsApp template message');
      throw error;
    }
  }

  markActivity() {
    this.lastActivityAt = Date.now();
  }

  startHealthCheck() {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastActivityAt;
      if (this.recoveryEnabled && idleMs > 180000) {
        logger.warn({ idleMs }, 'WhatsApp client idle for too long; attempting recovery');
        this.scheduleReconnect();
      }
    }, 60000);
  }

  clearHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  scheduleReconnect() {
    if (!this.recoveryEnabled || this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error({ attempts: this.reconnectAttempts }, 'Max WhatsApp reconnect attempts reached');
      return;
    }

    const delay = this.reconnectDelayMs * (this.reconnectAttempts + 1);
    logger.warn({ delayMs: delay, attempts: this.reconnectAttempts + 1 }, 'Scheduling WhatsApp recovery');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      this.connected = true;
      this.markActivity();
      logger.info('WhatsApp recovery completed');
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

module.exports = WhatsAppClient;
