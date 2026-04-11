// 云函数入口文件
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 企业微信机器人 Webhook URL
const QY_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ea6d8cc7-b50b-4072-9f8e-eb830e5b6a90'

/**
 * 发送消息到企业微信机器人
 * @param {Object} messageData - 消息数据
 */
async function sendToQyWebhook(messageData) {
  return new Promise((resolve, reject) => {
    try {
      // 构建消息内容（Markdown 格式）
      let content = ''

      // 根据消息类型格式化内容
      if (messageData.msg_type === 'image') {
        
        content += '**🔗 图片链接：**\n> [点击查看](' + messageData.image_url + ')\n\n'
        content += '![](' + messageData.image_url + ')\n\n'
        content += '**📷 消息类型：**> 图片\n\n'
      } else if (messageData.msg_type === 'miniprogramapp') {
       
        content += '**📝 标题：**> ' + (messageData.content || '-') + '\n\n'
        content += '**📂 AppID：**> `' + messageData.app_id + '`\n\n'
        content += '**🛣️ 页面路径：**> `' + messageData.page_path + '`\n\n'
        content += '**📱 消息类型：**> 小程序卡片\n\n'
      } else {
        content += (messageData.content || '(空)') + '\n\n'
        content += '**💬 消息类型：**> 文本\n\n'
      }

      content += new Date(messageData.create_time).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }) + '\n\n\n'
      content += `**👤 用户 OpenID**\n> \`${messageData.from_openid}\`\n\n`

      const payload = {
        msgtype: 'markdown',
        markdown: {
          content: content
        }
      }

      const postData = JSON.stringify(payload)
      const url = new URL(QY_WEBHOOK_URL)

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }

      console.log('[CustomerServiceCallback] 发送到企业微信机器人')

      const req = https.request(options, (res) => {
        let responseData = ''

        res.on('data', (chunk) => {
          responseData += chunk
        })

        res.on('end', () => {
          try {
            const result = JSON.parse(responseData)
            console.log('[CustomerServiceCallback] 企业微信响应:', JSON.stringify(result))

            if (res.statusCode === 200 && result.errcode === 0) {
              resolve(result)
            } else {
              reject(new Error(`企业微信推送失败: ${res.statusCode} - ${responseData}`))
            }
          } catch (err) {
            console.error('[CustomerServiceCallback] 解析企业微信响应失败:', err)
            reject(err)
          }
        })
      })

      req.on('error', (error) => {
        console.error('[CustomerServiceCallback] 企业微信请求失败:', error)
        reject(error)
      })

      req.write(postData)
      req.end()
    } catch (err) {
      console.error('[CustomerServiceCallback] 发送到企业微信异常:', err)
      reject(err)
    }
  })
}

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[CustomerServiceCallback] ===== 收到客服消息回调 =====')
  console.log('[CustomerServiceCallback] 完整事件对象:', JSON.stringify(event))
  console.log('[CustomerServiceCallback] 事件对象键:', Object.keys(event))

  // 解构消息字段
  const {
    FromUserName,    // 发送者 openid
    ToUserName,      // 接收者（小程序）
    Content,         // 消息内容
    CreateTime,      // 创建时间
    MsgId,           // 消息ID
    MsgType          // 消息类型
  } = event

  console.log('[CustomerServiceCallback] ===== 消息详情 =====', event)

  try {
    let messageData = {}

    // 处理不同类型的消息
    if (MsgType === 'image') {
      // 图片消息：直接保存图片 URL
      const { PicUrl, MediaId } = event
      console.log('[CustomerServiceCallback] 处理图片消息')

      messageData = {
        from_openid: FromUserName,
        to_username: ToUserName,
        content: '',
        image_url: PicUrl, // 直接保存原始图片 URL
        create_time: CreateTime ? new Date(CreateTime * 1000).toISOString() : new Date().toISOString(),
        msg_id: MsgId,
        msg_type: 'image',
        media_id: MediaId,
        raw_event: event,
        created_at: new Date().toISOString()
      }

    } else if (MsgType === 'miniprogrampage' || MsgType === 1) {
      // 小程序卡片消息
      const { Title, AppId, PagePath, ThumbMediaId, ThumbUrl } = event
      console.log('[CustomerServiceCallback] 处理小程序卡片消息')

      messageData = {
        from_openid: FromUserName,
        to_username: ToUserName,
        content: Title || '',
        app_id: AppId, // 小程序 AppId
        page_path: PagePath, // 小程序页面路径
        thumb_media_id: ThumbMediaId, // 缩略图媒体 ID
        thumb_url: ThumbUrl, // 缩略图 URL
        create_time: CreateTime ? new Date(CreateTime * 1000).toISOString() : new Date().toISOString(),
        msg_id: MsgId,
        msg_type: 'miniprogramapp',
        raw_event: event,
        created_at: new Date().toISOString()
      }

      // 发送支付链接卡片回复（文本消息）
      try {
        console.log('[CustomerServiceCallback] 发送支付链接')
        console.log('[CustomerServiceCallback] PagePath:', PagePath)

        // 根据 PagePath 结尾判断是哪个套餐
        let sendContent = ''
        if (PagePath && PagePath.endsWith('product1')) {
          sendContent = `购买入门套餐：
<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=1">点我购买: 
入门套餐 ¥1 (1万元宝)</a>`
        } else if (PagePath && PagePath.endsWith('product2')) {
          sendContent = `购买标准套餐：
<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=2">点我购买:
标准套餐 ¥10 (10万元宝 + 赠送1万元宝)</a>`
        } else if (PagePath && PagePath.endsWith('product3')) {
          sendContent = `购买畅享套餐：
<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=3">点我购买:
畅享套餐 ¥100 (100万元宝 + 赠送15万元宝)</a>`
        } else {
          // 默认显示所有套餐
          sendContent = `点击下方套餐购买元宝：
<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=1">入门套餐 ¥1 (1万元宝)</a>

<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=2">标准套餐 ¥10 (10万元宝 + 赠送 1 万元宝)</a>

<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=3">畅享套餐 ¥100 (100万元宝 + 赠送 20 万元宝)</a>`
        }

        console.log('[CustomerServiceCallback] sendContent:', sendContent)

        const payResult = await cloud.openapi({
          appid: 'wx126d0f048410f694'
        }).customerServiceMessage.send({
          touser: FromUserName,
          msgtype: 'text',
          "text":
          {
            "content": sendContent
          }
        })
        console.log('[CustomerServiceCallback] 支付链接发送结果:', payResult)

        // 保存支付链接消息记录
        const payMessageRecord = {
          type: 'customer_to_user',
          msg_type: 'text',
          content: '点击前往支付',
          send_result: {
            errcode: payResult.errcode,
            errmsg: payResult.errmsg
          },
          success: payResult.errcode === 0,
          created_at: new Date().toISOString()
        }

        // 更新数据库，添加支付链接消息
        await db.collection('customer_service_messages').where({
          openid: FromUserName
        }).update({
          data: {
            messages: db.command.push(payMessageRecord),
            updated_at: new Date().toISOString()
          }
        })
        console.log('[CustomerServiceCallback] 支付链接消息已保存')
      } catch (err) {
        console.error('[CustomerServiceCallback] 发送支付链接失败:', err)
      }

    } else {
      // 文本消息
      messageData = {
        from_openid: FromUserName,
        to_username: ToUserName,
        content: Content || '',
        create_time: CreateTime ? new Date(CreateTime * 1000).toISOString() : new Date().toISOString(),
        msg_id: MsgId,
        msg_type: MsgType || 'text',
        raw_event: event, // 保存原始事件数据
        created_at: new Date().toISOString()
      }
    }

    console.log('[CustomerServiceCallback] 准备保存消息数据:', JSON.stringify(messageData))

    // 保存消息到数据库
    if (FromUserName && MsgId) {
      // 查询是否已有该用户的消息记录
      const result = await db.collection('customer_service_messages').where({
        openid: FromUserName
      }).get()

      if (result.data.length === 0) {
        // 创建新记录
        console.log('[CustomerServiceCallback] 创建新消息记录')
        await db.collection('customer_service_messages').add({
          data: {
            openid: FromUserName,
            messages: [messageData],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        })
      } else {
        // 更新现有记录，添加新消息
        console.log('[CustomerServiceCallback] 更新现有消息记录')
        await db.collection('customer_service_messages').where({
          openid: FromUserName
        }).update({
          data: {
            messages: db.command.push(messageData),
            updated_at: new Date().toISOString()
          }
        })
      }

      console.log('[CustomerServiceCallback] 消息保存成功')

      // 推送到企业微信机器人
      try {
        await sendToQyWebhook(messageData)
        console.log('[CustomerServiceCallback] 企业微信推送成功')
      } catch (qyErr) {
        console.error('[CustomerServiceCallback] 企业微信推送失败:', qyErr)
        // 企业微信推送失败不影响主流程
      }
    } else {
      console.warn('[CustomerServiceCallback] 消息缺少必要字段 FromUserName 或 MsgId')
    }

    console.log('[CustomerServiceCallback] ===== 处理完成 =====')

    // 返回成功响应
    return {
      errcode: 0,
      errmsg: 'success'
    }

  } catch (err) {
    console.error('[CustomerServiceCallback] 处理失败:', err)
    console.error('[CustomerServiceCallback] 错误堆栈:', err.stack)
    return {
      errcode: -1,
      errmsg: err.message || '处理失败'
    }
  }
}
