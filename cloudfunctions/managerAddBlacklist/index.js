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
  console.log('[ManagerAddBlacklist] ===== 添加用户到黑名单 =====')

  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const { openid, reason } = event

  if (!openid) {
    return {
      code: 400,
      message: '用户 openid 不能为空',
      data: null
    }
  }

  if (!reason || reason.trim() === '') {
    return {
      code: 400,
      message: '黑名单原因不能为空',
      data: null
    }
  }

  try {
    console.log('[ManagerAddBlacklist] 添加 openid:', openid, '原因:', reason)

    // 检查是否已在黑名单
    const existResult = await db.collection('black_list')
      .where({
        openid: openid
      })
      .get()

    if (existResult.data.length > 0) {
      return {
        code: 400,
        message: '用户已在黑名单中',
        data: null
      }
    }

    // 添加到黑名单
    const addResult = await db.collection('black_list').add({
      data: {
        openid: openid,
        reason: reason.trim(),
        created_at: new Date().toISOString(),
        created_by: auth.userInfo.userId
      }
    })

    console.log('[ManagerAddBlacklist] 添加成功, ID:', addResult._id)

    return {
      code: 0,
      message: '添加黑名单成功',
      data: {
        openid: openid,
        _id: addResult._id
      }
    }
  } catch (err) {
    console.error('[ManagerAddBlacklist] 添加失败:', err)
    return {
      code: 500,
      message: err.message || '添加失败',
      data: null
    }
  }
}
