const dotenv = require('dotenv');
dotenv.config();

const axios = require('axios');
const express = require('express');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

const pino = require('pino');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

dns.setServers(['8.8.8.8', '8.8.4.4']);

const phoneNumber = String(process.env.WHATSAPP_PHONE_NUMBER || '').trim();
const nodeEnv = String(process.env.NODE_ENV || '').trim();
const portValue = Number(process.env.PORT);

if (!phoneNumber) {
  console.error('[WA][FATAL] Missing required environment variable: WHATSAPP_PHONE_NUMBER');
  process.exit(1);
}

if (!/^[0-9]{10,15}$/.test(phoneNumber)) {
  console.error('[WA][FATAL] WHATSAPP_PHONE_NUMBER must contain only digits and include country code');
  process.exit(1);
}

if (!nodeEnv) {
  console.error('[WA][FATAL] Missing required environment variable: NODE_ENV');
  process.exit(1);
}

if (!Number.isInteger(portValue) || portValue <= 0) {
  console.error('[WA][FATAL] Missing or invalid required environment variable: PORT');
  process.exit(1);
}

// ---------- Dummy Server for Render ----------
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Nezuko Bot is Awake! 🌸'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
const PORT = portValue;
const server = app.listen(PORT, () => console.log(`[WA][INFO] Dummy server listening on port ${PORT}`));

const ConnectionStates = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  AWAITING_PAIRING_CODE: 'AWAITING_PAIRING_CODE',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  DISCONNECTED: 'DISCONNECTED',
};

let connectionState = ConnectionStates.IDLE;
let isConnecting = false;
let lastActivityAt = Date.now();

function setConnectionState(nextState) {
  if (connectionState === nextState) return;
  logInfo('[WA][STATE] State transition', { from: connectionState, to: nextState });
  connectionState = nextState;
}

function isSocketOpen() {
  return Boolean(sock && sock.ws && sock.ws.readyState === 1);
}

function isSocketPresent() {
  return Boolean(sock);
}

function markActivity() {
  lastActivityAt = Date.now();
}

function isWhatsAppConnected() {
  return Boolean(isSocketOpen() && lastSocketHealth?.state === 'open');
}

function shouldStartSocket() {
  if (isShuttingDown) {
    logInfo('Socket start skipped: shutting down');
    return false;
  }
  if (isSocketPresent()) {
    logInfo('Socket start skipped: socket already exists');
    return false;
  }
  if (isConnecting) {
    logInfo('Socket start skipped: already connecting');
    return false;
  }
  return true;
}

function isValidPhoneNumber(phone) {
  return /^\d{10,15}$/.test(phone);
}

// ---------- Config ----------
const FASTAPI_URL = process.env.FASTAPI_URL || '';

const OWNER_NUMBER = process.env.OWNER_NUMBER || '';
const BOT_NAME = process.env.BOT_NAME || 'College Community Bot';
const BOT_PREFIX = process.env.BOT_PREFIX || '/';
const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH || '4000');

// Baileys auth state directory (multi-file)
const AUTH_DIR = path.resolve(process.env.WA_AUTH_DIR || './.baileys_auth');
const AUTH_STATE_FILE = path.join(AUTH_DIR, 'auth-state.json');

// Rate limiting
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 6; // messages per window
const senderBuckets = new Map();

// Cache to prevent duplicate message processing (TTL: 120 seconds)
const messageCache = new NodeCache({ stdTTL: 120, checkperiod: 15 });

// Cache for repeated questions -> avoid repeated Gemini/AI calls
const aiResponseCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60 }); // 10 minutes

// Prevent parallel AI work per sender (keeps latency stable)
const inFlightBySender = new Map();

