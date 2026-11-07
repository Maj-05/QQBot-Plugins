/**
 * B站自己刷片服务
 *
 * 以前 B站记忆只能靠群里有人丢链接才有素材，等于摆设。
 * 这里改成自己去 B站逛：定时拉分区排行榜，用便宜的 flash 模型判断
 * 「这些片子我会不会点进去看」，会看的就写一句自己的感想进 bili-memory。
 *
 * 只读公开接口，不点赞、不评论；带上 config/bili.yaml 里的 cookie 免被风控。
 * 政治 / 娱乐圈内容由 BiliMemoryService.isBlockedContent 统一拦掉。
 */
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import config from '../../../config/config.js'
import { chatLogger as logger } from '../../core/utils/logger.js'
import { biliMemoryService, isBlockedContent } from './BiliMemoryService.js'

const RANK_API = 'https://api.bilibili.com/x/web-interface/ranking/v2'
const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** 我平时会逛的分区：游戏、动画、科技、搞笑、鬼畜、动物圈、生活、影视 */
const RIDS = [4, 1, 36, 119, 217, 160, 188, 5, 155, 181, 211, 223, 234]

const DEFAULT_CONFIG = {
    enabled: true,
    pollIntervalMinutes: 180,
    quietStart: '01:30',
    quietEnd: '09:00',
    maxPerRound: 2,
    minScore: 8,
    model: 'glm-4-flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    timeoutMs: 40000,
}

const DATA_DIR = path.join(process.cwd(), 'data', 'bili-memory')
const HARD_LOG = path.join(DATA_DIR, 'bili-watch.log')

function hardLog(msg) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
        fs.appendFileSync(HARD_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
    } catch {}
}

function clockToMinutes(text, fallback) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
    if (!m) return fallback
    return Number(m[1]) * 60 + Number(m[2])
}

function inQuiet(now, start, end) {
    const s = clockToMinutes(start, 90)
    const e = clockToMinutes(end, 540)
    if (s === e) return false
    const d = new Date(now)
    const m = d.getHours() * 60 + d.getMinutes()
    return s < e ? m >= s && m < e : m >= s || m < e
}

function short(text, n) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 从 config 的 channels 里翻一个智谱 key，省得再单独填一遍 */
function findZhipuKey() {
    try {
        const channels = config.get('channels') || []
        for (const ch of channels) {
            const id = String(ch?.id || '')
            const name = String(ch?.name || '')
            const base = String(ch?.baseUrl || '')
            if (!ch?.apiKey) continue
            if (id.startsWith('zhipu') || name.includes('智谱') || base.includes('bigmodel.cn')) {
                return ch.apiKey
            }
        }
    } catch {}
    return ''
}

/** 从 Yunzai 的 config/bili.yaml 里借一份登录 cookie，没有就退回匿名请求 */
function findBiliCookie() {
    try {
        const cfgCookie = config.get('biliWatch.cookie')
        if (cfgCookie) return String(cfgCookie)
    } catch {}
    try {
        const file = path.join(process.cwd(), 'config', 'bili.yaml')
        if (!fs.existsSync(file)) return ''
        const text = fs.readFileSync(file, 'utf8')
        const m = text.match(/cookie:\s*"([^"]+)"/) || text.match(/cookie:\s*'([^']+)'/)
        return m ? m[1] : ''
    } catch {
        return ''
    }
}

function buildHeaders() {
    const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
    const cookie = findBiliCookie()
    if (cookie) headers.Cookie = cookie
    return headers
}

class BiliWatchService {
    constructor() {
        this.timer = null
        this.initialized = false
        this.running = false
        this.lastRoundAt = 0
    }

    getConfig() {
        let cfg = { ...DEFAULT_CONFIG }
        try {
            const c = config.get('biliWatch')
            if (c && typeof c === 'object') cfg = { ...cfg, ...c }
        } catch {}
        if (!cfg.apiKey) cfg.apiKey = findZhipuKey()
        return cfg
    }

