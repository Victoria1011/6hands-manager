// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerGetLogs] ===== 获取用户日志 =====')

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
    console.log('[ManagerGetLogs] 查询 openid:', openid)

    // 查询用户日志
    const result = await db.collection('tts_clone_design_logs')
      .where({
        openid: openid
      })
      .get()

    console.log('[ManagerGetLogs] 查询结果:', result.data.length, '条记录')

    if (result.data.length === 0) {
      return {
        code: 0,
        message: 'success',
        data: {
          openid: openid,
          logs: []
        }
      }
    }

    // 获取第一条记录（一个 openid 只有一条数据）
    const record = result.data[0]
    const logs = record.logs || []

    // 按时间倒序排序（最新的在前）
    logs.sort((a, b) => {
      const timeA = new Date(a.created_at).getTime()
      const timeB = new Date(b.created_at).getTime()
      return timeB - timeA
    })

    return {
      code: 0,
      message: 'success',
      data: {
        openid: openid,
        logs: logs
      }
    }
  } catch (err) {
    console.error('[ManagerGetLogs] 查询失败:', err)
    return {
      code: 500,
      message: err.message || '查询失败',
      data: null
    }
  }
}
