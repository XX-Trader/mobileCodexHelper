# API 文档

## 1. 文档范围

这份文档聚焦 `mobileCodexHelper` 当前项目中“自定义和高频使用”的接口，不试图穷举上游 `claudecodeui` 的全部原始路由。接口信息主要根据以下代码整理:

- `upstream-overrides/claudecodeui-1.25.2/server/index.js`
- `upstream-overrides/claudecodeui-1.25.2/server/routes/auth.js`
- `upstream-overrides/claudecodeui-1.25.2/server/routes/user.js`
- `upstream-overrides/claudecodeui-1.25.2/server/routes/projects.js`
- `upstream-overrides/claudecodeui-1.25.2/server/routes/codex.js`
- `upstream-overrides/claudecodeui-1.25.2/src/utils/api.js`

## 2. 接口约定

### 2.1 基础入口

- 健康检查: `/health`
- 业务接口前缀: `/api`

### 2.2 认证方式

项目当前采用“Cookie 会话 + 设备绑定 Bearer fallback”模式:

- 浏览器场景优先使用同源 Cookie
- 兼容 WebView 或特殊客户端时，可走 `Authorization: Bearer <token>` fallback
- 新设备登录仍必须先通过电脑端审批

### 2.3 权限约束

- `/api/auth/*` 中的注册、登录、审批查询为公开接口
- 大多数业务接口都要求登录
- 默认 `Codex-only hardened mode` 会屏蔽部分高风险或非核心路由

## 3. 公开接口

### GET `/health`

用途:

- 应用健康检查

返回要点:

- `status`
- `timestamp`
- `installMode`

### GET `/api/auth/status`

用途:

- 查询系统是否需要首次注册

返回要点:

- `needsSetup`
- `isAuthenticated`

### GET `/api/auth/device-approval/:requestToken`

用途:

- 轮询某台新设备的审批状态

返回要点:

- `approvalStatus`
- `message`

### POST `/api/auth/register`

用途:

- 首次创建单用户账号

请求体重点:

- `username`
- `password`
- `deviceId`
- `deviceName`
- `platform`
- `appType`

说明:

- 当前系统只允许单用户
- 如果请求携带设备标识，注册时会把当前设备直接加入受信任设备

### POST `/api/auth/login`

用途:

- 用户登录

请求体重点:

- `username`
- `password`
- `deviceId`
- `deviceName`
- `platform`
- `appType`

说明:

- 如果设备未批准，接口会返回 `202`，并带上 `approvalRequired` 与 `requestToken`
- 已批准设备登录成功后会签发 token 并设置 Cookie

## 4. 登录后接口

### GET `/api/auth/user`

用途:

- 读取当前登录用户信息

### POST `/api/auth/logout`

用途:

- 登出并清理认证 Cookie

## 5. 用户相关接口

注意:

- 在 `CODEX_ONLY_HARDENED_MODE=true` 下，`/api/user/git-config` 仍会返回 `403`，因为该接口会修改本机 Git 配置。
- `GET /api/user/language`、`PUT /api/user/language`、`POST /api/user/complete-onboarding`、`GET /api/user/onboarding-status` 在 hardened mode 下保持可用，供前端初始化与引导流程使用。

### GET `/api/user/git-config`

用途:

- 获取用户级 Git 姓名和邮箱
- 如数据库为空，会尝试读取系统 Git 配置

### POST `/api/user/git-config`

用途:

- 更新数据库中的 Git 配置
- 尝试同步写入系统全局 `git config --global`

### GET `/api/user/language`

用途:

- 获取用户级语言偏好

### PUT `/api/user/language`

用途:

- 更新用户级语言偏好

支持值:

- `en`
- `ko`
- `zh-CN`
- `ja`
- `ru`

### POST `/api/user/complete-onboarding`

用途:

- 标记用户完成引导

### GET `/api/user/onboarding-status`

用途:

- 查询当前用户是否已完成引导

## 6. 项目与工作区接口

### POST `/api/projects/create-workspace`

用途:

- 创建工作区或接入现有目录

请求体重点:

- `workspaceType`: `existing` 或 `new`
- `path`
- `githubUrl`
- `githubTokenId`
- `newGithubToken`

关键约束:

- 会进行工作区路径安全校验
- 不能使用系统关键目录
- 必须落在允许的工作区根目录下
- 在 hardened mode 下当前会被禁用

### GET `/api/projects/clone-progress`

用途:

