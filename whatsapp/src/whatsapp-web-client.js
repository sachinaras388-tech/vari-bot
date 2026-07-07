const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
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
    this.startPromise = null;
    this.lastStartupError = null;
    this.lockDiagnostics = null;
    this.browserProfileDir = null;
    this.activeClientId = 'wbot';
    this.sessionPath = path.resolve(getEnv('WHATSAPP_SESSION_PATH', './.wwebjs-auth'));
    this.headless = getBoolEnv('WHATSAPP_HEADLESS', true);
    this.puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
    ];
  }

  getExecutablePath() {
    const configuredPath = getEnv('PUPPETEER_EXECUTABLE_PATH', '').trim();
    return configuredPath || undefined;
  }

  getClientId() {
    return 'wbot';
  }

  getSessionFolder() {
    return path.join(this.sessionPath, 'session-wbot');
  }

  getBrowserProfileDir() {
    const configuredPath = getEnv('WHATSAPP_BROWSER_PROFILE_DIR', '').trim();
    if (configuredPath) {
      return path.resolve(configuredPath);
    }

    return path.join(this.sessionPath, 'puppeteer-profile-wbot');
  }

  ensureBrowserProfileDir() {
    const browserProfileDir = this.getBrowserProfileDir();
    fs.mkdirSync(browserProfileDir, { recursive: true });
    this.browserProfileDir = browserProfileDir;
    return browserProfileDir;
  }

  getPuppeteerConfig(browserWSEndpoint = '') {
    const args = [...this.puppeteerArgs];
    const browserProfileDir = this.ensureBrowserProfileDir();
    args.push(`--user-data-dir=${browserProfileDir}`);

    if (process.platform === 'linux') {
      args.push('--disable-features=IsolateOrigins,site-per-process');
    }

    const config = {
      headless: this.headless,
      args,
      executablePath: this.getExecutablePath(),
      timeout: getIntEnv('PUPPETEER_TIMEOUT_MS', 120000),
    };

    if (browserWSEndpoint) {
      config.browserWSEndpoint = browserWSEndpoint;
    }

    return config;
  }

  isProfileLockError(error) {
    return /already running|browser is already running|userDataDir|profile/i.test(String(error?.message || error));
  }

  classifyProcessList(processes = [], sessionFolder) {
    const relevant = (processes || []).filter((entry) => {
      const commandLine = [entry.CommandLine, entry.Commandline, entry.commandLine].find(Boolean) || '';
      return commandLine.includes(sessionFolder) || commandLine.includes(this.sessionPath) || commandLine.includes('whatsapp-web.js') || commandLine.includes('puppeteer');
    });

    const nodeProcesses = relevant.filter((entry) => /node\.exe/i.test(entry.Name || entry.name || ''));
    if (nodeProcesses.length > 0) {
      return {
        processType: 'node-process',
        processes: relevant,
      };
    }

    const browserProcesses = relevant.filter((entry) => /chrome|chromium|msedge/i.test(entry.Name || entry.name || ''));
    if (browserProcesses.length === 0) {
      return {
        processType: 'unknown',
        processes: relevant,
      };
    }

    const browserProcess = browserProcesses[0];
    const commandLine = [browserProcess.CommandLine, browserProcess.Commandline, browserProcess.commandLine].find(Boolean) || '';
    const remoteDebuggingPortMatch = /--remote-debugging-port=(\d+)/i.exec(commandLine);
    if (remoteDebuggingPortMatch) {
      return {
        processType: 'puppeteer-instance',
        browserWSEndpoint: `ws://127.0.0.1:${remoteDebuggingPortMatch[1]}/devtools/browser`,
        processes: relevant,
      };
    }

    return {
      processType: 'manual-chrome',
      processes: relevant,
    };
  }

  inspectProfileLock(error) {
    const sessionFolder = this.getSessionFolder();
    const diagnostics = {
      message: String(error?.message || error || ''),
      sessionPath: this.sessionPath,
      sessionFolder,
      browserProfileDir: this.getBrowserProfileDir(),
      processType: 'unknown',
      browserWSEndpoint: '',
      processes: [],
    };

    if (process.platform !== 'win32') {
      return diagnostics;
    }

    try {
      const powerShellOutput = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('chrome.exe','chromium.exe','msedge.exe','node.exe') } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: 'utf8' },
      );

      let parsedProcesses = [];
      if (powerShellOutput) {
        try {
          parsedProcesses = JSON.parse(powerShellOutput);
        } catch (parseError) {
          logger.warn({ err: parseError?.message || parseError }, 'Unable to parse Windows process diagnostics');
        }
      }

      if (!Array.isArray(parsedProcesses)) {
        parsedProcesses = parsedProcesses ? [parsedProcesses] : [];
      }

      const classification = this.classifyProcessList(parsedProcesses, sessionFolder);
      Object.assign(diagnostics, classification);
    } catch (processError) {
      logger.warn({ err: processError?.message || processError }, 'Unable to inspect Windows processes for profile lock diagnostics');
    }

    return diagnostics;
  }

  buildLockedProfileError(lockDiagnostics) {
    const sessionFolder = lockDiagnostics?.sessionFolder || this.getSessionFolder();
    const baseMessage = `Unable to start WhatsApp Web because the LocalAuth session at ${sessionFolder} is already locked.`;

    if (lockDiagnostics?.processType === 'puppeteer-instance') {
      if (lockDiagnostics?.browserWSEndpoint) {
        return `${baseMessage} A Puppeteer/Chromium instance was found and the client will reconnect through the existing DevTools endpoint.`;
      }
      return `${baseMessage} A Chromium/Puppeteer instance is using the profile, but Puppeteer does not expose a reconnectable DevTools endpoint for this session, so startup is aborted.`;
    }

    if (lockDiagnostics?.processType === 'node-process') {
      return `${baseMessage} Another Node.js process is holding the profile. Startup is aborted without creating a new LocalAuth session.`;
    }

    if (lockDiagnostics?.processType === 'manual-chrome') {
      return `${baseMessage} A manually opened Chrome/Chromium instance is using the profile, so startup is aborted without creating a new LocalAuth session.`;
    }

    return `${baseMessage} The lock could not be attributed to a specific process, so startup is aborted without creating a new LocalAuth session.`;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async start() {
    if (this.client) {
      return this.client;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.initializeClient();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async initializeClient() {
    this.status = 'starting';
    this.activeClientId = this.getClientId();
    this.lockDiagnostics = null;
    const authSessionDir = this.getSessionFolder();
    const browserProfileDir = this.ensureBrowserProfileDir();

    logger.info(
      {
        clientId: this.activeClientId,
        sessionPath: this.sessionPath,
        authSessionDir,
        browserProfileDir,
        headless: this.headless,
      },
      'Starting WhatsApp Web client',
    );

    const lockDiagnostics = this.inspectProfileLock({ message: 'startup-check' });
    const browserWSEndpoint = lockDiagnostics.browserWSEndpoint || getEnv('WHATSAPP_BROWSER_WS_ENDPOINT', '').trim();
    this.lockDiagnostics = lockDiagnostics;

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: this.activeClientId, dataPath: this.sessionPath }),
      puppeteer: this.getPuppeteerConfig(browserWSEndpoint),
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
    });

    try {
      await this.client.initialize();
      logger.info(
        {
          authSessionPath: this.sessionPath,
          clientId: this.activeClientId,
          browserProfileDir: this.browserProfileDir || this.getBrowserProfileDir(),
          browserWSEndpoint: browserWSEndpoint || undefined,
        },
        'WhatsApp Web client initialized successfully',
      );
      return this.client;
    } catch (error) {
      this.lastStartupError = error;
      this.ready = false;
      this.authenticated = false;
      this.status = 'start_failed';

      const lockDiagnostics = this.inspectProfileLock(error);
      this.lockDiagnostics = lockDiagnostics;
      logger.error(
        {
          err: error?.message || error,
          stack: error?.stack,
          sessionPath: this.sessionPath,
          diagnostics: lockDiagnostics,
        },
        'WhatsApp client initialization failed',
      );

      if (this.isProfileLockError(error)) {
        throw new Error(this.buildLockedProfileError(lockDiagnostics));
      }

      throw error;
    }
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
    this.status = 'stopping';

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
