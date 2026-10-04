// Real main Orion Electron app; a stalled loopback fixture proves startup independence.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const crypto = require('node:crypto');
const { artifactPayload, manifestPayload, computeKeyId } = require('../main/update-service');
async function waitForState(page, predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await page.evaluate(predicate)) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Timed out waiting for Orion update state.');
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-update-startup-'));
  const requests = [];
  let response, app;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const server = http.createServer((req, res) => { requests.push(req.url); response = res; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const launch = () => _electron.launch({ args: [path.resolve(__dirname, '..')], env: { ...process.env,
      IDE_TEST_MODE: '1', IDE_TEST_USER_DATA: profile, N11X_UPDATE_URL: baseUrl,
      N11X_UPDATE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) } });
    app = await launch();
    let page = await app.firstWindow();
    await page.waitForSelector('.terminal-pane');
    assert.equal(await page.locator('.terminal-pane').count(), 4);
    await waitForState(page, () => window.appInstance.updateState?.status === 'checking');
    assert.equal(await page.locator('.terminal-pane').count(), 4, 'UI remains usable while backend never replies');
    assert(await page.locator('#modal-update').evaluate(el => el.classList.contains('hidden')), 'startup stays silent');
    assert.equal(requests.length, 1);
    const query = new URL(requests[0], baseUrl);
    assert.equal(query.pathname, '/v1/orion/latest');
    assert.equal(query.searchParams.get('currentVersion'), require('../package.json').version);
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"error":"internal_error"}');
    await waitForState(page, () => window.appInstance.updateState?.status === 'error');
    assert.equal(await page.locator('#settings-update-state').textContent(), 'Unable to check for updates');
    assert.equal(await page.locator('.terminal-pane').count(), 4);
    await app.close(); app = null;
    app = await launch(); page = await app.firstWindow();
    await page.waitForSelector('.terminal-pane');
    await page.waitForTimeout(3500);
    assert.equal(requests.length, 1, 'restart respects persisted startup interval even after failure');
    await page.locator('[data-activity="settings"]').click();
    await page.locator('#btn-check-updates').click();
    await waitForState(page, () => window.appInstance.updateState?.status === 'checking');
    assert.equal(requests.length, 2, 'manual Settings action bypasses startup interval');
    response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"release_not_found"}');
    await waitForState(page, () => window.appInstance.updateState?.status === 'no-release');
    assert.equal(await page.locator('#update-modal-title').textContent(), 'No Update Published');
    // A disposable signed fixture checks the complete application's positive path.
    // The live test remains separate and never treats this as real-backend success.
    await page.locator('#modal-update-close').click();
    await page.locator('#btn-check-updates').click();
    await waitForState(page, () => window.appInstance.updateState?.status === 'checking');
    const runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));
    const version = `${Number(runtime.version.split('.')[0]) + 1}.0.0`;
    const artifact = { platform: { win32: 'windows', linux: 'linux', darwin: 'macos' }[runtime.platform],
      architecture: runtime.arch, filename: 'Orion-test.bin', size: 1, sha256: crypto.createHash('sha256').update('x').digest('hex') };
    const manifest = { schemaVersion: 1, product: 'orion', version, channel: 'stable',
      releaseDate: '2026-10-04T12:00:00.000Z', mandatory: false, minimumSupportedVersion: null,
      releaseNotes: ['Disposable integration fixture'], keyId: computeKeyId(publicKey), artifacts: [artifact] };
    artifact.signature = crypto.sign(null, artifactPayload(manifest, artifact), privateKey).toString('base64');
    manifest.signature = crypto.sign(null, manifestPayload(manifest), privateKey).toString('base64');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ product: 'orion', channel: 'stable', currentVersion: runtime.version, latestVersion: version,
      updateAvailable: true, mandatory: false, manifest, artifact: { ...artifact, keyId: manifest.keyId,
        signatureAlgorithm: 'Ed25519', signatureFormat: 'N11X-ARTIFACT-v1',
        url: `/v1/orion/download/${version}/${artifact.platform}/${artifact.architecture}?channel=stable` } }));
    await waitForState(page, () => window.appInstance.updateState?.status === 'available');
    assert.match(await page.locator('#update-info-container').textContent(), new RegExp(runtime.version));
    assert.match(await page.locator('#update-info-container').textContent(), new RegExp(version));
    assert.equal(await page.locator('#btn-update-action').textContent(), 'Download Update');
    assert.equal(await page.locator('.terminal-pane').count(), 4);
    console.log('PASS actual Orion with disposable fixtures: non-blocking startup, HTTP failure, UI liveness, persisted interval, manual Settings IPC, no-release UI, valid manifest verification and update-available UI');
  } finally {
    if (app) await app.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
