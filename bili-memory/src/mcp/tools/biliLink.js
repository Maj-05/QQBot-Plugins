import config from '../../../config/config.js'
import { StandardBotApi, StandardMessage as segment } from '../../core/platform/index.js'
import { chatLogger as logger } from '../../core/utils/logger.js'

/**
 * B 站链接解析工具
 *
 * 说明：
 * - 只做「链接 -> 信息卡片」的解析，不下载视频本体，避免大文件与风控问题
 * - 短链 b23.tv / bili2233.cn 先跟随重定向拿到真实 URL
 * - 支持 BV 号、av 号、b23.tv 短链、带 p 分P 的视频链接
 * - 可选使用 config 里的 bilibili.sessdata，登录态下能拿到更完整的接口数据
 */

/** 外部请求超时（毫秒） */
const BILI_TIMEOUT_MS = 15000

/** 短链最多跟随的跳转次数，防止死循环 */
const MAX_REDIRECTS = 5

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 短链域名 */
const SHORT_HOSTS = ['b23.tv', 'bili2233.cn', 'bili22.cn', 'bili33.cn']

/**
 * 判断 URL 是否属于 B 站
 * @param {string} url
 * @returns {boolean}
 */
export function isBiliUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase()
        return host.endsWith('bilibili.com') || SHORT_HOSTS.includes(host)
    } catch {
        return false
    }
}

/**
 * 跟随重定向拿到最终 URL
 * @param {string} url
 * @returns {Promise<string>}
 */
async function resolveRedirect(url) {
    let current = url
    for (let i = 0; i < MAX_REDIRECTS; i++) {
        const res = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(BILI_TIMEOUT_MS)
        })
        const location = res.headers.get('location')
        if (!location) return current
        current = new URL(location, current).toString()
        if (!isBiliUrl(current)) return current
    }
    return current
}

/**
 * 从链接中解析出视频标识
 * @param {string} url
 * @returns {{ bvid?: string, aid?: string, page?: number } | null}
 */
export function parseBiliVideoId(url) {
    if (!url) return null

    const bv = url.match(/\/video\/(BV[0-9A-Za-z]{10})/i)
    if (bv) {
        const page = url.match(/[?&]p=(\d+)/)
        return { bvid: bv[1], page: page ? Number(page[1]) : 1 }
    }

    const av = url.match(/\/video\/av(\d+)/i)
    if (av) {
        const page = url.match(/[?&]p=(\d+)/)
        return { aid: av[1], page: page ? Number(page[1]) : 1 }
    }

    return null
}

/** 匿名 Cookie 缓存（buvid3 等），有效期 30 分钟 */
let anonCookie = ''
let anonCookieAt = 0
const ANON_COOKIE_TTL = 30 * 60 * 1000

/**
 * 获取匿名 Cookie：先访问主页拿 buvid3，否则接口会返回 -412 风控
 * 配置了 bilibili.sessdata 时优先使用登录态
 * @returns {Promise<string>}
 */
async function getCookie() {
    const sessdata = config.get('bilibili.sessdata') || ''
    if (sessdata) return `SESSDATA=${sessdata}`

    if (anonCookie && Date.now() - anonCookieAt < ANON_COOKIE_TTL) return anonCookie

    try {
        const res = await fetch('https://www.bilibili.com', {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(BILI_TIMEOUT_MS)
        })
        const parts = []
        for (const [k, v] of res.headers) {
            if (k.toLowerCase() === 'set-cookie') parts.push(v.split(';')[0])
        }
        anonCookie = parts.join('; ')
        anonCookieAt = Date.now()
    } catch (err) {
        logger.debug(`[biliLink] 获取匿名 Cookie 失败: ${err.message}`)
    }
    return anonCookie
}

/**
 * 构造请求头（带登录态时更稳）
 * @returns {Promise<Object>}
 */
