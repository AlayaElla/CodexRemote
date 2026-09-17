# 异步问答 IPC（PC 0.1.18）

ESP32 上回答 `request_user_input_async` 卡片时，PC 通过现有 `\\.\pipe\codex-ipc` 命名管道提交，原有设备消息格式保持一致。

## 提交路径

1. 验证设备连接、所选任务和原始问题仍然有效。
2. 从任务记录读取完整问题、原始 `sourceQuestionId` 和所属轮次；拒绝已回答、已结束或其他轮次的问题。
3. 将 `questionItemId`、`question`、`answer` 封装为 `<send_user_message_question_reply>` 消息。
4. 向任务拥有者发送 `thread-follower-steer-turn`（本地协议版本 1），包含 `input`、`restoreMessage`、`clientUserMessageId` 和空附件列表。请求目标使用原生协议字段 `targetClientId`。
5. 收到目标拥有者的成功回执后，等待任务记录出现同一问题 ID 和同一答案，才报告提交成功。

这条路径不再调用问答 UIA helper，也不唤起任务窗口。普通同步问答继续使用 `thread-follower-submit-user-input`。

## 边界

- 支持本地、运行中轮次的异步问答。
- 已结束轮次的旧问题返回明确提示，不自动创建新一轮任务。
- 连接变化、任务切换、IPC 拒绝和回答确认超时均返回错误，不自动重发答案。
- 客户端协议根据本机 Codex 26.911.7940.0 的卡片提交代码、IPC 注册表和路由实现核对。

## 验证

自动化测试覆盖：命名管道消息及目标路由、完整问题与答案编码、重复提交、回答先于 IPC 回执出现、已回答及已结束问题、跨轮次旧问题、错误回执、断连、任务切换，以及其他答案不能误确认成功。

2026-09-17：11 项相关测试通过，PC 构建通过。已解包最终 EXE，确认 `main.js`、`codex-desktop-ipc.js`、`codex-async-questions.js` 与源码一致，包内版本为 0.1.18。

产物：`build/pc/CodexRemote-Portable-0.1.18.exe`，68,590,915 bytes。SHA-256：`6a52b0fec73cc800ae7cd69b5b196c7167c7173891a79ea557b3352e038cb5ab`。

设备实测步骤：启动 0.1.18 PC 桥接，在运行中的任务生成异步问题，通过 ESP32 选择或填写答案，确认电脑不切换前台、任务收到对应答案、设备卡片显示已回答。自动化测试不代表已完成此项实测。
