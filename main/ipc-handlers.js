const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const { ExtensionService } = require('./extension-service');
const { ExtensionEditor } = require('./extension-editor');
const ptyManager = require('./pty-manager');
const agentConfig = require('./agent-config');
const workspaceStore = require('./workspace-store');
const customModelStore = require('./custom-model-store');
const customModelService = require('./custom-model-service');
const projectRoot = require('./project-root');
const gitService = require('./git-service');
const developmentServices = require('./development-services');
const { UpdateService } = require('./update-service');
const Store = require('electron-store');

function registerIpcHandlers({ openEditorFile, updateService: customUpdateService } = {}) {
  let updatePreferences = null;
  if (!customUpdateService) {
    try { updatePreferences = new Store({ name: 'updates', defaults: { channel: 'stable', lastCheckAt: 0 } }); }
    catch (_) { console.warn('[Updates] Preferences unavailable; continuing without update scheduling persistence.'); }
  }
  const updateService = customUpdateService || new UpdateService({
    preferences: updatePreferences,
    onStatusChanged: (status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('updater:status-changed', status);
      }
    },
    onDownloadProgress: (progress) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('updater:download-progress', progress);
      }
    }
  });

  // The application owns update identity and target, never the renderer.
  ipcMain.handle('updater:check-for-updates', () => updateService.checkForUpdates());
  ipcMain.handle('updater:download-update', () => updateService.downloadUpdate());
  ipcMain.handle('updater:get-status', () => updateService.getStatus());
  ipcMain.handle('updater:install-update', () => updateService.installUpdate());
  const extensions = new ExtensionService({ root: path.join(app.getPath('userData'), 'extensions') });
  const extensionEditor = new ExtensionEditor({ root: path.join(app.getPath('userData'), 'extension-editor'), extensions });
  ipcMain.handle('extensions:use-builtin-editor', () => extensionEditor.useBuiltInEditor());
  ipcMain.handle('extensions:open-editor', async (event, identifier) => {
    if (identifier && !(await extensions.list()).some(item => item.id === String(identifier).toLowerCase())) throw new Error('Install this extension before opening it in Extension Editor.');
    return extensions.serialize(() => extensionEditor.open({
      workspace: projectRoot.get(),
      progress: message => { if (!event.sender.isDestroyed()) event.sender.send('extensions:editor-progress', message); }
    }));
  });
  const broadcastExtensions = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('extensions:changed');
    }
  };
  const gitSubscriptions = new Map();
  const gitRefreshes = new Map();
  const stopGitWatch = (sender) => {
    const stop = gitSubscriptions.get(sender.id);
    if (stop) stop();
    gitSubscriptions.delete(sender.id);
    gitRefreshes.delete(sender.id);
  };
  const refreshGitSubscriber = async (sender, cwd) => {
    const key = sender.id;
    const state = gitRefreshes.get(key) || { inFlight: false, pending: false, signature: null };
    if (state.inFlight) {
      state.pending = true;
      gitRefreshes.set(key, state);
      return;
    }
    state.inFlight = true;
    gitRefreshes.set(key, state);
    try {
      const status = await gitService.status(cwd);
      const signature = JSON.stringify(status);
      if (signature !== state.signature && !sender.isDestroyed()) {
        state.signature = signature;
        sender.send('git:status-changed', status);
      }
    } catch (_) {
      // A folder may disappear while a watcher callback is queued.
    } finally {
      state.inFlight = false;
      if (state.pending) {
        state.pending = false;
        refreshGitSubscriber(sender, cwd);
      }
    }
  };
  ipcMain.handle('git:status', (_event, cwd) => gitService.status(cwd || projectRoot.get()));
  ipcMain.handle('git:diff', (_event, { cwd, filePath, staged }) => gitService.diff(cwd || projectRoot.get(), filePath, staged));
  ipcMain.handle('git:operation', async (_event, { cwd, action, payload }) => gitService.operation(cwd || projectRoot.get(), action, payload));
  ipcMain.handle('git:watch', async (event, cwd) => {
    stopGitWatch(event.sender);
    const activeCwd = cwd || projectRoot.get();
    const stop = gitService.watch(activeCwd, () => refreshGitSubscriber(event.sender, activeCwd));
    gitSubscriptions.set(event.sender.id, stop);
    event.sender.once('destroyed', () => stopGitWatch(event.sender));
    return gitService.status(activeCwd);
  });
  ipcMain.handle('git:unwatch', (event) => { stopGitWatch(event.sender); return true; });
  // The active project root is deliberately main-process state so the file
  // tree, PTY spawner, and model tool loop cannot silently drift apart.
  ipcMain.handle('project-root:get', () => projectRoot.get());
  ipcMain.handle('project-root:set', (event, root) => {
    const assigned = projectRoot.set(root);
    console.log(`[OPENED FOLDER IPC] renderer requested=${JSON.stringify(root)} assigned=${JSON.stringify(assigned)}`);
    // The editor is a separate renderer. Broadcast its folder changes to the
    // terminal renderer too, so already-running shells cannot retain a prior
    // project cwd after File > Open Folder is used in either window.
    ptyManager.send('project-root:changed', { root: assigned, sourceWebContentsId: event.sender.id });
    return assigned;
  });

  // Development sidebar services stay in the main process so workspace data,
  // Git credentials, and registry networking are never exposed to the renderer.
  ipcMain.handle('workspace:search', async (event, query) => {
    const root = projectRoot.get();
    if (!root) return { results: [], reason: 'Open a folder to search.' };
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return { results: [] };
    return { results: await developmentServices.walk(root, normalized, []) };
  });
  ipcMain.handle('marketplace:search', async (event, { query, offset, size }) => {
    const [data, installed] = await Promise.all([developmentServices.marketplaceSearch(query, offset, size), extensions.list()]);
    const byId = new Map(installed.map(item => [item.id, item]));
    return { ...data, results: data.results.map(item => ({ ...item, installed: byId.has(item.id.toLowerCase()), installedVersion: byId.get(item.id.toLowerCase())?.version })) };
  });
  ipcMain.handle('marketplace:details', async (event, identifier) => {
    const installed = (await extensions.list()).find(item => item.id === String(identifier).toLowerCase());
    try {
      const details = await developmentServices.marketplaceDetails(identifier);
      return { ...details, installed: Boolean(installed), installedVersion: installed?.version, runtimeMessage: installed?.runtimeMessage, launchActions: installed?.launchActions };
    } catch (error) {
      if (installed) return { ...installed, installedVersion: installed.version, compatibilityMessage: installed.runtimeMessage };
      throw error;
    }
  });
  ipcMain.handle('extensions:list', () => extensions.list());
  ipcMain.handle('extensions:launch-info', (_event, identifier, action) => extensions.launchInfo(identifier, action));
  ipcMain.handle('extensions:install', async (_event, identifier) => {
    try { return await extensions.install(identifier); }
    finally { broadcastExtensions(); }
  });
  ipcMain.handle('extensions:uninstall', async (_event, identifier) => {
    const result = await extensions.uninstall(identifier); broadcastExtensions(); return result;
  });
  ipcMain.handle('extensions:contributions', () => extensions.contributions());
  ipcMain.handle('extensions:theme', async (_event, themeId) => {
    await extensions.setTheme(themeId); broadcastExtensions(); return true;
  });

  // PTY session handlers
  ipcMain.handle('pty:create', async (event, params) => {
    if (process.env.IDE_PTY_TRACE === '1') console.log('[PTY_TRACE] ipc.pty:create ' + JSON.stringify({ paneId: params?.paneId, trigger: params?.trigger, envVars: params?.envVars, senderId: event.sender.id }));
    try {
      return await ptyManager.createSession(params);
    } catch (error) {
      event.sender.send('cwd:warning', { action: params?.trigger || 'unknown-pane-action', error: error.message, cwd: params?.cwd || null, openedFolder: projectRoot.get() });
      throw error;
    }
  });

  ipcMain.on('pty:write', (event, { paneId, data }) => {
    if (process.env.IDE_PTY_TRACE === '1' && String(data).includes('\x03')) console.log('[PTY_TRACE] ipc.pty:write.ctrl-c ' + JSON.stringify({ paneId, data, senderId: event.sender.id }));
    ptyManager.write(paneId, data);
  });

  ipcMain.on('pty:resize', (event, { paneId, cols, rows }) => {
    ptyManager.resize(paneId, cols, rows);
  });

  ipcMain.handle('pty:destroy', async (event, { paneId, killTmux }) => {
    if (process.env.IDE_PTY_TRACE === '1') console.log('[PTY_TRACE] ipc.pty:destroy ' + JSON.stringify({ paneId, killTmux, senderId: event.sender.id }));
    await ptyManager.destroySession(paneId, killTmux);
    return { success: true };
  });

  ipcMain.handle('pty:restart', async (event, params) => {
    if (process.env.IDE_PTY_TRACE === '1') console.log('[PTY_TRACE] ipc.pty:restart ' + JSON.stringify({ paneId: params?.paneId, trigger: params?.trigger, envVars: params?.envVars, senderId: event.sender.id }));
    // Kill old tmux session by default so Restart always spawns a fresh PTY,
    // not a reattach to a dead session. Pass forceNew:false to reattach only.
    const forceNew = params.forceNew !== false;
    await ptyManager.destroySession(params.paneId, forceNew);
    try {
      return await ptyManager.createSession({ ...params, forceNew });
    } catch (error) {
      event.sender.send('cwd:warning', { action: params?.trigger || 'pane-restart', error: error.message, cwd: params?.cwd || null, openedFolder: projectRoot.get() });
      throw error;
    }
  });

  // tmux management handlers
  ipcMain.handle('tmux:check', async () => {
    return ptyManager.checkTmuxAvailable();
  });

  ipcMain.handle('tmux:list-orphans', async () => {
    return ptyManager.listOrphanSessions();
  });

  ipcMain.handle('tmux:kill-session', async (event, { sessionName }) => {
    return ptyManager.killTmuxSession(sessionName);
  });

  ipcMain.handle('tmux:kill-all', async () => {
    return ptyManager.killAllTmuxSessions();
  });

  // Agent Preset handlers
  ipcMain.handle('agents:list', async () => {
    return agentConfig.loadAgents();
  });

  ipcMain.handle('agents:save', async (event, agentsList) => {
    return agentConfig.saveAgents(agentsList);
  });

  // Custom remote models always use main-process networking. The renderer only
  // receives sanitized configuration and streamed tokens through IPC.
  ipcMain.handle('custom-models:list', () => customModelStore.list());
  ipcMain.handle('custom-models:save', (event, models) => customModelStore.save(models));
  ipcMain.handle('custom-models:test', (event, model) => customModelService.testConnection(model));
  ipcMain.handle('custom-models:fetch-models', (event, model) => customModelService.fetchAvailableModels(model));
  ipcMain.handle('custom-models:chat', (event, payload) => customModelService.streamChat(event.sender, payload.paneId, payload.model, payload.messages, payload.cwd, payload.fullAutoApprove, payload.maxIterations));
  ipcMain.handle('custom-models:tool-decision', (event, { callId, approved }) => customModelService.resolveApproval(callId, approved));
  ipcMain.handle('custom-models:cancel', (event, { paneId }) => customModelService.cancelChat(event.sender.id, paneId));

  // Keep terminal clipboard access inside Electron rather than relying on the
  // renderer having browser clipboard permissions.
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());
  ipcMain.handle('clipboard:write-text', (event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  // Workspace Storage handlers
  ipcMain.handle('workspaces:get-all', async () => {
    return workspaceStore.getWorkspaces();
  });

  ipcMain.handle('workspaces:save', async (event, { name, layout }) => {
    return workspaceStore.saveWorkspace(name, layout);
  });

  ipcMain.handle('workspaces:load', async (event, { name }) => {
    return workspaceStore.loadWorkspace(name);
  });

  ipcMain.handle('workspaces:delete', async (event, { name }) => {
    return workspaceStore.deleteWorkspace(name);
  });

  // Directory picker dialog handler
  ipcMain.handle('dialog:select-directory', async (event, defaultPath) => {
    if (process.env.IDE_TEST_MODE === '1' && global.__TEST_DIRECTORY_PATH__) {
      const selected = global.__TEST_DIRECTORY_PATH__;
      global.__TEST_DIRECTORY_PATH__ = null;
      return selected;
    }
    const window = event.sender.getOwnerBrowserWindow();
    const result = await dialog.showOpenDialog(window, {
      title: 'Select Working Directory',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('test:set-save-as-path', (event, targetPath) => {
    if (process.env.IDE_TEST_MODE !== '1') throw new Error('Test-only IPC is disabled.');
    global.__TEST_SAVE_AS_PATH__ = targetPath;
    return true;
  });
  ipcMain.handle('test:set-directory-path', (event, targetPath) => {
    if (process.env.IDE_TEST_MODE !== '1') throw new Error('Test-only IPC is disabled.');
    global.__TEST_DIRECTORY_PATH__ = targetPath;
    return true;
  });

  // The main renderer requests editor files through this channel. It never
  // mounts Monaco itself; the file is delivered to the editor BrowserWindow.
  ipcMain.handle('editor:open-file', async (event, filePath) => {
    if (await extensionEditor.isEnabled()) {
      await extensions.serialize(() => extensionEditor.open({ workspace: projectRoot.get(), file: filePath }));
      return true;
    }
    if (typeof openEditorFile === 'function') openEditorFile(filePath);
    return true;
  });

  ipcMain.handle('dialog:show-save-dialog', async (event, defaultPath) => {
    if (process.env.IDE_TEST_MODE === '1' && global.__TEST_SAVE_AS_PATH__) {
      const p = global.__TEST_SAVE_AS_PATH__;
      global.__TEST_SAVE_AS_PATH__ = null;
      return approveExternalPath(event.sender, p);
    }
    const window = event.sender.getOwnerBrowserWindow();
    const result = await dialog.showSaveDialog(window, {
      title: 'Save File As',
      defaultPath: defaultPath || undefined
    });

    if (!result.canceled && result.filePath) {
      return approveExternalPath(event.sender, result.filePath);
    }
    return null;
  });

  // Filesystem IPC handlers
  const fs = require('fs');
  const fileWatchers = new Map();
  const watcherCleanupRegistered = new Set();
  const approvedExternalPaths = new Map();
  const watcherKey = (sender, filePath) => `${sender.id}:${filePath}`;
  const closeSenderWatchers = (sender) => {
    const prefix = `${sender.id}:`;
    for (const [key, watcher] of fileWatchers) {
      if (key.startsWith(prefix)) {
        try { watcher.close(); } catch (_) {}
        fileWatchers.delete(key);
      }
    }
    watcherCleanupRegistered.delete(sender.id);
    approvedExternalPaths.delete(sender.id);
  };

  function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  function nearestExistingPath(target) {
    let probe = target;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return probe;
  }

  function approveExternalPath(sender, targetPath) {
    const target = path.resolve(targetPath);
    if (!approvedExternalPaths.has(sender.id)) approvedExternalPaths.set(sender.id, new Set());
    approvedExternalPaths.get(sender.id).add(target);
    return target;
  }

  function resolveFsPath(sender, targetPath) {
    if (!targetPath) throw new Error('Could not resolve working directory: no file path was provided.');
    const root = projectRoot.resolveWorkingDirectory(null, 'filesystem operation');
    const target = path.resolve(root, targetPath);
    const approved = approvedExternalPaths.get(sender.id)?.has(target);
    if (!isInside(root, target) && !approved) {
      throw new Error(`Filesystem path is outside the opened folder: ${target}`);
    }
    if (!approved) {
      const realRoot = fs.realpathSync(root);
      const existing = nearestExistingPath(target);
      const realExisting = fs.realpathSync(existing);
      if (!isInside(realRoot, realExisting)) {
        throw new Error(`Filesystem path resolves outside the opened folder: ${target}`);
      }
    }
    return target;
  }

  ipcMain.handle('fs:read-dir', async (event, dirPath) => {
    try {
      const target = resolveFsPath(event.sender, dirPath);
      if (!target || !fs.existsSync(target)) return [];
      const entries = await fs.promises.readdir(target, { withFileTypes: true });
      const results = entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(target, entry.name)
      }));

      // Sort directories first, then files alphabetically
      results.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return results;
    } catch (err) {
      console.error('fs:read-dir error:', err);
      return [];
    }
  });

  ipcMain.handle('fs:read-file', async (event, filePath) => {
    try {
      const target = resolveFsPath(event.sender, filePath);
      const content = await fs.promises.readFile(target, { encoding: 'utf8' });
      return { success: true, content };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:write-file', async (event, { filePath, content }) => {
    try {
      const target = resolveFsPath(event.sender, filePath);
      console.log(`[FS WRITE ASSERTION] IPC fs:write-file writing to path: ${target}`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content, { encoding: 'utf8' });
      refreshGitSubscriber(event.sender, projectRoot.get());
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // fs.watch accepts both a file and a directory. The Explorer watches its
  // project root to receive structural changes made by terminal agents.
  ipcMain.handle('fs:watch-file', (event, filePath) => {
    if (!filePath) return false;
    try {
      const target = resolveFsPath(event.sender, filePath);
      const key = watcherKey(event.sender, target);
      if (fileWatchers.has(key)) return true;
      let debounceTimer = null;
      const pendingChanges = new Map();
      const watchingDirectory = fs.statSync(target).isDirectory();
      // Windows supports recursive fs.watch, allowing a single owner per
      // workspace to identify nested structural changes. Other platforms use
      // their native non-recursive watcher rather than creating a watcher for
      // every directory.
      const watcher = fs.watch(target, process.platform === 'win32' ? { recursive: true } : {}, (eventType, filename) => {
        const changedPath = watchingDirectory && filename ? path.resolve(target, String(filename)) : target;
        // Keep structural events when creation also emits a content change.
        if (pendingChanges.get(changedPath) !== 'rename') pendingChanges.set(changedPath, eventType);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const win = event.sender.getOwnerBrowserWindow();
          if (win && !win.isDestroyed()) {
            // fs.watch reports a name relative to the watched directory.  Do
            // not discard it: consumers need the affected parent directory
            // to avoid rebuilding an entire Explorer tree for one entry.
            for (const [changedPath, eventType] of pendingChanges) {
              const relativeParts = path.relative(target, changedPath).split(path.sep);
              // Generated output is intentionally not a source-tree refresh
              // trigger. Git continues to make an independent decision about
              // whether an unignored file merits a decoration.
              if (relativeParts.some((part) => ['node_modules', 'dist', 'build', '.cache', '.next'].includes(part))) continue;
              win.webContents.send('file-changed', { filePath: changedPath, eventType });
            }
          }
          pendingChanges.clear();
        }, 150);
      });
      watcher.on('error', (error) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        fileWatchers.delete(key);
        console.error('fs watcher error:', error);
        try { watcher.close(); } catch (_) {}
      });
      fileWatchers.set(key, watcher);
      if (!watcherCleanupRegistered.has(event.sender.id)) {
        watcherCleanupRegistered.add(event.sender.id);
        event.sender.once('destroyed', () => closeSenderWatchers(event.sender));
      }
      return true;
    } catch (err) {
      console.error('fs:watch-file error:', err);
      return false;
    }
  });

  ipcMain.handle('fs:unwatch-file', (event, filePath) => {
    let target;
    try { target = resolveFsPath(event.sender, filePath); } catch (_) { target = path.resolve(String(filePath || '')); }
    const key = watcherKey(event.sender, target);
    if (fileWatchers.has(key)) {
      try {
        fileWatchers.get(key).close();
      } catch (_) {}
      fileWatchers.delete(key);
    }
    return true;
  });

  // Runner & Debugger IPC handlers
  const runner = require('./runner');
  ipcMain.handle('runner:execute', async (event, payload) => {
    try {
      return await runner.execute(event.sender, payload);
    } catch (error) {
      event.sender.send('cwd:warning', { action: 'run-or-debug', error: error.message, cwd: payload?.filePath || null, openedFolder: projectRoot.get() });
      return { success: false, message: error.message };
    }
  });
  ipcMain.handle('runner:stop', (event, runId) => runner.stop(runId));
  ipcMain.handle('runner:debug-command', (event, { runId, command }) => runner.sendDebugCommand(runId, command));
  return updateService;
}

module.exports = { registerIpcHandlers };
