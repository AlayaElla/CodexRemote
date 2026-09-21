'use strict';

// The application-level debug service owns activation and reports its status.
// Individual Micro and voice connections only consume the verified inspector.
const WINDOWS_INSPECTOR_REQUIRED = 'Codex 调试连接尚未就绪，请查看桥接工具中“Codex 桥接监听”的调试状态。';

module.exports = { WINDOWS_INSPECTOR_REQUIRED };
