// 云函数入口文件
const cloud = require('wx-server-sdk')
const https = require('https')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

// 阿里云 DashScope API 配置
const DASHSCOPE_API_KEY = process.env.QWEN_API_KEY
const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization'

/**
 * 发送 HTTP POST 请求
 * @param {String} url - 请求 URL
 * @param {Object} data - 请求体数据
 * @returns {Promise<Object>} 响应数据
 */
function sendPostRequest(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const postData = JSON.stringify(data)

    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }

    console.log('[VoiceManage] 发送请求到:', url)
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
          console.log('[VoiceManage] 响应数据:', JSON.stringify(result, null, 2))

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
 * 查询音色列表
 * @param {Number} pageIndex - 页码索引，默认 0
 * @param {Number} pageSize - 每页数量，默认 10
 * @returns {Promise<Object>} 音色列表
 */
async function listVoices(pageIndex = 0, pageSize = 10) {
  console.log('[VoiceManage] 查询音色列表，page_index:', pageIndex, 'page_size:', pageSize)

  const payload = {
    model: 'qwen-voice-enrollment',
    input: {
      action: 'list',
      page_index: pageIndex,
      page_size: pageSize
    }
  }

  try {
    const response = await sendPostRequest(DASHSCOPE_API_URL, payload)
    return {
      code: 0,
      message: 'success',
      data: {
        voice_list: response.output?.voice_list || [],
        request_id: response.request_id
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
 * @returns {Promise<Object>} 删除结果
 */
async function deleteVoice(voice) {
  console.log('[VoiceManage] 删除音色，voice:', voice)

  if (!voice) {
    throw new Error('音色名称不能为空')
  }

  const payload = {
    model: 'qwen-voice-enrollment',
    input: {
      action: 'delete',
      voice: voice
    }
  }

  try {
    const response = await sendPostRequest(DASHSCOPE_API_URL, payload)
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

  const { action, voice, page_index = 0, page_size = 10 } = event

  // 验证 API Key
  if (!DASHSCOPE_API_KEY) {
    console.error('[VoiceManage] DASHSCOPE_API_KEY 未配置')
    return {
      code: 500,
      message: 'DASHSCOPE_API_KEY 未配置',
      data: null
    }
  }

  try {
    let result

    switch (action) {
      case 'list':
        // 查询音色列表
        result = await listVoices(page_index, page_size)
        break

      case 'delete':
        // 删除音色
        result = await deleteVoice(voice)
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
