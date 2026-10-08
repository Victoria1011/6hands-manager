// 云函数：ppgardenTimer
// 云上花匠（ppgarden.top）花园托管定时调度（按花园配置时段版）
//
// 调度模型：
//   - 网站同一账号同时只能托管一个花园（并发位=1），多个花园按小时错峰轮换
//   - 每个「花园」独立配置每小时托管时段，如 [{start:0,stop:4},{start:30,stop:34}]
//     表示每小时的 00~04 分、30~34 分托管该花园，其余时间暂停
//   - 同一账号下不同花园的时段不允许重叠（保存校验 + 运行时守卫），支持一键随机错峰分配
//     （时段 4~5 分钟、间隔 25~30 分钟随机）；各托管账号相互独立，跨账号时段不构成冲突
//   - 每个花园有独立的定时托管开关
//   - 执行启停前先查询网站实际托管状态：已处于目标状态的操作直接跳过，避免冗余接口调用
//
// 登录策略：
//   每个网站账号每天只登录一次（会话 Cookie 缓存到数据库），当天复用；
//   Cookie 失效(401)自动重登；每天首次登录成功后自动加载网站内花园列表。
//
// 手动模式（管理端小程序调用，需 token）：
//   action: list / add / update / delete / logs / status
//           loadGardens / setGardenConfig / autoAssignAll
//           startGarden / pauseGarden / setMaster / runSchedule / siteActivity / gardenActivity
//
// 手动启动：手动启动的花园运行 MANUAL_RUN_MINUTES 分钟后由每分钟定时器自动暂停
//   （日志 trigger = 'auto'，不受定时任务总开关影响）

const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// ==================== 配置 ====================
const PPG_HOST = 'ppgarden.top'
const ACCOUNTS_COLL = 'ppgarden_accounts' // 账号、花园时段配置与会话缓存
const LOGS_COLL = 'ppgarden_logs'         // 执行日志集合
const STATE_COLL = 'ppgarden_state'       // 全局开关（单文档 global）
const STATE_DOC_ID = 'global'
const TIMER_NAME = 'ppgarden-timer-minute'

// 时段自动分配参数（随机区间）
const MIN_WINDOW_MIN = 4    // 单时段最短（分钟）
const MAX_WINDOW_MIN = 5    // 单时段最长（分钟）
const MIN_GAP_MIN = 25      // 同花园两时段间隔最短（分钟）
const MAX_GAP_MIN = 30      // 同花园两时段间隔最长（分钟）
const MIN_CROSS_GAP_MIN = 3 // 同一账号内与其它花园时段的最小间距（分钟）
const START_TOLERANCE_MIN = 2 // 错过整点后，start 分钟起 2 分钟内仍可补启动
const STOP_TOLERANCE_MIN = 2  // 错过整点后，stop 分钟起 2 分钟内仍可补暂停

const MAX_WINDOWS_PER_GARDEN = 6
const MIN_WINDOW_DURATION = 2 // 手动设置时单时段最短时长（分钟）

const MANUAL_RUN_MINUTES = 3 // 手动启动的花园运行多少分钟后自动暂停

const TZ_OFFSET_MS = 8 * 3600 * 1000 // 东八区（Asia/Shanghai）
const HTTP_TIMEOUT_MS = 20000
const DB_BATCH_SIZE = 100
const LOG_RETENTION_DAYS = 14

// 托管状态中文映射（对应网站 API 的 state 字段）
const STATE_TEXT = {
  paused: '已暂停',
  armed: '已就绪',
  managed: '托管中',
  running: '运行中',
  schedule_wait: '等待定时',
  finishing: '收尾中',
  blocked: '受阻'
}

// ==================== 基础工具 ====================
function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function randInt(min, max) {
  // 含首尾的随机整数
  return min + Math.floor(Math.random() * (max - min + 1))
}

function nowCST() {
  return new Date(Date.now() + TZ_OFFSET_MS)
}

// 由于已把时间戳 +8h，用 UTC 方法取值即为东八区时间
function cstDateStr(d) {
  return d.toISOString().slice(0, 10)
}

// 小时槽位：'YYYYMMDDHH'（东八区），用于每小时去重
function hourSlotOf(d) {
  return cstDateStr(d).replace(/-/g, '') + pad2(d.getUTCHours())
}

function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

function windowsText(windows) {
  return (windows || []).map(w => pad2(w.start) + '~' + pad2(w.stop)).join('、')
}

// ==================== 数据库工具 ====================
// 获取集合全部文档（先 count 再并发分页）
async function getAllDocs(collectionName) {
  const countRes = await db.collection(collectionName).count()
  const total = countRes.total || 0
  if (total === 0) return []

  const batchTimes = Math.ceil(total / DB_BATCH_SIZE)
  const tasks = []
  for (let i = 0; i < batchTimes; i++) {
    tasks.push(
      db.collection(collectionName)
        .skip(i * DB_BATCH_SIZE)
        .limit(DB_BATCH_SIZE)
        .get()
    )
  }
  const results = await Promise.all(tasks)
  return results.reduce((acc, r) => acc.concat(r.data || []), [])
}

// 确保集合存在（TCB 不会自动建集合）
let _collectionsReady = null
function ensureCollections() {
  if (!_collectionsReady) {
    _collectionsReady = (async () => {
      for (const name of [ACCOUNTS_COLL, LOGS_COLL, STATE_COLL]) {
        try {
          await db.createCollection(name)
          console.log('[PPGarden] 已创建集合:', name)
        } catch (e) {
          // 已存在时会抛错，忽略
        }
      }
    })().catch(e => {
      console.error('[PPGarden] 初始化集合失败:', e.message)
      _collectionsReady = null
    })
  }
  return _collectionsReady
}

async function saveLog(entry) {
  try {
    await db.collection(LOGS_COLL).add({ data: entry })
  } catch (e) {
    console.error('[PPGarden] 写日志失败:', e.message)
  }
}

// 全局开关（单文档）
async function getGlobalState() {
  try {
    const res = await db.collection(STATE_COLL).doc(STATE_DOC_ID).get()
    return res.data || null
  } catch (e) {
    return null
  }
}

async function ensureGlobalState() {
  let st = await getGlobalState()
  if (st) return st
  try {
    const initData = {
      _id: STATE_DOC_ID,
      masterEnabled: true, // 定时任务总开关
      updatedAt: db.serverDate()
    }
    await db.collection(STATE_COLL).add({ data: initData })
    st = initData
  } catch (e) {
    st = await getGlobalState()
  }
  return st || { masterEnabled: true }
}

