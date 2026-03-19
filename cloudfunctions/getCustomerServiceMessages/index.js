// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[GetCustomerServiceMessages] ===== 获取用户客服消息 =====')

  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const { openid } = event

  if (!openid) {
    return {
      code: 400,
      message: '用户 openid 不能为空',
      data: null
    }
  }

  try {
    console.log('[GetCustomerServiceMessages] 查询 openid:', openid)

    // 查询该用户的所有消息
    const result = await db.collection('customer_service_messages')
      .where({
        openid: openid
      })
      .get()

    console.log('[GetCustomerServiceMessages] 查询结果:', result.data.length, '条记录')

    if (result.data.length === 0) {
      return {
        code: 0,
        message: 'success',
        data: {
          openid: openid,
          messages: []
        }
      }
    }

    const messages = result.data[0].messages || []
    
    // 按时间排序
    messages.sort((a, b) => {
      const timeA = new Date(a.created_at).getTime()
      const timeB = new Date(b.created_at).getTime()
      return timeA - timeB
    })

    return {
      code: 0,
      message: 'success',
      data: {
        openid: openid,
        messages: messages
      }
    }
  } catch (err) {
    console.error('[GetCustomerServiceMessages] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
