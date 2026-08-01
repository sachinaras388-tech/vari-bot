const { getEnv, getBoolEnv } = require('./config');
const WhatsAppBridge = require('./whatsapp-bridge');
const WhatsAppWebClient = require('./whatsapp-web-client');
const BaileysClient = require('./baileys-client');

function selectWhatsAppClientClass() {
  const clientMode = getEnv('WHATSAPP_CLIENT_MODE', '').toLowerCase();
  if (clientMode === 'bridge') {
    return WhatsAppBridge;
  }
  if (clientMode === 'web') {
    return WhatsAppWebClient;
  }
  if (clientMode === 'baileys') {
    return BaileysClient;
  }

  const useQr = getBoolEnv('USE_QR', false);
  const usePairing = getBoolEnv('USE_PAIRING_CODE', false);
  const cloudConfigured = Boolean(
    getEnv('WHATSAPP_PHONE_NUMBER', '').trim() &&
    getEnv('WHATSAPP_ACCESS_TOKEN', '').trim() &&
    getEnv('WHATSAPP_PHONE_NUMBER_ID', '').trim() &&
    getEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', '').trim()
  );

  return useQr || usePairing || !cloudConfigured ? BaileysClient : WhatsAppBridge;
}

class WhatsAppClient {
  constructor() {
    const ClientClass = selectWhatsAppClientClass();
    return new ClientClass();
  }
}

module.exports = WhatsAppClient;
