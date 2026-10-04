// No mock or replacement backend. Observe actual main-process HTTP traffic and UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { UPDATE_BASE_URL } = require('../main/update-config');
async function waitForState(page, predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await page.evaluate(predicate)) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Timed out waiting for the real backend update check.');
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-update-live-'));
  let app;
  const traffic = [];
  try {
    app = await _electron.launch({ executablePath: process.env.ORION_TEST_EXECUTABLE || undefined,
      args: process.env.ORION_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '..')], env: { ...process.env,
      IDE_TEST_MODE: '1', IDE_TEST_USER_DATA: profile, IDE_UPDATE_TRACE: '1', N11X_UPDATE_URL: UPDATE_BASE_URL } });
    let output = '';
    app.process().stdout.on('data', chunk => {
      output += chunk.toString();
      const lines = output.split(/\r?\n/); output = lines.pop();
      for (const line of lines) if (line.startsWith('[UPDATE_TRACE] ')) traffic.push(JSON.parse(line.slice(15)));
    });
    const page = await app.firstWindow();
    await page.waitForSelector('.terminal-pane');
    await waitForState(page, () => ['available', 'not-available', 'no-release', 'error'].includes(window.appInstance.updateState?.status));
    const startupState = await page.evaluate(() => window.appInstance.updateState);
    await page.locator('[data-activity="settings"]').click();
    await page.locator('#btn-check-updates').click();
    await waitForState(page, () => window.appInstance.updateState?.status !== 'checking');
    const evidence = {
      runtime: await app.evaluate(({ app }) => ({ version: app.getVersion(), platform: process.platform, architecture: process.arch, packaged: app.isPackaged })),
      traffic, startupStatus: startupState.status,
      state: await page.evaluate(() => window.appInstance.updateState),
      modalTitle: await page.locator('#update-modal-title').textContent(),
      settingsState: await page.locator('#settings-update-state').textContent(),
      terminalPanes: await page.locator('.terminal-pane').count()
    };
    const evidenceDir = path.resolve(__dirname, '../dist/update-verification');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const label = evidence.runtime.packaged ? 'packaged' : 'source';
    fs.writeFileSync(path.join(evidenceDir, `orion-live-${label}.json`), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: path.join(evidenceDir, `orion-live-${label}.png`) });
    console.log(JSON.stringify(evidence, null, 2));
    assert.equal(evidence.terminalPanes, 4);
    assert(evidence.traffic.length >= 2, 'both real startup and manual requests were observed');
    for (const item of evidence.traffic.filter(item => item.url.includes('/latest?'))) {
      const url = new URL(item.url);
      assert.equal(url.origin, UPDATE_BASE_URL);
      assert.equal(url.pathname, '/v1/orion/latest');
      assert.equal(url.searchParams.get('currentVersion'), evidence.runtime.version);
      assert.equal(url.searchParams.get('channel'), 'stable');
      assert.equal(url.searchParams.get('platform'), { win32: 'windows', darwin: 'macos', linux: 'linux' }[evidence.runtime.platform]);
      assert.equal(url.searchParams.get('architecture'), evidence.runtime.architecture);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['architecture', 'channel', 'currentVersion', 'platform']);
    }
    if (evidence.state.status === 'no-release') {
      assert.equal(evidence.modalTitle, 'No Update Published');
      console.log('REAL BACKEND COMMUNICATION PASSED; SIGNED RELEASE E2E BLOCKED: backend catalog has no matching release.');
      process.exitCode = 2;
    } else {
      assert(['available', 'not-available'].includes(evidence.state.status), 'real signed manifest was not successfully verified');
      assert(evidence.state.manifest, 'signed manifest required for full E2E success');
      console.log('PASS real Orion/backend manifest verification, version comparison, and UI state');
    }
  } finally {
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
