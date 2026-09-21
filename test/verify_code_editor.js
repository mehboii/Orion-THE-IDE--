/* Integration coverage for the detached Monaco editor and project-root contract. */
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, 'test', 'temp-editor-nested');
const testFile = path.join(fixtureDir, 'temp_demo_file.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWindow(app, marker) {
  for (let i = 0; i < 80; i += 1) {
    const page = app.windows().find((candidate) => candidate.url().includes(marker));
    if (page) return page;
    await sleep(100);
  }
  throw new Error(`Window not found: ${marker}`);
}

(async () => {
  console.log('=== STARTING CODE EDITOR & FILE EXPLORER VERIFICATION ===');
  const initialContent = '// Initial Demo File\nconst answer = 42;\n';
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(testFile, initialContent, 'utf8');

  let app;
  try {
    app = await electron.launch({ args: [root], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const main = await waitForWindow(app, 'index.html');
    await main.waitForSelector('.terminal-pane');
    await main.evaluate((folder) => window.appInstance.fileExplorer.setRootDirectory(folder, true), root);
    await main.getByTitle(path.join(root, 'package.json'), { exact: true }).waitFor();
    const blockedWrite = await main.evaluate((target) => window.electronAPI.writeFile(target, 'blocked'), path.join(os.tmpdir(), `ide-blocked-${process.pid}.txt`));
    assert.strictEqual(blockedWrite.success, false, 'renderer filesystem IPC wrote outside the opened project');
    const escaped = await main.evaluate(() => window.appInstance.fileExplorer.escapeHtml('<img src=x onerror=alert(1)>'));
    assert(!escaped.includes('<img'), 'file explorer did not escape markup in a filename');
    console.log('PASS File Explorer rendered the selected project root.');

    await main.evaluate((filePath) => window.electronAPI.openEditorFile(filePath), testFile);
    const editor = await waitForWindow(app, 'editor.html');
    await editor.waitForSelector('.monaco-editor');
    await editor.waitForFunction((filePath) => Boolean(window.editorApp?.manager?.openTabs?.get(filePath)?.model), testFile);
    const opened = await editor.evaluate((filePath) => ({
      value: window.editorApp.manager.openTabs.get(filePath).model.getValue(),
      root: window.editorApp.rootDirectory
    }), testFile);
    assert.strictEqual(opened.value, initialContent);
    assert.strictEqual(opened.root, root, 'opening a nested file must not change the project root');
    assert.strictEqual(await main.evaluate(() => window.electronAPI.getProjectRoot()), root);
    console.log('PASS Nested file opened in Monaco without changing the project root.');

    const editedContent = `${initialContent}console.log(answer);\n`;
    await editor.locator('.mode-toggle-pill').click();
    await editor.evaluate((value) => window.editorApp.manager.editor.setValue(value), editedContent);
    assert.strictEqual(await editor.evaluate((filePath) => window.editorApp.manager.openTabs.get(filePath).dirty, testFile), true);
    await editor.evaluate(() => window.editorApp.save());
    assert.strictEqual(fs.readFileSync(testFile, 'utf8'), editedContent);
    assert.strictEqual(await editor.evaluate((filePath) => window.editorApp.manager.openTabs.get(filePath).dirty, testFile), false);
    console.log('PASS Dirty tracking and Save persisted the edited buffer.');

    await editor.evaluate((filePath) => window.editorApp.manager.toggleMode(filePath), testFile);
    const externalContent = `${editedContent}// external update\n`;
    fs.writeFileSync(testFile, externalContent, 'utf8');
    await editor.waitForFunction((value) => window.editorApp.manager.editor.getValue() === value, externalContent, { timeout: 5000 });
    console.log('PASS View mode refreshed after an external disk change.');

    await editor.close();
    await app.close();
    app = null;
    console.log('PASS CODE EDITOR VERIFICATION COMPLETE');
  } catch (error) {
    console.error('FAIL CODE EDITOR VERIFICATION:', error.stack || error);
    process.exitCode = 1;
  } finally {
    if (app) try { await app.close(); } catch (_) {}
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch (_) {}
  }
})();
