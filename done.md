# DONE
- 2026-03-24: 修复 Codex 会话重命名后的标题同步边界；侧边栏会话名现在优先读取 `title`，并在改名成功后对当前会话注入前端本地标题覆盖，避免后端刷新慢半拍时出现“顶部已更新、左侧仍是旧名”的短暂不一致。
- 2026-03-23: 修复 Processing 页面的 token 饼图闪烁；聊天页现在会为当前会话保留最后一个有效的 `tokenBudget`，并在 runtime 快照回写时继续沿用该稳定值，避免处理中的会话在 `100%` 与 `0%` 之间来回跳变导致页面闪动。
- 2026-03-23: 优化 Codex 会话重命名交互体验；桌面端把编辑态从 hover 浮层改为稳定可见的独立面板，修复“点击改名后需移动鼠标才出现输入框”；移动端同步放大按钮、提升输入区样式，并在进入编辑和视口变化时自动滚动到可视区域，缓解软键盘遮挡问题。
- 2026-03-23: 修复未读红点历史脏数据导致的“后端有未读但当前会话列表不变红”；服务端现在会在读取 `session_notifications` 时按当前仍可发现的 Codex 会话过滤未读，并自动清理旧版本遗留的孤儿 `session_id` 记录。
- 2026-03-23: 完成 Codex 会话标题数据源收口；网页端 Codex 列表现在优先读取 `~/.codex/state_5.sqlite.threads.title`，`/api/sessions/:sessionId/rename` 对 Codex 改为原生写入 `threads.title + session_index.jsonl.thread_name`，并移除了 Codex 对 `auth.db.session_names/session_auto_titles` 的标题依赖；已做真实会话“临时改名再改回”的往返验证，确认 sqlite、session_index 与网页读取同步生效。
- 2026-03-23: 修复完成态未读红点的同步竞态；`AppContent` 现在在收到 `codex-complete/claude-complete` 等完成事件后主动补拉一次 `get-session-notifications`，避免 `session-notifications-state` 被紧随其后的 websocket 消息覆盖时出现“后端已写未读但前端偶发不变红”。
- 2026-03-23: Stopped the current chat page from consuming the global `processingSessions` bridge; sidebar and project summaries still use the shared processing set, but the active chat surface now relies on session runtime and session-status only.
- 2026-03-23: Fixed Processing re-entry regression by forcing a fresh `check-session-status` whenever a real session chat view is restored, and by clearing background session runtime snapshots when websocket lifecycle signals prove that session is no longer processing.
- 2026-03-23: Prevented refresh-time Processing flicker by waiting for a fresh `active-sessions` baseline before treating global `claude-status` and permission messages as authoritative processing-start signals in `AppContent`.
- 2026-03-23: 完成聊天附件访问链路加固与站内查看器首版。后端 `chat-attachments` 响应新增 `contentUrl/downloadUrl/previewKind`，`GET /api/projects/:projectName/chat-attachments/content` 新增 `download=1` 与 `maxBytes`；前端新增受保护附件访问工具、聊天内图片缩略图鉴权加载、站内附件查看器、Markdown 新窗口预览页，以及日志/文本文件截断预览与下载能力。
# 2026-03-23
- Fixed stale global Processing synchronization by updating `processingSessions` from websocket `session-status`, `claude-status`, permission, and terminal lifecycle messages in `AppContent`, reducing completed-session Processing flicker when other sessions continue running.

- 2026-03-23: 完成项目文档二次整理与编码收口，统一了 [index.md](index.md)、[memory.md](memory.md)、[agent.md](agent.md)、[todo.md](todo.md)、[done.md](done.md)、[docs/requirements.md](docs/requirements.md)、[docs/api.md](docs/api.md)、[docs/technical.md](docs/technical.md) 的状态描述；移除了“聊天图片/附件上传仍待修复”的过期表述，改为以“回归验证 + 本地 UI 自动化验收脚本”作为剩余待办，并补充了 Windows PowerShell 查看 UTF-8 中文文档的编码说明。
- 2026-03-23: 完成本机 VS Code Codex 扩展会话时间补丁工具，新增 `scripts/patch-vscode-codex-session-time.ps1`，可自动定位最新 `openai.chatgpt-*` 扩展目录、备份 `out/extension.js`、把会话列表时间改为按 `updated_at / updatedAt` 排序与显示，并以幂等方式支持扩展升级后重复执行。
- 2026-03-23: 完成 VS Code Codex 会话时间补丁文档，新增 [docs/vscode-codex-session-time-patch.md](docs/vscode-codex-session-time-patch.md)，补充补丁目的、使用方式、升级后重打流程与回滚说明，并同步更新索引与技术文档入口。
- 2026-03-23: 完成 VS Code Codex 会话时间补丁自动确保机制，新增 `scripts/ensure-vscode-codex-session-time-patch.ps1`；脚本会记录 `.runtime/vscode-codex-session-time-patch-state.json`，识别当前最新安装扩展版本，并在版本变化或当前版本未补丁时自动触发底层补丁。当前已验证版本为 `openai.chatgpt-26.318.11754-win32-x64`。

