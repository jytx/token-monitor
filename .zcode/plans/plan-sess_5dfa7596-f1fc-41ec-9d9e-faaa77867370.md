## 拆分 4 个 commit 为 3 个独立分支

### 背景

`fix/exit-hang-on-watcher-close` 分支上有 4 个 commit，对应 3 个独立 bug 修复：

| Commit | 主题 | 影响文件 |
|---|---|---|
| `e2f4ec2` | fix(quit): 退出卡死（SIGKILL 兜底） | main.js + collector.js + deviceRuntime.js |
| `30bf2bd` | fix(collector): mimo watch 风暴 | collector.js |
| `ebbae8c` | fix(boot): anchor 预填 localStats | main.js |
| `8a21d20` | fix(boot): anchor push 改用 sendMainWindowEvent | main.js |

分支名误导性强（只对应第一个 fix），且 3 个修复相互独立、各自对应独立 PR。拆 PR review 清晰，便于 cherry-pick / revert。

### Commit 依赖分析

- `e2f4ec2` ↔ `30bf2bd`：两个都在 collector.js，但改动位置完全不重叠（2026/2137 行 vs 1212/1247/1281 行）。**可独立 cherry-pick**。
- `ebbae8c` ↔ `8a21d20`：`8a21d20` 修改 `ebbae8c` 引入的 `primeLocalStatsFromAnchor` 函数。**必须一起 cherry-pick**（commit message 也明确引用 "之前一个 fix(boot)"）。

### 操作步骤

1. **创建三个新分支（基于 main）**
   ```bash
   git checkout main
   git checkout -b fix/quit-hang-on-sigterm
   git cherry-pick e2f4ec2

   git checkout main
   git checkout -b fix/mimo-watch-storm
   git cherry-pick 30bf2bd

   git checkout main
   git checkout -b fix/boot-anchor-hydration
   git cherry-pick ebbae8c 8a21d20   # 一起 cherry-pick
   ```

2. **每个分支验证**
   - `npm run lint`：无错误
   - `npm test`：2410 pass
   - `npm run verify`：同上

3. **旧分支 `fix/exit-hang-on-watcher-close` 处理**
   - 重命名为 `fix/exit-hang-on-watcher-close_archive`（本地 + 远端）
   - 不删 commit 记录，安全可逆
   - 你提完 3 个 PR 后可手动 `git push origin --delete fix/exit-hang-on-watcher-close_archive`

4. **不 push（你没要求 push）**
   - 3 个新分支留在本地
   - 你需要 push 时告诉我，每个 push 前我再 `npm run verify` 一次确认

### 风险评估

- **乐观**：4 个 commit 在 main 上的合并 diff 应该等于现有 fix 分支的总 diff（commits 本身没改动）。cherry-pick 应该零冲突。
- **唯一风险点**：`ebbae8c + 8a21d20` 如果 8a21d20 行的上下文因 main 分支漂移产生偏移——但 main 近期没有 collector.js 相关改动（看 git log），应该零冲突。
- **完全可逆**：每个 cherry-pick 都在新分支上做，旧的 `fix/exit-hang-on-watcher-close` 仍在。

### 验证脚本

每个分支切过去后：
```bash
npm run verify  # lint + 2410 test
```

### 需要确认的执行顺序

我会按以下顺序操作，每完成一步就停下来让你过目：

1. **第一步**：在 main 上创建 `fix/quit-hang-on-sigterm` 并 cherry-pick `e2f4ec2`，跑 verify
2. **第二步**：在 main 上创建 `fix/mimo-watch-storm` 并 cherry-pick `30bf2bd`，跑 verify
3. **第三步**：在 main 上创建 `fix/boot-anchor-hydration` 并 cherry-pick `ebbae8c + 8a21d20`，跑 verify
4. **第四步**：旧分支重命名为 `_archive`

每步完成后停下来，让你确认 OK 再继续。