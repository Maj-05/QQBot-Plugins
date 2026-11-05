/**
 * B站记忆工具
 * 记我自己在B站看过什么、想什么；查的时候按关键词检索
 */
import { biliMemoryService } from '../../services/bili/BiliMemoryService.js'

export const biliMemoryTools = [
    {
        name: 'bili_memory_record',
        description:
            '记一条自己在B站的看片经历（看过什么视频、当时怎么想的、留了什么评论）。' +
            '同一个BV号会自动合并，分数取高、理由取长。涉及政治和娱乐圈的会被拒绝。',
        inputSchema: {
            type: 'object',
            properties: {
                bvid: { type: 'string', description: 'BV号，可以只传这个' },
                title: { type: 'string', description: '视频标题' },
                owner: { type: 'string', description: 'UP主' },
                score: { type: 'number', description: '我给的评分，0-20' },
                reason: { type: 'string', description: '当时的判断/感想' },
                quote: { type: 'string', description: '我留下的评论（如果有）' },
                kind: { type: 'string', description: '类型，比如 视频/动态/收藏' }
            }
        },
        handler: async args => {
            try {
                const res = biliMemoryService.record(args || {})
                if (!res.ok) return res
                await biliMemoryService.refresh()
                return { success: true, id: res.id, total: res.total }
            } catch (err) {
                return { success: false, error: `记录失败: ${err.message}` }
            }
        }
    },
    {
        name: 'bili_memory_recall',
        description: '按关键词检索自己在B站看过的东西。想不起来某条视频细节时用，别硬编。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '要检索的关键词，比如某个标题、UP主、话题' }
            },
            required: ['query']
        },
        handler: async args => {
            const q = String(args?.query || '').trim()
            if (!q) return { success: false, error: '要查什么？给我一个词' }
            try {
                const block = biliMemoryService.recallBlock(q, { maxChars: 1600, limit: 6 })
                if (!block) return { success: false, query: q, hint: '记忆里没有相关的，别硬编，说没印象' }
                return { success: true, query: q, text: block }
            } catch (err) {
                return { success: false, error: `检索失败: ${err.message}` }
            }
        }
    },
    {
        name: 'bili_memory_status',
        description: '查看B站记忆的条数、简版字数和最近分享记录，用于排障',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
            try {
                await biliMemoryService.refresh()
                return biliMemoryService.status()
            } catch (err) {
                return { success: false, error: err.message }
            }
        }
    }
]
