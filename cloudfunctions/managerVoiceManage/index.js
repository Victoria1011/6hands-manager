// 云函数入口文件
const cloud = require('wx-server-sdk')
const https = require('https')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// 云函数端单次查询批量大小（云函数端 limit 上限为 1000，此处取较保守值避免单次返回体过大）
const DB_BATCH_SIZE = 100

/**
 * 获取集合的全部文档（先 count 再并发分页拉取）
 * 相比逐页串行查询：1) 不会因默认 limit 漏数据；2) 多页并发，速度大幅提升
 * @param {String} collectionName - 集合名
 * @returns {Promise<Array>} 全部文档
 */
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

// 阿里云 DashScope API 配置
const DASHSCOPE_API_KEYS = {
  'main': process.env.QWEN_API_KEY,
  'v': process.env.QWEN_API_KEY_V,
  'w': process.env.QWEN_API_KEY_W
}
const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization'

/**
 * 发送 HTTP POST 请求
 * @param {String} url - 请求 URL
 * @param {Object} data - 请求体数据
 * @param {String} accountType - 账号类型：main, v, w
 * @returns {Promise<Object>} 响应数据
 */
function sendPostRequest(url, data, accountType = 'main') {
  return new Promise((resolve, reject) => {
    const apiKey = DASHSCOPE_API_KEYS[accountType]

    if (!apiKey) {
      return reject(new Error(`账号 ${accountType} 的 API Key 未配置`))
    }

    const urlObj = new URL(url)
    const postData = JSON.stringify(data)

    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }

    console.log('[VoiceManage] 发送请求到:', url, '账号:', accountType)
    console.log('[VoiceManage] 请求参数:', JSON.stringify(data, null, 2))

    const req = https.request(options, (res) => {
      let responseData = ''

      res.on('data', (chunk) => {
        responseData += chunk
      })

      res.on('end', () => {
        try {
          const result = JSON.parse(responseData)
          console.log('[VoiceManage] 响应状态:', res.statusCode)
          //console.log('[VoiceManage] 响应数据:', JSON.stringify(result, null, 2))

          if (res.statusCode === 200) {
            resolve(result)
          } else {
            reject(new Error(`API 请求失败: ${res.statusCode} - ${responseData}`))
          }
        } catch (err) {
          console.error('[VoiceManage] 解析响应失败:', err)
          reject(new Error(`解析响应失败: ${err.message}`))
        }
      })
    })

    req.on('error', (error) => {
      console.error('[VoiceManage] 请求错误:', error)
      reject(error)
    })

    // 超时保护：避免单个请求挂死拖垮整次拉取（挂死会导致分页中断、数量偏少）
    req.setTimeout(20000, () => {
      req.destroy(new Error('请求超时(20s)'))
    })

    req.write(postData)
    req.end()
  })
}

/**
 * 查询单个账号的全部音色列表（逐页拉取，按“页”级别重试）
 *
 * 关键点：以前的实现一旦某页失败就会从第 0 页重新开始，并在最终失败时
 * 静默返回已拉取的部分数据，导致数量偏少且为整百（如 300/400）。
 * 现改为针对“当前页”重试，不丢弃已拉取的数据；若某页彻底失败则停止翻页
 * 并标记 complete=false，由上层据此提示“数据不完整”，避免静默返回错误数量。
 *
 * @param {String} accountType - 账号类型：main, v, w
 * @param {String} voiceType - 音色类型：clone(声音克隆) 或 design(声音设计)
 * @returns {Promise<{list: Array, complete: boolean}>} 音色列表与是否完整
 */
