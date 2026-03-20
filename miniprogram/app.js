// app.js
App({
  onLaunch: async function () {
    this.globalData = {
      token: null, // 存储 token
      userInfo: null, // 存储用户信息
      cloud: null // 存储云开发实例
    };

    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      try {
        wx.showLoading({
          title: '准备中...'
        })
        // 跨账号环境共享，必须使用 new wx.cloud.Cloud 新建实例
        this.globalData.cloud = new wx.cloud.Cloud({
          // 资源方 AppID
          resourceAppid: 'wx126d0f048410f694',
          // 资源方环境 ID
          resourceEnv: 'six-hands-9g9fuco71bc0d539'
        });
        console.log('[App] 云开发 ', this.globalData.cloud);

        
        // 初始化云开发实例
        await this.globalData.cloud.init();

        console.log('[App] 云开发初始化成功（跨账号环境共享模式）', this.globalData.cloud);
        wx.hideLoading()
      } catch (err) {
        console.error('[App] 云开发初始化失败:', err);
        wx.showToast({
          title: '云开发初始化失败',
          icon: 'none'
        });
      }
    }

    // 小程序启动时不自动登录，由首页负责登录
  },

  // 登录方法
  async login(username, password) {
    console.log('[App] 开始登录流程');

    if (!this.globalData.cloud) {
      console.error('[App] 云开发未初始化');
      return { success: false, message: '云开发未初始化' };
    }

    try {
      const action = username && password ? 'passwordLogin' : 'autoLogin';
      const data = username && password
        ? { action, username, password }
        : { action };

      console.log('[App] 调用云函数，action:', action);

      const loginRes = await this.globalData.cloud.callFunction({
        name: 'manager-login',
        data: data
      });

      if (loginRes.result.code === 0) {
        const { token, openid, username: usernameRes } = loginRes.result.data;

        console.log('[App] 登录成功');

        // 构建 userInfo 对象
        const userInfo = {
          userId: openid || usernameRes,
          role: "admin",
          openid: openid || usernameRes,
          username: usernameRes
        };

        // 保存 token 和用户信息到全局数据
        this.globalData.token = token;
        this.globalData.userInfo = userInfo;

        // 保存到本地存储
        wx.setStorageSync('token', token);
        wx.setStorageSync('userInfo', userInfo);

        console.log('[App] Token 已保存');
        return { success: true, userInfo };
      } else {
        console.error('[App] 登录失败:', loginRes.result.message);
        return { success: false, message: loginRes.result.message };
      }
    } catch (err) {
      console.error('[App] 登录异常:', err);
      return { success: false, message: '登录失败' };
    }
  },

  // 验证 token 有效性
  async verifyToken() {
    const token = this.globalData.token || wx.getStorageSync('token');
    
    if (!token) {
      console.log('[App] Token 不存在，需要登录');
      return false;
    }

    try {
      const res = await this.globalData.cloud.callFunction({
        name: 'manager-verify-token',
        data: { token }
      });

      if (res.result.code === 200 && res.result.data.valid) {
        console.log('[App] Token 验证通过');
        return true;
      } else {
        console.log('[App] Token 验证失败:', res.result.message);
        // Token 失效，清除本地存储并重新登录
        this.clearToken();
        await this.login();
        return false;
      }
    } catch (err) {
      console.error('[App] Token 验证异常:', err);
      return false;
    }
  },

  // 清除 token
  clearToken() {
    console.log('[App] 清除 Token');
    this.globalData.token = null;
    this.globalData.userInfo = null;
    wx.removeStorageSync('token');
    wx.removeStorageSync('userInfo');
  },

  // 获取 token
  getToken() {
    return this.globalData.token || wx.getStorageSync('token');
  },

  // 获取用户信息
  getUserInfo() {
    return this.globalData.userInfo || wx.getStorageSync('userInfo');
  }
});