const RECONNECT_BASE_DELAY_MS = Number(process.env.RECONNECT_BASE_DELAY_MS || '3000');
const RECONNECT_MAX_DELAY_MS = Number(process.env.RECONNECT_MAX_DELAY_MS || '60000');
const RECONNECT_MAX_ATTEMPTS = Number(process.env.RECONNECT_MAX_ATTEMPTS || '20');
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || '30000');
const WHATSAPP_API_ENDPOINT = FASTAPI_URL ? `${FASTAPI_URL}/api/v1/whatsapp/message` : '';
const FASTAPI_HTTP_TIMEOUT_MS = Number(process.env.FASTAPI_TIMEOUT_MS || '8000');
const fastApiHttpClient = axios.create({
  timeout: FASTAPI_HTTP_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

let sock = null;
let authState = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let isReconnecting = false;
let isShuttingDown = false;
let lastSocketHealth = null;
let heartbeatUnhealthyCount = 0;
const HEARTBEAT_UNHEALTHY_THRESHOLD = Number(process.env.HEARTBEAT_UNHEALTHY_THRESHOLD || '2');
// auth save handler (populated per start)
let saveCredsFn = null;
let pendingCredsSave = false;

// ---------- Logging helpers ----------
function logInfo(msg, obj) {
  if (obj !== undefined) console.log(`[WA][INFO] ${msg}`, obj);
  else console.log(`[WA][INFO] ${msg}`);
}
function logWarn(msg, obj) {
  if (obj !== undefined) console.warn(`[WA][WARN] ${msg}`, obj);
  else console.warn(`[WA][WARN] ${msg}`);
}
function logError(msg, obj) {
  if (obj !== undefined) console.error(`[WA][ERROR] ${msg}`, obj);
  else console.error(`[WA][ERROR] ${msg}`);
}

function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rssMB: Math.round(usage.rss / 1024 / 1024),
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
  };
}

