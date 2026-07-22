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

        // 安装 401 拦截器：任意云函数授权失败时自动重新登录并重试一次
        this._installAuthFailureInterceptor();

        // 优先检查本地是否已有有效 token，避免每次启动都重新登录
        const cachedToken = wx.getStorageSync('token');
        const cachedUserInfo = wx.getStorageSync('userInfo');

        if (cachedToken && cachedUserInfo) {
          console.log('[App] 本地已有 token，直接复用，跳过登录（授权失败会自动重新登录）');
          this.globalData.token = cachedToken;
          this.globalData.userInfo = cachedUserInfo;
        } else {
          console.log('[App] 本地无 token，开始自动登录');
          const loginResult = await this.login();
          
          if (loginResult.success) {
            console.log('[App] 自动登录成功');
          } else {
            console.error('[App] 自动登录失败:', loginResult.message);
          }
        }
        
        wx.hideLoading()
      } catch (err) {
        console.error('[App] 云开发初始化失败:', err);
        wx.hideLoading()
        wx.showToast({
          title: '云开发初始化失败',
          icon: 'none'
        });
      }
    }
  },

  // 登录方法
  async login(username, password) {
    console.log('[App] ===== 开始登录流程 =====');
    console.log('[App] 是否使用密码登录:', !!username && !!password);

    if (!this.globalData.cloud) {
      console.error('[App] 云开发未初始化');
      return { success: false, message: '云开发未初始化' };
    }

    try {
      const action = username && password ? 'passwordLogin' : 'autoLogin';
      const data = username && password
        ? { action, username, password }
        : { action };

      console.log('[App] 调用云函数 manager-login，action:', action);
      console.log('[App] 请求数据:', JSON.stringify(data));

      const loginRes = await this.globalData.cloud.callFunction({
        name: 'manager-login',
        data: data
      });

      console.log('[App] 云函数返回结果:', JSON.stringify(loginRes.result));

      if (loginRes.result.code === 0) {
        const { token, openid, username: usernameRes } = loginRes.result.data;

        console.log('[App] 登录成功');
        console.log('[App] Token 长度:', token.length);
        console.log('[App] 用户 openid:', openid);
        console.log('[App] 用户名:', usernameRes);

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

        console.log('[App] Token 已保存到本地存储');
        return { success: true, userInfo };
      } else {
        console.error('[App] 登录失败，错误码:', loginRes.result.code, '错误信息:', loginRes.result.message);
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

  // 在 cloud 实例上安装 401 拦截器：云函数返回未授权时，自动重新登录并用新 token 重试一次
  // 通过单例 Promise 串行化重新登录，避免并发 401 触发多次 login
  _installAuthFailureInterceptor() {
    const cloudInstance = this.globalData.cloud;
    if (!cloudInstance || cloudInstance._authInterceptorInstalled) return;
    cloudInstance._authInterceptorInstalled = true;

    const originalCall = cloudInstance.callFunction.bind(cloudInstance);
    const app = this;

    cloudInstance.callFunction = async function (opts) {
      const res = await originalCall(opts);

      // 排除登录/验证函数本身，避免无限循环
      const fnName = opts && opts.name;
      const isAuthFn = fnName === 'manager-login' || fnName === 'manager-verify-token';
      if (isAuthFn) return res;

      const code = res && res.result && res.result.code;
      if (code !== 401) return res;

      console.warn('[App] 云函数 401 未授权:', fnName, '— 尝试重新登录后重试');

      // 单例：所有并发 401 共用同一次 login
      if (!app._reloginPromise) {
        app._reloginPromise = app.login().finally(() => { app._reloginPromise = null; });
      }

      let loginRes;
      try {
        loginRes = await app._reloginPromise;
      } catch (e) {
        console.error('[App] 重新登录异常:', e);
        return res;
      }

      if (!loginRes || !loginRes.success) {
        console.error('[App] 重新登录失败，返回原始 401 响应');
        return res;
      }

      console.log('[App] 重新登录成功，重试云函数:', fnName);

      // 用新 token 重试原始调用
      const retryOpts = { ...opts };
      if (retryOpts.data && typeof retryOpts.data === 'object' && 'token' in retryOpts.data) {
        retryOpts.data = { ...retryOpts.data, token: app.globalData.token };
      }
      return await originalCall(retryOpts);
    };

    console.log('[App] 已安装云函数 401 自动重登拦截器');
  },

  // 获取用户信息
  getUserInfo() {
    return this.globalData.userInfo || wx.getStorageSync('userInfo');
  }
});
