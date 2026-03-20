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

  const { openid } = event

  if (!openid) {
    return {
      code: 400,
      message: '用户 openid 不能为空',
      data: null
    }
  }

  try {
    console.log('[ManagerGetCoins] 查询 openid:', openid)

    // 查询用户元宝数据
    const result = await db.collection('coins')
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
          balance: 0,
          created_at: ''
        }
      }
    }

    const coinData = result.data[0]
    const balance = coinData.balance || 0
    const createdAt = coinData.created_at || ''

    return {
      code: 0,
      message: 'success',
      data: coinData
    }
  } catch (err) {
    console.error('[ManagerGetCoins] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
