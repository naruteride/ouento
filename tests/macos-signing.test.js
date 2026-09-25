import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bundleIdentifier,
  designatedRequirement,
  localAppPath,
  loginKeychain,
  parseIdentities,
  readSigningMarker,
  signApp,
  signLocalBuild,
  signingName,
  validateSigningMarker,
  wantsLocalSigning,
  writeSigningMarker,
} from '../scripts/macos-signing.mjs';
import { setupLocalSigning } from '../scripts/setup-macos-signing.mjs';

// All security, codesign and OpenSSL calls are doubles. No keychain is read or changed.
const fingerprint = '0123456789ABCDEF0123456789ABCDEF01234567';
const identity = { fingerprint, keychain: '/synthetic/login.keychain-db' };
const config = { productName: 'Ouento', identifier: bundleIdentifier, bundle: { targets: 'all' } };

test('project marker stores only the public fingerprint and refuses identity replacement', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ouento-marker-test-'));
  const path = join(temporary, '.local', 'macos-signing.json');
  try {
    assert.equal(await readSigningMarker(path), null);
    await writeSigningMarker(identity, path);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { fingerprint });
    assert.deepEqual(await readSigningMarker(path), { fingerprint });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    await writeSigningMarker(identity, path);
    await assert.rejects(
      writeSigningMarker({ ...identity, fingerprint: 'A'.repeat(40) }, path),
      /지문이 달라/,
    );
    assert.deepEqual(await readSigningMarker(path), { fingerprint });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('malformed or secret-bearing project markers fail closed', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ouento-marker-test-'));
  const path = join(temporary, 'marker.json');
  try {
    for (const contents of [
      '{',
      'null',
      JSON.stringify({ fingerprint: [fingerprint] }),
      JSON.stringify({ fingerprint, keychain: '/private/path' }),
    ]) {
      await writeFile(path, contents);
      await assert.rejects(readSigningMarker(path), /서명 표식/);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a configured build cannot silently succeed when the sandbox hides its signing identity', async () => {
  for (const found of [null, { ...identity, fingerprint: 'A'.repeat(40) }]) {
    await assert.rejects(
      signLocalBuild(['build', '--bundles', 'app'], {
        env: {},
        platform: 'darwin',
        readMarker: async () => ({ fingerprint }),
        findIdentity: async () => found,
        run: async () => {
          throw new Error('must not reach signing or metadata');
        },
      }),
      /샌드박스 밖/,
    );
  }
  assert.strictEqual(validateSigningMarker(identity, { fingerprint }), identity);
  assert.throws(() => validateSigningMarker(identity, null), /signing:setup/);
  assert.equal(validateSigningMarker(null, null), null);
});

test('setup with an existing project marker never generates a replacement for a hidden identity', async () => {
  await assert.rejects(
    setupLocalSigning({
      platform: 'darwin',
      readMarker: async () => ({ fingerprint }),
      findIdentity: async () => null,
      run: async () => {
        throw new Error('must not create another certificate');
      },
    }),
    /샌드박스 밖/,
  );
});

test('missing legacy login preference accepts only a default login keychain', async () => {
  const run = async (_file, args) => {
    if (args[0] === 'login-keychain') throw Object.assign(new Error('no preference'), { code: 1 });
    return { stdout: '"/synthetic/login.keychain-db"\n', stderr: '' };
  };
  assert.equal(await loginKeychain(run), '/synthetic/login.keychain-db');
  await assert.rejects(
    loginKeychain(async (_file, args) => {
      if (args[0] === 'login-keychain')
        throw Object.assign(new Error('no preference'), { code: 1 });
      return { stdout: '"/synthetic/unrelated.keychain-db"\n', stderr: '' };
    }),
    /기본 키체인/,
  );
});

test('identity selection ignores unrelated and partial names and deduplicates tool sections', () => {
  const output = `1) ${fingerprint} "${signingName}"\n2) ${'A'.repeat(40)} "Unrelated"\n3) ${'B'.repeat(40)} "${signingName} old"\n1) ${fingerprint} "${signingName}"`;
  assert.deepEqual(parseIdentities(output), [fingerprint]);
  assert.throws(() => designatedRequirement('bad" or always'), /지문/);
  assert.equal(
    designatedRequirement(fingerprint),
    `identifier "${bundleIdentifier}" and certificate leaf = H"${fingerprint.toLowerCase()}"`,
  );
});

test('automatic local signing respects OS, CI and explicit signing choices', () => {
  assert.equal(wantsLocalSigning(['build', '--bundles', 'app'], 'darwin', {}), true);
  for (const platform of ['win32', 'linux'])
    assert.equal(wantsLocalSigning(['build'], platform, {}), false);
  for (const args of [
    ['dev'],
    ['build', '--no-bundle'],
    ['build', '--no-sign'],
    ['build', '--ci'],
    ['build', '--help'],
  ])
    assert.equal(wantsLocalSigning(args, 'darwin', {}), false);
  for (const env of [{ CI: '1' }, { APPLE_SIGNING_IDENTITY: 'Apple Development: Example' }])
    assert.equal(wantsLocalSigning(['build'], 'darwin', env), false);
});

test('app locations resolve debug, release and explicit architecture without shell parsing', () => {
  const options = { config, targetDirectory: '/synthetic/target', env: {} };
  assert.equal(
    localAppPath(['build', '--bundles', 'app', '--debug'], options),
    '/synthetic/target/debug/bundle/macos/Ouento.app',
  );
  assert.equal(
    localAppPath(['build', '--bundles=app'], options),
    '/synthetic/target/release/bundle/macos/Ouento.app',
  );
  assert.equal(
    localAppPath(['build', '-b', 'app', '-t', 'universal-apple-darwin'], options),
    '/synthetic/target/universal-apple-darwin/release/bundle/macos/Ouento.app',
  );
  assert.equal(
    localAppPath(['build', '-b', 'app', '-d'], {
      ...options,
      env: { CARGO_BUILD_TARGET: 'aarch64-apple-darwin' },
    }),
    '/synthetic/target/aarch64-apple-darwin/debug/bundle/macos/Ouento.app',
  );
});

test('ambiguous builds fail with explicit signing instructions rather than signing stale artifacts', () => {
  for (const args of [
    ['build'],
    ['build', '-b', 'app', 'dmg'],
    ['build', '--bundles=dmg'],
    ['build', '-b', 'app', '--config', 'other.json'],
    ['build', '-b', 'app', '--', '--profile', 'custom'],
    ['build', '-b', 'app', '--target', 'unknown'],
  ])
    assert.throws(
      () => localAppPath(args, { config, targetDirectory: '/target', env: {} }),
      /macos-signing/,
    );
});

test('setup reuses its existing identity without invoking any tool or regenerating keys', async () => {
  const result = await setupLocalSigning({
    platform: 'darwin',
    readMarker: async () => null,
    findIdentity: async () => identity,
    run: async () => {
      throw new Error('unexpected security mutation');
    },
  });
  assert.deepEqual(result, { ...identity, created: false });
});

test('setup keeps temporary keys private, imports only into login keychain and cleans up', async () => {
  let checks = 0;
  let temporary;
  const calls = [];
  const result = await setupLocalSigning({
    platform: 'darwin',
    readMarker: async () => null,
    findIdentity: async () => (checks++ === 0 ? null : identity),
    findKeychain: async () => identity.keychain,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (file.endsWith('openssl') && args[0] === 'req') {
        const key = args[args.indexOf('-keyout') + 1];
        temporary = dirname(key);
        assert.equal((await stat(temporary)).mode & 0o777, 0o700);
        const contents = await readFile(args[args.indexOf('-config') + 1], 'utf8');
        assert.match(contents, /extendedKeyUsage = critical,codeSigning/);
        await writeFile(key, 'SYNTHETIC TEST KEY');
        await writeFile(args[args.indexOf('-out') + 1], 'SYNTHETIC TEST CERTIFICATE');
      } else {
        assert.equal(file, '/usr/bin/security');
        assert.equal(args[0], 'import');
        assert.equal((await stat(args[1])).mode & 0o777, 0o600);
        assert.equal(args[args.indexOf('-k') + 1], identity.keychain);
        assert.equal(args[args.indexOf('-f') + 1], 'pemseq');
        assert.equal(args[args.indexOf('-t') + 1], 'agg');
        assert.ok(!args.includes('-P'));
        assert.ok(args.includes('-x'));
        assert.equal(args[args.indexOf('-T') + 1], '/usr/bin/codesign');
        assert.ok(!args.includes('-A'));
      }
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(result.created, true);
  assert.equal(calls.length, 2);
  await assert.rejects(access(temporary), { code: 'ENOENT' });
});

test('failed setup cleans only its own temporary directory and never falls back to ad hoc', async () => {
  let temporary;
  await assert.rejects(
    setupLocalSigning({
      platform: 'darwin',
      readMarker: async () => null,
      findIdentity: async () => null,
      findKeychain: async () => identity.keychain,
      run: async (_file, args) => {
        temporary = dirname(args[args.indexOf('-keyout') + 1]);
        throw new Error('synthetic generation failure');
      },
    }),
    /synthetic generation failure/,
  );
  await assert.rejects(access(temporary), { code: 'ENOENT' });
});

test('signing seals the app bundle and verifies both integrity and certificate-pinned identity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ouento-sign-test-'));
  try {
    const app = join(temporary, 'Ouento.app');
    await mkdir(app);
    const calls = [];
    await signApp(app, identity, async (file, args) => {
      calls.push({ file, args });
      if (file.endsWith('plutil')) return { stdout: bundleIdentifier, stderr: '' };
      if (args.includes('--display'))
        return {
          stdout: '',
          stderr: `Identifier=${bundleIdentifier}\ndesignated => ${designatedRequirement(fingerprint)}\n`,
        };
      return { stdout: '', stderr: '' };
    });
    const signing = calls.find(({ args }) => args.includes('--sign')).args;
    assert.equal(signing[signing.indexOf('--sign') + 1], fingerprint);
    assert.equal(signing[signing.indexOf('--identifier') + 1], bundleIdentifier);
    assert.equal(
      signing[signing.indexOf('--requirements') + 1],
      `=designated => ${designatedRequirement(fingerprint)}`,
    );
    assert.ok(!signing.includes('--deep'));
    const verify = calls.find(({ args }) => args.includes('--verify')).args;
    assert.ok(verify.includes('--strict') && verify.includes('--deep'));
    assert.equal(verify[verify.indexOf('-R') + 1], `=${designatedRequirement(fingerprint)}`);
    const before = calls.length;
    await assert.rejects(
      signApp(app, identity, async () => {
        calls.push({});
        return { stdout: 'com.unrelated.app', stderr: '' };
      }),
      /Ouento 식별자/,
    );
    assert.equal(calls.length, before + 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
