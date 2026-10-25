import { getHtml, pickArray, mmr, num, pick, ARCHETYPE, BASE } from './hunt_core.js'

async function queryPlayer (query) {
  const html = await getHtml(BASE + '?q=' + encodeURIComponent(query))
  const players = pickArray(html, 'players')
  if (!players || !players.length) {
    return { success: false, error: '没找到「' + query + '」这个猎人，确认下名字或者换 SteamID 试试' }
  }
  const p = players[0]
  const detailHtml = await getHtml(BASE + '/p/' + p.steam_id)
  const detail = pickArray(detailHtml, 'players')
  const d = (detail && detail[0]) || p
  const rankMatch = detailHtml.match(/第 (\d+) 名，共 (\d+) 名，前 ([\d.]+)%/)
  const kda = pick(d.kda_lifetime, p.kda_lifetime)
  const kd = pick(d.kd_ratio, p.kd_ratio)
  const minutes = pick(d.hunt_playtime_minutes, p.hunt_playtime_minutes) || 0
  const totalPlayers = (html.match(/totalAll:(\d+)/) || [])[1]
  return {
    success: true,
    name: pick(d.name, p.name),
    steam_id: pick(d.steam_id, p.steam_id),
    mmr: mmr(pick(d.skill_rating, p.skill_rating)),
    kda: kda ? Number(kda.toFixed(2)) : null,
    kd: kd ? Number(kd.toFixed(2)) : null,
    kills: pick(d.player_kills, p.player_kills),
    deaths: pick(d.killed_by_player, p.killed_by_player),
    bounty: pick(d.total_bounty, p.total_bounty),
    hours: Math.round(minutes / 60),
    archetype: ARCHETYPE[pick(d.archetype_key, p.archetype_key)] || '-',
    rank: pick(d.rank, p.rank),
    total_players: totalPlayers ? Number(totalPlayers) : null,
    kills_rank: rankMatch ? { pos: Number(rankMatch[1]), total: Number(rankMatch[2]), pct: rankMatch[3] } : null,
    url: BASE + '/p/' + pick(d.steam_id, p.steam_id)
  }
}

async function queryLeaderboard () {
  const html = await getHtml(BASE)
  const players = pickArray(html, 'players') || []
  return players.slice(0, 10).map(function (p) {
    return {
      rank: p.rank,
      name: p.name,
      mmr: mmr(p.skill_rating),
      kda: p.kda_lifetime ? Number(p.kda_lifetime.toFixed(2)) : null,
      kills: p.player_kills,
      archetype: ARCHETYPE[p.archetype_key] || '-'
    }
  })
}

function formatPct (pos, total) {
  if (!total) return ''
  const pct = (pos / total) * 100
  if (pct < 0.1) return '前 0.1%'
  return '前 ' + (pct < 1 ? pct.toFixed(1) : Math.round(pct)) + '%'
}

function formatPlayer (r) {
  if (!r.success) return r.error
  const lines = []
  lines.push(r.name + ' · ' + r.archetype)
  lines.push('MMR ' + r.mmr + ' | KDA ' + (r.kda === null ? '-' : r.kda) + ' | KD ' + (r.kd === null ? '-' : r.kd))
  lines.push('击杀 ' + num(r.kills) + ' | 死亡 ' + num(r.deaths) + ' | 赏金 ' + num(r.bounty))
  lines.push('时长 ' + r.hours + ' 小时')
  if (r.rank) lines.push('名册排名 #' + r.rank + (r.total_players ? ' / ' + num(r.total_players) : ''))
  if (r.kills_rank) lines.push('击杀 ' + num(r.kills) + ' 排第 ' + r.kills_rank.pos + ' ' + formatPct(r.kills_rank.pos, r.kills_rank.total))
  lines.push(r.url)
  return lines.join('\n')
}

function formatLeaderboard (list) {
  if (!list.length) return '没拿到排行榜数据，稍后再试试'
  return list.map(function (p) {
    return '#' + p.rank + ' ' + p.name + ' | MMR ' + p.mmr + ' | KDA ' + (p.kda === null ? '-' : p.kda) + (p.archetype !== '-' ? ' | ' + p.archetype : '')
  }).join('\n')
}

export { queryPlayer, queryLeaderboard, formatPlayer, formatLeaderboard }

