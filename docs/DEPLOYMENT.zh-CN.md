# 部署说明

[中文](DEPLOYMENT.zh-CN.md) | [English](DEPLOYMENT.md)

这份文档面向第一次部署 `mobileCodexHelper` 的 Windows 用户。  
目标不是解释内部实现，而是让你尽快把服务跑起来，并且明确每一步的验证方法。

## 1. 先选部署路线

优先按你的角色选路线，不要两条路混着走：

| 路线 | 适合谁 | 复杂度 | 推荐度 |
|------|--------|--------|--------|
| 便携版 | 只想尽快用起来的个人用户 | 低 | 高 |
| 源码版 | 需要维护、调试、二次开发的维护者 | 中 | 中 |

如果你只是想“手机继续控制电脑上的 Codex”，优先选便携版。  
如果你要改代码、重新打包或核对上游覆盖逻辑，再走源码版。

## 2. 成功标准

部署完成后，至少应满足下面这些条件：

- 电脑本机能打开 `http://127.0.0.1:3001`
- 本机 nginx 能代理 `http://127.0.0.1:8080`
- 手机和电脑在同一个 Tailscale 网络时，手机能打开私有访问地址
- 新设备首次登录时，电脑端能看到待审批设备
- 批准后，手机能查看项目、会话并继续发送消息

## 3. 默认部署模型

项目默认按下面这条链路工作：

```text
手机浏览器
   ↓
Tailscale 私网 HTTPS
   ↓
本机 nginx（127.0.0.1:8080）
   ↓
本机 claudecodeui + 本项目补丁（127.0.0.1:3001）
   ↓
电脑上的本地 Codex 会话
```

设计重点只有两个：

- 应用本身只监听本机回环地址，不直接暴露公网
- 新设备第一次登录必须经过电脑端批准

## 4. 前置条件

### 4.1 操作系统

- Windows 10
- Windows 11

### 4.2 软件要求

#### 便携版

- Tailscale
  - 仅当你需要手机远程访问时必装

#### 源码版

- Python 3.11+
- Node.js 22 LTS
- Git
- nginx for Windows
- Tailscale
  - 仅当你需要手机远程访问时必装
- 一个可正常使用的本地 Codex 环境

### 4.3 上游源码要求

源码版依赖上游 `siteboon/claudecodeui` 的 `v1.25.2`。  
目录名需要放成下面这样：

```text
mobileCodexHelper/
├─ deploy/
├─ docs/
├─ scripts/
├─ upstream-overrides/
├─ vendor/
│  └─ claudecodeui-1.25.2/
├─ mobile_codex_control.py
└─ requirements.txt
```

## 5. 便携版部署

便携版是普通用户的首选方案。

### 第 1 步：下载并完整解压

从发布页下载便携版后，完整解压到一个固定目录。  
不要只拿出 `MobileCodexControl.exe` 单独运行。

### 第 2 步：启动桌面工具

双击：

```text
MobileCodexControl.exe
```

首次启动通常会进入初始化向导。

### 第 3 步：完成初始化向导

在向导中确认以下路径：

- `node.exe`
- `nginx.exe`
- `tailscale.exe`

说明：

- 正常情况下，便携包会自动识别内置运行环境
- 如果你不需要手机远程访问，`tailscale.exe` 可以稍后再配
- 如果向导找不到路径，再手动指定本机安装位置

然后点击：

```text
一键初始化并启动
```

### 第 4 步：本机验证

初始化完成后，先只验证电脑本机：

1. 用电脑浏览器打开 `http://127.0.0.1:3001`
2. 完成首次注册
3. 确认桌面工具中的 PC 应用服务和 nginx 状态都为正常

如果这一步还没通，不要急着测手机。

### 第 5 步：启用手机远程访问

如果你需要用手机访问：

1. 让电脑登录 Tailscale
2. 让手机登录同一个 Tailnet
3. 在桌面工具中开启手机访问
4. 用手机打开桌面工具显示的私有访问地址

### 第 6 步：首次设备批准

新设备第一次登录时：

1. 手机端会显示等待批准
2. 电脑端桌面工具会出现待审批设备
3. 你核对设备名、平台、UA、IP 后点击批准
4. 手机端自动继续登录

如果没有看到待审批设备，优先排查电脑端服务和 Tailscale 状态。

## 6. 源码版部署

源码版适合维护者、二次开发者和需要重新构建发布目录的人。

### 第 1 步：获取仓库源码

把本仓库克隆到本地，例如：

