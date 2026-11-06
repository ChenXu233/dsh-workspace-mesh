# patches

对 `../vendor/ui-workspace` 的改动，一个主题一个 `.patch`，用 `git diff` 生成（路径相对仓库根）。

改完 vendor 里的文件后：

```sh
git diff -- packages/workspace-remote-mesh/vendor/ui-workspace > packages/workspace-remote-mesh/patches/<主题>.patch
git checkout -- packages/workspace-remote-mesh/vendor
node scripts/vendor-upstream.mjs --check
```

规则：**vendor 目录永远保持上游原样**。手工改 vendor 而不落补丁，下一次 re-vendor 会静默丢掉改动，所以脚本会把补丁当作唯一真相。

当前补丁：`01-remote-workspaces.patch` —— 让浏览器把 peer 的工作区当作派生分组追加到列表尾部（地球图标、`@机器名` 后缀、悬浮卡写机器与远端路径），并隐藏本地动作。
