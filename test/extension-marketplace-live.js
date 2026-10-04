// Optional live registry check: node test/extension-marketplace-live.js
const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ExtensionService } = require('../main/extension-service');
const { marketplaceSearch, marketplaceDetails } = require('../main/development-services');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-marketplace-live-'));
  try {
    const results = await marketplaceSearch('dracula', 0, 5);
    assert(results.results.length > 0);
    assert(results.results.every(item => item.installable));
    const service = new ExtensionService({ root });
    for (const id of ['dracula-theme.theme-dracula', 'esbenp.prettier-vscode']) {
      const details = await marketplaceDetails(id);
      assert.equal(details.id, id);
      const result = await service.install(id);
      assert.equal(result.extension.id, id);
      console.log(`PASS live install ${id} ${result.extension.version}; needs extension host: ${result.extension.requiresExtensionHost}`);
    }
    const contributions = await service.contributions();
    assert(contributions.themes.length > 0);
    assert.equal(contributions.errors.length, 0, JSON.stringify(contributions.errors));
    assert.equal((await new ExtensionService({ root }).list()).length, 2);
    await service.uninstall('esbenp.prettier-vscode');
    await service.uninstall('dracula-theme.theme-dracula');
    assert.equal((await service.list()).length, 0);
    console.log('PASS live search, metadata, theme loading, restart persistence, and uninstall');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