async function listVoicesForAccount(accountType, voiceType = 'clone') {
  console.log('[VoiceManage] 查询全部音色列表，account:', accountType, 'voice_type:', voiceType)

  // 根据音色类型选择 model
  const model = voiceType === 'design' ? 'qwen-voice-design' : 'qwen-voice-enrollment'

  const pageSize = 100 // 每次请求最多 100 条，减少请求次数
  const MAX_PAGE_RETRIES = 4 // 单页最多重试次数
  const PAGE_INTERVAL_MS = 150 // 页间间隔，降低被限流概率（宁可慢一点，也要数量正确）

  let allVoices = []
  let pageIndex = 0
  let complete = true

  while (true) {
    let pageVoices = null
    let lastErr = null

    for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
      try {
        const payload = {
          model: model,
          input: {
            action: 'list',
            page_index: pageIndex,
            page_size: pageSize
          }
        }

        const response = await sendPostRequest(DASHSCOPE_API_URL, payload, accountType)
        pageVoices = response.output?.voice_list || []
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        console.error(`[VoiceManage] 账号 ${accountType} 第 ${pageIndex + 1} 页第 ${attempt + 1}/${MAX_PAGE_RETRIES + 1} 次失败:`, err.message)
        if (attempt < MAX_PAGE_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1))) // 指数退避
        }
      }
    }

    // 当前页多次重试仍失败：停止翻页并标记不完整（继续翻页会导致页号错乱、漏数据）
    if (lastErr) {
      console.error(`[VoiceManage] 账号 ${accountType} 第 ${pageIndex + 1} 页彻底失败，已拉取 ${allVoices.length} 条，标记为数据不完整`)
      complete = false
      break
    }

    console.log('[VoiceManage] 账号', accountType, '第', pageIndex + 1, '页，本页数量:', pageVoices.length, '累计:', allVoices.length + pageVoices.length)

    if (pageVoices.length === 0) break // 没有更多数据了
    allVoices = allVoices.concat(pageVoices)
    if (pageVoices.length < pageSize) break // 本页不足一页，说明已到末尾

    pageIndex++
    if (PAGE_INTERVAL_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, PAGE_INTERVAL_MS))
    }
  }

  console.log('[VoiceManage] 账号', accountType, '获取完毕，总数量:', allVoices.length, '完整:', complete)
  return { list: allVoices, complete }
}

/**
 * 查询所有账号的音色列表
 * @param {String} voiceType - 音色类型：clone(声音克隆) 或 design(声音设计)，默认 clone
 * @returns {Promise<Object>} 音色列表
 */
