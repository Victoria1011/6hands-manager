// 云函数入口文件
const cloud = require('wx-server-sdk')
const https = require('https')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

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

    req.write(postData)
    req.end()
  })
}

/**
 * 查询单个账号的音色列表
 * @param {String} accountType - 账号类型：main, v, w
 * @param {String} voiceType - 音色类型：clone(声音克隆) 或 design(声音设计)
 * @param {Number} pageIndex - 页码索引，默认 0
 * @param {Number} pageSize - 每页数量，默认 10
 * @returns {Promise<Object>} 音色列表
 */
async function listVoicesForAccount(accountType, voiceType = 'clone', pageIndex = 0, pageSize = 10) {
  console.log('[VoiceManage] 查询音色列表，account:', accountType, 'voice_type:', voiceType, 'page_index:', pageIndex, 'page_size:', pageSize)

  // 根据音色类型选择 model
  const model = voiceType === 'design' ? 'qwen-voice-design' : 'qwen-voice-enrollment'

  const payload = {
    model: model,
    input: {
      action: 'list',
      page_index: pageIndex,
      page_size: pageSize
    }
  }

  try {
    // 调用阿里云 API 查询音色列表
    const response = await sendPostRequest(DASHSCOPE_API_URL, payload, accountType)
    const voiceList = response.output?.voice_list || []

    console.log('[VoiceManage] 账号', accountType, '获取到音色列表，数量:', voiceList.length, '类型:', voiceType)

    return voiceList
  } catch (err) {
    console.error('[VoiceManage] 账号', accountType, '查询音色列表失败:', err)
    // 返回空数组，不影响其他账号
    return []
  }
}

/**
 * 查询所有账号的音色列表
 * @param {String} voiceType - 音色类型：clone(声音克隆) 或 design(声音设计)，默认 clone
 * @param {Number} pageIndex - 页码索引，默认 0
 * @param {Number} pageSize - 每页数量，默认 10
 * @returns {Promise<Object>} 音色列表
 */
async function listVoices(voiceType = 'clone', pageIndex = 0, pageSize = 10) {
  console.log('[VoiceManage] 查询所有账号音色列表，voice_type:', voiceType)

  try {
    // 并发查询3个账号的音色列表
    const [mainList, vList, wList] = await Promise.all([
      listVoicesForAccount('main', voiceType, pageIndex, pageSize),
      listVoicesForAccount('v', voiceType, pageIndex, pageSize),
      listVoicesForAccount('w', voiceType, pageIndex, pageSize)
    ])

    // 合并所有账号的音色列表，并标记账号类型
    const allVoiceList = [
      ...mainList.map(v => ({ ...v, account_type: 'main' })),
      ...vList.map(v => ({ ...v, account_type: 'v' })),
      ...wList.map(v => ({ ...v, account_type: 'w' }))
    ]

    console.log('[VoiceManage] 所有账号音色列表，数量:', allVoiceList.length)

    // 查询数据库中所有用户的音色记录（包含创建和保存）
    const savedVoicesResult = await db.collection('user_saved_voices').get()
    const savedRecords = savedVoicesResult.data || []

    console.log('[VoiceManage] 查询到用户音色记录，数量:', savedRecords.length)

    // 构建音色到用户信息的映射：voice_id -> {openid, voice_name, type: 'saved'|'creator'}
    const voiceUserMap = {}

    savedRecords.forEach(record => {
      const openid = record.openid
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

    //console.log('[VoiceManage] 音色用户映射:', JSON.stringify(voiceUserMap))
    //console.log('[VoiceManage] 音色列表示例:', JSON.stringify(voiceList.slice(0, 2)))

    // 为每个音色添加用户信息
    const enhancedVoiceList = allVoiceList.map(voice => {
      const voiceId = voice.voice
      const userInfo = voiceUserMap[voiceId] || null

      console.log('[VoiceManage] 音色:', voiceId, '账号:', voice.account_type, '用户信息:', userInfo ? `${userInfo.openid} (${userInfo.type})` : '无')

      return {
        ...voice,
        voice_type: voiceType, // 添加音色类型
        user_info: userInfo // 用户信息 {openid, voice_name, type: 'saved'|'creator'}，无则为 null
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
        account_stats: accountStats
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

  // 根据音色类型选择 model
  const model = voiceType === 'design' ? 'qwen-voice-design' : 'qwen-voice-enrollment'

  const payload = {
    model: model,
    input: {
      action: 'delete',
      voice: voice
    }
  }

  try {
    // 先调用阿里云 API 删除音色，使用指定的账号
    const response = await sendPostRequest(DASHSCOPE_API_URL, payload, accountType)

    // 删除成功后，更新 tts_clone_design_logs 表中相关日志
    console.log('[VoiceManage] 开始更新日志表中的音色信息')

    try {
      // 如果有创建者 openid，直接查询该用户的日志记录
      if (creatorOpenid) {
        const record = await db.collection('tts_clone_design_logs')
          .doc(creatorOpenid)
          .get()

        if (record.data && record.data.logs) {
          const logs = record.data.logs
          let needUpdate = false

          // 检查 logs 数组中是否有匹配的 voice_id
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

          // 如果有需要更新的日志，执行更新
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
      // 日志表更新失败不影响删除操作的成功状态
    }

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

  const { action, voice, creator_openid, voice_type = 'clone', page_index = 0, page_size = 10, account_type = 'main' } = event

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
        // 查询音色列表
        result = await listVoices(voice_type, page_index, page_size)
        break

      case 'delete':
        // 删除音色
        result = await deleteVoice(voice, creator_openid, voice_type, account_type)
        break

      default:
        return {
          code: 400,
          message: `不支持的操作类型: ${action}，支持的操作: list, delete`,
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
