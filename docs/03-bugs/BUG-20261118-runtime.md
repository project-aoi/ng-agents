# 宿主休眠与进程身份

<a id="bug-009"></a>

## BUG-009　跨休眠续租

合盖期间墙上时间继续前进。唤醒后若径直判定租约过期，同一批工作可能再次执行。收件箱比较墙钟和单调时钟，延长仍有效的租约，首次认领也执行相同检查。宿主保活只在有活跃工作时启用。

[租约与休眠测试](../../packages/inbox/test/sleep.test.ts) [宿主保活测试](../../packages/cell/test/awake.test.ts)

<a id="bug-013"></a>

## BUG-013　辨认后台进程

进程编号会被系统复用。宿主查询结合进程开始时间和所属执行实例检查身份，再决定是否恢复或结束后台命令。时间文本的解析固定在 UTC，进程身份不明时暂缓重新派工。

[后台命令测试](../../packages/workspace/test/jobs.test.ts) [命令行子进程测试](../../packages/loop/test/cli-orphans.test.ts) [内核运行测试](../../packages/cell/test/phase0.test.ts)
