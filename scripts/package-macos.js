'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const nativeRoot = path.join(root, 'native', 'macos-audio-bridge');
const stagingRoot = path.join(root, 'build', 'macos-native', 'esp32-audio');
const outputRoot = path.join(root, 'build', 'mac');
const dependenciesRoot = path.join(root, 'build', 'macos-deps');
const opusVersion = '1.6.1';
const macosDeploymentTarget = '13.0';
const opusArchiveHash = '6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1';
const opusArchiveUrl = `https://downloads.xiph.org/releases/opus/opus-${opusVersion}.tar.gz`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...options.env },
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} failed with exit code ${result.status}${details ? `: ${details}` : '.'}`);
  }
  return options.capture ? String(result.stdout).trim() : '';
}

function packageArchitecture(args = process.argv.slice(2)) {
  const unknown = args.find(argument => !/^--arch=(arm64|x64)$/.test(argument));
  if (unknown) throw new Error(`Unsupported argument: ${unknown}. Use --help for usage.`);
  if (args.length > 1) throw new Error("Specify --arch only once.");
  const value = args.find(argument => argument.startsWith('--arch='))?.slice(7) || process.arch;
  if (!['arm64', 'x64'].includes(value)) throw new Error(`Unsupported macOS package architecture: ${value}`);
  if (value !== process.arch) {
    throw new Error(`Native helper cross-compilation is not supported; run this package on a ${value} Mac.`);
  }
  return value;
}

function findHelper() {
  const candidates = [
    path.join(nativeRoot, '.build', 'release', 'CodexRemoteMacAudioBridge'),
    path.join(nativeRoot, '.build', `${packageArchitecture()}-apple-macosx`, 'release', 'CodexRemoteMacAudioBridge')
  ];
  const helper = candidates.find(candidate => fs.existsSync(candidate));
  if (!helper) throw new Error('The release CodexRemoteMacAudioBridge executable was not produced.');
  return helper;
}

function opusDependency(helper, environment) {
  const linked = run('otool', ['-L', helper], { capture: true })
    .split(/\r?\n/)
    .map(line => line.trim().split(' ')[0])
    .find(value => /libopus(?:\.\d+)*\.dylib$/.test(value));
  if (!linked) throw new Error('The macOS audio bridge is not linked to a dynamic libopus library.');

  if (path.isAbsolute(linked) && fs.existsSync(linked)) return { linked, source: linked };
  const libdir = environment.CODEX_REMOTE_OPUS_PREFIX
    ? path.join(environment.CODEX_REMOTE_OPUS_PREFIX, 'lib')
    : run('pkg-config', ['--variable=libdir', 'opus'], { capture: true, env: environment });
  const source = path.join(libdir, path.basename(linked));
  if (!fs.existsSync(source)) throw new Error(`Unable to locate ${path.basename(linked)} in ${libdir}.`);
  return { linked, source };
}

function localOpusEnvironment() {
  const prefix = path.join(
    dependenciesRoot, `opus-${opusVersion}-${packageArchitecture()}-macos${macosDeploymentTarget}`
  );
  const library = path.join(prefix, 'lib', 'libopus.0.dylib');
  const environment = {
    CODEX_REMOTE_OPUS_PREFIX: prefix,
    MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget,
    CFLAGS: [process.env.CFLAGS, `-mmacosx-version-min=${macosDeploymentTarget}`].filter(Boolean).join(' '),
    LDFLAGS: [process.env.LDFLAGS, `-mmacosx-version-min=${macosDeploymentTarget}`].filter(Boolean).join(' ')
  };
  const archive = path.join(dependenciesRoot, `opus-${opusVersion}.tar.gz`);
  const source = path.join(dependenciesRoot, `opus-${opusVersion}`);
  if (fs.existsSync(library)) {
    const loadCommands = run('otool', ['-l', library], { capture: true });
    if (loadCommands.includes(`minos ${macosDeploymentTarget}`)) return environment;
    console.log(`Rebuilding Opus because its deployment target is not macOS ${macosDeploymentTarget}.`);
    fs.rmSync(prefix, { recursive: true, force: true });
    if (fs.existsSync(path.join(source, 'Makefile'))) {
      run('make', ['-C', source, 'distclean'], { env: environment });
    }
  }

  fs.mkdirSync(dependenciesRoot, { recursive: true });
  if (!fs.existsSync(archive)) run('curl', ['--fail', '--location', '--output', archive, opusArchiveUrl]);
  const actualHash = run('shasum', ['-a', '256', archive], { capture: true }).split(/\s+/)[0];
  if (actualHash !== opusArchiveHash) {
    throw new Error(`Opus archive checksum mismatch: expected ${opusArchiveHash}, received ${actualHash}.`);
  }
  if (!fs.existsSync(path.join(source, 'configure'))) {
    run('tar', ['-xzf', archive, '-C', dependenciesRoot]);
  }
  run(path.join(source, 'configure'), [
    `--prefix=${prefix}`, '--enable-shared', '--disable-static',
    '--disable-extra-programs', '--disable-doc'
  ], { cwd: source, env: environment });
  run('make', ['-C', source, `-j${Math.max(1, os.cpus().length)}`], { env: environment });
  run('make', ['-C', source, 'install'], { env: environment });
  if (!fs.existsSync(library)) throw new Error('The local libopus build did not produce libopus.0.dylib.');
  return environment;
}

function opusEnvironment() {
  console.log(`Preparing verified Opus ${opusVersion} for macOS ${macosDeploymentTarget}.`);
  return localOpusEnvironment();
}

function stageNativeRuntime(environment) {
  const swiftArguments = ['build', '--package-path', nativeRoot, '-c', 'release'];
  if (environment.CODEX_REMOTE_OPUS_PREFIX) {
    swiftArguments.push(
      '-Xcc', `-I${path.join(environment.CODEX_REMOTE_OPUS_PREFIX, 'include')}`,
      '-Xlinker', `-L${path.join(environment.CODEX_REMOTE_OPUS_PREFIX, 'lib')}`,
      '-Xlinker', '-lopus'
    );
  }
  // SwiftPM does not always relink a system-library target when only its
  // search path changes. Clean first so the helper cannot retain an older
  // Homebrew or local Opus load path.
  run('swift', ['package', '--package-path', nativeRoot, 'clean'], { env: environment });
  run('swift', swiftArguments, { env: environment });
  const helper = findHelper();
  const opus = opusDependency(helper, environment);
  const stagedHelper = path.join(stagingRoot, 'CodexRemoteMacAudioBridge');
  const stagedLibrary = path.join(stagingRoot, path.basename(opus.source));

  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.copyFileSync(helper, stagedHelper);
  fs.copyFileSync(fs.realpathSync(opus.source), stagedLibrary);
  fs.copyFileSync(path.join(nativeRoot, 'THIRD-PARTY-NOTICES.md'), path.join(stagingRoot, 'THIRD-PARTY-NOTICES.md'));
  fs.copyFileSync(path.join(nativeRoot, 'OPUS-LICENSE.txt'), path.join(stagingRoot, 'OPUS-LICENSE.txt'));
  fs.chmodSync(stagedHelper, 0o755);
  fs.chmodSync(stagedLibrary, 0o755);

  const packagedLibrary = `@executable_path/${path.basename(stagedLibrary)}`;
  run('install_name_tool', ['-change', opus.linked, packagedLibrary, stagedHelper]);
  run('install_name_tool', ['-id', `@loader_path/${path.basename(stagedLibrary)}`, stagedLibrary]);
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', stagedLibrary]);
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', stagedHelper]);

  const remaining = run('otool', ['-L', stagedHelper], { capture: true });
  if (!remaining.includes(packagedLibrary)) {
    throw new Error('The staged audio bridge still references an external libopus library.');
  }
}

function main() {
  if (process.argv.slice(2).some(argument => ['--help', '-h'].includes(argument))) {
    console.log(`macOS 应用打包