async function buildHeaders() {
    const headers = {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json, text/plain, */*'
    }
    const cookie = await getCookie()
    if (cookie) headers.Cookie = cookie
    return headers
}

/**
 * 数字格式化：12345 -> 1.2万
 * @param {number} num
 * @returns {string}
 */
function formatCount(num) {
    const n = Number(num) || 0
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
    return String(n)
}

/**
 * 秒数转 mm:ss / hh:mm:ss
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    const s = Number(seconds) || 0
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    const pad = v => String(v).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * 拉取视频基础信息
 * @param {{ bvid?: string, aid?: string }} id
 * @returns {Promise<Object>}
 */
async function fetchVideoInfo(id) {
    const query = id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, {
        headers: await buildHeaders(),
        signal: AbortSignal.timeout(BILI_TIMEOUT_MS)
    })
    const json = await res.json()
    if (json.code !== 0) throw new Error(json.message || '获取视频信息失败')
    return json.data
}

/**
 * 拉取分P列表（可选，失败不影响主流程）
 * @param {string} bvid
 * @returns {Promise<Array|null>}
 */
async function fetchPages(bvid) {
    try {
        const res = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
            headers: await buildHeaders(),
            signal: AbortSignal.timeout(BILI_TIMEOUT_MS)
        })
        const json = await res.json()
        if (json.code !== 0) return null
        return json.data
    } catch {
        return null
    }
}

/**
 * 解析 B 站链接并组装成可读文本
 * @param {string} url
 * @returns {Promise<{ success: boolean, text?: string, cover?: string, bvid?: string, error?: string }>}
 */
export async function resolveBiliLink(url) {
    try {
        let target = url
        if (SHORT_HOSTS.includes(new URL(url).hostname.toLowerCase())) {
            target = await resolveRedirect(url)
        }

        const id = parseBiliVideoId(target)
        if (!id) {
            return { success: false, error: '链接里没找到视频 BV/av 号' }
        }

        const data = await fetchVideoInfo(id)
        const page = id.page || 1
        const pages = data.videos > 1 ? await fetchPages(data.bvid) : null
        const pageInfo = pages?.[page - 1]

        const lines = []
        lines.push(`标题：${data.title}`)
        lines.push(`UP主：${data.owner?.name || '未知'}`)
        if (pageInfo) lines.push(`分P：P${page} ${pageInfo.part}`)
        lines.push(`时长：${formatDuration(pageInfo?.duration || data.duration)}`)
        lines.push(`播放：${formatCount(data.stat?.view)}  弹幕：${formatCount(data.stat?.danmaku)}`)
        lines.push(`点赞：${formatCount(data.stat?.like)}  投币：${formatCount(data.stat?.coin)}  收藏：${formatCount(data.stat?.favorite)}`)
        if (data.desc) lines.push(`简介：${data.desc.replace(/\s+/g, ' ').slice(0, 100)}`)

        return {
            success: true,
            bvid: data.bvid,
            cover: data.pic ? (data.pic.startsWith('//') ? 'https:' + data.pic : data.pic) : '',
            text: lines.join('\n')
        }
    } catch (err) {
        logger.debug(`[biliLink] 解析失败: ${err.message}`)
        return { success: false, error: err.message }
    }
}

export const biliLinkTools = [
    {
        name: 'bilibili_link_parse',
        description: '解析B站视频链接（支持BV号、av号、b23.tv短链），返回标题、UP主、时长、播放量等卡片信息',
        inputSchema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'B站视频链接或BV号'
                },
                send: {
                    type: 'boolean',
                    description: '是否直接把结果发到当前会话，默认true',
                    default: true
                }
            },
            required: ['url']
        },
        handler: async (args, ctx) => {
            let { url, send = true } = args
            if (/^BV[0-9A-Za-z]{10}$/i.test(url)) {
                url = `https://www.bilibili.com/video/${url}`
            }

            const result = await resolveBiliLink(url)
            if (!result.success) return { error: `解析失败: ${result.error}` }

            if (send) {
                const payload = result.cover ? [segment.image(result.cover), result.text] : [result.text]
                await StandardBotApi.fromContext(ctx).reply(payload)
            }

            return { success: true, ...result }
        }
    }
]
