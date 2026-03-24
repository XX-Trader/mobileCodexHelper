# 项目索引

`mobileCodexHelper` 是一个把 Windows 本机运行的 Codex 会话，通过私有网页面板安全延伸到手机浏览器的项目。本文档是仓库级导航入口，目的是让维护者、协作者和 Agent 能快速找到正确资料，而不是重新扫全仓库。

## 1. 建议阅读顺序

1. [README.md](README.md)
2. [memory.md](memory.md)
3. [docs/requirements.md](docs/requirements.md)
4. [docs/api.md](docs/api.md)
5. [docs/technical.md](docs/technical.md)
6. [todo.md](todo.md)
7. [done.md](done.md)

## 2. 文档职责

### 根目录入口

- [README.md](README.md)
  - 对外公开入口，适合快速了解项目定位、部署方式和使用方式。
- [memory.md](memory.md)
  - 长期稳定记忆，记录项目定位、核心约束、关键路径和当前需要持续记住的事实。
- [agent.md](agent.md)
  - 项目级提示词，供新 Agent 或新线程快速进入统一工作方式。
- [todo.md](todo.md)
  - 待办任务台账，按四象限维护优先级。
- [done.md](done.md)
  - 已完成任务归档；凡是从 `todo.md` 完成的事项，都应同步追加到这里。

### 正式文档

- [docs/requirements.md](docs/requirements.md)
  - 产品目标、范围边界、核心需求、非功能要求和成功标准。
- [docs/api.md](docs/api.md)
  - 当前项目自定义和高频使用接口说明，重点覆盖认证、用户、项目、Codex 与聊天附件相关接口。
- [docs/technical.md](docs/technical.md)
  - 系统结构、运行模型、目录职责、数据落点、排障入口与编码约定。
- [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)
  - 当前安全架构与私网访问模型说明。
- [docs/DEPLOYMENT.zh-CN.md](docs/DEPLOYMENT.zh-CN.md)
  - Windows 环境部署说明。
- [docs/AUTOSTART.zh-CN.md](docs/AUTOSTART.zh-CN.md)
  - 登录自启与服务恢复说明。
- [docs/chat-experience-upgrade-plan.md](docs/chat-experience-upgrade-plan.md)
  - 聊天体验升级专项计划，属于演进规划，不是当前稳定实现的 SSOT。
- [docs/chat-session-view-state-plan.md](docs/chat-session-view-state-plan.md)
  - 会话级聊天页面状态与按需加载专项方案。
- [docs/vscode-codex-session-time-patch.md](docs/vscode-codex-session-time-patch.md)
  - VS Code Codex 扩展会话列表时间补丁说明。

## 3. 代码与目录入口

- `mobile_codex_control.py`
  - Windows 桌面控制工具入口，负责本地状态展示、设备审批、远程访问开关和运行环境检查。
- `upstream-overrides/claudecodeui-1.25.2/`
  - 本项目对上游 `claudecodeui v1.25.2` 的覆盖层，功能改动优先落在这里。
- `vendor/claudecodeui-1.25.2/`
  - 上游源码镜像目录，原则上不直接手改，需通过覆盖脚本应用变更。
- `scripts/`
  - 启动、停止、检查、打包、覆盖验证等运维脚本。
- `config/mobile-projects.json`
  - 移动端允许展示的项目白名单配置。
- `docs/`
  - 正式文档目录。
- `.workflow/project-index-local/`
  - 本地生成索引，可辅助检索，但不是手工维护的唯一事实来源。

## 4. 编码与查看约定

- 仓库中文文档默认使用 UTF-8 无 BOM。
- Windows PowerShell 直接查看 UTF-8 中文文件时，可能因为控制台输出编码导致“显示乱码”，这不等于文件内容损坏。
- 需要在 PowerShell 中查看中文文档时，先执行：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-Content -Raw -Encoding UTF8 README.md
```

## 5. 变更同步矩阵

- 产品目标、范围、成功标准变化：更新 [docs/requirements.md](docs/requirements.md)
- 接口、认证、路由挂载、WebSocket 行为变化：更新 [docs/api.md](docs/api.md)
- 架构、目录职责、部署方式、运行路径变化：更新 [docs/technical.md](docs/technical.md) 和 [memory.md](memory.md)
- 新增任务：写入 [todo.md](todo.md)
- 完成任务：从 [todo.md](todo.md) 移除，并归档到 [done.md](done.md)

## 6. 维护规则

- 对上游功能做自定义时，优先修改 `upstream-overrides/`，不要直接改 `vendor/`。
- 保持“单用户 + 首次设备审批 + 私网访问 + localhost 运行”的安全边界。
- 文档优先记录稳定事实；临时实验或阶段性方案应放在计划文档或任务台账里。

## 7. 常用入口

- 本地启动: `scripts/start-mobile-codex-local.cmd`
- 本地停止: `scripts/stop-mobile-codex-local.cmd`
- 本地状态: `scripts/status-mobile-codex-local.cmd`
- 远程访问: `scripts/enable-mobile-codex-remote.cmd`
- 运行环境检查: `scripts/check-mobile-codex-runtime.ps1`
- 覆盖流程自测: `scripts/smoke-test-override-flow.ps1`
