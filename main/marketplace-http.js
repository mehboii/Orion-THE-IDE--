const https = require('https');
const { createWriteStream } = require('fs');
const fs = require('fs/promises');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

function sizeError(maxBytes) {
  return new Error(`Marketplace download exceeds Orion's ${maxBytes / (1024 * 1024)} MiB limit.`);
}

// VSIX packages can contain large native binaries. Stream them to disk rather
// than retaining both the archive and a concatenated copy in main-process RAM.
async function requestFile(url, destination, { maxBytes = MAX_PACKAGE_BYTES, redirects = 5, timeout = 600000 } = {}) {
  let created = false;
  try {
    await new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Marketplace downloads require HTTPS.');
      } catch (error) { reject(error); return; }
      let timer, transferResponse;
      const req = https.get(parsed, { headers: { 'User-Agent': 'Orion-IDE', Accept: '*/*' } }, res => {
        res.on('error', error => {
          if (!transferResponse) { clearTimeout(timer); reject(error); }
        });
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          clearTimeout(timer);
          res.resume();
          if (!res.headers.location || redirects <= 0) return reject(new Error('Too many marketplace redirects.'));
          let target;
          try { target = new URL(res.headers.location, parsed).href; } catch (error) { reject(error); return; }
          requestFile(target, destination, { maxBytes, redirects: redirects - 1, timeout }).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          clearTimeout(timer); res.resume();
          reject(new Error(`Marketplace responded with HTTP ${res.statusCode}.`)); return;
        }
        if (Number(res.headers['content-length']) > maxBytes) {
          req.destroy(sizeError(maxBytes)); return;
        }
        let size = 0;
        const counter = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(size > maxBytes ? sizeError(maxBytes) : null, chunk);
        } });
        const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        transferResponse = res;
        output.on('open', () => { created = true; });
        pipeline(res, counter, output).then(() => {
          clearTimeout(timer); resolve();
        }, error => {
          clearTimeout(timer); req.destroy(); reject(error);
        });
      });
      timer = setTimeout(() => req.destroy(new Error('Marketplace request timed out.')), timeout);
      req.setTimeout(15000, () => req.destroy(new Error('Marketplace connection timed out.')));
      req.on('error', error => {
        clearTimeout(timer);
        // Let pipeline close the file before cleanup, including on Windows.
        if (transferResponse) transferResponse.destroy(error);
        else reject(error);
      });
    });
    return destination;
  } catch (error) {
    if (created) await fs.rm(destination, { force: true });
    throw error;
  }
}

// Registry metadata and package downloads share bounded requests with timeouts.
function requestBuffer(url, { maxBytes = 256 * 1024 * 1024, redirects = 5, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Marketplace downloads require HTTPS.');
    } catch (error) { reject(error); return; }
    let timer;
    const req = https.get(parsed, { headers: { 'User-Agent': 'Orion-IDE', Accept: '*/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        clearTimeout(timer);
        res.resume();
        if (!res.headers.location || redirects <= 0) return reject(new Error('Too many marketplace redirects.'));
        let target;
        try { target = new URL(res.headers.location, parsed).href; } catch (error) { reject(error); return; }
        requestBuffer(target, { maxBytes, redirects: redirects - 1, timeout }).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer); res.resume();
        return reject(new Error(`Marketplace responded with HTTP ${res.statusCode}.`));
      }
      if (Number(res.headers['content-length']) > maxBytes) {
        req.destroy(sizeError(maxBytes)); return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(sizeError(maxBytes));
        else chunks.push(chunk);
      });
      res.on('error', error => { clearTimeout(timer); reject(error); });
      res.on('aborted', () => { clearTimeout(timer); reject(new Error('Marketplace download was interrupted.')); });
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    });
    timer = setTimeout(() => req.destroy(new Error('Marketplace request timed out.')), timeout);
    req.setTimeout(15000, () => req.destroy(new Error('Marketplace connection timed out.')));
    req.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function requestJson(url) {
  const bytes = await requestBuffer(url, { maxBytes: 8 * 1024 * 1024, timeout: 20000 });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (_) { throw new Error('Marketplace returned invalid JSON.'); }
}

module.exports = { requestBuffer, requestJson, requestFile, MAX_PACKAGE_BYTES };
