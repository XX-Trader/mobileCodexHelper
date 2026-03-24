# 技术文档

## 1. 文档目标

这份文档说明 `mobileCodexHelper` 的技术结构、目录职责、运行时依赖、数据落点和排障入口。重点是帮助维护者快速判断“代码应该改哪里、服务怎么跑、问题先看什么”。

## 2. 系统概览

项目由三部分组成:

1. Windows 桌面控制工具
2. 基于 `claudecodeui` 的本地 Web UI 与服务端
3. 部署、反向代理和运行检查脚本

推荐运行链路:

```text
手机浏览器
   ↓
Tailscale 私网
   ↓
nginx
   ↓
本地 claudecodeui + 覆盖层
   ↓
本地 Codex 会话
```

## 3. 关键目录职责

### 根目录

- `mobile_codex_control.py`
  - Python 桌面控制工具入口
  - 负责服务状态、设备审批、远程访问控制和错误摘要
- `requirements.txt`
  - 主要用于打包桌面工具时安装 `pyinstaller`
- `README.md`
  - 对外介绍和快速开始入口

### 覆盖层与上游源码

- `upstream-overrides/claudecodeui-1.25.2/`
  - 本项目真正的定制层
  - 前端、服务端、数据库初始化 SQL 的自定义都优先放这里
- `vendor/claudecodeui-1.25.2/`
  - 上游 `siteboon/claudecodeui v1.25.2`
  - 作为基线源码与构建目录存在

原则:

- 自定义优先改 `upstream-overrides/`
- 通过 `scripts/apply-upstream-overrides.ps1` 应用覆盖
- 避免直接在 `vendor/` 上堆积不可追踪的手工修改

### 脚本与配置

- `scripts/`
  - 本地启动、停止、环境检查、打包、远程访问、覆盖验证
  - 也包含本机 VS Code Codex 扩展会话时间补丁脚本 `patch-vscode-codex-session-time.ps1`
  - `ensure-vscode-codex-session-time-patch.ps1` 会记录当前已确认版本，并在检测到扩展版本变化或当前版本未补丁时自动触发补丁
- `config/mobile-projects.json`
  - 允许出现在移动端的项目白名单
- `config/mobile-projects.example.json`
  - 白名单配置示例

### 文档与索引

- `docs/`
  - 正式文档
- `.workflow/project-index-local/`
  - 自动生成的本地索引，可用于辅助检索，但不是手工维护 SSOT

## 4. 运行时技术栈

### 桌面控制工具

- Python 3.11+
- `tkinter`
- 标准库:
  - `sqlite3`
  - `subprocess`
  - `urllib`
  - `threading`

### Web UI 与服务端

基于 `vendor/claudecodeui-1.25.2/package.json` 当前可确认:

- Node.js 22 LTS
- Express
- WebSocket `ws`
- React 18
- Vite 7
- `better-sqlite3`
- `@openai/codex-sdk`
- `multer`
- `react-dropzone`

### 代理与远程访问

- nginx for Windows
- Tailscale

## 5. 关键运行参数

### 端口

- 应用服务: `3001`
- nginx: `8080`

### 关键环境与路径

- `DATABASE_PATH`
  - 自定义认证数据库路径
- `MOBILE_CODEX_TAILSCALE`
  - 自定义 `tailscale.exe` 路径
- `MOBILE_CODEX_ASCII_ALIAS`
  - ASCII 别名工作目录
- `MOBILE_CODEX_UPSTREAM_DIR`
  - 自定义上游目录
- `MOBILE_CODEX_NODE`
  - 自定义 `node.exe`
- `MOBILE_CODEX_NGINX`
  - 自定义 `nginx.exe`
- `CODEX_ONLY_HARDENED_MODE`
  - 控制 hardened mode 开关
  - 开启后会禁用高风险能力；`/api/user/git-config` 被拦截，但语言偏好和 onboarding 状态接口继续开放

## 6. 数据与状态模型

### 数据库

认证数据库初始化位于:

- `upstream-overrides/claudecodeui-1.25.2/server/database/init.sql`

关键表:

- `users`
  - 单用户账号信息
- `api_keys`
  - 外部 API key
- `user_credentials`
  - 用户凭证
- `session_names`
  - 会话自定义名称
- `session_auto_titles`
  - 自动标题持久化
- `trusted_devices`
  - 已批准设备白名单
- `device_approval_requests`
  - 待审批设备
