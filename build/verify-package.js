const path = require('path');
const asar = require('@electron/asar');

// Validate the archive that goes into the installer, rather than source files.
module.exports = async function verifyPackage(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  const read = name => asar.extractFile(archive, path.join(...name.split('/'))).toString('utf8');
  const metadata = JSON.parse(read('package.json'));
  if (metadata.version !== context.packager.appInfo.version) throw new Error('Packaged version does not match the installer version.');
  const ui = read('renderer/sidebar-panels.js');
  const service = read('main/development-services.js');
  if (ui.includes('Install unavailable') || service.includes('installation is intentionally blocked')) {
    throw new Error('Packaging rejected: obsolete marketplace installation block found.');
  }
  if (!ui.includes('installExtension(id)') || !read('main/ipc-handlers.js').includes("'extensions:install'")) {
    throw new Error('Packaging rejected: extension installation flow is missing.');
  }
  for (const file of [
    'main/update-service.js', 'main/update-client.js', 'main/update-config.js', 'config/update-keys.json',
    'main/extension-service.js', 'main/extension-editor.js', 'main/marketplace-http.js', 'renderer/editor-extensions.js',
    'node_modules/yauzl/index.js', 'node_modules/yauzl/crc32.js', 'node_modules/yauzl/fd-slicer.js',
    'node_modules/pend/index.js', 'node_modules/jsonc-parser/lib/umd/main.js'
  ]) {
    if (!read(file).length) throw new Error(`Packaging rejected: required file is empty: ${file}`);
  }
  const updateKeys = JSON.parse(read('config/update-keys.json'));
  if (!Array.isArray(updateKeys.pinnedKeys) || /BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY/.test(JSON.stringify(updateKeys))) {
    throw new Error('Packaging rejected: invalid update public trust configuration or private signing material.');
  }
  if (!ui.includes('getExtensionLaunchInfo') || !read('preload/index.js').includes('getExtensionLaunchInfo') || !read('main/ipc-handlers.js').includes("'extensions:launch-info'")) {
    throw new Error('Packaging rejected: installed-extension terminal launch flow is missing.');
  }
  if (!ui.includes('openExtensionEditor') || !read('preload/index.js').includes('openExtensionEditor') || !read('main/ipc-handlers.js').includes("'extensions:open-editor'")) {
    throw new Error('Packaging rejected: executable-extension editor flow is missing.');
  }
  console.log(`  Verified packaged Orion ${metadata.version}: marketplace Install enabled and dependencies included.`);
};
