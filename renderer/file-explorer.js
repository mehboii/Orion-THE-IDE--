// Compact, Seti-inspired labels rather than copied icon assets.  Keeping this
// as data makes it easy to extend while leaving the tree data and IPC untouched.
const FILE_ICON_MAP = {
  js: { label: 'JS', color: 'yellow' }, jsx: { label: 'JS', color: 'yellow' }, mjs: { label: 'JS', color: 'yellow' }, cjs: { label: 'JS', color: 'yellow' },
  ts: { label: 'TS', color: 'blue' }, tsx: { label: 'TS', color: 'blue' },
  json: { label: '{}', color: 'yellow' }, jsonc: { label: '{}', color: 'yellow' },
  html: { label: '<>', color: 'orange' }, htm: { label: '<>', color: 'orange' }, xml: { label: '<>', color: 'orange' },
  css: { label: '#', color: 'blue' }, scss: { label: '#', color: 'pink' }, sass: { label: '#', color: 'pink' }, less: { label: '#', color: 'blue' },
  md: { label: 'M', color: 'blue' }, markdown: { label: 'M', color: 'blue' }, mdx: { label: 'M', color: 'blue' },
  py: { label: 'PY', color: 'blue' }, pyw: { label: 'PY', color: 'blue' },
  yml: { label: 'Y', color: 'red' }, yaml: { label: 'Y', color: 'red' },
  toml: { label: 'T', color: 'red' }, env: { label: 'E', color: 'green' },
  sh: { label: '$', color: 'green' }, bash: { label: '$', color: 'green' }, zsh: { label: '$', color: 'green' },
  sql: { label: 'SQL', color: 'pink' },
  png: { label: '\u25C8', color: 'purple' }, jpg: { label: '\u25C8', color: 'purple' }, jpeg: { label: '\u25C8', color: 'purple' }, gif: { label: '\u25C8', color: 'purple' }, svg: { label: '\u25C8', color: 'yellow' },
  lock: { label: '\u2022', color: 'muted' }, txt: { label: '\u2261', color: 'muted' },
};

class FileExplorer {
  constructor(containerEl, openFolderBtnEl) {
    this.containerEl = containerEl;
    this.openFolderBtnEl = openFolderBtnEl;
    this.currentRootDir = null;
    this.onFileSelectCallback = null;
    this.onRootChangeCallback = null;
    this.expandedDirs = new Set();
    this.selectedFilePath = null;
    this.gitRoot = null;
    this.gitStatuses = new Map();
    this.watchedRootDir = null;
    this.unsubscribeFileChanges = window.electronAPI.onFileChanged(({ filePath }) => {
      // The main process watches the open root. A rerender keeps the Explorer
      // in sync when terminal agents create, rename, or remove files there.
      if (this.watchedRootDir && filePath === this.watchedRootDir) this.render();
    });

    if (this.openFolderBtnEl) {
      this.openFolderBtnEl.addEventListener('click', () => this.handleOpenFolderClick());
    }
  }

  onFileSelect(fn) {
    this.onFileSelectCallback = fn;
  }

  onRootChange(fn) { this.onRootChangeCallback = fn; }

  setGitStatus(status) {
    this.gitRoot = status?.root || null;
    this.gitStatuses = new Map((status?.files || []).map((file) => [String(file.path).replace(/\\/g, '/'), file]));
    this.render();
  }

  gitStatusFor(filePath, isDirectory = false) {
    if (!this.gitRoot) return null;
    const root = this.gitRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const relative = String(filePath).replace(/\\/g, '/').slice(root.length + 1);
    if (!isDirectory) return this.gitStatuses.get(relative) || null;
    const matches = [...this.gitStatuses.entries()].filter(([candidate]) => candidate.startsWith(`${relative}/`)).map(([, item]) => item);
    if (!matches.length) return null;
    const priority = { conflict: 6, deleted: 5, modified: 4, renamed: 3, added: 2, untracked: 1 };
    return matches.sort((a, b) => (priority[b.kind] || 0) - (priority[a.kind] || 0))[0];
  }

