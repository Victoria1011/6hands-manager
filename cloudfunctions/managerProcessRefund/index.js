// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerProcessRefund] ===== 开始处理退款 =====')
  console.log('[ManagerProcessRefund] 事件参数:', JSON.stringify(event))

  const wxContext = cloud.getWXContext()
  console.log('[ManagerProcessRefund] wxContext:', wxContext)

  const { refundId, status, rejectReason, token, openid, coins } = event

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

    console.log('[ManagerProcessRefund] 用户 openid:', openid)
    console.log('[ManagerProcessRefund] 处理退款ID:', refundId, '状态:', status)

    // 查询 refund_list 集合（每条记录是一个退款申请）
    // 先根据 _id 查找对应的文档
    const refundRecordResult = await db.collection('refund_list').doc(refundId).get()
    const refundRecord = refundRecordResult.data

    if (!refundRecord) {
      console.log('[ManagerProcessRefund] 未找到退款ID:', refundId)
      return {
        code: 404,
        message: '退款申请不存在'
      }
    }

    console.log('[ManagerProcessRefund] 找到退款记录:', refundRecord._id)

    // 准备更新数据
    const updateData = {
      status: status,
      updated_at: new Date().toISOString()
    }

    // 如果是驳回且提供了驳回原因
    if (status === 'rejected' && rejectReason) {
      updateData.reject_reason = rejectReason
    }

    // 如果是同意或完成，记录完成时间
    if (status === 'approved' || status === 'completed') {
      updateData.completed_at = new Date().toISOString()
    }

    console.log('[ManagerProcessRefund] 更新数据:', updateData)

    // 如果状态改为 approved，需要处理 coins 数据库
    if (status === 'approved') {
      console.log('[ManagerProcessRefund] 状态改为 approved，开始处理 coins 数据库')

      if (!openid) {
        console.log('[ManagerProcessRefund] 退款记录中没有 openid')
        return {
          code: 400,
          message: '退款记录缺少 openid 信息'
        }
      }

      if (!coins) {
        console.log('[ManagerProcessRefund] 退款记录中没有 coins 数量')
        return {
          code: 400,
          message: '退款记录缺少元宝数量信息'
        }
      }

      console.log('[ManagerProcessRefund] 用户 openid:', openid, '退款元宝数量:', coins)

      // 查询 coins 数据库中该用户的记录
      const coinsRecordResult = await db.collection('coins').where({
        openid: openid
      }).get()

      if (coinsRecordResult.data.length === 0) {
        console.log('[ManagerProcessRefund] 未找到该用户的 coins 记录')
        return {
          code: 404,
          message: '未找到该用户的元宝记录'
        }
      }

      const coinsRecord = coinsRecordResult.data[0]
      const currentRefundCoins = coinsRecord.refund_coins || 0

      console.log('[ManagerProcessRefund] 当前退款元宝累计:', currentRefundCoins)

      // 更新 coins 记录：清零相关字段，增加 refund_coins
      await db.collection('coins').doc(coinsRecord._id).update({
        data: {
          total_earn: 0,
          total_spend: 0,
          balance: 0,
          total_checkin_earn: 0,
          total_gift_earn: 0,
          total_watchad_earn: 0,
          refund_coins: currentRefundCoins + coins,
          updated_at: new Date().toISOString()
        }
      })

      console.log('[ManagerProcessRefund] coins 数据库更新成功')
    }

    // 更新数据库
    await db.collection('refund_list').doc(refundId).update({
      data: updateData
    })
    // 6. 更新用户状态为退款审核中
    await db.collection('users').where({
      openid: openid
    }).update({
      data: {
        refund_status: 'approved',
        refund_id: refundId,
        updated_at: new Date().toISOString()
      }
    })
    await db.collection('recharge_orders').where({
      _id: doc._id
    }).update({
      data: {
        orders: ordersNeedUpdate.map(order => ({
          ...order,
          refund_status: 'approved', // 标记为审核中
          refund_id: refundId // 记录退款申请ID
        }))
      }
    })
    console.log('[ManagerProcessRefund] 更新成功')

    return {
      code: 0,
      message: '处理成功'
    }

  } catch (err) {
    console.error('[ManagerProcessRefund] 处理退款失败:', err)
    return {
      code: -1,
      message: err.message || '处理失败'
    }
  }
}
