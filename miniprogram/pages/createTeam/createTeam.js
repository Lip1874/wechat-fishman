const { call } = require('../../utils/api')

Page({
  data: {
    teamName: '',
    createdTeam: null   // 创建成功后展示邀请入口
  },

  onInput(e) {
    this.setData({ teamName: e.detail.value })
  },

  // 创建团队
  create() {
    const teamName = this.data.teamName.trim()
    if (!teamName) return wx.showToast({ title: '请填写团队名称', icon: 'none' })
    if (teamName.length > 20) return wx.showToast({ title: '团队名称不能超过20个字', icon: 'none' })
    wx.showLoading({ title: '创建中' })
    call('teamService', { action: 'createTeam', teamName })
      .then(res => {
        wx.hideLoading()
        wx.showToast({ title: '创建成功' })
        this.shareTeam = { _id: res.teamId, teamName }
        this.setData({ createdTeam: this.shareTeam })
      })
      .catch(err => {
        wx.hideLoading()
        wx.showToast({ title: err.message || '创建失败', icon: 'none' })
      })
  },

  // 团队邀请分享卡片
  onShareAppMessage() {
    if (this.shareTeam) {
      return {
        title: `「${this.shareTeam.teamName}」邀请你加入团队，一起维护钓点库`,
        path: `/pages/index/index?joinTeam=${this.shareTeam._id}`
      }
    }
    return { title: '钓点小助手', path: '/pages/index/index' }
  }
})
