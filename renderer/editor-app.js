class EditorApp {
  constructor() {
    this.manager = new CodeEditorManager(
      document.getElementById('monaco-editor-container'),
      document.getElementById('code-editor-tabs')
    );
    this.rootLabel = document.getElementById('editor-root-label');
    this.rootDirectory = null;
    this.currentRunId = null;
    this.pendingRunLaunches = 0;
    this.earlyRunEvents = new Map();

    // DOM Elements
    this.btnSave = document.getElementById('btn-editor-save');
    this.btnRun = document.getElementById('btn-editor-run');
    this.btnRunChevron = document.getElementById('btn-editor-run-chevron');
    this.runDropdownMenu = document.getElementById('run-dropdown-menu');
    this.btnMenuRun = document.getElementById('menu-opt-run');
    this.btnMenuRunNoDebug = document.getElementById('menu-opt-run-no-debug');
    this.btnMenuDebug = document.getElementById('menu-opt-debug');
    this.btnStop = document.getElementById('btn-editor-stop');

    this.runOutputPanel = document.getElementById('run-output-panel');
    this.runOutputTitle = document.getElementById('run-output-title');
    this.runOutputStatus = document.getElementById('run-output-status');
    this.runOutputContent = document.getElementById('run-output-content');
    this.btnClearOutput = document.getElementById('btn-clear-output');
    this.btnCloseOutput = document.getElementById('btn-close-output');

    this.debugToolbarControls = document.getElementById('debug-toolbar-controls');
    this.btnDebugContinue = document.getElementById('btn-debug-continue');
    this.btnDebugStepOver = document.getElementById('btn-debug-step-over');
    this.btnDebugStepInto = document.getElementById('btn-debug-step-into');
    this.btnDebugStepOut = document.getElementById('btn-debug-step-out');
    this.debugVariablesPanel = document.getElementById('debug-variables-panel');
    this.debugVariablesList = document.getElementById('debug-variables-list');
    this.editorMenuDropdown = document.getElementById('editor-menu-dropdown');
    this.editorCommandPalette = document.getElementById('editor-command-palette');
    this.editorCommandInput = document.getElementById('editor-command-input');
    this.editorCommandList = document.getElementById('editor-command-list');
    this.editorCommandIndex = 0;
    this.editorCommandResults = [];

    this.initListeners();
    this.setupCommandCenter();
    this.initProjectRoot();
  }

  async initProjectRoot() {
    if (window.electronAPI && window.electronAPI.getProjectRoot) {
      const pr = await window.electronAPI.getProjectRoot();
      if (pr) {
        this.rootDirectory = pr;
        this.rootLabel.textContent = pr;
        await this.startGitTracking(pr);
      }
    }
  }

  initListeners() {
    window.electronAPI.onEditorOpenFile((filePath) => this.openFile(filePath));

    // Save button
    if (this.btnSave) {
      this.btnSave.addEventListener('click', () => this.save());
    }

    // Run buttons & dropdown
    if (this.btnRun) {
      this.btnRun.addEventListener('click', () => this.executeRun('run'));
    }
    if (this.btnRunChevron) {
      this.btnRunChevron.addEventListener('click', (e) => {
        e.stopPropagation();
        this.runDropdownMenu.classList.toggle('hidden');
      });
    }

    document.addEventListener('click', (e) => {
      if (this.runDropdownMenu && !this.runDropdownMenu.contains(e.target) && e.target !== this.btnRunChevron) {
        this.runDropdownMenu.classList.add('hidden');
      }
    });

    if (this.btnMenuRun) {
      this.btnMenuRun.addEventListener('click', () => {
        this.runDropdownMenu.classList.add('hidden');
        this.executeRun('run');
      });
    }
    if (this.btnMenuRunNoDebug) {
      this.btnMenuRunNoDebug.addEventListener('click', () => {
        this.runDropdownMenu.classList.add('hidden');
        this.executeRun('run-without-debug');
      });
    }
    if (this.btnMenuDebug) {
      this.btnMenuDebug.addEventListener('click', () => {
        this.runDropdownMenu.classList.add('hidden');
        this.executeRun('debug');
      });
    }

    if (this.btnStop) {
      this.btnStop.addEventListener('click', () => this.stopCurrentRun());
    }

    if (this.btnClearOutput) {
      this.btnClearOutput.addEventListener('click', () => {
        if (this.runOutputContent) this.runOutputContent.textContent = '';
      });
    }
    if (this.btnCloseOutput) {
      this.btnCloseOutput.addEventListener('click', () => {
        if (this.runOutputPanel) this.runOutputPanel.classList.add('hidden');
      });
    }

    // Keyboard Shortcuts (F5 for Debug, Ctrl+F5 / Cmd+F5 for Run Without Debugging)
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault(); this.openCommandCenter(); return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.executeRun('run-without-debug');
        } else {
          this.executeRun('debug');
        }
      }
    });

    // Debug Step Control Buttons
    if (this.btnDebugContinue) this.btnDebugContinue.addEventListener('click', () => this.sendDebugCmd('resume'));
    if (this.btnDebugStepOver) this.btnDebugStepOver.addEventListener('click', () => this.sendDebugCmd('stepOver'));
    if (this.btnDebugStepInto) this.btnDebugStepInto.addEventListener('click', () => this.sendDebugCmd('stepInto'));
    if (this.btnDebugStepOut) this.btnDebugStepOut.addEventListener('click', () => this.sendDebugCmd('stepOut'));

    // Runner IPC Listeners
    if (window.electronAPI.onRunnerData) {
      window.electronAPI.onRunnerData((data) => this.routeRunEvent('data', data));
    }

    if (window.electronAPI.onRunnerExit) {
      window.electronAPI.onRunnerExit((data) => this.routeRunEvent('exit', data));
    }

    if (window.electronAPI.onDebugPaused) {
      window.electronAPI.onDebugPaused((data) => this.routeRunEvent('paused', data));
    }

    if (window.electronAPI.onDebugResumed) {
      window.electronAPI.onDebugResumed((data) => this.routeRunEvent('resumed', data));
    }
  }

  async startGitTracking(root) {
    if (!window.electronAPI.gitStatus) return;
    const apply = (status) => this.manager.setGitStatus(status?.root, status?.files);
    apply(await window.electronAPI.gitStatus(root));
    window.electronAPI.watchGit(root);
    if (!this.gitListener) this.gitListener = window.electronAPI.onGitStatusChanged(apply);
  }

  routeRunEvent(type, data) {
    if (data.runId === this.currentRunId) {
      this.applyRunEvent(type, data);
    } else if (this.pendingRunLaunches > 0) {
      if (!this.earlyRunEvents.has(data.runId)) this.earlyRunEvents.set(data.runId, []);
      this.earlyRunEvents.get(data.runId).push({ type, data });
    }
  }

  applyRunEvent(type, data) {
    if (type === 'data' && this.runOutputContent) {
      this.runOutputContent.textContent += data.text;
      this.runOutputContent.scrollTop = this.runOutputContent.scrollHeight;
    } else if (type === 'exit') {
      this.runOutputStatus.textContent = `[Exited with code ${data.exitCode}]`;
      this.btnStop.classList.add('hidden');
      this.debugToolbarControls.classList.add('hidden');
      this.debugVariablesPanel.classList.add('hidden');
      this.manager.clearPausedLine();
      this.currentRunId = null;
    } else if (type === 'paused') {
      this.runOutputStatus.textContent = `[Paused on line ${data.lineNumber}]`;
      this.debugToolbarControls.classList.remove('hidden');
      this.debugVariablesPanel.classList.remove('hidden');
      if (this.manager.activeFilePath) this.manager.highlightPausedLine(this.manager.activeFilePath, data.lineNumber);
      this.renderVariables(data.variables || []);
    } else if (type === 'resumed') {
      this.runOutputStatus.textContent = '[Running\u2026]';
      this.manager.clearPausedLine();
    }
  }

  replayEarlyRunEvents(runId) {
    const events = this.earlyRunEvents.get(runId) || [];
    this.earlyRunEvents.delete(runId);
    for (const event of events) this.applyRunEvent(event.type, event.data);
  }

  async openFile(filePath) {
    await this.manager.openFile(filePath);
    const root = await window.electronAPI.getProjectRoot?.();
    if (root) {
      this.rootDirectory = root;
      this.rootLabel.textContent = root;
    }
  }

  async openFolder() {
    const folder = await window.electronAPI.selectDirectory(this.rootDirectory || undefined);
    if (folder) {
      if (window.electronAPI && window.electronAPI.setProjectRoot) {
        this.rootDirectory = await window.electronAPI.setProjectRoot(folder);
      } else {
        this.rootDirectory = folder;
      }
      this.rootLabel.textContent = this.rootDirectory;
      await this.startGitTracking(this.rootDirectory);
    }
  }

  save() { return this.manager.saveActiveFile(); }
  saveAs() { return this.manager.saveAsActiveFile(); }

  async executeRun(mode = 'run') {
    const filePath = this.manager.activeFilePath;
    if (!filePath) {
      if (!window.__IDE_TEST_MODE__) alert('No active file open in the editor.');
      return { success: false, message: 'No active file open in the editor.' };
    }

    const breakpoints = this.manager.getBreakpoints(filePath);
    this.pendingRunLaunches += 1;
    let result;
    try {
      result = await window.electronAPI.executeRun({ filePath, mode, breakpoints });
    } finally {
      this.pendingRunLaunches = Math.max(0, this.pendingRunLaunches - 1);
    }

    if (!result.success) {
      if (this.pendingRunLaunches === 0) this.earlyRunEvents.clear();
      if (!window.__IDE_TEST_MODE__) {
        if (result.isNotice) {
          alert(result.message);
        } else {
          alert(`Run Error: ${result.message}`);
        }
      }
      return result;
    }

    if (result.isNotice) {
      return result; // Browser or external launcher
    }

    this.currentRunId = result.runId;
    this.runOutputTitle.textContent = result.label || 'Run Output';
    this.runOutputStatus.textContent = '[Running\u2026]';
    this.runOutputContent.textContent = '';
    this.runOutputPanel.classList.remove('hidden');
    this.btnStop.classList.remove('hidden');
    this.debugToolbarControls.classList.add('hidden');
    this.debugVariablesPanel.classList.add('hidden');
    this.manager.clearPausedLine();
    this.replayEarlyRunEvents(result.runId);
    if (this.pendingRunLaunches === 0) {
      for (const runId of [...this.earlyRunEvents.keys()]) {
        if (runId !== this.currentRunId) this.earlyRunEvents.delete(runId);
      }
    }
    return result;
  }

  async stopCurrentRun() {
    if (this.currentRunId && window.electronAPI.stopRun) {
      await window.electronAPI.stopRun(this.currentRunId);
      this.runOutputStatus.textContent = '[Stopped]';
      this.btnStop.classList.add('hidden');
      this.debugToolbarControls.classList.add('hidden');
      this.debugVariablesPanel.classList.add('hidden');
      this.manager.clearPausedLine();
      this.currentRunId = null;
    }
  }

  sendDebugCmd(cmd) {
    if (this.currentRunId && window.electronAPI.sendDebugCommand) {
      window.electronAPI.sendDebugCommand(this.currentRunId, cmd);
    }
  }

  renderVariables(vars) {
    if (!this.debugVariablesList) return;
    this.debugVariablesList.innerHTML = '';
    if (!vars || vars.length === 0) {
      this.debugVariablesList.innerHTML = '<div style="color:#888;">No variables</div>';
      return;
    }
    vars.forEach(v => {
      const item = document.createElement('div');
      item.className = 'debug-var-item';
      item.innerHTML = `<span class="debug-var-name">${this.escapeHtml(v.name)}</span><span class="debug-var-val" title="${this.escapeHtml(v.value)}">${this.escapeHtml(v.value)}</span>`;
      this.debugVariablesList.appendChild(item);
    });
  }

  editorAction(id, unavailableMessage) {
    const action = this.manager.editor?.getAction(id);
    if (!action) { this.notice(unavailableMessage || 'This command is unavailable for the active editor.'); return; }
    Promise.resolve(action.run()).catch(() => this.notice(unavailableMessage || 'This command requires language support.'));
  }

  notice(message) {
    if (this.runOutputStatus) this.runOutputStatus.textContent = message;
    if (this.runOutputPanel) this.runOutputPanel.classList.remove('hidden');
  }

  getCommandRegistry() {
    const action = (id, message) => () => this.editorAction(id, message);
    return [
      { id: 'file.openFolder', label: 'File: Open Folder…', accel: 'Ctrl+O', run: () => this.openFolder() },
      { id: 'file.save', label: 'File: Save', accel: 'Ctrl+S', enabled: () => !!this.manager.activeFilePath, run: () => this.save() },
      { id: 'file.saveAs', label: 'File: Save As…', accel: 'Ctrl+Shift+S', enabled: () => !!this.manager.activeFilePath, run: () => this.saveAs() },
      { id: 'file.close', label: 'File: Close Editor', enabled: () => !!this.manager.activeFilePath, run: () => this.manager.closeTab(this.manager.activeFilePath) },
      { id: 'edit.undo', label: 'Edit: Undo', accel: 'Ctrl+Z', run: action('undo') },
      { id: 'edit.redo', label: 'Edit: Redo', accel: 'Ctrl+Y', run: action('redo') },
      { id: 'edit.cut', label: 'Edit: Cut', accel: 'Ctrl+X', run: action('editor.action.clipboardCutAction') },
      { id: 'edit.copy', label: 'Edit: Copy', accel: 'Ctrl+C', run: action('editor.action.clipboardCopyAction') },
      { id: 'edit.paste', label: 'Edit: Paste', accel: 'Ctrl+V', run: action('editor.action.clipboardPasteAction') },
      { id: 'edit.selectAll', label: 'Edit: Select All', accel: 'Ctrl+A', run: action('editor.action.selectAll') },
      { id: 'edit.find', label: 'Edit: Find', accel: 'Ctrl+F', run: action('actions.find') },
      { id: 'edit.replace', label: 'Edit: Replace', accel: 'Ctrl+H', run: action('editor.action.startFindReplaceAction') },
      { id: 'edit.commentLine', label: 'Edit: Toggle Line Comment', run: action('editor.action.commentLine') },
      { id: 'edit.commentBlock', label: 'Edit: Toggle Block Comment', run: action('editor.action.blockComment') },
      { id: 'edit.format', label: 'Edit: Format Document', run: action('editor.action.formatDocument', 'No formatter is configured for this document.') },
      { id: 'selection.allOccurrences', label: 'Selection: Select All Occurrences', run: action('editor.action.selectAllSearchMatches') },
      { id: 'selection.nextMatch', label: 'Selection: Add Next Find Match', run: action('editor.action.addSelectionToNextFindMatch') },
      { id: 'selection.previousMatch', label: 'Selection: Add Previous Find Match', run: action('editor.action.addSelectionToPreviousFindMatch') },
      { id: 'selection.cursorAbove', label: 'Selection: Add Cursor Above', run: action('editor.action.insertCursorAbove') },
      { id: 'selection.cursorBelow', label: 'Selection: Add Cursor Below', run: action('editor.action.insertCursorBelow') },
      { id: 'selection.lineEnds', label: 'Selection: Insert Cursor at Line Ends', run: action('editor.action.insertCursorAtEndOfEachLineSelected') },
      { id: 'selection.expand', label: 'Selection: Expand Selection', run: action('editor.action.smartSelect.expand') },
      { id: 'selection.shrink', label: 'Selection: Shrink Selection', run: action('editor.action.smartSelect.shrink') },
      { id: 'view.wordWrap', label: 'View: Toggle Word Wrap', run: action('editor.action.toggleWordWrap') },
      { id: 'view.minimap', label: 'View: Toggle Minimap', run: () => { const current = this.manager.editor.getOption(monaco.editor.EditorOption.minimap).enabled; this.manager.editor.updateOptions({ minimap: { enabled: !current } }); } },
      { id: 'view.output', label: 'View: Toggle Output Panel', run: () => this.runOutputPanel.classList.toggle('hidden') },
      { id: 'go.line', label: 'Go: Go to Line…', accel: 'Ctrl+G', run: action('editor.action.gotoLine') },
      { id: 'go.nextEditor', label: 'Go: Next Editor', run: () => { const files = Array.from(this.manager.openTabs.keys()); const at = files.indexOf(this.manager.activeFilePath); if (files.length) this.manager.switchTab(files[(at + 1) % files.length]); } },
      { id: 'run.start', label: 'Run: Start Debugging', accel: 'F5', run: () => this.executeRun('debug') },
      { id: 'run.withoutDebug', label: 'Run: Run Without Debugging', accel: 'Ctrl+F5', run: () => this.executeRun('run-without-debug') },
      { id: 'run.stop', label: 'Run: Stop Debugging', enabled: () => !!this.currentRunId, run: () => this.stopCurrentRun() },
      { id: 'run.breakpoint', label: 'Run: Toggle Breakpoint', enabled: () => !!this.manager.activeFilePath, run: () => { const line = this.manager.editor?.getPosition()?.lineNumber; if (line) this.manager.toggleBreakpoint(this.manager.activeFilePath, line); } },
      { id: 'terminal.runFile', label: 'Terminal: Run Active File', run: () => this.executeRun('run') },
      { id: 'terminal.clear', label: 'Terminal: Clear Output', run: () => { this.runOutputContent.textContent = ''; } },
      { id: 'terminal.show', label: 'Terminal: Show Output', run: () => this.runOutputPanel.classList.remove('hidden') },
      { id: 'help.shortcuts', label: 'Help: Keyboard Shortcuts', run: () => this.notice('Shortcuts follow the menu labels; command search is Ctrl+Shift+P.') },
      { id: 'help.about', label: 'Help: About Orion', run: () => this.notice('Orion editor — version provided by the desktop application package.') }
    ].map((command) => ({ ...command, enabled: command.enabled ? command.enabled() : true }));
  }

  setupCommandCenter() {
    const groups = { file: ['file.openFolder', 'file.save', 'file.saveAs', 'file.close'], edit: ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll', 'edit.find', 'edit.replace', 'edit.commentLine', 'edit.commentBlock', 'edit.format'], selection: ['selection.allOccurrences', 'selection.nextMatch', 'selection.previousMatch', 'selection.cursorAbove', 'selection.cursorBelow', 'selection.lineEnds', 'selection.expand', 'selection.shrink'], view: ['view.wordWrap', 'view.minimap', 'view.output'], go: ['go.line', 'go.nextEditor'], run: ['run.start', 'run.withoutDebug', 'run.stop', 'run.breakpoint'], terminal: ['terminal.runFile', 'terminal.clear', 'terminal.show'], help: ['help.shortcuts', 'help.about'] };
    document.getElementById('editor-command-center')?.addEventListener('click', () => this.openCommandCenter());
    document.querySelectorAll('.editor-menu-button').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); this.openEditorMenu(button, (groups[button.dataset.editorMenu] || []).map((id) => this.getCommandRegistry().find((c) => c.id === id)).filter(Boolean)); }));
    document.addEventListener('click', () => this.closeEditorMenu());
    this.editorCommandPalette?.addEventListener('click', (event) => { if (event.target === this.editorCommandPalette) this.closeCommandCenter(); });
    this.editorCommandInput?.addEventListener('input', () => this.filterCommandCenter());
    this.editorCommandInput?.addEventListener('keydown', (event) => { if (event.key === 'Escape') this.closeCommandCenter(); else if (event.key === 'ArrowDown') { event.preventDefault(); this.editorCommandIndex = Math.min(this.editorCommandIndex + 1, this.editorCommandResults.length - 1); this.renderCommandCenter(); } else if (event.key === 'ArrowUp') { event.preventDefault(); this.editorCommandIndex = Math.max(0, this.editorCommandIndex - 1); this.renderCommandCenter(); } else if (event.key === 'Enter') { event.preventDefault(); const command = this.editorCommandResults[this.editorCommandIndex]; if (command?.enabled) { this.closeCommandCenter(); command.run(); } } });
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape') { this.closeEditorMenu(); this.closeCommandCenter(); } });
  }

  openEditorMenu(anchor, commands) {
    if (!commands.length) return;
    const rect = anchor.getBoundingClientRect(); this.editorMenuDropdown.innerHTML = '';
    commands.forEach((command) => { const item = document.createElement('button'); item.type = 'button'; item.disabled = !command.enabled; item.innerHTML = `<span>${this.escapeHtml(command.label.replace(/^[^:]+:\\s*/, ''))}</span><small>${this.escapeHtml(command.accel || '')}</small>`; item.addEventListener('click', (event) => { event.stopPropagation(); if (!item.disabled) { this.closeEditorMenu(); command.run(); } }); this.editorMenuDropdown.appendChild(item); });
    this.editorMenuDropdown.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`; this.editorMenuDropdown.style.top = `${rect.bottom}px`; this.editorMenuDropdown.classList.remove('hidden');
  }

  closeEditorMenu() { this.editorMenuDropdown?.classList.add('hidden'); }
  openCommandCenter() { this.editorCommandPalette.classList.remove('hidden'); this.editorCommandInput.value = ''; this.filterCommandCenter(); setTimeout(() => this.editorCommandInput.focus(), 0); }
  closeCommandCenter() { this.editorCommandPalette?.classList.add('hidden'); }
  filterCommandCenter() { const query = this.editorCommandInput.value.trim().toLowerCase(); this.editorCommandResults = this.getCommandRegistry().filter((command) => !query || command.label.toLowerCase().includes(query) || command.id.includes(query) || (command.accel || '').toLowerCase().includes(query)); this.editorCommandIndex = 0; this.renderCommandCenter(); }
  renderCommandCenter() { this.editorCommandList.innerHTML = ''; this.editorCommandResults.forEach((command, index) => { const item = document.createElement('button'); item.type = 'button'; item.disabled = !command.enabled; item.className = index === this.editorCommandIndex ? 'selected' : ''; item.innerHTML = `<span>${this.escapeHtml(command.label)}</span><small>${this.escapeHtml(command.accel || '')}</small>`; item.addEventListener('click', () => { if (command.enabled) { this.closeCommandCenter(); command.run(); } }); this.editorCommandList.appendChild(item); }); }

  escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.editorApp = new EditorApp();
});
