const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  UpdateService,
  compareVersions,
  parseSemVer,
  computeKeyId,
  artifactPayload,
  manifestPayload
} = require('../main/update-service');

test('SemVer parsing and comparison', () => {
  assert.equal(compareVersions('13.1.0', '13.0.1'), 1);
  assert.equal(compareVersions('13.0.1', '13.1.0'), -1);
  assert.equal(compareVersions('13.0.1', '13.0.1'), 0);
  assert.equal(compareVersions('14.0.0', '13.9.9'), 1);
  assert.equal(compareVersions('13.1.0-beta.2', '13.1.0-beta.1'), 1);
  assert.equal(compareVersions('13.1.0', '13.1.0-beta.1'), 1);
  assert.equal(compareVersions('13.1.0-alpha', '13.1.0-beta'), -1);

  assert.throws(() => parseSemVer('invalid-version'), /Invalid SemVer format/);
});

test('Ed25519 keyId derivation matches SPKI SHA-256', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = computeKeyId(publicKey);
  assert.match(keyId, /^[0-9a-f]{64}$/);

  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const expectedHash = crypto.createHash('sha256').update(spkiDer).digest('hex');
  assert.equal(keyId, expectedHash);
});

test('Exact canonical payload serialization matches N11X protocol bytes', () => {
  const manifest = {
    schemaVersion: 1,
    product: 'orion',
    version: '13.1.0',
    channel: 'stable',
    releaseDate: '2026-10-04T12:00:00.000Z',
    mandatory: false,
    minimumSupportedVersion: null,
    releaseNotes: ['Fix bug', 'Improve performance'],
    keyId: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    artifacts: [
      {
        platform: 'windows',
        architecture: 'x64',
        filename: 'Orion-13.1.0-Setup.exe',
        size: 1048576,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        signature: 'c2lnbmF0dXJlMQ=='
      }
    ],
    signature: 'c2lnbmF0dXJlMg=='
  };

  const a = manifest.artifacts[0];
  const aBuf = artifactPayload(manifest, a);
  const expectedArtifact = JSON.stringify([
    'N11X-ARTIFACT-v1',
    'orion',
    '13.1.0',
    'stable',
    'windows',
    'x64',
    'Orion-13.1.0-Setup.exe',
    1048576,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ]);
  assert.equal(aBuf.toString('utf8'), expectedArtifact);

  const mBuf = manifestPayload(manifest);
  const expectedManifest = JSON.stringify([
    'N11X-MANIFEST-v1',
    1,
    'orion',
    '13.1.0',
    'stable',
    '2026-10-04T12:00:00.000Z',
    false,
    null,
    ['Fix bug', 'Improve performance'],
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    [
      [
        'windows',
        'x64',
        'Orion-13.1.0-Setup.exe',
        1048576,
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'c2lnbmF0dXJlMQ=='
      ]
    ]
  ]);
  assert.equal(mBuf.toString('utf8'), expectedManifest);
});