- 查询克隆工作区时的进度

### 其他高频项目接口

前端当前还直接依赖以下一组项目接口，主要由上游项目能力提供，并在本项目中继续使用:

- `GET /api/projects`
- `GET /api/projects/:projectName/sessions`
- `GET /api/projects/:projectName/sessions/:sessionId/messages`
- `PUT /api/sessions/:sessionId/rename`
- `PUT /api/projects/:projectName/rename`
- `PUT /api/projects/:projectName/hidden`
- `DELETE /api/projects/:projectName/sessions/:sessionId`
- `DELETE /api/projects/:projectName`
- `GET /api/projects/:projectName/file`
- `PUT /api/projects/:projectName/file`
- `GET /api/projects/:projectName/files`
- `POST /api/projects/:projectName/files/create`
- `PUT /api/projects/:projectName/files/rename`
- `DELETE /api/projects/:projectName/files`
- `POST /api/projects/:projectName/files/upload`

说明:

- 通用文件上传仍走 `files/upload`；聊天输入区图片与普通附件请以 `/chat-attachments` 专用链路为准。
- 当前剩余工作是补自动化验收，而不是补聊天附件接口。

## 7. Codex 相关接口

### GET `/api/codex/config`

用途:

- 读取 `~/.codex/config.toml`

返回重点:

- `model`
- `mcpServers`
- `approvalMode`

### GET `/api/codex/sessions`

用途:

- 根据 `projectPath` 查询 Codex 会话列表

查询参数:

- `projectPath`

说明:

- 返回标题当前优先来自 `~/.codex/state_5.sqlite -> threads.title`
- 如果 native title 不存在，才回退到 rollout 自动摘要
- 不再对 Codex 会话叠加 `auth.db.session_names / session_auto_titles` 的网页私有覆盖

### PUT `/api/sessions/:sessionId/rename`

用途:

- 重命名会话标题

请求体重点:

- `summary`
- `provider`

说明:

- 当 `provider=codex` 时，服务端会把标题主写到 `~/.codex/state_5.sqlite -> threads.title`
- 同时会同步更新 `~/.codex/session_index.jsonl -> thread_name`
- 不会改写 `~/.codex/sessions/**/*.jsonl` rollout transcript
- `auth.db.session_names` 与 `session_auto_titles` 对 Codex 不再作为标题事实源
- 对其他 provider，仍沿用原有 `auth.db` 标题覆盖语义

### GET `/api/codex/sessions/:sessionId/messages`

用途:

- 读取指定 Codex 会话消息

查询参数:

- `limit`
- `offset`

### DELETE `/api/codex/sessions/:sessionId`

用途:

- 归档 Codex 会话

说明:

- 当前语义对齐 Codex CLI 的“归档”行为，不是永久物理删除。
- 服务端会把对应 rollout `jsonl` 从 `.codex/sessions/` 移动到 `.codex/archived_sessions/`。
- 同时会把 `state_5.sqlite.threads.archived=1`、`archived_at` 和 `rollout_path` 同步更新到归档路径。
- 已归档会话会从网页侧边栏列表中隐藏。

### Codex 本地存储与恢复说明

网页端新建 Codex 会话时，本地真实持久化仍然涉及三层数据，但服务端只补写后两层元数据:

1. `~/.codex/sessions/**/*.jsonl`
   - 真正的 rollout 会话文件
   - 由 Codex CLI 原生写入，服务端信任 CLI，不再回写 rollout 内容
2. `~/.codex/state_5.sqlite -> threads`
   - CLI 最近会话、`resume --last`、交互选择器依赖的线程元数据
   - `threads.title` 也是当前 Codex 会话标题的主事实源
   - 如果线程行晚于 `thread.started` 才出现，服务端会按退避策略后台重试补写
3. `~/.codex/session_index.jsonl`
   - 兼容索引，不是唯一事实来源
   - `thread_name` 会跟随 `threads.title` 同步更新

排障时要注意:

1. `session_index.jsonl` 字段不完整，不等于“网页端没有保存”
2. `codex resume <sessionId>` 更依赖 rollout `jsonl`
3. `codex resume --last` 和交互选择器更依赖 `state_5.sqlite.threads`
4. 如果 CLI “按最近恢复”看不到新会话，优先检查 `threads` 行是否补齐，而不是只看 `session_index.jsonl`

### GET `/api/codex/mcp/cli/list`

用途:

