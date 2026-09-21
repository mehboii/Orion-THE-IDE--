/* Regression coverage for editor synchronization, conflicts, Save As, and run cleanup. */
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const editTestFile = path.join(root, 'test', 'temp_edit_test.js');
const longRunFile = path.join(root, 'test', 'temp_long_run.js');
const missingInterpreterFile = path.join(root, 'test', 'temp_missing_interpreter.py');
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
  console.log('=== STARTING EDITOR REGRESSION VERIFICATION ===');
  const initialText = '// Original Content\nconst x = 42;\n';
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ide-save-as-'));
  const saveAsTestFile = path.join(externalDir, 'saved-copy.js');
  const heartbeatFile = path.join(externalDir, 'heartbeat.txt');
  fs.writeFileSync(editTestFile, initialText, 'utf8');
  fs.writeFileSync(longRunFile, `const fs = require('fs');\nsetInterval(() => fs.writeFileSync(${JSON.stringify(heartbeatFile)}, String(Date.now())), 50);\n`, 'utf8');
  fs.writeFileSync(missingInterpreterFile, 'print("should not run")\n', 'utf8');

  let app;
  try {
    app = await electron.launch({ args: [root], env: { ...process.env, PYTHON: '__missing_python_for_ide_test__', IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const main = await waitForWindow(app, 'index.html');
    await main.waitForSelector('.terminal-pane');
    await main.evaluate((folder) => window.appInstance.fileExplorer.setRootDirectory(folder, true), root);
    await main.evaluate((filePath) => window.electronAPI.openEditorFile(filePath), editTestFile);
    const editor = await waitForWindow(app, 'editor.html');
    await editor.waitForSelector('.monaco-editor');
    await editor.waitForFunction((filePath) => Boolean(window.editorApp?.manager?.openTabs?.get(filePath)?.model), editTestFile);

    await editor.evaluate(async (folder) => {
      await window.electronAPI.setTestDirectoryPath(folder);
      await window.editorApp.openFolder();
    }, path.join(root, 'main'));
    await main.waitForFunction((folder) => window.appInstance.fileExplorer.currentRootDir === folder, path.join(root, 'main'));
    assert.strictEqual(await main.evaluate(() => window.electronAPI.getProjectRoot()), path.join(root, 'main'));
    console.log('PASS Editor Open Folder synchronized the main Explorer and global project root.');

    await main.evaluate((folder) => window.appInstance.fileExplorer.setRootDirectory(folder, true), root);
    await editor.evaluate((filePath) => window.editorApp.manager.switchTab(filePath), editTestFile);
    await editor.locator('.mode-toggle-pill').click();
    const localEdit = `${initialText}// unsaved local edit\n`;
    await editor.evaluate((value) => window.editorApp.manager.editor.setValue(value), localEdit);
    fs.writeFileSync(editTestFile, `${initialText}// external edit\n`, 'utf8');
    await editor.waitForFunction((filePath) => window.editorApp.manager.openTabs.get(filePath)?.externalConflict === true, editTestFile);
    assert.strictEqual(await editor.evaluate(() => window.editorApp.manager.editor.getValue()), localEdit, 'external change must not overwrite a dirty buffer');
    await editor.evaluate(() => window.editorApp.save());
    assert.strictEqual(fs.readFileSync(editTestFile, 'utf8'), localEdit);
    console.log('PASS External changes are flagged without replacing unsaved editor content.');

    const saveAsText = `${localEdit}// external Save As target\n`;
    await editor.evaluate((value) => window.editorApp.manager.editor.setValue(value), saveAsText);
    await editor.evaluate(async (target) => {
      await window.electronAPI.setTestSaveAsPath(target);
      await window.editorApp.saveAs();
    }, saveAsTestFile);
    assert.strictEqual(fs.readFileSync(saveAsTestFile, 'utf8'), saveAsText);
    console.log('PASS Explicit Save As authorization wrote and reopened a file outside the project root.');

    await editor.evaluate((filePath) => window.editorApp.openFile(filePath), missingInterpreterFile);
    await editor.evaluate(() => window.editorApp.executeRun('run'));
    await editor.waitForFunction(() => document.getElementById('run-output-status')?.textContent.includes('Exited with code 1'));
    assert.strictEqual(app.windows().length, 2, 'missing interpreter crashed an Electron window');
    console.log('PASS Missing interpreter produced a handled run error without crashing Electron.');

    await editor.evaluate((filePath) => window.editorApp.openFile(filePath), longRunFile);
    await editor.waitForFunction((filePath) => window.editorApp.manager.activeFilePath === filePath, longRunFile);
    await editor.evaluate(() => window.editorApp.executeRun('run'));
    for (let i = 0; i < 40 && !fs.existsSync(heartbeatFile); i += 1) await sleep(50);
    assert(fs.existsSync(heartbeatFile), 'long-running fixture did not start');
    await editor.close();
    await sleep(350);
    const stoppedValue = fs.readFileSync(heartbeatFile, 'utf8');
    await sleep(350);
    assert.strictEqual(fs.readFileSync(heartbeatFile, 'utf8'), stoppedValue, 'run process continued after editor window closed');
    console.log('PASS Closing the editor terminated its active Run process.');

    await app.close();
    app = null;
    console.log('PASS EDITOR REGRESSION VERIFICATION COMPLETE');
  } catch (error) {
    console.error('FAIL EDITOR REGRESSION VERIFICATION:', error.stack || error);
    process.exitCode = 1;
  } finally {
    if (app) try { await app.close(); } catch (_) {}
    for (const file of [editTestFile, longRunFile, missingInterpreterFile]) try { fs.unlinkSync(file); } catch (_) {}
    try { fs.rmSync(externalDir, { recursive: true, force: true }); } catch (_) {}
  }
})();