function getCpuUsage() {
  const usage = process.cpuUsage();
  return {
    userMS: usage.user,
    systemMS: usage.system,
  };
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearHeartbeatTimer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function isRateLimited(senderId) {
  const now = Date.now();
  const bucket = senderBuckets.get(senderId) || { start: now, count: 0 };

  if (now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  senderBuckets.set(senderId, bucket);

  return bucket.count > RATE_LIMIT_MAX;
}

function isOwner(senderId) {
  if (!OWNER_NUMBER) return false;
  return senderId === `${OWNER_NUMBER}@s.whatsapp.net` || senderId === OWNER_NUMBER;
}

async function handleOwnerCommand(sock, msg, text) {
  if (!isOwner(msg.key?.remoteJid)) return false;

  const normalized = String(text || '').trim();
  const cmd = normalized.split(/\s+/)[0];

  if (cmd === '/restart' || cmd === `${BOT_PREFIX}restart`) {
    await sock.sendMessage(msg.key.remoteJid, { text: 'Restarting session... 🔄' }, { quoted: msg });
    setTimeout(() => process.exit(0), 1000);
    return true;
  }

  if (cmd === '/status' || cmd === `${BOT_PREFIX}status`) {
    await sock.sendMessage(msg.key.remoteJid, { text: `Status ✅\nBot: ${BOT_NAME}` }, { quoted: msg });
    return true;
  }

  if (cmd === '/help' || cmd === `${BOT_PREFIX}help`) {
    await sock.sendMessage(
      msg.key.remoteJid,
      {
        text: [
          `${BOT_NAME} owner commands:`,
          `- /status`,
          `- /restart`,
          `Other commands are handled via FastAPI access control.`,
        ].join('\n'),
      },
      { quoted: msg }
    );
    return true;
  }

  return false;
}

function safeSlice(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return str.slice(0, n);
}

function normalizeQuotedText(m) {
  if (!m.quotedMsg || !m.quotedMsg.message) return null;

  const q = m.quotedMsg.message;
  if (q.conversation) return q.conversation;
  if (q.extendedTextMessage?.text) return q.extendedTextMessage.text;
  return null;
}

async function normalizeWhatsAppMessage(sock, m) {
  const fromJid = m.key?.remoteJid;
  const isGroup = !!fromJid && fromJid.endsWith('@g.us');

  const authorJid = m.key?.participant || fromJid;
  const userId = authorJid;

  const phoneNumber = (authorJid || '')
    .replace('@c.us', '')
    .replace('@g.us', '')
    .replace('@s.whatsapp.net', '') || '';

  const senderName = 'Unknown';
  const profileName = '';

  const quotedText = normalizeQuotedText(m);

  const body = safeSlice(m.messageText || m.message?.conversation || '', MAX_MESSAGE_LENGTH);

  const timestamp = m.messageTimestamp ? Number(m.messageTimestamp) : Math.floor(Date.now() / 1000);

  const messageType = m.message?.type || (m.message?.conversation ? 'text' : 'text');

  return {
    platform_id: userId,
    phone_number: phoneNumber,

    sender_name: senderName,
    profile_name: profileName,

    chat_id: fromJid,
    group_id: isGroup ? fromJid : null,
    group_name: isGroup ? fromJid : null,

    message: body,
    quoted_message: quotedText,

    media: m.message?.imageMessage ? { type: 'image' } : m.message?.videoMessage ? { type: 'video' } : null,
    location: null,
    sticker: null,
    voice: null,

    timestamp,
    message_type: messageType,

    is_group: isGroup,
    quoted_text: quotedText,
  };
}

async function forwardToFastAPI(payload, retries = 1) {
  if (!WHATSAPP_API_ENDPOINT) {
    return { status: 'error', reason: 'FASTAPI_URL missing on Render', reply: (process.env.FASTAPI_FALLBACK_REPLY || 'FASTAPI_URL is not configured on this server. ❌') };
  }

  const timeoutMs = Number(process.env.FASTAPI_TIMEOUT_MS || '8000');

  const cacheKey = payload?.platform_id ? `${payload.platform_id}|${payload.message}|${payload.is_group}` : null;

  if (cacheKey) {
    const cached = aiResponseCache.get(cacheKey);
    if (cached) return cached;
  }

  const fallbackReply = process.env.FASTAPI_FALLBACK_REPLY || 'Sorry! My brain is taking time. Try again in a bit 😭';

  const senderKey = payload?.platform_id;
  if (senderKey) {
    const existing = inFlightBySender.get(senderKey);
    if (existing) return existing;
  }

  let inFlightPromise = (async () => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fastApiHttpClient.post(WHATSAPP_API_ENDPOINT, payload, {
          signal: controller.signal,
        }).finally(() => clearTimeout(t));

        return response.data;
      } catch (error) {
        logWarn(`FastAPI request attempt ${attempt} failed: ${error?.message || error}`);

        if (attempt === retries) {
          return { __timeout: true, reply: fallbackReply };
        }

        await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt - 1)));
      }
    }
    return { __timeout: true, reply: fallbackReply };
  })();

  if (senderKey) inFlightBySender.set(senderKey, inFlightPromise);

  try {
    const result = await inFlightPromise;
    if (cacheKey) aiResponseCache.set(cacheKey, result);
    return result;
  } finally {
    if (senderKey) inFlightBySender.delete(senderKey);
  }
}


function extractMessageText(m) {
  const msg = m.message;
  if (!msg) return '';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  return '';
}

async function ensureAuthDir() {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const tempFile = path.join(AUTH_DIR, '.write-test');
    fs.writeFileSync(tempFile, 'ok');
    fs.unlinkSync(tempFile);
  } catch (error) {
    logError('Auth directory unavailable', { error: error?.message || error });
  }
}

async function saveStateSafely(saveCreds) {
  try {
    if (typeof saveCreds === 'function') {
      await saveCreds();
    }
    if (authState?.creds) {
      const statePath = path.join(AUTH_DIR, 'creds.json');
      fs.writeFileSync(statePath, JSON.stringify(authState.creds, null, 2));
    }
  } catch (error) {
    logError('Failed to save auth state', { error: error?.message || error });
  }
}

