const {
  getAdminInfo,
  getUserInfo,
  getUserStats,
  getModelProgress,
  getDiagnosisInfo,
  updateSyncConfig,
  updateProfile,
  resolveAvatarUrl,
  isTempFile,
  uploadAvatar
} = require('../../utils/api')
const { ensureLogin } = require('../../utils/login')
const { getSettings, updateSettings } = require('../../utils/settings')
const { listDrafts, clearAllDrafts } = require('../../utils/draft')

// 鱼种偏好可选鱼种（与新增钓点/渔获列表保持一致）
const FISH_PREF_OPTIONS = [
  '鲫鱼', '鲤鱼', '草鱼', '青鱼', '鲢鳙', '黑鱼', '翘嘴',
  '马口', '罗非', '鲶鱼', '黄颡鱼', '白条', '鳜鱼', '鲈鱼', '鳊鱼'
]

Page({
  data: {
    openidShort: '',
    isAdmin: false,
    loading: false,
    profile: {
      avatarUrl: '',
      nickName: '',
      remark: ''
    },
    avatarDisplayUrl: '', // 头像临时 HTTPS URL，用于 image 组件渲染
    stats: {
      myPoints: 0,
      fishRecords: 0,
      activeRecords: 0
    },
    modelProgress: 0,
    syncMode: 'cloud',
    diagnosisText: '',
    // 离线草稿
    hasDraft: false,
    draftCount: 0,
    // 设置项
    settings: {
      notify: true,
      distanceUnit: 'km',
      fishPref: []
    },
    fishPrefText: '未设置',
    fishPrefOptions: [],
    showFishPref: false
  },

  onShow() {
    // 进入「我的」时触发微信一键登录（静默鉴权：自动获取 openid 并在 user 集合建档）。
    // 静默执行，失败不打扰游客，页面资料正常展示
    ensureLogin().catch(() => {})
    this.refreshPage()
    this.refreshDraft()
    this.loadSettings()
  },

  // 刷新离线草稿小红点状态
  refreshDraft() {
    const drafts = listDrafts()
    this.setData({
      hasDraft: drafts.length > 0,
      draftCount: drafts.length
    })
  },

  // 加载本地设置（消息通知 / 距离单位 / 鱼种偏好）
  loadSettings() {
    const settings = getSettings()
    const fishPref = Array.isArray(settings.fishPref) ? settings.fishPref : []
    this.setData({
      settings,
      fishPrefText: fishPref.length ? `${fishPref.slice(0, 3).join('、')}${fishPref.length > 3 ? ` 等${fishPref.length}种` : ''}` : '未设置',
      fishPrefOptions: FISH_PREF_OPTIONS.map(name => ({ name, checked: fishPref.indexOf(name) > -1 }))
    })
  },

  // 刷新页面：加载用户资料 + 统计 + 模型进度 + 诊断信息
  refreshPage() {
    this.setData({ loading: true })

    Promise.all([
      getAdminInfo().catch(() => ({ openid: '', isAdmin: false })),
      getUserInfo().catch(() => null),
      getModelProgress().catch(() => ({ progress: 0 })),
      getDiagnosisInfo().catch(() => null)
    ])
      .then(async ([adminInfo, userInfo, modelInfo, diagInfo]) => {
        const profile = (userInfo && userInfo.profile) || this.data.profile
        const stats = (userInfo && userInfo.stats) || this.data.stats
        const isAdmin = typeof adminInfo.isAdmin === 'boolean' ? adminInfo.isAdmin : false
        const progress = (modelInfo && typeof modelInfo.progress === 'number') ? modelInfo.progress : 0
        const syncMode = (userInfo && userInfo.profile && userInfo.profile.syncMode) || 'cloud'

        // 头像若是云存储 fileID，需换取临时 HTTPS URL 才能渲染
        const avatarUrl = profile.avatarUrl || ''
        const avatarDisplayUrl = await resolveAvatarUrl(avatarUrl)

        this.setData({
          openidShort: adminInfo.openid ? adminInfo.openid.slice(-6) : '',
          isAdmin,
          profile,
          avatarDisplayUrl,
          stats,
          modelProgress: progress,
          syncMode,
          diagnosisText: this.formatDiagnosis(diagInfo)
        })
      })
      .catch(err => {
        this.showError(err.message || '加载失败，请检查网络')
      })
      .finally(() => {
        this.setData({ loading: false })
      })
  },

  // 格式化诊断文本
  formatDiagnosis(diagInfo) {
    if (!diagInfo || !diagInfo.diagnosis) return ''
    const d = diagInfo.diagnosis
    return [
      `运行环境：${d.env || '-'}`,
      `openid 尾号：${d.openidShort || '-'}`,
      `平台：${d.platform || '-'} ${d.version || ''}`,
      `设备：${d.brand || '-'} ${d.model || '-'}`,
      `微信基础库：${d.SDKVersion || '-'}`,
      `系统：${d.system || '-'}`,
      `云状态：${d.cloudStatus || 'online'}`,
      `管理员：${d.isAdmin ? '是' : '否'}`,
      `时间：${d.timestamp ? new Date(d.timestamp).toLocaleString() : '-'}`
    ].join('\n')
  },

  // 跳转个人资料设置页
  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  // 是否已登录：以昵称是否完善为准
  getLoginState() {
    return !!(this.data.profile && this.data.profile.nickName && String(this.data.profile.nickName).trim())
  },

  // 微信一键登录：弹出授权获取头像昵称，保存到云端即完成登录
  handleLogin() {
    if (this.getLoginState()) {
      wx.navigateTo({ url: '/pages/profile/profile' })
      return
    }
    // 基础库过低不支持 getUserProfile 时，直接引导到资料完善页
    if (typeof wx.getUserProfile !== 'function') {
      wx.navigateTo({ url: '/pages/profile/profile' })
      return
    }
    wx.showLoading({ title: '请求授权中', mask: true })
    wx.getUserProfile({
      desc: '用于完善个人资料（头像、昵称）',
      success: res => {
        wx.hideLoading()
        const info = res.userInfo || {}
        const nickName = String(info.nickName || '').trim()
        const avatarUrl = info.avatarUrl || ''
        // 新版基础库下 getUserProfile 返回匿名信息（昵称为"微信用户"、灰色默认头像），
        // 此时不落库，引导用户用 chooseAvatar / nickname 输入框选择真实微信头像昵称
        if (!nickName || nickName === '微信用户') {
          wx.showModal({
            title: '选择真实头像昵称',
            content: '已通过微信授权。请点击头像和昵称，一键使用你的微信头像与昵称',
            confirmText: '去完善',
            cancelText: '稍后',
            success: r => {
              if (r.confirm) wx.navigateTo({ url: '/pages/profile/profile' })
            }
          })
          return
        }
        this.persistLogin(nickName, avatarUrl)
      },
      fail: () => {
        wx.hideLoading()
        // 用户拒绝授权：引导手动完善资料页
        wx.navigateTo({ url: '/pages/profile/profile' })
      }
    })
  },

  // 保存微信授权获取的头像昵称，完成登录
  persistLogin(nickName, avatarUrl) {
    wx.showLoading({ title: '登录中', mask: true })
    const doSave = finalAvatar => {
      updateProfile({ nickName, avatarUrl: finalAvatar || '' })
        .then(() => {
          wx.hideLoading()
          wx.showToast({ title: '登录成功', icon: 'success' })
          const app = getApp()
          if (app.globalData) {
            app.globalData.userProfile = { nickName, avatarUrl: finalAvatar || '' }
          }
          this.refreshPage()
        })
        .catch(err => {
          wx.hideLoading()
          this.showError(err.message || '登录失败')
        })
    }
    if (isTempFile(avatarUrl)) {
      // 本地临时头像：上传到云存储换取持久 fileID
      uploadAvatar(avatarUrl)
        .then(fileID => doSave(fileID))
        .catch(() => doSave(avatarUrl))
    } else {
      doSave(avatarUrl)
    }
  },

  // 统计数字点击：跳转到对应列表
  onStatTap(e) {
    const type = e.currentTarget.dataset.type
    switch (type) {
      case 'points':
        // 我的钓点 → 钓点列表（首页地图/列表 tab）
        wx.switchTab({ url: '/pages/index/index' })
        break
      case 'fishRecords':
        // 渔获记录 → 我的鱼护列表
        wx.navigateTo({ url: '/pages/fishLog/fishLog' })
        break
      case 'activeRecords':
        // 活跃记录 = 出钓打卡/渔获上报 → 打卡钓点（生成活跃记录）
        wx.navigateTo({ url: '/pages/addPoint/addPoint' })
        break
      default:
        break
    }
  },

  // 查看鱼情模型成长
  goModelGrowth() {
    wx.showModal({
      title: '我的鱼情模型',
      content: `当前成长进度：${this.data.modelProgress}%\n更多鱼情分析能力敬请期待。`,
      showCancel: false
    })
  },

  // 菜单项点击分发
  onMenuTap(e) {
    const key = e.currentTarget.dataset.key
    switch (key) {
      case 'privatePoints':
        wx.switchTab({ url: '/pages/index/index' })
        break
      case 'fishRecords':
        wx.navigateTo({ url: '/pages/fishLog/fishLog' })
        break
      case 'drafts':
        this.handleDrafts()
        break
      case 'sync':
        this.toggleSyncMode()
        break
      case 'privacy':
        wx.showModal({
          title: '隐私与权限',
          content: '位置信息仅用于附近钓点与天气展示；钓点记录默认仅自己可见，分享后按分享规则访问。',
          showCancel: false
        })
        break
      default:
        break
    }
  },

  // 切换同步模式并持久化
  toggleSyncMode() {
    const nextMode = this.data.syncMode === 'cloud' ? 'local' : 'cloud'
    wx.showLoading({ title: '切换中', mask: true })
    updateSyncConfig(nextMode)
      .then(() => {
        this.setData({ syncMode: nextMode })
        wx.showToast({ title: '已切换', icon: 'success' })
      })
      .catch(err => {
        this.showError(err.message || '切换失败')
      })
      .finally(() => {
        wx.hideLoading()
      })
  },

  // 手动同步：从云端重新拉取用户资料与统计，刷新页面数据
  manualSync() {
    wx.showLoading({ title: '同步中', mask: true })
    Promise.all([
      getUserInfo().catch(() => null),
      getUserStats().catch(() => null)
    ])
      .then(([userInfo, statsRes]) => {
        wx.hideLoading()
        const profile = (userInfo && userInfo.profile) || this.data.profile
        const stats = (statsRes && statsRes.stats) || (userInfo && userInfo.stats) || this.data.stats
        this.setData({ profile, stats })
        wx.showToast({ title: '同步完成', icon: 'success' })
      })
      .catch(() => {
        wx.hideLoading()
        this.showError('同步失败，请检查网络')
      })
  },

  // 离线草稿入口：有草稿时提供恢复/清空操作，无草稿时提示
  handleDrafts() {
    const drafts = listDrafts()
    if (!drafts.length) {
      this.showToast('暂无离线草稿')
      return
    }
    const itemList = drafts.map(d => `恢复${d.title}`)
    itemList.push('清空全部草稿')
    wx.showActionSheet({
      itemList,
      success: res => {
        const picked = itemList[res.tapIndex]
        if (picked === '清空全部草稿') {
          clearAllDrafts()
          this.refreshDraft()
          this.showToast('草稿已清空')
          return
        }
        const draft = drafts[res.tapIndex]
        if (!draft) return
        if (draft.type === 'addPoint') {
          wx.navigateTo({ url: '/pages/addPoint/addPoint' })
        } else if (draft.type === 'addCatch') {
          wx.navigateTo({ url: '/pages/addCatch/addCatch' })
        }
      }
    })
  },

  // 快捷操作：快速新增渔获
  quickAddCatch() {
    ensureLogin()
      .then(() => wx.navigateTo({ url: '/pages/addCatch/addCatch' }))
      .catch(() => this.showError('登录失败，请稍后重试'))
  },

  // 快捷操作：快速新建钓点
  quickAddPoint() {
    ensureLogin()
      .then(() => wx.navigateTo({ url: '/pages/addPoint/addPoint' }))
      .catch(() => this.showError('登录失败，请稍后重试'))
  },

  // ===== 设置项 =====
  // 消息通知开关
  onNotifyChange(e) {
    const notify = !!e.detail.value
    updateSettings({ notify })
    this.setData({ settings: getSettings() })
    wx.showToast({ title: notify ? '已开启通知' : '已关闭通知', icon: 'none' })
  },

  // 距离单位切换（km / 米）
  onUnitTap(e) {
    const unit = e.currentTarget.dataset.unit
    if (unit !== 'km' && unit !== 'm') return
    const settings = updateSettings({ distanceUnit: unit })
    this.setData({ settings })
    wx.showToast({ title: unit === 'km' ? '距离单位：km' : '距离单位：米', icon: 'none' })
  },

  // 打开鱼种偏好弹层
  openFishPref() {
    this.setData({ showFishPref: true })
  },

  closeFishPref() {
    this.setData({ showFishPref: false })
  },

  noop() {},

  // 弹层内切换选中态
  onFishPrefToggle(e) {
    const name = e.currentTarget.dataset.name
    const fishPrefOptions = this.data.fishPrefOptions.map(item =>
      item.name === name ? Object.assign({}, item, { checked: !item.checked }) : item
    )
    this.setData({ fishPrefOptions })
  },

  // 确认鱼种偏好并持久化
  confirmFishPref() {
    const fishPref = this.data.fishPrefOptions.filter(item => item.checked).map(item => item.name)
    const settings = updateSettings({ fishPref })
    this.setData({
      settings,
      showFishPref: false,
      fishPrefText: fishPref.length ? `${fishPref.slice(0, 3).join('、')}${fishPref.length > 3 ? ` 等${fishPref.length}种` : ''}` : '未设置'
    })
    wx.showToast({ title: '偏好已保存', icon: 'success' })
  },

  // 复制诊断信息
  copyDiagnosis() {
    if (!this.data.diagnosisText) {
      this.showToast('暂无诊断信息')
      return
    }
    wx.setClipboardData({
      data: this.data.diagnosisText,
      success: () => {
        wx.showToast({ title: '已复制', icon: 'success' })
      },
      fail: () => {
        this.showToast('复制失败')
      }
    })
  },

  // 粘贴分析指令
  pasteAnalysis() {
    wx.getClipboardData({
      success: (res) => {
        const text = res.data
        if (!text) {
          this.showToast('剪贴板为空')
          return
        }
        wx.showModal({
          title: '已粘贴的诊断指令',
          content: text.slice(0, 500) + (text.length > 500 ? '...' : ''),
          showCancel: false
        })
      },
      fail: () => {
        this.showToast('读取剪贴板失败')
      }
    })
  },

  // 刷新统计数字（供外部调用）
  refreshStats() {
    getUserStats()
      .then(res => {
        this.setData({ stats: res.stats || this.data.stats })
      })
      .catch(() => {
        // 静默失败，避免打扰用户
      })
  },

  // 统一的轻错误提示（禁止裸抛）
  showError(msg) {
    wx.showToast({ title: msg, icon: 'none', duration: 2500 })
  },

  showToast(msg) {
    wx.showToast({ title: msg, icon: 'none' })
  }
})
