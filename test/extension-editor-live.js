// Optional full runtime check: downloads official VSCodium and opens a disposable
// editor window. Verifies real Open VSX Prettier execution, not a mock VS Code API.
const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { ExtensionService } = require('../main/extension-service');
const { ExtensionEditor } = require('../main/extension-editor');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-extension-editor-live-'));
  let application;
  try {
    const extensions = new ExtensionService({ root: path.join(root, 'packages') });
    await extensions.install('esbenp.prettier-vscode');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'editor.defaultFormatter': 'esbenp.prettier-vscode', 'security.workspace.trust.enabled': false }));
    await fs.writeFile(path.join(workspace, 'example.js'), 'const x={a:1}');
    const fixture = path.join(extensions.root, 'orion.runtime-check');
    await fs.mkdir(fixture, { recursive: true });
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ publisher: 'orion', name: 'runtime-check', version: '1.0.0', engines: { vscode: '^1.80.0' }, main: './extension.js', activationEvents: ['*'] }));
    await fs.writeFile(path.join(fixture, '.orion-install.json'), JSON.stringify({ installedAt: new Date().toISOString() }));
    await fs.writeFile(path.join(fixture, 'extension.js'), `
      const vscode = require('vscode');
      exports.activate = async context => {
        const root = vscode.workspace.workspaceFolders[0].uri;
        const result = { version: vscode.version, workspace: root.fsPath };
        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'example.js'));
          await vscode.window.showTextDocument(document);
          const prettier = vscode.extensions.getExtension('esbenp.prettier-vscode');
          if (!prettier) throw new Error('Prettier was not discovered by the extension scanner.');
          await prettier.activate();
          // The editor's format action respects editor.defaultFormatter; the
          // executeFormatDocumentProvider API can return the built-in formatter.
          await vscode.commands.executeCommand('editor.action.formatDocument');
          result.formatted = document.getText();
          const diagnostics = vscode.languages.createDiagnosticCollection('orion-check');
          diagnostics.set(document.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'Runtime check', vscode.DiagnosticSeverity.Information)]);
          context.subscriptions.push(diagnostics);
          result.diagnostics = diagnostics.get(document.uri).length;
          const panel = vscode.window.createWebviewPanel('orion-check', 'Orion Runtime Check', vscode.ViewColumn.Beside, {});
          panel.webview.html = '<h1>Orion extension runtime is active</h1>';
          context.subscriptions.push(panel);
          result.webview = true;
          for (let attempt = 0; attempt < 60; attempt++) {
            result.edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 2, insertSpaces: true });
            if (result.edits?.length) break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          result.prettierActive = vscode.extensions.getExtension('esbenp.prettier-vscode')?.isActive;
        } catch (error) { result.error = error.stack || error.message; }
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'runtime-result.json'), Buffer.from(JSON.stringify(result)));
      };
    `);
    // Cache only the verified runtime; every editor profile and workspace is disposable.
    const runtime = new ExtensionEditor({ root: path.join(os.tmpdir(), 'orion-vscodium-runtime-test-cache'), extensions });
    const executable = await runtime.ensureRuntime(message => console.log(message));
    const editor = new ExtensionEditor({ root: path.join(root, 'editor'), extensions, executable });
    const extensionDirectory = await editor.syncExtensions();
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    application = await electron.launch({ executablePath: executable, args: ['--user-data-dir', path.join(editor.root, 'user-data'), '--extensions-dir', extensionDirectory, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace], env, timeout: 60000 });
    await application.firstWindow({ timeout: 60000 });
    let result;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { result = JSON.parse(await fs.readFile(path.join(workspace, 'runtime-result.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(result, 'extension activation writes its result');
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.workspace.toLowerCase(), workspace.toLowerCase());
    assert.equal(result.diagnostics, 1);
    assert.equal(result.webview, true);
    assert.equal(result.prettierActive, true, 'actual Open VSX Prettier extension activates');
    assert.equal(result.formatted, 'const x = { a: 1 };\n', JSON.stringify(result));
    console.log('PASS real VSCodium extension host: Open VSX Prettier activation/formatting, workspace, diagnostics, and webview API');
  } finally {
    if (application) await application.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
