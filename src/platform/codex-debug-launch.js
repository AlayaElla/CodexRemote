'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn: nodeSpawn } = require('node:child_process');

const PROCESS_QUERY = "Get-CimInstance Win32_Process | Where-Object { $_.SessionId -eq [System.Diagnostics.Process]::GetCurrentProcess().SessionId -and $_.Name -in @('ChatGPT.exe','Codex.exe') -and $_.CommandLine -notmatch '--type=' -and (-not $_.ExecutablePath -or $_.ExecutablePath -match '[\\\\/]OpenAI[.]Codex_[^\\\\/]+[\\\\/]app[\\\\/]') } | Select-Object ProcessId,ExecutablePath,@{Name='CreationTime';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress";
const PACKAGE_QUERY = "Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object PackageFullName,Version,InstallLocation | ConvertTo-Json -Compress";

function runPowerShell(script, exec = execFile, timeout = 10000) {
  return new Promise((resolve, reject) => exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(String(stdout || '').trim() || '[]')); }
      catch { reject(new Error('Codex 安装或进程信息无效。')); }
    }));
}

function rows(value) { return value == null || value === '' ? [] : Array.isArray(value) ? value : [value]; }

function versionParts(value) {
  const match = String(value || '').match(/^\s*(\d+(?:\.\d+){1,3})/);
  return match ? match[1].split('.').map(part => Number(part)) : [];
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function selectInstalledPackage(packages, pathApi = path.win32) {
  const candidates = rows(packages).filter(item => typeof item?.InstallLocation === 'string' && item.InstallLocation.trim())
    .map(item => ({ ...item, root: pathApi.resolve(item.InstallLocation) }));
  if (!candidates.length) throw new Error('未找到已安装的 Codex 应用包。');
  candidates.sort((a, b) => compareVersions(b.Version, a.Version));
  const highest = candidates.filter(item => compareVersions(item.Version, candidates[0].Version) === 0);
  const roots = [...new Set(highest.map(item => item.root.toLowerCase()))];
  if (roots.length !== 1) throw new Error('已安装的 Codex 应用包不唯一，无法安全启动。');
  return highest[0];
}

function executableWithin(root, candidate, pathApi = path.win32) {
  const absoluteRoot = pathApi.resolve(root), absoluteCandidate = pathApi.resolve(candidate);
  const relative = pathApi.relative(absoluteRoot, absoluteCandidate);
  return relative === pathApi.join('app', 'ChatGPT.exe')
    && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative);
}

function isFile(filePath, fsImpl = fs) {
  try { return fsImpl.statSync(filePath).isFile(); } catch { return false; }
}

