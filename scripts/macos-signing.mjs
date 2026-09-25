import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const signingName = 'Ouento Local Development (com.ouento.desktop)';
export const bundleIdentifier = 'com.ouento.desktop';
export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const signingMarkerPath = join(projectDirectory, '.local', 'macos-signing.json');
const manualHelp =
  '로컬 개발 빌드는 --bundles app을 사용하거나, 앱 경로를 확인한 뒤 node scripts/macos-signing.mjs <Ouento.app 경로>로 서명하세요.';

// Arguments are never printed: setup may invoke tools on temporary private-key files.
export function runTool(file, args, { input, ...options } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          const failure = new Error(`${basename(file)} 실행 실패: ${stderr.trim() || error.code}`);
          failure.code = error.code;
          reject(failure);
        } else resolveResult({ stdout, stderr });
      },
    );
    child.stdin.end(input);
  });
}

export function parseIdentities(output) {
  return [
    ...new Set(
      output
        .split('\n')
        .map((line) => line.match(/^\s*\d+\)\s+([a-f\d]{40})\s+"([^"]+)"/i))
        .filter((match) => match?.[2] === signingName)
        .map((match) => match[1].toUpperCase()),
    ),
  ];
}

export function designatedRequirement(fingerprint) {
  if (!/^[A-F\d]{40}$/i.test(fingerprint)) throw new Error('서명 인증서 지문이 잘못되었습니다.');
  return `identifier "${bundleIdentifier}" and certificate leaf = H"${fingerprint.toLowerCase()}"`;
}

export async function readSigningMarker(path = signingMarkerPath) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let marker;
  try {
    marker = JSON.parse(contents);
  } catch {
    throw new Error('로컬 서명 표식이 손상되었습니다. 자동으로 덮어쓰지 않습니다.');
  }
  if (
    contents.length > 1024 ||
    !marker ||
    Object.keys(marker).length !== 1 ||
    typeof marker.fingerprint !== 'string' ||
    !/^[A-F\d]{40}$/i.test(marker.fingerprint)
  )
    throw new Error('로컬 서명 표식 형식이 잘못되었습니다. 자동으로 덮어쓰지 않습니다.');
  return { fingerprint: marker.fingerprint.toUpperCase() };
}

export function validateSigningMarker(identity, marker, { requireMarker = true } = {}) {
  if (marker && (!identity || identity.fingerprint.toUpperCase() !== marker.fingerprint))
    throw new Error(
      '이 프로젝트에 설정한 서명 인증서를 키체인에서 확인할 수 없거나 지문이 달라졌습니다. 서명 없이 완료하지 않습니다. 샌드박스 밖에서 같은 인증서로 서명을 다시 시도하세요.',
    );
  if (requireMarker && identity && !marker)
    throw new Error(
      '기존 인증서의 프로젝트 표식이 없습니다. npm run signing:setup을 다시 실행하세요. 인증서는 재생성하지 않습니다.',
    );
  return identity;
}

