const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { app } = require('electron');

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
      return 'windows';
  }
}

function detectArchitecture() {
  switch (process.arch) {
    case 'arm64':
      return 'arm64';
    case 'x64':
    default:
      return 'x64';
  }
}

class UpdateService {
  constructor(options = {}) {
    this.product = options.product || 'orion';
    this.currentVersion = options.currentVersion || (app ? app.getVersion() : '13.0.1');
    this.channel = options.channel || 'stable';
    this.platform = options.platform || detectPlatform();
    this.architecture = options.architecture || detectArchitecture();
    this.serverUrl = options.serverUrl || process.env.N11X_UPDATE_URL || 'http://127.0.0.1:8091';
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
    // 1. Check environment variable for test/dev public keys
    if (process.env.N11X_UPDATE_PUBLIC_KEY) {
      this.setPinnedKeys([process.env.N11X_UPDATE_PUBLIC_KEY]);
      return;
    }
    if (process.env.N11X_UPDATE_PUBLIC_KEYS_PATH && fs.existsSync(process.env.N11X_UPDATE_PUBLIC_KEYS_PATH)) {
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
      this.onStatusChanged(this.state);
    }
  }

  getStatus() {
    return { ...this.state };
  }

  _httpGet(urlStr) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(urlStr);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(urlStr, { timeout: 15000 }, (res) => {
        const statusCode = res.statusCode || 0;
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode, headers: res.headers, body: data });
        });
      });

      req.on('error', err => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out to ${urlStr}`));
      });
    });
  }

  async checkForUpdates(customOptions = {}) {
    const channel = customOptions.channel || this.channel;
    const platform = customOptions.platform || this.platform;
    const architecture = customOptions.architecture || this.architecture;
    const currentVersion = customOptions.currentVersion || this.currentVersion;

    this._updateState({
      status: 'checking',
      error: null
    });

    try {
      const query = new URLSearchParams({
        channel,
        platform,
        architecture,
        currentVersion
      });
      const url = `${this.serverUrl}/v1/${this.product}/latest?${query.toString()}`;

      const res = await this._httpGet(url);

      if (res.statusCode === 404) {
        // No release exists for this product/channel/platform
        this._updateState({
          status: 'not-available',
          updateAvailable: false,
          mandatory: false,
          latestVersion: currentVersion,
          error: null
        });
        return this.getStatus();
      }

      if (res.statusCode !== 200) {
        let errMsg = `Update service returned status ${res.statusCode}`;
        try {
          const errObj = JSON.parse(res.body);
          if (errObj.error) errMsg += `: ${errObj.error}`;
        } catch (_) {}
        throw new Error(errMsg);
      }

      const body = JSON.parse(res.body);

      if (!body.updateAvailable) {
        this._updateState({
          status: 'not-available',
          updateAvailable: false,
          mandatory: false,
          latestVersion: body.latestVersion || currentVersion,
          error: null
        });
        return this.getStatus();
      }

      // If update is available, verify manifest and artifact strictly
      const manifest = body.manifest;
      const artifact = body.artifact;

      if (!manifest || !artifact) {
        throw new Error('Update service reported an available update but omitted manifest or artifact.');
      }

      // 1. Verify that the advertised version is strictly greater than current version
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        throw new Error(`Server offered non-advancing version: ${manifest.version} <= ${currentVersion}`);
      }

      // 2. Verify manifest schema and fields
      if (manifest.schemaVersion !== 1) {
        throw new Error(`Unsupported manifest schema version: ${manifest.schemaVersion}`);
      }
      if (manifest.product !== this.product || manifest.channel !== channel) {
        throw new Error(`Manifest product/channel mismatch: expected ${this.product}/${channel}, got ${manifest.product}/${manifest.channel}`);
      }

      // 3. Verify Ed25519 signature of manifest using pinned keys
      const key = this.pinnedKeys.get(manifest.keyId);
      if (!key) {
        throw new Error(`Untrusted signing key ID: ${manifest.keyId}. Key is not in pinned trust store.`);
      }

      const mPayload = manifestPayload(manifest);
      const isManifestSigValid = crypto.verify(
        null,
        mPayload,
        key,
        Buffer.from(manifest.signature, 'base64')
      );
      if (!isManifestSigValid) {
        throw new Error('Invalid manifest Ed25519 signature.');
      }

      // 4. Verify artifact in manifest matching target platform & architecture
      const matchedArtifact = manifest.artifacts.find(
        a => a.platform === platform && a.architecture === architecture
      );
      if (!matchedArtifact) {
        throw new Error(`Manifest does not contain an artifact for ${platform}-${architecture}.`);
      }

      // 5. Verify Ed25519 signature of the target artifact record
      const aPayload = artifactPayload(manifest, matchedArtifact);
      const isArtifactSigValid = crypto.verify(
        null,
        aPayload,
        key,
        Buffer.from(matchedArtifact.signature, 'base64')
      );
      if (!isArtifactSigValid) {
        throw new Error(`Invalid artifact Ed25519 signature for ${matchedArtifact.filename}.`);
      }

      // 6. Verify that body.artifact matches the cryptographically verified matchedArtifact
      if (
        artifact.filename !== matchedArtifact.filename ||
        artifact.size !== matchedArtifact.size ||
        artifact.sha256 !== matchedArtifact.sha256 ||
        artifact.signature !== matchedArtifact.signature
      ) {
        throw new Error('Payload artifact does not match verified manifest artifact record.');
      }

      // Verification passed! Update state to available
      this._updateState({
        status: 'available',
        updateAvailable: true,
        mandatory: Boolean(body.mandatory),
        latestVersion: manifest.version,
        releaseDate: manifest.releaseDate,
        releaseNotes: Array.isArray(manifest.releaseNotes) ? manifest.releaseNotes : [],
        minimumSupportedVersion: manifest.minimumSupportedVersion,
        artifact,
        manifest,
        error: null
      });

      return this.getStatus();
    } catch (err) {
      this._updateState({
        status: 'error',
        error: err.message
      });
      throw err;
    }
  }

  async downloadUpdate() {
    if (this.state.status !== 'available' || !this.state.artifact) {
      throw new Error('Cannot download update: no verified update is currently available.');
    }

    const artifact = this.state.artifact;
    const downloadUrl = artifact.url;
    if (!downloadUrl) {
      throw new Error('Artifact has no download URL.');
    }

    this._updateState({
      status: 'downloading',
      downloadProgress: { percent: 0, transferred: 0, total: artifact.size }
    });

    await fs.promises.mkdir(this.downloadDirectory, { recursive: true });
    const tempFilePath = path.join(this.downloadDirectory, `${artifact.filename}.download`);
    const finalFilePath = path.join(this.downloadDirectory, artifact.filename);

    // Clean up any stale partial download
    if (fs.existsSync(tempFilePath)) {
      try { await fs.promises.unlink(tempFilePath); } catch (_) {}
    }

    return new Promise((resolve, reject) => {
      const urlObj = new URL(downloadUrl);
      const client = urlObj.protocol === 'https:' ? https : http;

      const req = client.get(downloadUrl, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return reject(new Error(`Download failed with HTTP status ${res.statusCode}`));
        }

        const fileStream = fs.createWriteStream(tempFilePath);
        const hash = crypto.createHash('sha256');
        let transferred = 0;
        const total = artifact.size;

        res.on('data', chunk => {
          hash.update(chunk);
          transferred += chunk.length;
          fileStream.write(chunk);

          const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
          this.state.downloadProgress = { percent, transferred, total };
          if (typeof this.onDownloadProgress === 'function') {
            this.onDownloadProgress(this.state.downloadProgress);
          }
        });

        res.on('end', async () => {
          fileStream.end();
          const calculatedSha256 = hash.digest('hex');

          // Strict verification of downloaded byte count and SHA-256
          if (transferred !== artifact.size) {
            try { await fs.promises.unlink(tempFilePath); } catch (_) {}
            const err = new Error(`Downloaded size mismatch: expected ${artifact.size} bytes, got ${transferred} bytes.`);
            this._updateState({ status: 'error', error: err.message });
            return reject(err);
          }

          if (calculatedSha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
            try { await fs.promises.unlink(tempFilePath); } catch (_) {}
            const err = new Error(`Downloaded SHA-256 mismatch: expected ${artifact.sha256}, calculated ${calculatedSha256}.`);
            this._updateState({ status: 'error', error: err.message });
            return reject(err);
          }

          // Verification succeeded: atomic move to final file
          try {
            if (fs.existsSync(finalFilePath)) {
              await fs.promises.unlink(finalFilePath);
            }
            await fs.promises.rename(tempFilePath, finalFilePath);
          } catch (renameErr) {
            this._updateState({ status: 'error', error: renameErr.message });
            return reject(renameErr);
          }

          this._updateState({
            status: 'downloaded',
            downloadedFile: finalFilePath,
            error: null
          });
          resolve(this.getStatus());
        });

        res.on('error', async (err) => {
          fileStream.destroy();
          try { await fs.promises.unlink(tempFilePath); } catch (_) {}
          this._updateState({ status: 'error', error: err.message });
          reject(err);
        });
      });

      req.on('error', async (err) => {
        try { await fs.promises.unlink(tempFilePath); } catch (_) {}
        this._updateState({ status: 'error', error: err.message });
        reject(err);
      });

      req.on('timeout', async () => {
        req.destroy();
        try { await fs.promises.unlink(tempFilePath); } catch (_) {}
        const err = new Error('Download connection timed out.');
        this._updateState({ status: 'error', error: err.message });
        reject(err);
      });
    });
  }

  installUpdate() {
    if (this.state.status !== 'downloaded' || !this.state.downloadedFile) {
      throw new Error('No downloaded update ready for installation.');
    }
    // Return verified file location for user or native installer runner.
    // Notice: Do NOT execute arbitrary unreviewed code without explicit user action.
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
