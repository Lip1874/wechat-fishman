const { call } = require('../../utils/api')

Page({
  data: {
    teams: [],          // 我的团队
    loading: false
  },

  onShow() {
    this.loadTeams()
  },

  // 加载我的团队（我创建的+我加入的）
  async loadTeams() {
    this.setData({ loading: true })
    try {
      const res = await call('teamService', { action: 'getMyTeams' })
      this.setData({ teams: res.teams || [] })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
    this.setData({ loading: false })
  },

  // 顶部 + 创建（与空状态按钮共用，创建逻辑不变）
  goCreate() {
    wx.navigateTo({ url: '/pages/createTeam/createTeam' })
  },

  // 点击团队条目 -> 进入团队详情页
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/teamDetail/teamDetail?id=${id}` })
  }
})
