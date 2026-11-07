/**
 * B站记忆服务
 *
 * 参考 surfcore 的 bili-memory 三级结构：
 *   · bili-memory-brief.md  常驻注入的短记忆（口味 + 最近看过），硬截断
 *   · bili-memory.json      全量索引，只给「按当前这句话检索」和「分享池」用
 *   · bili-memory.md        长记忆，给人看和排查，不进提示词
 *
 * 与 MemoryService 的区别：那边按 group:<群号>:user:<QQ> 记「关于群友的事」，
 * 这里记「我自己在 B 站看过什么、怎么想的」，两套不混。
 *
 * 数据来源只有本地账本 data/bili-memory/ledger.json，
 * 由工具写入，本文件不打任何外部接口。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { chatLogger } from '../../core/utils/logger.js'

const logger = chatLogger
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.resolve(__dirname, '../../../')

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/

// 政治 / 娱乐圈：分享与注入一律避开
const BLOCKED_RE =
    /政治|时政|新闻联播|两会|习近平|总书记|主席|总统|首相|政府|国务院|外交部|国防|军事|战争|俄乌|乌克兰|俄罗斯|巴以|以色列|巴勒斯坦|加沙|特朗普|拜登|普京|泽连斯基|选举|大选|民主党|共和党|台湾|台独|南海|香港|新疆|西藏|六四|文革|法轮|股市|A股|美股|基金|楼市|房价|经济|资本|制裁|联合国|外交|明星|娱乐圈|综艺|八卦|绯闻|恋情|分手|离婚|结婚|塌房|饭圈|粉丝|偶像|爱豆|演唱会|追星|演员|歌手|选秀/

// 检索时不该当关键词的大白话
const STOP_BIGRAMS = new Set([
    '视频', '动态', '评论', '记忆', '记得', '这个', '那个',
    '什么', '怎么', '可以', '我们', '你们', '他们', '今天', '昨天', '现在', '真的',
    '就是', '不是', '一个', '一下', '觉得', '知道', '你还', '还记', '在吗',
    '没有', '看过', '说的', '是什', '群友', '有人', '问题', '我记', '吗我'
])

const DEFAULT_BRIEF_MAX = 2700
const DEFAULT_RECALL_MAX = 1200

function readJson(file, fallback = null) {
    try {
        let text = fs.readFileSync(file, 'utf8')
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        return JSON.parse(text)
    } catch {
        return fallback
    }
}

function atomicWriteText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`
    try {
        fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
        fs.renameSync(tmp, file)
    } catch (err) {
        try {
            fs.unlinkSync(tmp)
        } catch {}
        throw err
    }
}

function short(text, n) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    return s.length > n ? `${s.slice(0, n)}…` : s
}

function localDate(value) {
    const t = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
    if (!Number.isFinite(t)) return ''
    return new Date(t).toLocaleDateString('sv-SE')
}

function extractBv(text) {
    const m = String(text ?? '').match(BV_RE)
    return m ? m[0] : ''
}

/**
 * 把各种残缺写法还原成标准 BV 号。
 * 模型有时候会把 BV1 当成前缀吃掉，只回 8~10 位的尾巴，这里补回来。
 * 认不出来就返回空串，宁可不记也不要存一条坏链接。
 */
function normalizeBv(input) {
    const raw = String(input ?? '').trim()
    if (!raw) return ''
    // 带链接的先抽一遍
    const fromUrl = extractBv(raw)
    if (fromUrl) return fromUrl
    // 去掉分隔符和前缀
    const bare = raw.replace(/[^0-9A-Za-z]/g, '')
    if (/^BV[0-9A-Za-z]{10}$/i.test(bare)) return 'BV' + bare.slice(2)
    // 只剩尾巴的：BV 号一定含数字，纯字母的一律不认，免得把单词当号
    if (!/[0-9]/.test(bare)) return ''
    if (/^[0-9A-Za-z]{10}$/.test(bare)) return 'BV' + bare
    // BV1 被整段吃掉时尾巴是 9 位
    if (/^[0-9A-Za-z]{9}$/.test(bare)) return 'BV1' + bare
    return ''
}

function cleanText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\*\*/g, '')
        .replace(/^>\s?/gm, '')
        .replace(/[ \t]+/g, ' ')
        .trim()
}

