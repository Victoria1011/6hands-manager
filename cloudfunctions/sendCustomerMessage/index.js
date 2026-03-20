// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

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
        if (!msgData || !msgData.media_id) {
          return {
            code: 400,
            message: '图片消息需要 media_id',
            data: null
          }
        }
        sendParams.image = {
          media_id: msgData.media_id
        }
        break

      case 'voice':
        if (!msgData || !msgData.media_id) {
          return {
            code: 400,
            message: '语音消息需要 media_id',
            data: null
          }
        }
        sendParams.voice = {
          media_id: msgData.media_id
        }
        break

      case 'video':
        if (!msgData || !msgData.media_id) {
          return {
            code: 400,
            message: '视频消息需要 media_id',
            data: null
          }
        }
        sendParams.video = {
          media_id: msgData.media_id,
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
    console.log('[SendCustomerMessage] 发送消息参数 0 :', sendParams)

    // 使用云调用 API 发送客服消息，指定来源方 AppID
    const result = await cloud.openapi({
      appid: 'wx126d0f048410f694'
    }).customerServiceMessage.send(sendParams)

    console.log('[SendCustomerMessage] 发送结果:', result)

    // 保存发送记录到数据库
    const messageRecord = {
      type: 'customer_to_user',
      openid: openid,
      msg_type: msgtype,
      content: content || '',
      msg_data: msgData || {},
      send_result: {
        errcode: result.errcode,
        errmsg: result.errmsg
      },
      success: result.errcode === 0,
      created_at: new Date().toISOString()
    }

    await db.collection('customer_service_messages').where({
      openid: openid
    }).update({
      data: {
        messages: db.command.push(messageRecord),
        updated_at: new Date().toISOString()
      }
    })

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
