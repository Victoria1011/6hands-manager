// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[GetCustomerServiceList] ===== 获取客服消息列表 =====')

  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  try {
    // 查询所有有客服消息的用户
    const result = await db.collection('customer_service_messages')
      .orderBy('updated_at', 'desc')
      .get()

    console.log('[GetCustomerServiceList] 查询结果:', result.data.length, '条记录')

    // 处理数据，为每个用户添加最新消息信息
    const list = result.data.map(item => {
      const messages = item.messages || []
      const lastMessage = messages[messages.length - 1] || {}
      
      return {
        openid: item.openid,
        last_message: lastMessage.content || lastMessage.msg_type || '',
        last_message_type: lastMessage.msg_type || 'text',
        last_time: item.updated_at,
        message_count: messages.length
      }
    })

    return {
      code: 0,
      message: 'success',
      data: list
    }
  } catch (err) {
    console.error('[GetCustomerServiceList] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
