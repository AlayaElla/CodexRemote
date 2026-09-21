'use strict';

// The application-level debug service owns activation and reports its status.
// Individual Micro and voice connections only consume the verified inspector.
const WINDOWS_INSPECTOR_REQUIRED = 'Codex 调试连接尚未就绪，请查看桥接工具中“Codex 桥接监听”的调试状态。';
const MACOS_INSPECTOR_REQUIRED = 'Codex 调试连接不可用。请完全退出 Codex 后，运行 启动Codex.command，以启动参数开启本地调试，再连接桥接。桥接不会发送可能导致崩溃的 SIGUSR1；仍从 Codex 内存读取原生 Micro 六槽。';

module.exports = { WINDOWS_INSPECTOR_REQUIRED, MACOS_INSPECTOR_REQUIRED };
