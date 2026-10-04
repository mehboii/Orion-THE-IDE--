const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('Settings manual action and all update UI states use the IPC service', async () => {
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8'));
  let resolveCheck, calls = 0, statusListener;
  const initial = { status: 'idle', currentVersion: require('../package.json').version, updateAvailable: false };
  const window = { electronAPI: { updater: {
    getStatus: async () => initial,
    checkForUpdates: () => { calls++; return new Promise(resolve => { resolveCheck = resolve; }); },
    onStatusChanged: fn => { statusListener = fn; }, onDownloadProgress: () => {}
  } } };
  const context = vm.createContext({ document, window, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8') + '\nglobalThis.Controller = AppController;', context);
  const controller = Object.create(context.Controller.prototype);
  for (const [property, id] of Object.entries({ statusUpdate: 'status-update', statusUpdateText: 'status-update-text',
    modalUpdate: 'modal-update', modalUpdateClose: 'modal-update-close', updateModalTitle: 'update-modal-title',
    updateInfoContainer: 'update-info-container', updateProgressContainer: 'update-progress-container',
    btnUpdateCancel: 'btn-update-cancel', btnUpdateAction: 'btn-update-action' })) controller[property] = document.getElementById(id);
  controller.setupUpdateListeners();
  await Promise.resolve();
  const button = document.getElementById('btn-check-updates');
  button.click();
  assert.equal(calls, 1);
  assert.equal(controller.updateModalTitle.textContent, 'Checking for Updates');
  statusListener({ ...initial, status: 'checking' });
  assert.equal(button.disabled, true);
  resolveCheck({ ...initial, status: 'not-available' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, false);
  assert.match(controller.updateInfoContainer.textContent, /You're up to date/);
  assert.match(document.getElementById('settings-update-version').textContent, new RegExp(initial.currentVersion));
  statusListener({ ...initial, status: 'available', updateAvailable: true, latestVersion: '99.0.0', releaseNotes: ['<script>unsafe</script>'] });
  assert.match(controller.updateInfoContainer.textContent, /99.0.0/);
  assert.match(controller.updateInfoContainer.textContent, new RegExp(initial.currentVersion));
  assert.equal(controller.btnUpdateAction.textContent, 'Download Update');
  assert.equal(controller.updateInfoContainer.querySelector('script'), null);
  statusListener({ ...initial, status: 'error', error: '<img src=x onerror=bad>' });
  assert.equal(controller.updateModalTitle.textContent, 'Unable to check for updates');
  assert.equal(controller.updateInfoContainer.querySelector('img'), null);
  assert(controller.btnUpdateAction.classList.contains('hidden'));
  statusListener({ ...initial, status: 'no-release' });
  assert.equal(controller.updateModalTitle.textContent, 'No Update Published');
  assert(!controller.updateInfoContainer.textContent.includes('up to date'));
});