```bash
git clone https://github.com/<你的账号>/mobileCodexHelper.git
cd mobileCodexHelper
```

### 第 2 步：准备上游 claudecodeui

下载上游 `siteboon/claudecodeui` 的 `v1.25.2`，放到：

```text
vendor/claudecodeui-1.25.2
```

如果目录名不对，后续运行环境检查会直接失败。

### 第 3 步：应用覆盖文件

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/apply-upstream-overrides.ps1
```

如果你想在公开发布前自检覆盖流程，也可以额外执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test-override-flow.ps1 -UpstreamZip <上游源码压缩包路径>
```

### 第 4 步：安装 Node 依赖

进入上游目录并安装依赖：

```bash
cd vendor/claudecodeui-1.25.2
npm install
cd ../..
```

如果 `npm install` 失败，优先检查：

- Node 是否为 22 LTS
- npm 网络是否可用
- 上游目录是否真的在 `vendor/claudecodeui-1.25.2`

### 第 5 步：确认 Python 运行条件

桌面控制工具源码运行只依赖 Python 3.11+ 标准库。  
`requirements.txt` 中的 `pyinstaller` 仅在你需要打包 `MobileCodexControl.exe` 时才需要安装。

如需打包，再执行：

```bash
pip install -r requirements.txt
```

### 第 6 步：检查本地运行环境

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-mobile-codex-runtime.ps1
```

至少要确认下面几项：

- `UpstreamExists = True`
- `Node` 有值
- `Nginx` 有值
- 如果你要手机远程访问，`Tailscale` 也有值
- `Python` 有值

### 第 7 步：启动整套服务

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-codex-stack.ps1
```

这个脚本会做两件事：

- 启动应用服务到 `127.0.0.1:3001`
- 启动 nginx 到 `127.0.0.1:8080`

如果你当前环境不方便使用 PowerShell，也可以直接执行：

```text
scripts\start-mobile-codex-local.cmd
```

对应的本机停止和状态检查脚本：

```text
scripts\stop-mobile-codex-local.cmd
scripts\status-mobile-codex-local.cmd
```

这 3 个 `.cmd` 脚本只负责本机部署，不会开启 Tailscale 远程发布。

### 第 8 步：启动桌面控制工具

源码版桌面控制工具可直接运行：

```bash
python mobile_codex_control.py
```

或者使用仓库自带启动器：

```text
scripts\launch-mobile-codex-control.cmd
```

### 第 9 步：完成首次注册

用电脑浏览器打开：

```text
http://127.0.0.1:3001
```

完成首次注册后，再继续测试远程访问。

### 第 10 步：启用 Tailscale 私网访问

确认电脑和手机都已登录同一个 Tailnet 后，在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/enable-mobile-codex-remote.ps1
```

这个脚本本质上会把：

```text
http://127.0.0.1:8080
```

通过 `tailscale serve` 发布成 Tailnet 内的私有 HTTPS 地址。

如果命令输出提示需要先在 tailnet 中开启 Serve，请按输出给出的链接先完成授权。

## 7. 服务地址与日志

### 7.1 默认服务地址

- 应用服务：`http://127.0.0.1:3001`
- 本机代理：`http://127.0.0.1:8080`
- 远程访问：由 `tailscale serve` 发布出的私有 HTTPS 地址

### 7.2 应用日志

- `tmp/logs/mobile-codex-app.stdout.log`
- `tmp/logs/mobile-codex-app.stderr.log`

### 7.3 nginx 日志

默认情况下，nginx 运行目录会被映射到 ASCII 别名路径：

```text
C:\mobileCodexHelper_ascii\.runtime\nginx\logs\
```

常见日志文件：

- `mobile-codex.access.log`
- `mobile-codex.error.log`

如果你设置了 `MOBILE_CODEX_ASCII_ALIAS`，日志目录会跟着这个变量一起变化。

## 8. 常用命令

### 检查运行环境

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-mobile-codex-runtime.ps1
```

### 启动整套服务

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-codex-stack.ps1
```

### 本机一键启动（不依赖 PowerShell）

```text
scripts\start-mobile-codex-local.cmd
```

### 停止整套服务

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-mobile-codex-stack.ps1
```

### 本机一键停止（不依赖 PowerShell）

```text
scripts\stop-mobile-codex-local.cmd
```

### 本机状态检查（不依赖 PowerShell）

```text
scripts\status-mobile-codex-local.cmd
```

### 检查 Tailscale 状态

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-tailscale-status.ps1
```