- 2026-03-23: 收紧会话回复中的 sidebar 刷新链路；处理中的会话现在会冻结 `selectedProject/selectedSession` 绑定，避免左侧列表按时间重排时把主聊天区选中对象替换掉；同时把聊天实时处理与外部消息重载中的关键 effect 依赖改为 `sessionId/provider/projectName` 等稳定字段，降低因对象刷新导致的状态抖动和 `Processing` 闪烁。

- 2026-03-23: 收口会话级 runtime 读写链路，新增按显式 `SessionViewTarget` 读写 `chatRuntime` 的能力；`ChatInterface` 改为按实际视图会话 target 持久化状态，并在模板/切换占位面板期间禁止把 idle runtime 写回会话，减少新建会话首帧把 `Processing` 时间和运行态写坏的问题。

- 2026-03-23: 修复了 Processing 状态条 `startedAt` 的跨会话串值；`startedAt` 现在按 `view key` 绑定和持久化，切回新会话时不会再把上一个已完成会话的发送时间写进当前运行中的会话。

- 2026-03-23: 删除“会话搜索结果点击后自动跳转到指定消息位置”的行为；现在点击其他会话或搜索命中只做普通会话切换，消息定位统一交给“上一条 / 下一条”导航键。

## 2026-03-23

- 修复了聊天 Processing 状态在多会话切换后的运行态恢复：切回仍在处理中的会话时，前端会优先复用会话级 runtime 快照，不再先把 `isLoading/claudeStatus/canAbortSession` 清空再补回，避免状态条持续闪烁。
- 修复了 Processing 状态条“发送于”时间漂移：状态起始时间恢复时不再把缺失时间错误回退到当前时刻，切回会话后会优先使用已持久化的 `startedAt`，拿不到可靠时间时先不显示错误时间。
- 修复了会话级 Processing 卡片串态：前端不再恢复或持久化“已闲置会话的占位 `Processing/Working` 状态”，并在会话生命周期结束与前台重同步时同步清空状态条，避免其他会话运行时把当前已完成会话错误显示为 `PAUSED + Processing`。
- 收紧了新建会话的状态边界：首次发送时就为 `new-session-*` optimistic session 注入独立 `chatRuntime`，并把模板页/optimistic session/真实 session 的 key 与 `session-status` 判定统一，避免首轮回答前切页仍回落到模板页状态而闪烁。

## 2026-03-21

