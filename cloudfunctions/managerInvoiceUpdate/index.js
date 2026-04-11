// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 发票状态映射
const STATUS_TEXT_MAP = {
  'reviewing': '审核中',
  'invoicing': '开票中',
  'completed': '开票完成'
}

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerInvoiceUpdate] ===== 更新发票状态 =====')
  console.log('[ManagerInvoiceUpdate] event:', event)

  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const {
    invoice_id,
    status,
    invoice_no = null,
    invoice_url = null
  } = event

  if (!invoice_id) {
    return {
      code: 400,
      message: '发票 ID 不能为空',
      data: null
    }
  }

  if (!status || !['reviewing', 'invoicing', 'completed'].includes(status)) {
    return {
      code: 400,
      message: '状态不能为空或无效',
      data: null
    }
  }

  try {
    const updateData = {
      status: status,
      status_text: STATUS_TEXT_MAP[status],
      updated_at: new Date().toISOString()
    }

    // 如果提供了发票编号，更新发票编号
    if (invoice_no) {
      updateData.invoice_no = invoice_no
    }

    // 如果提供了发票链接，更新发票链接
    if (invoice_url) {
      updateData.invoice_url = invoice_url
    }

    console.log('[ManagerInvoiceUpdate] 更新发票数据:', updateData)

    // 先查询发票信息，获取 openid 和 order_nos
    const invoiceResult = await db.collection('invoice_list')
      .doc(invoice_id)
      .get()

    if (!invoiceResult.data) {
      return {
        code: 404,
        message: '发票不存在',
        data: null
      }
    }

    const invoice = invoiceResult.data

    // 更新发票状态
    const result = await db.collection('invoice_list')
      .doc(invoice_id)
      .update({
        data: updateData
      })

    console.log('[ManagerInvoiceUpdate] 发票状态更新成功')

    // 更新 recharge_orders 中对应订单的发票状态
    if (invoice.openid && invoice.order_nos && invoice.order_nos.length > 0) {
      console.log('[ManagerInvoiceUpdate] 开始更新订单发票状态, openid:', invoice.openid, '订单号:', invoice.order_nos)

      // 查询用户的充值订单
      const rechargeOrdersResult = await db.collection('recharge_orders')
        .where({
          openid: invoice.openid
        })
        .get()

      if (rechargeOrdersResult.data.length > 0) {
        const rechargeOrder = rechargeOrdersResult.data[0]
        const orders = rechargeOrder.orders || []

        // 更新对应订单的发票状态、发票号和发票链接
        const updatedOrders = orders.map(order => {
          if (invoice.order_nos.includes(order.order_no)) {
            return {
              ...order,
              invoice_status: status,
              invoice_no: invoice_no || null,
              invoice_url: invoice_url || null
            }
          }
          return order
        })

        // 保存更新后的订单列表
        await db.collection('recharge_orders')
          .doc(rechargeOrder._id)
          .update({
            data: {
              orders: updatedOrders
            }
          })

        console.log('[ManagerInvoiceUpdate] 订单发票状态更新成功')
      }
    }

    return {
      code: 0,
      message: '更新成功',
      data: {
        stats: result.stats
      }
    }
  } catch (err) {
    console.error('[ManagerInvoiceUpdate] 更新失败:', err)
    return {
      code: 500,
      message: err.message || '更新失败',
      data: null
    }
  }
}
