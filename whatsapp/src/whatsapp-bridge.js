const axios = require('axios');
const { EventEmitter } = require('events');
const { getEnv, getIntEnv, getBoolEnv } = require('./config');
const logger = require('./logger');
const FastApiClient = require('./fastapi');
const {
  createMessageDeduper,
  normalizeMessagePayload,
  shouldProcessMessage,
  getBackoffDelay,
} = require('./bridge-utils');

class WhatsAppBridge extends EventEmitter {
  constructor() {
    super();
    this.phoneNumber = getEnv('WHATSAPP_PHONE_NUMBER', '');
    this.accessToken = getEnv('WHATSAPP_ACCESS_TOKEN', '');
    this.businessAccountId = getEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', '');
    this.verifyToken = getEnv('WHATSAPP_VERIFY_TOKEN', '');
    this.apiVersion = getEnv('WHATSAPP_API_VERSION', 'v22.0');
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.fastApi = new FastApiClient();
    this.httpClient = axios.create({ timeout: getIntEnv('WHATSAPP_HTTP_TIMEOUT_MS', 15_000) });
    this.connected = false;
    this.ready = false;
    this.connectionStatus = 'stopped';
    this.lastActivityAt = Date.now();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.watchdogTimer = null;
    this.shutdownRequested = false;
    this.messageQueue = [];
    this.processingQueue = false;
    this.messageDeduper = createMessageDeduper(
      getIntEnv('MESSAGE_DEDUP_TTL_MS', 60_000),
      getIntEnv('MESSAGE_DEDUP_MAX_ENTRIES', 5_000),
    );
    this.browserState = { initialized: false, crashed: false, restartCount: 0 };
    this.reconnectDelayMs = getIntEnv('RECONNECT_DELAY_MS', 5_000);
    this.maxReconnectAttempts = getIntEnv('MAX_RECONNECT_ATTEMPTS', 8);
    this.healthCheckIntervalMs = getIntEnv('HEALTHCHECK_INTERVAL_MS', 30_000);
    this.idleRecoveryMs = getIntEnv('IDLE_RECOVERY_MS', 180_000);
    this.watchdogIntervalMs = getIntEnv('WATCHDOG_INTERVAL_MS', 60_000);
    this.enableRecovery = getBoolEnv('WHATSAPP_RECOVERY_ENABLED', true);
    this.enableBrowserRecovery = getBoolEnv('WHATSAPP_BROWSER_RECOVERY_ENABLED', true);
    this.maxQueueSize = getIntEnv('MESSAGE_QUEUE_MAX_SIZE', 200);
    this.inFlight = new Map();
    this.heartbeatTimer = null;
    this.apiTimeoutMs = getIntEnv('WHATSAPP_HTTP_TIMEOUT_MS', 15_000);
    this.configReady = false;
  }

