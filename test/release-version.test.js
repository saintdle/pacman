import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const resolver = fileURLToPath(new URL('../tools/resolve-release-version.js', import.meta.url));

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

test('release replay resolves the immutable source tag when latest has advanced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pacman-release-version-'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.7.7' }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version: '0.7.7' } } }));
  writeFileSync(join(directory, 'source.txt'), 'released source');

  try {
    git(directory, '-c', 'init.defaultBranch=main', 'init');
    git(directory, 'config', 'user.name', 'Release regression test');
    git(directory, 'config', 'user.email', 'release-test@example.invalid');
    git(directory, 'add', 'package.json', 'package-lock.json', 'source.txt');
    git(directory, 'commit', '-m', 'released source');
    const releasedSha = git(directory, 'rev-parse', 'HEAD');
    git(directory, 'tag', 'pacman-v0.7.7', releasedSha);

    writeFileSync(join(directory, 'source.txt'), 'later source');
    git(directory, 'add', 'source.txt');
    git(directory, 'commit', '-m', 'later source');
    git(directory, 'tag', 'pacman-v0.8.0');

    const output = execFileSync(process.execPath, [resolver], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: releasedSha, RELEASE_BASE_SHA: '' },
    });

    assert.match(output, /^version=0\.7\.7$/m);
    assert.match(output, /^existing_release=true$/m);
    assert.match(output, /^tag=pacman-v0\.7\.7$/m);
    assert.match(output, /^latest_release=0\.8\.0$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
