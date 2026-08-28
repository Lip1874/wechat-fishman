const {
  getUserInfo,
  updateProfile,
  resolveAvatarUrl,
  isTempFile,
  uploadAvatar
} = require('../../utils/api')

Page({
  data: {
    profile: {
      avatarUrl: '',
      nickName: '',
      remark: ''
    },
    avatarDisplayUrl: '', // 头像临时 HTTPS URL，用于 image 组件渲染
    pendingAvatar: '', // 临时头像路径，保存时上传
    saving: false,
    loaded: false
  },

  onLoad() {
    this.loadProfile()
  },

  onShow() {
    if (this.data.loaded) {
      this.loadProfile()
    }
  },

  // 加载云端个人资料，头像 fileID 需转换为临时 HTTPS URL 渲染
  loadProfile() {
    wx.showLoading({ title: '加载中', mask: true })
    getUserInfo()
      .then(async res => {
        const p = res.profile || {}
        const avatarDisplayUrl = await resolveAvatarUrl(p.avatarUrl || '')
        this.setData({
          profile: {
            avatarUrl: p.avatarUrl || '',
            nickName: p.nickName || '',
            remark: p.remark || ''
          },
          avatarDisplayUrl,
          loaded: true
        })
      })
      .catch(err => {
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      })
      .finally(() => {
        wx.hideLoading()
      })
  },

  // 选择微信头像：chooseAvatar 返回临时路径，直接作为展示 URL
  onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl
    if (!tempPath) return
    this.setData({
      'profile.avatarUrl': tempPath,
      avatarDisplayUrl: tempPath,
      pendingAvatar: tempPath
    })
  },

  onNickNameBlur(e) {
    this.setData({ 'profile.nickName': e.detail.value.trim() })
  },

  onRemarkBlur(e) {
    this.setData({ 'profile.remark': e.detail.value.trim() })
  },

  // 保存个人资料：优先上传新头像到云存储，存储 fileID，便于长期复用
  saveProfile() {
    if (this.data.saving) return
    const { profile, pendingAvatar } = this.data

    this.setData({ saving: true })

    const doSave = (avatarUrl) => {
      updateProfile({
        nickName: profile.nickName,
        avatarUrl: avatarUrl || profile.avatarUrl,
        remark: profile.remark
      })
        .then(() => {
          wx.showToast({ title: '保存成功', icon: 'success' })
          // 同步全局，减少返回后的二次请求
          const app = getApp()
          if (app.globalData) {
            app.globalData.userProfile = { ...profile, avatarUrl: avatarUrl || profile.avatarUrl }
          }
          setTimeout(() => wx.navigateBack(), 800)
        })
        .catch(err => {
          wx.showToast({ title: err.message || '保存失败', icon: 'none' })
        })
        .finally(() => {
          this.setData({ saving: false })
        })
    }

    if (isTempFile(pendingAvatar)) {
      // 上传临时头像到云存储，得到持久 fileID，保存到数据库，展示时通过 getTempFileURL 换取临时 HTTPS URL
      uploadAvatar(pendingAvatar)
        .then(fileID => doSave(fileID))
        .catch(err => {
          this.setData({ saving: false })
          wx.showToast({ title: err.message || '头像上传失败', icon: 'none' })
        })
    } else {
      doSave(profile.avatarUrl)
    }
  }
})
