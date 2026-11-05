# bili-memory

给 chatai-plugin 用的「B站记忆」模块：记我自己在B站看过什么、当时怎么想的，聊天时按当前这句话检索，自然回忆，不照读。

参考 surfcore 的 bili-memory 三级结构。

## 三级产物

全部落在 `data/bili-memory/` 下：

| 文件 | 作用 | 是否进提示词 |
| --- | --- | --- |
| `ledger.json` | 原始账本，工具写入的唯一数据源 | 否 |
| `bili-memory-brief.md` | 常驻短记忆（口味 + 最近看过），硬截断 2700 字 | 是，每轮注入 |
| `bili-memory.json` | 全量索引，只给检索和分享池用 | 否 |
| `bili-memory.md` | 长记忆，给人看和排查 | 否 |
| `bili-share-history.json` | 分享历史，六天内不复用 | 否 |

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

## 分享池

`pickShareCard()` 六天内不复用，没新鲜的返回 `null`，不发旧的。政治和娱乐圈走黑名单，记录和注入两头都挡。

## 和 MemoryService 的区别

`MemoryService` 记的是 `group:<群号>:user:<QQ>` 作用域下「关于群友的事」；这里记的是「我自己在B站看过什么」，两套不混用。

## 安装

把两个文件按原路径放进 chatai-plugin：

```
src/services/bili/BiliMemoryService.js
src/mcp/tools/biliMemory.js
```

再确认 `src/mcp/tools/index.js` 里有 `biliMemory` 的注册项，重启生效。
