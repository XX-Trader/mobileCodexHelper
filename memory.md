# 项目记忆

这份文件记录 `mobileCodexHelper` 的长期稳定记忆，目的是让后续维护、排障和协作不必每次都重新扫描整个仓库。

## 1. 项目定位

- 项目目标: 把电脑上本地运行的 Codex 会话，通过私有网页面板安全延伸到手机端。
- 目标用户: 单个电脑所有者本人，不面向多人协作。
- 默认安全边界:
  - 单用户系统
  - 新设备首次登录必须由电脑端批准
  - 默认推荐通过 Tailscale 私网访问
  - Node 应用和 nginx 默认都只在本机回环地址上工作
- 默认产品形态:
  - Windows 桌面控制工具
  - 本地 Node Web UI
  - 手机浏览器访问入口

## 2. 核心架构

推荐访问链路如下:

```text
手机浏览器
   ↓
Tailscale 私网 HTTPS
   ↓
本机 nginx 代理
   ↓
本机 claudecodeui + mobileCodexHelper 覆盖层
   ↓
电脑上的本地 Codex 会话
```

关键端口:

- 应用服务: `127.0.0.1:3001`
- nginx 代理: `127.0.0.1:8080`

关键运行模式:

- 默认开启 `Codex-only hardened mode`
- 当前项目核心体验围绕 `codex`，其他 provider 相关能力应谨慎开启

## 3. 仓库结构记忆

- `mobile_codex_control.py`
  - 桌面控制工具核心入口
  - 负责服务状态、Tailscale 远程访问、设备审批、日志摘要和错误提示
- `upstream-overrides/claudecodeui-1.25.2/`
  - 自定义覆盖层
  - 这里是功能修改的主要落点
- `vendor/claudecodeui-1.25.2/`
  - 上游源码副本
  - 原则上保持接近上游，不作为自定义修改首选位置
- `scripts/`
  - 负责启动、停止、打包、部署检查、覆盖自测
- `config/mobile-projects.json`
  - 控制移动端项目白名单
- `tmp/logs/`
  - 本地应用日志重点查看目录
- `.runtime/`
  - 运行期 nginx 与控制状态相关目录

## 4. 数据与状态落点

- 认证数据库:
  - 优先使用 `DATABASE_PATH`
  - 否则按代码逻辑在多个候选位置中解析，重点包括:
    - `vendor/claudecodeui-1.25.2/server/database/auth.db`
    - `~/.cloudcli/auth.db`
    - `~/.codex/auth.db`
- 关键表:
  - `users`
  - `trusted_devices`
  - `device_approval_requests`
  - `session_names`
  - `session_auto_titles`
  - `session_continuations`
  - `app_config`
- 控制状态:
  - `.runtime/mobile-codex-control-state.json`
- 项目白名单:
  - `config/mobile-projects.json`

## 5. 需要持续记住的稳定事实

- 这是“手机查看和聊天控制”项目，不是远程桌面。
- 不应默认把高风险管理能力直接暴露到移动端。
- 聊天图片/普通附件上传链路已经落地，对应专用接口是:
  - `POST /api/projects/:projectName/chat-attachments`
  - `GET /api/projects/:projectName/chat-attachments/content`
- Codex safe continuation 已落地，旧 rollout 不改写，链路关系持久化到 `session_continuations`。
- 任何影响认证、白名单、反代入口、对外暴露面的改动，都必须同步更新文档。

## 6. 当前待收口事项

- 聊天相关改动仍需补一轮回归闭环验证。
- 本地 UI 自动化验收脚本仍未补齐，尤其是图片/附件上传、发送和状态回显链路。
- 中英文文档还没有建立稳定同步策略，当前中文文档是主事实来源。

## 7. 维护约定

- 需求变更: 更新 [docs/requirements.md](docs/requirements.md)
- 接口变更: 更新 [docs/api.md](docs/api.md)
- 架构、路径、部署、运行方式变更: 更新 [docs/technical.md](docs/technical.md) 和本文件
- 任务新增: 写入 [todo.md](todo.md)
- 任务完成: 追加到 [done.md](done.md)
- 在 Windows PowerShell 中查看 UTF-8 中文文档时，先设置输出编码为 UTF-8，不要把终端显示乱码误判为文件损坏

## 8. 新 Agent 快速进入方式

1. 先读 [index.md](index.md)
2. 再读 [memory.md](memory.md)
3. 根据任务类型补读:
   - 产品目标看 [docs/requirements.md](docs/requirements.md)
   - 接口和鉴权看 [docs/api.md](docs/api.md)
   - 架构和排障看 [docs/technical.md](docs/technical.md)
4. 开工前检查 [todo.md](todo.md)、[done.md](done.md) 和当前工作区未提交改动
