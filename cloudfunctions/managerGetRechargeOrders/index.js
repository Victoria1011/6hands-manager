// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerGetRechargeOrders] ===== 获取用户订单 =====')

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
    console.log('[ManagerGetRechargeOrders] 查询 openid:', openid)

    // 查询用户订单
    const result = await db.collection('recharge_orders')
      .where({
        openid: openid
      })
      .get()

    console.log('[ManagerGetRechargeOrders] 查询结果:', result.data.length, '条记录')

    if (result.data.length === 0) {
      return {
        code: 0,
        message: 'success',
        data: {
          openid: openid,
          orders: []
        }
      }
    }

    // 获取所有订单记录的 orders 字段
    const allOrders = []
    result.data.forEach(record => {
      const orders = record.orders || []
      if (Array.isArray(orders)) {
        allOrders.push(...orders)
      }
    })

    // 按时间倒序排序（最新的在前）
    allOrders.sort((a, b) => {
      const timeA = new Date(a.created_at || a.updated_at).getTime()
      const timeB = new Date(b.created_at || b.updated_at).getTime()
      return timeB - timeA
    })

    return {
      code: 0,
      message: 'success',
      data: {
        openid: openid,
        orders: allOrders
      }
    }
  } catch (err) {
    console.error('[ManagerGetRechargeOrders] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
