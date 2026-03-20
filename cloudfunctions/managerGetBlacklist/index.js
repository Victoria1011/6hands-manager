// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerGetBlacklist] ===== 检查用户是否在黑名单 =====')

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
    console.log('[ManagerGetBlacklist] 查询 openid:', openid)

    // 查询用户是否在黑名单
    const result = await db.collection('black_list')
      .where({
        openid: openid
      })
      .get()

    console.log('[ManagerGetBlacklist] 查询结果:', result.data.length, '条记录')
    console.log('[ManagerGetBlacklist] 查询到的数据:', JSON.stringify(result.data))

    const isInBlacklist = result.data.length > 0

    if (isInBlacklist) {
      console.log('[ManagerGetBlacklist] 黑名单原因:', result.data[0].reason)
    }

    return {
      code: 0,
      message: 'success',
      data: {
        openid: openid,
        isInBlacklist: isInBlacklist,
        blacklistData: isInBlacklist ? result.data[0] : null
      }
    }
  } catch (err) {
    console.error('[ManagerGetBlacklist] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