- `app_config`
  - 应用级配置与密钥

### 本地文件状态

- 项目白名单: `config/mobile-projects.json`
- 控制状态: `.runtime/mobile-codex-control-state.json`
- VS Code Codex 会话时间补丁状态: `.runtime/vscode-codex-session-time-patch-state.json`
- nginx 日志: `.runtime/nginx/logs/`
- 应用日志: `tmp/logs/`

### Codex 会话本地存储

网页端新建 Codex 会话时，真实的本地持久化不是只写一份索引，而是同时涉及三层数据:

1. `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
   - 这是最核心的会话落盘文件
   - 首行通常是 `session_meta`
   - 后续包含用户消息、模型响应、工具调用等实际会话内容
2. `~/.codex/state_5.sqlite`
   - 重点表是 `threads`
   - 保存 `id`、`rollout_path`、`created_at`、`updated_at`、`source`、`cwd`、`title`、`cli_version` 等恢复所需元数据
3. `~/.codex/session_index.jsonl`
   - 兼容层索引
   - 可用于补充标题和部分会话元数据
   - 不是唯一事实来源，也不应作为“会话是否成功保存”的唯一判断依据

### Codex 会话标题数据源

当前实现已经把 Codex 会话标题统一到原生 CLI 元数据，而不是网页私有库覆盖:

1. `~/.codex/state_5.sqlite -> threads.title`
   - 这是 Codex 会话标题的主事实源
   - CLI 的 `resume --last`、交互选择器，以及网页端当前的 Codex 会话列表都应优先信任这里
2. `~/.codex/session_index.jsonl -> thread_name`
   - 这是兼容同步副本
   - 用于跟随 `threads.title` 更新，兼容依赖索引的周边读取方
3. `~/.codex/sessions/**/*.jsonl`
   - 仍然是原始 transcript / rollout 事实源
   - 不参与“重命名标题”写回，避免 live 会话期间改写 transcript
4. `auth.db -> session_names` / `session_auto_titles`
   - 继续保留给 Claude / Cursor / Gemini 等 provider
   - Codex 已不再依赖这两张表做标题覆盖

因此，Codex 会话重命名现在应理解为:

1. 主写 `threads.title`
2. 同步写 `session_index.jsonl.thread_name`
3. 网页刷新后从 native title 读取
4. 不再通过 `auth.db.session_names` 给 Codex 叠一层私有标题

服务端当前的网页新建会话补写逻辑位于:

- `upstream-overrides/claudecodeui-1.25.2/server/openai-codex.js`
  - `queryCodex(...)`
  - `syncCodexSessionArtifacts(...)`
  - `syncCodexSessionIndex(...)`
  - `syncCodexStateThread(...)`

其中 rollout `jsonl` 由 Codex CLI 原生写入，服务端当前信任 CLI 提供的 rollout 格式，不再回写 rollout 首行内容。

写入顺序可以概括为:

1. 前端为新会话先生成 `new-session-*` 临时 ID
2. WebSocket 发送 `codex-command`
3. 后端启动新线程，拿到真实 `thread_id`
4. Codex CLI 自行落盘 rollout `jsonl`
5. 后端补写 `session_index.jsonl`
6. 后端尝试补写 `state_5.sqlite.threads`，若 CLI 线程记录尚未出现，则按退避策略在后台重试
7. 后端回推 `session-created`
8. 前端把临时会话替换为真实会话 ID

### Codex CLI 恢复判定结论

2026-03-21 进行过一轮本机假数据实验，结论如下:

1. 只写 `session_index.jsonl`
   - `codex resume <sessionId>` 不能恢复
   - 说明索引文件单独不构成可恢复会话
2. 只写 `state_5.sqlite.threads`
   - `codex resume <sessionId>` 不能恢复
   - 缺少真实 rollout 文件时，线程元数据单独也不够
3. 只写 rollout `jsonl`
   - `codex resume <sessionId>` 可以恢复
   - 说明按 ID 直接恢复时，CLI 能从 rollout 文件本身解析会话
4. rollout `jsonl` + `state_5.sqlite.threads`
   - `codex resume <sessionId>` 可以恢复
   - `codex resume --last` / 交互选择器也会吃到这条会话

这意味着:

1. `codex resume <sessionId>` 的核心前提是 rollout 文件真实存在
2. `codex resume --last` 和交互选择器更依赖 `state_5.sqlite.threads`
3. `session_index.jsonl` 更像兼容索引，不是恢复主依据

因此排查“网页端新建会话后 CLI 看不到”时，优先级应是:

1. 先看 `~/.codex/sessions/` 下是否生成了对应 rollout `jsonl`
2. 再看 `state_5.sqlite.threads` 是否有对应行，尤其是 `rollout_path`、`source`、`cwd`、`title`
3. 最后再看 `session_index.jsonl` 是否被补写，以及是否被其他写入方覆盖

### 当前已知风险

当前这条补写链路有两个已知风险:

1. `thread.started` 出现时，`state_5.sqlite.threads` 记录未必已经可见
   - 服务端现在会在同步时点之外，继续按退避策略后台重试 `threads` 元数据补写
   - 如果超过重试窗口仍未出现，日志会输出明确告警
2. `session_index.jsonl` 可能被网页端服务和外部 Codex 进程分别写入，时间格式和字段完整性不一定稳定

设计取舍:

1. rollout `jsonl` 视为 Codex CLI 的原生事实源，服务端不再修改该文件内容
2. Windows 上 live 会话期间 rollout 文件可能被 CLI 持有文件锁，因此服务端避免再对 rollout 做整文件替换

所以现阶段不能把“`session_index.jsonl` 某条记录字段不完整”直接等同于“网页端没有触发本地保存”。

## 7. 关键服务端行为

### 路由挂载

`server/index.js` 当前可以确认的主要路由组:

- `/health`
- `/api/auth`
- `/api/projects`
- `/api/codex`
- `/api/user`
- `/api/git`
- `/api/mcp`
- `/api/taskmaster`
- `/api/settings`
- `/api/plugins`

其中多个路由组在 `Codex-only hardened mode` 下会被禁用或收敛。

### 文件监听

服务端会监听 provider 相关目录变化，并通过 WebSocket 广播项目更新。当前默认重点仍然是:

- `~/.codex/sessions`

### 认证模型

- 登录依赖用户名密码
- 新设备登录时，如果设备不在 `trusted_devices` 中，会创建审批请求
- 电脑端批准后，该设备才能正常登录
- 兼容移动壳时支持 Bearer fallback

## 8. 开发与发布流程

### 源码维护

1. 准备 `vendor/claudecodeui-1.25.2`
2. 修改 `upstream-overrides/`
3. 应用覆盖
4. 安装 Node 依赖
5. 运行检查脚本
6. 启动整套服务

### 关键脚本

- `scripts/apply-upstream-overrides.ps1`
- `scripts/check-mobile-codex-runtime.ps1`
- `scripts/ensure-vscode-codex-session-time-patch.ps1`
- `scripts/patch-vscode-codex-session-time.ps1`
- `scripts/start-mobile-codex-local.cmd`
- `scripts/stop-mobile-codex-local.cmd`
- `scripts/status-mobile-codex-local.cmd`
- `scripts/start-mobile-codex-stack.ps1`
- `scripts/stop-mobile-codex-stack.ps1`
- `scripts/package-mobile-codex-control.cmd`
- `scripts/smoke-test-override-flow.ps1`

## 9. 排障入口

### 第一层检查

- `http://127.0.0.1:3001/health`
- `scripts/status-mobile-codex-local.cmd`
- `scripts/check-mobile-codex-runtime.ps1`

### 第二层检查

- `tmp/logs/mobile-codex-app.stderr.log`
- `tmp/logs/mobile-codex-app.stdout.log`
- nginx 日志目录

### 第三层检查

- `trusted_devices` 和 `device_approval_requests` 表
- `config/mobile-projects.json`
- `~/.codex/config.toml`
- `~/.codex/sessions`

### 终端中文显示

- Windows PowerShell 默认输出编码可能导致 UTF-8 中文文档“显示乱码”。
- 排查中文文档前，先执行 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。
- 需要读取文件原文时，优先使用 `Get-Content -Encoding UTF8 <文件>`，不要直接把控制台显示问题误判为文件损坏。

## 10. 当前技术债与注意事项

- 项目默认使用 hardened mode，新增接口或功能时必须先确认是否应暴露到移动端。
- 聊天图片/普通附件上传链路已经接通，当前剩余短板是缺本地浏览器自动化验收脚本与回归闭环验证。
- 文档体系已完成一轮一致性收口；后续任何核心改动都要同步更新，避免 README、正式文档和任务台账再次脱节。
