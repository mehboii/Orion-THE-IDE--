const fs = require('fs/promises');
const { createReadStream } = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { spawn } = require('child_process');
const { requestFile, requestJson, requestBuffer } = require('./marketplace-http');
const { extractZip, extensionId } = require('./extension-service');

const RELEASE_API = 'https://api.github.com/repos/VSCodium/vscodium/releases/latest';

async function fileExists(filename) {
  try { return (await fs.stat(filename)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

class ExtensionEditor {
  constructor({ root, extensions, platform = process.platform, arch = process.arch,
    json = requestJson, download = requestFile, buffer = requestBuffer,
    extract = extractZip, launch = spawn, executable, environment = process.env } = {}) {
    this.root = path.resolve(root);
    this.extensions = extensions;
    this.platform = platform;
    this.arch = arch;
    this.json = json;
    this.download = download;
    this.buffer = buffer;
    this.extract = extract;
    this.spawn = launch;
    this.executable = executable;
    this.environment = environment;
    this.queue = Promise.resolve();
    this.setup = null;
    this.enabled = false;
  }

  async isEnabled() {
    if (this.enabled) return true;
    return fileExists(path.join(this.root, 'enabled.json'));
  }

  useBuiltInEditor() {
    const result = this.queue.then(async () => {
      await fs.rm(path.join(this.root, 'enabled.json'), { force: true });
      this.enabled = false;
      return true;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async findExecutable() {
    const managed = path.join(this.root, 'runtime', 'VSCodium.exe');
    const candidates = this.executable ? [path.resolve(this.executable)] : this.platform === 'win32' ? [
      managed,
      this.environment.LOCALAPPDATA && path.join(this.environment.LOCALAPPDATA, 'Programs', 'VSCodium', 'VSCodium.exe'),
      this.environment.ProgramFiles && path.join(this.environment.ProgramFiles, 'VSCodium', 'VSCodium.exe')
    ] : this.platform === 'darwin' ? [
      '/Applications/VSCodium.app/Contents/MacOS/Electron',
      path.join(os.homedir(), 'Applications/VSCodium.app/Contents/MacOS/Electron')
    ] : ['/usr/share/codium/codium', '/opt/vscodium/codium', '/usr/bin/codium'];
    for (const candidate of candidates.filter(Boolean)) if (await fileExists(candidate)) return candidate;
    if (this.executable) throw new Error('The configured extension editor executable was not found.');
    return null;
  }

  async ensureRuntime(progress = () => {}) {
    const existing = await this.findExecutable();
    if (existing) return existing;
    if (this.setup) return this.setup;
    this.setup = this.provision(progress).finally(() => { this.setup = null; });
    return this.setup;
  }

  async provision(progress) {
    if (this.platform !== 'win32' || !['x64', 'arm64'].includes(this.arch)) {
      throw new Error('Install VSCodium for this platform, then reopen Extension Editor. Automatic runtime setup currently supports Windows x64 and arm64.');
    }
    progress('Finding the VSCodium editor runtime...');
    const release = await this.json(RELEASE_API);
    const expectedName = `VSCodium-win32-${this.arch}-${release.tag_name}.zip`;
    const asset = release.assets?.find(item => item.name === expectedName);
    const expectedUrl = `https://github.com/VSCodium/vscodium/releases/download/${release.tag_name}/${expectedName}`;
    if (!asset || asset.browser_download_url !== expectedUrl) throw new Error('No official VSCodium runtime is available for this platform.');
    let digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1];
    if (!digest) {
      const checksum = release.assets.find(item => item.name === `${expectedName}.sha256`);
      if (!checksum || checksum.browser_download_url !== `${expectedUrl}.sha256`) throw new Error('The editor runtime has no SHA-256 checksum.');
      const text = (await this.buffer(checksum.browser_download_url, { maxBytes: 16384 })).toString('utf8');
      digest = /^([a-f0-9]{64})\s/i.exec(text)?.[1];
      if (!digest) throw new Error('The editor runtime checksum is invalid.');
    }
    await fs.mkdir(this.root, { recursive: true });
    const stage = await fs.mkdtemp(path.join(this.root, '.runtime-'));
    const archive = `${stage}.zip`;
    try {
      progress('Downloading the VSCodium editor runtime. This is only needed on the first launch...');
      await this.download(expectedUrl, archive);
      progress('Verifying the editor runtime...');
      if ((await sha256(archive)).toLowerCase() !== digest.toLowerCase()) throw new Error('Editor runtime checksum verification failed. Retry the download.');
      progress('Extracting the editor runtime...');
      await this.extract(archive, stage, { maxExpandedBytes: 2 * 1024 * 1024 * 1024 });
      if (!await fileExists(path.join(stage, 'VSCodium.exe'))) throw new Error('The editor runtime archive does not contain VSCodium.exe.');
      await fs.writeFile(path.join(stage, '.orion-runtime.json'), JSON.stringify({ version: release.tag_name, sha256: digest, provider: 'VSCodium' }));
      await fs.rename(stage, path.join(this.root, 'runtime'));
      return path.join(this.root, 'runtime', 'VSCodium.exe');
    } finally {
      await fs.rm(archive, { force: true });
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  async syncExtensions() {
    const directory = path.join(this.root, 'extensions');
    await fs.mkdir(directory, { recursive: true });
    const stateFile = path.join(this.root, 'synced-extensions.json');
    let previous = {};
    try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = {};
    for (const item of await this.extensions.list()) {
      const id = extensionId(item.id);
      // A stable directory per Orion package avoids duplicate extension versions.
      const name = `orion.${id}`;
      const stamp = `${item.version}:${item.installedAt}`;
      const destination = path.join(directory, name);
      if (previous[id] !== stamp || !await fileExists(path.join(destination, 'package.json'))) {
        const stage = await fs.mkdtemp(path.join(this.root, '.sync-'));
        const backup = `${stage}-previous`;
        let hadPrevious = false;
        try {
          await fs.cp(path.join(this.extensions.root, id), stage, { recursive: true, dereference: false });
          try { await fs.rename(destination, backup); hadPrevious = true; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          try { await fs.rename(stage, destination); }
          catch (error) { if (hadPrevious) await fs.rename(backup, destination); throw error; }
          if (hadPrevious) await fs.rm(backup, { recursive: true, force: true });
        } finally { await fs.rm(stage, { recursive: true, force: true }); }
      }
      next[id] = stamp;
    }
    for (const id of Object.keys(previous)) {
      if (!(id in next)) await fs.rm(path.join(directory, `orion.${extensionId(id)}`), { recursive: true, force: true });
    }
    await fs.writeFile(stateFile, JSON.stringify(next));
    return directory;
  }

  open({ workspace, file, progress = () => {} } = {}) {
    const result = this.queue.then(async () => {
      // Validate before a potentially lengthy first-time download.
      if (workspace && !(await fs.stat(workspace)).isDirectory()) throw new Error('The workspace folder no longer exists.');
      if (file && !(await fs.stat(file)).isFile()) throw new Error('The requested editor file no longer exists.');
      const executable = await this.ensureRuntime(progress);
      progress('Loading installed extensions...');
      const extensionDirectory = await this.syncExtensions();
      const userData = path.join(this.root, 'user-data');
      await fs.mkdir(userData, { recursive: true });
      const args = ['--user-data-dir', userData, '--extensions-dir', extensionDirectory, '--reuse-window'];
      if (workspace) args.push(path.resolve(workspace));
      if (file) args.push(path.resolve(file));
      const env = { ...this.environment };
      // Orion or its test runner may have inherited Electron's Node-only mode.
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      progress('Opening Extension Editor...');
      await new Promise((resolve, reject) => {
        const child = this.spawn(executable, args, { cwd: workspace || os.homedir(), env, detached: true, stdio: 'ignore', shell: false, windowsHide: false });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      await fs.writeFile(path.join(this.root, 'enabled.json'), JSON.stringify({ enabled: true }));
      this.enabled = true;
      progress('Extension Editor opened. Installed extensions activate there as their commands, files, or views are used.');
      return { opened: true, runtime: 'VSCodium' };
    });
    this.queue = result.catch(() => {});
    return result;
  }
}

module.exports = { ExtensionEditor, sha256 };
