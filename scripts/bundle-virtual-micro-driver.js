'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { DRIVER_FILES, driverDirectory, validateDriverPackage } = require('./prepare-virtual-micro-driver');
const { AUDIO_DRIVER_FILES, audioDriverDirectory, validateAudioDriverPackage } = require('./prepare-virtual-audio-driver');
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
function validateHashes(files, bytes, expectedHashes, label) {
  if (!expectedHashes) return;
  bytes.forEach((value, index) => {
    const actual = crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
    if (actual !== expectedHashes[files[index]]) throw new Error(`${label} payload changed after hash generation: ${files[index]}`);
  });
}

function bundleVirtualMicroDriver(payload, root = path.resolve(__dirname, '..'), source = driverDirectory(root), expectedHashes,
  audioSource = audioDriverDirectory(root), expectedAudioHashes) {
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
  validateHashes(DRIVER_FILES, driverBytes, expectedHashes, 'Micro driver');
  const audioFiles = validateAudioDriverPackage(audioSource);
  const audioBytes = audioFiles.map(file => fs.readFileSync(file));
  const audioLicense = path.join(root, 'native/virtual-audio-driver/LICENSE');
  if (!fs.existsSync(audioLicense) || !fs.lstatSync(audioLicense).isFile()) throw new Error('Audio third-party license is missing.');
  validateHashes(AUDIO_DRIVER_FILES, audioBytes, expectedAudioHashes, 'Audio driver');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) throw new Error('Invalid package version.');
  const name = `CodexRemote-Drivers-${version}-x64`;
  const zip = new AdmZip();
  zip.addFile(`${name}/VirtualMicroDriverInstaller.exe`, installer);
  zip.addFile(`${name}/README.md`, Buffer.from('解压后保持 driver-bundle 文件夹与 EXE 位于同一目录。运行 VirtualMicroDriverInstaller.exe，选择“安装（覆盖安装）”或“删除”。安装会校验固定 Micro 开发包和必须由 Microsoft 签名的音频内核包；不会修改 Secure Boot 或系统签名策略。\n', 'utf8'));
  zip.addFile(`${name}/THIRDPARTY-AUDIO-LICENSE.txt`, fs.readFileSync(audioLicense));
  DRIVER_FILES.forEach((file, i) => zip.addFile(`${name}/driver-bundle/micro/${file}`, driverBytes[i]));
  AUDIO_DRIVER_FILES.forEach((file, i) => zip.addFile(`${name}/driver-bundle/audio/${file}`, audioBytes[i]));
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
  if (!process.argv[2]) throw new Error('Usage: node bundle-virtual-micro-driver.js <payload> [micro-snapshot] [micro-hashes.json] [audio-snapshot] [audio-hashes.json]');
  const hashes = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')) : undefined;
  const audioHashes = process.argv[6] ? JSON.parse(fs.readFileSync(process.argv[6], 'utf8')) : undefined;
  console.log(bundleVirtualMicroDriver(process.argv[2], undefined, process.argv[3], hashes, process.argv[5], audioHashes).artifact);
}
module.exports = { bundleVirtualMicroDriver, MAX_INSTALLER_BYTES };
