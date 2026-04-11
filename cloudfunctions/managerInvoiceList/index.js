// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerInvoiceList] ===== 获取发票列表 =====')
  console.log('[ManagerInvoiceList] event:', event)

  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const {
    page = 1,
    pageSize = 10,
    status = null,
    keyword = null
  } = event

  try {
    const skip = (page - 1) * pageSize

    // 构建查询条件
    const whereCondition = {}

    if (status && status !== 'all') {
      whereCondition.status = status
    }

    // 关键词搜索（发票号、抬头、税号）
    if (keyword) {
      whereCondition.title = db.RegExp({
        regexp: keyword,
        options: 'i'
      })
    }

    console.log('[ManagerInvoiceList] 查询条件:', whereCondition)
    console.log('[ManagerInvoiceList] 分页参数:', { page, pageSize, skip })

    // 查询总数
    const countResult = await db.collection('invoice_list')
      .where(whereCondition)
      .count()

    const total = countResult.total
    console.log('[ManagerInvoiceList] 总数:', total)

    // 查询数据列表
    const result = await db.collection('invoice_list')
      .where(whereCondition)
      .orderBy('created_at', 'desc')
      .skip(skip)
      .limit(pageSize)
      .get()

    console.log('[ManagerInvoiceList] 查询结果:', result.data.length, '条记录')

    // 关联查询订单详情
    const invoiceList = await Promise.all(result.data.map(async (invoice) => {
      try {
        // 根据 openid 查询该用户的充值订单
        const rechargeOrdersResult = await db.collection('recharge_orders')
          .where({
            openid: invoice.openid
          })
          .get()

        let relatedOrders = []

        if (rechargeOrdersResult.data.length > 0) {
          const allOrders = rechargeOrdersResult.data[0].orders || []
          
          // 根据 order_nos 过滤出关联的订单
          relatedOrders = allOrders.filter(order => 
            invoice.order_nos && invoice.order_nos.includes(order.order_no)
          )

          // 格式化订单信息
          relatedOrders = relatedOrders.map(order => ({
            order_no: order.order_no,
            amount: (order.amount / 100).toFixed(2),
            package_name: order.product_name || '',
            pay_time: order.paid_at,
            status: order.status,
            refund_status: order.refund_status
          }))
        }

        return {
          ...invoice,
          related_orders: relatedOrders
        }
      } catch (err) {
        console.error('[ManagerInvoiceList] 查询订单详情失败:', err)
        return {
          ...invoice,
          related_orders: []
        }
      }
    }))

    return {
      code: 0,
      message: 'success',
      data: {
        list: invoiceList,
        total: total,
        page: page,
        pageSize: pageSize,
        hasMore: skip + result.data.length < total
      }
    }
  } catch (err) {
    console.error('[ManagerInvoiceList] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
