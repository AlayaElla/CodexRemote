const path = require('path');
const { spawnSync } = require('child_process');

exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const result = spawnSync('codesign', [
    '--deep', '--force', '--sign', '-', '--timestamp=none', appPath
  ], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Ad-hoc signing failed with exit code ${result.status}.`);
};
