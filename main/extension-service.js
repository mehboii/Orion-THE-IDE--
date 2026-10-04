const fs = require('fs/promises');
const path = require('path');
const yauzl = require('yauzl');
const { parse } = require('jsonc-parser');
const { requestJson, requestFile } = require('./marketplace-http');

function extensionId(value) {
  const id = String(value || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Invalid extension identifier.');
  return id;
}

function platformTarget(platform = process.platform, arch = process.arch) {
  return `${platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`;
}

function packagePath(root, name) {
  if (typeof name !== 'string' || name.includes('\\') || name.includes(':') || name.includes('\0')) throw new Error('Unsafe extension file path.');
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe extension file path.');
  // Reject aliases, Windows devices and trailing dots/spaces on every platform.
  if (name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe extension file path.');
  return target;
}

async function extractZip(bytes, destination, { prefix = '', maxExpandedBytes = 1024 * 1024 * 1024 } = {}) {
  const zip = await new Promise((resolve, reject) => {
    const open = Buffer.isBuffer(bytes) ? yauzl.fromBuffer : yauzl.open;
    open(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result));
  });
  await fs.mkdir(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    let count = 0, expanded = 0, failed = false;
    const names = new Set();
    const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', async entry => {
      try {
        if (++count > 100000 || (expanded += entry.uncompressedSize) > maxExpandedBytes) throw new Error('Archive exceeds extraction limits.');
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Extension archives cannot contain symbolic links.');
        if (!entry.fileName.startsWith(prefix) || entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        const name = entry.fileName.slice(prefix.length);
        const target = packagePath(destination, name);
        if (names.has(name.toLowerCase())) throw new Error('Extension archive contains duplicate file paths.');
        names.add(name.toLowerCase());
        const stream = await new Promise((yes, no) => zip.openReadStream(entry, (error, result) => error ? no(error) : yes(result)));
        await fs.mkdir(path.dirname(target), { recursive: true });
        const { pipeline } = require('stream/promises');
        const { createWriteStream } = require('fs');
        const permissions = (entry.externalFileAttributes >>> 16) & 0o777;
        await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: permissions || 0o644 }));
        if (!failed) zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
}

// VSIX metadata lives outside extension/. Only the package is installed.
function extractVsix(bytes, destination) {
  return extractZip(bytes, destination, { prefix: 'extension/' });
}

function installationInfo(manifest, installedAt) {
  const requiresHost = Boolean(manifest.main || manifest.browser);
  const supported = ['themes', 'snippets'];
  const unsupported = Object.keys(manifest.contributes || {}).filter(key => !supported.includes(key));
  return {
    id: extensionId(`${manifest.publisher}.${manifest.name}`), name: manifest.displayName || manifest.name,
    publisher: manifest.publisher, version: manifest.version, description: manifest.description || '', installed: true,
    installedAt, requiresExtensionHost: requiresHost, unsupportedContributions: unsupported,
    launchActions: [{ id: 'editor', label: 'Open Extension Editor' }],
    runtimeMessage: requiresHost
      ? 'Package installed. Open Extension Editor to run its executable features in the VSCodium editor. The first launch sets up the editor runtime.'
      : unsupported.length
        ? 'Package installed. Open Extension Editor to use all of its editor contributions. Color themes and snippets are also available in the built-in editor.'
        : 'Package installed. Color themes and snippets are available in the Orion editor.'
  };
}

class ExtensionService {
  constructor({ root, json = requestJson, download, downloadFile = requestFile, target = platformTarget() }) {
    this.root = path.resolve(root);
    this.json = json;
    this.download = download;
    this.downloadFile = downloadFile;
    this.target = target;
    this.queue = Promise.resolve();
  }

  serialize(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async list() {
    let entries;
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const installed = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const id = extensionId(entry.name);
        const manifest = JSON.parse(await fs.readFile(path.join(this.root, id, 'package.json'), 'utf8'));
        const metadata = JSON.parse(await fs.readFile(path.join(this.root, id, '.orion-install.json'), 'utf8'));
        if (extensionId(`${manifest.publisher}.${manifest.name}`) !== id) continue;
        const info = installationInfo(manifest, metadata.installedAt);
        if (await this.nativeExecutable(id)) {
          info.launchActions.push({ id: 'terminal', label: 'Run Claude Code in Terminal' });
          info.runtimeMessage = 'Open Extension Editor to use Claude Code panels, or run its bundled CLI in an Orion terminal.';
        }
        installed.push(info);
      } catch (_) { /* An incomplete or externally modified package is not installed. */ }
    }
    return installed.sort((a, b) => a.id.localeCompare(b.id));
  }

  async nativeExecutable(identifier) {
    const id = extensionId(identifier);
    // A bundled CLI is a supported terminal integration, not a VS Code API host.
    if (id !== 'anthropic.claude-code') return null;
    const directory = path.join(this.root, id);
    const executable = path.join(directory, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      const resolved = await fs.realpath(executable);
      const relative = path.relative(await fs.realpath(directory), resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(resolved)).isFile()) return null;
      return resolved;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async launchInfo(identifier, action) {
    const id = extensionId(identifier);
    const installed = (await this.list()).find(item => item.id === id);
    if (!installed || action !== 'terminal' || !installed.launchActions?.some(item => item.id === 'terminal')) throw new Error('This extension has no supported terminal launch action.');
    const executable = await this.nativeExecutable(id);
    if (!executable) throw new Error('The bundled executable is missing. Reinstall this extension.');
    const agentCommand = process.platform === 'win32'
      ? `& '${executable.replace(/'/g, "''")}'`
      : `'${executable.replace(/'/g, "'\\''")}'`;
    return { label: 'Claude Code', agentId: 'shell', agentCommand, trigger: 'extension-launch' };
  }

  install(identifier) {
    const id = extensionId(identifier);
    return this.serialize(async () => {
      const installed = new Map((await this.list()).map(item => [item.id, item]));
      const visiting = new Set();
      const changed = [];
      const installOne = async (current, force = false, depth = 0) => {
        current = extensionId(current);
        if (depth > 32 || visiting.size > 200) throw new Error('Extension dependency graph is too large.');
        if (visiting.has(current)) return;
        if (!force && installed.has(current)) return;
        visiting.add(current);
        const [namespace, name] = current.split('.');
        const base = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        // Prefer the native artifact, then fall back to the universal package.
        let details;
        try { details = await this.json(`${base}/${this.target}/latest`); }
        catch (error) { if (!/HTTP 404/.test(error.message)) throw error; details = await this.json(base); }
        if (details.error) throw new Error(details.error);
        if (details.targetPlatform && !['universal', this.target].includes(details.targetPlatform)) throw new Error(`This extension has no package for ${this.target}.`);
        if (!details.files?.download) throw new Error('This extension has no downloadable VSIX package.');
        await fs.mkdir(this.root, { recursive: true });
        const stage = await fs.mkdtemp(path.join(this.root, '.install-'));
        const archive = `${stage}.vsix`;
        try {
          if (this.download) {
            await extractVsix(await this.download(details.files.download), stage);
          } else {
            await this.downloadFile(details.files.download, archive);
            await extractVsix(archive, stage);
          }
          const manifest = JSON.parse(await fs.readFile(path.join(stage, 'package.json'), 'utf8'));
          if (extensionId(`${manifest.publisher}.${manifest.name}`) !== current || typeof manifest.version !== 'string' || !manifest.version) throw new Error('Downloaded package does not match the requested extension.');
          if (details.version && manifest.version !== details.version) throw new Error('Downloaded extension version does not match the registry.');
          for (const key of ['extensionDependencies', 'extensionPack']) {
            if (manifest[key] !== undefined && !Array.isArray(manifest[key])) throw new Error(`Invalid ${key} in extension manifest.`);
            for (const dependency of manifest[key] || []) await installOne(dependency, false, depth + 1);
          }
          const installedAt = new Date().toISOString();
          await fs.writeFile(path.join(stage, '.orion-install.json'), JSON.stringify({ installedAt, provider: 'open-vsx', targetPlatform: details.targetPlatform || 'universal' }));
          const destination = path.join(this.root, current);
          const backup = path.join(this.root, `${path.basename(stage)}-previous`);
          let previous = false;
          try { await fs.rename(destination, backup); previous = true; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          try { await fs.rename(stage, destination); }
          catch (error) { if (previous) await fs.rename(backup, destination); throw error; }
          if (previous) await fs.rm(backup, { recursive: true, force: true });
          const info = installationInfo(manifest, installedAt);
          installed.set(current, info); changed.push(info);
        } finally {
          await fs.rm(archive, { force: true });
          await fs.rm(stage, { recursive: true, force: true });
        }
      };
      await installOne(id, true);
      return { extension: installed.get(id), installed: changed };
    });
  }

  uninstall(identifier) {
    const id = extensionId(identifier);
    return this.serialize(async () => {
      for (const item of await this.list()) {
        if (item.id === id) continue;
        const manifest = JSON.parse(await fs.readFile(path.join(this.root, item.id, 'package.json'), 'utf8'));
        if ((manifest.extensionDependencies || []).some(dependency => extensionId(dependency) === id)) throw new Error(`Uninstall ${item.name} first; it depends on this extension.`);
      }
      await fs.rm(path.join(this.root, id), { recursive: true, force: true });
      return { id, installed: false };
    });
  }

  async contributions() {
    const themes = [], snippets = [], errors = [];
    for (const info of await this.list()) {
      const root = path.join(this.root, info.id);
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      const readJson = async filename => {
        const file = packagePath(root, filename.replace(/^\.\//, ''));
        const content = await fs.readFile(file, 'utf8');
        if (content.length > 8 * 1024 * 1024) throw new Error('Contribution file is too large.');
        const parseErrors = [];
        const value = parse(content, parseErrors, { allowTrailingComma: true });
        if (parseErrors.length || !value || typeof value !== 'object') throw new Error('Invalid contribution JSON.');
        return value;
      };
      for (const theme of manifest.contributes?.themes || []) {
        try {
          const loadTheme = async (filename, seen = new Set()) => {
            if (seen.has(filename) || seen.size >= 16) throw new Error('Circular theme include.');
            seen.add(filename);
            const data = await readJson(filename);
            if (!data.include) return data;
            const inherited = await loadTheme(path.posix.join(path.posix.dirname(filename), data.include), seen);
            return { ...inherited, ...data, colors: { ...inherited.colors, ...data.colors }, tokenColors: [...(inherited.tokenColors || []), ...(data.tokenColors || [])] };
          };
          themes.push({ extensionId: info.id, id: `${info.id}:${theme.id || theme.label}`, label: theme.label || theme.id, uiTheme: theme.uiTheme, data: await loadTheme(theme.path) });
        } catch (error) { errors.push({ id: info.id, message: error.message }); }
      }
      for (const snippet of manifest.contributes?.snippets || []) {
        try { snippets.push({ extensionId: info.id, language: snippet.language, data: await readJson(snippet.path) }); }
        catch (error) { errors.push({ id: info.id, message: error.message }); }
      }
    }
    let selectedTheme = null;
    try { selectedTheme = JSON.parse(await fs.readFile(path.join(this.root, '.preferences.json'), 'utf8')).theme || null; }
    catch (_) { /* Default editor theme until a user chooses an installed theme. */ }
    return { themes, snippets, errors, selectedTheme };
  }

  setTheme(themeId) {
    return this.serialize(async () => {
      if (themeId !== null && !(await this.contributions()).themes.some(theme => theme.id === themeId)) throw new Error('Theme is not installed.');
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(path.join(this.root, '.preferences.json'), JSON.stringify({ theme: themeId }));
    });
  }
}

module.exports = { ExtensionService, extensionId, platformTarget, extractVsix, extractZip, installationInfo };
