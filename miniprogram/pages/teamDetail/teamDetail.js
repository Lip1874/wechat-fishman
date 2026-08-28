// 收费类型 -> 标签颜色（与首页/详情风格一致）
const FEE_CLASS_MAP = {
  '免费野钓': 'fee-green',
  '黑坑': 'fee-orange',
  '休闲收费塘': 'fee-blue',
  '禁钓': 'fee-red'
}

const { call, getOpenId, ensureLogin, resolveAvatarUrl } = require('../../utils/api')

Page({
  data: {
    teamId: '',
    team: null,              // 团队基础信息（含公告/成员/钓点数）
    memberList: [],          // 成员展示列表（昵称/角色/是否我）
    points: [],              // 共享钓点清单
    pointsLoading: true,
    catchSummary: null,      // 团队渔获汇总
    catchLoading: true,
    announcementEditing: false,
    announcementDraft: '',
    loading: true,
    loadError: ''
  },

  onLoad(options) {
    const id = options.id || ''
    this.teamId = id
    if (!id) {
      wx.showToast({ title: '缺少团队ID', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    getOpenId().then(openid => {
      this.myOpenid = openid
      this.renderDetail()
    }).catch(() => {})
  },

  // 每次显示刷新：从新增/编辑钓点、钓点详情返回后，钓点清单/团队信息/渔获汇总自动同步
  onShow() {
    if (!this.teamId) return
    this.loadDetail()
    this.loadPoints()
    this.loadCatchSummary()
  },

  // 团队详情（含公告/成员/钓点数）
  loadDetail() {
    return call('teamService', { action: 'getTeamDetail', teamId: this.teamId })
      .then(res => {
        this.detailData = res.team
        this.renderDetail()
      })
      .catch(err => {
        this.setData({ loading: false, loadError: err.message || '加载失败' })
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
      })
  },

  // 渲染团队信息 + 成员列表（openid 异步到达后重新渲染"我"标记）
  renderDetail() {
    const team = this.detailData
    if (!team) return
    const myOpenid = this.myOpenid || ''
    const memberList = (team.memberProfiles || []).map(m => ({
      openid: m.openid,
      name: m.nickName || '钓友' + m.openid.slice(-6),
      short: m.openid.slice(-6),
      avatarUrl: m.avatarUrl || '',
      avatarDisplayUrl: '', // cloud:// fileID 异步转换后的临时 HTTPS URL
      isCreator: m.openid === team.creatorOpenid,
      isSelf: myOpenid === m.openid
    }))
    this.setData({ team, memberList, loading: false, loadError: '' })
    this.resolveMemberAvatars(memberList)
  },

  // 批量转换成员头像：cloud:// fileID -> 临时 HTTPS URL（已入库的是网络地址则原样展示）
  resolveMemberAvatars(memberList) {
    const need = memberList.filter(m => m.avatarUrl && !m.avatarDisplayUrl)
    if (!need.length) return
    Promise.all(need.map(m => resolveAvatarUrl(m.avatarUrl).then(url => {
      m.avatarDisplayUrl = url
    })))
      .then(() => this.setData({ memberList }))
      .catch(() => {})
  },

  // 共享钓点清单（服务端校验成员权限；一次取前 100 条含作废）
  loadPoints() {
    call('dianpointService', { action: 'list', mode: 'team', teamId: this.teamId, all: true, status: '全部' })
      .then(res => {
        const points = (res.list || []).map(p => ({
          ...p,
          invalid: p.status === '作废',
          cover: (p.images && p.images.length) ? p.images[0] : '',
          feeClass: FEE_CLASS_MAP[p.feeType] || 'tag-gray',
          fishPreview: (p.fish || []).slice(0, 3),
          fishMore: (p.fish && p.fish.length > 3) ? p.fish.length - 3 : 0,
          creatorShort: p.creatorName || (p.createOpenid ? p.createOpenid.slice(-6) : '')
        }))
        this.setData({ points, pointsLoading: false })
      })
      .catch(err => {
        this.setData({ pointsLoading: false })
        wx.showToast({ title: err.message || '加载钓点失败', icon: 'none' })
      })
  },

  // 团队渔获汇总（聚合团队钓点关联的鱼获记录）
  loadCatchSummary() {
    call('teamService', { action: 'getTeamCatchSummary', teamId: this.teamId })
      .then(res => {
        const recentList = (res.recentList || []).map(r => ({
          ...r,
          caughtAtLabel: r.caughtAtMs ? this.formatDate(r.caughtAtMs) : ''
        }))
        this.setData({ catchSummary: { ...res, recentList }, catchLoading: false })
      })
      .catch(() => {
        this.setData({ catchLoading: false })
      })
  },

  formatDate(ms) {
    const d = new Date(ms)
    const p = n => (n < 10 ? '0' + n : '' + n)
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  },

  // ---- 团队公告 ----
  onEditAnnouncement() {
    const team = this.data.team
    if (!team || !team.isCreator) return
    this.setData({ announcementDraft: team.announcement || '', announcementEditing: true })
  },
  onAnnouncementInput(e) {
    this.setData({ announcementDraft: e.detail.value })
  },
  onSaveAnnouncement() {
    const text = (this.data.announcementDraft || '').trim()
    wx.showLoading({ title: '保存中' })
    call('teamService', { action: 'updateAnnouncement', teamId: this.teamId, announcement: text })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '公告已更新' })
        this.setData({ announcementEditing: false })
        return this.loadDetail()
      })
      .catch(err => {
        wx.hideLoading()
        wx.showToast({ title: err.message || '保存失败', icon: 'none' })
      })
  },
  onCloseAnnouncement() {
    this.setData({ announcementEditing: false })
  },

  // ---- 成员管理 ----
  removeMember(e) {
    const memberOpenid = e.currentTarget.dataset.openid
    wx.showModal({
      title: '移除成员',
      content: '确定移除该成员吗？移除后将无法查看团队钓点',
      confirmColor: '#e64340',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '移除中' })
        call('teamService', { action: 'removeMember', teamId: this.teamId, memberOpenid })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已移除' })
            this.loadDetail()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '移除失败', icon: 'none' })
          })
      }
    })
  },
  leaveTeam() {
    wx.showModal({
      title: '退出团队',
      content: '确定退出该团队吗？退出后将无法查看团队钓点',
      confirmColor: '#e64340',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '退出中' })
        call('teamService', { action: 'leaveTeam', teamId: this.teamId })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已退出' })
            setTimeout(() => wx.navigateBack(), 600)
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '退出失败', icon: 'none' })
          })
      }
    })
  },
  dismissTeam() {
    wx.showModal({
      title: '解散团队',
      content: '解散后该团队下全部钓点将被删除且不可恢复，确定继续吗？',
      confirmText: '解散',
      confirmColor: '#e64340',
      success: res => {
        if (!res.confirm) return
        wx.showLoading({ title: '解散中' })
        call('teamService', { action: 'dismissTeam', teamId: this.teamId })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已解散' })
            setTimeout(() => wx.navigateBack(), 600)
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '解散失败', icon: 'none' })
          })
      }
    })
  },

  // 记录邀请分享目标团队（配合 button open-type="share"）
  setShareTeam() {
    this.shareTeam = this.data.team
  },
  onShareAppMessage() {
    if (this.shareTeam) {
      return {
        title: `「${this.shareTeam.teamName}」邀请你加入团队，一起维护钓点库`,
        path: `/pages/index/index?joinTeam=${this.shareTeam._id}`
      }
    }
    return { title: '钓点小助手', path: '/pages/index/index' }
  },

  // ---- 共享钓点 ----
  goPointDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` })
  },
  goAddPoint() {
    ensureLogin().then(ok => {
      if (!ok) return
      wx.navigateTo({ url: `/pages/addPoint/addPoint?mode=team&teamId=${this.teamId}` })
    })
  },
  // 回首页永不空军分组：团队钓点已自动聚合同步，直达该分组强化同步认知
  goHomeTeam() {
    wx.reLaunch({ url: '/pages/index/index?neverEmpty=1' })
  }
})