// Unit fixtures follow the inspected N11X schema and exact signing bytes.
// They do not substitute for the separate real-backend Electron verification.
const { UpdateClient } = require('../main/update-client');
const { validateBaseUrl, PRODUCTION_UPDATE_BASE_URL } = require('../main/update-config');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
const artifactBytes = Buffer.from('DISPOSABLE_TEST_ARTIFACT');
function signedManifest(version = '13.1.0') {
  return sign({ schemaVersion: 1, product: 'orion', version, channel: 'stable',
    releaseDate: '2026-10-04T12:00:00.000Z', mandatory: false, minimumSupportedVersion: null,
    releaseNotes: ['Test release'], keyId: computeKeyId(publicKey), artifacts: [{
      platform: 'windows', architecture: 'x64', filename: 'Orion-test.exe', size: artifactBytes.length,
      sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex') }] });
}
function sign(m) {
  for (const a of m.artifacts) a.signature = crypto.sign(null, artifactPayload(m, a), privateKey).toString('base64');
  m.signature = crypto.sign(null, manifestPayload(m), privateKey).toString('base64');
  return m;
}
async function fixture(t, { manifest = signedManifest(), mutate = () => {}, status = 200, raw, hang = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (hang) return;
    if (url.pathname.includes('/download/')) {
      res.writeHead(200); res.end(artifactBytes); return;
    }
    const current = url.searchParams.get('currentVersion');
    let body = manifest;
    if (url.pathname.endsWith('/latest')) {
      const newer = compareVersions(manifest.version, current) > 0;
      body = { product: 'orion', channel: 'stable', currentVersion: current, latestVersion: manifest.version,
        updateAvailable: newer, mandatory: newer && (manifest.mandatory || (manifest.minimumSupportedVersion !== null &&
          compareVersions(current, manifest.minimumSupportedVersion) < 0)) };
      if (newer) Object.assign(body, { manifest, artifact: { ...manifest.artifacts[0],
        url: `/v1/orion/download/${manifest.version}/windows/x64?channel=stable`, keyId: manifest.keyId,
        signatureAlgorithm: 'Ed25519', signatureFormat: 'N11X-ARTIFACT-v1' },
        manifestUrl: `/v1/orion/releases/${manifest.version}?channel=stable` });
      mutate(body);
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(raw === undefined ? JSON.stringify(body) : raw);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const make = options => new UpdateService({ currentVersion: '13.0.1', platform: 'windows', architecture: 'x64',
    serverUrl: baseUrl, pinnedKeys: [pubPem], ...options });
  return { requests, server, make, baseUrl };
}

for (const [version, expected] of [['13.0.1', 'not-available'], ['13.1.0', 'available'], ['12.9.0', 'not-available']]) {
  test(`signed ${version}: ${expected}, never downgrade`, async t => {
    const { make, requests } = await fixture(t, { manifest: signedManifest(version) });
    const result = await make().checkForUpdates();
    assert.equal(result.status, expected);
    assert.equal(result.updateAvailable, expected === 'available');
    assert.equal(result.latestVersion, version);
    assert.equal(requests[0], '/v1/orion/latest?channel=stable&platform=windows&architecture=x64&currentVersion=13.0.1');
    if (expected === 'not-available') assert.equal(requests[1], `/v1/orion/releases/${version}?channel=stable`);
  });
}

const mutations = [
  ['wrong product', b => { b.product = 'calliope'; }],
  ['wrong channel', b => { b.channel = 'beta'; }],
  ['wrong current version', b => { b.currentVersion = '1.0.0'; }],
  ['malformed version', b => { b.latestVersion = 'broken'; }],
  ['missing response fields', b => { delete b.updateAvailable; }],
  ['false update availability', b => { b.updateAvailable = false; }],
  ['wrong platform', b => { b.artifact.platform = 'macos'; }],
  ['wrong architecture', b => { b.artifact.architecture = 'arm64'; }],
  ['wrong manifest product', b => { b.manifest.product = 'calliope'; }],
  ['invalid signature', b => { b.manifest.releaseNotes = ['Tampered']; }],
  ['missing signature', b => { delete b.manifest.signature; }],
  ['external download URL', b => { b.artifact.url = 'https://example.com/untrusted.exe'; }],
  ['wrong download route', b => { b.artifact.url = '/v1/orion/download/13.1.0/macos/arm64?channel=stable'; }],
  ['unsafe filename', b => { b.manifest.artifacts[0].filename = '../Orion.exe'; }],
  ['invalid size', b => { b.manifest.artifacts[0].size = -1; }],
  ['invalid SHA-256', b => { b.manifest.artifacts[0].sha256 = 'invalid'; }],
  ['invalid mandatory policy', b => { b.mandatory = true; }]
];
for (const [name, mutate] of mutations) test(`${name} rejected safely`, async t => {
  const { make } = await fixture(t, { mutate });
  const updater = make();
  const result = await updater.checkForUpdates();
  assert.equal(result.status, 'error');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.artifact, null);
  await assert.rejects(updater.downloadUpdate(), /no verified update/);
});

test('invalid artifact signature with valid manifest signature rejected', async t => {
  const m = signedManifest();
  m.artifacts[0].signature = Buffer.alloc(64).toString('base64');
  m.signature = crypto.sign(null, manifestPayload(m), privateKey).toString('base64');
  const { make } = await fixture(t, { manifest: m });
  assert.match((await make().checkForUpdates()).error, /artifact Ed25519 signature/);
});

test('validly signed manifest for another target rejected', async t => {
  const m = signedManifest(); m.artifacts[0].platform = 'macos'; sign(m);
  const { make } = await fixture(t, { manifest: m });
  assert.match((await make().checkForUpdates()).error, /requested platform and architecture/);
});

test('unpinned key rejected', async t => {
  const { make } = await fixture(t);
  assert.match((await make({ pinnedKeys: [] }).checkForUpdates()).error, /Untrusted signing key/);
});

test('invalid JSON, HTTP 500 and unknown 404 are failures', async t => {
  for (const options of [{ raw: '{' }, { raw: '{}', status: 500 }, { raw: '{"error":"product_not_found"}', status: 404 }]) {
    const { make } = await fixture(t, options);
    assert.equal((await make().checkForUpdates()).status, 'error');
  }
});

test('real API release_not_found is distinct from up to date', async t => {
  const { make } = await fixture(t, { status: 404, raw: '{"error":"release_not_found"}' });
  assert.equal((await make().checkForUpdates()).status, 'no-release');
});

test('backend unavailable returns error without rejection or crash', async t => {
  const { make, server } = await fixture(t);
  await new Promise(resolve => server.close(resolve));
  assert.equal((await make().checkForUpdates()).status, 'error');
});

test('absolute timeout and bounded response fail gracefully', async t => {
  const { make } = await fixture(t, { hang: true });
  assert.match((await make({ clientOptions: { timeout: 30 } }).checkForUpdates()).error, /timed out/);
  const next = await fixture(t);
  assert.match((await next.make({ clientOptions: { maxBytes: 20 } }).checkForUpdates()).error, /size limit/);
});

test('startup frequency persists attempts; manual checks bypass interval; checks deduplicate', async t => {
  const { make, requests } = await fixture(t);
  const data = { channel: 'stable', lastCheckAt: 0 };
  const preferences = { get: (k, fallback) => data[k] ?? fallback, set: (k, v) => { data[k] = v; } };
  const updater = make({ preferences, now: () => 100000 });
  const first = updater.checkAtStartup();
  assert.equal(updater.getStatus().status, 'checking');
  assert.equal(updater.checkForUpdates(), first);
  await first;
  await updater.checkAtStartup();
  assert.equal(requests.length, 1);
  await updater.checkForUpdates();
  assert.equal(requests.length, 2);
  await make({ preferences, now: () => 100001 }).checkAtStartup();
  assert.equal(requests.length, 2);
  await make({ preferences, now: () => 100000 + 86400001 }).checkAtStartup();
  assert.equal(requests.length, 3);
});

test('failure clears previous verified offer and notification failures cannot crash check', async t => {
  let fail = false;
  const { make } = await fixture(t, { mutate: b => { if (fail) b.product = 'wrong'; } });
  const updater = make({ onStatusChanged: () => { throw new Error('Listener failed'); } });
  assert.equal((await updater.checkForUpdates()).status, 'available');
  fail = true;
  assert.equal((await updater.checkForUpdates()).status, 'error');
  assert.equal(updater.getStatus().updateAvailable, false);
  assert.equal(updater.getStatus().artifact, null);
});

test('download streams and verifies actual bytes; no automatic installation', async t => {
  const { make } = await fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-update-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const updater = make({ downloadDirectory: dir });
  assert.equal((await updater.checkForUpdates()).status, 'available');
  assert.equal((await updater.downloadUpdate()).status, 'downloaded');
  assert.deepEqual(fs.readFileSync(updater.getStatus().downloadedFile), artifactBytes);
});

test('production configuration rejects insecure origins and ignores development trust overrides', () => {
  assert.equal(validateBaseUrl(PRODUCTION_UPDATE_BASE_URL), 'https://updates.n11x.dev');
  for (const url of ['http://192.168.1.39:8091', 'file:///tmp/file', 'https://user:secret@example.com', 'https://example.com/path']) {
    assert.throws(() => validateBaseUrl(url));
  }
  const vm = require('vm');
  const source = fs.readFileSync(path.join(__dirname, '../main/update-service.js'), 'utf8');
  const exports = { exports: {} };
  const context = { require: name => name === 'electron' ? { app: { isPackaged: true, getVersion: () => require('../package.json').version,
    getPath: () => os.tmpdir() } } : require(require.resolve(name, { paths: [path.join(__dirname, '../main')] })),
    module: exports, __dirname: path.join(__dirname, '../main'), Buffer, URL, URLSearchParams, console,
    process: { ...process, env: { N11X_UPDATE_PUBLIC_KEY: pubPem } } };
  vm.runInNewContext(source, context);
  const packaged = new exports.exports.UpdateService();
  assert.equal(packaged.pinnedKeys.size, 0);
  const production = new UpdateService({ serverUrl: PRODUCTION_UPDATE_BASE_URL });
  assert.equal(production.pinnedKeys.size, 0);
  assert(!fs.readFileSync(path.join(__dirname, '../config/update-keys.json'), 'utf8').includes('BEGIN PRIVATE KEY'));
});

test('unsupported Orion build target rejected without requesting backend', async t => {
  const { make, requests } = await fixture(t);
  assert.equal((await make({ platform: 'windows', architecture: 'arm64' }).checkForUpdates()).status, 'error');
  assert.equal((await make({ platform: 'unsupported' }).checkForUpdates()).status, 'error');
  assert.equal(requests.length, 0);
});
