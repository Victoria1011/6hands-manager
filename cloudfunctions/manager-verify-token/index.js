// 云函数入口文件
const cloud = require('wx-server-sdk')
const { verifyToken } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerVerifyToken] ===== 验证 Token =====')
  console.log('[ManagerVerifyToken] 事件对象:', JSON.stringify(event))

  const { token } = event

  if (!token) {
    return {
      code: 400,
      message: 'token 不能为空',
      data: null
    }
  }

  try {
    // 验证 token
    const decoded = verifyToken(token)

    if (!decoded) {
      console.warn('[ManagerVerifyToken] Token 验证失败')
      return {
        code: 401,
        message: 'Token 无效或已过期',
        data: null
      }
    }

    console.log('[ManagerVerifyToken] Token 验证成功:', decoded)

    // 验证用户是否在数据库中存在
    const userId = decoded.userId
    const dbResult = await db.collection('managers').where({
      _id: userId
    }).get()

    if (dbResult.data.length === 0) {
      console.warn('[ManagerVerifyToken] 用户不存在')
      return {
        code: 404,
        message: '用户不存在',
        data: null
      }
    }

    // 返回用户信息
    return {
      code: 200,
      message: 'success',
      data: {
        valid: true,
        userId: decoded.userId,
        username: decoded.username,
        role: decoded.role,
        exp: decoded.exp,
        iat: decoded.iat
      }
    }

  } catch (err) {
    console.error('[ManagerVerifyToken] Token 验证失败:', err)
    
    return {
      code: 500,
      message: '验证失败',
      data: null
    }
  }
}
