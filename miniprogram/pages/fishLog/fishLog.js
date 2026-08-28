// ============================================================
// 电子鱼护 - 主页（按设计稿复刻：月统计 / 出勤 / 放流率 / 周柱图 / 按位置 / 常见鱼 / 最近记录）
// ------------------------------------------------------------
// 数据全部走 cloud function fishLogService；前端只做展示与交互
// ============================================================
const {
  getFishSummary,
  getFishPointStats,
  listFishCatches,
  quickAddFishCatch,
  removeFishCatch,
  ensureLogin
} = require('../../utils/api')

// 24 种常见淡水鱼（按图像排序）+ 每种使用 distinct 的卡片底色（用于横滑列表）
const COMMON_FISH = [
  { name: '鲫鱼',    bg: '#fde4dc', stroke: '#a04830' },
  { name: '鲤鱼',    bg: '#fde2b6', stroke: '#a06a18' },
  { name: '草鱼',    bg: '#e6f4d8', stroke: '#5a8a30' },
  { name: '青鱼',    bg: '#cfe7d9', stroke: '#3a7a5a' },
  { name: '鲢鳙',    bg: '#dde6f8', stroke: '#3a5aa0' },
  { name: '黑鱼',    bg: '#cfd6dc', stroke: '#2a3a48' },
  { name: '翘嘴',    bg: '#e2eafc', stroke: '#506ac0' },
  { name: '马口',    bg: '#fae2c8', stroke: '#a05828' },
  { name: '罗非',    bg: '#fce0cc', stroke: '#b06a30' },
  { name: '鲶鱼',    bg: '#e0dccc', stroke: '#807040' },
  { name: '黄颡鱼',  bg: '#fde8c4', stroke: '#b07818' },
  { name: '白条',    bg: '#eef5e2', stroke: '#7a9650' },
  { name: '鳜鱼',    bg: '#f6e8d6', stroke: '#9a6028' },
  { name: '鲈鱼',    bg: '#dde9ee', stroke: '#406a8a' },
  { name: '鳊鱼',    bg: '#e0eef8', stroke: '#30689a' },
  { name: '鲦鱼',    bg: '#eaf3dc', stroke: '#7a9a30' },
  { name: '红尾',    bg: '#fadcdc', stroke: '#a04038' },
  { name: '鳡鱼',    bg: '#dadce0', stroke: '#4a4a52' },
  { name: '鳙鱼',    bg: '#dce4f0', stroke: '#3a508a' },
  { name: '黄尾鲴',  bg: '#fde8c0', stroke: '#a07a18' },
  { name: '其他',    bg: '#ece9e3', stroke: '#7a7060' },
  { name: '蒙古鲌',  bg: '#f6dce0', stroke: '#a04050' },
  { name: '鳑鲏',    bg: '#dce8de', stroke: '#508060' },
  { name: '鳊',      bg: '#e2eef6', stroke: '#306890' }
]

// 一周范围（周一为周首）的描述标签
const WEEK_LABELS = ['1周', '2周', '3周', '4周', '5周', '6周']

const RANGE_TABS = [
  { key: 'all',   label: '全部' },
  { key: 'week',  label: '本周' },
  { key: 'month', label: '选中月' }
]