async function listVoices(voiceType = 'clone') {
  console.log('[VoiceManage] 查询所有账号音色列表，voice_type:', voiceType)

  try {
    // 并发查询3个账号的全部音色列表（每个账号内部自动循环分页）
    const [mainRes, vRes, wRes] = await Promise.all([
      listVoicesForAccount('main', voiceType),
      listVoicesForAccount('v', voiceType),
      listVoicesForAccount('w', voiceType)
    ])
    const mainList = mainRes.list
    const vList = vRes.list
    const wList = wRes.list

    // 汇总哪些账号数据不完整（某页彻底失败），用于前端提示
    const incompleteAccounts = []
    if (!mainRes.complete) incompleteAccounts.push('main')
    if (!vRes.complete) incompleteAccounts.push('v')
    if (!wRes.complete) incompleteAccounts.push('w')
    const incomplete = incompleteAccounts.length > 0
    if (incomplete) {
      console.warn('[VoiceManage] 以下账号数据不完整，数量可能偏少:', incompleteAccounts.join(','))
    }

    console.log('[VoiceManage] ===== 音色数量统计 =====')
    console.log('[VoiceManage] main 账号:', mainList.length, '个', mainRes.complete ? '' : '(不完整)')
    console.log('[VoiceManage] v 账号:', vList.length, '个', vRes.complete ? '' : '(不完整)')
    console.log('[VoiceManage] w 账号:', wList.length, '个', wRes.complete ? '' : '(不完整)')

    // 合并所有账号的音色列表，并标记账号类型
    const allVoiceList = [
      ...mainList.map(v => ({ ...v, account_type: 'main' })),
      ...vList.map(v => ({ ...v, account_type: 'v' })),
      ...wList.map(v => ({ ...v, account_type: 'w' }))
    ]

    console.log('[VoiceManage] 合并总计:', allVoiceList.length, '个')
    console.log('[VoiceManage] =========================')

    // 查询数据库中所有用户的音色记录（包含创建和保存）—— 全量拉取，避免默认 limit 漏数据导致已保存音色统计错误
    const savedRecords = await getAllDocs('user_saved_voices')

    console.log('[VoiceManage] 查询到用户音色记录，数量:', savedRecords.length)

    // 构建音色到用户信息的映射：voice_id -> {openid, voice_name, type: 'saved'|'creator'}
    const voiceUserMap = {}

    // 构建音色最近使用时间映射：voice_id -> 最近使用时间戳
    const voiceLastUsedTimeMap = {}

    savedRecords.forEach(record => {
      const openid = record.openid || record._id // 兼容旧文档：可能只有 _id 是 openid
      const savedList = record.list || []

      savedList.forEach(savedVoice => {
        const voiceId = savedVoice.voice_id || savedVoice.voice
        const voiceName = savedVoice.voice_name || savedVoice.name
        const isSaved = savedVoice.isSaved || false

        // 每个音色只记录第一个用户，优先记录已保存的（isSaved = true）
        if (voiceId && !voiceUserMap[voiceId]) {
          voiceUserMap[voiceId] = {
            openid: openid,
            voice_name: voiceName,
            type: isSaved ? 'saved' : 'creator'
          }
        }
      })
    })

    // 用 Set 做 O(1) 查找
    const allVoiceIdSet = new Set(allVoiceList.map(v => v.voice))

    // 先把系统/预置音色（speakers_test.system_speakers 和 speakers_test.upload_speakers）标记出来
    // 这些音色没有用户归属，不应进入“建议清理”
    try {
      const [systemDoc, uploadDoc] = await Promise.all([
        db.collection('speakers_test').doc('system_speakers').get().catch(() => null),
        db.collection('speakers_test').doc('upload_speakers').get().catch(() => null)
      ])

      const markSystem = (doc, source) => {
        if (!doc || !doc.data || !Array.isArray(doc.data.list)) return 0
        let count = 0
        doc.data.list.forEach(s => {
          const vid = s.voice_id || s.voice
          if (!vid) return
          // 仅当该 voice 当前确实在 API 列表中且未被 user_saved_voices 记录为 saved 时，标记为 system
          if (!allVoiceIdSet.has(vid)) return
          const existing = voiceUserMap[vid]
          if (existing && existing.type === 'saved') return // 用户已保存优先级最高
          voiceUserMap[vid] = {
            openid: '',
            voice_name: s.voice_name || s.name || '',
            type: 'system',
            source
          }
          count++
        })
        return count
      }
      const sysCount = markSystem(systemDoc, 'system_speakers')
      const upCount = markSystem(uploadDoc, 'upload_speakers')
      console.log('[VoiceManage] 系统音色匹配:', sysCount, '/上传预置音色匹配:', upCount)
    } catch (e) {
      console.error('[VoiceManage] 查询 speakers_test 失败（已忽略，不影响主流程）:', e)
    }

    // 从 tts_clone_design_logs 日志表补充查询未匹配音色的创建者信息 + 最近使用时间
    console.log('[VoiceManage] 开始从日志表补充查询创建者信息和最近使用时间')
    const unmatchedIdSet = new Set(allVoiceList.map(v => v.voice).filter(vid => !voiceUserMap[vid]))
    console.log('[VoiceManage] 经 saved/system 标记后未匹配的音色数量:', unmatchedIdSet.size)

    // 记录每个音色的创建日志（clone/design）相关字段，便于前端"上传到测试音色库"/播放预览
    const voiceCreationLogMap = {}

    try {
      // 全量并发拉取日志表，避免逐页串行造成的缓慢
      const logRecords = await getAllDocs('tts_clone_design_logs')
      console.log('[VoiceManage] 日志表文档数量:', logRecords.length)

      logRecords.forEach(doc => {
        // 兼容两种 schema：doc.openid 优先；旧文档以 _id 作为 openid
        const docOpenid = doc.openid || doc._id
        const logs = doc.logs || []

        logs.forEach(log => {
          // 兼容字段名：voice_id 与 voice 都可能存在
          const logVoiceId = log.voice_id || log.voice
          if (!logVoiceId) return

          // 处理未匹配音色的创建者信息
          if (!voiceUserMap[logVoiceId] && unmatchedIdSet.has(logVoiceId)) {
            voiceUserMap[logVoiceId] = {
              openid: docOpenid,
              voice_name: log.voice_name || '',
              type: 'creator' // 日志中都是创建者
            }
          }

          if (allVoiceIdSet.has(logVoiceId)) {
            const logType = log.type
            // 记录每个音色的最近使用时间（仅统计 synthesize 类型，即实际使用该音色进行语音合成的记录）
            if (logType === 'synthesize' || logType === 'synthesize_mimo') {
              // 日志表中时间字段为 created_at
              const logTime = log.created_at
              if (logTime) {
                const currentBest = voiceLastUsedTimeMap[logVoiceId]
                // 统一转为时间戳比较
                const logTimestamp = typeof logTime === 'number' ? logTime : new Date(logTime).getTime()
                const currentTimestamp = typeof currentBest === 'number' ? currentBest : (currentBest ? new Date(currentBest).getTime() : 0)
                if (!currentBest || logTimestamp > currentTimestamp) {
                  voiceLastUsedTimeMap[logVoiceId] = logTime
                }
              }
            }

            // 记录创建日志（clone/design）：保留最近一条，包含上传到测试音色库所需字段
            if (logType === 'clone' || logType === 'design') {
              const logTime = log.created_at
              const logTimestamp = typeof logTime === 'number' ? logTime : (logTime ? new Date(logTime).getTime() : 0)
              const existing = voiceCreationLogMap[logVoiceId]
              const existingTs = existing ? existing._ts : -1
              if (!existing || logTimestamp >= existingTs) {
                voiceCreationLogMap[logVoiceId] = {
                  voice_name: log.voice_name || '',
                  voice_prompt: log.voice_prompt || '',
                  used_api_key: log.used_api_key || '',
                  preview_text: log.preview_text || log.text || '',
                  preview_audio_file_id: log.preview_audio_file_id || log.audio_file_id || '',
                  language: log.language || '',
                  target_model: log.target_model || '',
                  creation_type: logType,
                  _ts: logTimestamp
                }
              }
            }
          }
        })
      })

      console.log('[VoiceManage] 日志表补充匹配完成，已记录最近使用时间的音色数量:', Object.keys(voiceLastUsedTimeMap).length, '/创建日志:', Object.keys(voiceCreationLogMap).length)
    } catch (logErr) {
      console.error('[VoiceManage] 查询日志表失败:', logErr)
    }

    // 诊断：列出仍未匹配的音色（同时缺少用户信息与最近使用时间），便于排查数据缺漏
    const stillUnmatched = allVoiceList.filter(v => !voiceUserMap[v.voice] && !voiceLastUsedTimeMap[v.voice])
    console.log('[VoiceManage] 既无创建者也无使用时间的音色数量:', stillUnmatched.length)
    if (stillUnmatched.length > 0) {
      const sample = stillUnmatched.slice(0, 10).map(v => ({
        voice: v.voice,
        account_type: v.account_type,
        gmt_create: v.gmt_create
      }))
      console.log('[VoiceManage] 未匹配样本(前10条):', JSON.stringify(sample))
    }

    //console.log('[VoiceManage] 音色用户映射:', JSON.stringify(voiceUserMap))
    //console.log('[VoiceManage] 音色列表示例:', JSON.stringify(voiceList.slice(0, 2)))

    // 为每个音色添加用户信息和最近使用时间
    // 注意：此处不再对每个音色单独打 log（音色多时会严重拖慢云函数并产生大量日志）
    const enhancedVoiceList = allVoiceList.map(voice => {
      const voiceId = voice.voice
      // 创建日志字段（去掉内部排序 _ts）
      let creationLog = null
      const cl = voiceCreationLogMap[voiceId]
      if (cl) {
        creationLog = {
          voice_name: cl.voice_name,
          voice_prompt: cl.voice_prompt,
          used_api_key: cl.used_api_key,
          preview_text: cl.preview_text,
          preview_audio_file_id: cl.preview_audio_file_id,
          language: cl.language,
          target_model: cl.target_model,
          creation_type: cl.creation_type
        }
      }
      return {
        ...voice,
        voice_type: voiceType, // 添加音色类型
        user_info: voiceUserMap[voiceId] || null, // 用户信息 {openid, voice_name, type: 'saved'|'creator'}，无则为 null
        last_used_time: voiceLastUsedTimeMap[voiceId] || null, // 最近使用该音色进行语音合成的时间，无则为 null
        creation_log: creationLog // 用于"上传到测试音色库"/播放预览，来自 clone/design 创建日志
      }
    })

    // 按账号分组统计
    const accountStats = {
      main: mainList.length,
      v: vList.length,
      w: wList.length
    }

    return {
      code: 0,
      message: 'success',
      data: {
        voice_list: enhancedVoiceList,
        voice_type: voiceType,
        account_stats: accountStats,
        incomplete: incomplete, // 是否有账号数据不完整（数量可能偏少）
        incomplete_accounts: incompleteAccounts // 不完整的账号列表
      }
    }
  } catch (err) {
    console.error('[VoiceManage] 查询音色列表失败:', err)
    throw err
  }
}

