import plugin from '../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import crypto from 'crypto'
import { execSync } from 'child_process'

// ================= 配置读取 =================
const CONFIG_PATH = path.join(process.cwd(), 'config', 'bili.yaml')

const DEFAULTS = {
    cookie: '',
    max_duration: 600,
    parse_article: true,
    max_chars: 2000,
    max_images: 3,
    timeout: 15000
}

function loadConfig() {
    const cfg = { ...DEFAULTS }
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            logger.warn('[B站解析] 未找到 config/bili.yaml，使用默认配置')
            return cfg
        }
        const text = fs.readFileSync(CONFIG_PATH, 'utf8')
        for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) continue
            const m = trimmed.match(/^([A-Za-z_][\w]*):\s*(.*)$/)
            if (!m) continue
            const key = m[1]
            let val = m[2].trim()
            if (!(key in cfg)) continue
            if (!val.startsWith('"') && !val.startsWith("'")) {
                const idx = val.indexOf(' #')
                if (idx > -1) val = val.slice(0, idx).trim()
            }
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1)
            }
            if (typeof cfg[key] === 'number') {
                const n = Number(val)
                if (!Number.isNaN(n)) cfg[key] = n
            } else if (typeof cfg[key] === 'boolean') {
                cfg[key] = val === 'true' || val === '1'
            } else {
                cfg[key] = val
            }
        }
    } catch (err) {
        logger.error(`[B站解析] 读取配置失败: ${err.message}`)
    }
    return cfg
}

// ================= 工具函数 =================
function formatNumber(num) {
    if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿'
    if (num >= 10000) return (num / 10000).toFixed(1) + '万'
    return num.toString()
}

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const WBI_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
    41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52
]

let cachedMixinKey = { key: '', expire: 0 }
let cachedAnonCookie = { value: '', expire: 0 }

async function getWbiMixinKey(timeout) {
    const now = Date.now()
    if (cachedMixinKey.key && cachedMixinKey.expire > now) return cachedMixinKey.key
    const nav = await axios.get('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'User-Agent': UA },
        timeout
    })
    const { img_url, sub_url } = nav.data.data.wbi_img
    const orig = img_url.split('/').pop().split('.')[0] + sub_url.split('/').pop().split('.')[0]
    const key = WBI_TAB.map(i => orig[i]).join('').slice(0, 32)
    cachedMixinKey = { key, expire: now + 30 * 60 * 1000 }
    return key
}

async function signWbi(params, timeout) {
    const mixinKey = await getWbiMixinKey(timeout)
    const withTs = { ...params, wts: Math.round(Date.now() / 1000) }
    const query = Object.keys(withTs)
        .sort()
        .map(k => `${k}=${encodeURIComponent(String(withTs[k]).replace(/[!'()*]/g, ''))}`)
        .join('&')
    const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
    return `${query}&w_rid=${w_rid}`
}

async function getAnonCookie(timeout) {
    const now = Date.now()
    if (cachedAnonCookie.value && cachedAnonCookie.expire > now) return cachedAnonCookie.value
    try {
        const res = await axios.get('https://www.bilibili.com', {
            headers: { 'User-Agent': UA },
            timeout,
            validateStatus: null
        })
        const raw = res.headers['set-cookie'] || []
        const value = raw.map(c => c.split(';')[0]).join('; ')
        cachedAnonCookie = { value, expire: now + 30 * 60 * 1000 }
        return value
    } catch {
        return ''
    }
}

// ================= 链接识别 =================
const BV_RE = /BV[0-9A-Za-z]{10}/
const SHORT_RE = /b23\.tv\/[0-9A-Za-z]+/
const OPUS_RE = /(?:bilibili\.com\/opus\/|t\.bilibili\.com\/)(\d{6,})/
const CV_RE = /(?:bilibili\.com\/read\/cv|^|\D)cv(\d{3,})/i

/**
 * 展开 b23.tv 短链
 * @param {string} shortUrl
 * @param {number} timeout
 * @returns {Promise<string|null>}
 */
async function expandShort(shortUrl, timeout) {
    try {
        const res = await axios.get(`https://${shortUrl}`, {
            headers: { 'User-Agent': UA },
            maxRedirects: 0,
            validateStatus: null,
            timeout
        })
        const loc = res.headers.location
        if (loc) return loc.startsWith('//') ? `https:${loc}` : loc
        return null
    } catch (err) {
        logger.warn(`[B站解析] 短链展开失败: ${err.message}`)
        return null
    }
}

/**
 * 从卡片 JSON 里递归挖出所有 bilibili 链接
 * @param {any} card
 * @returns {string[]}
 */
