class SidebarPanels {
  async renderSourceControlV2(status) {
    const panel = this.panel('source-control'); if (!panel) return;
    try {
      const git = status || await window.electronAPI.gitStatus();
      if (!git.available) { panel.innerHTML = '<div class="panel-pad"><p class="panel-muted">Open a Git repository to use Source Control.</p></div>'; return; }
      const staged = git.files.filter(f => f.staged && !f.conflict), changes = git.files.filter(f => f.unstaged && !f.conflict), conflicts = git.files.filter(f => f.conflict);
      const row = (f, section) => `<div class="scm-file git-${this.escape(f.kind)}"><button class="scm-open" data-open="${this.escape(f.path)}">${this.escape(f.path.split('/').pop())}</button><span class="scm-path">${this.escape(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '')}</span><span class="scm-status">${this.escape(f.badge)}</span><button class="icon-text-btn" data-diff="${this.escape(f.path)}" data-staged="${section === 'staged'}">Diff</button><button class="icon-text-btn" data-action="${section === 'staged' ? 'unstage' : 'stage'}" data-path="${this.escape(f.path)}">${section === 'staged' ? 'Unstage' : 'Stage'}</button>${section === 'changes' ? `<button class="icon-text-btn" data-discard="${this.escape(f.path)}">Discard</button>` : ''}</div>`;
      const section = (title, list, kind) => list.length ? `<h3 class="scm-section-title">${title} <span>${list.length}</span></h3>${list.map(f => row(f, kind)).join('')}` : '';
      const branch = git.branch?.detached ? 'DETACHED HEAD' : (git.branch?.head || 'HEAD');
      panel.innerHTML = `<div class="panel-pad"><div class="scm-head"><strong>${this.escape(branch)}</strong><span class="panel-muted">↑${git.branch?.ahead || 0} ↓${git.branch?.behind || 0}</span><button class="icon-text-btn" id="git-refresh">Refresh</button></div><div class="scm-toolbar"><button data-global="stage-all">Stage All</button><button data-global="unstage-all">Unstage All</button><button data-global="pull">Pull</button><button data-global="push">Push</button><button data-global="fetch">Fetch</button></div><textarea id="git-message" class="text-input scm-message" placeholder="Commit message"></textarea><div class="scm-toolbar"><button class="btn btn-primary" id="git-commit" ${staged.length ? '' : 'disabled'}>Commit</button><button class="btn btn-secondary" id="git-stage-commit" ${git.files.length ? '' : 'disabled'}>Stage All & Commit</button></div>${section('Merge Conflicts', conflicts, 'conflicts')}${section('Staged Changes', staged, 'staged')}${section('Changes', changes, 'changes')}${!git.files.length ? '<div class="panel-muted">Working tree clean.</div>' : ''}<pre class="git-diff-output hidden" id="git-diff-output"></pre></div>`;
      const refresh = async () => { const next = await window.electronAPI.gitStatus(); this.renderSourceControlV2(next); this.app.applyGitStatus?.(next); };
      panel.querySelector('#git-refresh').onclick = refresh;
      panel.querySelectorAll('[data-action]').forEach(btn => btn.onclick = async () => { await window.electronAPI.gitOperation({ action: btn.dataset.action, payload: { paths: [btn.dataset.path] } }); refresh(); });
      panel.querySelectorAll('[data-discard]').forEach(btn => btn.onclick = async () => { if (confirm(`Discard changes to ${btn.dataset.discard}?`)) { await window.electronAPI.gitOperation({ action: 'discard', payload: { paths: [btn.dataset.discard] } }); refresh(); } });
      panel.querySelectorAll('[data-open]').forEach(btn => btn.onclick = () => window.electronAPI.openEditorFile(`${git.root}/${btn.dataset.open}`));
      panel.querySelectorAll('[data-diff]').forEach(btn => btn.onclick = async () => { const out = panel.querySelector('#git-diff-output'); out.textContent = await window.electronAPI.gitDiff({ filePath: btn.dataset.diff, staged: btn.dataset.staged === 'true' }); out.classList.remove('hidden'); });
      panel.querySelectorAll('[data-global]').forEach(btn => btn.onclick = async () => { await window.electronAPI.gitOperation({ action: btn.dataset.global, payload: {} }); refresh(); });
      panel.querySelector('#git-commit').onclick = async () => { const message = panel.querySelector('#git-message').value.trim(); if (!message) return this.app.showBanner('Enter a commit message.', 'error'); await window.electronAPI.gitOperation({ action: 'commit', payload: { message } }); refresh(); };
      panel.querySelector('#git-stage-commit').onclick = async () => { const message = panel.querySelector('#git-message').value.trim(); if (!message) return this.app.showBanner('Enter a commit message.', 'error'); await window.electronAPI.gitOperation({ action: 'stage-all', payload: {} }); await window.electronAPI.gitOperation({ action: 'commit', payload: { message } }); refresh(); };
    } catch (error) { panel.innerHTML = `<div class="panel-pad"><p class="panel-muted">${this.escape(error.message)}</p></div>`; }
  }
  constructor(app) { this.app = app; this.searchTimer = null; this.marketTimer = null; this.marketRequest = 0; this.extensionQuery = ''; }
  escape(value) { const el = document.createElement('span'); el.textContent = String(value ?? ''); return el.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  panel(name) { return document.querySelector(`.sidebar-panel[data-panel="${name}"]`); }
  activate(name) {
    document.querySelectorAll('.sidebar-panel').forEach(el => el.classList.toggle('active', el.dataset.panel === name));
    const title = document.getElementById('side-bar-title'); if (title) title.textContent = ({ explorer: 'EXPLORER', search: 'SEARCH', 'source-control': 'SOURCE CONTROL', 'run-debug': 'RUN AND DEBUG', extensions: 'EXTENSIONS', settings: 'SETTINGS' })[name] || name.toUpperCase();
    if (name === 'search') this.renderSearch();
    if (name === 'source-control') this.renderSourceControlV2();
    if (name === 'run-debug') this.renderRunDebug();
    if (name === 'extensions') this.renderExtensions();
  }
  renderSearch() {
    const panel = this.panel('search'); if (!panel || panel.dataset.ready) return; panel.dataset.ready = 'true';
    panel.innerHTML = `<div class="panel-pad"><label class="sidebar-input-wrap">Search files<input id="workspace-search" class="text-input" autocomplete="off" placeholder="Search workspace"></label><div class="panel-muted" id="workspace-search-state">Enter text to search the opened folder.</div><div id="workspace-search-results" class="search-results"></div></div>`;
    const input = panel.querySelector('#workspace-search'); input.addEventListener('input', () => { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.runSearch(input.value), 220); });
  }
  async runSearch(query) {
    const panel = this.panel('search'); const state = panel.querySelector('#workspace-search-state'); const out = panel.querySelector('#workspace-search-results');
    if (!query.trim()) { state.textContent = 'Enter text to search the opened folder.'; out.innerHTML = ''; return; }
    state.textContent = 'Searching…'; out.innerHTML = '';
    try { const data = await window.electronAPI.searchWorkspace(query); state.textContent = data.reason || `${data.results.length} match${data.results.length === 1 ? '' : 'es'}`; out.innerHTML = data.results.map(r => `<button class="search-result" data-path="${this.escape(r.filePath)}" data-line="${r.line}"><strong>${this.escape(r.relativePath)}</strong><span>${r.line}: ${this.escape(r.text)}</span></button>`).join('') || '<div class="panel-muted">No matches found.</div>'; out.querySelectorAll('.search-result').forEach(el => el.addEventListener('click', () => window.electronAPI.openEditorFile(el.dataset.path))); } catch (error) { state.textContent = error.message; }
  }
  async renderSourceControl() {
    const panel = this.panel('source-control'); if (!panel) return; panel.innerHTML = '<div class="panel-pad"><div class="panel-muted">Loading repository status…</div></div>';
    try { const git = await window.electronAPI.gitStatus(); if (!git.available) { panel.innerHTML = '<div class="panel-pad"><p class="panel-muted">The opened folder is not a Git repository.</p></div>'; return; }
      panel.innerHTML = `<div class="panel-pad"><div class="scm-head"><strong>${this.escape(git.branch?.head || 'HEAD')}</strong><button class="icon-text-btn" id="git-refresh">Refresh</button></div><textarea id="git-message" class="text-input scm-message" placeholder="Commit message"></textarea><button class="btn btn-primary scm-commit" id="git-commit" ${git.files.length ? '' : 'disabled'}>Commit staged changes</button><div class="scm-files">${git.files.map(f => `<div class="scm-file"><span class="scm-status">${this.escape(f.badge || '')}</span><span title="${this.escape(f.path)}">${this.escape(f.path)}</span><button class="icon-text-btn" data-git-action="${f.staged ? 'unstage' : 'stage'}" data-path="${this.escape(f.path)}">${f.staged ? 'Unstage' : 'Stage'}</button></div>`).join('') || '<div class="panel-muted">No changes.</div>'}</div></div>`;
      panel.querySelector('#git-refresh').onclick = () => this.renderSourceControl(); panel.querySelectorAll('[data-git-action]').forEach(btn => btn.onclick = async () => { try { await window.electronAPI.gitOperation({ action: btn.dataset.gitAction, payload: { paths: [btn.dataset.path] } }); this.renderSourceControl(); } catch (e) { this.app.showBanner(e.message, 'error'); } }); panel.querySelector('#git-commit').onclick = async () => { const message = panel.querySelector('#git-message').value.trim(); if (!message) return this.app.showBanner('Enter a commit message.', 'error'); try { await window.electronAPI.gitOperation({ action: 'commit', payload: { message } }); this.renderSourceControl(); } catch (e) { this.app.showBanner(e.message, 'error'); } };
    } catch (error) { panel.innerHTML = `<div class="panel-pad"><p class="panel-muted">${this.escape(error.message)}</p></div>`; }
  }
  renderRunDebug() { const panel = this.panel('run-debug'); if (!panel) return; const panes = [...this.app.panes.values()]; panel.innerHTML = `<div class="panel-pad"><p class="panel-muted">Run configurations use Orion's real terminal sessions. Node files can be debugged from the detached editor.</p><button class="btn btn-primary" id="run-new-pane">New terminal session</button><div class="run-list">${panes.map(p => `<div class="run-item"><strong>${this.escape(p.label)}</strong><span>${this.escape(p.status || 'running')} · ${this.escape(p.cwd || '')}</span><button class="icon-text-btn" data-pane="${p.id}">Focus</button></div>`).join('') || '<div class="panel-muted">No active terminal sessions.</div>'}</div></div>`; panel.querySelector('#run-new-pane').onclick = () => this.app.createPane({}); panel.querySelectorAll('[data-pane]').forEach(btn => btn.onclick = () => this.app.focusPane(Number(btn.dataset.pane))); }
  renderExtensions() {
    const panel = this.panel('extensions'); if (!panel || panel.dataset.ready) return; panel.dataset.ready = 'true';
    panel.innerHTML = `<div class="panel-pad extension-panel"><div class="extension-search"><input id="marketplace-search" class="text-input" placeholder="Search Open VSX extensions" autocomplete="off"><button id="marketplace-clear" class="icon-text-btn">Clear</button></div><button id="marketplace-installed" class="icon-text-btn">Installed extensions</button><div id="marketplace-state" class="panel-muted">Popular extensions from Open VSX</div><div id="marketplace-results" class="extension-results"></div><p class="marketplace-notice">Install any extension category from Open VSX. Orion supports color themes and snippets. Executable extension features require a VS Code-compatible extension host, which is not available yet.</p></div>`;
    const input = panel.querySelector('#marketplace-search');
    input.value = this.extensionQuery;
    input.addEventListener('input', () => { this.extensionQuery = input.value; clearTimeout(this.marketTimer); this.marketTimer = setTimeout(() => this.loadExtensions(input.value), 280); });
    panel.querySelector('#marketplace-clear').onclick = () => { clearTimeout(this.marketTimer); input.value = ''; this.extensionQuery = ''; this.loadExtensions(''); };
    panel.querySelector('#marketplace-installed').onclick = () => { clearTimeout(this.marketTimer); this.loadExtensions('', true); };
    this.loadExtensions(this.extensionQuery);
  }
  async loadExtensions(query, installedOnly = false) {
    const panel = this.panel('extensions'); if (!panel) return;
    const state = panel.querySelector('#marketplace-state'); const results = panel.querySelector('#marketplace-results'); if (!state || !results) return;
    const request = ++this.marketRequest; state.textContent = 'Loading extensions…'; results.innerHTML = '';
    try {
      const data = installedOnly ? { results: await window.electronAPI.listExtensions(), provider: 'Installed in Orion' } : await window.electronAPI.searchMarketplace(query);
      if (request !== this.marketRequest || !state.isConnected) return;
      const count = data.total ?? data.results.length;
      state.textContent = `${count} result${count === 1 ? '' : 's'} · ${data.provider}`;
      results.innerHTML = data.results.map(x => `<button class="extension-card" data-id="${this.escape(x.id)}"><span class="extension-avatar">${this.escape((x.name || '?').slice(0, 1).toUpperCase())}</span><span><strong>${this.escape(x.name)}</strong><small>${this.escape(x.publisher)} · ${this.escape(x.version || 'version unavailable')}${x.installed ? ' · Installed' : ''}</small><em>${this.escape(x.description)}</em></span></button>`).join('') || '<div class="panel-muted">No extensions found.</div>';
      results.querySelectorAll('.extension-card').forEach(btn => btn.onclick = () => this.showExtensionDetails(btn.dataset.id));
    } catch (error) { if (request === this.marketRequest && state.isConnected) state.textContent = error.message; }
  }
  async showExtensionDetails(id) {
    const panel = this.panel('extensions'); if (!panel) return;
    clearTimeout(this.marketTimer);
    const request = ++this.marketRequest;
    const back = () => { ++this.marketRequest; panel.dataset.ready = ''; this.renderExtensions(); };
    panel.innerHTML = '<div class="panel-pad"><div class="panel-muted">Loading extension…</div></div>';
    try {
      const x = await window.electronAPI.getMarketplaceDetails(id);
      if (request !== this.marketRequest) return;
      const update = x.installed && x.installedVersion !== x.version;
      panel.innerHTML = `<div class="panel-pad extension-detail"><button class="icon-text-btn" id="extension-back">← Back to results</button><h2>${this.escape(x.name)}</h2><p class="panel-muted">${this.escape(x.publisher)} · ${this.escape(x.version || 'version unavailable')}${x.installed ? ` · Installed ${this.escape(x.installedVersion)}` : ''}</p><p>${this.escape(x.description)}</p><div class="compatibility-warning">${this.escape(x.runtimeMessage || x.compatibilityMessage)}</div>${!x.installed || update ? `<button id="extension-install" class="btn btn-primary">${update ? 'Update' : 'Install'}</button>` : ''}${x.installed ? '<button id="extension-uninstall" class="btn btn-secondary">Uninstall</button>' : ''}<div id="extension-theme-actions"></div><p id="extension-operation-state" class="panel-muted" role="status"></p></div>`;
      panel.querySelector('#extension-back').onclick = back;
      if (x.installed) {
        const launchActions = x.launchActions || [];
        const container = document.createElement('div');
        container.innerHTML = launchActions.map((action, index) => `<button class="btn btn-primary" data-extension-launch="${index}">${this.escape(action.label)}</button>`).join('');
        panel.querySelector('#extension-theme-actions').before(container);
        container.querySelectorAll('[data-extension-launch]').forEach(button => button.onclick = async () => {
          const state = panel.querySelector('#extension-operation-state');
          button.disabled = true;
          state.textContent = 'Starting extension in a terminal...';
          try {
            const options = await window.electronAPI.getExtensionLaunchInfo(id, launchActions[Number(button.dataset.extensionLaunch)].id);
            const pane = await this.app.createPane(options);
            if (!pane || pane.status === 'exited') throw new Error('Unable to start the extension. Check the terminal, or close a pane if all terminal slots are occupied.');
            if (request === this.marketRequest) state.textContent = 'Started in a terminal. Follow its setup or sign-in instructions there.';
          } catch (error) { if (request === this.marketRequest) state.textContent = error.message; }
          finally { button.disabled = false; }
        });
      }
      const operate = async action => {
        const state = panel.querySelector('#extension-operation-state');
        const buttons = [...panel.querySelectorAll('#extension-install, #extension-uninstall, [data-extension-launch]')];
        buttons.forEach(button => button.disabled = true);
        state.textContent = action === 'install' ? 'Downloading and installing extension and dependencies…' : 'Uninstalling extension…';
        try {
          if (action === 'install') await window.electronAPI.installExtension(id);
          else await window.electronAPI.uninstallExtension(id);
          if (request === this.marketRequest) await this.showExtensionDetails(id);
        } catch (error) {
          if (request === this.marketRequest) { state.textContent = error.message; buttons.forEach(button => button.disabled = false); }
        }
      };
      const install = panel.querySelector('#extension-install'), uninstall = panel.querySelector('#extension-uninstall');
      if (install) install.onclick = () => operate('install');
      if (uninstall) uninstall.onclick = () => operate('uninstall');
      if (x.installed) {
        const contributions = await window.electronAPI.getExtensionContributions();
        if (request !== this.marketRequest) return;
        const themes = contributions.themes.filter(theme => theme.extensionId === id.toLowerCase());
        const actions = panel.querySelector('#extension-theme-actions');
        actions.innerHTML = themes.map((theme, index) => `<button class="icon-text-btn" data-theme-index="${index}">Use ${this.escape(theme.label || 'color theme')}</button>`).join('') + (themes.length ? '<button class="icon-text-btn" id="extension-theme-reset">Use default editor theme</button>' : '');
        const selectTheme = async themeId => {
          try { await window.electronAPI.setExtensionTheme(themeId); if (request === this.marketRequest) panel.querySelector('#extension-operation-state').textContent = 'Editor theme updated.'; }
          catch (error) { if (request === this.marketRequest) panel.querySelector('#extension-operation-state').textContent = error.message; }
        };
        actions.querySelectorAll('[data-theme-index]').forEach(button => button.onclick = () => selectTheme(themes[Number(button.dataset.themeIndex)].id));
        const reset = actions.querySelector('#extension-theme-reset'); if (reset) reset.onclick = () => selectTheme(null);
      }
    } catch (error) {
      if (request !== this.marketRequest) return;
      panel.innerHTML = `<div class="panel-pad"><button class="icon-text-btn" id="extension-back">← Back</button><p class="panel-muted">${this.escape(error.message)}</p></div>`;
      panel.querySelector('#extension-back').onclick = back;
    }
  }
}
