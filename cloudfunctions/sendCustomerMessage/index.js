// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const appid = 'wx126d0f048410f694'

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[SendCustomerMessage] ===== 开始发送客服消息 =====')
  console.log('[SendCustomerMessage] 事件对象:', JSON.stringify(event))

  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const { openid, msgtype, content, msgData } = event

  if (!openid) {
    return {
      code: 400,
      message: '用户 openid 不能为空',
      data: null
    }
  }

  if (!msgtype) {
    return {
      code: 400,
      message: '消息类型不能为空',
      data: null
    }
  }

  try {
    console.log('[SendCustomerMessage] 发送消息参数:', { openid, msgtype, content, msgData })

    // 构建发送消息的数据
    const sendParams = {
      touser: openid,
      msgtype: msgtype
    }

    // 根据消息类型添加不同参数
    switch (msgtype) {
      case 'text':
        if (!content) {
          return {
            code: 400,
            message: '文本消息内容不能为空',
            data: null
          }
        }
        sendParams.text = {
          content: content
        }
        break

      case 'image':
        if (!msgData || !msgData.file_id) {
          return {
            code: 400,
            message: '图片消息需要 file_id (云存储ID)',
            data: null
          }
        }
        // 将云存储的 fileID 转换为微信临时素材的 media_id
        console.log('[SendCustomerMessage] 正在转换云存储图片为微信临时素材:', msgData.file_id)
        const mediaResult = await convertCloudFileToMedia(msgData.file_id)
        if (!mediaResult.success) {
          return {
            code: 400,
            message: '图片转换失败: ' + mediaResult.message,
            data: null
          }
        }
        // 保存云存储文件ID到msgData，用于数据库记录
        msgData.cloud_file_id = mediaResult.cloud_file_id
        sendParams.image = {
          media_id: mediaResult.media_id
        }
        break

      case 'voice':
        if (!msgData || !msgData.file_id) {
          return {
            code: 400,
            message: '语音消息需要 file_id (云存储ID)',
            data: null
          }
        }
        // 将云存储的 fileID 转换为微信临时素材的 media_id
        const voiceMediaResult = await convertCloudFileToMedia(msgData.file_id)
        if (!voiceMediaResult.success) {
          return {
            code: 400,
            message: '语音转换失败: ' + voiceMediaResult.message,
            data: null
          }
        }
        // 保存云存储文件ID到msgData，用于数据库记录
        msgData.cloud_file_id = voiceMediaResult.cloud_file_id
        sendParams.voice = {
          media_id: voiceMediaResult.media_id
        }
        break

      case 'video':
        if (!msgData || !msgData.file_id) {
          return {
            code: 400,
            message: '视频消息需要 file_id',
            data: null
          }
        }
        // 将云存储的 fileID 转换为微信临时素材的 media_id
        const videoMediaResult = await convertCloudFileToMedia(msgData.file_id)
        if (!videoMediaResult.success) {
          return {
            code: 400,
            message: '视频转换失败: ' + videoMediaResult.message,
            data: null
          }
        }
        // 保存云存储文件ID到msgData，用于数据库记录
        msgData.cloud_file_id = videoMediaResult.cloud_file_id
        sendParams.video = {
          media_id: videoMediaResult.media_id,
          thumb_media_id: msgData.thumb_media_id || '',
          title: msgData.title || '',
          description: msgData.description || ''
        }
        break

      case 'miniprogrampage':
        if (!msgData || !msgData.title || !msgData.appid || !msgData.pagepath || !msgData.thumb_media_id) {
          return {
            code: 400,
            message: '小程序卡片消息缺少必要参数',
            data: null
          }
        }
        sendParams.miniprogrampage = {
          title: msgData.title,
          appid: msgData.appid,
          pagepath: msgData.pagepath,
          thumb_media_id: msgData.thumb_media_id
        }
        break

      case 'news':
        if (!msgData || !msgData.articles || msgData.articles.length === 0) {
          return {
            code: 400,
            message: '图文消息需要 articles 参数',
            data: null
          }
        }
        sendParams.news = {
          articles: msgData.articles
        }
        break

      case 'msgmenu':
        if (!msgData) {
          return {
            code: 400,
            message: '菜单消息需要 msgData 参数',
            data: null
          }
        }
        sendParams.msgmenu = {
          head_content: msgData.head_content || '',
          list: msgData.list || [],
          tail_content: msgData.tail_content || ''
        }
        break

      default:
        return {
          code: 400,
          message: `不支持的消息类型: ${msgtype}`,
          data: null
        }
    }

    // 发送客服消息
    console.log('[SendCustomerMessage] 调用微信接口发送消息')
    console.log('[SendCustomerMessage] 发送消息参数:', JSON.stringify(sendParams))

    // 使用云调用 API 发送客服消息，指定来源方 AppID
    const result = await cloud.openapi({
      appid: appid
    }).customerServiceMessage.send(sendParams)

    console.log('[SendCustomerMessage] 发送结果:', result)

    // 保存发送记录到数据库
    const messageRecord = {
      type: 'customer_to_user',
      openid: openid,
      msg_type: msgtype,
      content: content || '',
      msg_data: msgData || {},
      // 图片/语音/视频消息保存云存储文件ID
      cloud_file_id: (msgData && msgData.cloud_file_id) ? msgData.cloud_file_id : '',
      send_result: {
        errcode: result.errcode,
        errmsg: result.errmsg
      },
      success: result.errcode === 0,
      created_at: new Date().toISOString()
    }

    // 先查询该用户的记录是否存在
    const existRecord = await db.collection('customer_service_messages').where({
      openid: openid
    }).get()

    if (existRecord.data.length > 0) {
      // 记录存在，更新消息数组
      await db.collection('customer_service_messages').where({
        openid: openid
      }).update({
        data: {
          messages: db.command.push(messageRecord),
          updated_at: new Date().toISOString()
        }
      })
    } else {
      // 记录不存在，创建新记录
      await db.collection('customer_service_messages').add({
        data: {
          openid: openid,
          messages: [messageRecord],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      })
    }

    console.log('[SendCustomerMessage] 消息记录保存成功')

    return {
      code: 0,
      message: 'success',
      data: {
        success: result.errcode === 0,
        errcode: result.errcode,
        errmsg: result.errmsg
      }
    }

  } catch (err) {
    console.error('[SendCustomerMessage] 发送客服消息失败:', err)
    console.error('[SendCustomerMessage] 错误详情:', {
      message: err.message,
      stack: err.stack,
      code: err.errCode,
      errMsg: err.errMsg
    })
    return {
      code: 500,
      message: err.message || '发送失败',
      data: null
    }
  }
}