function shouldReconnect(reason, lastDisconnect) {
  if (isShuttingDown) return false;
  if (connectionState === ConnectionStates.CONNECTING || connectionState === ConnectionStates.RECONNECTING) return false;
  if (connectionState === ConnectionStates.AWAITING_PAIRING_CODE) {
    logInfo('Reconnect skipped: awaiting pairing code');
    return false;
  }
  if (pendingCredsSave) {
    logInfo('Reconnect skipped: pending credentials save');
    return false;
  }
  if (reason === 'logout') return false;
  if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) return false;
  if (reason === 'bad_session') return false;
  if (reason === 'connection_replaced') return true;
  if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.connectionReplaced) return true;
  if (reason === 'network_lost' || reason === 'stream_error' || reason === 'restart_required' || reason === 'timeout' || reason === 'websocket_closed' || reason === 'unhandled_rejection' || reason === 'uncaught_exception' || reason === 'heartbeat_unhealthy') return true;
  return false;
}

const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
function getReconnectDelay(attempt) {
  const index = Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1);
  return Math.min(RECONNECT_BACKOFF_MS[index], RECONNECT_MAX_DELAY_MS) + Math.floor(Math.random() * 500);
}

async function stopSocket(reason = 'shutdown') {
  clearReconnectTimer();
  clearHeartbeatTimer();

  if (sock) {
    try {
      logWarn('Stopping existing socket', { reason, id: sock?.user?.id, state: lastSocketHealth });
      try {
        sock.ev.removeAllListeners?.();
      } catch (err) {
        logWarn('Failed to remove event listeners cleanly', { error: err?.message || err });
      }

      try {
        // prefer graceful close; if not available, terminate
        if (sock.ws && typeof sock.ws.close === 'function') await sock.ws.close();
        else if (sock.ws && typeof sock.ws.terminate === 'function') sock.ws.terminate();
      } catch (err) {
        logWarn('Socket close warning', { error: err?.message || err });
      }
    } catch (error) {
      logWarn('Socket stop outer warning', { error: error?.message || error });
    }
    sock = null;
  }
}

async function reconnectSocket(reason = 'unknown', lastDisconnect) {
  if (isShuttingDown) {
    logInfo('Reconnect skipped due to shutdown', { reason });
    return;
  }

  if (!shouldReconnect(reason, lastDisconnect)) {
    logInfo('Reconnect skipped by shouldReconnect', { reason, statusCode: lastDisconnect?.error?.output?.statusCode });
    return;
  }

  if (isReconnecting) {
    logInfo('Reconnect already in progress; skipping duplicate', { reason });
    return;
  }

  if (isSocketPresent() && isSocketOpen()) {
    logInfo('Reconnect skipped: active socket still open', { reason });
    return;
  }

  isReconnecting = true;
  setConnectionState(ConnectionStates.RECONNECTING);
  reconnectAttempts += 1;
  const attempt = reconnectAttempts;
  const delay = getReconnectDelay(attempt);

  logWarn('Reconnect scheduled', { attempt, reason, delayMs: delay, memory: getMemoryUsage() });

  clearReconnectTimer();
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      logInfo('Reconnect started', { attempt, reason });
      await stopSocket('reconnect');
      await start();
      isReconnecting = false;
      logInfo('Reconnect completed', { attempt });
    } catch (error) {
      logError('Reconnect failed', { attempt, error: error?.message || error, stack: error?.stack });
      isReconnecting = false;
      if (attempt < RECONNECT_MAX_ATTEMPTS) {
        reconnectSocket('retry_failed', null);
      } else {
        logError('Max reconnect attempts reached; exiting', { attempt });
        process.exit(1);
      }
    }
  }, delay);
}

