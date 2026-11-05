# patches

对 `../vendor/ui-workspace` 的改动，一个主题一个 `.patch`，用 `git diff` 生成（路径相对仓库根）。

改完 vendor 里的文件后：

```sh
git diff -- packages/workspace-seat/vendor/ui-workspace > packages/workspace-seat/patches/<主题>.patch
git checkout -- packages/workspace-seat/vendor/ui-workspace
node scripts/vendor-upstream.mjs --check
```

规则：**vendor 目录永远保持上游原样**。手工改 vendor 而不落补丁，下一次 re-vendor 会静默丢掉改动，所以脚本会把补丁当作唯一真相。