export function isBlockedContent(text) {
    return BLOCKED_RE.test(String(text ?? ''))
}

class BiliMemoryService {
    constructor() {
        this.initialized = false
        this.stateDir = path.join(PLUGIN_ROOT, 'data', 'bili-memory')
        this.paths = {
            ledger: path.join(this.stateDir, 'ledger.json'),
            doc: path.join(this.stateDir, 'bili-memory.md'),
            brief: path.join(this.stateDir, 'bili-memory-brief.md'),
            index: path.join(this.stateDir, 'bili-memory.json'),
            history: path.join(this.stateDir, 'bili-share-history.json')
        }
        this.briefCache = { mtime: -1, text: '' }
        this.indexCache = { mtime: -1, data: null }
        this.lastRefreshAt = 0
        this.refreshing = null
        this.config = {
            enabled: true,
            briefMaxChars: DEFAULT_BRIEF_MAX,
            recallMaxChars: DEFAULT_RECALL_MAX,
            shareHistoryDays: 6
        }
    }

    init() {
        if (this.initialized) return
        try {
            fs.mkdirSync(this.stateDir, { recursive: true })
        } catch (err) {
            logger.warn('[BiliMemory] 目录创建失败:', err.message)
        }
        this.initialized = true
    }

    /** 账本：一条记录 = 我看过/发过的一条 B 站内容 */
    readLedger() {
        const raw = readJson(this.paths.ledger, null)
        if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) return raw
        return { at: 0, entries: [] }
    }

    saveLedger(data) {
        atomicWriteText(this.paths.ledger, JSON.stringify(data, null, 2) + '\n')
    }

    /** 记一条看片记录。同一个 BV 会合并：分数取高、理由取长。 */
    record(entry = {}) {
        this.init()
        const rawBv = String(entry.bvid ?? '').trim() || String(entry.url ?? '').trim()
        const bvid = normalizeBv(rawBv)
        const title = cleanText(entry.title ?? '')
        if (!bvid && !title) return { ok: false, error: '至少要有 BV 号或标题' }
        if (rawBv && !bvid) return { ok: false, error: `BV 号认不出来：${rawBv}，要 BV 开头加 10 位` }
        if (isBlockedContent(`${title} ${entry.reason ?? ''} ${entry.quote ?? ''}`)) {
            return { ok: false, error: '这条涉及政治/娱乐圈，按规则不记' }
        }
        const data = this.readLedger()
        const at = Number(entry.at) || Date.now()
        const id = bvid ? `bv:${bvid}` : `note:${at}`
        const idx = data.entries.findIndex(e => e.id === id)
        const next = {
            id,
            type: 'video',
            bvid,
            title,
            owner: cleanText(entry.owner ?? ''),
            url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
            score: Number(entry.score) || 0,
            reason: cleanText(entry.reason ?? ''),
            quote: cleanText(entry.quote ?? ''),
            kind: cleanText(entry.kind ?? ''),
            date: localDate(at),
            at: new Date(at).toISOString()
        }
        if (idx >= 0) {
            const old = data.entries[idx]
            data.entries[idx] = {
                ...old,
                ...next,
                title: next.title || old.title,
                score: Math.max(Number(old.score) || 0, next.score),
                reason: next.reason.length >= String(old.reason ?? '').length ? next.reason : old.reason,
                quote: next.quote.length >= String(old.quote ?? '').length ? next.quote : old.quote
            }
        } else {
            data.entries.push(next)
        }
        data.at = Date.now()
        data.entries = data.entries.slice(-400)
        this.saveLedger(data)
        this.lastRefreshAt = 0
        return { ok: true, id, total: data.entries.length }
    }

    buildBrief(entries) {
        const lines = []
        lines.push('## B站记忆（这些是我自己真实看过的东西，不是别人说的）')
        lines.push('')
        const like = []
        const dislike = []
        for (const e of entries) {
            const text = `${e.title} ${e.reason}`
            if (/猫|鱼|鲸|可爱|整活|鬼畜|模型|二创|番剧/.test(text)) like.push(e.title)
            if (/带货|擦边|标题党|广告/.test(text)) dislike.push(e.title)
        }
        const likeText = [...new Set(like)].slice(0, 6).join('、') || '可爱、荒诞、短小、有梗的东西'
        const dislikeText = [...new Set(dislike)].slice(0, 4).join('、') || '带货、擦边、标题党'
        lines.push(`我的口味：${likeText}；不喜欢 ${dislikeText}。`)
        lines.push('')
        lines.push('最近在B站（真实看过，细节以这里为准，不要编）：')
        const seen = new Set()
        const picks = []
        const sorted = entries
            .filter(e => e.date && !isBlockedContent(`${e.title} ${e.reason} ${e.quote}`))
            .sort(
                (a, b) =>
                    String(b.date).localeCompare(String(a.date)) || (b.score || 0) - (a.score || 0)
            )
        for (const e of sorted) {
            const key = e.bvid || e.id
            if (key && seen.has(key)) continue
            if (key) seen.add(key)
            picks.push(e)
            if (picks.length >= 10) break
        }
        if (picks.length === 0) lines.push('- （最近还没看过什么）')
        for (const e of picks) {
            const label = e.score ? `${e.score}分` : '看过'
            const body = short(e.quote || e.reason || '', 90)
            lines.push(`- ${e.date}｜${label}｜${short(e.title, 40)}${body ? `｜${body}` : ''}`)
        }
        lines.push('')
        lines.push('边界：B站私信里的内容不在我的记忆里，我也不会编；问起就按记得的公开经历回答。')
        let brief = lines.join('\n')
        const max = this.config.briefMaxChars
        if (brief.length > max) brief = `${brief.slice(0, max)}…`
        return brief
    }

    buildDoc(entries) {
        const now = new Date().toLocaleString('sv-SE')
        const lines = []
        lines.push('# B站记忆')
        lines.push('')
        lines.push(`> 自动同步：${now}`)
        lines.push('> 来源：本地账本里我自己看过/发过的公开内容。')
        lines.push('')
        lines.push('## 时间线')
        lines.push('')
        const timeline = entries
            .filter(e => e.date)
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        let used = 0
        for (const e of timeline) {
            if (used >= 140) break
            if (isBlockedContent(`${e.title} ${e.reason} ${e.quote}`)) continue
            lines.push(
                `- ${e.date}${e.score ? ` [${e.score}分]` : ''} ${e.title}${e.bvid ? ` ${e.bvid}` : ''}`
            )
            if (e.reason) lines.push(`  - 当时的判断：${short(e.reason, 260)}`)
            if (e.quote) lines.push(`  - 我的评论：「${short(e.quote, 200)}」`)
            if (e.url) lines.push(`  - 链接：${e.url}`)
            used += 1
        }
        if (used === 0) lines.push('- （空）')
        const doc = lines.join('\n')
        return doc.length > 28000 ? `${doc.slice(0, 28000)}\n\n（后略）` : doc
    }

    buildIndex(entries) {
        return {
            generatedAt: new Date().toISOString(),
            entries: entries.slice(-260).map(e => ({
                id: e.id,
                type: e.type,
                title: e.title,
                bvid: e.bvid,
                url: e.url,
                text: short(e.reason, 600),
                quote: short(e.quote, 260),
                reason: short(e.reason, 300),
                score: e.score,
                date: e.date,
                at: e.at,
                priority: (e.score || 0) >= 15 ? 6 : (e.score || 0) >= 13 ? 5 : 3,
                shareable: !isBlockedContent(`${e.title} ${e.reason} ${e.quote}`)
            }))
        }
    }

    readBrief() {
        try {
            const st = fs.statSync(this.paths.brief)
            if (this.briefCache.mtime === st.mtimeMs) return this.briefCache.text
            const text = fs.readFileSync(this.paths.brief, 'utf8').trim()
            this.briefCache = { mtime: st.mtimeMs, text }
            return text
        } catch {
            return ''
        }
    }

    readIndex() {
        try {
            const st = fs.statSync(this.paths.index)
            if (this.indexCache.mtime === st.mtimeMs && this.indexCache.data) return this.indexCache.data
            const data = JSON.parse(fs.readFileSync(this.paths.index, 'utf8'))
            this.indexCache = { mtime: st.mtimeMs, data }
            return data
        } catch {
            return null
        }
    }

    /** 重建三份产物。4 分钟内重复调用直接返回缓存。 */
    async refresh({ force = false } = {}) {
        this.init()
        if (this.refreshing) return this.refreshing
        if (!force && this.lastRefreshAt && Date.now() - this.lastRefreshAt < 4 * 60 * 1000) {
            if (fs.existsSync(this.paths.brief)) return { ok: true, cached: true }
        }
        this.refreshing = (async () => {
            const started = Date.now()
            try {
                const data = this.readLedger()
                const entries = data.entries
                const doc = this.buildDoc(entries)
                const brief = this.buildBrief(entries)
                const index = this.buildIndex(entries)
                atomicWriteText(this.paths.doc, doc + '\n')
                atomicWriteText(this.paths.brief, brief + '\n')
                atomicWriteText(this.paths.index, JSON.stringify(index, null, 2) + '\n')
                this.briefCache = { mtime: -1, text: '' }
                this.indexCache = { mtime: -1, data: null }
                this.lastRefreshAt = Date.now()
                const stats = {
                    ok: true,
                    ms: Date.now() - started,
                    entries: entries.length,
                    briefChars: brief.length,
                    docChars: doc.length
                }
                logger.debug(
                    `[BiliMemory] 已刷新：${stats.entries} 条 · 简版 ${stats.briefChars} 字 · 用时 ${stats.ms}ms`
                )
                return stats
            } catch (error) {
                logger.warn(`[BiliMemory] 刷新失败：${error?.message ?? error}`)
                return { ok: false, error: String(error?.message ?? error) }
            } finally {
                this.refreshing = null
            }
        })()
        return this.refreshing
    }

    /** 常驻注入块：短记忆，每轮都带。 */
    briefBlock() {
        if (!this.config.enabled) return ''
        const brief = this.readBrief()
        return brief ? `${brief}\n` : ''
    }

    tokenize(query) {
        const q = String(query ?? '').toLowerCase()
        const tokens = new Set()
        for (const m of q.matchAll(/[a-z0-9]{2,}/g)) {
            if (!/^bv[0-9a-z]{10}$/.test(m[0])) tokens.add(m[0])
        }
        const cjk = q.replace(/[^\u4e00-\u9fff]/g, ' ')
        for (const seg of cjk.split(/\s+/)) {
            for (let i = 0; i + 1 < seg.length; i += 1) {
                const bg = seg.slice(i, i + 2)
                if (!STOP_BIGRAMS.has(bg)) tokens.add(bg)
            }
        }
        return [...tokens].slice(0, 24)
    }

    /** 按当前这句话检索，命中才注入；分数不够返回空串，宁可空着。 */
    recallBlock(query, { maxChars = this.config.recallMaxChars, limit = 4 } = {}) {
        if (!this.config.enabled) return ''
        const q = String(query ?? '').trim()
        if (!q || q.length < 2) return ''
        const index = this.readIndex()
        if (!index || !Array.isArray(index.entries)) return ''
        const lower = q.toLowerCase()
        const bv = extractBv(q)
        const tokens = this.tokenize(q)
        const trigger =
            /B站|b站|bilibili|视频|肥鱼|鲸鱼|养鱼|动态|评论|弹幕|up主|BV|投稿|收藏|刷到|看过|记得|日记|账号/.test(
                q
            ) || tokens.length > 0
        if (!trigger) return ''
        const scored = []
        for (const e of index.entries) {
            const hay = `${e.title ?? ''} ${e.text ?? ''} ${e.quote ?? ''} ${e.reason ?? ''}`.toLowerCase()
            let score = 0
            if (bv && e.bvid === bv) score += 60
            if (e.title && e.title.length >= 4 && lower.includes(String(e.title).toLowerCase())) score += 30
            let hit = 0
            for (const t of tokens) {
                if (!t) continue
                if (String(e.title ?? '').toLowerCase().includes(t)) {
                    score += 5
                    hit += 1
                    continue
                }
                if (hay.includes(t)) {
                    score += 2
                    hit += 1
                }
            }
            if (hit >= 3) score += 4
            const days = e.date
                ? Math.floor((Date.now() - Date.parse(`${e.date}T00:00:00+08:00`)) / 86400000)
                : 99
            if (days <= 2) score += 3
            else if (days <= 7) score += 1
            if (isBlockedContent(hay)) score = 0
            if (score > 0) scored.push({ e, score })
        }
        scored.sort((a, b) => b.score - a.score)
        if (!scored.length || scored[0].score < 8) return ''
        // 只保留和最高分同量级的命中，避免一条擦边的也跟进来
        const topScore = scored[0].score
        const floor = Math.max(8, Math.floor(topScore * 0.6))
        const lines = ['【B站记忆检索（和刚说的话相关；自然回忆，不要照读，不要提“记忆库”）】']
        let used = 0
        const seenBv = new Set()
        for (const { e, score } of scored) {
            if (score < floor) break
            if (used >= maxChars || lines.length - 1 >= limit) break
            if (e.bvid && seenBv.has(e.bvid)) continue
            if (e.bvid) seenBv.add(e.bvid)
            const plain = s => short(String(s ?? '').replace(/https?:\/\/\S+/g, ''), 150)
            let line = ''
            if (e.bvid) {
                line = `- ${e.date || ''} 你看过《${e.title}》${e.bvid}：${plain(e.reason || e.text)}`
            } else {
                line = `- ${e.date || ''} ${plain(e.text)}`
            }
            if (e.quote && !line.includes(short(e.quote, 40))) {
                line += `（你当时的评论：「${short(String(e.quote).replace(/https?:\/\/\S+/g, ''), 80)}」）`
            }
            if (used + line.length > maxChars) break
            lines.push(line)
            used += line.length
        }
        return lines.length > 1 ? `${lines.join('\n')}\n` : ''
    }

    history() {
        const raw = readJson(this.paths.history, null)
        if (raw && typeof raw === 'object' && raw.used && typeof raw.used === 'object') return raw
        return { used: {}, lastSlot: {} }
    }

    saveHistory(data) {
        try {
            atomicWriteText(this.paths.history, JSON.stringify(data, null, 2) + '\n')
        } catch {}
    }

    /** 从分享池挑一条没发过的；六天内都发过就返回 null，不发旧的。 */
    pickShareCard({ historyDays = this.config.shareHistoryDays, allowReuse = false } = {}) {
        const index = this.readIndex()
        if (!index || !Array.isArray(index.entries)) return null
        const hist = this.history()
        const used = hist.used ?? {}
        const cutoff = Date.now() - Math.max(1, historyDays) * 86400000
        const pool = index.entries
            .filter(e => e.shareable)
            .filter(
                e =>
                    (e.score || 0) >= 12 ||
                    (e.quote && e.quote.length >= 18) ||
                    (e.reason && e.reason.length >= 24)
            )
            .filter(e => (e.text || e.quote || e.reason || '').length >= 18)
            .filter(e => !e.date || Date.now() - Date.parse(`${e.date}T00:00:00+08:00`) < 21 * 86400000)
            .sort(
                (a, b) =>
                    (b.priority || 0) - (a.priority || 0) ||
                    (b.score || 0) - (a.score || 0) ||
                    String(b.date).localeCompare(String(a.date))
            )
            .slice(0, 16)
        if (!pool.length) return null
        const fresh = pool.filter(e => !(Date.parse(used[e.id] ?? 0) > cutoff))
        if (!fresh.length) return allowReuse ? pool[0] ?? null : null
        return fresh[0]
    }

    recordShare(id, slotKey = '') {
        if (!id) return
        const hist = this.history()
        hist.used = hist.used ?? {}
        hist.used[id] = new Date().toISOString()
        const cutoff = Date.now() - 30 * 86400000
        for (const [k, v] of Object.entries(hist.used)) {
            if (Date.parse(v) < cutoff) delete hist.used[k]
        }
        if (slotKey) {
            hist.lastSlot = hist.lastSlot ?? {}
            hist.lastSlot[slotKey] = new Date().toISOString()
        }
        this.saveHistory(hist)
    }

    status() {
        const index = this.readIndex()
        const hist = this.history()
        return {
            ok: Boolean(index),
            generatedAt: index?.generatedAt ?? '',
            entries: index?.entries?.length ?? 0,
            shareable: index?.entries?.filter(e => e.shareable).length ?? 0,
            briefChars: this.readBrief().length,
            used: Object.keys(hist.used ?? {}).length,
            lastSlots: hist.lastSlot ?? {},
            paths: this.paths
        }
    }
}

export const biliMemoryService = new BiliMemoryService()
export default biliMemoryService
