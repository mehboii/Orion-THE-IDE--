const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getExtensionContributions: () => ipcRenderer.invoke('extensions:contributions'),
  onExtensionsChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('extensions:changed', handler);
    return () => ipcRenderer.removeListener('extensions:changed', handler);
  },
  getProjectRoot: () => ipcRenderer.invoke('project-root:get'),
  setProjectRoot: (root) => ipcRenderer.invoke('project-root:set', root),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('dialog:select-directory', defaultPath),
  showSaveDialog: (defaultPath) => ipcRenderer.invoke('dialog:show-save-dialog', defaultPath),
  setTestSaveAsPath: (targetPath) => ipcRenderer.invoke('test:set-save-as-path', targetPath),
  setTestDirectoryPath: (targetPath) => ipcRenderer.invoke('test:set-directory-path', targetPath),
  readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:write-file', { filePath, content }),
  watchFile: (filePath) => ipcRenderer.invoke('fs:watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('fs:unwatch-file', filePath),
  gitStatus: (cwd) => ipcRenderer.invoke('git:status', cwd),
  watchGit: (cwd) => ipcRenderer.invoke('git:watch', cwd),
  onGitStatusChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('git:status-changed', handler);
    return () => ipcRenderer.removeListener('git:status-changed', handler);
  },
  onFileChanged: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('file-changed', handler);
    return () => ipcRenderer.removeListener('file-changed', handler);
  },
  onEditorOpenFile: (callback) => {
    const handler = (event, filePath) => callback(filePath);
    ipcRenderer.on('editor:open-file', handler);
    return () => ipcRenderer.removeListener('editor:open-file', handler);
  },
  executeRun: (payload) => ipcRenderer.invoke('runner:execute', payload),
  stopRun: (runId) => ipcRenderer.invoke('runner:stop', runId),
  sendDebugCommand: (runId, command) => ipcRenderer.invoke('runner:debug-command', { runId, command }),
  setEditorDirtyState: (dirty) => ipcRenderer.send('editor:dirty-state', Boolean(dirty)),
  onRunnerData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('runner:data', handler);
    return () => ipcRenderer.removeListener('runner:data', handler);
  },
  onRunnerExit: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('runner:exit', handler);
    return () => ipcRenderer.removeListener('runner:exit', handler);
  },
  onDebugPaused: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('runner:debug-paused', handler);
    return () => ipcRenderer.removeListener('runner:debug-paused', handler);
  },
  onDebugResumed: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('runner:debug-resumed', handler);
    return () => ipcRenderer.removeListener('runner:debug-resumed', handler);
  }
});

contextBridge.exposeInMainWorld('__IDE_TEST_MODE__', process.env.IDE_TEST_MODE === '1');
