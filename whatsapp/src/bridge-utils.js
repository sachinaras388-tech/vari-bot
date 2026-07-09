const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 5_000;

function normalizeWebhookPayload(payload) {
  const entry = payload?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const metadata = value?.metadata;
  const message = value?.messages?.[0];

  if (!message || !metadata) {
    return null;
  }

  const from = message?.from || '';
  const type = message?.type || 'text';
  const body = type === 'text' ? message?.text?.body || '' : '';
  const quotedText = message?.context?.text || '';
  const isGroup = Boolean(message?.context?.from);
  const timestamp = Number(message?.timestamp || Date.now() / 1000);

  return {
    platform_id: from,
    phone_number: String(from).replace(/@c\.us$/i, '').replace(/@s\.whatsapp\.net$/i, ''),
    sender_name: '',
    profile_name: '',
    chat_id: `${from}`,
    group_id: isGroup ? `${from}` : null,
    group_name: isGroup ? `${from}` : null,
    message: body,
    quoted_message: quotedText,
    media: Boolean(message?.mediaData || message?.hasMedia),
    location: null,
    sticker: null,
    voice: null,
    timestamp,
    message_type: type,
    is_group: isGroup,
    quoted_text: quotedText,
    raw_message_id: message?.id?.toString?.() || `${from}:${timestamp}`,
  };
}

function normalizeMessagePayload(message, fallbackTimestamp = Date.now() / 1000) {
  if (!message) {
    return null;
  }

  if (message?.entry || message?.object === 'whatsapp_business_account') {
    return normalizeWebhookPayload(message);
  }

  const rawFrom = message.from || message.chatId || message.sender || '';
  const from = String(rawFrom).replace(/@c\.us$/i, '').replace(/@s\.whatsapp\.net$/i, '');
  const chatId = message.chatId || message.from || message.chat?.id || '';
  const isGroup = Boolean(message.isGroup || message.chat?.isGroup || message.isGroupMsg);
  const timestamp = Number(message.timestamp || fallbackTimestamp);
  const rawBody = message.body || message.text || '';
  const quotedBody = message.quotedMsg?.body || message.quotedMsg?.text || message.quotedMessage?.body || '';
  const media = Boolean(message.hasMedia || message.mediaData || message.type === 'image' || message.type === 'video' || message.type === 'document' || message.type === 'audio' || message.type === 'sticker');
  const messageType = message.type || 'chat';

  return {
    platform_id: chatId || rawFrom,
    phone_number: from,
    sender_name: message.notifyName || message.senderName || '',
    profile_name: message.pushname || '',
    chat_id: chatId,
    group_id: isGroup ? chatId : null,
    group_name: isGroup ? chatId : null,
    message: rawBody,
    quoted_message: quotedBody,
    media,
    location: null,
    sticker: null,
    voice: null,
    timestamp,
    message_type: messageType,
    is_group: isGroup,
    quoted_text: quotedBody,
    raw_message_id: message.id?._serialized || message.id || message._data?.id || `${chatId}:${timestamp}`,
  };
}

function createMessageDeduper(ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES) {
  const entries = new Map();

  function cleanup() {
    const now = Date.now();
    for (const [key, expiresAt] of entries.entries()) {
      if (expiresAt <= now) {
        entries.delete(key);
      }
    }
    if (entries.size > maxEntries) {
      const oldestKeys = Array.from(entries.entries()).sort((a, b) => a[1] - b[1]).slice(0, entries.size - maxEntries);
      for (const [key] of oldestKeys) {
        entries.delete(key);
      }
    }
  }

  return {
    shouldProcess(key) {
      if (!key) {
        return false;
      }
      cleanup();
      const now = Date.now();
      const existing = entries.get(key);
      if (existing && existing > now) {
        return false;
      }
      entries.set(key, now + ttlMs);
      return true;
    },
    clear() {
      entries.clear();
    },
    size() {
      cleanup();
      return entries.size;
    },
  };
}

function shouldProcessMessage(message) {
  if (!message) {
    return false;
  }

  if (message.fromMe || message.isStatus || message.isBroadcast) {
    return false;
  }

  if (message.type === 'notification') {
    return false;
  }

  return Boolean(message.body || message.text || message.hasMedia || message.type !== 'chat');
}

function isTransientFailure(error) {
  const status = error?.response?.status || error?.status;
  const code = String(error?.code || error?.cause?.code || error?.message || '').toUpperCase();

  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return [
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT',
    'NETWORK_ERROR',
  ].some((candidate) => code.includes(candidate)) || code.includes('TIMEOUT');
}

function getBackoffDelay(attempt) {
  const baseDelayMs = 250;
  return Math.min(2_000, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

module.exports = {
  normalizeMessagePayload,
  normalizeWebhookPayload,
  createMessageDeduper,
  shouldProcessMessage,
  isTransientFailure,
  getBackoffDelay,
};
