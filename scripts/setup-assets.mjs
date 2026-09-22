import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { patchCubismShaders } from './patch-cubism-shaders.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, 'docs/sdk-lock.json'), 'utf8'));
const offline = process.argv.includes('--offline');
const verifyOnly = process.argv.includes('--verify');
const unknown = process.argv.slice(2).filter((arg) => !['--offline', '--verify'].includes(arg));
if (unknown.length)
  throw new Error(`알 수 없는 옵션: ${unknown.join(', ')}. 지원 옵션: --offline, --verify`);
const cache = path.join(root, '.cache', 'downloads');
const outputFiles = new Map();
const maxDownloadBytes = 64 * 1024 * 1024;
const maxExtractedBytes = 512 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function safeDirectory(directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`프로젝트 밖 쓰기를 거부했습니다: ${directory}`);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`디렉터리 대신 링크 또는 파일이 있습니다: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
}

async function safeWrite(file, bytes, record = false) {
  await safeDirectory(path.dirname(file));
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw new Error(`심볼릭 링크 쓰기를 거부했습니다: ${file}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(file, bytes);
  if (record) outputFiles.set(path.relative(root, file).split(path.sep).join('/'), digest(bytes));
}

async function acquire(spec, filename) {
  const location = path.join(cache, filename);
  try {
    const cached = await readFile(location);
    if (digest(cached) !== spec.sha256)
      throw new Error(
        `캐시 SHA-256이 일치하지 않습니다: ${filename}. 신뢰할 수 있는 공식 원본을 다시 준비하세요.`,
      );
    console.log(`검증된 캐시: ${filename}`);
    return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (offline) throw new Error(`오프라인 캐시에 파일이 없습니다: .cache/downloads/${filename}`);
  }
  console.log(`공식 배포 파일 받는 중: ${filename}`);
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body)
    throw new Error(`${filename} 다운로드 실패 (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length') || 0) > maxDownloadBytes)
    throw new Error(`다운로드 크기 제한 초과: ${filename}`);
  const chunks = [];
  let bytesRead = 0;
  for await (const chunk of response.body) {
    bytesRead += chunk.length;
    if (bytesRead > maxDownloadBytes) throw new Error(`다운로드 크기 제한 초과: ${filename}`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== spec.sha256)
    throw new Error(
      `공식 파일의 SHA-256이 고정 값과 다릅니다: ${filename}. 버전/배포 변경을 먼저 검토하세요.`,
    );
  await safeDirectory(cache);
  const temporary = `${location}.partial`;
  await safeWrite(temporary, bytes);
  await rename(temporary, location);
  return bytes;
}

async function extract(bytes, spec) {
  let entries = 0;
  let totalSize = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      entries += 1;
      totalSize += entry.originalSize;
      if (entries > 10_000 || totalSize > maxExtractedBytes)
        throw new Error('SDK ZIP의 파일 수 또는 해제 크기가 제한을 넘었습니다.');
      const name = entry.name;
      if (
        name.includes('\\') ||
        name.includes('\0') ||
        name.startsWith('/') ||
        /^[A-Za-z]:/.test(name) ||
        name.split('/').some((part) => part === '..')
      )
        throw new Error(`안전하지 않은 ZIP 경로: ${name}`);
      if (!name.startsWith(`${spec.directory}/`)) return false;
      return !name.endsWith('/');
    },
  });
  for (const [name, content] of Object.entries(files))
    await safeWrite(path.join(root, '.cache', ...name.split('/')), content);
  const directory = path.join(root, '.cache', spec.directory);
  await lstat(path.join(directory, 'LICENSE.md'));
  return directory;
}

async function copyTree(source, target) {
  await safeDirectory(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`SDK 디렉터리에 심볼릭 링크가 있습니다: ${from}`);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await safeWrite(to, await readFile(from), true);
  }
}

async function verifyPreparedFiles() {
  const manifest = JSON.parse(
    await readFile(path.join(root, '.cache/assets-manifest.json'), 'utf8'),
  );
  if (manifest.lockSha256 !== digest(await readFile(path.join(root, 'docs/sdk-lock.json'))))
    throw new Error('SDK 고정 파일이 바뀌었습니다. npm run assets:setup으로 다시 준비하세요.');
  let count = 0;
  for (const [file, checksum] of Object.entries(manifest.files)) {
    const relative = path.relative(root, path.resolve(root, file));
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('SDK 검증 목록에 잘못된 경로가 있습니다.');
    if (digest(await readFile(path.join(root, file))) !== checksum)
      throw new Error(`준비한 자산이 변경되었습니다: ${file}`);
    count += 1;
  }
  console.log(`SDK 자산 무결성 확인: ${count}개 파일`);
}

async function main() {
  if (verifyOnly) return verifyPreparedFiles();
  console.log(
    'Ouento 로컬 개발용 SDK와 샘플을 준비합니다. 라이선스와 배포 조건: docs/sdk-versions.md',
  );
  const sources = [lock.cubism, lock.motionSync];
  const archives = [];
  for (const source of sources) archives.push(await acquire(source, source.archive));
  const compatibility = [];
  for (const source of lock.compatibilityTypes)
    compatibility.push(await acquire(source, source.file));
  // 모든 다운로드의 해시를 확인한 뒤 기존 준비 경로를 갱신한다.
  const web = await extract(archives[0], lock.cubism);
  const motion = await extract(archives[1], lock.motionSync);
  for (const [source, target] of [
    [path.join(web, 'Framework'), 'vendor/cubism-framework'],
    [path.join(web, 'Core'), 'vendor/cubism-core'],
    [path.join(web, 'Framework/Shaders'), 'public/vendor/shaders'],
    [path.join(motion, 'Framework'), 'vendor/motionsync'],
    [path.join(motion, 'Core'), 'vendor/motionsync-core'],
    [path.join(web, 'Samples/Resources/Mao'), 'public/models/Mao'],
    [path.join(web, 'Samples/Resources/Haru'), 'public/models/Haru'],
    [path.join(motion, 'Samples/Resources/Kei_vowels'), 'public/models/Kei_vowels'],
  ])
    await copyTree(source, path.join(root, target));

  for (const filename of [
    'live2dcubismcore.min.js',
    'live2dcubismcore.d.ts',
    'LICENSE.md',
    'RedistributableFiles.txt',
  ])
    await safeWrite(
      path.join(root, 'public/vendor/cubism-core', filename),
      await readFile(path.join(web, 'Core', filename)),
      true,
    );
  for (const filename of [
    'live2dcubismmotionsynccore.min.js',
    'live2dcubismmotionsynccore.d.ts',
    'LICENSE.md',
    'RedistributableFiles.txt',
  ])
    await safeWrite(
      path.join(root, 'public/vendor/motionsync-core/CRI', filename),
      await readFile(path.join(motion, 'Core/CRI', filename)),
      true,
    );
  for (const filename of ['LICENSE.md', 'CRIWARELOGO_1.png'])
    await safeWrite(
      path.join(root, 'public/vendor/motionsync-core', filename),
      await readFile(path.join(motion, 'Core', filename)),
      true,
    );
  // 이전 개발용 전체 복사에서 남을 수 있는 파일. Core 재배포 목록에 없는 map을 공개 출력에서 제외한다.
  await rm(path.join(root, 'public/vendor/cubism-core/live2dcubismcore.js.map'), { force: true });

  for (let index = 0; index < lock.compatibilityTypes.length; index += 1)
    await safeWrite(
      path.join(root, 'vendor/cubism-framework/src/type', lock.compatibilityTypes[index].file),
      compatibility[index],
      true,
    );
  const pluginFile = path.join(root, 'vendor/motionsync/src/cubismmotionsyncdata.ts');
  const original = await readFile(pluginFile, 'utf8');
  const before = '.isEqual(cubismParameterList.at(cubismParameterIndex).id)';
  const after = '.isEqual(cubismParameterList.at(cubismParameterIndex).id.s)';
  if (original.split(before).length !== 2)
    throw new Error('MotionSync 호환 패치의 원본 위치가 일치하지 않습니다. SDK 조합을 검토하세요.');
  await safeWrite(pluginFile, original.replace(before, after), true);

  const shaderFile = path.join(root, lock.shaderLifecyclePatch.file);
  const shaderOriginal = await readFile(shaderFile, 'utf8');
  if (digest(shaderOriginal) !== lock.shaderLifecyclePatch.originalSha256)
    throw new Error('Cubism 셰이더 원본 SHA-256이 수명 패치의 고정 값과 다릅니다.');
  const shaderPatched = patchCubismShaders(shaderOriginal);
  if (digest(shaderPatched) !== lock.shaderLifecyclePatch.patchedSha256)
    throw new Error('Cubism 셰이더 패치 결과 SHA-256이 고정 값과 다릅니다.');
  await safeWrite(shaderFile, shaderPatched, true);

  for (const [from, to] of [
    [path.join(web, 'LICENSE.md'), 'public/vendor/licenses/cubism-sdk-LICENSE.md'],
    [path.join(web, 'NOTICE.md'), 'public/vendor/licenses/cubism-sdk-NOTICE.md'],
    [path.join(web, 'Framework/LICENSE.md'), 'public/vendor/licenses/cubism-framework-LICENSE.md'],
    [path.join(motion, 'LICENSE.md'), 'public/vendor/licenses/motionsync-plugin-LICENSE.md'],
    [path.join(motion, 'NOTICE.md'), 'public/vendor/licenses/motionsync-plugin-NOTICE.md'],
    [path.join(web, 'LICENSE.md'), 'public/models/Mao/SDK-LICENSE.md'],
    [path.join(web, 'LICENSE.md'), 'public/models/Haru/SDK-LICENSE.md'],
    [path.join(motion, 'LICENSE.md'), 'public/models/Kei_vowels/SDK-LICENSE.md'],
  ])
    await safeWrite(path.join(root, to), await readFile(from), true);

  const manifest = {
    schemaVersion: 1,
    lockSha256: digest(await readFile(path.join(root, 'docs/sdk-lock.json'))),
    files: Object.fromEntries([...outputFiles].sort(([a], [b]) => a.localeCompare(b))),
  };
  await safeWrite(
    path.join(root, '.cache/assets-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `개발 자산 준비 완료: ${outputFiles.size}개 파일. npm run check로 호환성을 검사하세요.`,
  );
  console.log('개발용 준비는 배포 허가나 두 OS 실기 검증을 의미하지 않습니다.');
}

main().catch((error) => {
  console.error(`자산 준비 실패: ${error.message}`);
  process.exitCode = 1;
});