/**
 * 删除音色
 * @param {String} voice - 音色名称
 * @param {String} creatorOpenid - 创建者 openid
 * @param {String} voiceType - 音色类型：clone(声音克隆) 或 design(声音设计)，默认 clone
 * @param {String} accountType - 账号类型：main, v, w
 * @returns {Promise<Object>} 删除结果
 */
async function deleteVoice(voice, creatorOpenid, voiceType = 'clone', accountType = 'main') {
  console.log('[VoiceManage] 删除音色，voice:', voice, 'creator_openid:', creatorOpenid, 'type:', voiceType, 'account:', accountType)

  if (!voice) {
    throw new Error('音色名称不能为空')
  }

  // 1. 更新 tts_clone_design_logs 表中相关日志，将 voice_id 置为 invalid
  console.log('[VoiceManage] 开始更新日志表中的音色信息')
  try {
    if (creatorOpenid) {
      const record = await db.collection('tts_clone_design_logs')
        .doc(creatorOpenid)
        .get()

      if (record.data && record.data.logs) {
        const logs = record.data.logs
        let needUpdate = false

        const updatedLogs = logs.map(log => {
          if (log.voice_id === voice) {
            console.log('[VoiceManage] 找到匹配日志, openid:', creatorOpenid)
            needUpdate = true
            return {
              ...log,
              voice_id: 'invalid',
              voice_name: 'invalid'
            }
          }
          return log
        })

        if (needUpdate) {
          await db.collection('tts_clone_design_logs')
            .doc(creatorOpenid)
            .update({
              data: {
                logs: updatedLogs
              }
            })
          console.log('[VoiceManage] 日志更新完成')
        } else {
          console.log('[VoiceManage] 日志中未找到该音色')
        }
      } else {
        console.log('[VoiceManage] 未找到日志记录')
      }
    } else {
      console.log('[VoiceManage] 未提供 openid，跳过日志更新')
    }
  } catch (dbErr) {
    console.error('[VoiceManage] 更新日志表失败:', dbErr)
  }

  // 2. 从 user_saved_voices 中移除该音色
  console.log('[VoiceManage] 开始清理 user_saved_voices 中的音色记录')
  try {
    const savedRecords = await getAllDocs('user_saved_voices')

    for (const record of savedRecords) {
      const savedList = record.list || []
      const filteredList = savedList.filter(sv => {
        const svId = sv.voice_id || sv.voice
        return svId !== voice
      })

      if (filteredList.length < savedList.length) {
        console.log('[VoiceManage] 从 user_saved_voices 中移除音色, openid:', record.openid)
        await db.collection('user_saved_voices').doc(record._id).update({
          data: { list: filteredList }
        })
      }
    }

    console.log('[VoiceManage] user_saved_voices 清理完成')
  } catch (savedErr) {
    console.error('[VoiceManage] 清理 user_saved_voices 失败:', savedErr)
  }

  // 3. 检查 speakers 集合中是否存在该音色
  try {
    const speakerResult = await db.collection('speakers')
      .doc('system_speakers')
      .get()
    if (speakerResult.data && speakerResult.data.list) {
      const isInSpeakers = speakerResult.data.list.some(s => s.voice_id === voice)
      if (isInSpeakers) {
        console.log('[VoiceManage] 音色在 speakers 中，不允许删除:', voice)
        return {
          code: 403,
          message: '该音色为系统内置音色，不支持删除',
          data: null
        }
      }
    }
  } catch (speakerErr) {
    console.error('[VoiceManage] 查询 speakers 失败:', speakerErr)
  }

  // 4. 调用阿里云 API 删除音色
  const model = voiceType === 'design' ? 'qwen-voice-design' : 'qwen-voice-enrollment'

  const payload = {
    model: model,
    input: {
      action: 'delete',
      voice: voice
    }
  }

  try {
    const response = await sendPostRequest(DASHSCOPE_API_URL, payload, accountType)

    return {
      code: 0,
      message: 'success',
      data: {
        request_id: response.request_id
      }
    }
  } catch (err) {
    console.error('[VoiceManage] 删除音色失败:', err)
    throw err
  }
}