// ==================== ppgarden.top HTTP 客户端 ====================
function httpRequest({ method = 'GET', path, body = null, cookie = null, timeoutMs = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null
    // 请求头与浏览器保持一致（站点在 Cloudflare 后面，头不一致可能被 bot 检测拦截）
    const headers = {
      'accept': 'application/json',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'referer': 'https://' + PPG_HOST + '/',
      'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not(A:Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
    if (postData) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(postData)
    }
    if (cookie) headers['cookie'] = cookie

    const req = https.request({
      hostname: PPG_HOST,
      port: 443,
      path,
      method,
      headers,
      timeout: timeoutMs
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        let json = null
        try {
          json = data ? JSON.parse(data) : null
        } catch (e) {
          json = null
        }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: data })
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error('请求超时（' + (timeoutMs / 1000) + 's）'))
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

// 把 Set-Cookie 响应头解析为 'k1=v1; k2=v2' 形式
function parseSetCookies(res) {
  const list = (res.headers && res.headers['set-cookie']) || []
  const jar = {}
  for (const line of list) {
    const pair = String(line).split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) {
      jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
  }
  return Object.keys(jar).map(k => k + '=' + jar[k]).join('; ')
}

// 强制重新登录（不使用缓存），成功后更新库内 Cookie
async function forceLogin(acc) {
  const res = await httpRequest({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: acc.username, password: acc.password, remember: true }
  })
  if (res.status !== 200) {
    const msg = (res.json && res.json.message) ? res.json.message : ('HTTP ' + res.status)
    const err = new Error('登录失败：' + msg)
    err.status = res.status
    err.isLogin = true
    throw err
  }
  const cookie = parseSetCookies(res)
  if (!cookie) {
    const err = new Error('登录成功但未返回会话 Cookie')
    err.isLogin = true
    throw err
  }
  const today = cstDateStr(nowCST())
  await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
    data: { cookie, lastLoginDate: today, loginErrorDate: null, updatedAt: db.serverDate() }
  }).catch(() => {})
  return cookie
}

// 获取可用会话：当天已登录则复用缓存 Cookie，否则登录一次
async function ensureSession(acc) {
  const today = cstDateStr(nowCST())
  if (acc.cookie && acc.lastLoginDate === today) return acc.cookie
  return forceLogin(acc)
}

// 会话包装：401 时自动重新登录并重试一次
async function withSession(acc, fn) {
  let cookie = await ensureSession(acc)
  try {
    return await fn(cookie)
  } catch (err) {
    if (err && err.status === 401) {
      cookie = await forceLogin(acc)
      return await fn(cookie)
    }
    throw err
  }
}

// 已持有 cookie 的会话包装（供工作循环使用，避免同一周期内重复登录）
async function ppWithRetry(acc, cookie, fn) {
  try {
    return await fn(cookie)
  } catch (err) {
    if (err && err.status === 401) {
      const fresh = await forceLogin(acc)
      return await fn(fresh)
    }
    throw err
  }
}

// 批量启动/暂停托管（enabled: true 启动 / false 暂停；gardenIds 为空表示全部花园）
async function ppBulkHosting(cookie, enabled, gardenIds) {
  const body = {
    enabled,
    operationId: uuidv4()
  }
  if (Array.isArray(gardenIds) && gardenIds.length) {
    body.gardenIds = gardenIds.slice().sort()
  }

  let res = await httpRequest({
    method: 'POST',
    path: '/api/hosting/bulk',
    body,
    cookie
  })

  // 新用户首次开启托管需确认试用条款，自动带上 trialConsent 重试一次
  if (res.status === 409 && res.json && res.json.error === 'trial_consent_required') {
    body.trialConsent = true
    res = await httpRequest({
      method: 'POST',
      path: '/api/hosting/bulk',
      body,
      cookie
    })
  }

  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) {
    const msg = (res.json && res.json.message) ? res.json.message : ('HTTP ' + res.status)
    throw new Error('托管操作失败：' + msg)
  }
  return res.json
}

// 托管总览（每个花园的托管状态）
async function ppHostingSummary(cookie) {
  const res = await httpRequest({ path: '/api/hosting-summary', cookie })
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询托管状态失败：HTTP ' + res.status)
  return res.json
}

// 查询各花园当前托管状态，返回 { gardenId: state } 映射（state 取值见 STATE_TEXT）
async function ppGardenStateMap(cookie) {
  const json = await ppHostingSummary(cookie)
  const map = {}
  for (const g of (json && json.gardens) || []) {
    map[g.gardenId] = g.state
  }
  return map
}

// ==================== 网站动态（最新动态日志） ====================
// 花园「动态」日志：GET /api/activity?gardenId=xxx&limit=n
// 返回 { gardenId, activity: [{ id, occurredAt(毫秒时间戳), summary(日志文本), detail(结构化详情) }] }
async function ppActivityList(cookie, gardenId, limit) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50)
  let path = '/api/activity?limit=' + n
  if (gardenId) path += '&gardenId=' + encodeURIComponent(gardenId)
  const res = await httpRequest({ path, cookie })
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询网站动态失败：HTTP ' + res.status)
  return res.json
}

// 东八区时间文本（MM-DD HH:mm）
function fmtCstMs(ms) {
  const d = new Date(ms + TZ_OFFSET_MS)
  return pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
}

// 把网站动态接口的返回归一化为 [{ id, timeMs, text, kind }]
function normalizeSiteActivity(json) {
  let list = []
  if (Array.isArray(json)) {
    list = json
  } else if (json && typeof json === 'object') {
    for (const key of ['activity', 'activities', 'items', 'logs', 'records', 'events', 'data', 'list']) {
      if (Array.isArray(json[key])) { list = json[key]; break }
    }
  }

  return list.map(it => {
    if (!it || typeof it !== 'object') return { id: '', timeMs: null, text: String(it), kind: '' }

    const rawTime = it.occurredAt || it.createdAt || it.created_at || it.time || it.timestamp
    let timeMs = null
    if (typeof rawTime === 'number') timeMs = rawTime < 1e12 ? rawTime * 1000 : rawTime
    else if (typeof rawTime === 'string' && rawTime) {
      const t = Date.parse(rawTime)
      if (!isNaN(t)) timeMs = t
    }

    const text = it.summary || it.message || it.text || it.content || ''
    const d = it.detail
    return {
      id: it.id == null ? '' : String(it.id),
      timeMs,
      text: String(text || (d && typeof d === 'object' ? JSON.stringify(d).slice(0, 200) : '')),
      kind: d && typeof d === 'object' ? String(d.kind || '') : ''
    }
  })
}

// 网站内添加的花园列表（仅刷新名称信息，不影响各花园的时段配置）
async function loadAndCacheGardens(acc, cookie) {
  const res = await httpRequest({ path: '/api/gardens', cookie })
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.gardens)) {
    throw new Error('加载花园列表失败：HTTP ' + res.status)
  }
  const gardens = res.json.gardens.map(g => ({
    id: g.id,
    name: (g.alias && g.alias.trim()) || g.nickname || g.gameUid || g.id,
    channel: g.channel || '',
    gameUid: g.gameUid || ''
  }))
  await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
    data: { gardenList: gardens, gardenLoadDate: cstDateStr(nowCST()), gardenListUpdatedAt: db.serverDate() }
  }).catch(() => {})
  return gardens
}

