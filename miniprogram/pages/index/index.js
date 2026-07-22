// index.js
const app = getApp()

Page({
  data: {
    openidInput: '',
    // 音视频预览
    fileIdInput: '',
    mediaUrl: '',        // 解析得到的临时链接
    mediaType: '',       // 'audio' | 'video'
    audioPlaying: false, // 音频是否正在播放
    loadingMedia: false  // 正在解析临时链接
  },

  onLoad() {
    console.log('[Index] 页面加载完成')
  },

  onHide() {
    // 离开页面时停止音频，避免后台继续播放
    this._destroyAudio()
    this.setData({ audioPlaying: false })
  },

  onUnload() {
    this._destroyAudio()
  },

  // 用户查询
  onUserQuery() {
    const openid = this.data.openidInput.trim();

    if (!openid) {
      wx.showToast({
        title: '请输入 openid',
        icon: 'none'
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/customer-service-chat/customer-service-chat?openid=${openid}`
    });
  },

  // openid 输入
  onOpenidInput(e) {
    this.setData({
      openidInput: e.detail.value
    });
  },

  // 客服消息
  onCustomerService() {
    wx.navigateTo({
      url: '/pages/customer-service-list/customer-service-list'
    });
  },

  // 退款处理
  onRefund() {
    wx.navigateTo({
      url: '/pages/refund-list/refund-list'
    });
  },

  // 音色管理
  onVoiceManage() {
    wx.navigateTo({
      url: '/pages/voice-manage/voice-manage'
    });
  },

  // 数据库管理
  onDatabase() {
    wx.navigateTo({
      url: '/pages/database-manage/database-manage'
    });
  },

  // 发票开具
  onInvoice() {
    wx.navigateTo({
      url: '/pages/invoice-list/invoice-list'
    });
  },

  // ===== 音视频预览 =====

  // 文件 ID 输入
  onFileIdInput(e) {
    this.setData({ fileIdInput: e.detail.value });
  },

  // 根据文件 ID 扩展名推断媒体类型
  detectMediaType(fileId) {
    const path = String(fileId).toLowerCase().split('?')[0];
    const audioExts = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.amr', '.wma', '.opus'];
    const videoExts = ['.mp4', '.mov', '.m4v', '.webm', '.m3u8', '.avi', '.mkv', '.flv', '.3gp'];
    if (audioExts.some(ext => path.endsWith(ext))) return 'audio';
    if (videoExts.some(ext => path.endsWith(ext))) return 'video';
    return '';
  },

  // 获取临时链接并播放
  async onPlayMedia() {
    const fileId = this.data.fileIdInput.trim();
    if (!fileId) {
      wx.showToast({ title: '请输入文件 ID', icon: 'none' });
      return;
    }
    if (!app.globalData.cloud) {
      wx.showToast({ title: '云开发未初始化', icon: 'none' });
      return;
    }

    // 先停掉上一次的音频
    this._destroyAudio();
    this.setData({ loadingMedia: true });
    wx.showLoading({ title: '获取链接...', mask: true });

    try {
      const res = await app.globalData.cloud.getTempFileURL({ fileList: [fileId] });
      wx.hideLoading();
      const item = res.fileList && res.fileList[0];

      if (item && item.status === 0 && item.tempFileURL) {
        const url = item.tempFileURL;
        // 未识别出类型时默认按视频处理（video 组件兼容性更好，用户也可手动切换）
        const type = this.detectMediaType(fileId) || 'video';
        this.setData({ mediaUrl: url, mediaType: type, audioPlaying: false, loadingMedia: false });
        if (type === 'audio') {
          this._playAudio(url);
        }
      } else {
        this.setData({ loadingMedia: false });
        wx.showToast({ title: (item && item.errmsg) || '获取链接失败，请检查文件 ID', icon: 'none' });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('[Index] 获取临时链接失败:', err);
      this.setData({ loadingMedia: false });
      wx.showToast({ title: '获取链接失败', icon: 'none' });
    }
  },

  // 手动切换音频/视频
  switchMediaType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.mediaType || !this.data.mediaUrl) return;
    this._destroyAudio();
    this.setData({ mediaType: type, audioPlaying: false });
    if (type === 'audio') {
      this._playAudio(this.data.mediaUrl);
    }
  },

  // 音频 播放/暂停
  toggleAudioPlay() {
    const ctx = this.innerAudioContext;
    if (this.data.audioPlaying) {
      if (ctx) ctx.pause();
      this.setData({ audioPlaying: false });
    } else if (ctx) {
      ctx.play();
      this.setData({ audioPlaying: true });
    } else if (this.data.mediaUrl) {
      this._playAudio(this.data.mediaUrl);
    }
  },

  _playAudio(url) {
    this._destroyAudio();
    const ctx = wx.createInnerAudioContext();
    ctx.src = url;
    ctx.onPlay(() => this.setData({ audioPlaying: true }));
    ctx.onPause(() => this.setData({ audioPlaying: false }));
    ctx.onStop(() => this.setData({ audioPlaying: false }));
    ctx.onEnded(() => this.setData({ audioPlaying: false }));
    ctx.onError((err) => {
      console.error('[Index] 音频播放失败:', err);
      wx.showToast({ title: '播放失败', icon: 'none' });
      this.setData({ audioPlaying: false });
    });
    ctx.play();
    this.innerAudioContext = ctx;
  },

  _destroyAudio() {
    if (this.innerAudioContext) {
      this.innerAudioContext.stop();
      this.innerAudioContext.destroy();
      this.innerAudioContext = null;
    }
  },

  // 复制临时链接
  copyMediaUrl() {
    if (!this.data.mediaUrl) return;
    wx.setClipboardData({
      data: this.data.mediaUrl,
      success: () => wx.showToast({ title: '链接已复制', icon: 'success' })
    });
  },

  // 关闭播放器，恢复原样
  closeMedia() {
    this._destroyAudio();
    this.setData({
      fileIdInput: '',
      mediaUrl: '',
      mediaType: '',
      audioPlaying: false
    });
  }
});
