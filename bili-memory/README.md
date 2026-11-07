# bili-memory

给 chatai-plugin 用的「B站记忆 / 自己刷片」模块：记我自己在B站看过什么、当时怎么想的，聊天时按当前这句话检索，自然回忆，不照读。

参考 surfcore 的 bili-memory 三级结构。

## 组成

| 文件 | 作用 |
| --- | --- |
| `src/services/bili/BiliMemoryService.js` | 记忆本体：账本读写、三级产物、检索、分享池 |
| `src/services/bili/BiliWatchService.js` | 自己逛B站：定时拉排行榜，用小模型挑自己会看的片写进账本 |
| `src/mcp/tools/biliMemory.js` | 工具：记录 / 检索 / 排障 |
| `src/mcp/tools/biliLink.js` | 工具：B站链接解析成信息卡片 |

## 三级产物

全部落在 `data/bili-memory/` 下：

| 文件 | 作用 | 是否进提示词 |
| --- | --- | --- |
| `ledger.json` | 原始账本，工具写入的唯一数据源 | 否 |
| `bili-memory-brief.md` | 常驻短记忆（口味 + 最近看过），硬截断 2700 字 | 是，每轮注入 |
| `bili-memory.json` | 全量索引，只给检索和分享池用 | 否 |
| `bili-memory.md` | 长记忆，给人看和排查 | 否 |
| `bili-share-history.json` | 分享历史，六天内不复用 | 否 |
| `bili-watch.log` | 逛B站的硬日志，排障用 | 否 |

`refresh()` 有四分钟节流，避免每轮都重写文件。

## 注入链路

`ChatAgent._addBiliMemoryContext` 挂在知识图谱之后：

1. 先拼 brief（常驻）
2. 再拿当前这句话去 `recallBlock()` 检索，命中才追加
3. 分数低于 8 直接返回空
4. 只保留和最高分同量级的命中，避免一条擦边的也跟进来

## 工具

注册在 `src/mcp/tools/index.js` 的 `biliMemory` 分类。

- `bili_memory_record` — 记一条，同一个 BV 自动合并（分数取高、理由取长）
- `bili_memory_recall` — 按关键词检索，查不到就提示别硬编
- `bili_memory_status` — 看条数、字数、分享记录，排障用

`biliLink` 分类：

- `bilibili_link_parse` — BV 号 / av 号 / b23.tv 短链解析成标题、UP主、时长、播放量卡片

## BV 号容错

模型常把 `BV1` 当前缀吃掉，只回 8~10 位尾巴。`normalizeBv()` 会补回来：

- 完整 BV 号直接用
- 10 位裸串补 `BV`
- 9 位裸串补 `BV1`
- 纯字母的一律不认，免得把单词当号

认不出来直接拒写，宁可不记也不存坏链接。

## 自己刷片（BiliWatchService）

以前 B站记忆只能等群里有人丢链接，等于摆设。现在自己逛：

- 定时拉分区排行榜（游戏 / 动画 / 科技 / 搞笑 / 生活 / 影视等）
- 用 `glm-4-flash` 判断「这些片子我会不会点进去看」
- 会看的写一句自己的感想进账本，分数低于 12 不记
- 每轮最多 2 条，安静时段（默认 01:30–09:00）不逛
- 只读公开接口，不点赞不评论；cookie 从 `config/bili.yaml` 借，没有就匿名

配置项在 `config.yaml` 的 `biliWatch` 下，key 缺省会自动从 `channels` 里翻智谱的。

## 分享池

`pickShareCard()` 六天内不复用，没新鲜的返回 `null`，不发旧的。政治和娱乐圈走黑名单，记录和注入两头都挡。

## 和 MemoryService 的区别

`MemoryService` 记的是 `group:<群号>:user:<QQ>` 作用域下「关于群友的事」；这里记的是「我自己在B站看过什么」，两套不混用。

## 安装

把文件按原路径放进 chatai-plugin：

```
src/services/bili/BiliMemoryService.js
src/services/bili/BiliWatchService.js
src/mcp/tools/biliMemory.js
src/mcp/tools/biliLink.js
```

再确认 `src/mcp/tools/index.js` 里有 `biliMemory` 和 `biliLink` 的注册项，重启生效。

## 依赖

- Node 18+（用了内置 fetch 与 AbortSignal.timeout）
- `axios`（BiliWatchService 拉排行榜）
- 可选：`config/bili.yaml` 里的登录 cookie，匿名也能跑但更易被风控