// 把 bulk 接口的 summary 转成可读文本
function summarizeBulk(json, enabled) {
  const s = (json && json.summary) || {}
  const parts = []
  if (s.started) parts.push('启动 ' + s.started)
  if (s.armed) parts.push('排队 ' + s.armed)
  if (s.scheduleWait) parts.push('等待定时 ' + s.scheduleWait)
  if (s.finishing) parts.push('收尾 ' + s.finishing)
  if (s.alreadyPaused) parts.push('已暂停 ' + s.alreadyPaused)
  if (s.blocked) parts.push('受阻 ' + s.blocked)
  if (s.failed) parts.push('失败 ' + s.failed)
  let text = parts.length ? parts.join('，') : '无变化'

  // 启动请求全部因并发位已满被拒 → 说明当前已有花园在托管中，给出友好提示
  if (enabled && s.blocked && !s.started && !s.armed) {
    const results = (json && json.results) || []
    const byConcurrency = results.some(r => r && r.status === 'blocked' && r.reason === 'concurrency_limit')
    if (byConcurrency) {
      text += '（并发托管位已满：当前已有花园在托管中）'
    }
  }
  return text
}

// ==================== 时段校验与分配 ====================
// 校验单花园时段：整数分钟 0~59、start<stop、时长≥2、互不重叠、数量上限
function validateWindows(windows) {
  if (!Array.isArray(windows) || !windows.length) return { ok: true }
  if (windows.length > MAX_WINDOWS_PER_GARDEN) {
    return { ok: false, error: '每个花园最多 ' + MAX_WINDOWS_PER_GARDEN + ' 个时段' }
  }
  const seen = []
  for (const w of windows) {
    const s = Number(w.start)
    const e = Number(w.stop)
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 59 || e - s < MIN_WINDOW_DURATION) {
      return { ok: false, error: '时段无效：分钟须为 0~59 的整数，且时长至少 ' + MIN_WINDOW_DURATION + ' 分钟' }
    }
    for (const p of seen) {
      if (s < p.stop && p.start < e) {
        return { ok: false, error: '同一花园的时段不能重叠（' + pad2(s) + '~' + pad2(e) + ' 与 ' + pad2(p.start) + '~' + pad2(p.stop) + '）' }
      }
    }
    seen.push({ start: s, stop: e })
  }
  return { ok: true }
}

// 两个时段在 0~60 分钟环上的间隔（分钟）
function circularGap(a, b) {
  const g1 = (b.start - a.stop + 60) % 60
  const g2 = (a.start - b.stop + 60) % 60
  return Math.min(g1, g2)
}

// 收集同一托管账号下其它花园已占用的时段 [{start, stop, ownerName}]（可排除某花园）
// 网站的并发托管位按账号独立计算，各托管账号相互独立，跨账号时段不构成冲突
function collectOccupied(acc, exceptGardenId) {
  const occupied = []
  if (!acc || acc.enabled === false) return occupied
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const configs = acc.gardenConfigs || {}
  for (const g of gardens) {
    if (g.id === exceptGardenId) continue
    const cfg = configs[g.id]
    if (!cfg) continue
    for (const w of (Array.isArray(cfg.windows) ? cfg.windows : [])) {
      occupied.push({ start: w.start, stop: w.stop, ownerName: g.name || g.id })
    }
  }
  return occupied
}

// 跨花园冲突检查：overlap=重叠（禁止），close=间距过近（警告）
function checkCrossConflict(occupied, windows) {
  let conflictName = null
  let minGap = Infinity
  let closeName = null
  for (const w of windows) {
    for (const o of occupied) {
      if (w.start < o.stop && o.start < w.stop) {
        if (!conflictName) conflictName = o.ownerName
      }
      const gap = circularGap(w, o)
      if (gap < minGap) {
        minGap = gap
        if (gap < MIN_CROSS_GAP_MIN) closeName = o.ownerName
      }
    }
  }
  return {
    conflictName,
    closeName,
    minGap: minGap === Infinity ? null : minGap
  }
}

// 为一个花园随机生成「每小时两个时段」：时段 4~5 分钟、间隔 25~30 分钟，
// 避开已占用时段并尽量保持安全间距。拥挤时逐步放宽间距要求。
function generateWindows(occupied) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const relax = Math.floor(attempt / 125) // 0,1,2,3
    const minCrossGap = Math.max(1, MIN_CROSS_GAP_MIN - relax)
    const gMin = Math.max(20, MIN_GAP_MIN - relax * 2)

    const d1 = randInt(MIN_WINDOW_MIN, MAX_WINDOW_MIN)
    const d2 = randInt(MIN_WINDOW_MIN, MAX_WINDOW_MIN)
    const g1 = randInt(gMin, MAX_GAP_MIN)
    const g2 = 60 - d1 - g1 - d2 // 环绕间隔（下一小时的第一个时段之前）
    if (g2 < gMin || g2 > MAX_GAP_MIN) continue

    const s1 = randInt(0, 59 - d1)
    const s2 = (s1 + d1 + g1) % 60
    if (s2 + d2 > 59) continue

    const w1 = { start: s1, stop: s1 + d1 }
    const w2 = { start: s2, stop: s2 + d2 }

    let ok = true
    let minGapSeen = Infinity
    for (const w of [w1, w2]) {
      for (const o of occupied) {
        if (w.start < o.stop && o.start < w.stop) { ok = false; break } // 重叠
        const gap = circularGap(w, o)
        if (gap < minGapSeen) minGapSeen = gap
      }
      if (!ok) break
    }
    if (!ok) continue
    if (minGapSeen < minCrossGap) continue
    return [w1, w2]
  }
  return null
}

// ==================== 工作循环 ====================
// 同一账号下其它花园是否正在托管：时段覆盖当前分钟、本小时已执行过启动、且尚未执行暂停
// （并发托管位按账号独立计算，只需检查同一账号内的其它花园）
function isPeerHosting(acc, exceptGardenId, minuteOfHour, hourSlot) {
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const configs = acc.gardenConfigs || {}
  return gardens.some(g => {
    if (g.id === exceptGardenId) return false
    const cfg = configs[g.id]
    if (!cfg || cfg.schedEnabled === false) return false
    const wins = Array.isArray(cfg.windows) ? cfg.windows : []
    return wins.some((w, wi) => {
      if (!(minuteOfHour >= w.start && minuteOfHour <= w.stop)) return false
      const key = g.id + '_' + wi
      const started = (acc.doneStart || {})[key] === hourSlot
      const stopped = (acc.doneStop || {})[key] === hourSlot
      return started && !stopped
    })
  })
}

// 记录某花园某时段本小时已完成（每小时去重）
async function markSlotDone(acc, field, key, hourSlot) {
  try {
    await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
      data: { [field + '.' + key]: hourSlot }
    })
  } catch (e) {
    // 兜底：整体写对象
    const obj = Object.assign({}, acc[field] || {})
    obj[key] = hourSlot
    await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
      data: { [field]: obj }
    }).catch(() => {})
  }
}