    async init() {
        if (this.initialized) return
        const cfg = this.getConfig()
        if (cfg.enabled !== true) {
            logger.info('[BiliWatch] 未启用，跳过')
            hardLog('init: 未启用')
            this.initialized = true
            return
        }
        const intervalMs = Math.max(30, Number(cfg.pollIntervalMinutes) || 180) * 60 * 1000
        this.timer = setInterval(() => {
            this.tick().catch(err => logger.warn('[BiliWatch] tick失败:', err.message))
        }, intervalMs)
        this.timer.unref?.()
        this.initialized = true
        logger.info(`[BiliWatch] 已启动，每 ${intervalMs / 60000} 分钟逛一次`)
        hardLog(`init: 已启动，间隔 ${intervalMs / 60000} 分钟，key=${cfg.apiKey ? '有' : '无'}`)
        // 启动后先等一会儿再逛第一轮，别和其他初始化抢资源
        setTimeout(() => {
            this.tick().catch(() => {})
        }, 3 * 60 * 1000).unref?.()
    }

    stop() {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        this.initialized = false
    }

    async tick() {
        const cfg = this.getConfig()
        if (cfg.enabled !== true) return
        if (this.running) {
            hardLog('tick: 上一轮还没跑完，跳过')
            return
        }
        if (inQuiet(Date.now(), cfg.quietStart, cfg.quietEnd)) {
            hardLog('tick: 安静时段，不逛')
            return
        }
        this.running = true
        try {
            await this.runRound(cfg)
        } catch (err) {
            hardLog('tick 异常: ' + (err?.stack || err?.message || err))
        } finally {
            this.running = false
            this.lastRoundAt = Date.now()
        }
    }

    async fetchRanking(rid) {
        const res = await axios.get(RANK_API, {
            params: { rid, type: 'all' },
            headers: buildHeaders(),
            timeout: 15000,
        })
        const list = res?.data?.data?.list
        return Array.isArray(list) ? list : []
    }

    async runRound(cfg) {
        if (!cfg.apiKey) {
            hardLog('runRound: 没有智谱 key，跳过')
            return
        }

        const known = new Set()
        try {
            for (const e of biliMemoryService.readLedger().entries) {
                if (e?.bvid) known.add(String(e.bvid))
            }
        } catch {}

        // 随机挑两个分区，避免每轮都是同一批游戏区视频
        const rids = [...RIDS].sort(() => Math.random() - 0.5).slice(0, 2)
        const pool = []
        for (const rid of rids) {
            try {
                const list = await this.fetchRanking(rid)
                for (const v of list.slice(0, 30)) {
                    if (!v?.bvid || known.has(v.bvid)) continue
                    const title = String(v.title || '')
                    const desc = String(v.desc || '')
                    if (!title) continue
                    if (isBlockedContent(`${title} ${desc}`)) continue
                    if (Number(v.duration) > 0 && Number(v.duration) < 60) continue
                    pool.push({
                        bvid: v.bvid,
                        title,
                        owner: String(v.owner?.name || ''),
                        desc: short(desc, 90),
                        tname: String(v.tname || ''),
                        view: Number(v.stat?.view) || 0,
                        duration: Number(v.duration) || 0,
                    })
                }
            } catch (err) {
                hardLog(`拉分区 ${rid} 失败: ${err.message}`)
            }
        }

        if (!pool.length) {
            hardLog('runRound: 没有新候选')
            return
        }

        const candidates = pool.sort(() => Math.random() - 0.5).slice(0, 14)
        hardLog(`runRound: 候选 ${candidates.length} 条（分区 ${rids.join(',')}）`)

        const picked = await this.askModel(cfg, candidates)
        if (!picked.length) {
            hardLog('runRound: 模型没挑中')
            return
        }

        let saved = 0
        const limit = Math.max(1, Number(cfg.maxPerRound) || 2)
        for (const item of picked) {
            if (saved >= limit) break
            const src = candidates.find(c => c.bvid === item.bvid)
            if (!src) continue
            if (Number(item.score) < Number(cfg.minScore || 11)) continue
            const res = biliMemoryService.record({
                bvid: src.bvid,
                title: src.title,
                owner: src.owner,
                score: Number(item.score) || 0,
                reason: String(item.reason || ''),
                kind: '视频',
            })
            if (res?.ok) {
                saved += 1
                hardLog(`记下 ${src.bvid} ${short(src.title, 30)} 分=${item.score}`)
            } else {
                hardLog(`记录失败 ${src.bvid}: ${res?.error || ''}`)
            }
        }

        if (saved > 0) {
            try {
                await biliMemoryService.refresh({ force: true })
            } catch (err) {
                hardLog('刷新索引失败: ' + err.message)
            }
        }
        hardLog(`runRound: 本轮记下 ${saved} 条`)
    }

