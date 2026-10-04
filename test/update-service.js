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

test('UpdateService cryptographic verification with disposable in-memory Ed25519 key', async () => {
  // Generate a disposable test keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = computeKeyId(publicKey);

  const artifactBytes = Buffer.from('DISPOSABLE_TEST_ORION_INSTALLER_BINARY_DATA');
  const artifactSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');

  const manifest = {
    schemaVersion: 1,
    product: 'orion',
    version: '13.1.0',
    channel: 'stable',
    releaseDate: '2026-10-04T12:00:00.000Z',
    mandatory: false,
    minimumSupportedVersion: null,
    releaseNotes: ['Initial release for test'],
    keyId,
    artifacts: [
      {
        platform: 'windows',
        architecture: 'x64',
        filename: 'Orion-13.1.0-Setup.exe',
        size: artifactBytes.length,
        sha256: artifactSha256
      }
    ]
  };

  // Sign artifact and manifest using test key
  const a = manifest.artifacts[0];
  a.signature = crypto.sign(null, artifactPayload(manifest, a), privateKey).toString('base64');
  manifest.signature = crypto.sign(null, manifestPayload(manifest), privateKey).toString('base64');

  // Start mock N11X Update Server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/v1/orion/latest') {
      const q = Object.fromEntries(url.searchParams);
      const updateAvailable = compareVersions(manifest.version, q.currentVersion) > 0;

      if (!updateAvailable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          product: 'orion',
          channel: 'stable',
          currentVersion: q.currentVersion,
          latestVersion: manifest.version,
          updateAvailable: false,
          mandatory: false
        }));
      }

      const body = {
        product: 'orion',
        channel: 'stable',
        currentVersion: q.currentVersion,
        latestVersion: manifest.version,
        updateAvailable: true,
        mandatory: false,
        releaseDate: manifest.releaseDate,
        releaseNotes: manifest.releaseNotes,
        minimumSupportedVersion: manifest.minimumSupportedVersion,
        artifact: {
          ...a,
          url: `http://127.0.0.1:${server.address().port}/v1/orion/download/13.1.0/windows/x64?channel=stable`,
          keyId: manifest.keyId,
          signatureAlgorithm: 'Ed25519',
          signatureFormat: 'N11X-ARTIFACT-v1'
        },
        manifest,
        manifestUrl: `http://127.0.0.1:${server.address().port}/v1/orion/releases/13.1.0?channel=stable`
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(body));
    }

    if (url.pathname === '/v1/orion/download/13.1.0/windows/x64') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.microsoft.portable-executable',
        'Content-Length': artifactBytes.length,
        'ETag': `"${artifactSha256}"`,
        'X-Checksum-SHA256': artifactSha256
      });
      return res.end(artifactBytes);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-update-test-'));

  try {
    const updater = new UpdateService({
      product: 'orion',
      currentVersion: '13.0.1',
      channel: 'stable',
      platform: 'windows',
      architecture: 'x64',
      serverUrl: `http://127.0.0.1:${port}`,
      downloadDirectory: tmpDir,
      pinnedKeys: [pubPem]
    });

    // 1. Check for updates succeeds and verifies Ed25519 signatures
    const status = await updater.checkForUpdates();
    assert.equal(status.status, 'available');
    assert.equal(status.updateAvailable, true);
    assert.equal(status.latestVersion, '13.1.0');
    assert.equal(status.artifact.filename, 'Orion-13.1.0-Setup.exe');

    // 2. Download and verify hash and size
    let progressReported = false;
    updater.onDownloadProgress = (p) => {
      progressReported = true;
      assert(p.percent >= 0 && p.percent <= 100);
    };

    const downloadResult = await updater.downloadUpdate();
    assert.equal(downloadResult.status, 'downloaded');
    assert(progressReported);
    assert(fs.existsSync(downloadResult.downloadedFile));

    const downloadedContent = fs.readFileSync(downloadResult.downloadedFile);
    assert.equal(downloadedContent.toString(), artifactBytes.toString());

    // 3. Reject non-advancing version (no-downgrade check)
    const updaterUpToDate = new UpdateService({
      product: 'orion',
      currentVersion: '13.1.0',
      channel: 'stable',
      platform: 'windows',
      architecture: 'x64',
      serverUrl: `http://127.0.0.1:${port}`,
      downloadDirectory: tmpDir,
      pinnedKeys: [pubPem]
    });
    const statusUpToDate = await updaterUpToDate.checkForUpdates();
    assert.equal(statusUpToDate.status, 'not-available');
    assert.equal(statusUpToDate.updateAvailable, false);

    // 4. Reject unpinned/untrusted key
    const { publicKey: otherPublic } = crypto.generateKeyPairSync('ed25519');
    const updaterUntrusted = new UpdateService({
      product: 'orion',
      currentVersion: '13.0.1',
      channel: 'stable',
      platform: 'windows',
      architecture: 'x64',
      serverUrl: `http://127.0.0.1:${port}`,
      downloadDirectory: tmpDir,
      pinnedKeys: [otherPublic.export({ type: 'spki', format: 'pem' })] // Different key!
    });
    await assert.rejects(
      () => updaterUntrusted.checkForUpdates(),
      /Untrusted signing key ID/
    );
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