// 执行一次某花园的启动/暂停并写日志
async function executeGardenAction(acc, garden, action, wi, w, cookie, ctx, hourSlot) {
  const enabled = action === 'start'
  const actionText = enabled ? '启动托管' : '暂停托管'
  const slotText = '花园「' + garden.name + '」' + pad2(w.start) + '~' + pad2(w.stop) + '分'
  const key = garden.id + '_' + wi
  try {
    const json = await ppWithRetry(acc, cookie, c => ppBulkHosting(c, enabled, [garden.id]))
    const message = actionText + '完成：' + summarizeBulk(json, enabled) + ' [' + slotText + ']'

    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId: garden.id,
      gardenName: garden.name || '',
      action,
      trigger: 'timer',
      success: true,
      message,
      detail: (json && json.summary) || null,
      createdAt: db.serverDate()
    })

    // 先同步内存快照（同轮后续花园的冲突守卫需要看到），再写库
    const memField = enabled ? 'doneStart' : 'doneStop'
    if (!acc[memField] || typeof acc[memField] !== 'object') acc[memField] = {}
    acc[memField][key] = hourSlot
    await markSlotDone(acc, memField, key, hourSlot)

    // 定时暂停了手动启动的花园 → 清除自动暂停标记，避免到点重复暂停
    if (!enabled && acc.manualStart && acc.manualStart.gardenId === garden.id) {
      acc.manualStart = null
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { manualStart: null }
      }).catch(() => {})
    }

    ctx.results.push({
      username: acc.username,
      remark: acc.remark || '',
      gardenName: garden.name || '',
      action,
      success: true,
      message
    })
    console.log('[PPGarden] ' + (acc.remark || acc.username) + ' ' + message)
  } catch (err) {
    const message = actionText + '失败：' + (err.message || '未知错误') + ' [' + slotText + ']'
    console.error('[PPGarden] ' + (acc.remark || acc.username) + ' ' + message)
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId: garden.id,
      gardenName: garden.name || '',
      action,
      trigger: 'timer',
      success: false,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    ctx.results.push({
      username: acc.username,
      remark: acc.remark || '',
      gardenName: garden.name || '',
      action,
      success: false,
      message
    })
  }
}

// 处理单个账号：确保会话 → 加载花园 → 按各花园时段执行启动/暂停
async function processAccount(acc, ctx) {
  const { today, nowC, results } = ctx
  const minuteOfHour = nowC.getUTCMinutes()
  const hourSlot = hourSlotOf(nowC)

  // 1. 会话：每天登录一次
  let cookie
  try {
    cookie = await ensureSession(acc)
  } catch (err) {
    // 登录失败每天只记一次日志，避免每分钟刷屏
    if (acc.loginErrorDate !== today) {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { loginErrorDate: today }
      }).catch(() => {})
      await saveLog({
        accountId: acc._id,
        username: acc.username,
        remark: acc.remark || '',
        action: 'login',
        trigger: 'timer',
        success: false,
        message: err.message || '登录失败',
        detail: null,
        createdAt: db.serverDate()
      })
    }
    results.push({
      username: acc.username,
      remark: acc.remark || '',
      action: 'login',
      success: false,
      message: err.message || '登录失败'
    })
    return
  }

  // 2. 每天首次登录后加载网站内花园列表（仅名称缓存，时段配置在 gardenConfigs 不受影响）
  const needLoadGardens = acc.lastLoginDate !== today ||
    (!Array.isArray(acc.gardenList) || !acc.gardenList.length) && acc.gardenLoadDate !== today
  if (needLoadGardens) {
    try {
      await ppWithRetry(acc, cookie, c => loadAndCacheGardens(acc, c))
    } catch (e) {
      console.error('[PPGarden] 加载花园列表失败:', acc.username, e.message)
      // 失败也记录尝试日期，避免当天每分钟重试；需要时可在管理页手动刷新
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { gardenLoadDate: today }
      }).catch(() => {})
    }
  }

  // 3. 每花园每小时时段任务（先统一处理暂停，再处理启动，减少撞车窗口）
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const configs = acc.gardenConfigs || {}
  const activeGardens = gardens
    .map(g => ({ g, cfg: configs[g.id] }))
    .filter(x => x.cfg && x.cfg.schedEnabled !== false && Array.isArray(x.cfg.windows) && x.cfg.windows.length)

  if (!activeGardens.length) return { cookie }

  // 收集本分钟到期的启停任务
  const duePauses = []
  const dueStarts = []
  for (const { g, cfg } of activeGardens) {
    for (let wi = 0; wi < cfg.windows.length; wi++) {
      const w = cfg.windows[wi]
      const key = g.id + '_' + wi
      if ((acc.doneStop || {})[key] !== hourSlot &&
          minuteOfHour >= w.stop && minuteOfHour < w.stop + STOP_TOLERANCE_MIN) {
        duePauses.push({ g, wi, w, key })
      }
      if ((acc.doneStart || {})[key] !== hourSlot &&
          minuteOfHour >= w.start && minuteOfHour < w.start + START_TOLERANCE_MIN) {
        dueStarts.push({ g, wi, w, key })
      }
    }
  }

  // 有到期任务时先查一次实际托管状态：已处于目标状态的操作直接跳过，不再调用启停接口
  let stateMap = null
  if (duePauses.length || dueStarts.length) {
    try {
      stateMap = await ppWithRetry(acc, cookie, c => ppGardenStateMap(c))
    } catch (e) {
      console.error('[PPGarden] 查询托管状态失败，将直接执行启停:', acc.username, e.message)
    }
  }

  // 先统一处理暂停：实际已是暂停状态（如本小时启动未执行/未成功）则只做标记，不调接口
  for (const { g, wi, w, key } of duePauses) {
    if (stateMap && stateMap[g.id] === 'paused') {
      console.log('[PPGarden] 花园已是暂停状态，跳过暂停:', acc.username, g.name)
      if (!acc.doneStop || typeof acc.doneStop !== 'object') acc.doneStop = {}
      acc.doneStop[key] = hourSlot
      await markSlotDone(acc, 'doneStop', key, hourSlot)
      continue
    }
    await executeGardenAction(acc, g, 'pause', wi, w, cookie, ctx, hourSlot)
  }
  // 再处理启动：实际已在托管/排队中（受阻除外）则只做标记，不调接口
  for (const { g, wi, w, key } of dueStarts) {
    // 运行时守卫：同一账号下其它花园本小时已在其时段内启动且尚未暂停 → 本次跳过，下分钟重试
    if (isPeerHosting(acc, g.id, minuteOfHour, hourSlot)) {
      console.log('[PPGarden] 同账号其它花园托管进行中，本次跳过启动:', acc.username, g.name)
      continue
    }
    const curState = stateMap ? stateMap[g.id] : null
    if (curState && curState !== 'paused' && curState !== 'blocked') {
      console.log('[PPGarden] 花园已在托管中，跳过启动:', acc.username, g.name, curState)
      if (!acc.doneStart || typeof acc.doneStart !== 'object') acc.doneStart = {}
      acc.doneStart[key] = hourSlot
      await markSlotDone(acc, 'doneStart', key, hourSlot)
      continue
    }
    await executeGardenAction(acc, g, 'start', wi, w, cookie, ctx, hourSlot)
  }

  return { cookie }
}

