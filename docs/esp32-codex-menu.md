# ESP32 Codex 菜单与真实状态同步

电脑桥接 0.1.9 与对应 ESP32 固件提供「任务 / 模型 / 连接」菜单。任务标题、运行状态、模型、推理强度和 Fast 从本机 Codex 的任务状态流读取。屏幕光圈可在连接页关闭，偏好保存在设备上。

## 使用

1. 启动 Codex 和新版 Codex Remote，等待虚拟 Micro 连接就绪。
2. Codex Micro 的任务来源支持「最近」「置顶」「优先」和「自定义」。自动模式读取本机真实任务元数据；自定义模式读取六个实际绑定。
3. ESP32 连接电脑后，打开 Codex 菜单并选择任务。自动模式按任务 ID 打开目标；自定义模式按电脑配置发送一次或两次 Micro 任务键。列表重排后仍按任务身份处理请求。
4. 模型页显示该任务的真实设置。修改会等待电脑回报；尚未同步或不支持的项目不可操作。
5. 模型选项为 GPT-6 Astra、GPT-5.6 Sol、Terra、Luna；推理强度为轻、中、高、极高、Ultra，并按当前模型支持情况显示。Luna 当前显示前四档。点击或拖动滑动条都在松手后提交一次，等待电脑实际确认。
6. 「新建任务」先恢复并唤起 Codex 窗口，确认它处于前台后发送新建快捷键，默认是 `Ctrl+N`。任务来源和六个槽位的占用情况不影响新建。未能取得前台焦点时会报错，不发送按键。新建后可以直接按住说话，松开自动请求发送。
7. 新建输入页的草稿尚无可追踪的任务 ID。首次发送后，从任务列表选中该任务再继续操作；自定义模式需先完成任务绑定。新建按钮会在首次发送请求后恢复可用。
8. 空闲任务显示「按住说话」，执行中显示「按住引导」。运行中也能录音，松开自动请求引导；长按旁边独立的停止按钮可停止任务。

## 通道

| 操作 | 通道 | 结果依据 |
| --- | --- | --- |
| 六个任务切换 | 自动来源按任务 ID 打开；自定义来源使用 Micro AG00–AG05 | 记录请求目标，任务状态另外同步 |
| 新建任务 | 确认 Codex 前台焦点后发送快捷键 | `submitted_to_keyboard` 表示按键已投递，不表示新任务已经产生编号或绑定 |
| 指定模型 | 本机 Codex IPC 的任务设置通道 | 指定任务的设置流回读匹配 |
| 推理强度 | 已配置的 Micro 增减键/推理编码器；否则任务设置通道 | 每一步或绝对设置均等待回读 |
| Fast | 已配置的 Micro Fast 键；否则任务设置通道 | 真实 Fast 值回读，超时不重放切换 |
| 标题、状态、设置 | 本机 Codex IPC 订阅；绑定和能力来自本机配置 | 仅发送精简元数据到 ESP32 |

听写结束时，PC 先排空音频，再请求原生提交，最后释放 PTT。空闲任务使用当前 Micro 布局中的 `composer.submit`；执行中如果 Codex 默认 follow-up 是 queue，则定位原生输入框并使用其引导快捷键（Enter 模式为 Ctrl+Enter，其他已支持模式为 Ctrl+Shift+Enter）。默认 follow-up 为 steer 时直接使用 Micro 提交。输入框定位只查找控件并聚焦，不读取或注入听写文字。取消、无设备音频、目标变化或布局缺少提交键时不会自动发送。

## 协议

电脑发送 `codex_state`，版本为 `1`，包括 `revision`、`connected`、`source`、`selectedSlot`、六个 `slots`、`models`、`capabilities`、`streamId` 和当前任务的 `conversation`。槽位字段为 `slot / hostId / threadId / title / state / synced / model / effort / serviceTier / fast / updatedAt`。状态包括 `unbound / unknown / idle / working / waiting / error`。`fast: null` 表示未知。

`conversation` 带 `hostId`、`threadId`、`ready` 与最新三条消息；每个任务的消息分别保留，只发送选中任务的历史。菜单打开时同一任务的消息继续接收，关闭后呈现最新内容。

设备发送示例：

```json
{"type":"codex_action","request_id":"esp-boot123-42","action":"set_fast","slot":0,"thread_id":"真实任务编号","host_id":"local","fast":true}
```

支持 `select_task / new_task / set_model / set_effort / set_fast`。除新建外必须携带所操作任务的真实身份。结果为同一 `request_id` 的 `codex_action_result`；只有设置回读匹配后，设置修改才返回 `success: true`。`delivery` 区分 Micro、键盘、本机 IPC 与桌面请求，`outcome` 区分已请求和已确认。

同一编号的重试不会重复发送按键。断线后取消排队操作，结果不会发送到替换连接。语音输入期间暂停任务和模型操作，避免输入过程中切换目标。绑定变化会清除旧控制目标。

## 验证范围

协议、按键编码、重试去重、任务身份隔离、断线清理、状态解析、菜单逻辑和构建通过情况见本次交付记录。真实只读订阅已在本机 Codex 验证。刷入新固件后的触摸布局、实体屏幕光圈、六槽切换和实际设置写入仍需联机验收。

自动来源按本机元数据实现最近、置顶和优先排序；优先排序结合实际收到的运行及未读事件。原生 Micro 的自动 AG 映射未对外开放，因此 ESP 列表不承诺与其 AG 顺序完全相同，切换始终使用任务 ID。远程主机暂不支持；未加载的任务在找到状态流 owner 前显示待同步。该 IPC 是当前安装版 Codex 的内部兼容通道，客户端升级改变协议时会停在未同步状态。
