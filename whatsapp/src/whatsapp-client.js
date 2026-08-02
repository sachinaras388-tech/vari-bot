const { getEnv, getBoolEnv } = require('./config');

function selectWhatsAppClientClass() {
  const clientMode = getEnv('WHATSAPP_CLIENT_MODE', '').toLowerCase();

  if (clientMode === 'bridge') {
    return require('./whatsapp-bridge');
  }

  if (clientMode === 'web') {
    return require('./whatsapp-web-client');
  }

  if (clientMode === 'baileys') {
    return require('./baileys-client');
  }

  const useQr = getBoolEnv('USE_QR', false);
  const usePairing = getBoolEnv('USE_PAIRING_CODE', false);

  const cloudConfigured = Boolean(
    getEnv('WHATSAPP_PHONE_NUMBER', '').trim() &&
    getEnv('WHATSAPP_ACCESS_TOKEN', '').trim() &&
    getEnv('WHATSAPP_PHONE_NUMBER_ID', '').trim() &&
    getEnv('WHATSAPP_BUSINESS_ACCOUNT_ID', '').trim()
  );

  if (useQr || usePairing || !cloudConfigured) {
    return require('./baileys-client');
  }

  return require('./whatsapp-bridge');
}

class WhatsAppClient {
  constructor() {
    const ClientClass = selectWhatsAppClientClass();
    return new ClientClass();
  }
}

module.exports = WhatsAppClient;