  validateConfig() {
    const missing = [];
    if (!this.phoneNumber) missing.push('WHATSAPP_PHONE_NUMBER');
    if (!this.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
    if (!this.businessAccountId) missing.push('WHATSAPP_BUSINESS_ACCOUNT_ID');

    this.configReady = missing.length === 0;
    if (!this.configReady) {
      logger.warn({ missing }, 'WhatsApp Cloud API config is incomplete; outbound replies will be unavailable until configured');
      this.connectionStatus = 'config_incomplete';
    }
    return this.configReady;
  }

  async start() {
    if (this.shutdownRequested) {
      this.shutdownRequested = false;
    }

    this.validateConfig();
    this.connectionStatus = 'starting';
    this.ready = false;
    this.connected = false;
    this.lastActivityAt = Date.now();
    this.startHeartbeats();
    this.startHealthCheck();
    this.startWatchdog();
    this.emit('bridge:starting');
    logger.info({ state: this.connectionStatus }, 'WhatsApp bridge starting');

    await this.initializeBrowser();
    this.ready = true;
    this.connected = true;
    this.connectionStatus = 'ready';
    this.lastActivityAt = Date.now();
    this.reconnectAttempts = 0;
    this.emit('bridge:ready');
    logger.info({ state: this.connectionStatus }, 'WhatsApp bridge ready');
    this.processQueue();
  }

  async initializeBrowser() {
    if (this.browserState.initialized && !this.browserState.crashed) {
      return;
    }

    this.browserState.crashed = false;
    this.browserState.restartCount += 1;
    logger.info({ restartCount: this.browserState.restartCount }, 'Initializing WhatsApp browser runtime');
    await this.waitForBrowserReady();
    this.browserState.initialized = true;
  }

  async waitForBrowserReady() {
    return new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async stop() {
    this.shutdownRequested = true;
    this.clearReconnectTimer();
    this.clearHealthCheck();
    this.clearWatchdog();
    this.clearHeartbeats();
    this.connected = false;
    this.ready = false;
    this.connectionStatus = 'stopping';
    this.emit('bridge:stopping');
    logger.info('WhatsApp bridge stopping');
    await this.flushQueue();
  }

  async handleIncomingMessage(message) {
    this.markActivity();
    const normalized = normalizeMessagePayload(message);

    if (!normalized) {
      logger.warn('Ignoring incoming message because the payload was invalid');
      return { status: 'ignored', reason: 'invalid_payload' };
    }

    const messageBody = normalized.message || '';
    const shouldProcess = /nezuko/i.test(messageBody) || normalized.quoted_text?.match(/nezuko/i);
    if (!shouldProcess) {
      logger.info({ from: normalized.phone_number }, 'Ignoring WhatsApp message because it did not trigger the bot');
      return { status: 'ignored', reason: 'no_trigger' };
    }

    if (!shouldProcessMessage(message)) {
      logger.info({ from: normalized.phone_number }, 'Ignoring message that is a status, broadcast, or own message');
      return { status: 'ignored', reason: 'ignored_message_type' };
    }

    const dedupeKey = normalized.raw_message_id || `${normalized.chat_id}:${normalized.timestamp}`;
    if (!this.messageDeduper.shouldProcess(dedupeKey)) {
      logger.info({ from: normalized.phone_number, dedupeKey }, 'Ignored duplicate WhatsApp message');
      return { status: 'ignored', reason: 'duplicate_message' };
    }

    if (this.messageQueue.length >= this.maxQueueSize) {
      logger.warn({ queueSize: this.messageQueue.length }, 'Incoming message queue is full; dropping oldest request');
      this.messageQueue.shift();
    }

    this.messageQueue.push({ normalized, dedupeKey, receivedAt: Date.now() });
    this.processQueue();
    return { status: 'queued', reason: 'message_enqueued' };
  }

  async processQueue() {
    if (this.processingQueue || this.messageQueue.length === 0 || !this.ready) {
      return;
    }

    this.processingQueue = true;
    try {
      while (this.messageQueue.length > 0) {
        const item = this.messageQueue.shift();
        if (!item) {
          continue;
        }

        await this.processMessage(item);
      }
    } finally {
      this.processingQueue = false;
    }
  }

  async processMessage(item) {
    const { normalized, dedupeKey } = item;
    this.markActivity();
    logger.info({ from: normalized.phone_number, chatId: normalized.chat_id, dedupeKey }, 'Processing queued WhatsApp message');

    const startTime = Date.now();
    try {
      const result = await this.fastApi.forward(normalized, { timeoutMs: this.apiTimeoutMs });
      const durationMs = Date.now() - startTime;
      this.emit('bridge:message-processed', { normalized, result, durationMs });

      if (!result || result.status !== 'success') {
        const fallbackReply = result?.reply || this.fastApi.fallbackReply;
        logger.warn({ from: normalized.phone_number, durationMs, reason: result?.reason || 'fastapi_unavailable' }, 'FastAPI response was unavailable; returning fallback');
        await this.sendReply(normalized.phone_number, fallbackReply);
        return;
      }

      if (result.reply) {
        await this.sendReply(normalized.phone_number, result.reply);
      }

      logger.info({ from: normalized.phone_number, durationMs }, 'WhatsApp message processed successfully');
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error({ from: normalized.phone_number, durationMs, err: error?.message || error }, 'Unhandled error while processing queued WhatsApp message');
      const fallbackReply = this.fastApi.fallbackReply;
      await this.sendReply(normalized.phone_number, fallbackReply);
    }
  }

  async sendReply(to, text) {
    if (!this.ready || !this.connected || !to || !text) {
      return;
    }

    const responseKey = `${to}:${text}`;
    if (this.inFlight.has(responseKey)) {
      logger.info({ to }, 'Reply already in-flight; skipping duplicate send');
      return;
    }

    this.inFlight.set(responseKey, Date.now() + 60_000);
    try {
      await this.sendText(to, text);
    } finally {
      this.inFlight.delete(responseKey);
    }
  }

  async sendText(to, text) {
    if (!this.configReady) {
      throw new Error('WhatsApp Cloud API is not configured');
    }

    if (!this.ready || !this.connected) {
      throw new Error('Bridge is not ready to send messages');
    }

    const url = `${this.baseUrl}/${this.businessAccountId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    };

    logger.info({ to, messageLength: text.length }, 'Sending outbound WhatsApp text');
    try {
      await this.httpClient.post(url, body, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        timeout: this.apiTimeoutMs,
      });
      logger.info({ to, messageLength: text.length }, 'Outbound WhatsApp text sent successfully');
      return { status: 'success' };
    } catch (error) {
      logger.error({ to, err: error?.message || error }, 'Failed to send outbound WhatsApp text');
      throw error;
    }
  }

  startHeartbeats() {
    this.clearHeartbeats();
    this.heartbeatTimer = setInterval(() => {
      this.emit('bridge:heartbeat', { connected: this.connected, ready: this.ready, queueSize: this.messageQueue.length });
      logger.info({ connected: this.connected, ready: this.ready, queueSize: this.messageQueue.length }, 'Bridge heartbeat');
    }, 30_000);
  }

  clearHeartbeats() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startHealthCheck() {
    this.clearHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastActivityAt;
      if (this.enableRecovery && idleMs > this.idleRecoveryMs) {
        logger.warn({ idleMs }, 'Bridge idle too long; forcing recovery');
        this.recover();
      }
    }, this.healthCheckIntervalMs);
  }

  clearHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  startWatchdog() {
    this.clearWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (!this.ready || !this.connected) {
        logger.warn('Bridge watchdog detected a disconnected state; scheduling recovery');
        this.recover();
      }
    }, this.watchdogIntervalMs);
  }

  clearWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  async recover() {
    if (this.reconnectTimer || this.shutdownRequested || !this.enableRecovery) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error({ attempts: this.reconnectAttempts }, 'Max bridge recovery attempts reached');
      return;
    }

    const attemptNumber = this.reconnectAttempts + 1;
    const delayMs = getBackoffDelay(this.reconnectAttempts) + this.reconnectDelayMs;
    this.reconnectAttempts += 1;
    this.connectionStatus = 'recovering';
    this.emit('bridge:recovering', { attemptNumber, delayMs });
    logger.warn({ attemptNumber, delayMs }, 'Scheduling bridge recovery attempt');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        this.browserState.crashed = true;
        await this.initializeBrowser();
        this.connected = true;
        this.ready = true;
        this.connectionStatus = 'ready';
        this.lastActivityAt = Date.now();
        logger.info({ attemptNumber }, 'Bridge recovery completed');
        this.processQueue();
      } catch (error) {
        logger.error({ err: error?.message || error, attemptNumber }, 'Bridge recovery attempt failed');
        this.reconnectAttempts = Math.min(this.maxReconnectAttempts, this.reconnectAttempts + 1);
        this.recover();
      }
    }, delayMs);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async flushQueue() {
    const pending = this.messageQueue.splice(0, this.messageQueue.length);
    if (pending.length === 0) {
      return;
    }

    logger.info({ pendingCount: pending.length }, 'Flushing pending messages during shutdown');
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

  async handleIncomingWebhook(payload) {
    this.markActivity();
    logger.info({ payloadReceived: Boolean(payload) }, 'Received WhatsApp webhook payload');
    const normalized = normalizeMessagePayload(payload);

    if (!normalized) {
      logger.warn('Ignoring WhatsApp webhook because the payload was invalid');
      return { status: 'ignored', reason: 'invalid_payload' };
    }

    const result = await this.handleIncomingMessage(normalized);
    if (result.status === 'queued') {
      return { status: 'success', reply: '' };
    }

    return result;
  }

  getHealthSnapshot() {
    return {
      connected: this.connected,
      ready: this.ready,
      connectionStatus: this.connectionStatus,
      queueSize: this.messageQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      browserInitialized: this.browserState.initialized,
      browserCrashed: this.browserState.crashed,
      configReady: this.configReady,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  markActivity() {
    this.lastActivityAt = Date.now();
  }
}

module.exports = WhatsAppBridge;
