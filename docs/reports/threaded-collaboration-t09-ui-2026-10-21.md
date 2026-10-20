# 持续协作 T09：Thread UI、回执与重连验收

日期：2026-10-21，Asia/Shanghai。基线：T08 `606a8c0` 已提交推送到origin/main；T09变更在工作区，尚未提交推送。结论：T09所列UI与授权同步范围通过；生产工作入场仍关闭，下一项T10。

实现包括独立入口、专用认证客户端、只读Owner投影、持久事件引用补齐、权限/连接epoch、时间线及精确回执、路由设置/preview、普通Decision、逐范围控制和调用日志。没有新增数据库迁移，v31及既有descriptor不变；没有迁移业务数据库，没有读取日常会话、账号凭据或调用真实供应商。合同见 [T09架构](../architecture/threaded-ui-v1.md)。

## 验证分层

| 命令 | 结果 |
| --- | --- |
| `pnpm verify:threaded-view` | 4组：快照替换移除旧私密内容、跨空间hint拒绝、读中hint不丢、旧连接迟到结果丢弃、断线重建、会话失效停驻和版本化no-store HTTP |
| `pnpm verify:threaded-view-api` | 4组：实际SQLite只读投影、精确回执、100条分页和来源重验、真实Fastify session/version/身份及游标校验、WS控制变化与会话失效关闭 |
| `pnpm verify:threaded-ui` | 11组真实Chrome操作，见[机器报告](evidence/threaded-t09-ui/report.json)；真实本机HTTP/WS、React和临时SQLite，模型为注入 |
| `pnpm typecheck` | shared/server/web通过 |
| `pnpm --filter @agent-gand/web build` | 通过；保留既有大chunk提示，ThreadedView独立懒加载 |
| 旧聊天真实UI回归 | `verify-chatroom-ui.mjs --message-presentation-only`五组通过，supplierRequests=0、browserErrors为空；[脱敏结果](evidence/threaded-t09-legacy-ui.json) |
| 访问、控制、消息与模式隔离 | access、message-api（6组）、controls、legacy-boundary、isolation通过 |
| T08与迁移回归 | collaboration（17组）、collaboration-api（4组）、migration（14组）通过 |
| 文档及差异 | 本地链接、行末空白及K01–K16/59场景与预期原文保留检查 |

本机浏览器命令使用已有依赖和已安装Chrome，没有安装或升级依赖：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
pnpm verify:threaded-ui
```

脚本自行分配本机端口和临时库；需要允许本机监听及受控子进程。不能用日常服务或`db:reset`代替。生成证据目录可由THREADED_UI_OUTPUT指定。

## 实际浏览器观察

1. 直接打开持续协作时未发旧房间/Run/任务/usage/Agent加载请求；经真实管理桥连接，公开、私密、草稿及post/final分别显示。
2. 精确delivery/seen/mention ACK独立；快照不含fence/nativeId/原生transcript，伪造owner拒绝400，未来游标拒绝409；回放跨100个事件无重复ID。
3. 更早页、跨空间选择、浏览器返回及刷新保留空间身份；私密消息不混入另一个空间，不写localStorage。
4. 普通问题回应成为规范用户消息，按当前问题版本提交；显示保存后等待成员处理。成员暂停/恢复按实际控制状态变化，不显示整个Thread已完成。
5. 路由设置抽屉通过CAS保存新群组，preview立即按新版本选中正确成员；自动多目标独立并行与显式execute串行分别观察。
6. 真实POST已提交后丢弃HTTP回执，重试相同内容沿原clientRequestId，数据库只有一条规范消息。
7. 私密消息分别选择执行收件人与额外可见成员；浏览器提交后核验规范消息的targets和audience，额外观察者没有逻辑Wake。
8. 浏览器offline立即清除私密展示；离线期间追加消息，online重新获取授权快照，只显示一条新消息，不从旧缓存补正文。
9. 桌面1440×1000和手机390×844实际截图检查；手机状态面板可关闭，恢复时间线/输入区，页面无横向溢出。
10. 对隔离HTTP服务进程实际SIGKILL，保留SQLite；新进程/新连接启动，旧session失效。用户重新连接后恢复原消息/等待/控制，无模型重放，丢回执消息仍只有一条。
11. fixture关闭入场后发送/Decision禁用，历史和控制保留；退出会话后私密正文消失，浏览器没有存储Threaded正文或token。

在开发验证中修复了浏览器fetch绑定、手机侧面板重叠、仅按Invocation漏算未领取Wake、offline时WebSocket未必立即断开，以及策略版本变化后preview刷新问题。最终证据由修复后的完整脚本生成；测试中404/401/400/409等预期拒绝不视为成功写入。

## 视觉证据

- [桌面时间线与成员状态](evidence/threaded-t09-ui/desktop.png)
- [手机成员状态面板](evidence/threaded-t09-ui/mobile.png)
- [手机时间线与输入区](evidence/threaded-t09-ui/mobile-timeline.png)

截图仅包含合成数据，未截取日常会话。机器报告记录实际viewport、进程重启范围、分组和截图文件；服务临时库测试后清理。

## 范围与下一步

UI01的本机隔离Chrome刷新/重连/实际HTTP进程重启子场景通过；不外推到真实SDK运行中进程被杀、业务Action修订、所有平台或生产发布。原生token流没有发布；当前呈现正式消息和持久调用/Attempt日志。日志最多显示最近200条，时间线每页100条并可继续向前翻页；这是显式分页/投影范围，不改变消息持久或ACL合同。

生产`closed|observe|execute`仍无executor且拒绝新工作，新建空间保持关闭。T10承接Action准入、完成谓词、返回/替换、真实领域producer/resolver/freshness与命令代际；T11承接Review/Revision、SOP/知识，T12完成综合发布及真实后端/平台故障矩阵。

本阶段真实模型请求及token消耗均为0。此前T07/T08累计占额75,327（36,317确认token +39,010未知预留）不变，20万token硬门禁没有重置。T08首轮真实征询取消原因仍未定位，保留原报告，不被本次UI通过覆盖。K01–K16及59项原场景/预期保留，不将阶段子项通过宣称为全矩阵通过。
