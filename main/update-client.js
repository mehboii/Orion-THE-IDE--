const http = require('http');
const https = require('https');
const { validateBaseUrl } = require('./update-config');

// N11X docs/api.md: bounded read-only HTTP; no credentials, telemetry or redirects.
class UpdateClient {
  constructor(baseUrl, { timeout = 15000, maxBytes = 256 * 1024 } = {}) {
    this.baseUrl = validateBaseUrl(baseUrl);
    this.timeout = timeout;
    this.maxBytes = maxBytes;
  }

  releaseUrl(product, version, channel) {
    return `${this.baseUrl}/v1/${product}/releases/${encodeURIComponent(version)}?${new URLSearchParams({ channel })}`;
  }

  downloadUrl(product, version, channel, platform, architecture) {
    return `${this.baseUrl}/v1/${product}/download/${encodeURIComponent(version)}/${platform}/${architecture}?${new URLSearchParams({ channel })}`;
  }

  latest(product, target) {
    return this.get(`${this.baseUrl}/v1/${product}/latest?${new URLSearchParams(target)}`);
  }

  get(value) {
    return new Promise((resolve, reject) => {
      const url = new URL(value, this.baseUrl);
      if (url.origin !== this.baseUrl) return reject(new Error('Update URL origin mismatch.'));
      let timer;
      const req = (url.protocol === 'https:' ? https : http).get(url, { headers: { Accept: 'application/json' } }, res => {
        let size = 0;
        const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > this.maxBytes) {
            clearTimeout(timer);
            reject(new Error('Update response exceeds size limit.'));
            res.destroy();
            req.destroy();
          }
          else chunks.push(chunk);
        });
        res.on('error', error => { clearTimeout(timer); reject(error); });
        res.on('aborted', () => { clearTimeout(timer); reject(new Error('Update response interrupted.')); });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            // Opt-in integration evidence: public update identity only, no headers/secrets.
            if (process.env.IDE_TEST_MODE === '1' && process.env.IDE_UPDATE_TRACE === '1') {
              console.log('[UPDATE_TRACE] ' + JSON.stringify({ url: url.href, statusCode: res.statusCode,
                body: { error: body?.error, product: body?.product, channel: body?.channel,
                  currentVersion: body?.currentVersion, latestVersion: body?.latestVersion,
                  updateAvailable: body?.updateAvailable, manifestVersion: body?.manifest?.version } }));
            }
            resolve({ statusCode: res.statusCode, body });
          } catch (_) { reject(new Error('Update service returned invalid JSON.')); }
        });
      });
      timer = setTimeout(() => req.destroy(new Error('Update request timed out.')), this.timeout);
      req.on('error', error => { clearTimeout(timer); reject(error); });
    });
  }
}

module.exports = { UpdateClient };
