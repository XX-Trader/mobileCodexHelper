# VS Code Codex 会话时间补丁

## 1. 目的

这份文档说明如何在本机对 OpenAI VS Code Codex 扩展打补丁，把会话列表的时间显示从“会话创建时间”改为“最后更新时间”。

当前已验证版本：

- `openai.chatgpt-26.318.11754-win32-x64`
- 2026-03-23 已在该版本执行并验证补丁

适用场景：

- 网页端同一个会话已经继续回答，显示“最近几分钟内”
- VS Code 里的 Codex 会话列表仍显示“1 天前”
- 需要在本机稳定复用这项修正，并在扩展升级后快速重打

## 2. 背景

当前本机 OpenAI VS Code 扩展的会话列表逻辑读取的是线程创建时间：

- `thread/list` 请求使用 `sortKey:"created_at"`
- 会话列表条目的 `timing.startTime` 取自 `createdAt`
- 同一会话后续继续回答时，列表时间不会跟随最后一轮更新时间刷新

网页端不是这条链路。网页端 Codex 会话时间来自 rollout `jsonl` 的最后一条事件时间，所以会更接近真实最后活动时间。

## 3. 脚本位置

补丁脚本：

- `scripts/patch-vscode-codex-session-time.ps1`
- `scripts/ensure-vscode-codex-session-time-patch.ps1`

脚本行为：

1. `patch-vscode-codex-session-time.ps1`
   - 自动定位最新的 `openai.chatgpt-*` VS Code 扩展目录
   - 备份原始 `out/extension.js`
   - 把会话列表时间逻辑从 `createdAt` 改为 `updatedAt ?? createdAt`
   - 把线程列表排序键从 `created_at` 改为 `updated_at`
   - 幂等执行；如果当前扩展已经打过补丁，会直接跳过
2. `ensure-vscode-codex-session-time-patch.ps1`
   - 读取项目本地状态文件 `.runtime/vscode-codex-session-time-patch-state.json`
   - 对比当前最新安装扩展版本与上次已确认版本
   - 当前版本未补丁，或版本已变化时，自动调用 `patch` 脚本
   - 当前版本已经补丁时，只刷新状态记录并退出

## 4. 使用方式

推荐在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ensure-vscode-codex-session-time-patch.ps1
```

`ensure` 脚本会优先做版本判定，只有需要时才自动调用实际补丁脚本。

如需直接重跑底层补丁，也可以执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/patch-vscode-codex-session-time.ps1
```

执行成功后，脚本会输出当前被修改的扩展目录，并提示重载 VS Code。

建议执行完后在 VS Code 中操作一次：

1. `Ctrl + Shift + P`
2. 执行 `Developer: Reload Window`

## 5. 生成的文件

`patch` 脚本会在目标扩展目录旁边生成两个文件：

- `out/extension.js.mobilecodexhelper.original.js`
  - 原始 bundle 备份
- `out/extension.js.mobilecodexhelper.patch.json`
  - 本次补丁的元数据记录

`ensure` 脚本会在仓库运行态目录生成：

- `.runtime/vscode-codex-session-time-patch-state.json`
  - 当前最新安装扩展版本
  - 上次已确认/已补丁版本
  - 最近一次检查动作与时间

## 6. 升级后的处理方式

OpenAI VS Code 扩展升级后，通常会安装到新的版本目录，例如：

```text
C:\Users\<用户名>\.vscode\extensions\openai.chatgpt-<新版本>
```

升级后旧目录上的补丁不会自动带到新版本目录，所以优先重新执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ensure-vscode-codex-session-time-patch.ps1
```

它会自动识别当前最新版本是否已经补丁；只有未补丁时才会继续执行底层 `patch` 脚本。

如果只想手动直连底层补丁，也可以执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/patch-vscode-codex-session-time.ps1
```

无论哪种方式，脚本都会自动找到最新版本目录。

## 7. 失败与回滚

### 7.1 失败时

如果扩展升级后 bundle 结构发生变化，脚本会 Fail-Fast 停止，并报出类似下面的错误：

- `Patch anchor missing`
- `Patch anchor is no longer unique`

这表示新版本的目标代码结构变了，需要重新检查补丁点，不能盲目覆盖。

### 7.2 回滚时

如果需要手动回滚，可以把备份文件覆盖回去：

```powershell
Copy-Item `
  -LiteralPath "$HOME/.vscode/extensions/<扩展目录>/out/extension.js.mobilecodexhelper.original.js" `
  -Destination "$HOME/.vscode/extensions/<扩展目录>/out/extension.js" `
  -Force
```

然后重载 VS Code。

## 8. 限制

- 这是本机扩展补丁，不是网页端补丁
- 它只影响 VS Code Codex 扩展里的会话列表时间显示与排序
- 它不会修改 Codex 会话本身的真实存储数据
- 扩展升级后仍需至少重新执行一次 `ensure` 脚本
