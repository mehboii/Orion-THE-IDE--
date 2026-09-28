const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Git is deliberately kept in the main process.  Renderers only ever receive
// parsed repository state and ask for named operations; they cannot construct
// arbitrary shell commands.
class GitService {
  constructor() {
    this.repositories = new Map();
  }

  async run(cwd, args) {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (error) {
      const message = error.stderr || error.stdout || error.message || 'Git command failed';
      const failure = new Error(String(message).trim());
      failure.code = error.code;
      throw failure;
    }
  }

  async repositoryFor(cwd) {
    if (!cwd) return null;
    try {
      const { stdout } = await this.run(cwd, ['rev-parse', '--show-toplevel']);
      return path.resolve(stdout.trim());
    } catch (_) {
      return null;
    }
  }

  // Parse porcelain v2 -z.  It preserves the independent index/worktree
  // columns and rename origin, unlike short status output.
  parseStatus(raw) {
    const records = raw.split('\0');
    const files = [];
    let branch = { head: null, upstream: null, ahead: 0, behind: 0, detached: false };
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record) continue;
      if (record.startsWith('# branch.head ')) {
        branch.head = record.slice(14);
        branch.detached = branch.head === '(detached)';
      } else if (record.startsWith('# branch.upstream ')) {
        branch.upstream = record.slice(18);
      } else if (record.startsWith('# branch.ab ')) {
        const parts = record.slice(12).split(' ');
        branch.ahead = Number(parts[0]?.slice(1) || 0);
        branch.behind = Number(parts[1]?.slice(1) || 0);
      } else if (record[0] === '1') {
        const fields = record.split(' ');
        const xy = fields[1] || '..';
        const filePath = fields.slice(8).join(' ');
        files.push(this.fileFromStatus(filePath, xy[0], xy[1]));
      } else if (record[0] === '2') {
        const fields = record.split(' ');
        const filePath = fields.slice(9).join(' ');
        const originalPath = records[++i] || null;
        const xy = fields[1] || '..';
        files.push(this.fileFromStatus(filePath, xy[0], xy[1], originalPath));
      } else if (record[0] === 'u') {
        const fields = record.split(' ');
        const filePath = fields.slice(10).join(' ');
        const xy = fields[1] || 'UU';
        files.push(this.fileFromStatus(filePath, xy[0], xy[1], null, true));
      } else if (record[0] === '?') {
        files.push(this.fileFromStatus(record.slice(2), '?', '.'));
      }
    }
    return { branch, files };
  }

  fileFromStatus(filePath, indexStatus, workTreeStatus, originalPath = null, conflict = false) {
    const statusFor = (value) => ({ M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', '?': 'untracked' }[value] || null);
    const indexKind = statusFor(indexStatus);
    const workTreeKind = statusFor(workTreeStatus);
    const kind = conflict ? 'conflict' : (workTreeKind || indexKind || 'modified');
    return {
      path: filePath,
      originalPath,
      indexStatus: indexStatus === '.' ? null : indexStatus,
      workTreeStatus: workTreeStatus === '.' ? null : workTreeStatus,
      staged: Boolean(indexKind && !conflict),
      unstaged: Boolean(workTreeKind || workTreeStatus === '?'),
      conflict,
      kind,
      // A file can have two badges conceptually; this is the primary one used
      // in compact places, while both columns remain available to the UI.
      badge: conflict ? 'C' : ((indexStatus === '?' || workTreeStatus === '?') ? 'U' : (workTreeStatus !== '.' ? workTreeStatus : indexStatus)),
    };
  }

  async status(cwd) {
    const root = await this.repositoryFor(cwd);
    if (!root) return { available: false, root: null, branch: null, files: [] };
    const { stdout } = await this.run(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal']);
    const model = this.parseStatus(stdout);
    return { available: true, root, ...model };
  }

  async operation(cwd, action, payload = {}) {
    const root = await this.repositoryFor(cwd);
    if (!root) throw new Error('The opened folder is not a Git repository.');
    const paths = Array.isArray(payload.paths) ? payload.paths : [];
    const pathArgs = paths.length ? ['--', ...paths] : [];
    switch (action) {
      case 'stage': await this.run(root, ['add', ...pathArgs]); break;
      case 'unstage': await this.run(root, ['restore', '--staged', ...pathArgs]); break;
      case 'stage-all': await this.run(root, ['add', '-A']); break;
      case 'unstage-all': await this.run(root, ['restore', '--staged', '.']); break;
      case 'discard': await this.run(root, ['restore', '--worktree', ...pathArgs]); break;
      case 'commit':
        if (!String(payload.message || '').trim()) throw new Error('A commit message is required.');
        await this.run(root, ['commit', '-m', String(payload.message).trim()]); break;
      case 'push': await this.run(root, ['push']); break;
      case 'pull': await this.run(root, ['pull', '--ff-only']); break;
      case 'fetch': await this.run(root, ['fetch']); break;
      case 'ignore':
        if (paths.length !== 1) throw new Error('Choose one file to ignore.');
        await fs.promises.appendFile(path.join(root, '.gitignore'), `${paths[0]}\n`); break;
      default: throw new Error(`Unsupported Git operation: ${action}`);
    }
    return this.status(root);
  }

  async diff(cwd, filePath, staged = false) {
    const root = await this.repositoryFor(cwd);
    if (!root) throw new Error('The opened folder is not a Git repository.');
    const { stdout } = await this.run(root, ['diff', ...(staged ? ['--cached'] : []), '--', filePath]);
    return stdout;
  }

  watch(cwd, callback) {
    let closed = false;
    let timer = null;
    let watcher = null;
    const notify = () => {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => callback(), 220);
    };
    this.repositoryFor(cwd).then((root) => {
      if (!root || closed) return;
      // Watch the repository root so external editor and terminal changes are
      // noticed; ignore noisy node_modules/.git internals in the callback.
      try { watcher = fs.watch(root, { recursive: true }, (_event, name) => {
        const value = String(name || '');
        if (!value.includes('node_modules')) notify();
      }); watcher.on('error', () => {}); } catch (_) {}
      notify();
    });
    return () => { closed = true; clearTimeout(timer); try { watcher?.close(); } catch (_) {} };
  }
}

module.exports = new GitService();
