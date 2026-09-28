const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const https = require('https');
const projectRoot = require('./project-root');

function exec(command, args, cwd) {
  return new Promise((resolve) => execFile(command, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', code: error?.code });
  }));
}

function requestJson(url, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Orion-IDE/1.0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Marketplace responded with HTTP ${res.statusCode}.`));
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('Marketplace returned invalid JSON.')); }
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('Marketplace request timed out.')));
    req.on('error', error => reject(new Error(`Marketplace unavailable: ${error.message}`)));
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('Marketplace request cancelled.')), { once: true });
  });
}

function relative(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
async function walk(root, query, results, max = 300) {
  const ignored = new Set(['node_modules', '.git', 'dist', 'build']);
  async function visit(dir) {
    if (results.length >= max) return;
    let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (results.length >= max) return;
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) await visit(path.join(dir, entry.name)); continue; }
      if (!entry.isFile() || entry.size > 2 * 1024 * 1024) continue;
      const filePath = path.join(dir, entry.name);
      let content; try { content = await fs.promises.readFile(filePath, 'utf8'); } catch (_) { continue; }
      content.split(/\r?\n/).forEach((text, index) => {
        if (results.length < max && text.toLowerCase().includes(query)) results.push({ filePath, relativePath: relative(root, filePath), line: index + 1, text: text.trim().slice(0, 500) });
      });
    }
  }
  await visit(root); return results;
}

async function gitStatus() {
  const cwd = projectRoot.get();
  if (!cwd) return { available: false, reason: 'Open a folder to inspect source control.' };
  const root = await exec('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!root.ok) return { available: false, reason: 'The opened folder is not a Git repository.' };
  const repoRoot = root.stdout.trim();
  const branch = await exec('git', ['branch', '--show-current'], repoRoot);
  const status = await exec('git', ['status', '--porcelain=v1', '-uall'], repoRoot);
  const files = status.stdout.split(/\r?\n/).filter(Boolean).map(line => ({ x: line.slice(0, 1), y: line.slice(1, 2), path: line.slice(3), staged: line.slice(0, 1) !== ' ', status: line.slice(0, 2) }));
  return { available: true, repoRoot, branch: branch.stdout.trim() || 'HEAD', files };
}

async function gitAction(action, filePath, message) {
  const cwd = projectRoot.get(); if (!cwd) throw new Error('Open a folder first.');
  const args = action === 'stage' ? ['add', '--', filePath] : action === 'unstage' ? ['restore', '--staged', '--', filePath] : action === 'commit' ? ['commit', '-m', message] : null;
  if (!args) throw new Error('Unsupported source-control action.');
  const result = await exec('git', args, cwd);
  if (!result.ok) throw new Error((result.stderr || result.stdout || 'Git operation failed.').trim());
  return gitStatus();
}

function normalizeExtension(item) {
  const ns = item.namespace || item.publisher || '';
  const name = item.name || item.extensionName || '';
  return { id: item.namespace && item.name ? `${item.namespace}.${item.name}` : item.id || `${ns}.${name}`, name: item.displayName || name, publisher: ns, description: item.description || '', version: item.version || item.latestVersion || '', iconUrl: item.iconUrl || null, downloadCount: Number.isFinite(item.downloadCount) ? item.downloadCount : null, categories: item.categories || [], tags: item.tags || [], provider: 'open-vsx', compatible: false, compatibilityMessage: 'Open VSX publishes VS Code-format VSIX packages. Orion does not execute that API format, so installation is intentionally blocked.' };
}

async function marketplaceSearch(query, offset = 0, size = 30) {
  const params = new URLSearchParams({ query: String(query || ''), offset: String(offset), size: String(Math.min(Math.max(size, 1), 50)), sortBy: query ? 'relevance' : 'downloadCount' });
  const data = await requestJson(`https://open-vsx.org/api/-/search?${params}`);
  return { provider: 'Open VSX Registry', results: (data.extensions || []).map(normalizeExtension), offset, total: data.totalCount || 0 };
}

async function marketplaceDetails(identifier) {
  const [namespace, name] = String(identifier).split('.', 2);
  if (!namespace || !name) throw new Error('Invalid extension identifier.');
  const data = await requestJson(`https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`);
  return normalizeExtension({ ...data, namespace, name, displayName: data.displayName || name, version: data.version || data.latestVersion });
}

module.exports = { walk, gitStatus, gitAction, marketplaceSearch, marketplaceDetails };