- 调用 `codex mcp list`，读取 CLI 已注册 MCP 服务

### POST `/api/codex/mcp/cli/add`

用途:

- 调用 `codex mcp add` 增加 MCP 服务

### DELETE `/api/codex/mcp/cli/remove/:name`

用途:

- 调用 `codex mcp remove` 删除 MCP 服务

### GET `/api/codex/mcp/cli/get/:name`

用途:

- 调用 `codex mcp get` 获取单个 MCP 服务详情

### GET `/api/codex/mcp/config/read`

用途:

- 读取 Codex MCP 配置文件内容

## 8. WebSocket 与推送

当前在 `server/index.js` 中可以确认的推送消息至少包括:

- `loading_progress`
  - 项目或会话加载过程中的进度更新
- `projects_updated`
  - 项目目录监听器检测到变化后的广播事件

说明:

- WebSocket 连接同样受认证状态影响
- 若后续新增消息类型，应同步在本文件登记

## 9. 已知限制

- 本文档不是上游 `claudecodeui` 的完整 OpenAPI 替代品。
- 当前项目默认 hardened mode 会关闭一部分路由，文档应始终以当前 `server/index.js` 的挂载逻辑为准。
- 聊天附件接口已经落地；当前剩余短板是缺一条稳定的本地 UI 自动化验收脚本，若后续调整附件模型或限制，需同步更新本文档。

## 2026-03-22 Chat Attachments Update

### POST `/api/projects/:projectName/chat-attachments`

用途:

- 上传聊天输入框中的图片与普通附件。
- 当前实现主要用于 Codex 会话；图片会作为 `local_image` 输入，普通附件目录会加入 `additionalDirectories`。

限制:

- 最多 15 个附件。
- 单个附件最大 20MB。
- 附件保存到应用临时目录，并按“用户 + 项目”隔离。

返回字段:

- `attachments[].name`
- `attachments[].path`
- `attachments[].size`
- `attachments[].mimeType`
- `attachments[].kind` (`image | file`)
- `attachments[].previewUrl`

### GET `/api/projects/:projectName/chat-attachments/content`

用途:

- 预览或读取当前用户在当前项目下上传的临时附件。

查询参数:

- `filePath`: 服务端返回的附件绝对路径。

安全约束:

- 仅允许访问当前用户、当前项目的临时附件目录。
- 超出受控目录的路径会被拒绝。

### 本次行为更新

- 聊天输入框现在支持“复制粘贴图片/文件”“拖拽图片/文件”“文件选择上传”。
- Codex 会话支持图片与普通附件同时发送。
- 非 Codex 会话继续只支持图片，不支持普通附件。

## 13. 2026-03-23 附件查看链路补充

### 聊天附件响应元数据

`POST /api/projects/:projectName/chat-attachments` 的单个附件对象现在额外返回：

- `contentUrl`: 受保护的附件内容地址
- `downloadUrl`: 受保护的附件下载地址
- `previewKind`: `image | markdown | text | unsupported`
- `previewUrl`: 兼容旧前端，当前等价于 `contentUrl`

说明：

- 前端附件缩略图、站内查看器、下载按钮都应优先使用这些字段
- 不再依赖浏览器直接访问“裸链接”完成鉴权

### GET `/api/projects/:projectName/chat-attachments/content` 新参数

新增查询参数：

- `download=1`
  - 返回 `Content-Disposition: attachment`
  - 用于前端显式下载
- `maxBytes=<number>`
  - 仅允许文本类附件预览
  - 服务端最多截断到 `4MB`
  - 响应头会补充：
    - `X-Chat-Attachment-Preview-Kind`
    - `X-Chat-Attachment-Original-Size`
    - `X-Chat-Attachment-File-Name`
    - `X-Chat-Attachment-Max-Bytes`
    - `X-Chat-Attachment-Truncated`

约束：

- `maxBytes` 只适用于 `markdown` 和 `text` 预览
- 超出当前用户/当前项目临时附件目录的路径仍会被拒绝

### 前端访问约定

`src/utils/api.js` 现已提供：

- `buildChatAttachmentUrl(...)`
- `resolveChatAttachmentUrl(...)`
- `fetchChatAttachmentBlob(...)`
- `fetchChatAttachmentTextPreview(...)`
- `downloadChatAttachment(...)`

说明：

- 这些方法统一复用 `authenticatedFetch`
- 图片缩略图、站内查看器、下载动作应通过这些方法访问附件
