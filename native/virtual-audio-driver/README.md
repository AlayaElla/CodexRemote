# CodexRemote 虚拟音频驱动

这是一个 x64 KMDF/PortCls WaveRT 虚拟渲染驱动，只注册一个播放端点：
`CodexRemote Speakers`（`ROOT\CodexRemoteVirtualAudio`）。端点固定接收
48 kHz、16-bit、双声道 PCM；共享模式下由 Windows Audio Engine 完成格式转换。

源码基于 Microsoft Windows-driver-samples 的 SysVAD（Microsoft Public License，
完整原文见本目录 `LICENSE`），固定上游
commit `3c3fb49073c047c4cc8e6c203c6331f62b426507`。vendor 不包含 APO、关键词
检测或安装包代码，但保留编译所需的通用 SysVAD 代码，其中包括未激活的 sample
ToneGenerator 实现。运行时只注册单一 speaker miniport，不注册麦克风 capture
端点，也没有用户态 IOCTL；render PCM 由 Windows Audio Engine 写入 WaveRT 缓冲。

WASAPI loopback 是 Windows Audio Engine 对该 render endpoint 的系统 loopback。
验收必须播放非静音 PCM，并从 WASAPI loopback 客户端取得非零 RMS；它不是硬件
loopback pin，也不能以 SysVAD 的模拟正弦波作为验收。

运行 `powershell -NoProfile -File native/virtual-audio-driver/scripts/build.ps1`。
INF 锁定 Windows 11 build 22000+，使用该系统版本支持的 KMDF 1.33。脚本不签名、
不安装内核驱动。发布包需要 Microsoft 接受的内核签名，且只包含
`CodexRemoteVirtualAudio.sys`、`.inf`、`.cat`。
