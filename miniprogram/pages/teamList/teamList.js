const { call, getOpenId } = require('../../utils/api')

Page({
  data: {
    teams: [],          // 我的团队
    expandedId: '',     // 展开中的团队ID
    detail: null        // 展开团队的详情（含成员列表）
  },

  onShow() {
    getOpenId().then(openid => { this.openid = openid }).catch(() => {})
    this.loadTeams()
  },

  // 加载我的团队（我创建的+我加入的）
  async loadTeams() {
    try {
      const res = await call('teamService', { action: 'getMyTeams' })
      this.setData({ teams: res.teams || [] })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/createTeam/createTeam' })
  },

  // 展开/收起团队详情（获取成员列表）
  async toggleDetail(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.expandedId === id) {
      this.setData({ expandedId: '', detail: null })
      return
    }
    wx.showLoading({ title: '加载中' })
    try {
      const res = await call('teamService', { action: 'getTeamDetail', teamId: id })
      const team = res.team
      const memberList = (team.members || []).map(m => ({
        openid: m,
        short: m.slice(-6),
        isCreator: m === team.creatorOpenid,
        isSelf: this.openid === m
      }))
      this.setData({ expandedId: id, detail: { ...team, memberList } })
      wx.hideLoading()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  // 记录邀请分享目标团队（配合 button open-type="share"）
  setShareTeam(e) {
    const id = e.currentTarget.dataset.id
    const team = this.data.teams.find(t => t._id === id)
    this.shareTeam = team
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
  },

  // 移除成员（仅创建人）
  removeMember(e) {
    const memberOpenid = e.currentTarget.dataset.openid
    wx.showModal({
      title: '移除成员',
      content: '确定移除该成员吗？移除后将无法查看团队钓点',
      confirmColor: '#e64340',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '移除中' })
        call('teamService', { action: 'removeMember', teamId: this.data.expandedId, memberOpenid })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已移除' })
            this.loadTeams()
            this.toggleDetail({ currentTarget: { dataset: { id: this.data.expandedId } } })
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '移除失败', icon: 'none' })
          })
      }
    })
  },

  // 成员退出团队
  leaveTeam() {
    wx.showModal({
      title: '退出团队',
      content: '确定退出该团队吗？退出后将无法查看团队钓点',
      confirmColor: '#e64340',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '退出中' })
        call('teamService', { action: 'leaveTeam', teamId: this.data.expandedId })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已退出' })
            this.setData({ expandedId: '', detail: null })
            this.loadTeams()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '退出失败', icon: 'none' })
          })
      }
    })
  },

  // 解散团队（仅创建人，团队钓点一并删除）
  dismissTeam() {
    wx.showModal({
      title: '解散团队',
      content: '解散后该团队下全部钓点将被删除且不可恢复，确定继续吗？',
      confirmText: '解散',
      confirmColor: '#e64340',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '解散中' })
        call('teamService', { action: 'dismissTeam', teamId: this.data.expandedId })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已解散' })
            this.setData({ expandedId: '', detail: null })
            this.loadTeams()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '解散失败', icon: 'none' })
          })
      }
    })
  }
})
