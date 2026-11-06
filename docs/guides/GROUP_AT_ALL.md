# 群聊艾特全体成员

## 使用
在白名单群中，由主人真实 @机器人后发送：
- 帮我艾特一下全体成员
- 请帮我艾特一下全体成员
- 艾特全体

程序直接识别原始入站消息，不依赖模型判断，不新增任意管理 MCP/API。
首版仅发送真正的 QQ @全体成员，不附带通知正文。问题、否定、举例、记事、引用/转发及夹带额外正文均不执行；不要通过引用旧消息触发。

## 权限与防重
- 仅 config.ownerQQ 对应主人、当前白名单群、真实 @机器人、5分钟内有效原始消息可触发。
- 发送前查询机器人群角色（no_cache）与 get_group_at_all_remain；须为群主/管理员，can_at_all=true，群与账号余量均为正整数。
- 发送前再次检查开关、群白名单/拒绝名单、当前会话模式、暂停/静默与来源有效期。
- 不放宽现有通用 atUserId 对 all 的限制。普通模型/群友发送文字“@全体成员”不产生管理能力。
- 持久账本 state/group-at-all/actions.sqlite3（目录700、文件600）；按群+消息ID唯一。同群权限检查与发送串行，群聊天发送走既有发送队列。
- 先落 sending 后外发。返回消息ID才记 success；超时或回执缺失记 uncertain，不自动重试。重启时未完成记录改为 interrupted/uncertain，不续发。
- 已拒绝的原指令也不重试；补权限后请主人发送新指令。

## 配置与运维
config.json 添加 `"groupAtAll": { "enabled": true }` 后重启 bigfish-qq-bridge。
config.example.json 默认 false。无 MCP schema 修改，不需要重启 DSH 或 QQ 容器。
无需新服务、升级 SDK 或改角色卡。不自动提交代码，不清除历史账本。
测试 `node --test scripts/test-group-at-all.mjs` 使用临时账本与mock，不发送真实群消息。

官方接口：https://snowluma.github.io/zh/docs/api/extended/get_group_at_all_remain 。
