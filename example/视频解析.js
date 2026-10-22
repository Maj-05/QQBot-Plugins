import plugin from '../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { execSync } from 'child_process'

// ================= 配置区 =================
const BILI_COOKIE = "输入你自己的bcooike "
const MAX_DURATION = 600 // 最大允许解析的视频时长(秒)
// =========================================

// 辅助函数：格式化播放量（如 3.5万）
function formatNumber(num) {
  if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿'
  if (num >= 10000) return (num / 10000).toFixed(1) + '万'
  return num.toString()
}

export class BiliParser extends plugin {
  constructor() {
    super({
      name: 'B站解析',
      dsc: '只解析B站视频，直接发送视频文件',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '(BV[0-9A-Za-z]{10})|(b23\\.tv/[0-9A-Za-z]+)',
          fnc: 'parseBili'
        }
      ]
    })
  }

  async parseBili(e) {
    // 提取链接或BV号
    let match = e.msg.match(/(BV[0-9A-Za-z]{10})|(b23\.tv\/[0-9A-Za-z]+)/)
    if (!match) return false

    let bvid = match[1]
    let shortUrl = match[2]

    if (shortUrl) {
      try {
        let res = await axios.head(`https://${shortUrl}`, { maxRedirects: 0, validateStatus: null })
        let location = res.headers.location
        if (location) {
          let bvMatch = location.match(/(BV[0-9A-Za-z]{10})/)
          if (bvMatch) bvid = bvMatch[1]
        }
      } catch (err) {
        return e.reply('短链接解析失败')
      }
    }

    if (!bvid) return e.reply('未找到有效的BV号')

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    }
    if (BILI_COOKIE) headers['Cookie'] = BILI_COOKIE

    try {
      // 1. 获取视频基础信息
      let infoRes = await axios.get(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers })
      let infoData = infoRes.data

      if (infoData.code !== 0) {
        return e.reply(`获取视频信息失败: ${infoData.code} (可能触发风控，请检查Cookie是否失效)`)
      }

      let videoData = infoData.data
      let title = videoData.title
      let duration = videoData.duration
      let cid = videoData.cid
      let pic = videoData.pic
      let aid = videoData.aid
      let ownerName = videoData.owner.name
      let viewCount = videoData.stat.view
      let danmakuCount = videoData.stat.danmaku

      if (duration > MAX_DURATION) {
        return e.reply(`视频时长超过 ${MAX_DURATION / 60} 分钟，已取消解析。`)
      }

      // 2. 获取视频播放流 
      // qn=16 表示 360P， qn=64 是 720P
      let playRes = await axios.get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=16`, { headers })
      let playData = playRes.data

      if (playData.code !== 0 || !playData.data.dash) {
        return e.reply(`获取视频流失败，可能需要大会员或触发风控。`)
      }

      // 优先获取360P流，如果找不到降级获取默认流
      let videoStream = playData.data.dash.video.find(v => v.id === 16) || playData.data.dash.video[0]
      let audioStream = playData.data.dash.audio[0]

      let videoUrl = videoStream.baseUrl
      let audioUrl = audioStream.baseUrl

      // 3. 发送详细信息卡片
      // 【修改点 3】详细化标题信息
      let msg = [
        `av${aid}`,
        `${title}`,
        `UP：${ownerName}`,
        `${formatNumber(viewCount)}播放 ${formatNumber(danmakuCount)}弹幕`,
        `https://www.bilibili.com/video/${bvid}`,
        segment.image(pic) // 图片放最后
      ]
      await e.reply(msg)

      const tmpDir = path.join(process.cwd(), 'data', 'bili_tmp')
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
      
      const videoPath = path.join(tmpDir, `${bvid}_video.m4s`)
      const audioPath = path.join(tmpDir, `${bvid}_audio.m4s`)
      const outPath = path.join(tmpDir, `${bvid}.mp4`)

      const download = async (url, dest) => {
        const response = await axios({ url, method: 'GET', responseType: 'stream', headers })
        const writer = fs.createWriteStream(dest)
        response.data.pipe(writer)
        return new Promise((resolve, reject) => {
          writer.on('finish', resolve)
          writer.on('error', reject)
        })
      }

      await download(videoUrl, videoPath)
      await download(audioUrl, audioPath)

      try {
        // 360P 文件很小，合并非常快
        execSync(`ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c copy "${outPath}"`, { stdio: 'ignore' })
      } catch (err) {
        logger.error(`[B站解析] FFmpeg 合并失败: ${err}`)
        return e.reply('视频合并失败，请检查服务器是否安装了 ffmpeg。')
      }

      // 发送视频文件
      await e.reply(segment.video(`file://${outPath}`))

      // 清理临时文件
      try {
        fs.unlinkSync(videoPath)
        fs.unlinkSync(audioPath)
        fs.unlinkSync(outPath)
      } catch (cleanErr) {}

    } catch (err) {
      logger.error(`[B站解析] 发生错误: ${err}`)
      return e.reply('解析发生异常，请查看控制台日志。')
    }
  }
}
