# 安装实录

这份文档不是泛化版部署说明，而是一次实际跑通 `mobileCodexHelper` 的安装与接入记录。

适用场景：

- 你已经 `fork` 了仓库
- 你准备按源码版部署
- 你希望先在电脑本机跑通，再让手机接入

如果你只是想看完整部署说明，请先读：

- [部署说明](DEPLOYMENT.zh-CN.md)
- [架构说明](ARCHITECTURE.zh-CN.md)
- [安全说明](../SECURITY.zh-CN.md)

## 1. 这次实际跑通的目标

我们这次的目标不是“把项目装上就算完”，而是跑通下面这条链路：

```text
电脑本机 Codex
   ↓
mobileCodexHelper Web 服务（127.0.0.1:3001）
   ↓
nginx 代理（127.0.0.1:8080）
   ↓
Tailscale Serve 私网 HTTPS
   ↓
手机浏览器访问
   ↓
首次设备批准
   ↓
手机继续控制电脑上的 Codex
```

## 2. 前置条件

安装前先准备这些：

- Windows 10 或 Windows 11
- Python 3.11+
- Node.js 22 LTS
- Git
- nginx for Windows
- Tailscale
- 一个已经能在电脑上正常工作的 Codex 环境

源码目录按下面准备：

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

关键点：

- 上游目录必须叫 `vendor/claudecodeui-1.25.2`
- 版本就是 `v1.25.2`
- 目录名不对，后面的脚本会直接失败

## 3. 获取源码并准备上游目录

先克隆你自己的 fork：

```bash
git clone https://github.com/<你的账号>/mobileCodexHelper.git
cd mobileCodexHelper
```

然后把上游 `siteboon/claudecodeui` 的 `v1.25.2` 放到：

```text
vendor/claudecodeui-1.25.2
```

这一步完成后，仓库里应该已经有：

- `vendor/claudecodeui-1.25.2/server`
- `vendor/claudecodeui-1.25.2/src`
- `vendor/claudecodeui-1.25.2/package.json`

## 4. 应用覆盖文件

在项目根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/apply-upstream-overrides.ps1
```

如果你要做发布前自检，可以额外执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test-override-flow.ps1 -UpstreamZip <上游源码压缩包路径>
```

## 5. 安装依赖并构建前端

进入上游目录安装依赖：

```bash
cd vendor/claudecodeui-1.25.2
npm install
npm run build
cd ../..
```

这一步的目的有两个：

- 安装 Node 依赖
- 生成前端静态产物

如果你漏掉 `npm run build`，后面通常会出现页面打不开或资源不完整。

## 6. 启动本机服务

优先使用我们补过的本机 `.cmd` 脚本：

```text
scripts\start-mobile-codex-local.cmd
```

配套命令：

```text
scripts\status-mobile-codex-local.cmd
scripts\stop-mobile-codex-local.cmd
```

启动成功后，至少应满足：

- `http://127.0.0.1:3001/health` 返回 `status: ok`
- `http://127.0.0.1:8080/health` 返回 `status: ok`
- `3001` 和 `8080` 都在本机监听

## 7. 第一次本机登录

先不要急着用手机，先只验证电脑本机：

1. 浏览器打开 `http://127.0.0.1:3001`
2. 完成首次注册
3. 再打开 `http://127.0.0.1:8080`
4. 确认通过 nginx 代理访问也正常

我们这次实际看到的认证状态是：

```json
{"needsSetup":false,"isAuthenticated":false}
```

这代表：

- 系统已经完成初始化
- 但当前浏览器会话还没登录

### 如果页面是白屏

我们这次遇到过一个典型问题：登录后页面白屏。

优先按这个顺序处理：

1. 不要先用 `3001`，改用 `http://127.0.0.1:8080`
2. 按一次 `Ctrl + F5`
3. 打开浏览器开发者工具
4. 清掉站点数据
5. 注销对应的 Service Worker
6. 关闭标签页后重新打开 `8080`

如果这样后能恢复，通常是缓存或 Service Worker 问题，不是后端没起来。

## 8. 启动桌面控制工具

电脑端的设备批准、白名单、远程入口都在桌面工具里处理。

启动方式：

```text
scripts\launch-mobile-codex-control.cmd
```

或者：

```bash
python mobile_codex_control.py
```

这次我们还做了两个桌面工具改动：

- 整页增加纵向滚动条
- 窗口初始尺寸按屏幕分辨率自适应

所以低分辨率机器现在能完整看到“待审批”区域。

## 9. 安装并登录 Tailscale

电脑和手机都要装 `Tailscale`，并登录同一个 Tailnet。

电脑端确认状态：

```bat
"C:\Program Files\Tailscale\tailscale.exe" status --json
```

至少要确认：

- `BackendState` 是 `Running`
- 电脑节点在线
- 手机节点在线

## 10. 发布手机访问地址

本项目不建议直接把 `127.0.0.1:3001` 暴露出去。

正确做法是把 `127.0.0.1:8080` 通过 `tailscale serve` 发布成 Tailnet 内 HTTPS：

```bat
"C:\Program Files\Tailscale\tailscale.exe" serve --bg http://127.0.0.1:8080
```

查看当前发布状态：

```bat
"C:\Program Files\Tailscale\tailscale.exe" serve status
```

成功后你会看到类似：

```text
https://<你的主机名>.<你的 tailnet>.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8080
```

