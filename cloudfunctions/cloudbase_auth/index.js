// 云函数入口文件
const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()

  console.log('[cloudbase_auth] 收到请求')
  console.log('[cloudbase_auth] event:', JSON.stringify(event))
  console.log('[cloudbase_auth] wxContext:', JSON.stringify(wxContext))

  // 跨账号调用时，由此拿到来源方小程序/公众号 AppID
  const fromAppid = wxContext.FROM_APPID
  console.log('[cloudbase_auth] 来源方 AppID:', fromAppid)

  // 跨账号调用时，由此拿到来源方小程序/公众号的用户 OpenID
  const fromOpenid = wxContext.FROM_OPENID
  console.log('[cloudbase_auth] 来源方 OpenID:', fromOpenid)

  // 跨账号调用、且满足 unionid 获取条件时，由此拿到同主体下的用户 UnionID
  const fromUnionid = wxContext.FROM_UNIONID
  console.log('[cloudbase_auth] 来源方 UnionID:', fromUnionid)

  // 白名单：允许访问的小程序 AppID
  // 请在此处添加被授权的小程序 AppID
  const allowedAppids = [
    'wx6abc7cafcf01cb1b'
    // 示例：'wx1234567890abcdef'
    // 添加实际需要访问的小程序 AppID
  ]
  const allowedOpenids = [
    'oAfY648UXQt0aiK9GxpJEJxgdpiw'
  ]

  // 检查来源方 AppID 是否在白名单中
  if (!fromAppid || allowedAppids.length === 0 || !allowedAppids.includes(fromAppid)) {
    console.log('[cloudbase_auth] 授权失败：来源方 AppID 不在白名单中')
    return {
      errCode: -1,
      errMsg: '未授权访问',
      auth: ''
    }
  }
  //检查来源方 openID 是否在白名单中
  if (!fromOpenid || allowedOpenids.length === 0 || !allowedOpenids.includes(fromOpenid)) {
    console.log('[cloudbase_auth] 授权失败：来源方 openid 不在白名单中')
    return {
      errCode: -1,
      errMsg: '未授权访问',
      auth: ''
    }
  }
  console.log('[cloudbase_auth] 授权成功')

  return {
    errCode: 0,
    errMsg: '',
    auth: JSON.stringify({
      // 自定义安全规则
      // 在前端访问资源方数据库、云函数等资源时，资源方可以通过
      // 安全规则的 `auth.custom` 字段获取此对象的内容做校验

      // 标记来源方 AppID，安全规则可通过 auth.custom.appid 获取
      appid: fromAppid,

      // 标记来源方 OpenID，安全规则可通过 auth.custom.openid 获取
      openid: fromOpenid,

      // 如果有 UnionID，也可标记，安全规则可通过 auth.custom.unionid 获取
      unionid: fromUnionid || '',

      // 标记授权时间，安全规则可通过 auth.custom.timestamp 获取
      timestamp: Date.now(),

      // 可以添加更多自定义字段，用于精细化的权限控制
      // 例如：限定只能访问某些集合或某些云函数
      permissions: {
        // 允许访问的数据库集合
        collections: [
          // 'users',
          // 'coins',
          // 'tts_clone_design_logs'
        ],
        // 允许调用的云函数
        functions: [
          // 'synthesize',
          // 'designVoice',
          // 'cloneVoice'
        ]
      }
    }),
  }
}
