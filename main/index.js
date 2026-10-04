const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
// Electron integration checks use a disposable profile, including packaged builds.
if (process.env.IDE_TEST_MODE === '1' && process.env.IDE_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.IDE_TEST_USER_DATA));
}
const ptyManager = require('./pty-manager');
const runner = require('./runner');
const { registerIpcHandlers } = require('./ipc-handlers');

let mainWindow = null;
let editorWindow = null;
let pendingEditorFiles = [];
let editorReady = false;
let editorDirty = false;
let editorWebContentsId = null;

function showBuildVersion(window, label) {
  const title = `${label} v${app.getVersion()}`;
  window.setTitle(title);
  window.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(title);
  });
}

function getGlassWindowOptions() {
  return {
    transparent: false,
    backgroundColor: '#101119',
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
  };
}

function confirmEditorDiscard(detail) {
  if (!editorDirty || !editorWindow || editorWindow.isDestroyed()) return true;
  const choice = dialog.showMessageBoxSync(editorWindow, {
    type: 'warning',
    title: 'Unsaved changes',
    message: 'The editor has unsaved changes.',
    detail,
    buttons: ['Cancel', 'Discard Changes'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (choice === 1) editorDirty = false;
  return choice === 1;
}


function registerWindowControlHandlers() {
  ipcMain.handle('window:control', (event, action) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) return false;

    if (action === 'minimize') targetWindow.minimize();
    if (action === 'toggle-maximize') {
      if (targetWindow.isMaximized()) targetWindow.unmaximize();
      else targetWindow.maximize();
    }
    if (action === 'toggle-fullscreen') targetWindow.setFullScreen(!targetWindow.isFullScreen());
    if (action === 'close') targetWindow.close();
    return targetWindow.isMaximized();
  });
}
function sendFileToEditor(filePath) {
  if (!editorWindow || editorWindow.isDestroyed()) return;
  editorWindow.webContents.send('editor:open-file', filePath);
}

function openEditorFile(filePath) {
  if (!filePath) return;
  if (editorWindow && !editorWindow.isDestroyed()) {
    if (!editorReady) {
      pendingEditorFiles.push(filePath);
      return;
    }
    editorWindow.show();
    editorWindow.focus();
    sendFileToEditor(filePath);
    return;
  }

  pendingEditorFiles.push(filePath);
  editorReady = false;
  editorWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    title: 'ORION IDE \u2014 Editor',
    icon: path.join(__dirname, '../build/icon.png'),
    ...getGlassWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/editor.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  editorWebContentsId = editorWindow.webContents.id;
  showBuildVersion(editorWindow, 'ORION IDE — Editor');
  editorDirty = false;
  editorWindow.on('close', (event) => {
    if (!confirmEditorDiscard('Cancel and save your work, or discard the unsaved changes and close the editor.')) event.preventDefault();
  });
  editorWindow.setMenu(createEditorMenu());
  editorWindow.loadFile(path.join(__dirname, '../renderer/editor.html'));
  editorWindow.webContents.once('did-finish-load', () => {
    editorReady = true;
    const files = pendingEditorFiles;
    pendingEditorFiles = [];
    files.forEach(sendFileToEditor);
  });
  editorWindow.on('closed', () => {
    if (editorWebContentsId != null) runner.stopAllForWebContents(editorWebContentsId);
    editorWindow = null;
    editorWebContentsId = null;
    editorDirty = false;
    editorReady = false;
    pendingEditorFiles = [];
  });
}

function callEditor(method) {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.executeJavaScript(`window.editorApp && window.editorApp.${method}()`);
  }
}

function createEditorMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder\u2026', accelerator: 'CmdOrCtrl+O', click: () => callEditor('openFolder') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => callEditor('save') },
        { label: 'Save As\u2026', accelerator: 'CmdOrCtrl+Shift+S', click: () => callEditor('saveAs') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { label: 'View', submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => {
          if (!editorWindow || editorWindow.isDestroyed()) return;
          if (!confirmEditorDiscard('Cancel and save your work, or discard the unsaved changes and reload the editor.')) return;
          runner.stopAllForWebContents(editorWindow.webContents.id);
          editorReady = false;
          editorWindow.webContents.once('did-finish-load', () => {
            editorReady = true;
            const files = pendingEditorFiles;
            pendingEditorFiles = [];
            files.forEach(sendFileToEditor);
          });
          editorWindow.reload();
        }
      },
      { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }
    ] }
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'ORION IDE',
    icon: path.join(__dirname, '../build/icon.png'),
    ...getGlassWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  ptyManager.setWindow(mainWindow);
  showBuildVersion(mainWindow, 'ORION IDE');

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Keep automated window counts meaningful; opt in to a detached inspector
  // separately when diagnosing a test run.
  if (process.env.IDE_TEST_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Native menu mirrors in-app File/Terminal/View actions (VS Code-style)
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Pane',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.createPane({})');
            }
          }
        },
        {
          label: 'Save Workspace',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.saveCurrentWorkspace()');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Kill All Sessions',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.killAllSessions()');
            }
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Toggle Broadcast',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.broadcastManager && window.broadcastManager.toggle()');
            }
          }
        },
        {
          label: 'Close Focused Pane',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript(
                'window.appInstance && window.appInstance.focusedPaneId && window.appInstance.removePane(window.appInstance.focusedPaneId)'
              );
            }
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette\u2026',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.openCommandPalette()');
            }
          }
        },
        {
          label: 'Toggle Side Bar',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript('window.appInstance && window.appInstance.toggleSidebar()');
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript(
                'window.appInstance && window.appInstance.checkForUpdates && window.appInstance.checkForUpdates()'
              );
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.executeJavaScript(
                'window.appInstance && window.appInstance.modalHelp && window.appInstance.modalHelp.classList.remove("hidden")'
              );
            }
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.autoHideMenuBar = true;
  }
}

app.whenReady().then(() => {
  registerIpcHandlers({ openEditorFile });
  registerWindowControlHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

ipcMain.on('editor:dirty-state', (event, dirty) => {
  if (editorWindow && !editorWindow.isDestroyed() && event.sender.id === editorWindow.webContents.id) {
    editorDirty = Boolean(dirty);
  }
});

app.on('will-quit', () => runner.stopAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
