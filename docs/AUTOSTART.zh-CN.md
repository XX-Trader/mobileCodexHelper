# Windows 登录自启与 Tailscale 恢复指南

这份文档专门说明一件事：

- 让 `mobileCodexHelper` 在你登录 Windows 后自动启动
- 让 `Tailscale Serve` 在你登录后自动恢复到 `http://127.0.0.1:8080`

这里刻意写成“登录自启”，不是“系统开机即服务化”。

原因很简单：

- 当前项目的正式启动入口是 `scripts\start-mobile-codex-local.cmd`
- 这套链路依赖当前用户目录、当前用户环境变量和本机交互会话
- 用“登录后自动启动”更接近项目当前结构，也更容易排障

推荐链路如下：

```text
Windows 登录
   ↓
计划任务 1：启动本地 Node + nginx
   ↓
计划任务 2：延迟恢复 Tailscale Serve
   ↓
手机继续走 Tailscale 私网 HTTPS 访问
```

## 1. 前置条件

安装自启前，先确认你已经手动跑通过下面两件事：

1. 本机启动成功：

```text
scripts\start-mobile-codex-local.cmd
```

2. 远程访问成功：

```text
scripts\enable-mobile-codex-remote.cmd
```

如果这两步手动都没跑通，不要先装自启。  
先把本机启动和 Tailscale 链路排通，再开启自动化。

## 2. 新增的脚本

这次补了 3 个脚本：

- `scripts\enable-mobile-codex-remote.cmd`
- `scripts\install-mobile-codex-autostart.cmd`
- `scripts\remove-mobile-codex-autostart.cmd`

作用分别是：

- `enable-mobile-codex-remote.cmd`
  把 `127.0.0.1:8080` 重新发布到 `tailscale serve`
- `install-mobile-codex-autostart.cmd`
  注册两个“登录后自动运行”的计划任务
- `remove-mobile-codex-autostart.cmd`
  删除上面两个计划任务

## 3. 自启会创建什么

安装脚本会注册两个计划任务：

1. `mobileCodexHelper-StartLocal`
   用户登录后立即执行 `scripts\start-mobile-codex-local.cmd`

2. `mobileCodexHelper-EnableRemote`
   用户登录后延迟 1 分钟执行 `scripts\enable-mobile-codex-remote.cmd`

这样拆成两个任务，不是为了“多此一举”，而是为了降低两个问题：

- 本地服务还没起来，`tailscale serve` 太早执行
- Tailscale Windows 服务刚开机时还没完全就绪

## 4. 如何安装自启

在项目根目录执行：

```text
scripts\install-mobile-codex-autostart.cmd
```

如果你想先看脚本会创建什么任务，不真正写入系统，可以先跑：

```text
scripts\install-mobile-codex-autostart.cmd --dry-run
```

安装成功后，可以用下面两条命令查看任务状态：

```text
schtasks /Query /TN "mobileCodexHelper-StartLocal" /V /FO LIST
schtasks /Query /TN "mobileCodexHelper-EnableRemote" /V /FO LIST
```

## 5. 如何卸载自启

如果后面你不想继续自动启动，执行：

```text
scripts\remove-mobile-codex-autostart.cmd
```

只预览删除动作、不真正删除：

```text
scripts\remove-mobile-codex-autostart.cmd --dry-run
```

## 6. Tailscale 的职责边界

要分清两件事：

1. `Tailscale` 自己的 Windows 后台服务是否自启
2. 当前 Tailnet 的 `tailscale serve` 发布规则是否恢复

这两件事不是一回事。

推荐做法：

- `Tailscale` 本体继续使用它自己的系统服务自启
- `mobileCodexHelper` 只负责在登录后补一次：

```text
tailscale serve --bg http://127.0.0.1:8080
```

也就是说，我们不是去替代 Tailscale 的系统服务，而是补“远程访问映射恢复”这一层。

## 7. 安装后的验证方法

建议按这个顺序验收：

1. 先手动执行一次：

```text
scripts\status-mobile-codex-local.cmd
```

确认 `3001` 和 `8080` 都正常。

2. 再检查 Tailscale 发布状态：

```bat
"C:\Program Files\Tailscale\tailscale.exe" serve status
```

3. 注销 Windows 再重新登录一次。

4. 登录后等待大约 1 分钟，重新检查：

- `http://127.0.0.1:3001/health`
- `http://127.0.0.1:8080/health`
- `tailscale serve status`

只要这三项都恢复，说明自启链路已经跑通。

## 8. 日志与排障位置

如果登录后没有自动恢复，优先看这里：

- `tmp/logs/mobile-codex-app.stdout.log`
- `tmp/logs/mobile-codex-app.stderr.log`
- `tmp/logs/mobile-codex-remote.stdout.log`
- `tmp/logs/mobile-codex-remote.stderr.log`

它们分别对应：

- 本地 Node 服务启动日志
- 本地 Node 服务错误日志
- `Tailscale Serve` 恢复日志
- `Tailscale Serve` 恢复错误日志

同时再看计划任务状态：

```text
schtasks /Query /TN "mobileCodexHelper-StartLocal" /V /FO LIST
schtasks /Query /TN "mobileCodexHelper-EnableRemote" /V /FO LIST
```

重点看：

- `Last Run Time`
- `Last Result`
- `Task To Run`

## 9. 什么时候不要开自启

下面这几种情况，不建议先装自启：

- 你还在频繁改上游目录或切换 `vendor` 版本
- 你还没确认 `node.exe`、`nginx.exe`、`tailscale.exe` 路径稳定
- 你当前只是在临时调试，不准备长期常驻运行

先手动启动更容易定位问题。

## 10. 推荐维护顺序

后续如果你更新了本项目，建议按这个顺序维护：

1. 先手动执行：

```text
scripts\start-mobile-codex-local.cmd
scripts\enable-mobile-codex-remote.cmd
```

2. 确认本机和手机链路都正常。

3. 再保留现有自启任务，不需要每次重装。

只有当脚本路径、仓库目录或任务命名规则变了，才需要重新执行安装脚本。
