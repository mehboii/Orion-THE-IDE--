const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createHash } = require('crypto');
const { ExtensionEditor } = require('../main/extension-editor');
const { ExtensionService } = require('../main/extension-service');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-extension-editor-test-'));
  try {
    const extensions = new ExtensionService({ root: path.join(root, 'packages') });
    const source = path.join(extensions.root, 'demo.executable');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ publisher: 'demo', name: 'executable', version: '1.0.0', main: 'extension.js', engines: { vscode: '^1.80.0' } }));
    await fs.writeFile(path.join(source, '.orion-install.json'), JSON.stringify({ installedAt: 'first' }));
    await fs.writeFile(path.join(source, 'extension.js'), 'fixture extension code');
    const archiveBytes = Buffer.from('verified runtime fixture');
    const digest = createHash('sha256').update(archiveBytes).digest('hex');
    const assetUrl = 'https://github.com/VSCodium/vscodium/releases/download/1.100.0/VSCodium-win32-x64-1.100.0.zip';
    const release = { tag_name: '1.100.0', assets: [{ name: 'VSCodium-win32-x64-1.100.0.zip', browser_download_url: assetUrl, digest: `sha256:${digest}` }] };
    let downloads = 0, launches = [], corrupt = false, launchError = false;
    const editor = new ExtensionEditor({ root: path.join(root, 'editor'), extensions, platform: 'win32', arch: 'x64', environment: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--bad-option', CUSTOM_ENV: 'preserved' },
      json: async () => release,
      download: async (url, destination) => { assert.equal(url, assetUrl); downloads++; await fs.writeFile(destination, corrupt ? 'corrupted' : archiveBytes); },
      extract: async (_archive, stage) => { await fs.writeFile(path.join(stage, 'VSCodium.exe'), 'runtime executable'); },
      launch: (executable, args, options) => {
        launches.push({ executable, args, options });
        const child = new EventEmitter(); child.unref = () => {};
        setImmediate(() => child.emit(launchError ? 'error' : 'spawn', launchError ? new Error('Launch failed') : undefined));
        return child;
      }
    });
    corrupt = true;
    await assert.rejects(editor.ensureRuntime(), /checksum verification failed/);
    assert.deepEqual(await fs.readdir(editor.root), [], 'failed setup is cleaned up and can retry');
    corrupt = false;
    const [first, second] = await Promise.all([editor.ensureRuntime(), editor.ensureRuntime()]);
    assert.equal(first, second);
    assert.equal(downloads, 2, 'concurrent setup uses one download and a failed attempt can retry');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const file = path.join(workspace, 'test.js'); await fs.writeFile(file, 'const x = 1;');
    const progress = [];
    assert.equal((await editor.open({ workspace, file, progress: message => progress.push(message) })).opened, true);
    assert(await editor.isEnabled());
    const launched = launches[0];
    assert(launched.args.includes(workspace) && launched.args.includes(file));
    assert(launched.args.includes('--extensions-dir') && launched.args.includes('--user-data-dir'));
    assert.equal(launched.options.cwd, workspace);
    assert.equal(launched.options.shell, false);
    assert.equal(launched.options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(launched.options.env.NODE_OPTIONS, undefined);
    assert.equal(launched.options.env.CUSTOM_ENV, 'preserved');
    assert(progress.some(message => /Opening/.test(message)));
    assert.equal(await fs.readFile(path.join(editor.root, 'extensions/orion.demo.executable/extension.js'), 'utf8'), 'fixture extension code');
    const restart = new ExtensionEditor({ root: editor.root, extensions });
    assert(await restart.isEnabled(), 'editor choice persists across Orion restarts');
    await editor.open({ workspace });
    assert.equal(downloads, 2, 'installed runtime is reused');
    await fs.writeFile(path.join(source, 'extension.js'), 'updated');
    await fs.writeFile(path.join(source, '.orion-install.json'), JSON.stringify({ installedAt: 'updated' }));
    await editor.open({ workspace });
    assert.equal(await fs.readFile(path.join(editor.root, 'extensions/orion.demo.executable/extension.js'), 'utf8'), 'updated');
    const external = path.join(editor.root, 'extensions/other.extension');
    await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep.txt'), 'keep');
    await extensions.uninstall('demo.executable');
    await editor.open({ workspace });
    assert(!(await fs.readdir(path.join(editor.root, 'extensions'))).includes('orion.demo.executable'));
    assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep', 'extensions installed directly in VSCodium are preserved');
    launchError = true;
    await assert.rejects(editor.open({ workspace }), /Launch failed/);
    launchError = false;
    await editor.open({ workspace });
    await assert.rejects(editor.open({ workspace: path.join(root, 'missing') }), /ENOENT/);
    const unsupported = new ExtensionEditor({ root: path.join(root, 'unsupported'), extensions, platform: 'linux', executable: path.join(root, 'missing') });
    await assert.rejects(unsupported.ensureRuntime(), /not found/);
    release.assets[0].browser_download_url = 'https://untrusted.test/runtime.zip';
    const invalid = new ExtensionEditor({ root: path.join(root, 'invalid'), extensions, platform: 'win32', arch: 'x64', environment: {}, json: async () => release });
    await assert.rejects(invalid.ensureRuntime(), /official VSCodium/);
    await editor.useBuiltInEditor();
    assert.equal(await editor.isEnabled(), false);
    assert.equal(await restart.isEnabled(), false, 'built-in editor selection persists');
    console.log('PASS verified runtime setup/retry, isolated profiles, package sync/update/uninstall, workspace/file routing, launch errors, and persisted editor choice');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