async function start() {
  if (!shouldStartSocket()) return;
  isConnecting = true;
  setConnectionState(ConnectionStates.CONNECTING);

  logInfo('Starting Baileys socket...', { authDir: AUTH_DIR, memory: getMemoryUsage() });

  try {
    await ensureAuthDir();

    const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'info' });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    authState = state;
    // expose saveCreds to outer scope for use across reconnects
    saveCredsFn = saveCreds;
    logInfo('[AUTH] Credentials loaded', { hasCreds: Boolean(authState?.creds) });

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    isReconnecting = false;
    lastSocketHealth = { timestamp: Date.now(), state: 'starting' };
    markActivity();
  } catch (error) {
    logError('Start failed', { error: error?.message || error, stack: error?.stack });
    throw error;
  } finally {
    isConnecting = false;
  }

  // register saveCreds directly so Baileys persists credentials safely
  sock.ev.on('creds.update', saveCredsFn);

  // Consolidated connection.update handler with detailed logging
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr, receivedPendingNotifications, isOnline, isNewLogin } = update;

      logInfo('[WA][EVENT] connection.update', {
        connection,
        lastDisconnect: lastDisconnect ? { message: lastDisconnect?.error?.message, output: lastDisconnect?.error?.output } : null,
        wsReadyState: sock?.ws?.readyState,
        userId: sock?.user?.id,
      });

      if (qr) {
        logWarn('[WA][AUTH] Unexpected QR payload received while using pairing auth; ignoring QR data');
      }

      if (connection === 'connecting') {
        setConnectionState(ConnectionStates.CONNECTING);
        logInfo('[WA][STATE] Connecting');
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        isReconnecting = false;
        heartbeatUnhealthyCount = 0;
        lastSocketHealth = { timestamp: Date.now(), state: 'open' };
        setConnectionState(ConnectionStates.CONNECTED);
        markActivity();
        logInfo('[WA][STATE] Connected', { isOnline, isNewLogin, receivedPendingNotifications });
        return;
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.status || null;
        const reason = lastDisconnect?.error?.output?.payload?.message || lastDisconnect?.error?.message || 'unknown';
        lastSocketHealth = { timestamp: Date.now(), state: 'closed' };
        setConnectionState(ConnectionStates.DISCONNECTED);
        logWarn('[WA][STATE] Disconnected', { statusCode, reason, lastDisconnect });

        if (statusCode === DisconnectReason.loggedOut || reason === 'bad_session' || reason === 'connection_replaced') {
          logError('[WA][STATE] Permanent disconnect detected; clearing auth state', { statusCode, reason });
          if (statusCode === DisconnectReason.loggedOut || reason === 'bad_session') {
            try {
              await stopSocket('logout_or_bad_session');
            } catch (error) {
              logError('Error during permanent disconnect cleanup', { error: error?.message || error });
            }
          }
          return;
        }

        if (statusCode === DisconnectReason.restartRequired || reason?.includes('restart_required') || statusCode === 515) {
          logWarn('[WA][STATE] Restart required detected', { statusCode, reason });

          // perform a controlled restart: stop socket, save creds, then reconnect with backoff
          try {
            logInfo('[WA][STATE] Performing controlled restart due to server request', { statusCode });
            await saveStateSafely(saveCredsFn);
          } catch (e) {
            logWarn('Failed to save creds before restart', { error: e?.message || e });
          }

          try {
            await stopSocket('restart_required');
          } catch (err) {
            logWarn('Error stopping socket during restart flow', { error: err?.message || err });
          }

          // schedule reconnect (use reconnectSocket which enforces backoff and guards)
          reconnectSocket('restart_required', lastDisconnect);
          return;
        }

        const shouldReconnectNow = shouldReconnect('connection_closed', lastDisconnect);
        if (shouldReconnectNow) {
          await reconnectSocket('connection_closed', lastDisconnect);
        }
      }
    } catch (err) {
      logError('connection.update handler error', { error: err?.message || err, stack: err?.stack });
    }
  });

  sock.ev.on('messages.upsert', (event) => {
    setImmediate(() => {
      handleUpsertEvent(sock, event).catch((error) => {
        logError('messages.upsert outer handler error', { message: error?.message, stack: error?.stack });
      });
    });
  });

  sock.ev.on('ws.close', () => {
    logWarn('[WA][STATE] WebSocket closed', { wsReadyState: sock?.ws?.readyState });
    reconnectSocket('websocket_closed', null).catch((error) => logError('ws.close reconnect failed', { error: error?.message || error }));
  });

  sock.ev.on('ws.error', (error) => {
    logError('[WA][STATE] WebSocket error', { error: error?.message || error });
    reconnectSocket('websocket_error', null).catch((error) => logError('ws.error reconnect failed', { error: error?.message || error }));
  });

  sock.ev.on('stream.error', (error) => {
    logError('[WA][STATE] Stream error', { error: error?.message || error });
    reconnectSocket('stream_error', null).catch((error) => logError('stream.error reconnect failed', { error: error?.message || error }));
  });


  if (!authState?.creds?.registered) {
    try {
      setConnectionState(ConnectionStates.AWAITING_PAIRING_CODE);
      const pairingCode = await sock.requestPairingCode(phoneNumber);
      console.log('==================================');
      console.log('WHATSAPP PAIRING CODE');
      console.log('');
      console.log(pairingCode);
      console.log('');
      console.log('Open WhatsApp');
      console.log('Linked Devices');
      console.log('Link with Phone Number');
      console.log('Enter the code above');
      console.log('==================================');
      logInfo('[AUTH] Pairing code generated');
    } catch (error) {
      logError('[AUTH] requestPairingCode failed', { error: error?.message || error });
      throw error;
    }
  }

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const wsReady = sock?.ws?.readyState;
      const healthy = Boolean(sock && wsReady === 1);
      const idleMs = now - lastActivityAt;

      if (!healthy || idleMs > HEARTBEAT_INTERVAL_MS * 2) {
        heartbeatUnhealthyCount += 1;
        logWarn('[WA][HEARTBEAT] Unhealthy check', {
          attempt: heartbeatUnhealthyCount,
          threshold: HEARTBEAT_UNHEALTHY_THRESHOLD,
          wsReadyState: wsReady,
          idleMs,
          lastState: lastSocketHealth?.state,
          memory: getMemoryUsage(),
          cpu: getCpuUsage(),
        });

        if (heartbeatUnhealthyCount >= HEARTBEAT_UNHEALTHY_THRESHOLD) {
          logWarn('[WA][HEARTBEAT] Threshold reached; scheduling reconnect', { heartbeatUnhealthyCount });
          heartbeatUnhealthyCount = 0;
          if (connectionState !== ConnectionStates.AWAITING_PAIRING_CODE) {
            reconnectSocket('heartbeat_unhealthy', null).catch((error) => logError('heartbeat reconnect failed', { error: error?.message || error }));
          }
        }
        return;
      }

      heartbeatUnhealthyCount = 0;
      logInfo('[WA][HEARTBEAT] Healthy', { wsReadyState: wsReady, idleMs, memory: getMemoryUsage(), cpu: getCpuUsage() });
      lastSocketHealth = { timestamp: now, state: 'healthy' };
    }, HEARTBEAT_INTERVAL_MS);
  }

  async function handleUpsertEvent(sock, event) {
    try {
      const m = event?.messages?.[0];

      if (!m || !m.key) return;

      const msgId = m.key?.id;
      if (!msgId) return;
      if (messageCache.has(msgId)) return;
      messageCache.set(msgId, true);

      if (m.key?.fromMe) return;

      const fromJid = m.key.remoteJid;
      if (!fromJid) return;
      if (fromJid.endsWith('@broadcast') || fromJid.endsWith('broadcast')) return;

      const body = extractMessageText(m);
      if (!body && !m.message?.imageMessage && !m.message?.videoMessage) return;

      const senderId = m.key.participant || fromJid;
      const textForTrigger = String(body ?? '').toLowerCase();
      if (!textForTrigger.includes('nezuko')) {
        logInfo('[SKIP] No trigger', { sender: senderId });
        return;
      }
      logInfo('[TRIGGERED] Nezuko activated', { sender: senderId });

      if (isRateLimited(senderId)) {
        logWarn('Rate limited sender:', senderId);
        return;
      }

      let pendingAckMessage = null;

      try {
        pendingAckMessage = await sock.sendMessage(fromJid, { text: '⏳' });
        logInfo('[WA][OUTBOUND] Ack sent', { chat: fromJid });
      } catch (error) {
        logWarn('[WA][OUTBOUND] Ack failed', { error: error?.message || error });
      }

      const ownerHandled = await handleOwnerCommand(sock, m, body);
      if (ownerHandled) return;

      const payload = await normalizeWhatsAppMessage(sock, { ...m, messageText: body });
      logInfo('[WA][INBOUND] Message received', { chat: payload.chat_id, sender: payload.platform_id, length: payload.message?.length || 0 });

      const apiRes = await forwardToFastAPI(payload);
      if (!apiRes) return;
      if (apiRes.status !== 'success') {
        const reason = apiRes.reason || 'unknown';
        logInfo('FastAPI ignored message.', { reason, chat: payload.chat_id });
        return;
      }

      const replyText = (apiRes.reply ?? '').toString().trim();

      try {
        if (pendingAckMessage?.key) {
          await sock.sendMessage(fromJid, { delete: pendingAckMessage.key });
          logInfo('[WA][OUTBOUND] Ack deleted', { chat: fromJid });
        }
      } catch (deleteErr) {
        logWarn('Failed to delete pending ack message', { error: deleteErr?.message || deleteErr });
      }

      if (!replyText) {
        await sock.sendMessage(payload.chat_id, { text: process.env.FASTAPI_FALLBACK_REPLY || 'Sorry! 😭' });
        return;
      }

      await sock.sendMessage(payload.chat_id, { text: replyText }, { quoted: m });
      logInfo('[WA][OUTBOUND] Reply sent', { chat: payload.chat_id, length: replyText.length });
    } catch (error) {
      logError('messages.upsert handler error', { message: error?.message, stack: error?.stack });
    }
  }
}