// ==================== 手动启动自动暂停 ====================
// 遍历账号，把手动启动且已运行超过 MANUAL_RUN_MINUTES 分钟的花园暂停（由每分钟定时器调用）
async function autoPauseExpiredManualStarts(accounts) {
  const results = []
  const now = Date.now()
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    const ms = acc.manualStart
    if (!ms || !ms.gardenId || !ms.startAtMs) continue
    const startAt = Number(ms.startAtMs) || 0
    if (!startAt || now - startAt < MANUAL_RUN_MINUTES * 60 * 1000) continue

    const name = ms.gardenName || gardenNameOf(acc, ms.gardenId) || '花园'
    const runMinutes = Math.round((now - startAt) / 60000)

    let success = true
    let message = ''
    try {
      // 先查实际状态：已是暂停状态则无需再调接口，直接清除标记
      const stateMap = await withSession(acc, c => ppGardenStateMap(c))
      if (stateMap[ms.gardenId] === 'paused') {
        message = '手动启动的花园「' + name + '」已是暂停状态，无需自动暂停'
      } else {
        const json = await withSession(acc, c => ppBulkHosting(c, false, [ms.gardenId]))
        message = '手动启动的花园「' + name + '」已运行 ' + runMinutes + ' 分钟，自动暂停完成：' + summarizeBulk(json, false)
      }
    } catch (err) {
      success = false
      message = '手动启动的花园「' + name + '」自动暂停失败：' + (err.message || '未知错误')
    }

    console.log('[PPGarden] ' + (acc.remark || acc.username) + ' ' + message)
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId: ms.gardenId,
      gardenName: name,
      action: 'pause',
      trigger: 'auto',
      success,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    results.push({
      username: acc.username,
      remark: acc.remark || '',
      gardenName: name,
      action: 'pause',
      success,
      message
    })

    // 失败时保留标记下一分钟重试，连续 3 次失败则放弃并清除标记
    const retries = (ms.retries || 0) + (success ? 0 : 1)
    if (success || retries >= 3) {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { manualStart: null, updatedAt: db.serverDate() }
      }).catch(() => {})
    } else {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { 'manualStart.retries': retries }
      }).catch(() => {})
    }
  }
  return results
}

// 一次工作循环：遍历所有启用账号（可传入已加载的账号列表避免重复读取）
async function runCycle(preloadedAccounts) {
  const nowC = nowCST()
  const today = cstDateStr(nowC)

  let accounts = preloadedAccounts
  if (!accounts) {
    try {
      accounts = await getAllDocs(ACCOUNTS_COLL)
    } catch (e) {
      console.error('[PPGarden] 读取账号集合失败:', e.message)
      return []
    }
  }

  const results = []
  const ctx = { today, nowC, results }
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    try {
      await processAccount(acc, ctx)
    } catch (err) {
      console.error('[PPGarden] 账号处理异常:', acc.username, err.message)
    }
  }

  // 顺带清理过期日志（每小时整点执行一次即可）
  if (nowC.getUTCMinutes() === 0) {
    try {
      await db.collection(LOGS_COLL).where({
        createdAt: _.lt(new Date(Date.now() - LOG_RETENTION_DAYS * 86400 * 1000))
      }).remove()
    } catch (e) {
      // 清理失败不影响主流程
    }
  }

  return results
}

// 定时触发入口：每分钟一次，按分钟匹配各花园时段任务
async function handleTimerTick() {
  await ensureCollections()
  const state = await ensureGlobalState()

  // 先加载账号：手动启动的自动暂停检查不受总开关影响
  let accounts = null
  try {
    accounts = await getAllDocs(ACCOUNTS_COLL)
  } catch (e) {
    console.error('[PPGarden] 读取账号集合失败:', e.message)
  }
  const autoResults = await autoPauseExpiredManualStarts(accounts || [])

  if (state.masterEnabled === false) {
    return { skipped: 'master_disabled', results: autoResults }
  }

  const results = await runCycle(accounts)
  return { results: autoResults.concat(results) }
}

// ==================== 手动操作处理 ====================
function maskAccount(acc) {
  return {
    _id: acc._id,
    username: acc.username,
    remark: acc.remark || '',
    enabled: acc.enabled !== false,
    gardenList: Array.isArray(acc.gardenList) ? acc.gardenList : [],
    gardenConfigs: acc.gardenConfigs || {},
    lastLoginDate: acc.lastLoginDate || null,
    loginErrorDate: acc.loginErrorDate || null,
    hostingCache: acc.hostingCache || null,
    createdAt: acc.createdAt || null
  }
}

async function handleList() {
  await ensureCollections()
  const accounts = await getAllDocs(ACCOUNTS_COLL)
  const state = await ensureGlobalState()
  const list = accounts.map(maskAccount)
  for (const item of list) {
    if (item.hostingCache && item.hostingCache.updatedAt) {
      item.hostingCache.updatedAtMs = new Date(item.hostingCache.updatedAt).getTime()
    }
  }
  list.sort((a, b) => (a.remark || a.username).localeCompare(b.remark || b.username))
  return {
    code: 0,
    message: 'success',
    data: {
      masterEnabled: state.masterEnabled !== false,
      accounts: list
    }
  }
}

async function handleAdd(event) {
  await ensureCollections()

  const username = (event.username || '').trim()
  const password = (event.password || '').trim()
  const remark = (event.remark || '').trim()

  if (!username || !password) {
    return { code: 400, message: '账号和密码不能为空' }
  }

  const dup = await db.collection(ACCOUNTS_COLL).where({ username }).count()
  if (dup.total > 0) {
    return { code: 400, message: '该账号已存在' }
  }

  const addRes = await db.collection(ACCOUNTS_COLL).add({
    data: {
      username,
      password,
      remark,
      enabled: true,
      // 会话与花园数据（时段配置按花园存放在 gardenConfigs）
      cookie: '',
      lastLoginDate: null,
      loginErrorDate: null,
      gardenList: [],
      gardenLoadDate: null,
      gardenConfigs: {},
      hostingCache: null,
      // 手动启动自动暂停标记 { gardenId, gardenName, startAtMs, retries }
      manualStart: null,
      // 每小时去重标记（key = gardenId_时段序号）
      doneStart: {},
      doneStop: {},
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })

  return {
    code: 0,
    message: '添加成功，请在卡片中加载花园并为每个花园配置每小时时段',
    data: { _id: addRes._id }
  }
}

async function handleUpdate(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  const update = { updatedAt: db.serverDate() }
  if (event.username !== undefined) update.username = String(event.username).trim()
  if (event.password) {
    // 密码变更后旧会话作废，强制重新登录
    update.password = String(event.password).trim()
    update.cookie = ''
    update.lastLoginDate = null
  }
  if (event.remark !== undefined) update.remark = String(event.remark).trim()

  await db.collection(ACCOUNTS_COLL).doc(_id).update({ data: update })
  return { code: 0, message: '保存成功' }
}

async function handleDelete(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }
  await db.collection(ACCOUNTS_COLL).doc(_id).remove()
  return { code: 0, message: '删除成功' }
}

// 全局定时任务总开关（停止/恢复定时启停）
async function handleSetMaster(event) {
  const enabled = !!event.enabled
  await ensureCollections()
  await ensureGlobalState()
  await db.collection(STATE_COLL).doc(STATE_DOC_ID).update({
    data: { masterEnabled: enabled, updatedAt: db.serverDate() }
  })
  return { code: 0, message: enabled ? '定时任务已开启' : '定时任务已停止' }
}

// 加载网站内添加的花园列表（登录成功后调用；不影响各花园已配置的时段）
async function handleLoadGardens(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const gardens = await withSession(acc, c => loadAndCacheGardens(acc, c))
    return { code: 0, message: '已加载 ' + gardens.length + ' 个花园', data: { gardens } }
  } catch (err) {
    return { code: 500, message: err.message || '加载花园列表失败' }
  }
}