/**
 * 上传音色到 speakers_test 集合
 * @param {Object} voiceData - 音色数据
 * @returns {Promise<Object>} 上传结果
 */
async function uploadSpeaker(voiceData) {
  console.log('[VoiceManage] 上传音色到 speakers_test:', JSON.stringify(voiceData))

  if (!voiceData || !voiceData.voice_id) {
    return {
      code: 400,
      message: '音色数据不完整，缺少 voice_id',
      data: null
    }
  }

  try {
    const docId = 'upload_speakers'
    const now = new Date()

    // 构建音色记录
    const speakerItem = {
      voice_id: voiceData.voice_id || '',
      voice_name: voiceData.voice_name || '',
      voice_prompt: voiceData.voice_prompt || '',
      used_api_key: voiceData.used_api_key || '',
      preview_text: voiceData.preview_text || '',
      preview_audio_file_id: voiceData.preview_audio_file_id || '',
      language: voiceData.language || '',
      target_model: voiceData.target_model || '',
      type: voiceData.type || ''
    }

    // 尝试获取已有文档
    let docExists = false
    let existingList = []
    try {
      const docResult = await db.collection('speakers_test').doc(docId).get()
      if (docResult.data) {
        docExists = true
        existingList = docResult.data.list || []
      }
    } catch (err) {
      // 文档不存在，需要创建
      docExists = false
    }

    // 检查是否已存在相同 voice_id
    const existingIndex = existingList.findIndex(s => s.voice_id === voiceData.voice_id)
    if (existingIndex >= 0) {
      // 已存在则更新
      existingList[existingIndex] = speakerItem
      console.log('[VoiceManage] 更新已有音色:', voiceData.voice_id)
    } else {
      // 不存在则添加
      existingList.push(speakerItem)
      console.log('[VoiceManage] 添加新音色:', voiceData.voice_id)
    }

    if (docExists) {
      // 更新已有文档
      await db.collection('speakers_test').doc(docId).update({
        data: {
          list: existingList,
          updated_at: now
        }
      })
    } else {
      // 创建新文档
      await db.collection('speakers_test').add({
        data: {
          _id: docId,
          list: existingList,
          updated_at: now
        }
      })
    }

    console.log('[VoiceManage] 上传完成，当前列表数量:', existingList.length)

    return {
      code: 0,
      message: '上传成功',
      data: { voice_id: voiceData.voice_id, total: existingList.length }
    }
  } catch (err) {
    console.error('[VoiceManage] 上传音色失败:', err)
    return {
      code: 500,
      message: err.message || '上传失败',
      data: null
    }
  }
}