用法：npm run package:mac -- [--arch=arm64|x64]
需要 Xcode 命令行工具，并先执行 npm ci。
架构默认使用当前机器架构，不支持交叉编译。
流程：校验并构建 Opus → 构建样式与音频桥 → 打包 DMG / ZIP。
输出：build/mac/
签名：通过 CSC_LINK 或 CSC_NAME 配置证书；未配置时使用临时签名。`);
    return;
  }
  packageArchitecture();
  if (process.platform !== 'darwin') throw new Error('Run macOS packaging on a Mac.');
  const environment = opusEnvironment();
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:css']);
  stageNativeRuntime(environment);

  fs.mkdirSync(outputRoot, { recursive: true });
  const arch = packageArchitecture();
  const builderArgs = [
    '--no-install', 'electron-builder', '--mac', 'dmg', 'zip', `--${arch}`,
    `--config.directories.output=${outputRoot}`,
    `--config.electronDist=${path.join(root, 'node_modules', 'electron', 'dist')}`
  ];
  run(process.platform === 'win32' ? 'npx.cmd' : 'npx', builderArgs, {
    env: process.env.CSC_LINK || process.env.CSC_NAME ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  });
  console.log(`macOS packages created in ${outputRoot}`);
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : error);
  console.error('macOS prerequisite: Xcode command-line tools. The packaging script builds a verified libopus locally.');
  process.exit(1);
}