async function closeCodexForRestart(target, options = {}) {
  if (!Number.isSafeInteger(target?.ProcessId) || target.ProcessId <= 0
      || typeof target.ExecutablePath !== 'string' || !target.ExecutablePath
      || !/^\d+$/.test(target.CreationTime || '')) throw new Error('无法确认运行中的 Codex 身份，请手动退出后再试。');
  const timeoutMs = options.exitTimeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Codex 退出等待时间无效。');
  const payload = Buffer.from(JSON.stringify(target), 'utf8').toString('base64');
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
function Finish($success, $message, $forcedExit = $false) {
  [pscustomobject]@{ success = $success; error = $message; forcedExit = $forcedExit } | ConvertTo-Json -Compress
  exit
}
try {
  $target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  $snapshot = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $target.ProcessId)
  if (-not $snapshot) { Finish $true $null }
  $owner = Invoke-CimMethod -InputObject $snapshot -MethodName GetOwnerSid
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($snapshot.ExecutablePath -ine $target.ExecutablePath -or
      $snapshot.CreationDate.ToUniversalTime().Ticks.ToString() -ne $target.CreationTime -or
      $snapshot.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
      $snapshot.CommandLine -match '--type=' -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $currentSid) {
    Finish $false 'Codex 进程身份已变化或不属于当前用户，请重新检测。'
  }
  $application = Get-Process -Id $target.ProcessId
  $null = $application.Handle
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexRestartWindows {
  private delegate bool Visitor(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", EntryPoint = "PostMessageW")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static int RequestClose(int processId) {
    int requested = 0;
    EnumWindows((window, state) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner == processId && IsWindowVisible(window) && PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero)) requested++;
      return true;
    }, IntPtr.Zero);
    return requested;
  }
}
'@
  if ($application.HasExited) { Finish $true $null }
  $requested = [CodexRestartWindows]::RequestClose($target.ProcessId)
  $forcedExit = $false
  if ($requested -eq 0 -or -not $application.WaitForExit(${timeoutMs})) {
    if (-not $application.HasExited) { $application.Kill(); $forcedExit = $true }
    if (-not $application.WaitForExit(5000)) {
      Finish $false 'Codex 尚未完全退出，请稍后重试。'
    }
  }
  Finish $true $null $forcedExit
} catch { Finish $false $_.Exception.Message }`;
  const result = await runPowerShell(script, options.execFile, timeoutMs + 10000);
  if (result?.success !== true) throw new Error(result?.error || 'Codex 退出失败，请重试。');
  return { forcedExit: result.forcedExit === true };
}

async function waitForSpawn(child) {
  if (!child || typeof child.once !== 'function') throw new Error('无法启动 Codex 应用。');
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      child.removeListener?.('spawn', onSpawn);
      child.removeListener?.('error', onError);
      error ? reject(error) : resolve();
    };
    const onSpawn = () => finish();
    const onError = error => finish(error);
    child.once('spawn', onSpawn);
    child.once('error', onError);
    // Test or alternate spawn adapters may return a child whose spawn already
    // completed; Node's ChildProcess exposes pid after that event.
    if (Number.isInteger(child.pid) && child.pid > 0) queueMicrotask(onSpawn);
  });
}

async function launchCodexForDebug(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') throw new Error('启动 Codex 调试连接目前仅支持 Windows。');
  const pathApi = options.path || path.win32;
  const getProcesses = options.listProcesses || (async () => rows(await runPowerShell(PROCESS_QUERY, options.execFile))
    .filter(item => Number.isInteger(item?.ProcessId)));
  const running = rows(await getProcesses());

  const getPackages = options.listPackages || (async () => rows(await runPowerShell(PACKAGE_QUERY, options.execFile)));
  const packages = rows(await getPackages());
  const installed = selectInstalledPackage(packages, pathApi);
  const executable = pathApi.resolve(installed.root, 'app', 'ChatGPT.exe');
  if (!executableWithin(installed.root, executable, pathApi)) throw new Error('Codex 启动路径无效。');
  const fileCheck = options.isFile || (value => isFile(value, options.fs || fs));
  if (!fileCheck(executable)) throw new Error('未找到已安装的 Codex 启动程序。');

  let forcedExit = false;
  if (running.length) {
    if (running.length !== 1) throw new Error('检测到多个 Codex 实例，请先关闭多余实例后重试。');
    const target = running[0];
    const registered = typeof target?.ExecutablePath === 'string' && packages.some(item =>
      typeof item?.InstallLocation === 'string' && item.InstallLocation.trim()
      && ['ChatGPT.exe', 'Codex.exe'].some(name => pathApi.resolve(item.InstallLocation, 'app', name).toLowerCase()
        === pathApi.resolve(target.ExecutablePath).toLowerCase()));
    if (!registered) throw new Error('无法确认运行中的 Codex 安装位置，请手动退出后再试。');
    const closed = await (options.closeProcess || (process => closeCodexForRestart(process, options)))(target);
    forcedExit = closed?.forcedExit === true;
    // Another concurrent launch must not cause the new flags to be forwarded
    // to an existing single instance.
    if (rows(await getProcesses()).length) throw new Error('Codex 尚未完全退出，请稍后重试。');
  }

  const spawn = options.spawn || nodeSpawn;
  let child;
  try {
    child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
      detached: true, windowsHide: true, shell: false, stdio: 'ignore'
    });
    await waitForSpawn(child);
  } catch (error) {
    throw new Error(`启动 Codex 失败：${String(error?.message || error).slice(0, 256)}`);
  }
  child.unref?.();
  return { success: true, restarted: running.length > 0, forcedExit, pid: Number.isInteger(child.pid) ? child.pid : null, executable };
}

module.exports = { launchCodexForDebug, closeCodexForRestart, selectInstalledPackage, executableWithin,
  compareVersions, PROCESS_QUERY, PACKAGE_QUERY };