如果第一次执行时提示：

```text
Serve is not enabled on your tailnet.
To enable, visit:
https://login.tailscale.com/f/serve?node=...
```

先打开这条授权链接完成启用，再重新执行一次 `serve --bg`。

## 11. 手机登录

手机登录流程按这个顺序走：

1. 手机安装并登录 `Tailscale`
2. 确认和电脑在同一个 Tailnet
3. 手机浏览器打开：

```text
https://<你的主机名>.<你的 tailnet>.ts.net/
```

4. 输入你在电脑上刚注册的账号和密码
5. 手机页面会提示“等待电脑端批准”

这一步是正常行为，不是故障。

## 12. 首次设备批准

当手机端提示“等待电脑端批准”时：

1. 回到电脑桌面控制工具
2. 打开 `待审批` 区域
3. 选中刚才那台手机
4. 核对设备名、平台、浏览器、IP
5. 点击“批准所选”

批准后：

- 手机通常会自动继续登录
- 如果没有自动继续，手动刷新一次即可

## 13. VS Code 中聊天记录不同步的问题

这次我们还确认了一个行为边界：

- 手机网页发出的消息，电脑上的 Codex 会继续执行
- 但 VS Code 里的 Codex 插件不会实时刷新外部会话
- 把 VS Code 关掉再打开，记录会出现

这更像是插件当前的前台刷新限制，不是服务端丢消息。

临时办法：

1. 在 VS Code 中按 `Ctrl + Shift + P`
2. 执行 `Developer: Reload Window`

这比整关整个 VS Code 更省事。

## 14. 我们这次实际新增或修正的内容

这次安装过程中，我们顺手补了几项对部署体验有帮助的内容：

- 新增本机启动脚本：
  - `scripts/start-mobile-codex-local.cmd`
  - `scripts/status-mobile-codex-local.cmd`
  - `scripts/stop-mobile-codex-local.cmd`
- 修正文档中的无效脚本引用
- 收敛 nginx 访问日志，避免记录完整 query string
- 收敛 WebSocket token 的 query fallback 使用范围
- 给桌面工具加了整页滚动和更适配小屏的窗口尺寸

## 15. 常见问题

### 15.1 电脑本机能打开，手机打不开

优先检查：

- 手机和电脑是否在同一个 Tailnet
- `tailscale serve status` 是否还能看到当前映射
- `127.0.0.1:8080/health` 是否正常

### 15.2 手机出现 `This authentication link has expired`

这次我们遇到过这个问题，结论不是“持久化丢了”，而是：

- 手机打开了一个已经过期的旧认证页
- 或者浏览器里还保留着旧的跳转上下文

处理顺序：

1. 关闭当前报错页
2. 确认手机里的 `Tailscale` 已连接
3. 重新打开一个新的浏览器页
4. 再次直接访问 `https://<主机名>.<tailnet>.ts.net/`
5. 必要时清掉手机浏览器里 `tailscale.com` 和当前 `ts.net` 域名的站点数据

### 15.3 登录后网页空白

优先检查：

- 换用 `http://127.0.0.1:8080`
- 强刷页面
- 清理站点缓存
- 注销 Service Worker

### 15.4 电脑端没有出现待审批设备

优先检查：

- 手机是否真的是第一次登录该浏览器环境
- 桌面工具是否已经打开
- 桌面工具里是否点过刷新
- 手机页面是否还是停留在旧页面

## 16. 常用命令汇总

本机启动：

```text
scripts\start-mobile-codex-local.cmd
```

本机状态：

```text
scripts\status-mobile-codex-local.cmd
```

本机停止：

```text
scripts\stop-mobile-codex-local.cmd
```

检查本机运行环境：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-mobile-codex-runtime.ps1
```

启动整套服务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-codex-stack.ps1
```

停止整套服务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-mobile-codex-stack.ps1
```

启用远程访问：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/enable-mobile-codex-remote.ps1
```

或者直接使用不依赖 PowerShell 的版本：

```text
scripts\enable-mobile-codex-remote.cmd
```

桌面控制工具：

```text
scripts\launch-mobile-codex-control.cmd
```

如果你希望 Windows 登录后自动恢复本地服务和 `Tailscale Serve`，继续看：

- [Windows 登录自启与 Tailscale 恢复指南](AUTOSTART.zh-CN.md)

## 17. 验收标准

如果你最后满足下面这些条件，就说明整个链路已经跑通：

- 电脑能打开 `http://127.0.0.1:3001`
- 电脑能打开 `http://127.0.0.1:8080`
- 两个 `/health` 都正常
- 桌面工具能看到本机服务状态
- `tailscale serve status` 能显示私有 HTTPS 地址
- 手机能打开该 HTTPS 地址
- 手机首次登录时，电脑端能看到待审批设备
- 批准后，手机能进入项目和会话列表
- 手机发消息后，电脑上的 Codex 会继续执行

## 18. 安全提醒

这次实际部署里有几个边界要坚持：

- 不要直接把 `127.0.0.1:3001` 暴露到公网
- 优先走 `Tailscale`
- 保留首次设备批准机制
- 不要把认证数据库、日志和私有域名随便提交到仓库

如果你后面还要公开发布自己的版本，先读：

- [安全说明](../SECURITY.zh-CN.md)
- [开源发布检查清单](OPEN_SOURCE_RELEASE_CHECKLIST.zh-CN.md)
