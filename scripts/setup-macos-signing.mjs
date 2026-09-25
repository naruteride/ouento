import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  localIdentity,
  loginKeychain,
  readSigningMarker,
  runTool,
  signingName,
  validateSigningMarker,
  writeSigningMarker,
} from './macos-signing.mjs';

// A dedicated self-signed certificate pins local builds to the same private key.
// Apple TN2206 documents self-signed code-signing identities. This is not Developer ID.
export async function setupLocalSigning({
  run = runTool,
  platform = process.platform,
  findIdentity = localIdentity,
  findKeychain = loginKeychain,
  readMarker = readSigningMarker,
} = {}) {
  if (platform !== 'darwin') throw new Error('macOS에서 실행하세요.');
  const marker = await readMarker();
  const previous = validateSigningMarker(await findIdentity(run), marker, { requireMarker: false });
  if (previous) return { ...previous, created: false };
  const keychain = await findKeychain(run);
  const temporary = await mkdtemp(join(tmpdir(), 'ouento-local-signing-'));
  await chmod(temporary, 0o700);
  try {
    const config = join(temporary, 'openssl.cnf');
    const key = join(temporary, 'private.pem');
    const certificate = join(temporary, 'certificate.pem');
    const archive = join(temporary, 'identity.pem');
    await writeFile(
      config,
      `[req]\nprompt = no\ndistinguished_name = subject\nx509_extensions = codesign\n[subject]\nCN = ${signingName}\nO = Ouento Local Development\n[codesign]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = critical,codeSigning\nsubjectKeyIdentifier = hash\n`,
      { mode: 0o600 },
    );
    await run('/usr/bin/openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:3072',
      '-x509',
      '-nodes',
      '-days',
      '3650',
      '-sha256',
      '-keyout',
      key,
      '-out',
      certificate,
      '-config',
      config,
    ]);
    await chmod(key, 0o600);
    await writeFile(archive, Buffer.concat([await readFile(key), await readFile(certificate)]), {
      mode: 0o600,
    });
    // The PEM sequence is unencrypted only inside the private temporary directory.
    // Avoid platform-dependent PKCS12 empty-password handling. Import
    // into the encrypted login keychain as a non-extractable codesign-only key.
    // No trust-store, search-list, ACL partition-list or existing item is changed.
    await run('/usr/bin/security', [
      'import',
      archive,
      '-k',
      keychain,
      '-f',
      'pemseq',
      '-t',
      'agg',
      '-x',
      '-T',
      '/usr/bin/codesign',
    ]);
    const created = await findIdentity(run);
    if (!created) throw new Error('가져온 코드 서명 인증서와 개인 키를 확인하지 못했습니다.');
    return { ...created, created: true };
  } finally {
    // Delete only the directory created by this invocation, including failed setup.
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('사용법: npm run signing:setup');
    const identity = await setupLocalSigning();
    await writeSigningMarker(identity);
    console.log(
      identity.created
        ? 'Ouento 전용 로컬 개발 인증서를 로그인 키체인에 만들었습니다. 시스템 신뢰 설정은 변경하지 않았습니다.'
        : '기존 Ouento 로컬 개발 인증서를 계속 사용합니다.',
    );
    console.log(`인증서 지문: ${identity.fingerprint}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
