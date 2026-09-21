'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { DRIVER_FILES, driverDirectory, validateDriverPackage } = require('./prepare-virtual-micro-driver');
const MAX_INSTALLER_BYTES = 5 * 1024 * 1024;

function validateInstaller(bytes) {
  if (bytes.length > MAX_INSTALLER_BYTES) throw new Error('Installer exceeds 5 MiB.');
  const invalid = () => { throw new Error('Expected a native Windows x64 GUI installer.'); };
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) invalid();
  const pe = bytes.readUInt32LE(60);
  const optional = pe + 24;
  if (pe < 64 || optional + 240 > bytes.length) invalid();
  if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 ||
      bytes.readUInt16LE(pe + 20) < 240 || bytes.readUInt16LE(optional) !== 0x20b ||
      bytes.readUInt16LE(optional + 68) !== 2 || bytes.readUInt32LE(optional + 108) < 15 ||
      bytes.readUInt32LE(optional + 224) !== 0 || bytes.readUInt32LE(optional + 228) !== 0) invalid();
}
function bundleVirtualMicroDriver(payload, root = path.resolve(__dirname, '..'), source = driverDirectory(root), expectedHashes) {
  const executable = path.join(payload, 'VirtualMicroDriverInstaller.exe');
  if (!fs.existsSync(executable)) throw new Error('Publish VirtualMicroDriverInstaller.exe before bundling.');
  for (const name of fs.readdirSync(payload)) {
    if (name !== 'VirtualMicroDriverInstaller.exe' && name !== 'VirtualMicroDriverInstaller.pdb') {
      throw new Error(`Unexpected installer payload: ${name}`);
    }
  }
  const installer = fs.readFileSync(executable);
  validateInstaller(installer);
  const files = validateDriverPackage(source);
  const driverBytes = files.map(file => fs.readFileSync(file));
  if (expectedHashes) driverBytes.forEach((bytes, i) => {
    const actual = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
    if (actual !== expectedHashes[DRIVER_FILES[i]]) throw new Error(`Driver payload changed after hash generation: ${DRIVER_FILES[i]}`);
  });
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) throw new Error('Invalid package version.');
  const name = `CodexRemote-VirtualMicro-Driver-${version}-x64`;
  const zip = new AdmZip();
  zip.addFile(`${name}/VirtualMicroDriverInstaller.exe`, installer);
  zip.addFile(`${name}/README.md`, Buffer.from('解压后保持 driver 文件夹与 EXE 位于同一目录。运行 VirtualMicroDriverInstaller.exe，选择“安装（覆盖安装）”或“删除”。安装需管理员授权，会为固定开发包添加本机证书信任。安装完成后回到 Codex Remote 刷新驱动状态。\n', 'utf8'));
  DRIVER_FILES.forEach((file, i) => zip.addFile(`${name}/driver/${file}`, driverBytes[i]));
  const bytes = zip.toBuffer();
  const staged = path.join(path.dirname(payload), `${name}.zip`);
  fs.writeFileSync(staged, bytes);
  const output = path.join(root, 'build/driver');
  fs.mkdirSync(output, { recursive: true });
  const artifact = path.join(output, `${name}.zip`);
  const temporary = path.join(output, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, artifact);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { artifact };
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: node bundle-virtual-micro-driver.js <payload> [driver-snapshot] [hashes.json]');
  const hashes = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) : undefined;
  console.log(bundleVirtualMicroDriver(process.argv[2], undefined, process.argv[3], hashes).artifact);
}
module.exports = { bundleVirtualMicroDriver, MAX_INSTALLER_BYTES };