/**
 * 将云存储的文件转换为微信临时素材的 media_id
 * @param {string} fileId - 云存储的 fileID (cloud://...)
 * @returns {Promise<{success: boolean, media_id?: string, message?: string}>}
 */
async function convertCloudFileToMedia(fileId) {
  const https = require('https')
  const http = require('http')
  const { URL } = require('url')
  
  try {
    console.log('[convertCloudFileToMedia] 开始转换:', fileId)
    
    // 获取云存储的 download URL
    const downloadRes = await cloud.getTempFileURL({
      fileList: [fileId]
    })
    
    console.log('[convertCloudFileToMedia] 获取下载链接结果:', JSON.stringify(downloadRes))
    
    if (!downloadRes.fileList || downloadRes.fileList.length === 0) {
      return { success: false, message: '获取文件下载链接失败' }
    }
    
    const fileInfo = downloadRes.fileList[0]
    
    if (fileInfo.status !== 0 || !fileInfo.tempFileURL) {
      return { success: false, message: '文件下载链接无效: ' + (fileInfo.errMsg || '未知错误') }
    }
    
    const tempFileURL = fileInfo.tempFileURL
    console.log('[convertCloudFileToMedia] 下载链接:', tempFileURL)
    
    // 确定文件类型
    let fileType = 'image'
    if (fileId.endsWith('.mp3') || fileId.endsWith('.amr') || fileId.endsWith('.m4a')) {
      fileType = 'voice'
    } else if (fileId.endsWith('.mp4') || fileId.endsWith('.avi') || fileId.endsWith('.mov')) {
      fileType = 'video'
    }
    
    // 下载文件内容
    const buffer = await downloadFile(tempFileURL)
    console.log('[convertCloudFileToMedia] 文件大小:', buffer.length)
    
    // 确定 MIME 类型
    let contentType = 'image/jpeg'
    if (fileId.endsWith('.png')) {
      contentType = 'image/png'
    } else if (fileId.endsWith('.gif')) {
      contentType = 'image/gif'
    } else if (fileId.endsWith('.mp3')) {
      contentType = 'audio/mpeg'
    } else if (fileId.endsWith('.amr')) {
      contentType = 'audio/amr'
    } else if (fileId.endsWith('.m4a')) {
      contentType = 'audio/m4a'
    } else if (fileId.endsWith('.mp4')) {
      contentType = 'video/mp4'
    }
    
    // 使用云调用上传临时素材
    const mediaRes = await cloud.openapi({
      appid: appid
    }).officialAccount.media.upload({
      type: fileType,
      media: {
        contentType: contentType,
        value: buffer
      }
    })
    
    console.log('[convertCloudFileToMedia] 上传结果:', JSON.stringify(mediaRes))
    
    if (mediaRes.errCode && mediaRes.errCode !== 0) {
      return { success: false, message: '上传失败: ' + (mediaRes.errMsg || '未知错误') }
    }
    
    if (!mediaRes.mediaId) {
      return { success: false, message: '上传结果中没有 mediaId' }
    }
    
    console.log('[convertCloudFileToMedia] 上传临时素材成功，mediaId:', mediaRes.mediaId)
    
    // 将文件上传到云存储保存（临时素材只保存3天）
    const fs = require('fs')
    const ext = fileId.split('.').pop() || 'jpg'
    const tmpFileName = '/tmp/media_' + Date.now() + '_' + Math.random().toString(36).substr(2) + '.' + ext
    fs.writeFileSync(tmpFileName, buffer)
    console.log('[convertCloudFileToMedia] 写入临时文件:', tmpFileName)
    
    const cloudPath = 'customer-service-media/' + Date.now() + '_' + Math.random().toString(36).substr(2, 8) + '.' + ext
    console.log('[convertCloudFileToMedia] 上传到云存储路径:', cloudPath)
    
    const uploadRes = await cloud.uploadFile({
      cloudPath: cloudPath,
      fileContent: buffer
    })
    console.log('[convertCloudFileToMedia] 云存储上传结果:', JSON.stringify(uploadRes))
    
    // 清理临时文件
    try {
      fs.unlinkSync(tmpFileName)
    } catch (e) {
      console.log('[convertCloudFileToMedia] 清理临时文件失败:', e.message)
    }
    
    console.log('[convertCloudFileToMedia] 完成，cloudFileId:', uploadRes.fileID)
    return { success: true, media_id: mediaRes.mediaId, cloud_file_id: uploadRes.fileID }
    
  } catch (err) {
    console.error('[convertCloudFileToMedia] 转换失败:', err)
    return { success: false, message: err.message || '转换过程出错' }
  }
}

/**
 * 使用 Node.js 原生模块下载文件
 */
function downloadFile(url) {
  const https = require('https')
  const http = require('http')
  const { URL } = require('url')
  
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const protocol = parsedUrl.protocol === 'https:' ? https : http
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    }
    
    const chunks = []
    
    const req = protocol.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error('下载失败，状态码: ' + res.statusCode))
        return
      }
      
      res.on('data', (chunk) => {
        chunks.push(chunk)
      })
      
      res.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
    })
    
    req.on('error', reject)
    req.end()
  })
}