process.on('uncaughtException', (error) => {
  logError('Unhandled uncaughtException', { message: error?.message, stack: error?.stack });
  reconnectSocket('uncaught_exception', null).catch((reconnectError) => logError('uncaughtException reconnect failed', { error: reconnectError?.message || reconnectError }));
});

process.on('unhandledRejection', (reason) => {
  logError('UnhandledPromiseRejection', { reason: reason?.message || reason });
  reconnectSocket('unhandled_rejection', null).catch((error) => logError('unhandledRejection reconnect failed', { error: error?.message || error }));
});

process.on('SIGINT', async () => {
  isShuttingDown = true;
  logInfo('SIGINT received; shutting down gracefully');
  try {
    await stopSocket('sigint');
    if (server && typeof server.close === 'function') {
      server.close(() => logInfo('HTTP server closed (SIGINT)'));
    }
  } catch (err) {
    logError('Error during SIGINT shutdown', { error: err?.message || err });
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  isShuttingDown = true;
  logInfo('SIGTERM received; shutting down gracefully');
  try {
    await stopSocket('sigterm');
    if (server && typeof server.close === 'function') {
      server.close(() => logInfo('HTTP server closed (SIGTERM)'));
    }
  } catch (err) {
    logError('Error during SIGTERM shutdown', { error: err?.message || err });
  }
  process.exit(0);
});

start().catch((error) => {
  logError('Fatal start() error', { message: error?.message, stack: error?.stack });
  reconnectSocket('startup_failed', null).catch((reconnectError) => logError('Startup reconnect failed', { error: reconnectError?.message || reconnectError }));
});
