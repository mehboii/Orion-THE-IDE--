const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { requestFile, MAX_PACKAGE_BYTES } = require('../main/marketplace-http');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-download-test-'));
  const destination = path.join(root, 'package.vsix');
  const originalGet = https.get;
  let routes = {}, calls = [];
  https.get = (url, _options, callback) => {
    calls.push(url.href);
    const req = new EventEmitter();
    let response, destroyed = false;
    req.setTimeout = () => req;
    req.destroy = error => {
      if (destroyed) return;
      destroyed = true;
      if (error) req.emit('error', error);
      if (response) response.destroy(error);
    };
    setImmediate(() => {
      if (destroyed) return;
      const route = routes[url.pathname];
      if (route.stall) return;
      response = route.stream ? route.stream() : Readable.from(route.chunks || [Buffer.from('vsix')]);
      response.statusCode = route.status || 200;
      response.headers = route.headers || {};
      callback(response);
    });
    return req;
  };
  try {
    assert.equal(MAX_PACKAGE_BYTES, 1024 * 1024 * 1024);
    routes = { '/redirect': { status: 302, headers: { location: '/package' } }, '/package': {} };
    assert.equal(await requestFile('https://packages.test/redirect', destination), destination);
    assert.equal(await fs.readFile(destination, 'utf8'), 'vsix');
    assert.equal(calls.length, 2);
    await assert.rejects(requestFile('https://packages.test/package', destination), /EEXIST/);
    assert.equal(await fs.readFile(destination, 'utf8'), 'vsix', 'never delete an existing file');
    await fs.unlink(destination);

    // Exercise a real stream larger than the former 256 MiB limit without
    // allocating the entire payload in memory.
    const size = 257 * 1024 * 1024;
    routes['/large'] = {
      headers: { 'content-length': String(size) },
      stream: () => Readable.from((function* () {
        const chunk = Buffer.alloc(64 * 1024);
        for (let written = 0; written < size; written += chunk.length) yield chunk;
      })())
    };
    await requestFile('https://packages.test/large', destination);
    assert.equal((await fs.stat(destination)).size, size);
    await fs.unlink(destination);

    routes['/header-limit'] = { headers: { 'content-length': '5' } };
    await assert.rejects(requestFile('https://packages.test/header-limit', destination, { maxBytes: 4 }), /MiB limit/);
    routes['/stream-limit'] = { chunks: [Buffer.from('abc'), Buffer.from('def')] };
    await assert.rejects(requestFile('https://packages.test/stream-limit', destination, { maxBytes: 4 }), /MiB limit/);
    assert.deepEqual(await fs.readdir(root), [], 'oversized transfers leave no partial file');

    routes['/interrupted'] = { stream: () => Readable.from((async function* () {
      yield Buffer.from('partial');
      await new Promise(resolve => setImmediate(resolve));
      throw new Error('Download interrupted.');
    })()) };
    await assert.rejects(requestFile('https://packages.test/interrupted', destination), /interrupted/);
    assert.deepEqual(await fs.readdir(root), [], 'interrupted transfers leave no partial file');
    routes['/slow'] = { stream: () => new Readable({ read() { this.push(Buffer.from('partial')); this._read = () => {}; } }) };
    await assert.rejects(requestFile('https://packages.test/slow', destination, { timeout: 30 }), /timed out/);
    assert.deepEqual(await fs.readdir(root), [], 'timed out transfers close and remove partial files');
    routes['/stall'] = { stall: true };
    await assert.rejects(requestFile('https://packages.test/stall', destination, { timeout: 10 }), /timed out/);
    routes['/missing'] = { status: 404 };
    await assert.rejects(requestFile('https://packages.test/missing', destination), /HTTP 404/);
    routes['/loop'] = { status: 302, headers: { location: '/loop' } };
    await assert.rejects(requestFile('https://packages.test/loop', destination, { redirects: 1 }), /redirects/);
    routes['/insecure'] = { status: 302, headers: { location: 'http://packages.test/package' } };
    await assert.rejects(requestFile('https://packages.test/insecure', destination), /HTTPS/);
    await assert.rejects(requestFile('https://user:password@packages.test/package', destination), /HTTPS/);
    assert.deepEqual(await fs.readdir(root), []);
    console.log('PASS streamed downloads above 256 MiB, redirects, size limits, timeouts, interruption cleanup, and HTTPS enforcement');
  } finally {
    https.get = originalGet;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
