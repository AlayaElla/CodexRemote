'use strict';
const fs = require('fs');
const path = require('path');

const DRIVER_FILES = ['CodexRemoteVirtualMicro.dll', 'CodexRemoteVirtualMicro.inf', 'codexremotevirtualmicro.cat'];
function driverDirectory(root = path.resolve(__dirname, '..')) {
  return path.join(root, 'native/virtual-micro-driver/x64/Release/CodexRemoteVirtualMicro');
}
function validateDriverPackage(directory) {
  return DRIVER_FILES.map(name => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error(`Driver package incomplete: ${file}. Build native/virtual-micro-driver/scripts/build.ps1 first.`);
    }
    return file;
  });
}
function copyDriverPackage(source, destination) {
  const files = validateDriverPackage(source);
  fs.mkdirSync(destination, { recursive: true });
  files.forEach((file, index) => fs.copyFileSync(file, path.join(destination, DRIVER_FILES[index])));
}
if (require.main === module) {
  const source = driverDirectory();
  if (process.argv[2]) copyDriverPackage(source, process.argv[2]);
  else validateDriverPackage(source);
  console.log('Driver payload files verified.');
}
module.exports = { DRIVER_FILES, driverDirectory, validateDriverPackage, copyDriverPackage };