export async function writeSigningMarker(identity, path = signingMarkerPath) {
  designatedRequirement(identity.fingerprint);
  const marker = await readSigningMarker(path);
  validateSigningMarker(identity, marker, { requireMarker: false });
  if (marker) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Only the public certificate fingerprint is persisted. Never a password or key path.
  await writeFile(
    path,
    `${JSON.stringify({ fingerprint: identity.fingerprint.toUpperCase() })}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    },
  );
}

export async function loginKeychain(run = runTool) {
  let result;
  let fallback = false;
  try {
    result = await run('/usr/bin/security', ['login-keychain', '-d', 'user']);
  } catch (error) {
    if (error.code !== 1) throw error;
    // Some macOS accounts have a login keychain but no legacy login-keychain
    // preference. Accept the default only when it is explicitly the login one.
    fallback = true;
    result = await run('/usr/bin/security', ['default-keychain', '-d', 'user']);
  }
  const value = (result.stdout || result.stderr).trim();
  const path = value.startsWith('"') ? JSON.parse(value) : value;
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('사용자 로그인 키체인 경로를 확인할 수 없습니다.');
  if (fallback && !['login.keychain', 'login.keychain-db'].includes(basename(path)))
    throw new Error('기본 키체인이 로그인 키체인이 아니므로 자동으로 변경하지 않습니다.');
  return path;
}

export async function localIdentity(run = runTool) {
  const keychain = await loginKeychain(run);
  const { stdout } = await run('/usr/bin/security', [
    'find-identity',
    '-p',
    'codesigning',
    keychain,
  ]);
  const identities = parseIdentities(stdout);
  if (identities.length > 1)
    throw new Error(
      'Ouento 개발 서명 인증서가 여러 개입니다. 자동으로 선택하거나 교체하지 않습니다.',
    );
  let pem;
  try {
    pem = (
      await run('/usr/bin/security', ['find-certificate', '-a', '-c', signingName, '-p', keychain])
    ).stdout;
  } catch (error) {
    // errSecItemNotFound (-25300) is returned by security as exit status 44.
    if (error.code === 44 && identities.length === 0) return null;
    throw error;
  }
  const certificates = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g),
  ]
    .map(([text]) => new X509Certificate(text))
    .filter((certificate) => certificate.subject.split('\n').includes(`CN=${signingName}`));
  const unique = new Map(certificates.map((certificate) => [certificate.fingerprint, certificate]));
  if (!unique.size && !identities.length) return null;
  if (unique.size !== 1 || identities.length !== 1)
    throw new Error(
      '기존 Ouento 인증서와 개인 키가 온전하지 않습니다. 자동으로 새 인증서를 만들지 않습니다.',
    );
  const certificate = [...unique.values()][0];
  const fingerprint = certificate.fingerprint.replaceAll(':', '').toUpperCase();
  if (
    fingerprint !== identities[0] ||
    certificate.issuer !== certificate.subject ||
    !certificate.verify(certificate.publicKey) ||
    !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.3') ||
    Date.now() < Date.parse(certificate.validFrom) ||
    Date.now() > Date.parse(certificate.validTo)
  )
    throw new Error(
      '기존 Ouento 코드 서명 인증서를 사용할 수 없습니다. 자동으로 교체하지 않습니다.',
    );
  return { fingerprint, keychain };
}

export function wantsLocalSigning(args, platform = process.platform, env = process.env) {
  const command = args.findIndex((arg) => !arg.startsWith('-'));
  return (
    platform === 'darwin' &&
    args[command] === 'build' &&
    !env.CI &&
    !env.APPLE_SIGNING_IDENTITY &&
    !args.some((arg) =>
      ['--ci', '--no-bundle', '--no-sign', '--help', '-h', '--version', '-V'].includes(arg),
    )
  );
}

export function localAppPath(args, { config, targetDirectory, env = process.env }) {
  const command = args.indexOf('build');
  const options = args.slice(command + 1);
  if (
    options.includes('--') ||
    options.some((arg) => /^(--config|--profile|--runner|-c|-r)(=|$)/.test(arg))
  )
    throw new Error(`사용자 지정 빌드의 앱 위치를 추측할 수 없습니다. ${manualHelp}`);
  let target = env.CARGO_BUILD_TARGET || '';
  let bundles;
  let debug = false;
  for (let index = 0; index < options.length; index++) {
    const arg = options[index];
    if (arg === '--debug' || arg === '-d') debug = true;
    if (arg === '--target' || arg === '-t') target = options[++index];
    else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    if (arg === '--bundles' || arg === '-b') {
      bundles = [];
      while (options[index + 1] && !options[index + 1].startsWith('-'))
        bundles.push(...options[++index].split(','));
    } else if (arg.startsWith('--bundles=')) bundles = arg.slice('--bundles='.length).split(',');
  }
  if (!bundles) {
    const configured = config.bundle?.targets ?? 'all';
    bundles = Array.isArray(configured) ? configured : [configured];
  }
  if (bundles.length !== 1 || bundles[0] !== 'app')
    throw new Error(`DMG를 만든 뒤 앱만 서명하면 DMG에는 서명이 반영되지 않습니다. ${manualHelp}`);
  if (target && !/^(aarch64|x86_64|universal)-apple-darwin$/.test(target))
    throw new Error(`대상 아키텍처의 앱 위치를 확인할 수 없습니다. ${manualHelp}`);
  const name = config.productName;
  if (
    config.identifier !== bundleIdentifier ||
    typeof name !== 'string' ||
    !name ||
    /[\\/\0]/.test(name) ||
    !isAbsolute(targetDirectory)
  )
    throw new Error(`Ouento 앱 경로와 식별자를 확인할 수 없습니다. ${manualHelp}`);
  return join(
    targetDirectory,
    target || '',
    debug ? 'debug' : 'release',
    'bundle',
    'macos',
    `${name}.app`,
  );
}

export async function signApp(appPath, identity, run = runTool) {
  const path = await realpath(appPath);
  if (!path.endsWith('.app')) throw new Error('서명할 .app 번들을 지정하세요.');
  const { stdout } = await run('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    join(path, 'Contents', 'Info.plist'),
  ]);
  if (stdout.trim() !== bundleIdentifier)
    throw new Error('Ouento 식별자가 아닌 앱은 로컬 개발 인증서로 서명하지 않습니다.');
  const requirement = designatedRequirement(identity.fingerprint);
  await run('/usr/bin/codesign', [
    '--force',
    '--sign',
    identity.fingerprint,
    '--keychain',
    identity.keychain,
    '--identifier',
    bundleIdentifier,
    '--requirements',
    `=designated => ${requirement}`,
    '--timestamp=none',
    path,
  ]);
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    '-R',
    `=${requirement}`,
    path,
  ]);
  const details = await run('/usr/bin/codesign', [
    '--display',
    '--verbose=4',
    '--requirements',
    '-',
    path,
  ]);
  const text = details.stdout + details.stderr;
  if (
    !text.includes(`Identifier=${bundleIdentifier}`) ||
    !text.includes('designated =>') ||
    !text.toLowerCase().includes(identity.fingerprint.toLowerCase()) ||
    /Signature=adhoc|Info\.plist=not bound|Sealed Resources=none|designated =>[^\n]*cdhash/.test(
      text,
    )
  )
    throw new Error(
      '서명 검사는 통과했지만 번들 서명 정보가 예상과 다릅니다. 앱을 실행하지 마세요.',
    );
  return path;
}

export async function signLocalBuild(
  args,
  {
    env = process.env,
    run = runTool,
    platform = process.platform,
    findIdentity = localIdentity,
    readMarker = readSigningMarker,
  } = {},
) {
  if (!wantsLocalSigning(args, platform, env)) return;
  const config = JSON.parse(
    await readFile(join(projectDirectory, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  if (!config.bundle?.active || config.bundle?.macOS?.signingIdentity) return;
  const marker = await readMarker();
  const identity = validateSigningMarker(await findIdentity(run), marker);
  if (!identity) {
    console.warn(
      '로컬 개발 서명 인증서가 없습니다. 권한을 빌드 간 유지하려면 npm run signing:setup을 실행하세요.',
    );
    return;
  }
  for (const candidate of [
    'src-tauri/tauri.macos.conf.json',
    'src-tauri/tauri.macos.conf.json5',
    'src-tauri/Tauri.macos.toml',
    '.cargo/config',
    '.cargo/config.toml',
    'src-tauri/.cargo/config',
    'src-tauri/.cargo/config.toml',
  ]) {
    try {
      await access(join(projectDirectory, candidate));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`추가 빌드 설정이 있어 앱 경로를 자동 추측하지 않습니다. ${manualHelp}`);
  }
  const metadata = await run(
    'cargo',
    [
      'metadata',
      '--no-deps',
      '--offline',
      '--format-version',
      '1',
      '--manifest-path',
      join(projectDirectory, 'src-tauri', 'Cargo.toml'),
    ],
    { cwd: join(projectDirectory, 'src-tauri'), env },
  );
  const appPath = localAppPath(args, {
    config,
    targetDirectory: JSON.parse(metadata.stdout).target_directory,
    env,
  });
  await signApp(appPath, identity, run);
  console.log(`로컬 개발 인증서로 번들 서명과 검증을 마쳤습니다: ${appPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'darwin') throw new Error('로컬 macOS 서명은 macOS에서 실행하세요.');
    if (process.argv.length !== 3)
      throw new Error('사용법: node scripts/macos-signing.mjs <Ouento.app 경로>');
    const marker = await readSigningMarker();
    const identity = validateSigningMarker(await localIdentity(), marker);
    if (!identity) throw new Error('먼저 npm run signing:setup을 실행하세요.');
    console.log(`서명 검증 완료: ${await signApp(process.argv[2], identity)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