function extractUrlsFromCard(card) {
    const urls = new Set()
    let data = card
    if (typeof card === 'string') {
        try {
            data = JSON.parse(card)
        } catch {
            const m = card.replace(/\\\//g, '/').match(/https?:\/\/[^\s"'<>\\]+/g)
            if (m) m.forEach(u => urls.add(u))
            return [...urls]
        }
    }
    const walk = obj => {
        if (!obj) return
        if (typeof obj === 'string') {
            const s = obj.replace(/\\\//g, '/')
            const m = s.match(/https?:\/\/[^\s"'<>\\]+/g)
            if (m) m.forEach(u => urls.add(u))
            return
        }
        if (Array.isArray(obj)) return obj.forEach(walk)
        if (typeof obj === 'object') return Object.values(obj).forEach(walk)
    }
    walk(data)
    return [...urls]
}

/**
 * 解析动态 / 专栏
 * @param {{type:string, id:string}} target
 * @param {object} cfg
 * @returns {Promise<object>}
 */
async function fetchArticle(target, cfg) {
    const cookie = cfg.cookie || (await getAnonCookie(cfg.timeout))
    const headers = {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `https://t.bilibili.com/${target.id}`,
        Cookie: cookie
    }

    try {
        if (target.type === 'opus') {
            const query = await signWbi(
                { id: target.id, timezone_offset: '-480', platform: 'web', features: 'itemOpusStyle' },
                cfg.timeout
            )
            const res = await axios.get(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?${query}`, {
                headers,
                timeout: cfg.timeout
            })
            const json = res.data
            if (json.code === 0 && json.data?.item) {
                const item = json.data.item
                const mod = item.modules?.module_dynamic || {}
                const desc = mod.desc?.text || mod.major?.opus?.summary?.text || ''
                const pics = mod.major?.opus?.pics || mod.major?.draw?.items || []
                const images = pics
                    .map(p => p.url || p.src)
                    .filter(Boolean)
                    .slice(0, cfg.max_images)
                let content = desc
                if (content.length > cfg.max_chars) content = content.slice(0, cfg.max_chars) + '…（已截断）'
                return {
                    success: true,
                    title: mod.major?.opus?.title || item.modules?.module_author?.name || '动态',
                    author: item.modules?.module_author?.name || '未知',
                    content: content || '（该动态没有文字内容）',
                    images,
                    url: `https://t.bilibili.com/${target.id}`
                }
            }
            logger.warn(`[B站解析] 动态接口返回 ${json.code} ${json.message || ''}`)
        }

        if (target.type === 'cv') {
            const res = await axios.get(`https://api.bilibili.com/x/article/viewinfo?id=${target.id}`, {
                headers,
                timeout: cfg.timeout
            })
            const d = res.data
            if (d.code === 0 && d.data) {
                return {
                    success: true,
                    title: d.data.title || '专栏',
                    author: d.data.author_name || '未知',
                    content: (d.data.summary || d.data.content || '').slice(0, cfg.max_chars),
                    images: [],
                    url: `https://www.bilibili.com/read/cv${target.id}`
                }
            }
        }
        return { success: false, error: '未取到内容' }
    } catch (err) {
        return { success: false, error: err.message }
    }
}

// ================= 插件主体 =================
export class BiliParser extends plugin {
    constructor() {
        super({
            name: 'B站解析',
            dsc: '解析B站视频、动态、专栏',
            event: 'message',
            priority: 5000,
            rule: [
                {
                    reg: 'b23\\.tv/|BV[0-9A-Za-z]{10}|bilibili\\.com/(video|opus|read)|t\\.bilibili\\.com/',
                    fnc: 'parseBili'
                }
            ]
        })
    }

    async parseBili(e) {
        const cfg = loadConfig()

        let rawMsg = ''
        const cards = []
        if (e.msg) rawMsg += e.msg + ' '
        if (e.raw_message) rawMsg += e.raw_message + ' '
        if (e.message && Array.isArray(e.message)) {
            for (const m of e.message) {
                if (typeof m === 'string') {
                    rawMsg += m + ' '
                } else if (m.data) {
                    if (m.type === 'json' || m.type === 'xml') {
                        cards.push(m.data.data || m.data)
                    }
                    rawMsg += (typeof m.data === 'string' ? m.data : JSON.stringify(m.data)) + ' '
                }
            }
        }
        rawMsg = rawMsg.replace(/\\\//g, '/').replace(/&amp;/g, '&')

        let allText = rawMsg
        for (const card of cards) {
            const urls = extractUrlsFromCard(card)
            if (urls.length) allText += ' ' + urls.join(' ')
        }

        const shortMatch = allText.match(SHORT_RE)
        if (shortMatch) {
            const real = await expandShort(shortMatch[0], cfg.timeout)
            if (real) allText += ' ' + real
        }

        const bvMatch = allText.match(BV_RE)
        if (bvMatch) return this.handleVideo(e, bvMatch[0], cfg)

        if (cfg.parse_article) {
            const opusMatch = allText.match(OPUS_RE)
            if (opusMatch) return this.handleArticle(e, { type: 'opus', id: opusMatch[1] }, cfg)

            const cvMatch = allText.match(CV_RE)
            if (cvMatch) return this.handleArticle(e, { type: 'cv', id: cvMatch[1] }, cfg)
        }

        logger.warn('[B站解析] 未识别出可解析的链接类型')
        return false
    }

    async handleArticle(e, target, cfg) {
        const result = await fetchArticle(target, cfg)
        if (!result.success) {
            logger.warn(`[B站解析] 图文解析失败: ${result.error}`)
            return e.reply('这条B站内容没解析出来，可能链接不完整或者接口限制了')
        }

        const lines = [`📄 ${result.title}`, `👤 ${result.author}`, '', result.content, '', `🔗 ${result.url}`]
        const msg = [lines.join('\n')]
        for (const img of result.images) {
            msg.push(segment.image(img))
        }
        return e.reply(msg)
    }

    async handleVideo(e, bvid, cfg) {
        const headers = {
            'User-Agent': UA,
            Referer: 'https://www.bilibili.com/'
        }
        if (cfg.cookie) headers.Cookie = cfg.cookie

        try {
            const infoRes = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
                headers,
                timeout: cfg.timeout
            })
            const infoData = infoRes.data
            if (infoData.code !== 0) {
                return e.reply(`获取视频信息失败: ${infoData.message}`)
            }

            const v = infoData.data
            const { title, duration, cid, pic, aid, owner, stat } = v
            let textMsg =
                `📺 av${aid}\n` +
                `${title}\n` +
                ` UP：${owner.name}\n` +
                ` ${formatNumber(stat.view)}播放 | ${formatNumber(stat.danmaku)}弹幕\n` +
                `🔗 https://www.bilibili.com/video/${bvid}`

            if (duration > cfg.max_duration) {
                textMsg += `\n\n 视频时长超过 ${Math.round(cfg.max_duration / 60)} 分钟，仅提供预览及链接。`
                return e.reply([textMsg, segment.image(pic)])
            }

            await e.reply([textMsg, segment.image(pic)])

            const playRes = await axios.get(
                `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=16`,
                { headers, timeout: cfg.timeout }
            )
            const playData = playRes.data
            if (playData.code !== 0 || !playData.data.dash) {
                return e.reply('获取视频流失败，可能需要大会员或触发风控。')
            }

            const videoStream = playData.data.dash.video.find(x => x.id === 16) || playData.data.dash.video[0]
            const audioStream = playData.data.dash.audio[0]

            const tmpDir = path.join(process.cwd(), 'data', 'bili_tmp')
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

            const videoPath = path.join(tmpDir, `${bvid}_video.m4s`)
            const audioPath = path.join(tmpDir, `${bvid}_audio.m4s`)
            const outPath = path.join(tmpDir, `${bvid}.mp4`)

            const download = async (url, dest) => {
                const response = await axios({
                    url,
                    method: 'GET',
                    responseType: 'stream',
                    headers,
                    timeout: cfg.timeout
                })
                const writer = fs.createWriteStream(dest)
                response.data.pipe(writer)
                return new Promise((resolve, reject) => {
                    writer.on('finish', resolve)
                    writer.on('error', reject)
                })
            }

            await download(videoStream.baseUrl, videoPath)
            await download(audioStream.baseUrl, audioPath)

            try {
                execSync(`ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c copy "${outPath}"`, { stdio: 'ignore' })
            } catch (err) {
                logger.error(`[B站解析] FFmpeg 合并失败: ${err}`)
                return e.reply('视频合并失败，请检查服务器是否安装了 ffmpeg。')
            }

            await e.reply(segment.video(`file://${outPath}`))

            try {
                fs.unlinkSync(videoPath)
                fs.unlinkSync(audioPath)
                fs.unlinkSync(outPath)
            } catch {}
        } catch (err) {
            logger.error(`[B站解析] 发生错误: ${err}`)
            return e.reply('解析发生异常，请查看控制台日志。')
        }
    }
}