Page({
  data: {
    // 月份选择器
    currentMonth: '',        // YYYY-MM
    currentMonthLabel: '',   // xxxx 年 x 月
    selectedDateMs: null,    // 当前展示的月份（取当月第一天 0 点）
    // 顶部统计
    summaryLoading: false,
    totalCount: 0,
    attendanceCount: 0,
    releaseCount: 0,
    releaseRate: 0,
    weekly: [0, 0, 0, 0, 0, 0],
    weeklyMax: 0,
    weekLabels: WEEK_LABELS,
    syncHint: '云端优先 · 本地备份',
    // 本月按位置
    pointGroups: [],
    pointStatsLoading: false,
    // 常见鱼快速处理
    commonFish: COMMON_FISH,
    commonFishCount: COMMON_FISH.length,
    // 最近记录 - tabs / toggle
    rangeTabs: RANGE_TABS,
    rangeKey: 'all',
    viewTabs: [{ key: 'list', label: '列表' }, { key: 'calendar', label: '日历' }],
    viewKey: 'list',
    records: [],
    recordsLoading: false,
    recordsLoadingMore: false,
    hasMore: false,
    page: 1,
    pageSize: 10,
    // 弹层
    showQuickAdd: false,
    quickAddFish: { name: '', icon: '', bg: '' },
    quickAddCount: 1,
    // 全局 loading
    loading: true,
    isLoggedIn: false,
    // 日历视图（按选中月份生成：每月1日对应周次的占位 + 当月所有日期的格）
    calendarCells: [],
    calendarLeadingEmpty: []
  },

  onLoad() {
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime()
    this.setData({
      currentMonth: month,
      currentMonthLabel: `${now.getFullYear()}年${now.getMonth() + 1}月鱼获`,
      selectedDateMs: monthStartMs
    })
  },

  onShow() {
    this.refreshAll()
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.refreshAll().finally(() => wx.stopPullDownRefresh())
  },

  // 一次性刷新：统计 + 按位置 + 最近记录
  refreshAll() {
    this.setData({ loading: true, summaryLoading: true })
    return Promise.all([
      this.loadSummary(),
      this.loadPointStats(),
      this.refreshRecords(true)
    ])
      .then(() => {
        // 同步登录态（用于判断是否可执行 quickAdd / save）
        return ensureLogin().then(ok => this.setData({ isLoggedIn: ok }))
      })
      .catch(() => {})
      .finally(() => {
        this.setData({ loading: false, summaryLoading: false })
      })
  },

  // 月度统计
  loadSummary() {
    return getFishSummary(this.data.currentMonth)
      .then(res => {
        this.setData({
          totalCount: res.totalCount || 0,
          attendanceCount: res.attendanceCount || 0,
          releaseCount: res.releaseCount || 0,
          releaseRate: typeof res.releaseRate === 'number' ? res.releaseRate : 0,
          weekly: res.weekly || [0, 0, 0, 0, 0, 0],
          weeklyMax: res.weeklyMax || 0
        })
      })
      .catch(err => {
        console.error('loadSummary error', err)
      })
  },

  // 按位置聚合
  loadPointStats() {
    this.setData({ pointStatsLoading: true })
    return getFishPointStats(this.data.currentMonth)
      .then(res => {
        const groups = (res.groups || []).map(g => ({
          ...g,
          releaseRate: g.totalCount > 0 ? Math.round((g.releaseCount / g.totalCount) * 100) : 0
        }))
        this.setData({ pointGroups: groups })
      })
      .catch(err => {
        console.error('loadPointStats error', err)
        this.setData({ pointGroups: [] })
      })
      .finally(() => this.setData({ pointStatsLoading: false }))
  },

  // 最近记录（支持分页 & tab 切换）
  refreshRecords(reset) {
    const { rangeKey, currentMonth, page, pageSize } = this.data
    if (reset) {
      this.setData({ recordsLoading: true, page: 1, records: [], hasMore: false })
    } else {
      if (!this.data.hasMore || this.data.recordsLoadingMore) return Promise.resolve()
      this.setData({ recordsLoadingMore: true })
    }
    const payload = {
      range: rangeKey,
      month: currentMonth,
      page: reset ? 1 : this.data.page,
      pageSize
    }
    return listFishCatches(payload)
      .then(res => {
        const list = (res.list || []).map(r => ({
          ...r,
          dateLabel: this.formatRecordDate(r.caughtAtMs),
          weekLabel: r.weekNo ? `第${r.weekNo}周` : '',
          typeLabel: r.isReleased ? '放流' : '保留'
        }))
        const merged = reset ? list : this.data.records.concat(list)
        this.setData({
          records: merged,
          hasMore: !!res.hasMore,
          page: reset ? 1 : (res.page || this.data.page)
        })
        // 记录变更后：如处于日历视图则立即重算每日累计
        if (this.data.viewKey === 'calendar') this.buildCalendarCells(this.data.currentMonth)
      })
      .catch(err => {
        console.error('refreshRecords error', err)
        if (reset) this.setData({ records: [] })
      })
      .finally(() => {
        this.setData({ recordsLoading: false, recordsLoadingMore: false })
      })
  },

  // 格式化记录日期：MM-DD HH:mm
  formatRecordDate(ms) {
    if (!ms) return ''
    const d = new Date(ms)
    const p = n => (n < 10 ? '0' + n : '' + n)
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  // 月份切换（上/下月）
  onMonthShift(e) {
    const dir = e.currentTarget.dataset.dir
    const cur = new Date(this.data.selectedDateMs)
    cur.setDate(1)
    cur.setMonth(cur.getMonth() + (dir === 'prev' ? -1 : 1))
    const y = cur.getFullYear()
    const m = cur.getMonth() + 1
    const monthStr = `${y}-${String(m).padStart(2, '0')}`
    this.setData({
      currentMonth: monthStr,
      currentMonthLabel: `${y}年${m}月鱼获`,
      selectedDateMs: new Date(y, m - 1, 1, 0, 0, 0, 0).getTime()
    })
    this.refreshAll()
      .then(() => {
        // 切到日历视图时立即按新月份重新生成
        if (this.data.viewKey === 'calendar') this.buildCalendarCells(monthStr)
      })
  },

  // 切换 range tab（全部/本周/选中月）
  onRangeChange(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.rangeKey) return
    this.setData({ rangeKey: key })
    this.refreshRecords(true)
  },

  // 切换视图 tab（列表/日历）
  onViewChange(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.viewKey) return
    this.setData({ viewKey: key })
    // 切到日历时基于当前选中月份生成日历单元格
    if (key === 'calendar') {
      this.buildCalendarCells(this.data.currentMonth)
    }
  },

  // 根据月份与记录列表构建日历单元格（每天的鱼数累计）
  buildCalendarCells(monthStr) {
    if (!/^\d{4}-\d{2}$/.test(monthStr)) {
      this.setData({ calendarCells: [], calendarLeadingEmpty: [] })
      return
    }
    const [y, m] = monthStr.split('-').map(Number)
    const lastDay = new Date(y, m, 0).getDate() // 当月最后一天
    // 计算 1 号对应的列偏移（周一=0...周日=6）
    const firstWeekday = (new Date(y, m - 1, 1).getDay() + 6) % 7
    const leading = []
    for (let i = 0; i < firstWeekday; i++) leading.push(i)
    // 聚合：每天的累计条数
    const map = {}
    this.data.records.forEach(r => {
      if (!r.caughtAtMs) return
      const d = new Date(r.caughtAtMs)
      if (d.getFullYear() !== y || d.getMonth() + 1 !== m) return
      const day = d.getDate()
      map[day] = (map[day] || 0) + (Number(r.count) || 0)
    })
    const cells = []
    for (let day = 1; day <= lastDay; day++) {
      cells.push({ day, count: map[day] || 0 })
    }
    this.setData({ calendarCells: cells, calendarLeadingEmpty: leading })
  },

  // 触底加载更多
  onReachBottom() {
    if (this.data.hasMore && !this.data.recordsLoadingMore) this.refreshRecords(false)
  },

  // 新增鱼获
  onGoAddCatch() {
    ensureLogin()
      .then(ok => {
        if (!ok) return
        wx.navigateTo({ url: '/pages/addCatch/addCatch' })
      })
  },

  // 常见鱼快速点击 -> 弹层确认
  onQuickTap(e) {
    const idx = e.currentTarget.dataset.index
    const fish = this.data.commonFish[idx]
    if (!fish) return
    ensureLogin()
      .then(ok => {
        if (!ok) return
        this.setData({
          showQuickAdd: true,
          quickAddFish: { name: fish.name, icon: fish.bg, bg: fish.bg },
          quickAddCount: 1
        })
      })
  },

  // 弹层：数量加减
  onQuickCountChange(e) {
    const op = e.currentTarget.dataset.op
    let n = Number(this.data.quickAddCount) || 1
    if (op === 'minus') n = Math.max(1, n - 1)
    else if (op === 'plus') n = Math.min(99, n + 1)
    this.setData({ quickAddCount: n })
  },

  // 弹层：确认快速录入
  onQuickConfirm() {
    const fish = this.data.quickAddFish
    const count = Number(this.data.quickAddCount) || 1
    if (!fish || !fish.name) return
    wx.showLoading({ title: '记录中', mask: true })
    quickAddFishCatch(fish.name, count)
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: `已记 ${fish.name} ×${count}`, icon: 'success' })
        this.setData({ showQuickAdd: false })
        this.refreshAll()
      })
      .catch(err => {
        wx.hideLoading()
        wx.showToast({ title: (err && err.message) || '记录失败', icon: 'none' })
      })
  },

  // 弹层：关闭
  onQuickClose() {
    this.setData({ showQuickAdd: false })
  },

  // 点空状态文案 -> 跳转添加
  onAddCatchTap() {
    this.onGoAddCatch()
  },

  // 按位置跳详情：打开对应月度记录区域（暂以 toast 提示）
  onPointGroupTap(e) {
    const idx = e.currentTarget.dataset.index
    const g = this.data.pointGroups[idx]
    if (!g) return
    this.setData({ rangeKey: 'month', viewKey: 'list' })
    wx.showToast({ title: `已切换到「${g.pointName}」月内记录`, icon: 'none' })
    this.refreshRecords(true)
  },

  // 删除单条记录（左滑删除）
  onRecordDelete(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '删除记录',
      content: '确认删除这条鱼护记录？',
      confirmText: '删除',
      confirmColor: '#e64340',
      success: r => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中' })
        removeFishCatch(id)
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已删除', icon: 'success' })
            this.refreshAll()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' })
          })
      }
    })
  }
})
