/* Regression coverage for Explorer updates during file, Git, and PTY activity. */
const assert = require('assert');
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(page, predicate, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await page.evaluate(predicate)) return;
    await sleep(100);
  }
  throw new Error(message);
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-explorer-stability-'));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  for (let index = 0; index < 40; index += 1) fs.writeFileSync(path.join(root, `filler-${index}.txt`), `${index}\n`);
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@orion.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Orion Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

  const app = await electron.launch({ args: [appRoot], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.terminal-pane');
    await page.evaluate((dir) => window.electronAPI.setTestDirectoryPath(dir), root);
    await page.evaluate(() => window.appInstance.fileExplorer.handleOpenFolderClick());
    await page.getByText('tracked.txt', { exact: true }).waitFor();

    await page.evaluate(() => {
      const explorer = window.appInstance.fileExplorer;
      explorer.renderCalls = 0;
      const render = explorer.render.bind(explorer);
      explorer.render = async (...args) => { explorer.renderCalls += 1; return render(...args); };
      explorer.selectedFilePath = [...document.querySelectorAll('[data-explorer-path]')]
        .find((item) => item.dataset.explorerPath.endsWith('tracked.txt')).dataset.explorerPath;
      document.querySelector('[data-explorer-path$="tracked.txt"]').classList.add('selected');
      document.querySelector('[data-explorer-path$="filler-0.txt"]').__explorerStabilityToken = 'unrelated-file';
      document.querySelector('#sidebar-file-tree').scrollTop = 120;
    });

    // A normal file edit changes Git decoration but must not reconstruct the tree.
    fs.appendFileSync(path.join(root, 'tracked.txt'), 'two\n');
    await waitFor(page, () => document.querySelector('[data-explorer-path$="tracked.txt"] .git-status-badge')?.textContent === 'M', 'Git modification badge did not update');
    const afterEdit = await page.evaluate(() => ({
      renders: window.appInstance.fileExplorer.renderCalls,
      selected: document.querySelector('[data-explorer-path$="tracked.txt"]')?.classList.contains('selected'),
      scrollTop: document.querySelector('#sidebar-file-tree').scrollTop
    }));
    assert.equal(afterEdit.renders, 0, 'file content edit rebuilt Explorer');
    assert(afterEdit.selected, 'file selection was lost after Git decoration update');
    assert(afterEdit.scrollTop >= 100, 'Explorer scroll position was lost after Git decoration update');

    // Git index updates must change decorations without a file-tree rebuild.
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    await waitFor(page, () => document.querySelector('[data-explorer-path$="tracked.txt"] .git-status-badge')?.textContent === 'A' || document.querySelector('[data-explorer-path$="tracked.txt"] .git-status-badge')?.textContent === 'M', 'Git index update did not reach Explorer');
    assert.equal(await page.evaluate(() => window.appInstance.fileExplorer.renderCalls), 0, 'Git operation rebuilt Explorer');

    // PTY data must be isolated from Explorer and the keyed sessions list keeps its row.
    const beforeTerminal = await page.evaluate(() => {
      const row = document.querySelector('#sidebar-sessions-list [data-pane-id]');
      row.__explorerStabilityToken = 'stable';
      return window.appInstance.fileExplorer.renderCalls;
    });
    await page.evaluate(() => window.electronAPI.writePty('pane-1', 'echo explorer-stability\r'));
    await sleep(400);
    const afterTerminal = await page.evaluate(() => ({
      renders: window.appInstance.fileExplorer.renderCalls,
      sameRow: document.querySelector('#sidebar-sessions-list [data-pane-id]')?.__explorerStabilityToken === 'stable'
    }));
    assert.equal(afterTerminal.renders, beforeTerminal, 'terminal output rebuilt Explorer');
    assert(afterTerminal.sameRow, 'terminal activity replaced the Terminal Sessions row');

    // A real directory entry still refreshes the tree and retains selection.
    fs.writeFileSync(path.join(root, 'created.txt'), 'created\n');
    await page.getByText('created.txt', { exact: true }).waitFor();
    assert(await page.evaluate(() => document.querySelector('[data-explorer-path$="tracked.txt"]')?.classList.contains('selected')), 'selection was lost after structural refresh');
    assert(await page.evaluate(() => document.querySelector('[data-explorer-path$="filler-0.txt"]')?.__explorerStabilityToken === 'unrelated-file'), 'unrelated file-tree nodes were replaced by a structural update');
    console.log('explorer-stability: passed');
  } finally {
    try { await app.close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
