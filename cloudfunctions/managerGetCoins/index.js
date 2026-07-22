// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerGetCoins] ===== 获取用户元宝 =====')

  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const { openid, action } = event

  if (!openid) {
    return {
      code: 400,
      message: '用户 openid 不能为空',
      data: null
    }
  }

  try {
    console.log('[ManagerGetCoins] 查询 openid:', openid, 'action:', action)

    // 如果 action 是 transactions，获取元宝明细
    if (action === 'transactions') {
      return await getCoinTransactions(openid)
    }

    // 默认获取元宝余额
    return await getCoinBalance(openid)
  } catch (err) {
    console.error('[ManagerGetCoins] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}

// 获取元宝余额
async function getCoinBalance(openid) {
  try {
    console.log('[ManagerGetCoins] 查询元宝余额, openid:', openid)

    // 查询用户元宝数据
    const result = await db.collection('coins')
      .where({
        openid: openid
      })
      .get()

    console.log('[ManagerGetCoins] 查询结果:', result.data.length, '条记录')

    // 查询用户设备信息（users 集合中可能有 device_info）
    let deviceInfo = null
    try {
      const userResult = await db.collection('users')
        .where({ openid: openid })
        .get()
      if (userResult.data && userResult.data.length > 0) {
        deviceInfo = userResult.data[0].device_info || null
      }
    } catch (e) {
      console.error('[ManagerGetCoins] 查询用户设备信息失败:', e)
    }

    if (result.data.length === 0) {
      return {
        code: 0,
        message: 'success',
        data: {
          openid: openid,
          balance: 0,
          created_at: '',
          device_info: deviceInfo
        }
      }
    }

    const coinData = result.data[0]

    return {
      code: 0,
      message: 'success',
      data: { ...coinData, device_info: deviceInfo }
    }
  } catch (err) {
    console.error('[ManagerGetCoins] 查询元宝余额失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}

// 获取元宝明细
async function getCoinTransactions(openid) {
  try {
    console.log('[ManagerGetCoins] 查询元宝明细, openid:', openid)

    // 查询用户元宝明细数据
    const result = await db.collection('coin_transactions')
      .where({
        openid: openid
      })
      .get()

    console.log('[ManagerGetCoins] 查询结果:', result.data.length, '条记录')

    if (result.data.length === 0) {
      return {
        code: 0,
        message: 'success',
        data: {
          openid: openid,
          transactions: []
        }
      }
    }

    // 获取所有交易记录的 transactions 字段
    const allTransactions = []
    result.data.forEach(record => {
      const transactions = record.transactions || []
      if (Array.isArray(transactions)) {
        allTransactions.push(...transactions)
      }
    })

    // 按时间倒序排序（最新的在前）
    allTransactions.sort((a, b) => {
      const timeA = new Date(a.created_at || a.updated_at).getTime()
      const timeB = new Date(b.created_at || b.updated_at).getTime()
      return timeB - timeA
    })

    return {
      code: 0,
      message: 'success',
      data: {
        openid: openid,
        transactions: allTransactions
      }
    }
  } catch (err) {
    console.error('[ManagerGetCoins] 查询元宝明细失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
