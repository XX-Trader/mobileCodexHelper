# 项目提示词

你正在维护 `mobileCodexHelper`。这是一个“Windows 本机 Codex 会话 + 私有网页控制面板 + 手机访问入口”的组合项目，不是普通单体前端仓库。

## 1. 基本要求

- 始终使用简体中文输出。
- 文档文件默认使用 UTF-8 无 BOM。
- 任何结论都应以当前仓库现状为准，不要直接把上游 `claudecodeui` 默认行为当成本项目行为。
- 在 Windows PowerShell 中查看中文文档时，先执行 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`，不要把控制台显示乱码误判为文件内容乱码。

## 2. 开工前先读什么

1. [index.md](index.md)
2. [memory.md](memory.md)
3. 任务相关文档:
   - 需求相关: [docs/requirements.md](docs/requirements.md)
   - 接口相关: [docs/api.md](docs/api.md)
   - 架构/部署/排障相关: [docs/technical.md](docs/technical.md)
4. 当前任务台账: [todo.md](todo.md)、[done.md](done.md)

## 3. 项目核心事实

- 目标是让“手机查看和继续控制电脑上的 Codex”变得可用且安全。
- 默认安全模型是:
  - 单用户
  - 首次设备审批
  - 私网访问优先
  - 本机服务优先，不直接公网暴露
- 功能改动主要落在 `upstream-overrides/claudecodeui-1.25.2/`。
- `vendor/claudecodeui-1.25.2/` 是上游源码基线，原则上不要直接手改。
- Windows 桌面控制工具入口是 `mobile_codex_control.py`。
- 聊天图片/普通附件链路已经接通；如果再次出问题，优先按回归问题排查，不要默认判定为“功能未实现”。

## 4. 实施规则

- 变更上游 UI/服务能力时，优先修改 `upstream-overrides/`，必要时再通过脚本应用到 `vendor/`。
- 不要弱化首次设备审批、白名单或 localhost 绑定等安全边界，除非需求明确且文档同步更新。
- 任何接口、认证、配置、部署方式变化，都要同步更新对应文档。
- 修改任务优先级时同步维护 [todo.md](todo.md)。
- 完成任务时，必须把结果追加到 [done.md](done.md)。

## 5. 调试优先级

排障时优先检查:

1. `http://127.0.0.1:3001/health`
2. `scripts/check-mobile-codex-runtime.ps1`
3. `tmp/logs/` 下的应用日志
4. nginx 日志
5. 认证数据库中的 `trusted_devices`、`device_approval_requests`、`session_continuations`
6. `config/mobile-projects.json`

## 6. 文档同步规则

- 需求变化: 更新 [docs/requirements.md](docs/requirements.md)
- API 变化: 更新 [docs/api.md](docs/api.md)
- 技术架构、目录职责、运行方式变化: 更新 [docs/technical.md](docs/technical.md)
- 稳定记忆变化: 更新 [memory.md](memory.md)

## 7. 当前优先事项

- 校验聊天相关改动的回归链路是否闭环。
- 补一条可复用的本地 UI 自动化验收脚本，覆盖图片/附件上传与发送主流程。
- 保持文档、代码、任务台账三者一致。
