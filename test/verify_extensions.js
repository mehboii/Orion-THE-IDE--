// Optional Electron + live-registry verification with isolated application data.
const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

async function waitInMain(page, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for the extension terminal to start.');
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-extension-electron-'));
  let app;
  try {
    const userData = path.join(temporary, 'user-data');
    await fs.mkdir(userData);
    const executablePath = process.env.ORION_TEST_EXECUTABLE;
    app = await electron.launch({
      ...(executablePath ? { executablePath: path.resolve(executablePath), args: [] } : { args: [root] }),
      env: { ...process.env, IDE_TEST_MODE: '1', IDE_TEST_USER_DATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });
    const version = await app.evaluate(({ app }) => app.getVersion());
    const expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
    assert.equal(version, expectedVersion, 'running application uses the requested release version');
    const nativeTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    assert(nativeTitle.includes(version), 'running build version is visible in the window title');
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(actualUserData, userData, 'verification must not change the user profile');
    console.log(`PASS ${executablePath ? 'packaged' : 'source'} Orion ${version} with visible build version and isolated application data`);
    const main = await app.firstWindow();
    await main.waitForSelector('.terminal-pane');
    const initialPanes = await main.locator('.terminal-pane').count();
    assert(initialPanes > 0);
    await main.locator('[data-activity="extensions"]').click();
    await main.waitForSelector('#marketplace-search');
    await main.evaluate(() => window.appInstance.sidebarPanels.showExtensionDetails('dracula-theme.theme-dracula'));
    const install = main.locator('#extension-install');
    assert.equal(await install.isEnabled(), true);
    assert(!(await main.locator('.extension-detail').textContent()).includes('Install unavailable'));
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

    // Test the real installed CLI through the UI, using a disposable package/profile.
    if (process.env.ORION_TEST_CLAUDE_BINARY) {
      const directory = path.join(userData, 'extensions', 'anthropic.claude-code');
      const nativeDirectory = path.join(directory, 'resources', 'native-binary');
      await fs.mkdir(nativeDirectory, { recursive: true });
      await fs.copyFile(process.env.ORION_TEST_CLAUDE_BINARY, path.join(nativeDirectory, process.platform === 'win32' ? 'claude.exe' : 'claude'));
      await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ publisher: 'anthropic', name: 'claude-code', version: '2.1.289', main: './extension.js', displayName: 'Claude Code' }));
      await fs.writeFile(path.join(directory, '.orion-install.json'), JSON.stringify({ installedAt: new Date().toISOString() }));
      await main.evaluate(() => window.appInstance.sidebarPanels.showExtensionDetails('anthropic.claude-code'));
      assert.match(await main.locator('[data-extension-launch]').textContent(), /Run Claude Code in Terminal/);
      await main.locator('[data-extension-launch]').click();
      await waitInMain(main, () => document.querySelector('#extension-operation-state')?.textContent.includes('Started in a terminal'));
      assert.equal(await main.locator('.terminal-pane').count(), initialPanes + 1);
      await waitInMain(main, () => {
        const pane = [...window.appInstance.panes.values()].find(pane => pane.label === 'Claude Code');
        const buffer = pane?.terminal?.buffer.active;
        if (!buffer) return false;
        let output = '';
        for (let i = 0; i < buffer.length; i++) output += buffer.getLine(i)?.translateToString() || '';
        return /Welcome to Claude|let.s get started|select.*text style|choose.*text style|trust this folder|login method|log in|Quick safety check/i.test(output)
          && !/not recognized|cannot be loaded|requires git.bash/i.test(output);
      });
      console.log('PASS Run Claude Code button starts the actual bundled CLI in an Orion terminal without replacing existing panes');
    }
  } finally {
    if (app) await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
