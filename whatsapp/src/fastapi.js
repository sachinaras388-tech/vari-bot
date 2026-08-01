const axios = require('axios');
const { getEnv, getIntEnv } = require('./config');
const logger = require('./logger');
const { isTransientFailure, getBackoffDelay } = require('./bridge-utils');

class FastApiClient {
  constructor() {
    this.baseUrl = getEnv('FASTAPI_URL', '').replace(/\/$/, '');
    this.endpoint = this.baseUrl ? `${this.baseUrl}/api/v1/whatsapp/message` : '';
    this.timeoutMs = getIntEnv('FASTAPI_TIMEOUT_MS', 8000);
    this.maxRetries = Math.max(0, getIntEnv('FASTAPI_MAX_RETRIES', 1));
    this.retryDelayMs = getIntEnv('FASTAPI_RETRY_DELAY_MS', 100);
    this.fallbackReply = getEnv('FASTAPI_FALLBACK_REPLY', 'Sorry! My brain is taking time. Try again in a bit 😭');
    this.client = axios.create({
      timeout: this.timeoutMs,
      maxRedirects: 3,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  isConfigured() {
    return Boolean(this.endpoint);
  }

  async forward(payload, options = {}) {
    if (!this.isConfigured()) {
      return { status: 'error', reason: 'FASTAPI_URL missing', reply: this.fallbackReply };
    }

    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const startedAt = Date.now();
    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.client.post(this.endpoint, payload, { timeout: timeoutMs });
        const data = this.validateResponse(response?.data);
        logger.info({ attempt: attempt + 1, durationMs: Date.now() - startedAt }, 'FastAPI request completed');
        return data;
      } catch (error) {
        lastError = error;
        const transient = isTransientFailure(error);
        const shouldRetry = transient && attempt < this.maxRetries;
        logger.warn(
          {
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            transient,
            durationMs: Date.now() - startedAt,
            err: error?.message || error,
          },
          shouldRetry ? 'FastAPI request failed; retrying' : 'FastAPI request failed'
        );

        if (!shouldRetry) {
          break;
        }

        await this.delay(getBackoffDelay(attempt) + this.retryDelayMs);
      }
    }

    return {
      status: 'error',
      reason: lastError?.response?.status || 'fastapi_unavailable',
      reply: this.fallbackReply,
      error: lastError?.message || 'FastAPI request failed',
    };
  }

  validateResponse(data) {
    if (!data || typeof data !== 'object') {
      return { status: 'error', reason: 'invalid_response', reply: this.fallbackReply };
    }

    if (data.status === 'success' && typeof data.reply === 'string') {
      return data;
    }

    return {
      status: 'error',
      reason: data.reason || 'invalid_response',
      reply: typeof data.reply === 'string' ? data.reply : this.fallbackReply,
    };
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = FastApiClient;
