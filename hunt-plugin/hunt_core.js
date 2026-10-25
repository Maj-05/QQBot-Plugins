const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const BASE = 'https://bayouledger.com/zh'

const ARCHETYPE = {
  apex_predator: '顶级掠食者',
  trailblazer: '自在猎人',
  scout: '侦察兵',
  lone_wolf: '独行客',
  terminator: '终结者',
  reaper: '收割者',
  vulture: '秃鹫',
  warlord: '战地指挥官',
  poacher: '偷猎者',
  sharpshooter: '神枪眼',
  gunslinger: '亡命徒',
  marksman: '神射手',
  brawler: '打手',
  marauder: '劫掠者'
}

async function getHtml (url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }
  })
  if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status)
  return await res.text()
}

function pickArray (html, key) {
  const idx = html.indexOf(key + ':[{')
  if (idx < 0) return null
  const start = idx + key.length + 1
  let depth = 0
  let inStr = false
  let quote = ''
  let escaped = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === String.fromCharCode(92)) escaped = true
      else if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true
      quote = ch
      continue
    }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) return null
  const raw = html.slice(start, end)
  try {
    return new Function('return (' + raw + ')')()
  } catch (e) {
    return null
  }
}

function mmr (skill) {
  if (skill === null || skill === undefined) return '-'
  return Math.round(skill * 1000)
}

function num (n) {
  if (n === null || n === undefined) return '-'
  return Number(n).toLocaleString('en-US')
}

function pick (a, b) {
  return (a !== null && a !== undefined) ? a : b
}

export { getHtml, pickArray, mmr, num, pick, ARCHETYPE, BASE }
