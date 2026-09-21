# macOS 调试启动器

启动器以 `--inspect=127.0.0.1:9229` 启动 Codex，供 Codex Remote 读取原生 Micro 六槽位和连接本机控制接口。需要 Node.js 22 或更新版本。

## 使用

1. 保存工作，完全退出 Codex 和 Codex Remote。
2. 双击 `scripts/启动Codex.command`。
3. 显示“本地调试接口已验证”后，打开 Codex Remote。
4. 在桥接中连接 Micro，等待设备同步任务。
5. 启动器显示完成提示后，按回车关闭其终端窗口；Codex 保持运行。

`.command` 是独立启动文件，可单独复制到桌面。关闭 Codex 后调试端口随进程关闭；从普通应用图标启动不会附加调试参数。

## 参数

```sh
node scripts/start-codex-with-inspector-macos.js --help
node scripts/start-codex-with-inspector-macos.js --check-only
node scripts/start-codex-with-inspector-macos.js --app=/Applications/Codex.app
```

无参数双击启动时，脚本会等待回车并尝试关闭自身所在的单标签 Terminal 窗口。多标签窗口或自动关闭受限时，请按 `⌘W`。带参数运行或非交互调用不等待回车。

`.command` 支持相同参数。`--check-only` 输出应用路径、版本、运行状态及端口占用情况，不启动应用。

## 启动条件

- 应用的 bundle ID 必须为 `com.openai.codex`。
- Codex、Codex Remote 均须退出，9229 端口须空闲。
- 启动后检查监听地址、端口所属 PID 和调试连接中的进程身份。
- 启动器只关闭自己的调试连接，不停止进程、不修改应用文件、不自动打开桥接。
- macOS 桥接只连接已有调试接口，不通过 `SIGUSR1` 激活运行中的 Codex。

接口验证成功表示调试连接可用；任务同步和语音功能仍取决于当前 Codex 版本的兼容性。调试接口启动失败时显示错误。

## 生成独立文件

修改 JavaScript 源码后执行：

```sh
node scripts/build-macos-inspector-launcher.js
```