// 保存单个花园的配置：每小时时段 / 定时开关
async function handleSetGardenConfig(event) {
  const _id = event._id
  const gardenId = event.gardenId
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const configs = Object.assign({}, acc.gardenConfigs || {})
  const cfg = Object.assign({ windows: [], schedEnabled: false }, configs[gardenId] || {})

  let warning = ''
  if (event.windows !== undefined) {
    const windows = Array.isArray(event.windows)
      ? event.windows.map(w => ({ start: Number(w.start), stop: Number(w.stop) }))
      : []

    if (windows.length) {
      const v = validateWindows(windows)
      if (!v.ok) return { code: 400, message: v.error }
      // 与同一账号下其它花园的时段查重叠（各账号独立，跨账号不冲突）
      const occupied = collectOccupied(acc, gardenId)
      const c = checkCrossConflict(occupied, windows)
      if (c.conflictName) {
        return { code: 400, message: '时段与本账号花园「' + c.conflictName + '」重叠，同一账号同一时间只能托管一个花园，请错开' }
      }
      if (c.closeName) {
        warning = '（提示：与花园「' + c.closeName + '」的时段仅隔 ' + (c.minGap === null ? '-' : c.minGap) + ' 分钟，建议再错开一些）'
      }
    }

    cfg.windows = windows
    // 时段变化后清空本小时完成标记，避免旧标记阻塞新时段
    configs[gardenId] = cfg
    await db.collection(ACCOUNTS_COLL).doc(_id).update({
      data: {
        gardenConfigs: configs,
        doneStart: {},
        doneStop: {},
        updatedAt: db.serverDate()
      }
    })

    return {
      code: 0,
      message: windows.length
        ? '花园「' + (gardenNameOf(acc, gardenId) || '花园') + '」时段已保存：每小时 ' + windowsText(windows) + ' 分' + warning
        : '花园时段已清空，该花园将不参与定时托管' + warning
    }
  }

  if (event.schedEnabled !== undefined) {
    cfg.schedEnabled = !!event.schedEnabled
    configs[gardenId] = cfg
    await db.collection(ACCOUNTS_COLL).doc(_id).update({
      data: { gardenConfigs: configs, updatedAt: db.serverDate() }
    })
    const name = gardenNameOf(acc, gardenId) || '花园'
    return {
      code: 0,
      message: '花园「' + name + '」定时托管已' + (cfg.schedEnabled ? '开启' : '关闭')
    }
  }

  return { code: 400, message: '未指定要修改的配置项' }
}

function gardenNameOf(acc, gardenId) {
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const g = gardens.find(x => x.id === gardenId)
  return g ? g.name : ''
}

// 一键为账号下全部花园随机错峰分配每小时时段
async function handleAutoAssignAll(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  if (!gardens.length) {
    return { code: 400, message: '尚未加载花园列表，请先点击「刷新花园」从网站获取' }
  }

  // 已占用时段：本账号其它花园（本账号全部花园重新分配；各账号独立，跨账号不冲突）
  const occupied = collectOccupied(acc, null)

  const configs = Object.assign({}, acc.gardenConfigs || {})
  const assigned = []
  for (const g of gardens) {
    const w = generateWindows(occupied)
    if (!w) {
      return { code: 400, message: '花园较多，每小时 60 分钟放不下所有时段。可手动为部分花园设置更短的时段（最少 ' + MIN_WINDOW_DURATION + ' 分钟），或减少参与轮换的花园数量' }
    }
    const cfg = Object.assign({ schedEnabled: true }, configs[g.id] || {})
    cfg.windows = w
    cfg.schedEnabled = true
    configs[g.id] = cfg
    assigned.push('「' + (g.name || g.id) + '」' + windowsText(w))
    for (const x of w) occupied.push({ start: x.start, stop: x.stop, ownerName: g.name || g.id })
  }

  await db.collection(ACCOUNTS_COLL).doc(_id).update({
    data: {
      gardenConfigs: configs,
      doneStart: {},
      doneStop: {},
      updatedAt: db.serverDate()
    }
  })

  return {
    code: 0,
    message: '已为 ' + gardens.length + ' 个花园分配时段并开启定时：\n' + assigned.join('\n'),
    data: { gardenConfigs: configs }
  }
}

// 手动启动某个花园：暂停其它在托花园腾出托管位后启动指定花园
// （先查实际托管状态：目标已在托管中则不重复启动，只暂停确实非暂停状态的花园）
async function handleStartGarden(event) {
  const _id = event._id
  const gardenId = event.gardenId
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const name = gardenNameOf(acc, gardenId) || '花园'
  try {
    const result = await withSession(acc, async c => {
      // 先查实际托管状态，避免冗余启停调用
      let stateMap = null
      try {
        stateMap = await ppGardenStateMap(c)
      } catch (e) {
        stateMap = null // 状态未知时退回「暂停全部」的原逻辑
      }

      // 暂停其它在托花园，腾出唯一托管位（并发位=1）；只暂停确实非暂停状态的花园
      if (stateMap) {
        const busyOthers = Object.keys(stateMap).filter(id => id !== gardenId && stateMap[id] !== 'paused')
        if (busyOthers.length) await ppBulkHosting(c, false, busyOthers)
      } else {
        // 状态查询失败：暂停全部花园兜底（避免 concurrency_limit 受阻）
        await ppBulkHosting(c, false)
      }

      // 目标花园已在托管中（受阻状态除外）→ 不再重复启动
      const targetState = stateMap ? stateMap[gardenId] : null
      if (targetState && targetState !== 'paused' && targetState !== 'blocked') {
        return { alreadyActive: true, json: null }
      }
      const json = await ppBulkHosting(c, true, [gardenId])
      return { alreadyActive: false, json }
    })

    // 已在托管中：不重复调用启动，仅重置自动暂停计时
    if (result.alreadyActive) {
      const message = '花园「' + name + '」已在托管中，无需重复启动'
      await saveLog({
        accountId: acc._id,
        username: acc.username,
        remark: acc.remark || '',
        gardenId,
        gardenName: name,
        action: 'start',
        trigger: 'manual',
        success: true,
        message,
        detail: null,
        createdAt: db.serverDate()
      })
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: {
          manualStart: { gardenId, gardenName: name, startAtMs: Date.now(), retries: 0 },
          updatedAt: db.serverDate()
        }
      }).catch(() => {})
      return { code: 0, message }
    }

    const json = result.json
    const message = '启动花园「' + name + '」完成：' + summarizeBulk(json, true) + '，' + MANUAL_RUN_MINUTES + ' 分钟后自动暂停'

    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'start',
      trigger: 'manual',
      success: true,
      message,
      detail: (json && json.summary) || null,
      createdAt: db.serverDate()
    })

    // 记录手动启动时间，由每分钟定时器在到期后自动暂停
    await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
      data: {
        manualStart: { gardenId, gardenName: name, startAtMs: Date.now(), retries: 0 },
        updatedAt: db.serverDate()
      }
    }).catch(() => {})

    return {
      code: 0,
      message,
      data: { summary: (json && json.summary) || null, results: (json && json.results) || [] }
    }
  } catch (err) {
    const message = '启动花园「' + name + '」失败：' + (err.message || '未知错误')
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'start',
      trigger: 'manual',
      success: false,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    return { code: 500, message }
  }
}

