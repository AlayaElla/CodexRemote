# 当前控制方式（PC 0.1.19）

| 操作 | 实现 |
| --- | --- |
| 开始听写 | Micro PTT 按下 |
| 结束并发送 | 当前 Micro 布局的 CODEX 命令，再释放 PTT |
| 取消听写 | Micro 激活目标任务 → 一次 Esc → 释放 PTT |
| 切换任务 | Micro AG00–AG05，遵循单击/双击配置 |
| 新建任务 | Micro 任务槽位键唤起窗口 → 当前布局中的 NEW 命令 |
| 停止任务 | Micro 激活目标任务 → 两次 Esc |
| 已有任务的模型、推理强度、Fast | 任务定向 IPC，并等待参数状态确认 |
| 同步问答及审批 | 对应的任务定向 IPC |
| 运行中异步问答 | steer-turn IPC，使用原始问题 ID，等待答案记录确认 |
| 通用文字、API 转写文字 | Micro 激活目标任务 → 快捷键核对任务链接 → 聚焦主聊天 → Ctrl+V → Micro CODEX |
| 新任务身份绑定 | 提交首条消息后通过 Ctrl+Alt+L 读取当前任务链接，与新增任务 ID 匹配 |
| 桌面连接状态 | 现有 IPC 连接状态 |

新任务草稿使用 Codex 当前默认参数；绑定真实任务后才开放模型设置。`draftSettings: null` 和 `draftSettingsLoading: false` 是保留给当前固件的协议字段。

## 快捷键设置

在 Codex 设置中配置：

- Codex Micro：给一个命令键绑定“新建任务”（NEW），保留发送命令（CODEX）。
- 快捷键：保留 `copyDeeplink`（复制深层链接）为 **Ctrl+Alt+L**。
- 如需 PC 普通文字发送或 API 转写后发送：将 `focusMainChat`（聚焦主聊天）绑定为 **Ctrl+Shift+L**。该绑定不影响 Micro 原生按住说话。

文本发送会先检查绑定是否缺失、禁用或冲突。复制任务链接和粘贴操作仅在 Codex 前台窗口进行，剪贴板恢复前会核对序号，避免覆盖用户的新剪贴板内容。文字粘贴保留输入框原有内容。

## 代码结构

- `codex-controls.js`：Micro 任务控制和 IPC 参数设置。
- `codex-shortcuts.js`：绑定校验及有限的快捷键接口。
- `codex-keyboard-worker.js`：常驻 PowerShell 工作进程，传递结构化请求，超时后不重发。
- `codex-shortcuts.ps1`：Win32 前台窗口检查、键盘输入和剪贴板操作。
- `codex-desktop-ipc.js`：状态、设置、审批和问答协议。

UIA 控制器、后台定位、草稿菜单、问答点击脚本及相关运行分支已删除；打包仅包含当前使用的脚本。`test/control-transports.test.js` 检查生产代码，防止 UIA 依赖或旧模式分支重新进入。

按键成功仅表示投递完成，不等同于桌面操作完成；参数设置和问答继续采用各自的状态确认。

## 本次验证（2026-09-17）

- 44 项回归中 43 项通过；驱动打包测试因仓库原有缺失的 `scripts/bundle-virtual-micro-driver` 无法运行。
- 生产 JavaScript 和 PowerShell 语法检查通过，真实快捷键工作进程启动通过；没有发送实机操作按键。
- PC 0.1.19 构建成功，解包检查了 45 个生产脚本，未发现 UIA 代码和已删除的控制模块；本次修改的打包源码与工作区一致。
- 打包期间另有任务槽位模块改动（`codex-desktop-state.js` / `codex-micro-slots.js`），工作区改动已保留；当前包使用打包开始时的任务槽位实现，不包含之后的并行改动。
- 包：`build/pc/CodexRemote-Portable-0.1.19.exe`，68,565,270 字节；SHA-256：`e2bb933dd548b76d0f1ca9860a55cf5e233ae183aede6905afe7551488fe4c09`。
- 未重启桥接程序，未刷写固件，也未验证 ESP32 实机端到端延迟。
