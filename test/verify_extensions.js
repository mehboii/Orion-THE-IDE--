// Optional Electron + live-registry verification with isolated application data.
const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-extension-electron-'));
  let app;
  try {
    const userData = path.join(temporary, 'user-data');
    await fs.mkdir(userData);
    const entry = path.join(temporary, 'bootstrap.js');
    await fs.writeFile(entry, `require('electron').app.setPath('userData', ${JSON.stringify(userData)}); require(${JSON.stringify(path.join(root, 'main/index.js'))});`);
    app = await electron.launch({ args: [entry], env: { ...process.env, IDE_TEST_MODE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } });
    const main = await app.firstWindow();
    await main.waitForSelector('.terminal-pane');
    const initialPanes = await main.locator('.terminal-pane').count();
    assert(initialPanes > 0);
    await main.locator('[data-activity="extensions"]').click();
    await main.waitForSelector('#marketplace-search');
    await main.evaluate(() => window.appInstance.sidebarPanels.showExtensionDetails('dracula-theme.theme-dracula'));
    const install = main.locator('#extension-install');
    assert.equal(await install.isEnabled(), true);
    await install.click();
    await main.waitForSelector('#extension-uninstall', { timeout: 60000 });
    assert((await main.evaluate(() => window.electronAPI.listExtensions())).some(item => item.id === 'dracula-theme.theme-dracula'));
    assert(await fs.stat(path.join(userData, 'extensions/dracula-theme.theme-dracula/package.json')));
    console.log('PASS Electron marketplace Install button downloads and persists a real VSIX through IPC');

    const fixture = path.join(temporary, 'workspace', 'example.js');
    await fs.mkdir(path.dirname(fixture)); await fs.writeFile(fixture, 'console.log("Orion");\n');
    await main.evaluate(async folder => { await window.electronAPI.setProjectRoot(folder); }, path.dirname(fixture));
    await main.evaluate(file => window.electronAPI.openEditorFile(file), fixture);
    let editor;
    for (let i = 0; i < 50; i++) {
      editor = app.windows().find(page => page.url().endsWith('editor.html'));
      if (editor) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(editor, 'separate editor opens');
    await editor.waitForSelector('.monaco-editor');
    await editor.waitForFunction(() => window.editorApp?.manager.editor?.getModel()?.getValue().includes('Orion'));
    await main.locator('[data-theme-index]').first().click();
    const background = await main.evaluate(async () => {
      const contributions = await window.electronAPI.getExtensionContributions();
      return contributions.themes.find(theme => theme.id === contributions.selectedTheme).data.colors['editor.background'];
    });
    await editor.waitForFunction(expected => {
      const probe = document.createElement('span'); probe.style.color = expected; document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color; probe.remove();
      const background = document.querySelector('.monaco-editor-background');
      return window.editorApp?.manager.extensions && background && getComputedStyle(background).backgroundColor === rgb;
    }, background);
    console.log('PASS installed theme applies to the existing Monaco editor without changing its layout');

    await main.locator('#extension-back').click();
    await main.evaluate(() => window.appInstance.sidebarPanels.showExtensionDetails('esbenp.prettier-vscode'));
    await main.locator('#extension-install').click();
    await main.waitForSelector('#extension-uninstall', { timeout: 60000 });
    assert.match(await main.locator('.compatibility-warning').textContent(), /does not yet provide/);
    await main.locator('#extension-uninstall').click();
    await main.waitForSelector('#extension-install');
    assert(!(await main.evaluate(() => window.electronAPI.listExtensions())).some(item => item.id === 'esbenp.prettier-vscode'));
    console.log('PASS executable-package install/uninstall and accurate runtime status in the Electron UI');

    assert.equal(await main.locator('.terminal-pane').count(), initialPanes);
    await editor.close();
    assert.equal(await main.locator('.terminal-pane').count(), initialPanes);
    console.log('PASS existing terminal grid and separate editor window remain available');
  } finally {
    if (app) await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
