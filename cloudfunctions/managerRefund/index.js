// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

/**
 * 微信支付退款（云调用方式）
 * @param {String} outTradeNo - 商户订单号
 * @param {String} outRefundNo - 商户退款单号
 * @param {Number} totalFee - 订单总金额（单位：分）
 * @param {Number} refundFee - 退款金额（单位：分）
 * @returns {Promise} 退款结果
 */
async function wechatPayRefund(outTradeNo, outRefundNo, totalFee, refundFee) {
  try {
    console.log('[ManagerRefund] 调用云支付退款:', {
      outTradeNo,
      outRefundNo,
      totalFee,
      refundFee
    })

    // 使用云调用方式退款
    const result = await cloud.cloudPay({ appid: 'wx126d0f048410f694' }).refund({
      out_trade_no: outTradeNo,
      out_refund_no: outRefundNo,
      total_fee: totalFee,
      sub_mch_id: process.env.MERCHANT_ID,
      refund_fee: refundFee
    })

    console.log('[ManagerRefund] 云支付退款成功:', result)

    return {
      success: true,
      refundId: result.refund_id,
      refundNo: result.out_refund_no
    }
  } catch (err) {
    console.error('[ManagerRefund] 云支付退款失败:', err)

    // 错误码说明：https://developers.weixin.qq.com/miniprogram/dev/api-backend/open-api/finance/pay.refund.html
    const errorCode = err.errCode || err.errcode
    const errorMsg = err.errMsg || err.errmsg

    let errorMessage = '退款失败'

    // 常见错误码处理
    if (errorCode === 'FAIL') {
      errorMessage = '退款申请失败'
    } else if (errorCode === 'PARAM_ERROR') {
      errorMessage = '参数错误'
    } else if (errorCode === 'ORDER_NOT_EXIST') {
      errorMessage = '订单不存在'
    } else if (errorCode === 'NO_AUTH') {
      errorMessage = '无退款权限'
    } else if (errorCode === 'NOTPAY') {
      errorMessage = '订单未支付'
    } else if (errorCode === 'REFUND_FREQ_LIMIT') {
      errorMessage = '退款频率过高'
    } else if (errorMsg) {
      errorMessage = errorMsg
    }

    throw new Error(errorMessage)
  }
}

// 云函数入口函数
exports.main = async (event, _context) => {
  console.log('[ManagerRefund] ===== 开始处理退款 =====')
  console.log('[ManagerRefund] 事件参数:', JSON.stringify(event))

  const { refundId, refundAmount, refundOrders, openid } = event

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

    // 查询退款记录
    const refundRecordResult = await db.collection('refund_list').doc(refundId).get()
    const refundRecord = refundRecordResult.data

    if (!refundRecord) {
      console.log('[ManagerRefund] 未找到退款ID:', refundId)
      return {
        code: 404,
        message: '退款申请不存在'
      }
    }

    // 检查退款状态
    if (refundRecord.status !== 'approved') {
      return {
        code: 400,
        message: '退款状态不正确，只能处理已通过审核的退款'
      }
    }

    if (!refundOrders || refundOrders.length === 0) {
      return {
        code: 400,
        message: '退款订单信息不能为空'
      }
    }

    console.log('[ManagerRefund] 退款订单数量:', refundOrders.length)

    // 处理每个订单的退款
    const refundResults = []

    for (let i = 0; i < refundOrders.length; i++) {
      const refundOrder = refundOrders[i]

      try {
        // 生成退款单号
        const outRefundNo = `REF${Date.now()}${i}`

        // 转换为分（传入的 refund_amount 单位已经是元）
        const orderAmount = Math.round(parseFloat(refundOrder.amount) * 100)
        const refundOrderAmount = Math.round(parseFloat(refundOrder.refund_amount) * 100)

        console.log('[ManagerRefund] 订单退款详情:', {
          order_no: refundOrder.order_no,
          order_amount: orderAmount,
          refund_amount: refundOrderAmount
        })

        // 调用微信支付退款（云调用）
        const wechatResult = await wechatPayRefund(
          refundOrder.order_no,
          outRefundNo,
          orderAmount,
          refundOrderAmount
        )

        refundResults.push({
          order_no: refundOrder.order_no,
          success: true,
          refund_id: wechatResult.refundId,
          out_refund_no: wechatResult.refundNo,
          refund_amount: refundOrder.refund_amount
        })

        console.log('[ManagerRefund] 订单退款成功:', refundOrder.order_no)
      } catch (err) {
        console.error('[ManagerRefund] 订单退款失败:', refundOrder.order_no, err.message)
        refundResults.push({
          order_no: refundOrder.order_no,
          success: false,
          error: err.message
        })

        // 如果有任何一个订单退款失败，标记整个退款为失败
        throw new Error(`订单 ${refundOrder.order_no} 退款失败：${err.message}`)
      }
    }

    // 更新退款记录状态为已完成
    await db.collection('refund_list').doc(refundId).update({
      data: {
        status: 'completed',
        refund_amount: refundAmount,
        refund_orders: refundOrders,
        refund_results: refundResults,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    })
    // 6. 更新用户状态
    await db.collection('users').where({
      openid: openid
    }).update({
      data: {
        refund_status: null,
        updated_at: new Date().toISOString()
      }
    })
    await db.collection('recharge_orders').where({
      _id: doc._id
    }).update({
      data: {
        orders: ordersNeedUpdate.map(order => ({
          ...order,
          refund_status: 'completed', // 恢复为未退款
          refund_id: refundId // 清空退款申请ID
        }))
      }
    })
    console.log('[ManagerRefund] 退款记录更新成功')

    return {
      code: 0,
      message: '退款成功',
      data: {
        refundId: refundId,
        refundAmount: refundAmount,
        refundResults: refundResults
      }
    }

  } catch (err) {
    console.error('[ManagerRefund] 处理退款失败:', err)

    // 如果退款失败，更新退款记录状态
    // try {
    //   await db.collection('refund_list').doc(refundId).update({
    //     data: {
    //       status: 'failed',
    //       error_message: err.message,
    //       updated_at: new Date().toISOString()
    //     }
    //   })
    // } catch (updateErr) {
    //   console.error('[ManagerRefund] 更新退款失败状态失败:', updateErr)
    // }

    return {
      code: -1,
      message: err.message || '退款失败',
      data: null
    }
  }
}
