const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const git = require('../main/git-service');
const exec = promisify(execFile);

async function run(dir, args) { await exec('git', args, { cwd: dir, windowsHide: true }); }

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-git-'));
  try {
    await run(dir, ['init']);
    await run(dir, ['config', 'user.email', 'test@orion.local']);
    await run(dir, ['config', 'user.name', 'Orion Test']);
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'one\n');
    await run(dir, ['add', 'tracked.txt']);
    await run(dir, ['commit', '-m', 'initial']);

    await fs.writeFile(path.join(dir, 'tracked.txt'), 'two\n');
    await fs.writeFile(path.join(dir, 'new.txt'), 'new\n');
    let status = await git.status(dir);
    assert(status.available);
    assert.equal(status.files.find(f => f.path === 'tracked.txt').badge, 'M');
    assert.equal(status.files.find(f => f.path === 'new.txt').badge, 'U');

    await git.operation(dir, 'stage', { paths: ['tracked.txt'] });
    await fs.appendFile(path.join(dir, 'tracked.txt'), 'unstaged\n');
    status = await git.status(dir);
    const mixed = status.files.find(f => f.path === 'tracked.txt');
    assert(mixed.staged && mixed.unstaged, 'index and worktree changes must remain distinct');

    await git.operation(dir, 'stage', { paths: ['new.txt'] });
    status = await git.status(dir);
    assert.equal(status.files.find(f => f.path === 'new.txt').badge, 'A');

    await git.operation(dir, 'commit', { message: 'stage new file' });
    status = await git.status(dir);
    assert(status.files.find(f => f.path === 'tracked.txt').unstaged, 'commit must retain unstaged content');
    await git.operation(dir, 'stage', { paths: ['tracked.txt'] });
    await git.operation(dir, 'commit', { message: 'finish tracked file' });

    await run(dir, ['mv', 'new.txt', 'renamed.txt']);
    status = await git.status(dir);
    assert.equal(status.files.find(f => f.path === 'renamed.txt').badge, 'R');
    assert.equal(status.files.find(f => f.path === 'renamed.txt').originalPath, 'new.txt');
    await run(dir, ['reset', '--hard']);
    await fs.rm(path.join(dir, 'tracked.txt'));
    status = await git.status(dir);
    assert.equal(status.files.find(f => f.path === 'tracked.txt').badge, 'D');
    console.log('git-service: passed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
