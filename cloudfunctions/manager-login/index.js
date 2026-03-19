const cloud = require("wx-server-sdk");
const { generateToken } = require("./auth");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

/**
 * 管理员登录云函数
 * 简化版：获取 openid 并生成 token
 *
 * @param {string} action - 操作类型：'autoLogin'
 */
exports.main = async (event, context) => {
  const { action } = event;

  if (action === "autoLogin") {
    return handleAutoLogin(event);
  } else {
    return {
      code: 400,
      message: "无效的操作类型，请使用 'autoLogin'",
    };
  }
};

/**
 * 处理自动登录逻辑
 */
async function handleAutoLogin(event) {
  try {
    // 获取微信 openid
    const wxContext = cloud.getWXContext();
    const openid = wxContext.FROM_OPENID;

    console.log('[AutoLogin] wxContext:', wxContext);

    if (!openid) {
      console.error('[AutoLogin] OPENID 为空');
      return {
        code: 400,
        message: "获取 openid 失败",
      };
    }

    // 生成 token
    const token = generateToken({
      userId: openid,
      role: "zswf",
      openid: openid,
    });

    console.log('[AutoLogin] 登录成功，token 已生成');

    return {
      code: 0,
      message: "success",
      data: {
        token: token,
        openid: openid
      },
    };
  } catch (error) {
    console.error("自动登录失败:", error);
    return {
      code: 500,
      message: "自动登录失败",
      error: error.message,
    };
  }
}