- 完成聊天 Markdown 文件自动链接补齐，聊天正文中的裸 `.md/.markdown` 路径和反引号中的 Markdown 路径现在都会跳到 `/file-preview`，可直接打开计划文档。
- 完成项目文档体系整理，新增 [index.md](index.md)、[memory.md](memory.md)、[agent.md](agent.md) 作为根目录知识入口。
- 完成正式文档补齐，新增 [docs/requirements.md](docs/requirements.md)、[docs/api.md](docs/api.md)、[docs/technical.md](docs/technical.md)。
- 完成会话级聊天页面改造方案文档，新增 [docs/chat-session-view-state-plan.md](docs/chat-session-view-state-plan.md)，明确会话级 `activeTab`、按访问加载和聊天运行时状态边界。
- 完成会话级聊天视图第一阶段实现，主内容区 `activeTab` 已改为跟随会话持久化，并新增 `mountedTabs` 与聊天运行时快照存储，支持已访问页面按会话懒挂载、临时会话迁移到真实会话时复用对应视图状态。
- 完成任务台账重构，将 [todo.md](todo.md) 统一为四象限结构，并建立“完成任务同步归档到 `done.md`”规则。
- 完成 Codex 会话索引写入逻辑调整，在 `session_index.jsonl` 中补充 `cwd`、`originator`、`source` 元数据写入代码，待服务重启后验证 CLI 会话可见性。
- 完成 Codex 会话索引元数据对齐，后续新会话会优先写入 `codex_sdk_ts` 作为 `originator`，并允许再次触达时修正旧索引条目。
- 完成本机 `codex` 命令包装，在 `C:\Users\Administrator\AppData\Roaming\npm\codex.cmd` 建立稳定入口，支持直接在终端执行 `codex`。
- 完成 Codex 二进制发现逻辑修正，Windows 环境下会把 `codex.cmd` 包装器解析为真实 `codex.exe`，避免网页端误回落到内置 `@openai/codex-sdk 0.101.0`。
- 完成网页端新建 Codex 会话元数据对齐，使用 VS Code 扩展二进制时会写入与真实会话文件一致的 `originator/source/cli_version`，恢复已有会话时不再覆写旧索引来源。
- 完成 Codex 会话恢复兼容修复，网页端新会话现在会同步修正 `state_5.sqlite` 与 `sessions/*.jsonl` 的来源元数据，避免被 CLI 当成 `exec` 非交互会话而从 `codex resume` 列表中隐藏。
- 完成 Codex 会话删除语义改造，网页端对 Codex 会话现在改为写入 `state_5.sqlite.threads.archived=1` 的归档操作，并在侧边栏中过滤已归档会话、统一展示为“删除”交互。
- 完成侧边栏会话与项目管理入口恢复，重新接通会话“删除”、项目“隐藏”、隐藏项目列表与“取消隐藏”前端按钮和弹窗链路。
- 完成历史 SDK-only Codex 会话删除兼容，删除旧测试会话时若缺少 `threads` 行，会从 rollout 文件补最小线程记录后再归档，避免再次出现 `Codex thread not found`。
- 完成 Codex-only hardened 模式下的会话归档链路修复，网页端“删除”现已真正调用后端归档接口，并按 Codex CLI 语义把 rollout `jsonl` 移动到 `.codex/archived_sessions/`，同时同步更新 `state_5.sqlite.threads.rollout_path/archived/archived_at`。
- 完成会话状态标记显示修复，左侧会话列表与聊天顶部最近会话条都改为独立显示处理中绿点和未读红点，项目旁继续保留红绿数字统计。
- 完成会话状态标记视觉微调，左侧列表状态点移回条目左侧，并把红绿状态颜色调整为更淡的低饱和版本。
- 完成 Codex 会话本地存储方案文档补充，明确网页端新建会话的三层落盘结构（rollout `jsonl`、`state_5.sqlite.threads`、`session_index.jsonl`）以及 `codex resume <sessionId>` / `codex resume --last` 的不同判定来源。
- 完成 Codex 会话持久化策略收口，网页端现已信任 CLI 原生 rollout 文件，不再回写 rollout 首行，同时为 `state_5.sqlite.threads` 元数据补写增加后台退避重试，缓解线程记录晚到导致的恢复可见性问题。
- 完成“会话模板页”语义落地：统一文档与前端状态模型中的模板页命名，新增模板页视图 helper，并收紧新建对话时的模板页草稿键、主聊天面板 key 与实时会话归属判断，避免旧会话状态泄漏到新建对话。

## 2026-03-22

- 统一了会话删除入口：主会话顶部删除按钮与左侧会话删除按钮现在共用同一套删除确认弹窗、同一条删除请求链路；“最近会话”的 `X` 继续只做“从最近列表移除”。
- 修复了 Codex 空项目保留：删除最后一个 Codex 会话时，后端会把对应项目自动持久化到 `~/.claude/project-config.json`，所以项目即使没有会话也会继续显示在左侧，并可继续新建聊天或手动隐藏/恢复显示。
- 完成聊天输入框图片/附件能力修复：支持复制粘贴、拖拽上传、文件选择上传、聊天消息附件展示，以及 Codex 图片 `local_image`/普通附件 `additionalDirectories` 发送链路。
- 完成后端临时聊天附件上传与预览接口补充：新增 `POST /api/projects/:projectName/chat-attachments` 与 `GET /api/projects/:projectName/chat-attachments/content`。
- 完成集成验证：已执行 `scripts/apply-upstream-overrides.ps1`、`npm run typecheck`、`npm run build`，均通过；当前仅剩本地常驻服务受命令策略限制，未完成浏览器自动化冒烟。
- 2026-03-23: 收紧 Web 端会话未读消费语义；红点仍由服务端 `session_notifications` 持久化，但自动清红已从 `AppContent` 壳层下沉到 `ChatInterface`，只有聊天页处于前台、窗口聚焦、会话消息已加载完成时才调用 `/api/session-notifications/read`。Codex CLI 的打开、继续、resume 不再被视为消费 Web 提醒。