// 手动暂停某个花园
async function handlePauseGarden(event) {
  const _id = event._id
  const gardenId = event.gardenId
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const name = gardenNameOf(acc, gardenId) || '花园'
  try {
    let skipped = false
    const json = await withSession(acc, async c => {
      // 先查实际状态：已是暂停状态则无需再调接口
      let stateMap = null
      try {
        stateMap = await ppGardenStateMap(c)
      } catch (e) {
        stateMap = null
      }
      if (stateMap && stateMap[gardenId] === 'paused') {
        skipped = true
        return null
      }
      return ppBulkHosting(c, false, [gardenId])
    })
    const message = skipped
      ? '花园「' + name + '」已是暂停状态，无需操作'
      : '暂停花园「' + name + '」完成：' + summarizeBulk(json, false)

    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'pause',
      trigger: 'manual',
      success: true,
      message,
      detail: (json && json.summary) || null,
      createdAt: db.serverDate()
    })

    // 手动暂停后清除自动暂停标记
    if (acc.manualStart && acc.manualStart.gardenId === gardenId) {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { manualStart: null, updatedAt: db.serverDate() }
      }).catch(() => {})
    }

    return {
      code: 0,
      message,
      data: { summary: (json && json.summary) || null, results: (json && json.results) || [] }
    }
  } catch (err) {
    const message = '暂停花园「' + name + '」失败：' + (err.message || '未知错误')
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'pause',
      trigger: 'manual',
      success: false,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    return { code: 500, message }
  }
}

// 查询账号当前托管状态（复用缓存会话），并更新缓存
async function handleStatus(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const summary = await withSession(acc, c => ppHostingSummary(c))

    // 花园名称映射：优先用缓存的 gardenList，没有则现场拉取
    let nameMap = {}
    if (Array.isArray(acc.gardenList) && acc.gardenList.length) {
      for (const g of acc.gardenList) nameMap[g.id] = g.name
    } else {
      try {
        const gardens = await withSession(acc, c => loadAndCacheGardens(acc, c))
        for (const g of gardens) nameMap[g.id] = g.name
      } catch (e) { /* ignore */ }
    }

    const items = (summary.gardens || []).map(g => ({
      gardenId: g.gardenId,
      name: nameMap[g.gardenId] || ('花园' + String(g.gardenId).slice(0, 8)),
      state: g.state,
      stateText: (STATE_TEXT[g.state] || g.state) + (g.credentialExpired ? '(凭证过期)' : '')
    }))

    const counts = summary.counts || {}
    const countParts = []
    if (counts.running) countParts.push('运行中 ' + counts.running)
    if (counts.managed) countParts.push('托管中 ' + counts.managed)
    if (counts.armed) countParts.push('已就绪 ' + counts.armed)
    if (counts.scheduleWait) countParts.push('等待定时 ' + counts.scheduleWait)
    if (counts.finishing) countParts.push('收尾 ' + counts.finishing)
    if (counts.paused) countParts.push('已暂停 ' + counts.paused)
    if (counts.blocked) countParts.push('受阻 ' + counts.blocked)
    const summaryText = '共 ' + (summary.total || items.length) + ' 个花园' + (countParts.length ? '：' + countParts.join('，') : '')

    // 更新缓存（含逐花园状态，供管理页直接展示）
    await db.collection(ACCOUNTS_COLL).doc(_id).update({
      data: {
        hostingCache: {
          total: summary.total || 0,
          summaryText,
          counts,
          states: items,
          updatedAt: db.serverDate()
        }
      }
    }).catch(() => {})

    return {
      code: 0,
      message: 'success',
      data: {
        total: summary.total || items.length,
        summaryText,
        gardens: items,
        serverTime: summary.serverTime || null
      }
    }
  } catch (err) {
    console.error('[PPGarden] 查询状态失败:', err.message)
    return { code: 500, message: err.message || '查询状态失败' }
  }
}

async function handleLogs(event) {
  await ensureCollections()
  const limit = Math.min(Number(event.limit) || 50, 100)
  const res = await db.collection(LOGS_COLL)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()

  const logs = (res.data || []).map(l => ({
    _id: l._id,
    username: l.username,
    remark: l.remark || '',
    gardenName: l.gardenName || '',
    action: l.action,
    trigger: l.trigger,
    success: l.success,
    message: l.message,
    createdAtMs: l.createdAt ? new Date(l.createdAt).getTime() : null
  }))

  return { code: 0, message: 'success', data: { logs } }
}

// 汇总所有账号当前正在托管（非暂停）的花园
const HOSTING_ACTIVE_STATES = ['running', 'managed', 'finishing']

async function handleHostingNow() {
  await ensureCollections()
  const accounts = await getAllDocs(ACCOUNTS_COLL)
  const hosting = [] // 正在托管
  const waiting = [] // 其它状态（已就绪/等待定时/受阻）
  const errors = []

  for (const acc of accounts) {
    if (acc.enabled === false) continue
    try {
      const summary = await withSession(acc, c => ppHostingSummary(c))
      let nameMap = {}
      if (Array.isArray(acc.gardenList) && acc.gardenList.length) {
        for (const g of acc.gardenList) nameMap[g.id] = g.name
      }
      for (const g of (summary.gardens || [])) {
        if (g.state === 'paused') continue
        const item = {
          accountId: acc._id,
          accountName: acc.remark || acc.username,
          gardenId: g.gardenId,
          gardenName: nameMap[g.gardenId] || ('花园' + String(g.gardenId).slice(0, 8)),
          state: g.state,
          stateText: (STATE_TEXT[g.state] || g.state) + (g.credentialExpired ? '(凭证过期)' : ''),
          active: HOSTING_ACTIVE_STATES.includes(g.state),
          busyPause: false
        }
        if (item.active) hosting.push(item)
        else waiting.push(item)
      }
    } catch (err) {
      errors.push({
        accountName: acc.remark || acc.username,
        message: err.message || '查询失败'
      })
    }
  }

  return {
    code: 0,
    message: 'success',
    data: { hosting, waiting, errors }
  }
}

// 正在托管面板：按账号聚合（花园托管状态 + 执行日志首页）
async function handleAccountPanel(event) {
  await ensureCollections()
  const logsLimit = Math.min(Math.max(Number(event.logsLimit) || 10, 1), 50)
  const accounts = await getAllDocs(ACCOUNTS_COLL)

  const out = []
  const errors = []
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    const item = {
      accountId: acc._id,
      accountName: acc.remark || acc.username,
      activeCount: 0,
      logs: [],
      logsComplete: false
    }
    // 该账号正在托管的花园数（用于「托管中」标记与日志动态刷新）
    try {
      const summary = await withSession(acc, c => ppHostingSummary(c))
      item.activeCount = (summary.gardens || []).filter(g => HOSTING_ACTIVE_STATES.includes(g.state)).length
    } catch (err) {
      errors.push({ accountId: acc._id, accountName: item.accountName, message: err.message || '查询失败' })
    }

    // 该账号执行日志（首页）
    try {
      const page = await loadAccountLogs(acc._id, 0, logsLimit)
      item.logs = page.logs
      item.logsComplete = page.complete
    } catch (e) { /* 日志读取失败不影响状态展示 */ }

    out.push(item)
  }

  // 有活跃花园的账号排前面，其余按名称排序
  out.sort((a, b) => {
    const aa = a.activeCount > 0 ? 0 : 1
    const bb = b.activeCount > 0 ? 0 : 1
    if (aa !== bb) return aa - bb
    return a.accountName.localeCompare(b.accountName)
  })

  return { code: 0, message: 'success', data: { accounts: out, errors } }
}

