// JWT 认证模块
const jwt = require('jsonwebtoken')

// JWT 密钥 - 从环境变量读取，生产环境建议在云开发控制台配置
const JWT_SECRET = process.env.JWT_SECRET || 'six-hands-jwt-secret-key-change-in-production'

/**
 * 生成 JWT Token
 * @param {Object} payload - token 载荷
 * @returns {String} token
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: '24h' // token 有效期 24 小时
  })
}

/**
 * 验证 JWT Token
 * @param {String} token - token 字符串
 * @returns {Object|null} 解析后的载荷，验证失败返回 null
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (err) {
    console.error('[Auth] Token 验证失败:', err.message)
    return null
  }
}

/**
 * 从请求中获取用户信息
 * @param {Object} event - 云函数 event 对象
 * @returns {Object|null} 用户信息
 */
function getUserFromToken(event) {
  const token = event.token || event.headers?.token || event.headers?.Authorization?.replace('Bearer ', '')

  if (!token) {
    console.error('[Auth] 未找到 token')
    return null
  }

  const payload = verifyToken(token)
  if (!payload) {
    return null
  }

  return {
    userId: payload.userId,
    username: payload.username,
    openid: payload.openid,
    role: payload.role
  }
}

/**
 * 云函数中间件：验证用户身份
 * @param {Object} event - 云函数 event 对象
 * @returns {Object} 包含 success, userInfo
 */
function requireAuth(event) {
  const user = getUserFromToken(event)

  if (!user) {
    return {
      success: false,
      error: '未授权或 token 无效'
    }
  }

  return {
    success: true,
    userInfo: user
  }
}

module.exports = {
  generateToken,
  verifyToken,
  getUserFromToken,
  requireAuth
}
