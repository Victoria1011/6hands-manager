// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerGetRefundList] ===== 开始获取退款列表 =====')
  console.log('[ManagerGetRefundList] 事件参数:', JSON.stringify(event))

  const wxContext = cloud.getWXContext()
  console.log('[ManagerGetRefundList] wxContext:', wxContext)

  const { token, openid } = event

  try {
    // 验证 token
    const auth = requireAuth(event)
    if (!auth.success) {
      return {
        code: 401,
        message: '未授权，请先登录',
        data: null
      }
    }

    console.log('[ManagerGetRefundList] 用户 openid:', openid)

    // 查询 refund_list 集合（每条数据是一个退款申请）
    const refundListResult = await db.collection('refund_list').get()
    console.log('[ManagerGetRefundList] refund_list 查询结果数量:', refundListResult.data.length)

    const refunds = refundListResult.data

    console.log('[ManagerGetRefundList] 退款列表数量:', refunds.length)
    console.log('[ManagerGetRefundList] 待审核数量:', refunds.filter(r => r.status === 'reviewing').length)

    return {
      code: 0,
      message: '获取成功',
      data: {
        refunds: refunds
      }
    }

  } catch (err) {
    console.error('[ManagerGetRefundList] 获取退款列表失败:', err)
    return {
      code: -1,
      message: err.message || '获取失败'
    }
  }
}