    /**
     * 让 flash 模型从候选里挑自己真会点进去看的。
     * 返回 [{ bvid, score, reason }]
     */
    async askModel(cfg, candidates) {
        const lines = candidates
            .map((c, i) => {
                const mins = c.duration ? Math.round(c.duration / 60) + '分钟' : ''
                return `${i + 1}. ${c.bvid} | ${c.title} | UP:${c.owner} | 分区:${c.tname} | ${mins} | 播放:${c.view} | 简介:${c.desc}`
            })
            .join('\n')

        const system = [
            '你是 Luce，一个游戏宅网友，正在刷 B 站首页排行榜。',
            '你要从候选里挑出「自己真的会点进去看完」的视频，不是挑播放量最高的。',
            '偏好：游戏（尤其单机、独立、整活、技术向）、动画、科技数码、搞笑整活、动物、生活杂谈。',
            '不喜欢：纯营销号、标题党、饭圈、政治、擦边、纯音乐MV、无信息量的剪辑。',
            '打分标准：15-20 是「刷到就想点，还会想跟群友聊两句」；10-14 是「有点兴趣会看」；5-9 是「顺手点开看看」；0-4 是「划过去」。',
            '只输出 JSON，格式：{"picks":[{"bvid":"BV...","score":0-20,"reason":"一句自己的感想，20字内，口语化"}]}',
            '最多挑 2 个。如果这批都不想看，输出 {"picks":[]}。不要输出 JSON 以外的任何内容。',
        ].join('\n')

        const body = {
            model: cfg.model || 'glm-4-flash',
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: `候选列表：\n${lines}` },
            ],
            temperature: 0.8,
            max_tokens: 500,
        }

        const res = await axios.post(`${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`, body, {
            headers: {
                Authorization: `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: Number(cfg.timeoutMs) || 40000,
        })

        const raw = String(res?.data?.choices?.[0]?.message?.content || '').trim()
        hardLog('模型回执: ' + short(raw, 200))
        return this.parsePicks(raw, candidates)
    }

    parsePicks(raw, candidates) {
        const text = String(raw || '')
        const start = text.indexOf('{')
        const end = text.lastIndexOf('}')
        if (start < 0 || end <= start) return []
        let data
        try {
            data = JSON.parse(text.slice(start, end + 1))
        } catch {
            return []
        }
        const picks = Array.isArray(data?.picks) ? data.picks : []
        const valid = new Set(candidates.map(c => c.bvid))
        const out = []
        for (const p of picks) {
            const bvid = String(p?.bvid || '').trim()
            if (!bvid || !valid.has(bvid)) continue
            if (out.some(o => o.bvid === bvid)) continue
            const reason = short(p?.reason, 40)
            if (isBlockedContent(reason)) continue
            out.push({
                bvid,
                score: Math.max(0, Math.min(20, Number(p?.score) || 0)),
                reason,
            })
        }
        return out
    }

    status() {
        const cfg = this.getConfig()
        return {
            enabled: cfg.enabled === true,
            running: this.running,
            intervalMinutes: cfg.pollIntervalMinutes,
            lastRoundAt: this.lastRoundAt ? new Date(this.lastRoundAt).toISOString() : '',
            hasKey: Boolean(cfg.apiKey),
            model: cfg.model,
        }
    }
}

export const biliWatchService = new BiliWatchService()
export default biliWatchService
