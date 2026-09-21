const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { bundleVirtualMicroDriver, MAX_INSTALLER_BYTES } = require('../../scripts/bundle-virtual-micro-driver');
const {
  DRIVER_FILES,
  copyDriverPackage,
  validateDriverPackage
} = require('../../scripts/prepare-virtual-micro-driver');

const tempParent = fs.realpathSync(os.tmpdir());
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'codex-remote-virtual-micro-'));
// A PE header fixture, not a runnable program. Driver installation is never run.
function installerFixture(marker = 'installer') {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(240, 84);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt16LE(2, 156);
  bytes.writeUInt32LE(16, 196);
  bytes.write(marker, 400);
  return bytes;
}
try {
  const source = path.join(tempRoot, 'source');
  const destination = path.join(tempRoot, 'destination');
  fs.mkdirSync(source);
  assert.throws(() => validateDriverPackage(source), /incomplete/);

  for (const name of DRIVER_FILES) fs.writeFileSync(path.join(source, name), name);
  fs.writeFileSync(path.join(source, 'do-not-package.pdb'), 'debug');
  assert.equal(validateDriverPackage(source).length, 3);
  copyDriverPackage(source, destination);
  assert.deepEqual(fs.readdirSync(destination).sort(), [...DRIVER_FILES].sort());
  for (const name of DRIVER_FILES) assert.equal(fs.readFileSync(path.join(destination, name), 'utf8'), name);

  const rootDir = path.join(tempRoot, 'repo');
  const driverDir = path.join(rootDir, 'native/virtual-micro-driver/x64/Release/CodexRemoteVirtualMicro');
  const stageDir = path.join(tempRoot, 'stage');
  const payloadDir = path.join(stageDir, 'payload');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '0.1.1' }));
  copyDriverPackage(source, driverDir);
  const outputName = 'CodexRemote-VirtualMicro-Driver-0.1.1-x64.zip';
  assert.throws(() => bundleVirtualMicroDriver(payloadDir, rootDir), /Publish VirtualMicroDriverInstaller.exe/);
  const installerPath = path.join(payloadDir, 'VirtualMicroDriverInstaller.exe');
  const originalInstaller = installerFixture();
  fs.writeFileSync(installerPath, originalInstaller);
  fs.writeFileSync(path.join(payloadDir, 'coreclr.dll'), 'runtime');
  assert.throws(() => bundleVirtualMicroDriver(payloadDir, rootDir), /Unexpected installer payload: coreclr.dll/);
  assert(!fs.existsSync(path.join(rootDir, 'build/driver', outputName)));
  fs.unlinkSync(path.join(payloadDir, 'coreclr.dll'));
  fs.writeFileSync(path.join(payloadDir, 'VirtualMicroDriverInstaller.pdb'), 'debug');
  const first = bundleVirtualMicroDriver(payloadDir, rootDir);
  assert.equal(first.artifact, path.join(rootDir, 'build/driver', outputName));
  const firstBytes = fs.readFileSync(first.artifact);
  const zip = new AdmZip(firstBytes);
  const prefix = outputName.replace(/\.zip$/, '') + '/';
  assert.deepEqual(zip.getEntries().map((entry) => entry.entryName).sort(), [
    'VirtualMicroDriverInstaller.exe', 'README.md', ...DRIVER_FILES.map((file) => 'driver/' + file)
  ].map((file) => prefix + file).sort());
  for (const file of DRIVER_FILES) assert.deepEqual(zip.readFile(prefix + 'driver/' + file), fs.readFileSync(path.join(driverDir, file)));
  assert.deepEqual(zip.readFile(prefix + 'VirtualMicroDriverInstaller.exe'), originalInstaller);
  assert.match(zip.readAsText(prefix + 'README.md'), /安装（覆盖安装）/);
  assert.match(zip.readAsText(prefix + 'README.md'), /删除/);
  assert(!fs.existsSync(path.join(rootDir, 'build/pc')));

  fs.unlinkSync(path.join(stageDir, outputName));
  const archiveRoot = path.join(rootDir, 'build/archive');
  fs.mkdirSync(archiveRoot, { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, 'sentinel.txt'), 'leave me alone');
  const updatedInstaller = installerFixture('updated installer');
  fs.writeFileSync(installerPath, updatedInstaller);
  const second = bundleVirtualMicroDriver(payloadDir, rootDir);
  assert.deepEqual(new AdmZip(second.artifact).readFile(prefix + 'VirtualMicroDriverInstaller.exe'), updatedInstaller);
  assert.deepEqual(fs.readdirSync(archiveRoot), ['sentinel.txt'], 'replacement must not create a driver archive');
  assert.equal(fs.readFileSync(path.join(archiveRoot, 'sentinel.txt'), 'utf8'), 'leave me alone');
  const currentBytes = fs.readFileSync(second.artifact);
  function assertPreservesPackage(bytes, pattern) {
    fs.writeFileSync(installerPath, bytes);
    assert.throws(() => bundleVirtualMicroDriver(payloadDir, rootDir), pattern);
    assert.deepEqual(fs.readFileSync(second.artifact), currentBytes);
  }
  assertPreservesPackage(Buffer.alloc(MAX_INSTALLER_BYTES + 1), /exceeds 5 MiB/);
  assertPreservesPackage(Buffer.from('invalid exe'), /native Windows x64 GUI/);
  for (const offset of [68, 88, 156, 196, 312, 316]) {
    const bad = Buffer.from(updatedInstaller);
    bad.writeUInt32LE(offset === 312 || offset === 316 ? 1 : 0, offset);
    assertPreservesPackage(bad, /native Windows x64 GUI/);
  }
  const invalidOffset = Buffer.from(updatedInstaller);
  invalidOffset.writeUInt32LE(0xffffffff, 60);
  assertPreservesPackage(invalidOffset, /native Windows x64 GUI/);
  fs.writeFileSync(installerPath, updatedInstaller);
  fs.unlinkSync(path.join(driverDir, DRIVER_FILES[0]));
  assert.throws(() => bundleVirtualMicroDriver(payloadDir, rootDir), /incomplete/);
  assert.deepEqual(fs.readFileSync(second.artifact), currentBytes);
} finally {
  const resolved = fs.realpathSync(tempRoot);
  assert.equal(resolved, path.resolve(tempRoot));
  assert.equal(path.dirname(resolved), tempParent);
  assert.match(path.basename(resolved), /^codex-remote-virtual-micro-[A-Za-z0-9]+$/);
  assert(!fs.lstatSync(tempRoot).isSymbolicLink());
  fs.rmSync(resolved, { recursive: true, force: true });
}

console.log('virtual micro driver packaging tests passed');