  async handleOpenFolderClick() {
    const selected = await window.electronAPI.selectDirectory(this.currentRootDir || undefined);
    if (selected) {
      await this.setRootDirectory(selected, true);
    }
  }

  async setRootDirectory(dirPath, force = false, publishRootChange = true) {
    if (!dirPath) return;
    // The main process returns its canonical ProjectRoot; this tree is a view
    // of that exact value instead of maintaining a second root spelling.
    const canonicalRoot = publishRootChange ? (await this.onRootChangeCallback?.(dirPath) || dirPath) : dirPath;
    if (this.currentRootDir === canonicalRoot && !force) return;

    if (this.watchedRootDir && this.watchedRootDir !== canonicalRoot) {
      await window.electronAPI.unwatchFile(this.watchedRootDir);
      this.watchedRootDir = null;
    }
    this.currentRootDir = canonicalRoot;
    this.expandedDirs.clear();
    this.expandedDirs.add(canonicalRoot);
    if (this.watchedRootDir !== canonicalRoot) {
      const watching = await window.electronAPI.watchFile(canonicalRoot);
      if (watching) this.watchedRootDir = canonicalRoot;
    }
    await this.render();
  }

  async render() {
    if (!this.containerEl) return;
    this.containerEl.innerHTML = '';

    if (!this.currentRootDir) {
      this.containerEl.innerHTML = `
        <div class="file-tree-empty">
          <p>No folder opened. Choose <strong>Open Folder</strong> to view real files.</p>
          <button class="btn btn-secondary btn-sm" id="btn-tree-open-folder">Open Folder</button>
        </div>
      `;
      const btn = this.containerEl.querySelector('#btn-tree-open-folder');
      if (btn) btn.addEventListener('click', () => this.handleOpenFolderClick());
      return;
    }

    const header = document.createElement('div');
    header.className = 'file-tree-root-header tree-item folder';
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    header.setAttribute('aria-expanded', String(this.expandedDirs.has(this.currentRootDir)));
    const folderName = this.currentRootDir.split(/[/\\]/).pop() || this.currentRootDir;
    const rootGit = this.gitStatusFor(this.currentRootDir, true);
    header.innerHTML = `
      <span class="tree-chevron ${this.expandedDirs.has(this.currentRootDir) ? 'is-expanded' : ''}" aria-hidden="true"></span>
      <span class="file-icon folder-icon ${this.expandedDirs.has(this.currentRootDir) ? 'is-open' : ''}" aria-hidden="true"></span>
      <span class="file-tree-root-title ${rootGit ? `git-${rootGit.kind}` : ''}" title="${this.escapeHtml(this.currentRootDir)}"><strong>${this.escapeHtml(folderName)}</strong></span>${rootGit ? `<span class="git-status-badge git-${rootGit.kind}">${rootGit.badge}</span>` : ''}
    `;
    const toggleRoot = async () => {
      if (window.__IDE_TEST_MODE__) console.info('[FileExplorer] root-toggle', this.currentRootDir);
      if (this.expandedDirs.has(this.currentRootDir)) this.expandedDirs.delete(this.currentRootDir);
      else this.expandedDirs.add(this.currentRootDir);
      // Re-render on expansion so root uses the same fs:read-dir IPC route as
      // nested folders and fresh directory contents are always displayed.
      await this.render();
    };
    header.addEventListener('click', toggleRoot);
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleRoot(); }
    });
    this.containerEl.appendChild(header);

    const rootList = document.createElement('div');
    rootList.className = 'file-tree-list';
    this.containerEl.appendChild(rootList);

    if (this.expandedDirs.has(this.currentRootDir)) await this.populateDirNode(this.currentRootDir, rootList, 0);
  }

  async populateDirNode(dirPath, parentElement, depth) {
    const entries = await window.electronAPI.readDir(dirPath);
    if (window.__IDE_TEST_MODE__) console.info('[FileExplorer] read-dir', dirPath, Array.isArray(entries) ? entries.length : 'invalid');
    if (!entries || entries.length === 0) {
      if (depth > 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'tree-item empty';
        emptyEl.style.paddingLeft = `${depth * 14 + 16}px`;
        emptyEl.textContent = '(empty)';
        parentElement.appendChild(emptyEl);
      }
      return;
    }

    const sortedEntries = [...entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    for (const entry of sortedEntries) {
      const itemEl = document.createElement('div');
      const isExpanded = entry.isDirectory && this.expandedDirs.has(entry.path);
      itemEl.className = `tree-item ${entry.isDirectory ? 'folder' : 'file'}${this.selectedFilePath === entry.path ? ' selected' : ''}`;
      itemEl.style.paddingLeft = `${depth * 14 + 8}px`;

      const icon = entry.isDirectory ? null : this.getFileIcon(entry.name);
      const git = this.gitStatusFor(entry.path, entry.isDirectory);
      if (git) itemEl.classList.add(`git-${git.kind}`);

      itemEl.innerHTML = `
        ${entry.isDirectory
          ? `<span class="tree-chevron ${isExpanded ? 'is-expanded' : ''}" aria-hidden="true"></span><span class="file-icon folder-icon ${isExpanded ? 'is-open' : ''}" aria-hidden="true"></span>`
          : `<span class="file-icon file-icon-${icon.color}" aria-hidden="true">${this.escapeHtml(icon.label)}</span>`}
        <span class="tree-label" title="${this.escapeHtml(entry.path)}">${this.escapeHtml(entry.name)}</span>${git ? `<span class="git-status-badge git-${git.kind}" title="${this.escapeHtml(git.kind)}${git.staged && git.unstaged ? ' (staged and unstaged)' : ''}">${this.escapeHtml(git.badge)}</span>` : ''}
      `;

      parentElement.appendChild(itemEl);

      if (entry.isDirectory) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        if (!this.expandedDirs.has(entry.path)) {
          childContainer.style.display = 'none';
        }
        parentElement.appendChild(childContainer);

        itemEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.expandedDirs.has(entry.path)) {
            this.expandedDirs.delete(entry.path);
            childContainer.style.display = 'none';
            itemEl.querySelector('.tree-chevron').classList.remove('is-expanded');
            itemEl.querySelector('.folder-icon').classList.remove('is-open');
          } else {
            this.expandedDirs.add(entry.path);
            childContainer.style.display = 'block';
            itemEl.querySelector('.tree-chevron').classList.add('is-expanded');
            itemEl.querySelector('.folder-icon').classList.add('is-open');
            if (childContainer.children.length === 0) {
              await this.populateDirNode(entry.path, childContainer, depth + 1);
            }
          }
        });

        if (this.expandedDirs.has(entry.path)) {
          await this.populateDirNode(entry.path, childContainer, depth + 1);
        }
      } else {
        itemEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.selectedFilePath = entry.path;
          this.containerEl.querySelectorAll('.tree-item.file').forEach(el => el.classList.remove('selected'));
          itemEl.classList.add('selected');
          if (this.onFileSelectCallback) {
            this.onFileSelectCallback(entry.path);
          }
        });
      }
    }
  }

  getFileIcon(filename) {
    const normalizedName = filename.toLowerCase();
    if (normalizedName === '.gitignore') return { label: 'G', color: 'orange' };
    if (normalizedName === 'dockerfile') return { label: 'D', color: 'blue' };
    const ext = normalizedName.includes('.') ? normalizedName.split('.').pop() : '';
    return FILE_ICON_MAP[ext] || { label: '\u2022', color: 'muted' };
  }

  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileExplorer;
}
