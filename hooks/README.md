# Codex Hook 接入

Bridge 运行时只监听 `127.0.0.1:<hookPort>`，不会读取、写入或删除
`~/.codex` 下的任何文件。Hook 配置必须由用户或部署程序显式安装。

在 `~/.codex/hooks.json` 中为以下事件注册 `codex-hook.js`：

- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PermissionRequest`
- `Stop`

每类 Hook 通过命令中的路由键声明事件类型。路由键只是 Hook 注册接口，
所有事件仍通过本地 HTTP 进入同一个 Codex 采集器；不存在 sessions 文件来源。
脚本也不依赖 Codex Desktop 是否在 stdin 中重复提供事件名：

```text
node "<absolute-path>\pc\hooks\codex-hook.js" user-prompt --port 7777
node "<absolute-path>\pc\hooks\codex-hook.js" pre --port 7777
node "<absolute-path>\pc\hooks\codex-hook.js" post --port 7777
node "<absolute-path>\pc\hooks\codex-hook.js" waiting --port 7777
node "<absolute-path>\pc\hooks\codex-hook.js" stop --port 7777
```

配置后在 Codex 中运行 `/hooks`，审核并信任命令。`PermissionRequest` 最长等待
九分钟；Bridge 不在线或超时时 Hook 返回空决定，Codex 会继续显示原生审批。
