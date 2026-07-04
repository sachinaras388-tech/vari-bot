const axios = require('axios');
const { getEnv, getIntEnv } = require('./config');
const logger = require('./logger');

class FastApiClient {
  constructor() {
    this.baseUrl = getEnv('FASTAPI_URL', '').replace(/\/$/, '');
    this.endpoint = this.baseUrl ? `${this.baseUrl}/api/v1/whatsapp/message` : '';
    this.timeoutMs = getIntEnv('FASTAPI_TIMEOUT_MS', 8000);
    this.fallbackReply = getEnv('FASTAPI_FALLBACK_REPLY', 'Sorry! My brain is taking time. Try again in a bit 😭');
    this.client = axios.create({
      timeout: this.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  isConfigured() {
    return Boolean(this.endpoint);
  }

  async forward(payload) {
    if (!this.isConfigured()) {
      return { status: 'error', reason: 'FASTAPI_URL missing', reply: this.fallbackReply };
    }

    try {
      const response = await this.client.post(this.endpoint, payload);
      return response.data;
    } catch (error) {
      logger.warn({ err: error?.message || error }, 'FastAPI forwarding failed');
      return { __timeout: true, reply: this.fallbackReply };
    }
  }
}

module.exports = FastApiClient;
