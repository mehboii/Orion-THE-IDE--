const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { app } = require('electron');
const { UpdateClient } = require('./update-client');
const { UPDATE_BASE_URL, UPDATE_CHECK_INTERVAL_MS, isLoopback, validateBaseUrl } = require('./update-config');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const CHANNELS = ['stable', 'beta', 'nightly'];
const PLATFORMS = ['windows', 'macos', 'linux'];
const ARCHITECTURES = ['x64', 'arm64'];

function parseSemVer(val) {
  if (typeof val !== 'string' || val.length > 128) {
    throw new Error(`Invalid version string: ${val}`);
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(val);
  if (!match) throw new Error(`Invalid SemVer format: ${val}`);
  if (match[4] && !match[4].split('.').every(p => !/^\d+$/.test(p) || p === '0' || p[0] !== '0')) {
    throw new Error(`Invalid SemVer prerelease identifier: ${val}`);
  }
  return {
    core: match.slice(1, 4).map(BigInt),
    pre: match[4] ? match[4].split('.') : []
  };
}

function compareVersions(a, b) {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) {
      return x.core[i] > y.core[i] ? 1 : -1;
    }
  }
  if (!x.pre.length || !y.pre.length) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined || y.pre[i] === undefined) {
      return x.pre[i] === undefined ? -1 : 1;
    }
    const l = x.pre[i];
    const r = y.pre[i];
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) > BigInt(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

function computeKeyId(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function artifactPayload(manifest, artifact) {
  return Buffer.from(
    JSON.stringify([
      'N11X-ARTIFACT-v1',
      manifest.product,
      manifest.version,
      manifest.channel,
      artifact.platform,
      artifact.architecture,
      artifact.filename,
      artifact.size,
      artifact.sha256
    ]),
    'utf8'
  );
}

function manifestPayload(manifest) {
  return Buffer.from(
    JSON.stringify([
      'N11X-MANIFEST-v1',
      manifest.schemaVersion,
      manifest.product,
      manifest.version,
      manifest.channel,
      manifest.releaseDate,
      manifest.mandatory,
      manifest.minimumSupportedVersion,
      manifest.releaseNotes,
      manifest.keyId,
      manifest.artifacts.map(a => [
        a.platform,
        a.architecture,
        a.filename,
        a.size,
        a.sha256,
        a.signature
      ])
    ]),
    'utf8'
  );
}

function detectPlatform() {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return null;
  }
}

function detectArchitecture() {
  switch (process.arch) {
    case 'arm64':
      return 'arm64';
    case 'x64':
      return 'x64';
    default:
      return null;
  }
}

class UpdateService {
  constructor(options = {}) {
    this.product = options.product || 'orion';
    this.currentVersion = options.currentVersion || (app ? app.getVersion() : require('../package.json').version);
    this.preferences = options.preferences || null;
    this.channel = options.channel || this.preferences?.get('channel', 'stable') || 'stable';
    this.platform = options.platform || detectPlatform();
    this.architecture = options.architecture || detectArchitecture();
    this.serverUrl = options.serverUrl || process.env.N11X_UPDATE_URL || UPDATE_BASE_URL;
    this.clientOptions = options.clientOptions || {};
    this.now = options.now || Date.now;
    this.inFlight = null;
    this.downloadDirectory = options.downloadDirectory || (app ? path.join(app.getPath('userData'), 'updates') : path.join(process.cwd(), '.tmp-updates'));
    this.pinnedKeys = new Map(); // keyId -> crypto.KeyObject
    this.onStatusChanged = options.onStatusChanged || null;
    this.onDownloadProgress = options.onDownloadProgress || null;

    this.state = {
      status: 'idle', // 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
      error: null,
      currentVersion: this.currentVersion,
      latestVersion: null,
      updateAvailable: false,
      mandatory: false,
      releaseDate: null,
      releaseNotes: [],
      minimumSupportedVersion: null,
      artifact: null,
      manifest: null,
      downloadedFile: null,
      downloadProgress: { percent: 0, transferred: 0, total: 0 }
    };

    if (options.pinnedKeys) {
      this.setPinnedKeys(options.pinnedKeys);
    } else {
      this.loadDefaultPinnedKeys();
    }
  }

  setPinnedKeys(keys) {
    this.pinnedKeys.clear();
    const keyArray = Array.isArray(keys) ? keys : [keys];
    for (const item of keyArray) {
      if (!item) continue;
      let pem = typeof item === 'string' ? item : item.pem;
      if (!pem && item.publicKey) pem = item.publicKey;
      if (!pem || !pem.includes('-----BEGIN PUBLIC KEY-----')) continue;
      try {
        const keyObj = crypto.createPublicKey(pem);
        if (keyObj.asymmetricKeyType === 'ed25519') {
          const id = computeKeyId(keyObj);
          this.pinnedKeys.set(id, keyObj);
        }
      } catch (_) {}
    }
  }

  loadDefaultPinnedKeys() {
    // Development trust overrides are allowed only in an unpackaged app on loopback.
    let development = false;
    try { development = !app?.isPackaged && isLoopback(new URL(validateBaseUrl(this.serverUrl))); } catch (_) {}
    if (development && process.env.N11X_UPDATE_PUBLIC_KEY) {
      this.setPinnedKeys([process.env.N11X_UPDATE_PUBLIC_KEY]);
      return;
    }
    if (development && process.env.N11X_UPDATE_PUBLIC_KEYS_PATH && fs.existsSync(process.env.N11X_UPDATE_PUBLIC_KEYS_PATH)) {
      try {
        const content = fs.readFileSync(process.env.N11X_UPDATE_PUBLIC_KEYS_PATH, 'utf8');
        const parsed = JSON.parse(content);
        this.setPinnedKeys(parsed);
        return;
      } catch (_) {}
    }

    // 2. Load from config/update-keys.json
    try {
      const configPath = path.join(__dirname, '../config/update-keys.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.pinnedKeys)) {
          this.setPinnedKeys(data.pinnedKeys);
        }
      }
    } catch (_) {}
  }

  _updateState(partial) {
    this.state = { ...this.state, ...partial };
    if (typeof this.onStatusChanged === 'function') {
      try { this.onStatusChanged(this.getStatus()); } catch (_) { console.warn('[Updates] Status notification failed.'); }
    }
  }

  getStatus() {
    return { ...this.state };
  }

  checkAtStartup() {
    let lastCheck = 0;
    try { lastCheck = this.preferences?.get('lastCheckAt', 0) || 0; } catch (_) {}
    const elapsed = this.now() - lastCheck;
    if (lastCheck && elapsed >= 0 && elapsed < UPDATE_CHECK_INTERVAL_MS) return Promise.resolve(this.getStatus());
    return this.checkForUpdates();
  }

  checkForUpdates() {
    if (this.inFlight) return this.inFlight;
    if (this.state.status === 'downloading') return Promise.resolve(this.getStatus());
    this.inFlight = this._check().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async _check() {
    const { channel, platform, architecture, currentVersion } = this;
    this._updateState({ status: 'checking', error: null, updateAvailable: false,
      artifact: null, manifest: null, latestVersion: null, downloadedFile: null,
      mandatory: false, releaseDate: null, releaseNotes: [], minimumSupportedVersion: null });
    try { this.preferences?.set('lastCheckAt', this.now()); } catch (_) {
      console.warn('[Updates] Unable to save update check time.');
    }
    try {
      parseSemVer(currentVersion);
      if (this.product !== 'orion' || !CHANNELS.includes(channel) ||
          !PLATFORMS.includes(platform) || !ARCHITECTURES.includes(architecture) ||
          ((platform === 'windows' || platform === 'linux') && architecture !== 'x64')) {
        throw new Error('Unsupported Orion update target or channel.');
      }
      const client = new UpdateClient(this.serverUrl, this.clientOptions);
      const response = await client.latest(this.product, { channel, platform, architecture, currentVersion });
      if (response.statusCode === 404 && response.body?.error === 'release_not_found') {
        this._updateState({ status: 'no-release', mandatory: false, releaseNotes: [] });
        return this.getStatus();
      }
      if (response.statusCode !== 200) throw new Error(`Update service returned HTTP ${response.statusCode}.`);
      const body = response.body;
      if (!body || body.product !== this.product || body.channel !== channel ||
          body.currentVersion !== currentVersion || typeof body.updateAvailable !== 'boolean' ||
          typeof body.mandatory !== 'boolean') throw new Error('Invalid update response identity or fields.');
      const newer = compareVersions(body.latestVersion, currentVersion) > 0;
      if (body.updateAvailable !== newer) throw new Error('Update response version comparison mismatch.');
      // Equal/older responses omit the manifest. Retrieve the original signed object
      // from the documented release endpoint instead of trusting unsigned metadata.
      const manifestUrl = client.releaseUrl(this.product, body.latestVersion, channel);
      let manifest = body.manifest;
      if (!manifest) {
        const release = await client.get(manifestUrl);
        if (release.statusCode !== 200) throw new Error('Unable to verify the latest release manifest.');
        manifest = release.body;
      }
      if (body.manifestUrl && new URL(body.manifestUrl, client.baseUrl).href !== manifestUrl) {
        throw new Error('Manifest URL mismatch.');
      }
      this.verifyManifest(manifest);
      if (manifest.version !== body.latestVersion || manifest.product !== this.product || manifest.channel !== channel) {
        throw new Error('Manifest identity does not match the requested release.');
      }
      const artifact = manifest.artifacts.find(a => a.platform === platform && a.architecture === architecture);
      if (!artifact) throw new Error('Manifest does not contain the requested platform and architecture.');
      const downloadUrl = client.downloadUrl(this.product, manifest.version, channel, platform, architecture);
      if (newer) {
        const advertised = body.artifact;
        if (!advertised || ['platform', 'architecture', 'filename', 'size', 'sha256', 'signature'].some(k => advertised[k] !== artifact[k]) ||
            advertised.keyId !== manifest.keyId || advertised.signatureAlgorithm !== 'Ed25519' ||
            advertised.signatureFormat !== 'N11X-ARTIFACT-v1' ||
            new URL(advertised.url, client.baseUrl).href !== downloadUrl) {
          throw new Error('Response artifact does not match the verified release or download route.');
        }
      }
      const mandatory = newer && (manifest.mandatory || (manifest.minimumSupportedVersion !== null &&
        compareVersions(currentVersion, manifest.minimumSupportedVersion) < 0));
      if (body.mandatory !== mandatory) throw new Error('Update policy does not match the signed manifest.');
      this._updateState({ status: newer ? 'available' : 'not-available', updateAvailable: newer,
        latestVersion: manifest.version, mandatory, releaseDate: manifest.releaseDate,
        releaseNotes: manifest.releaseNotes, minimumSupportedVersion: manifest.minimumSupportedVersion,
        artifact: newer ? { ...artifact, url: downloadUrl } : null, manifest, error: null });
    } catch (error) {
      // Optional background work never rejects into the application lifecycle.
      console.warn('[Updates] Update check failed.');
      this._updateState({ status: 'error', updateAvailable: false, artifact: null, manifest: null,
        latestVersion: null, mandatory: false, releaseNotes: [], error: error.message });
    }
    return this.getStatus();
  }

  verifyManifest(m) {
    const record = (value, allowed) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) {
        throw new Error('Invalid manifest record.');
      }
    };
    const signature = value => typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value) &&
      Buffer.from(value, 'base64').toString('base64') === value;
    record(m, ['schemaVersion', 'product', 'version', 'channel', 'releaseDate', 'mandatory',
      'minimumSupportedVersion', 'releaseNotes', 'artifacts', 'keyId', 'signature']);
    parseSemVer(m.version);
    if (m.schemaVersion !== 1 || m.product !== this.product || m.channel !== this.channel ||
        (m.channel === 'stable' && parseSemVer(m.version).pre.length) ||
        typeof m.releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.releaseDate) ||
        !Number.isFinite(Date.parse(m.releaseDate)) || new Date(m.releaseDate).toISOString() !== m.releaseDate ||
        typeof m.mandatory !== 'boolean' || typeof m.keyId !== 'string' || !/^[a-f0-9]{64}$/.test(m.keyId) ||
        !signature(m.signature) || !Array.isArray(m.releaseNotes) || m.releaseNotes.length > 100 ||
        !m.releaseNotes.every(n => typeof n === 'string' && n.length <= 2000 && [...n].every(c => {
          const code = c.codePointAt(0); return code < 0xd800 || code > 0xdfff;
        })) || !Array.isArray(m.artifacts) || m.artifacts.length < 1 || m.artifacts.length > 6) {
      throw new Error('Invalid manifest schema or identity.');
    }
    if (m.minimumSupportedVersion !== null && compareVersions(m.minimumSupportedVersion, m.version) > 0) {
      throw new Error('Invalid minimum supported version.');
    }
    const targets = new Set(), names = new Set();
    for (const a of m.artifacts) {
      record(a, ['platform', 'architecture', 'filename', 'size', 'sha256', 'signature']);
      const target = `${a.platform}-${a.architecture}`;
      if (!PLATFORMS.includes(a.platform) || !ARCHITECTURES.includes(a.architecture) ||
          typeof a.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,179}$/.test(a.filename) ||
          a.filename.includes('..') || a.filename === 'manifest.json' || names.has(a.filename) || targets.has(target) ||
          !Number.isSafeInteger(a.size) || a.size <= 0 || typeof a.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(a.sha256) || !signature(a.signature)) throw new Error('Invalid manifest artifact.');
      names.add(a.filename); targets.add(target);
    }
    const key = this.pinnedKeys.get(m.keyId);
    if (!key) throw new Error('Untrusted signing key ID. Key is not in the pinned trust store.');
    if (!crypto.verify(null, manifestPayload(m), key, Buffer.from(m.signature, 'base64'))) {
      throw new Error('Invalid manifest Ed25519 signature.');
    }
    for (const a of m.artifacts) {
      if (!crypto.verify(null, artifactPayload(m, a), key, Buffer.from(a.signature, 'base64'))) {
        throw new Error('Invalid artifact Ed25519 signature.');
      }
    }
  }

  async downloadUpdate() {
    if (this.state.status !== 'available' || !this.state.artifact) {
      throw new Error('Cannot download update: no verified update is currently available.');
    }
    const artifact = this.state.artifact;
    const temporary = path.join(this.downloadDirectory, `${artifact.filename}.download`);
    const destination = path.join(this.downloadDirectory, artifact.filename);
    this._updateState({ status: 'downloading', downloadProgress: { percent: 0, transferred: 0, total: artifact.size } });
    let timer;
    try {
      await fs.promises.mkdir(this.downloadDirectory, { recursive: true });
      const hash = crypto.createHash('sha256');
      let transferred = 0;
      await new Promise((resolve, reject) => {
        const url = new URL(artifact.url);
        let transferResponse;
        const req = (url.protocol === 'https:' ? https : http).get(url, res => {
          if (res.statusCode !== 200) { res.on('error', reject); res.resume(); reject(new Error(`Download failed with HTTP ${res.statusCode}.`)); return; }
          transferResponse = res;
          const counter = new Transform({ transform: (chunk, _encoding, callback) => {
            transferred += chunk.length;
            if (transferred > artifact.size) return callback(new Error('Downloaded size exceeds signed size.'));
            hash.update(chunk);
            const progress = { percent: Math.round(transferred / artifact.size * 100), transferred, total: artifact.size };
            this.state.downloadProgress = progress;
            try { this.onDownloadProgress?.(progress); } catch (_) {}
            callback(null, chunk);
          } });
          // Pipeline handles backpressure and waits for the file to close before rename.
          pipeline(res, counter, fs.createWriteStream(temporary, { flags: 'w', mode: 0o600 })).then(resolve, reject);
        });
        timer = setTimeout(() => req.destroy(new Error('Update download timed out.')), 10 * 60 * 1000);
        req.setTimeout(15000, () => req.destroy(new Error('Update download connection timed out.')));
        req.on('error', error => {
          if (transferResponse) transferResponse.destroy(error);
          else reject(error);
        });
      });
      if (transferred !== artifact.size || hash.digest('hex') !== artifact.sha256) {
        throw new Error('Downloaded size or SHA-256 does not match the signed artifact.');
      }
      await fs.promises.rename(temporary, destination);
      this._updateState({ status: 'downloaded', downloadedFile: destination, error: null });
      return this.getStatus();
    } catch (error) {
      try { await fs.promises.unlink(temporary); } catch (_) {}
      this._updateState({ status: 'error', updateAvailable: false, artifact: null, error: error.message });
      throw error;
    } finally { clearTimeout(timer); }
  }

  installUpdate() {
    if (this.state.status !== 'downloaded' || !this.state.downloadedFile) {
      throw new Error('No downloaded update ready for installation.');
    }
    // Reveal the verified download; this integration never executes an installer.
    require('electron').shell.showItemInFolder(this.state.downloadedFile);
    return {
      success: true,
      filePath: this.state.downloadedFile,
      version: this.state.latestVersion
    };
  }
}

module.exports = {
  UpdateService,
  compareVersions,
  parseSemVer,
  computeKeyId,
  artifactPayload,
  manifestPayload,
  CHANNELS,
  PLATFORMS,
  ARCHITECTURES
};