// 读取某账号执行日志（按时间倒序分页；beforeMs 向更早翻页，afterMs 拉取更新）
async function loadAccountLogs(accountId, beforeMs, limit, afterMs) {
  let cond = { accountId }
  if (beforeMs > 0) cond.createdAt = _.lt(new Date(beforeMs))
  else if (afterMs > 0) cond.createdAt = _.gt(new Date(afterMs))
  const res = await db.collection(LOGS_COLL)
    .where(cond)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1)
    .get()
  const rows = (res.data || []).slice(0, limit)
  return {
    logs: rows.map(l => ({
      id: l._id,
      ts: l.createdAt ? new Date(l.createdAt).getTime() : 0,
      timeText: l.createdAt ? fmtCstMs(new Date(l.createdAt).getTime()) : '',
      actionText: l.action === 'start' ? '启动托管' : l.action === 'pause' ? '暂停托管' : '登录',
      triggerText: l.trigger === 'timer' ? '定时' : l.trigger === 'auto' ? '自动暂停' : l.trigger === 'redeem' ? '兑换码' : '手动',
      success: !!l.success,
      message: l.message || ''
    })),
    complete: (res.data || []).length <= limit
  }
}

// 分页加载某账号更早的执行日志
async function handleAccountLogs(event) {
  const accountId = event.accountId
  if (!accountId) return { code: 400, message: '缺少 accountId' }
  await ensureCollections()
  const limit = Math.min(Math.max(Number(event.limit) || 10, 1), 50)
  const beforeMs = Number(event.before) || 0
  const afterMs = Number(event.after) || 0
  try {
    const page = await loadAccountLogs(accountId, beforeMs, limit, afterMs)
    return { code: 0, message: 'success', data: page }
  } catch (err) {
    return { code: 500, message: err.message || '加载日志失败' }
  }
}

// 汇总所有账号「正在托管」花园的动态日志（网站动态接口按花园查询，先取托管状态再逐花园拉取）
async function handleSiteActivity(event) {
  await ensureCollections()
  const limit = Math.min(Number(event.limit) || 30, 100)
  const perGarden = Math.min(Number(event.perGarden) || 10, 20)
  const accounts = await getAllDocs(ACCOUNTS_COLL)

  const items = []
  const errors = []
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    let stateMap = null
    try {
      stateMap = await withSession(acc, c => ppGardenStateMap(c))
    } catch (err) {
      errors.push({ accountName: acc.remark || acc.username, message: err.message || '查询失败' })
      continue
    }
    // 只拉非暂停状态花园的动态（通常并发位=1，每账号最多 1 个）
    const activeIds = Object.keys(stateMap).filter(id => stateMap[id] && stateMap[id] !== 'paused').slice(0, 3)
    for (const gid of activeIds) {
      try {
        const json = await withSession(acc, c => ppActivityList(c, gid, perGarden))
        for (const it of normalizeSiteActivity(json)) {
          items.push(Object.assign({}, it, {
            accountName: acc.remark || acc.username,
            gardenName: gardenNameOf(acc, gid) || ('花园' + String(gid).slice(0, 8))
          }))
        }
      } catch (e) { /* 单花园失败不影响其它 */ }
    }
  }

  items.sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0))
  const trimmed = items.slice(0, limit)
  trimmed.forEach((it, i) => {
    it.idx = i
    it.timeText = it.timeMs ? fmtCstMs(it.timeMs) : ''
  })

  return { code: 0, message: 'success', data: { items: trimmed, errors } }
}

// 单个花园的网站「动态」日志（管理页「日志」按钮底部弹窗用）
async function handleGardenActivity(event) {
  const _id = event._id
  const gardenId = event.gardenId
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const limit = Math.min(Number(event.limit) || 20, 50)
    const json = await withSession(acc, c => ppActivityList(c, gardenId, limit))
    const items = normalizeSiteActivity(json)
    items.forEach((it, i) => {
      it.idx = i
      it.timeText = it.timeMs ? fmtCstMs(it.timeMs) : ''
    })
    return { code: 0, message: 'success', data: { items } }
  } catch (err) {
    return { code: 500, message: err.message || '查询动态失败' }
  }
}

// ==================== 入口 ====================
exports.main = async (event, context) => {
  // ===== 定时触发器模式（每分钟唤醒，按花园时段调度） =====
  if (event.Type === 'Timer' || event.TriggerName === TIMER_NAME) {
    try {
      const r = await handleTimerTick()
      if (r.skipped) {
        console.log('[PPGarden] 跳过:', r.skipped)
      } else if (r.results && r.results.length) {
        console.log('[PPGarden] 本次执行:', JSON.stringify(r.results))
      }
      return { code: 0, message: 'ok', data: r }
    } catch (err) {
      console.error('[PPGarden] 定时任务失败:', err)
      return { code: 500, message: err.message || '定时任务执行失败' }
    }
  }

  // ===== 手动调用模式（管理端，需授权） =====
  const auth = requireAuth(event)
  if (!auth.success) {
    return { code: 401, message: '未授权，请先登录' }
  }

  const action = event.action

  try {
    switch (action) {
      case 'list':
        return await handleList()
      case 'add':
        return await handleAdd(event)
      case 'update':
        return await handleUpdate(event)
      case 'delete':
        return await handleDelete(event)
      case 'setMaster':
        return await handleSetMaster(event)
      case 'loadGardens':
        return await handleLoadGardens(event)
      case 'setGardenConfig':
        return await handleSetGardenConfig(event)
      case 'autoAssignAll':
        return await handleAutoAssignAll(event)
      case 'startGarden':
        return await handleStartGarden(event)
      case 'pauseGarden':
        return await handlePauseGarden(event)
      case 'status':
        return await handleStatus(event)
      case 'hostingNow':
        return await handleHostingNow()
      case 'accountPanel':
        return await handleAccountPanel(event)
      case 'accountLogs':
        return await handleAccountLogs(event)
      case 'siteActivity':
        return await handleSiteActivity(event)
      case 'gardenActivity':
        return await handleGardenActivity(event)
      case 'logs':
        return await handleLogs(event)
      case 'runSchedule': {
        // 手动触发一次工作循环（调试用）
        await ensureCollections()
        const results = await runCycle()
        return { code: 0, message: '执行完成，共处理 ' + results.length + ' 项', data: results }
      }
      default:
        return { code: 400, message: '不支持的操作: ' + action }
    }
  } catch (err) {
    console.error('[PPGarden] 操作 ' + action + ' 失败:', err)
    return { code: 500, message: err.message || '操作失败' }
  }
}
