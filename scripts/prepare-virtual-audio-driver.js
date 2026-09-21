'use strict';
const fs = require('fs');
const path = require('path');

const AUDIO_DRIVER_FILES = ['CodexRemoteVirtualAudio.sys', 'CodexRemoteVirtualAudio.inf', 'CodexRemoteVirtualAudio.cat'];
function audioDriverDirectory(root = path.resolve(__dirname, '..')) {
  return path.join(root, 'native/virtual-audio-driver/x64/Release/CodexRemoteVirtualAudio');
}
function validateAudioDriverPackage(directory) {
  return AUDIO_DRIVER_FILES.map(name => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size === 0) {
      throw new Error(`Audio driver package incomplete: ${file}. Build native/virtual-audio-driver first.`);
    }
    return file;
  });
}
function copyAudioDriverPackage(source, destination) {
  const files = validateAudioDriverPackage(source);
  fs.mkdirSync(destination, { recursive: true });
  files.forEach((file, index) => fs.copyFileSync(file, path.join(destination, AUDIO_DRIVER_FILES[index])));
}
if (require.main === module) {
  const source = process.argv[3] || audioDriverDirectory();
  if (process.argv[2]) copyAudioDriverPackage(source, process.argv[2]);
  else validateAudioDriverPackage(source);
  console.log('Audio driver payload files verified.');
}
module.exports = { AUDIO_DRIVER_FILES, audioDriverDirectory, validateAudioDriverPackage, copyAudioDriverPackage };
