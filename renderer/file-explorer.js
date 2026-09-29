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
    this.directoryGitStatuses = new Map();
    this.watchedRootDir = null;
    this._rendering = null;
    this._refreshQueued = false;
    this._pendingDirectories = new Set();
    this.unsubscribeFileChanges = window.electronAPI.onFileChanged(({ filePath, eventType }) => {
      // This watcher is only for structural changes. Git decorations are
      // patched in place below, so terminal output never rebuilds the tree.
      if (this.watchedRootDir && eventType !== 'change' && this.isWithinRoot(filePath)) {
        this.queueRefresh(this.parentDirectoryForChange(filePath));
      }
    });
    window.addEventListener('beforeunload', () => this.dispose(), { once: true });

    if (this.openFolderBtnEl) {
      this.openFolderBtnEl.addEventListener('click', () => this.handleOpenFolderClick());
    }
  }

  onFileSelect(fn) {
    this.onFileSelectCallback = fn;
  }

  onRootChange(fn) { this.onRootChangeCallback = fn; }

  setGitStatus(status) {
    const nextRoot = status?.root || null;
    const nextStatuses = new Map((status?.files || []).map((file) => [String(file.path).replace(/\\/g, '/'), file]));
    if (nextRoot === this.gitRoot && this.sameGitStatuses(nextStatuses)) return;
    const rootChanged = nextRoot !== this.gitRoot;
    const previousFiles = this.gitStatuses;
    const previousDirectories = this.directoryGitStatuses;
    this.gitRoot = nextRoot;
    this.gitStatuses = nextStatuses;
    this.directoryGitStatuses = this.buildDirectoryGitStatuses(nextRoot, nextStatuses);
    const changed = new Set();
    for (const key of new Set([...previousFiles.keys(), ...nextStatuses.keys()])) {
      if (!this.sameGitStatus(previousFiles.get(key), nextStatuses.get(key))) changed.add(key);
    }
    for (const key of new Set([...previousDirectories.keys(), ...this.directoryGitStatuses.keys()])) {
      if (!this.sameGitStatus(previousDirectories.get(key), this.directoryGitStatuses.get(key))) changed.add(key);
    }
    // Repository changes invalidate relative keys; otherwise patch only the
    // file and ancestor folders whose decoration actually changed.
    this.updateGitDecorations(rootChanged ? null : changed);
  }

  sameGitStatus(a, b) {
    return a === b || (!!a && !!b && a.kind === b.kind && a.badge === b.badge && a.staged === b.staged && a.unstaged === b.unstaged);
  }

  sameGitStatuses(nextStatuses) {
    if (nextStatuses.size !== this.gitStatuses.size) return false;
    for (const [filePath, status] of nextStatuses) {
      const current = this.gitStatuses.get(filePath);
      if (!this.sameGitStatus(current, status)) return false;
    }
    return true;
  }

  gitStatusFor(filePath, isDirectory = false) {
    if (!this.gitRoot) return null;
    const relative = this.gitRelativePath(filePath);
    if (!isDirectory) return this.gitStatuses.get(relative) || null;
    return this.directoryGitStatuses.get(relative) || null;
  }

  gitRelativePath(filePath) {
    if (!this.gitRoot) return '';
    const root = this.gitRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const value = String(filePath).replace(/\\/g, '/');
    return value === root ? '' : value.slice(root.length + 1);
  }

  buildDirectoryGitStatuses(root, statuses) {
    const directories = new Map();
    if (!root) return directories;
    const priority = { conflict: 6, deleted: 5, modified: 4, renamed: 3, added: 2, untracked: 1 };
    for (const [filePath, status] of statuses) {
      let directory = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
      while (true) {
        const current = directories.get(directory);
        if (!current || (priority[status.kind] || 0) > (priority[current.kind] || 0)) directories.set(directory, status);
        if (!directory) break;
        directory = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '';
      }
    }
    return directories;
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

  isWithinRoot(filePath) {
    const root = String(this.watchedRootDir).replace(/\\/g, '/').replace(/\/$/, '');
    const candidate = String(filePath || '').replace(/\\/g, '/');
    return candidate === root || candidate.startsWith(`${root}/`);
  }

  parentDirectoryForChange(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    const root = String(this.currentRootDir).replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === root) return this.currentRootDir;
    return normalized.slice(0, normalized.lastIndexOf('/')) || this.currentRootDir;
  }

  queueRefresh(directory = this.currentRootDir) {
    if (directory) this._pendingDirectories.add(directory);
    if (this._refreshQueued) return;
    this._refreshQueued = true;
    Promise.resolve().then(async () => {
      this._refreshQueued = false;
      const directories = [...this._pendingDirectories];
      this._pendingDirectories.clear();
      for (const changedDirectory of directories) await this.refreshDirectory(changedDirectory);
    }).catch((error) => console.error('Explorer refresh failed:', error));
  }

  childContainerFor(dirPath) {
    if (dirPath === this.currentRootDir) return this.containerEl.querySelector('.file-tree-list');
    return [...this.containerEl.querySelectorAll('[data-explorer-children-for]')]
      .find((element) => element.dataset.explorerChildrenFor === dirPath) || null;
  }

  async refreshDirectory(dirPath) {
    if (!this.currentRootDir || !this.isWithinRoot(dirPath)) return;
    const container = this.childContainerFor(dirPath);
    // A collapsed directory has no visible structure to reconcile. Its next
    // expansion reads current entries, with no work or layout shift now.
    if (!container) return;
    const scroll = this.scrollState();
    const depth = Number(container.dataset.explorerDepth || 0);
    await this.populateDirNode(dirPath, container, depth, true);
    if (scroll) {
      scroll.element.scrollTop = scroll.top;
      scroll.element.scrollLeft = scroll.left;
    }
  }

  scrollState() {
    const scrollParent = this.containerEl;
    return scrollParent ? { element: scrollParent, top: scrollParent.scrollTop, left: scrollParent.scrollLeft } : null;
  }

  async render() {
    if (!this.containerEl) return;
    if (this._rendering) {
      this._refreshQueued = true;
      return this._rendering;
    }
    const scroll = this.scrollState();
    this._rendering = this.renderTree().finally(() => {
      if (scroll) {
        scroll.element.scrollTop = scroll.top;
        scroll.element.scrollLeft = scroll.left;
      }
      this._rendering = null;
      if (this._refreshQueued) {
        this._refreshQueued = false;
        this.queueRefresh();
      }
    });
    return this._rendering;
  }

  async renderTree() {
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
    header.dataset.explorerPath = this.currentRootDir;
    header.dataset.explorerDirectory = 'true';
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

    rootList.dataset.explorerDepth = '0';
    if (this.expandedDirs.has(this.currentRootDir)) await this.populateDirNode(this.currentRootDir, rootList, 0);
  }

  async populateDirNode(dirPath, parentElement, depth, replace = false) {
    const entries = await window.electronAPI.readDir(dirPath);
    // Preserve complete, unchanged entry subtrees. Besides avoiding needless
    // work for large directories, this keeps DOM identity, focus and nested
    // expansion state intact when a sibling is created, deleted or renamed.
    const reusable = new Map();
    if (replace) {
      const children = [...parentElement.children];
      for (let index = 0; index < children.length; index += 1) {
        const item = children[index];
        const entryPath = item.dataset?.explorerPath;
        if (!entryPath) continue;
        const treeChildren = item.dataset.explorerDirectory === 'true' ? children[index + 1] : null;
        reusable.set(entryPath, { item, treeChildren });
      }
      parentElement.replaceChildren();
    }
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
      const preserved = reusable.get(entry.path);
      if (preserved) {
        parentElement.appendChild(preserved.item);
        if (preserved.treeChildren?.dataset.explorerChildrenFor === entry.path) parentElement.appendChild(preserved.treeChildren);
        continue;
      }
      const itemEl = document.createElement('div');
      itemEl.dataset.explorerPath = entry.path;
      itemEl.dataset.explorerDirectory = String(entry.isDirectory);
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
        childContainer.dataset.explorerChildrenFor = entry.path;
        childContainer.dataset.explorerDepth = String(depth + 1);
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

  updateGitDecorations(changedPaths = null) {
    if (!this.containerEl) return;
    this.containerEl.querySelectorAll('[data-explorer-path]').forEach((itemEl) => {
      const filePath = itemEl.dataset.explorerPath;
      const isDirectory = itemEl.dataset.explorerDirectory === 'true';
      const key = this.gitRelativePath(filePath);
      if (changedPaths && !changedPaths.has(key)) return;
      const git = this.gitStatusFor(filePath, isDirectory);
      ['conflict', 'deleted', 'modified', 'renamed', 'added', 'untracked'].forEach((kind) => itemEl.classList.remove(`git-${kind}`));
      if (git) itemEl.classList.add(`git-${git.kind}`);

      const label = itemEl.classList.contains('file-tree-root-header')
        ? itemEl.querySelector('.file-tree-root-title')
        : itemEl;
      if (label) ['conflict', 'deleted', 'modified', 'renamed', 'added', 'untracked'].forEach((kind) => label.classList.remove(`git-${kind}`));
      if (git && label) label.classList.add(`git-${git.kind}`);

      let badge = itemEl.querySelector(':scope > .git-status-badge');
      if (!git) {
        badge?.remove();
      } else if (badge) {
        badge.className = `git-status-badge git-${git.kind}`;
        badge.title = `${git.kind}${git.staged && git.unstaged ? ' (staged and unstaged)' : ''}`;
        badge.textContent = git.badge;
      } else {
        badge = document.createElement('span');
        badge.className = `git-status-badge git-${git.kind}`;
        badge.title = `${git.kind}${git.staged && git.unstaged ? ' (staged and unstaged)' : ''}`;
        badge.textContent = git.badge;
        itemEl.appendChild(badge);
      }
    });
  }

  dispose() {
    this.unsubscribeFileChanges?.();
    this.unsubscribeFileChanges = null;
    if (this.watchedRootDir) window.electronAPI.unwatchFile(this.watchedRootDir);
    this.watchedRootDir = null;
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