/**
 * 查询 speakers 集合中 system_speakers 的所有 voice_id
 * @returns {Promise<Object>} { code, data: { voice_ids: [...] } }
 */
async function checkSpeakers() {
  try {
    const docResult = await db.collection('speakers_test').doc('system_speakers').get()
    const list = (docResult.data && docResult.data.list) || []
    const voiceIds = list.map(s => s.voice_id).filter(Boolean)
    console.log('[VoiceManage] speakers 中音色数量:', voiceIds.length)
    return {
      code: 0,
      message: 'success',
      data: { voice_ids: voiceIds }
    }
  } catch (err) {
    console.error('[VoiceManage] 查询 speakers 失败:', err)
    return {
      code: 0,
      message: 'success',
      data: { voice_ids: [] }
    }
  }
}

/**
 * 查询 speakers_test 集合中 upload_speakers 的所有 voice_id
 * @returns {Promise<Object>} { code, data: { voice_ids: [...] } }
 */
async function checkUploadSpeakers() {
  try {
    const docResult = await db.collection('speakers_test').doc('upload_speakers').get()
    const list = (docResult.data && docResult.data.list) || []
    const voiceIds = list.map(s => s.voice_id).filter(Boolean)
    console.log('[VoiceManage] speakers_test 中音色数量:', voiceIds.length)
    return {
      code: 0,
      message: 'success',
      data: { voice_ids: voiceIds }
    }
  } catch (err) {
    console.error('[VoiceManage] 查询 speakers_test 失败:', err)
    return {
      code: 0,
      message: 'success',
      data: { voice_ids: [] }
    }
  }
}

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[VoiceManage] ===== 音色管理 =====')

  // 验证用户身份
  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const { action, voice, creator_openid, voice_type = 'clone', account_type = 'main' } = event

  // 验证至少有一个 API Key 配置
  const hasValidKey = Object.values(DASHSCOPE_API_KEYS).some(key => key)
  if (!hasValidKey) {
    console.error('[VoiceManage] 未配置任何有效的 API Key')
    return {
      code: 500,
      message: '未配置任何有效的 API Key',
      data: null
    }
  }

  try {
    let result

    switch (action) {
      case 'list':
        // 查询音色列表（获取全部数据）
        result = await listVoices(voice_type)
        break

      case 'delete':
        // 删除音色
        result = await deleteVoice(voice, creator_openid, voice_type, account_type)
        break

      case 'upload_speaker':
        // 上传音色到 speakers_test
        result = await uploadSpeaker(event.voice_data)
        break

      case 'check_speakers':
        // 查询已发布音色ID列表
        result = await checkSpeakers()
        break

      case 'check_upload_speakers':
        // 查询已上传音色ID列表
        result = await checkUploadSpeakers()
        break

      default:
        return {
          code: 400,
          message: `不支持的操作类型: ${action}，支持的操作: list, delete, upload_speaker, check_speakers, check_upload_speakers`,
          data: null
        }
    }

    return result
  } catch (err) {
    console.error('[VoiceManage] 操作失败:', err)
    return {
      code: 500,
      message: err.message || '操作失败',
      data: null
    }
  }
}
