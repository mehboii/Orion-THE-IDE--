const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ExtensionService, extensionId, extractVsix, platformTarget } = require('../main/extension-service');

// Small standards-compliant ZIP fixtures; no extension code is ever executed.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [name, contents, attributes = 0] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(contents);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(attributes >>> 0, 38); central.writeUInt32LE(offset, 42);
    chunks.push(local, filename, data); directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-extension-test-'));
  const registry = new Map(), downloads = new Map(), calls = [];
  function publish(id, extra = {}, files = [], version = '1.0.0') {
    const [publisher, name] = id.split('.');
    const manifest = { publisher, name, version, ...extra };
    registry.set(id, { version, targetPlatform: 'universal', files: { download: `https://packages.test/${id}` } });
    downloads.set(`https://packages.test/${id}`, zip([['extension/package.json', JSON.stringify(manifest)], ...files.map(([filename, contents]) => [`extension/${filename}`, contents])]));
  }
  const service = new ExtensionService({ root, target: 'win32-x64',
    json: async url => {
      calls.push(url);
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      if (parts.length > 3) throw new Error('Marketplace responded with HTTP 404.');
      const data = registry.get(`${parts[1]}.${parts[2]}`);
      if (!data) throw new Error('Marketplace responded with HTTP 404.');
      return data;
    },
    download: async url => { if (!downloads.has(url)) throw new Error('Download interrupted.'); return downloads.get(url); }
  });
  try {
    assert.equal(platformTarget('win32', 'x64'), 'win32-x64');
    assert.equal(platformTarget('darwin', 'arm64'), 'darwin-arm64');
    assert.throws(() => extensionId('../outside'), /Invalid extension/);
    assert.deepEqual(await service.list(), []);
    publish('demo.code', { main: './extension.js', contributes: { commands: [{ command: 'demo.command', title: 'Demo' }] } }, [['extension.js', 'throw new Error("MUST NOT EXECUTE DURING INSTALL");']]);
    let result = await service.install('Demo.Code');
    assert.equal(result.extension.id, 'demo.code');
    assert.equal(result.extension.requiresExtensionHost, true);
    assert.match(result.extension.runtimeMessage, /does not yet provide/);
    assert.equal(await fs.readFile(path.join(root, 'demo.code', 'extension.js'), 'utf8'), 'throw new Error("MUST NOT EXECUTE DURING INSTALL");');
    assert(calls.some(url => url.endsWith('/win32-x64/latest')), 'request matching platform first');
    const restarted = new ExtensionService({ root });
    assert.equal((await restarted.list())[0].id, 'demo.code', 'install persists across app restarts');

    publish('demo.web', { browser: './web.js' }, [['web.js', 'throw new Error("DO NOT RUN");']]);
    await service.install('demo.web');
    publish('demo.data', { contributes: { themes: [{ id: 'test', label: 'Test Theme', uiTheme: 'vs-dark', path: './themes/main.json' }], snippets: [{ language: 'javascript', path: './snippets/js.json' }] } }, [
      ['themes/base.json', '{"colors":{"editor.foreground":"#abcdef"},"tokenColors":[]}'],
      ['themes/main.json', '{ // JSON with comments\n "include":"./base.json", "colors":{"editor.background":"#123456"}, }'],
      ['snippets/js.json', '{"Log":{"prefix":"log","body":["console.log(${1:value});"],"description":"Log a value"}}']
    ]);
    await service.install('demo.data');
    let contributions = await service.contributions();
    assert.equal(contributions.themes[0].data.colors['editor.foreground'], '#abcdef');
    assert.equal(contributions.themes[0].data.colors['editor.background'], '#123456');
    assert.equal(contributions.snippets[0].data.Log.prefix, 'log');
    await service.setTheme('demo.data:test');
    assert.equal((await restarted.contributions()).selectedTheme, 'demo.data:test');
    await assert.rejects(service.setTheme('unknown'), /not installed/);
    await service.setTheme(null);

    publish('demo.pack', { extensionPack: ['demo.code', 'demo.data', 'demo.web'] });
    result = await service.install('demo.pack');
    assert.deepEqual(result.installed.map(item => item.id), ['demo.pack'], 'already installed pack members are reused');
    publish('demo.dependent', { extensionDependencies: ['demo.code'] });
    await service.install('demo.dependent');
    await assert.rejects(service.uninstall('demo.code'), /depends on/);
    await service.uninstall('demo.dependent');
    await service.uninstall('demo.code');
    assert(!(await service.list()).some(item => item.id === 'demo.code'));
    result = await service.install('demo.pack');
    assert.deepEqual(result.installed.map(item => item.id), ['demo.code', 'demo.pack'], 'packs install missing members');

    publish('demo.cyclea', { extensionDependencies: ['demo.cycleb'] });
    publish('demo.cycleb', { extensionDependencies: ['demo.cyclea'] });
    await service.install('demo.cyclea');
    assert((await service.list()).some(item => item.id === 'demo.cycleb'));
    publish('demo.missing', { extensionDependencies: ['demo.notpublished'] });
    await assert.rejects(service.install('demo.missing'), /HTTP 404/);
    assert(!(await service.list()).some(item => item.id === 'demo.missing'));

    // A failed update must preserve the previously installed package.
    publish('demo.code', { main: './extension.js' }, [], '2.0.0');
    downloads.set('https://packages.test/demo.code', Buffer.from('broken zip'));
    await assert.rejects(service.install('demo.code'));
    assert.equal((await service.list()).find(item => item.id === 'demo.code').version, '1.0.0');
    publish('demo.code', { main: './extension.js' }, [['extension.js', 'updated']], '2.0.0');
    await service.install('demo.code');
    assert.equal((await service.list()).find(item => item.id === 'demo.code').version, '2.0.0');
    assert.equal(await fs.readFile(path.join(root, 'demo.code', 'extension.js'), 'utf8'), 'updated');

    publish('demo.mismatch');
    downloads.set('https://packages.test/demo.mismatch', zip([['extension/package.json', '{"publisher":"other","name":"extension","version":"1.0.0"}']]));
    await assert.rejects(service.install('demo.mismatch'), /does not match/);
    publish('demo.foreign');
    registry.get('demo.foreign').targetPlatform = 'darwin-arm64';
    await assert.rejects(service.install('demo.foreign'), /no package for/);
    const failedStage = path.join(root, '.bad-archive');
    for (const entries of [
      [['extension/../../escape.txt', 'bad']],
      [['extension/C:/escape.txt', 'bad']],
      [['extension/NUL.txt', 'bad']],
      [['extension/link', '../../escape.txt', 0xa1ff << 16]],
      [['extension/file.txt', 'one'], ['extension/FILE.txt', 'two']]
    ]) {
      await fs.rm(failedStage, { recursive: true, force: true });
      await assert.rejects(extractVsix(zip(entries), failedStage));
    }
    await fs.rm(failedStage, { recursive: true, force: true });
    assert(!(await fs.readdir(root)).some(name => name.startsWith('.install-')), 'failed installs clean staging files');
    await assert.rejects(service.launchInfo('demo.code', 'terminal'), /no supported/);
    const nativeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    publish('anthropic.claude-code', { main: './extension.js' }, [[`resources/native-binary/${nativeName}`, 'fixture']]);
    await service.install('anthropic.claude-code');
    const claude = (await service.list()).find(item => item.id === 'anthropic.claude-code');
    assert.equal(claude.launchActions[0].id, 'terminal');
    const launch = await service.launchInfo(claude.id, 'terminal');
    assert.equal(launch.trigger, 'extension-launch');
    assert(launch.agentCommand.includes(path.join(root, claude.id, 'resources', 'native-binary', nativeName)));
    await assert.rejects(service.launchInfo(claude.id, 'unknown'), /no supported/);
    await fs.unlink(path.join(root, claude.id, 'resources', 'native-binary', nativeName));
    assert.equal((await service.list()).find(item => item.id === claude.id).launchActions, undefined);
    await assert.rejects(service.launchInfo(claude.id, 'terminal'), /no supported/);
    const before = (await service.list()).length;
    assert.throws(() => service.uninstall('../outside'), /Invalid extension/);
    assert.equal((await service.list()).length, before);
    console.log('PASS extension installation, all package types, persistence, packs, dependencies, updates, uninstall, themes/snippets, and unsafe archives');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
