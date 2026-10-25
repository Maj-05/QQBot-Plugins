import plugin from '../../lib/plugins/plugin.js'
import { queryPlayer, queryLeaderboard, formatPlayer, formatLeaderboard } from './hunt_query.js'

export class HuntShowdown extends plugin {
  constructor () {
    super({
      name: '猎杀对决战绩',
      dsc: '查询 Hunt: Showdown 1896 玩家战绩',
      event: 'message',
      priority: 1000,
      rule: [
        {
          reg: '^#?猎杀(战绩|查询)?\\s*(.+)$',
          fnc: 'player'
        },
        {
          reg: '^#?猎杀排行$',
          fnc: 'leaderboard'
        }
      ]
    })
  }

  async player (e) {
    const m = e.msg.match(/^#?猎杀(?:战绩|查询)?\s*(.+)$/)
    const keyword = m && m[1] ? m[1].trim() : ''
    if (!keyword || keyword === '排行') return this.leaderboard(e)
    try {
      const r = await queryPlayer(keyword)
      return this.reply(formatPlayer(r), true)
    } catch (err) {
      return this.reply('查询出错了，等下再试试吧', true)
    }
  }

  async leaderboard (e) {
    try {
      const list = await queryLeaderboard()
      return this.reply(formatLeaderboard(list), true)
    } catch (err) {
      return this.reply('排行榜没拉到，稍后再试试', true)
    }
  }
}
