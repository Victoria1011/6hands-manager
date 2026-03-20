// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerRemoveBlacklist] ===== 从黑名单移除用户 =====')

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
    console.log('[ManagerRemoveBlacklist] 移除 openid:', openid)

    // 从黑名单移除
    const result = await db.collection('black_list')
      .where({
        openid: openid
      })
      .remove()

    console.log('[ManagerRemoveBlacklist] 移除结果:', result)

    if (result.stats.removed > 0) {
      return {
        code: 0,
        message: '移除黑名单成功',
        data: {
          openid: openid,
          removed: result.stats.removed
        }
      }
    } else {
      return {
        code: 400,
        message: '用户不在黑名单中',
        data: null
      }
    }
  } catch (err) {
    console.error('[ManagerRemoveBlacklist] 移除失败:', err)
    return {
      code: 500,
      message: err.message || '移除失败',
      data: null
    }
  }
}
