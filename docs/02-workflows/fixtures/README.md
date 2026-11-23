# 工作流夹具

八组工作流用到的本地替身。每个 `ucNN.sh` 在一个**空的 HOME** 里建好仓库、裸远端和数据文件，不联网，不碰 HOME 以外的目录。

```sh
H=$(mktemp -d) && mkdir -p "$H/bin" "$H/dev" "$H/remotes"
env -i HOME="$H" PATH="$H/bin:/usr/bin:/bin" bash docs/02-workflows/fixtures/uc02.sh
```

不要在主人的真实 HOME 里运行。需要 git 身份和默认分支 `main`（`.gitconfig` 或 `GIT_CONFIG_*`）。

隔离环境的做法（2026-11-23 使用）：bubblewrap 只读挂载整机、把 `/home` 换成空目录并绑定上面的 HOME，`--unshare-pid`；工作台用独立端口和 `NG_DESK_DATA_DIR`，`NG_AGENT_RUNNERS=codex` 与 `NG_CODEX_MODEL_STRONG/FAST` 固定模型；外部助手和后台各用一个 `CODEX_HOME`，关闭账号连接器。登录只放访问令牌，不放刷新令牌，避免替主人轮换登录。冻结测试要按 PID 命名空间找进程，`nsenter` 进去的进程不在容器进程树里。

`forge` 代替代码平台：`mr create/view/list/merge` 和 `ci status`。CI 首轮在 `lint` 上失败（已知偶发），自动重跑，约 150 秒后通过。
