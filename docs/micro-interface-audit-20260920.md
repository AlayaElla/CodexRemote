# 无调试端口的 Micro 接口调查

调查日期：2026-09-20。对象：本机安装的 `OpenAI.Codex_26.915.4065.0_x64`。本次只读取安装包，并对正常运行的 Codex 做只读 IPC 查询；未开启 inspector、修改安装包、切换任务或刷写设备。

## 结论

在本版本已检查的路径中，未找到可供外部桥接直接读取 Micro 实际六槽位的接口。存在内部传递真实任务标识的服务，但没有发现对应的外部查询入口。这不等于证明所有版本或所有未公开路径均不存在这样的接口。

## 证据

| 路径 | 观察 | 对桥接的意义 |
| --- | --- | --- |
| `codex-micro-slot-signals-136f3c195ed1.js` | renderer 根据来源、固定任务/项目排序、注意状态、最近任务和自定义配置计算六槽位；结果含 threadKey、标题、状态和 selected | 数据库前六条无法严格替代实际结果 |
| `codex-micro-bridge-80b0c335ab43.js` | 调用 `codexMicro.updateAgentThreadKeys`，同时调用 `updateLighting` | 真实标识确实会传到主进程，并非只存在于 renderer |
| `main-LM8MUIFp.js` | Micro 窗口服务暴露 getState、权限查询、ownsPrimaryWindow、updateAgentThreadKeys、updateLighting；更新检查调用窗口身份 | 此服务绑定窗口上下文，不是外部 codex-ipc 查询服务 |
| 同上，CodexMicroServiceManager | agentThreadKeys、agentKeyKinds 缓存在内存，参与原生按键处理；getState 转交设备服务 | 没有在已检查实现中发现槽位读取 getter |
| `service-C6nm9ayu.js` 与 device-kit-oai | HID 写入按槽位的颜色、亮度、效果等；v.oai.thstatus 的 id 是灯效槽位编号 | HID 包不包含任务 UUID 和标题，监听虚拟驱动不能补出这些字段 |
| `src-C3YaUE83.js` | 外部命名管道按请求方法寻找处理客户端；线程协议含 owner discovery、消息流和控制等 | 与窗口内部 codexMicro 服务是不同入口 |

扫描安装包内非 node_modules 的 JavaScript，`updateAgentThreadKeys` 仅出现在上述 main 和 micro bridge 两个文件；未匹配到 `getAgentThreadKeys`。

## 本机 IPC 探测

通过现有 CodexDesktopIpc 客户端连接 `\\.\pipe\codex-ipc`，初始化成功。没有订阅或输出聊天内容。

- `codexMicro.getState`：`resultType=error, error=no-client-found`。
- `codexMicro.getAgentThreadKeys`：`resultType=error, error=no-client-found`。

这两个方法名是用于验证直接寻址可能性的候选查询，不是已确认存在的外部协议。结果只说明这两个查询没有处理客户端，不能单凭它们证明全部 Micro 接口不存在。

## 可行边界

1. 严格镜像实际 Micro 六槽位：现有读取方式仍需进入 Codex 进程内获取状态；本次没有找到免调试、免注入的替代接口。
2. 自定义静态任务分配：可以进一步验证持久化的 `codex-micro-custom-agent-assignments`；只适合明确分配了任务的槽位，不能覆盖 recent、priority、命令型槽位和实时选中状态。
3. 独立任务列表：可以用本地任务目录配合 IPC，但必须按 hostId/threadId 控制，不能把列表位置当成 Micro 槽位编号；未加载任务的订阅也需另行解决。
4. 给安装包加只读导出服务：理论上可以把已有内存数据暴露给桥接，但属于修改客户端并需随升级维护，不是发现了现成接口。本次未实施。

公开文档核查：[Codex Micro](https://developers.openai.com/zh-Hans/docs/features/codex-micro)。该页面介绍设备设置和任务来源，没有提供供第三方查询槽位的 API 说明。

本次没有改动桥接生产逻辑，未完成 ESP32 同步恢复或设备 E2E 验证。
