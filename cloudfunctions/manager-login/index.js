const cloud = require("wx-server-sdk");
const { generateToken } = require("./auth");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

/**
 * 管理员登录云函数
 *
 * @param {string} action - 操作类型：'autoLogin' | 'passwordLogin'
 * @param {string} username - 用户名（密码登录时需要）
 * @param {string} password - 密码（密码登录时需要）
 */
exports.main = async (event, context) => {
  
  const { action, username, password } = event;
  console.log('[ManagerLogin] action:', action);

  if (action === "autoLogin") {
    return handleAutoLogin(event);
  } else if (action === "passwordLogin") {
    return handlePasswordLogin(event, username, password);
  } else {
    console.error('[ManagerLogin] 无效的操作类型:', action);
    return {
      code: 400,
      message: "无效的操作类型",
    };
  }
};

/**
 * 处理自动登录逻辑
 */
async function handleAutoLogin(event) {
  console.log('[AutoLogin] ===== 开始自动登录 =====');
  
  try {
    // 获取微信 openid
    const wxContext = cloud.getWXContext();
    console.log('[AutoLogin] 获取 wxContext');
    console.log('[AutoLogin] wxContext.FROM_OPENID:', wxContext.FROM_OPENID);
    console.log('[AutoLogin] wxContext.OPENID:', wxContext.OPENID);
    console.log('[AutoLogin] wxContext.APPID:', wxContext.APPID);
    
    const openid = wxContext.FROM_OPENID;

    if (!openid) {
      console.error('[AutoLogin] OPENID 为空');
      return {
        code: 400,
        message: "获取 openid 失败",
      };
    }

    console.log('[AutoLogin] OpenID 获取成功:', openid);

    // 生成 token
    const token = generateToken({
      userId: openid,
      role: "zswf",
      openid: openid,
    });

    console.log('[AutoLogin] 登录成功，token 已生成');
    console.log('[AutoLogin] Token 长度:', token.length);

    return {
      code: 0,
      message: "success",
      data: {
        token: token,
        openid: openid
      },
    };
  } catch (error) {
    console.error('[AutoLogin] 自动登录失败:', error);
    console.error('[AutoLogin] 错误堆栈:', error.stack);
    return {
      code: 500,
      message: "自动登录失败",
      error: error.message,
    };
  }
}

/**
 * 处理密码登录逻辑
 */
async function handlePasswordLogin(event, username, password) {
  try {
    console.log('[PasswordLogin] 用户名:', username);

    // 这里应该验证用户名和密码
    // 简化版：暂时只验证用户名不为空
    // 实际项目中应该从数据库验证或调用第三方认证服务

    if (!username || !password) {
      return {
        code: 400,
        message: "用户名和密码不能为空",
      };
    }

    // 模拟一个管理员账号验证
    // TODO: 实际项目中需要替换为真实的验证逻辑
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      console.error('[PasswordLogin] 用户名或密码错误');
      return {
        code: 401,
        message: "用户名或密码错误",
      };
    }

    // 生成 token（使用用户名作为 userId）
    const token = generateToken({
      userId: username,
      role: "admin",
      username: username,
    });

    console.log('[PasswordLogin] 登录成功，token 已生成');

    return {
      code: 0,
      message: "success",
      data: {
        token: token,
        username: username
      },
    };
  } catch (error) {
    console.error("密码登录失败:", error);
    return {
      code: 500,
      message: "登录失败",
      error: error.message,
    };
  }
}
