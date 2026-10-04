const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
(async () => {
  const { document } = parseHTML('<html><body><div class="sidebar-panel" data-panel="extensions"></div></body></html>');
  const panel = document.querySelector('.sidebar-panel');
  let installed = false, version = '1.0.0', installWait, shouldFail = false, theme, launched, launchFail = false;
  const info = () => ({ id: 'demo.test', name: '<script>Demo</script>', publisher: 'demo', version, installed, installedVersion: installed ? '1.0.0' : undefined, description: '<img src=x onerror=alert(1)>', compatibilityMessage: 'Package can be installed.', runtimeMessage: installed ? 'Executable features need an extension host.' : undefined });
  const api = {
    searchMarketplace: async () => ({ results: [info()], total: 1, provider: 'Open VSX' }),
    getMarketplaceDetails: async () => info(),
    installExtension: async id => { assert.equal(id, 'demo.test'); if (installWait) await installWait.promise; if (shouldFail) throw new Error('Download failed.'); installed = true; },
    uninstallExtension: async id => { assert.equal(id, 'demo.test'); installed = false; },
    listExtensions: async () => installed ? [info()] : [],
    getExtensionContributions: async () => ({ themes: [{ extensionId: 'demo.test', id: 'demo.test:dark', label: 'Demo Dark' }] }),
    setExtensionTheme: async id => { theme = id; }
  };
  const context = vm.createContext({ document, window: { electronAPI: api }, console, clearTimeout, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/sidebar-panels.js'), 'utf8') + '\nglobalThis.SidebarPanels = SidebarPanels;', context);
  const sidebar = new context.SidebarPanels({ createPane: async options => { launched = options; return launchFail ? null : { status: 'running' }; } });
  sidebar.renderExtensions(); await tick();
  assert(panel.querySelector('.extension-card'));
  assert.equal(panel.querySelector('script'), null);
  assert.equal(panel.querySelector('img'), null);
  await sidebar.showExtensionDetails('demo.test');
  assert.equal(panel.querySelector('#extension-install').disabled, false);
  assert.equal(panel.querySelector('#extension-uninstall'), null);
  installWait = deferred();
  const pending = panel.querySelector('#extension-install').onclick();
  assert(panel.querySelector('#extension-install').disabled);
  assert.match(panel.querySelector('#extension-operation-state').textContent, /Downloading/);
  installWait.resolve(); await pending; installWait = null;
  assert.equal(panel.querySelector('#extension-install'), null);
  assert(panel.querySelector('#extension-uninstall'));
  assert.match(panel.querySelector('.compatibility-warning').textContent, /extension host/);
  assert.equal(panel.querySelector('[data-extension-launch]'), null, 'unsupported packages do not promise executable support');
  api.getMarketplaceDetails = async () => ({ ...info(), launchActions: [{ id: 'terminal', label: 'Run Claude Code in Terminal' }] });
  api.getExtensionLaunchInfo = async (id, action) => { assert.equal(id, 'demo.test'); assert.equal(action, 'terminal'); return { label: 'Claude Code', agentCommand: 'verified native executable', trigger: 'extension-launch' }; };
  await sidebar.showExtensionDetails('demo.test');
  await panel.querySelector('[data-extension-launch]').onclick();
  assert.equal(launched.agentCommand, 'verified native executable');
  assert.match(panel.querySelector('#extension-operation-state').textContent, /Started in a terminal/);
  launchFail = true;
  await panel.querySelector('[data-extension-launch]').onclick();
  assert.match(panel.querySelector('#extension-operation-state').textContent, /Unable to start/);
  assert.equal(panel.querySelector('[data-extension-launch]').disabled, false);
  launchFail = false;
  api.getMarketplaceDetails = async () => info();
  await panel.querySelector('[data-theme-index]').onclick();
  assert.equal(theme, 'demo.test:dark');
  await panel.querySelector('#extension-theme-reset').onclick();
  assert.equal(theme, null);
  version = '2.0.0';
  await sidebar.showExtensionDetails('demo.test');
  assert.equal(panel.querySelector('#extension-install').textContent, 'Update');
  await panel.querySelector('#extension-uninstall').onclick();
  assert(panel.querySelector('#extension-install'));
  shouldFail = true;
  await panel.querySelector('#extension-install').onclick();
  assert.match(panel.querySelector('#extension-operation-state').textContent, /Download failed/);
  assert.equal(panel.querySelector('#extension-install').disabled, false, 'a failed install can be retried');

  // Old search and details responses must not replace the view after navigation.
  shouldFail = false;
  panel.querySelector('#extension-back').onclick(); await tick();
  const slowSearch = deferred();
  api.searchMarketplace = () => slowSearch.promise;
  const pendingSearch = sidebar.loadExtensions('old');
  await sidebar.showExtensionDetails('demo.test');
  slowSearch.resolve({ results: [], total: 0, provider: 'Open VSX' }); await pendingSearch;
  assert(panel.querySelector('#extension-install'), 'search response cannot overwrite detail view');
  const oldDetails = deferred();
  api.getMarketplaceDetails = () => oldDetails.promise;
  const pendingDetail = sidebar.showExtensionDetails('demo.test');
  panel.dataset.ready = ''; api.searchMarketplace = async () => ({ results: [], total: 0, provider: 'Open VSX' });
  sidebar.renderExtensions(); await tick();
  oldDetails.resolve(info()); await pendingDetail;
  assert(panel.querySelector('#marketplace-search'), 'old details cannot overwrite a newer results view');
  assert.match(panel.querySelector('#marketplace-state').textContent, /^0 results/);

  installed = true;
  panel.querySelector('#marketplace-installed').onclick(); await tick();
  assert.match(panel.querySelector('#marketplace-state').textContent, /Installed in Orion/);
  assert.match(panel.querySelector('.extension-card').textContent, /Installed/);
  console.log('PASS marketplace install/update/uninstall controls, progress/errors, themes, installed list, escaping, and navigation races');
})().catch(error => { console.error(error); process.exitCode = 1; });