### 检查 nginx ASCII 别名路径

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-nginx-workspace-alias.ps1
```

### 维护者：源码覆盖自测

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test-override-flow.ps1 -UpstreamZip <上游源码压缩包路径>
```

### 维护者：打包桌面工具

```text
scripts\package-mobile-codex-control.cmd
```

## 9. 验证清单

建议按下面顺序验证，排障成本最低：

### 9.1 本机验证

- `scripts/check-mobile-codex-runtime.ps1` 输出完整且关键路径非空
- `http://127.0.0.1:3001` 能打开
- `http://127.0.0.1:8080` 能正常代理到应用
- 桌面工具里 PC 应用服务和 nginx 都显示正常

### 9.2 远程验证

- 电脑和手机都在线于同一个 Tailnet
- `scripts/enable-mobile-codex-remote.ps1` 执行成功
- 手机能打开私有 HTTPS 地址

### 9.3 安全验证

- 新设备第一次登录时，电脑端能看到待审批设备
- 批准前，手机端不能直接进入项目列表
- 批准后，手机端能进入项目和会话列表

## 10. 常见问题

### 10.1 `UpstreamExists = False`

这通常说明上游目录不存在或目录名不对。

先检查：

- `vendor/claudecodeui-1.25.2` 是否存在
- 是否误写成了别的版本号
- 是否设置了错误的 `MOBILE_CODEX_UPSTREAM_DIR`

### 10.2 `Node`、`Nginx` 或 `Tailscale` 为空

说明脚本没有找到可执行文件。

解决顺序：

1. 确认可执行文件已经安装
2. 确认它们在 PATH 中
3. 必要时设置环境变量

可选环境变量：

- `MOBILE_CODEX_UPSTREAM_DIR`
- `MOBILE_CODEX_NODE`
- `MOBILE_CODEX_NGINX`
- `MOBILE_CODEX_TAILSCALE`
- `MOBILE_CODEX_ASCII_ALIAS`

### 10.3 `127.0.0.1:3001` 打不开

优先检查：

- `tmp/logs/mobile-codex-app.stderr.log`
- 上游目录是否已执行过 `npm install`
- 上游目录是否已执行过 `npm run build`
- 是否误删了 `vendor/claudecodeui-1.25.2`

### 10.4 `127.0.0.1:8080` 打不开或出现 502

优先检查：

- `scripts/check-nginx-workspace-alias.ps1` 输出的路径是否正常
- `C:\mobileCodexHelper_ascii\.runtime\nginx\logs\mobile-codex.error.log`
- 3001 服务是否已经先启动成功

### 10.5 Tailscale 无法发布远程地址

优先检查：

- 电脑是否已登录 Tailscale
- `tailscale status --json` 是否显示 `BackendState = Running`
- Tailnet 是否已开启 Serve 功能

如果脚本输出了需要访问的授权链接，先完成授权再重试。

### 10.6 手机浏览器能用，但封装 App 或 WebView 不行

先以手机浏览器打通全流程，再排查封装壳。  
常见兼容点包括：

- `localStorage`
- Cookie
- `Authorization` 请求头
- WebSocket

### 10.7 仓库路径包含中文后 nginx 异常

先运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-nginx-workspace-alias.ps1
```

项目默认会通过 ASCII 别名目录运行 nginx。  
如果你的环境特殊，再显式设置 `MOBILE_CODEX_ASCII_ALIAS`。

## 11. 安全建议

部署时请至少坚持下面这些约束：

- 不要把 `127.0.0.1:3001` 直接暴露到公网
- 优先通过 Tailscale 等私网访问
- 保留首次设备审批机制，不要为了省事关闭它
- 不要把真实 `.env`、认证数据库、日志或私有域名提交到仓库

更多背景请继续阅读：

- [`../SECURITY.zh-CN.md`](../SECURITY.zh-CN.md)
- [`ARCHITECTURE.zh-CN.md`](ARCHITECTURE.zh-CN.md)

## 12. 回滚与停止

如果你只是想停服务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-mobile-codex-stack.ps1
```

如果你还要关闭远程发布：

- 在桌面工具中关闭手机访问
- 或者手动关闭当前 Tailnet 的 `tailscale serve` 配置

如果源码版覆盖错了上游，建议：

1. 删除 `vendor/claudecodeui-1.25.2`
2. 重新放入干净的 `v1.25.2`
3. 重新执行 `scripts/apply-upstream-overrides.ps1`
