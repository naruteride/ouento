// Development fixtures only. Product code is exercised by the Rust example, not reimplemented here.
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = '.cache/model-compatibility';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const portable = (value) => value.split(path.sep).join('/');

async function checkedPath(relative, { createDirectory = false } = {}) {
  if (
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error(`안전하지 않은 검사 경로: ${relative}`);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`검사 경로의 링크를 거부했습니다: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT' || !createDirectory) throw error;
      await mkdir(current);
    }
  }
  return current;
}

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`표본/출력의 링크를 거부했습니다: ${file}`);
    if (entry.isDirectory()) files.push(...(await filesUnder(file, relative + '/')));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`일반 파일이 아닌 표본: ${file}`);
  }
  return files.sort(order);
}

async function sourceProvenance(spec, names) {
  const archivePath = `.cache/downloads/${spec.archive}`;
  const archive = await readFile(await checkedPath(archivePath));
  if (sha256(archive) !== spec.sha256)
    throw new Error(`공식 SDK ZIP 체크섬이 다릅니다: ${spec.archive}`);
  const prefixes = names.map((name) => `${spec.directory}/Samples/Resources/${name}/`);
  const official = unzipSync(archive, {
    filter: (entry) =>
      !entry.name.endsWith('/') && prefixes.some((prefix) => entry.name.startsWith(prefix)),
  });
  const models = new Map();
  for (const name of names) {
    const source = `.cache/${spec.directory}/Samples/Resources/${name}`;
    const directory = await checkedPath(source);
    const files = await filesUnder(directory);
    const prefix = `${spec.directory}/Samples/Resources/${name}/`;
    const expected = Object.keys(official)
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length))
      .sort(order);
    if (JSON.stringify(files) !== JSON.stringify(expected))
      throw new Error(`공식 ZIP과 표본 파일 목록이 다릅니다: ${name}`);
    const tree = createHash('sha256');
    let byteCount = 0;
    for (const file of files) {
      const bytes = await readFile(path.join(directory, file));
      if (!Buffer.from(official[prefix + file]).equals(bytes))
        throw new Error(`공식 ZIP과 표본 바이트가 다릅니다: ${name}/${file}`);
      tree.update(`${file}\0${bytes.length}\0${sha256(bytes)}\n`);
      byteCount += bytes.length;
    }
    models.set(name, {
      path: source,
      archive: archivePath,
      url: spec.url,
      archiveSha256: sha256(archive),
      verifiedAgainstArchive: true,
      treeSha256: tree.digest('hex'),
      treeHashMethod: 'SHA256(sorted UTF-8 path + NUL + decimal bytes + NUL + file SHA256 + LF)',
      modelDefinitionSha256: sha256(await readFile(path.join(directory, `${name}.model3.json`))),
      fileCount: files.length,
      bytes: byteCount,
    });
  }
  return models;
}

async function main() {
  if (process.argv.length !== 2)
    throw new Error('이 검사는 인수 없이 고정된 공식 SDK 표본만 사용합니다.');
  await checkedPath(output, { createDirectory: true });
  for (const name of ['catalog.json', 'catalog.native.json']) {
    const file = path.join(root, output, name);
    try {
      await checkedPath(`${output}/${name}`);
      await rm(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const lock = JSON.parse(await readFile(path.join(root, 'docs/sdk-lock.json'), 'utf8'));
  const provenance = new Map([
    ...(await sourceProvenance(lock.cubism, [
      'Haru',
      'Hiyori',
      'Mao',
      'Mark',
      'Natori',
      'Ren',
      'Rice',
      'Wanko',
    ])),
    ...(await sourceProvenance(lock.motionSync, ['Kei_basic', 'Kei_vowels'])),
  ]);
  console.log('공식 ZIP SHA-256과 추출 표본 10묶음의 모든 원본 바이트가 일치합니다.');
  const installedCargo = path.join(
    homedir(),
    '.cargo/bin',
    process.platform === 'win32' ? 'cargo.exe' : 'cargo',
  );
  const cargo =
    process.env.CARGO ||
    (await lstat(installedCargo).then(
      () => installedCargo,
      () => 'cargo',
    ));
  const command = [
    'run',
    '--locked',
    '--offline',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--example',
    'model_compatibility',
  ];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(cargo, command, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      signal ? reject(new Error(`검사 종료 신호: ${signal}`)) : resolve(code),
    );
  });
  const catalog = JSON.parse(
    await readFile(await checkedPath(`${output}/catalog.native.json`), 'utf8'),
  );
  for (const model of catalog.models) {
    if (!provenance.has(model.name)) throw new Error(`알 수 없는 표본 이름: ${model.name}`);
    model.source = { ...model.source, ...provenance.get(model.name) };
    model.zip.sha256 = sha256(await readFile(await checkedPath(model.zipPath)));
    if (model.render) {
      const directory = `${output}/render/${model.name}`;
      const exported = await filesUnder(await checkedPath(directory));
      const allowed = model.render.assets.map((asset) => asset.path).sort(order);
      if (JSON.stringify(exported) !== JSON.stringify(allowed))
        throw new Error(`검증 목록과 출력 파일이 다릅니다: ${model.name}`);
      for (const asset of model.render.assets) {
        const bytes = await readFile(await checkedPath(`${directory}/${asset.path}`));
        if (bytes.length !== asset.bytes)
          throw new Error(`검증 자산 크기가 바뀌었습니다: ${model.name}/${asset.path}`);
        asset.sha256 = sha256(bytes);
      }
      model.render.url = model.render.url.split('/').map(encodeURIComponent).join('/');
      model.render.assetBaseUrl = model.render.assetBaseUrl
        .split('/')
        .map(encodeURIComponent)
        .join('/');
    }
  }
  catalog.generatedAt = new Date().toISOString();
  catalog.environment = {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
  };
  catalog.command = `node scripts/check-import-compatibility.mjs`;
  catalog.sampleBundleCount = catalog.models.length;
  catalog.characterFamilyCount = new Set(catalog.models.map((model) => model.family)).size;
  catalog.passedBundleCount = catalog.models.filter((model) => model.status === 'passed').length;
  catalog.status = exitCode === 0 && catalog.passedBundleCount === 10 ? 'passed' : 'failed';
  const destination = path.join(root, output, 'catalog.json');
  await writeFile(destination, JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
  console.log(
    `결과: ${catalog.status}, ${catalog.passedBundleCount}/${catalog.sampleBundleCount} 공식 샘플 묶음 (${catalog.characterFamilyCount}캐릭터 계열)`,
  );
  console.log(`manifest: ${portable(path.relative(root, destination))}`);
  console.log('브라우저 Core/표정/물리/립싱크, 독립 사용자 모델 10개 및 양 OS 검증과 구분합니다.');
  if (catalog.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`모델 가져오기 호환성 검사 실패: ${error.message}`);
  process.exitCode = 1;
});
