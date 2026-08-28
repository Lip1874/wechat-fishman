// 收费类型 -> 标签颜色
const FEE_CLASS_MAP = {
  '免费野钓': 'fee-green',
  '黑坑': 'fee-orange',
  '休闲收费塘': 'fee-blue',
  '禁钓': 'fee-red'
}

// 兜底默认选项（数据库无数据时使用）
const DEFAULT_WATER = ['江河','水库','河道','塘','湖泊','溪流']
const DEFAULT_FISH = ['鲫鱼','鲤鱼','草鱼','青鱼','鲢鳙','黑鱼','翘嘴','马口','罗非','鲶鱼','黄颡鱼','白条','鳜鱼','其他']

const { call, getOpenId } = require('../../utils/api')
const { ensureLogin } = require('../../utils/login')
const { weatherEmoji, warnLevelText } = require('../../utils/weather')
const { reverseGeocode } = require('../../utils/geo')
const { formatDistance } = require('../../utils/settings')

// 天气缓存：相同经纬度 15 分钟内不重复请求和风接口（手动点刷新强制重新请求）
const WEATHER_CACHE_KEY = 'weatherCache'
const WEATHER_CACHE_TTL = 15 * 60 * 1000

// 筛选条件持久化 key（鱼种/河道类型/状态/收费类型，本地 storage）
const FILTER_STORAGE_KEY = 'dp_index_filter_v1'

Page({
  data: {
    userLat: 39.9042,
    userLng: 116.4074,
    filteredList: [],      // 服务端筛选+分页后已加载的钓点列表
    swipeIdx: -1,          // 左滑展开的列表项索引（-1=无）
    swipeX: 0,             // 左滑跟手位移（rpx）
    touchIdx: -1,          // 正在触摸滑动的列表项索引
    batchMode: false,      // 是否处于批量选择模式
    selectedIds: [],       // 批量模式下已选中的钓点ID
    selectedMap: {},       // 批量模式下已选中ID映射（id->true，驱动模板选中态）
    // ---- 筛选条件（持久化到本地 storage，查询在云函数端执行）----
    feeFilterArr: ['全部','免费野钓','黑坑','休闲收费塘','禁钓'],
    feeFilter: '全部',
    waterTypeFilterArr: [{label:'全部', value:''}],
    waterTypeFilterIdx: 0,
    waterTypeValue: '',    // 河道类型筛选值（''=全部）
    waterTypeLabel: '水域类型',
    fishFilterArr: [{label:'全部', value:''}],
    fishFilterIdx: 0,
    fishValue: '',         // 鱼种筛选值（''=全部）
    fishLabel: '目标鱼种',
    statusFilterArr: ['全部','正常','作废'],
    statusFilter: '正常',   // 钓点状态筛选（默认隐藏作废，兼容旧行为）
    hiddenInvalidCount: 0, // 被"正常"状态过滤隐藏的作废钓点数（服务端统计）
    // ---- 更多筛选弹窗 + 已选筛选标签 ----
    filterOpen: false,     // 更多筛选弹窗是否打开
    activeFilterTags: [],  // 已选筛选标签（含搜索词），驱动标签展示与一键清空
    filterCount: 0,        // 非默认筛选数量（不含关键词，用于"更多筛选"角标）
    // ---- 搜索 ----
    keyword: '',           // 搜索框输入值
    searchKeyword: '',     // 实际生效的搜索词（回车/点搜索后提交）
    // ---- 分页 ----
    page: 1,
    pageSize: 10,
    total: 0,              // 服务端返回的匹配总数（头部"共 X 个"）
    hasMore: true,
    listLoading: false,    // 首页加载态
    loadingMore: false,    // 加载更多态
    loadError: '',         // 首页加载失败提示
    // 空状态文案分支
    emptyHidden: false,    // 因隐藏作废导致列表为空
    emptyNoMatch: false,   // 筛选/搜索无匹配
    emptyNoData: false,    // 暂无任何钓点
    // 模式与团队
    mode: 'private',      // private=我的私有 / neverEmpty=永不空军（首页团队统一入口，聚合全部团队钓点）；team 仅供 addPoint/detail 编辑链路使用
    teamId: '',           // 当前团队ID
    teamIds: [],          // 我加入的全部团队ID（永不空军分组聚合用）
    myTeams: [],          // 我的团队列表
    currentTitle: '我的私有钓点',
    emptyNoTeam: false,   // 永不空军分组：未加入任何团队时空状态
    // 首页当前位置实况天气
    weather: null,               // 天气数据（icon/text/temp/...）
    weatherAddr: '',             // 逆地址解析出的具体地址（如「北京市朝阳区太阳宫乡太阳宫中路」）
    weatherStatus: 'loading',    // loading=加载中 ok=正常 denied=定位被拒 error=接口异常
    weatherError: '',            // 接口异常时的具体原因（便于排查）
    weatherCollapsed: false      // 天气卡片折叠态（默认展开展示设备定位天气，支持一键收起）
  },

  // 天气缓存：同经纬度 15 分钟内直接读缓存，不重复请求（含逆地址解析结果 addr）
  readWeatherCache(lat, lng) {
    try {
      const cache = wx.getStorageSync(WEATHER_CACHE_KEY)
      if (!cache || !cache.weather) return null
      if (cache.lat !== lat || cache.lng !== lng) return null
      if (Date.now() - cache.time > WEATHER_CACHE_TTL) return null
      return cache
    } catch (e) {
      return null
    }
  },

  // 写天气缓存（addr 为可选的具体地址，随天气一同缓存）
  writeWeatherCache(lat, lng, weather, addr) {
    try {
      wx.setStorageSync(WEATHER_CACHE_KEY, { lat, lng, time: Date.now(), weather, addr: addr || '' })
    } catch (e) { /* 忽略存储失败 */ }
  },

  onLoad(options) {
    try {
      this.windowWidth = (wx.getWindowInfo ? wx.getWindowInfo().windowWidth : wx.getSystemInfoSync().windowWidth) || 375
    } catch (e) {
      this.windowWidth = 375
    }
    // 通过团队邀请卡片进入：?joinTeam=团队ID
    if (options.joinTeam) this.pendingJoinTeam = options.joinTeam
    // 直达永不空军分组（团队详情「永不空军」按钮 / 指定团队进入统一聚合，团队钓点都在此分组）
    if (options.teamId || options.neverEmpty) this.pendingNeverEmpty = true
    // 恢复上次保存的筛选条件（鱼种/河道类型/状态/收费）
    this.restoreFilters()
    this.refreshFilterTags()
    // 分页请求序号与并发标记：用于丢弃过期响应、防止重复请求
    this._listReqId = 0
    this._pendingList = 0
  },

  // 每次页面显示时刷新（首次进入、从新增/编辑/详情/团队页返回都会重新拉取）
  async onShow() {
    this.initOptions()
    this.getUserLocation()
    await this.migratePrivate()
    this.loadMyTeams()
    this.checkLoginGuide()
  },

  // 游客模式引导：首页/地图页无需登录即可浏览全部钓点（微信审核要求）。
  // 此处仅静默预热 openid 缓存（loginService 自动建档 user），
  // 不弹任何授权窗，正式登录校验在【新增标点】【我的】等入口触发。
  checkLoginGuide() {
    ensureLogin().catch(() => {})
  },

  // 旧 fishing_point 数据迁移到 dianpoints（私有，幂等，无数据时秒回）
  // 顺带执行 repairOpenid：修复历史缺失 _openid 的私有钓点（幂等）
  migratePrivate() {
    return call('dianpointService', { action: 'migratePrivate' })
      .then(() => call('dianpointService', { action: 'repairOpenid' }))
      .then(() => {
        // 迁移/修复完成后若当前处于私有模式，刷新一次列表
        if (this.data.mode === 'private') this.loadPoints()
      })
      .catch(() => {})
  },

  // 加载我的团队（创建的+加入的），并处理邀请/指定团队进入
  async loadMyTeams() {
    try {
      const res = await call('teamService', { action: 'getMyTeams' })
      const myTeams = res.teams || []
      const teamIds = myTeams.map(t => t._id)
      this.setData({ myTeams, teamIds })

      // 优先处理：通过邀请卡片加入团队
      if (this.pendingJoinTeam) {
        const joinTeamId = this.pendingJoinTeam
        this.pendingJoinTeam = null
        this.joinTeamById(joinTeamId)
        return
      }
      // 直达永不空军分组：聚合我加入的全部团队钓点（团队钓点自动同步到该分组）
      if (this.pendingNeverEmpty) {
        this.pendingNeverEmpty = null
        this.setData({ mode: 'neverEmpty', teamId: '', currentTitle: '永不空军' })
      }
      this.loadPoints()
    } catch (err) {
      console.error('加载团队失败', err)
      this.loadPoints()
    }
  },

  // 通过分享卡片加入团队
  joinTeamById(teamId) {
    wx.showLoading({ title: '正在加入团队' })
    call('teamService', { action: 'joinTeam', teamId })
      .then(res => {
        wx.hideLoading()
        wx.showToast({ title: res.alreadyJoined ? '你已在团队中' : `已加入「${res.teamName}」` })
        // 团队钓点统一聚合在「永不空军」分组展示（首页不再按团队分 tab）
        this.setData({ mode: 'neverEmpty', teamId: '', currentTitle: '永不空军' })
        this.loadMyTeams()
        this.loadPoints()
      })
      .catch(() => {
        wx.hideLoading()
        wx.showModal({ title: '提示', content: '无权限访问该团队', showCancel: false, success: () => {} })
      })
  },

  // 切换为我的私有钓点
  switchPrivate() {
    if (this.data.mode === 'private') return
    this.setData({ mode: 'private', teamId: '', currentTitle: '私有钓点' })
    this.loadPoints()
  },

  // 永不空军：聚合我全部团队的钓点（团队钓点自动同步到该分组）
  switchNeverEmpty() {
    if (this.data.mode === 'neverEmpty') return
    this.setData({ mode: 'neverEmpty', teamId: '', currentTitle: '永不空军' })
    this.loadPoints()
  },

  // 跳转团队管理页（tabBar 页面需用 switchTab）
  goTeamList() {
    wx.switchTab({ url: '/pages/teamList/teamList' })
  },

  // 加载筛选选项（水域/鱼种，来自 point_option 集合，只读「自己名下的」字典项；dictType 区分，兼容旧 category 字段）
  async initOptions() {
    const db = wx.cloud.database()
    let water = [], fish = []
    try {
      const openid = await getOpenId()
      const res = await db.collection('point_option')
        .where({ _openid: openid })
        .orderBy('sort','asc')
        .limit(100)
        .get()
      res.data.forEach(i => {
        const type = i.dictType || (i.category === 'waterType' ? 'river_type' : i.category === 'fish' ? 'fish_type' : '')
        const label = i.label || i.value || ''
        const value = i.value || label
        if (!label) return
        if (type === 'river_type') water.push({ label, value })
        else if (type === 'fish_type') fish.push({ label, value })
      })
    } catch (err) {
      console.error('读取筛选选项失败', err)
    }
    // 名下无个人数据时使用默认兜底（在「我的-基础数据」首次打开会自动生成个人标准选项）
    if (!water.length) water = DEFAULT_WATER.map(v => ({ label: v, value: v }))
    if (!fish.length) fish = DEFAULT_FISH.map(v => ({ label: v, value: v }))
    this.setData({
      waterTypeFilterArr: [{ label: '全部', value: '' }, ...water],
      fishFilterArr: [{ label: '全部', value: '' }, ...fish]
    })
    // 选项加载完成后回填持久化的筛选值（值已不存在则回退到"全部"）
    this.syncFilterIdx()
    this.refreshFilterTags()
  },

  // 获取当前定位（成功后同时刷新距离与首页天气）
  getUserLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({
          userLat: res.latitude,
          userLng: res.longitude
        })
        this.refreshDistances()
        this.fetchWeather(res.latitude, res.longitude)
        this.loadWeatherAddr(res.latitude, res.longitude)
      },
      fail: () => {
        wx.showToast({ title: '定位失败', icon: 'none' })
        // 定位权限被拒绝/失败：天气卡片降级提示，地图、列表、新增钓点等业务完全不受影响
        this.setData({ weatherStatus: 'denied' })
      }
    })
  },

  // 获取当前位置实况天气（失败仅降级卡片，绝不影响其他业务）
  // force=true 时跳过缓存强制重新请求（点刷新按钮）
  fetchWeather(lat, lng, force) {
    if (!lat || !lng) return
    const rLat = Number(lat.toFixed(4))
    const rLng = Number(lng.toFixed(4))
    if (!force) {
      const cached = this.readWeatherCache(rLat, rLng)
      if (cached) {
        this.setData({ weather: cached.weather, weatherAddr: cached.addr || '', weatherStatus: 'ok', weatherError: '' })
        return
      }
    }
    this.setData({ weatherStatus: 'loading', weatherError: '' })
    call('getWeather', { lat, lon: lng, type: 'now' })
      .then(res => {
        if (!res.weather) throw new Error('无天气数据')
        const w = res.weather
        // 预警等级文案（供预警条展示）；预警文字精简：如「蓝色·大风」「黄色·暴雨」
        const warning = (w.warning || []).map(item => {
          const levelText = warnLevelText(item.color)
          const level = String(levelText || '').replace(/^\S+\s*/, '') // 去掉 emoji 前缀，如「蓝色」
          return {
            ...item,
            levelText,
            brief: `${level}${item.eventName ? '·' + item.eventName : ''}`,
            headShort: String(item.headline || '').slice(0, 22)
          }
        })
        // 24小时逐时：天气图标 emoji + 降雨概率颜色分级（0-30浅灰 / 30-60浅蓝 / 60-100深蓝）
        const hourly = (w.hourly || []).map(h => ({
          ...h,
          emoji: weatherEmoji(h.icon),
          probClass: h.prob == null ? '' : (h.prob <= 30 ? 'prob-low' : (h.prob <= 60 ? 'prob-mid' : 'prob-high'))
        }))
        const weather = Object.assign({}, w, {
          emoji: weatherEmoji(w.icon),
          hourly,
          warning,
          hasWarn: warning.length > 0
        })
        this.setData({ weather, weatherStatus: 'ok', weatherError: '' })
        this.writeWeatherCache(rLat, rLng, weather, this.data.weatherAddr)
      })
      .catch(err => {
        console.error('获取天气失败', err)
        this.setData({
          weatherStatus: 'error',
          weatherError: (err && err.message) || '天气服务暂时不可用'
        })
      })
  },

  // 手动刷新天气：重新定位后强制重新请求（跳过 15 分钟缓存）
  onRefreshWeather() {
    this.setData({ weatherStatus: 'loading', weatherError: '' })
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.fetchWeather(res.latitude, res.longitude, true)
        this.loadWeatherAddr(res.latitude, res.longitude, true)
      },
      fail: () => {
        wx.showModal({
          title: '需要定位权限',
          content: '获取当前位置天气需要定位权限，是否前往设置开启？',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.openSetting()
            else this.setData({ weatherStatus: 'denied' })
          }
        })
      }
    })
  },

  // 逆地址解析当前位置 -> 具体地址（腾讯地图 WebService，地址随天气缓存同 TTL 15 分钟）
  // 地址仅用于展示天气所属位置，失败静默降级（回退到和风反查的区县名或"当前位置"）
  loadWeatherAddr(lat, lng, force) {
    if (!lat || !lng) return
    const rLat = Number(lat.toFixed(4))
    const rLng = Number(lng.toFixed(4))
    if (!force) {
      const cached = this.readWeatherCache(rLat, rLng)
      if (cached && cached.addr) {
        this.setData({ weatherAddr: cached.addr })
        return
      }
    }
    reverseGeocode(lat, lng)
      .then(addr => {
        if (!addr) return
        this.setData({ weatherAddr: addr })
        // 天气缓存已存在时同步补充地址，避免下次进页面重复解析
        const cached = this.readWeatherCache(rLat, rLng)
        if (cached && cached.weather) this.writeWeatherCache(rLat, rLng, cached.weather, addr)
      })
      .catch(() => { /* 解析失败不阻塞天气展示 */ })
  },

  // 折叠/展开天气卡片：默认收起以保证钓点列表可见，点击头部切换
  onWeatherToggle() {
    this.setData({ weatherCollapsed: !this.data.weatherCollapsed })
  },

  // 点击预警条：展示预警详情
  onWarnTap(e) {
    const idx = e.currentTarget.dataset.index
    const warn = this.data.weather && this.data.weather.warning && this.data.weather.warning[idx]
    if (!warn) return
    wx.showModal({
      title: `${warn.levelText || ''}预警`,
      content: warn.description || warn.headline || '暂无详情',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  // ---- 分页加载钓点（筛选/搜索/分页全部在云函数 dianpointService.list 中执行）----
  // reset=true 重新拉第一页；reset=false 追加下一页（滚动到底触发）
  loadPoints(reset = true) {
    // 加载更多仅在无并发请求时允许；重新加载永远允许（可覆盖进行中的旧请求）
    if (!reset && (this._pendingList > 0 || !this.data.hasMore)) return
    const { mode, teamId, teamIds, pageSize, searchKeyword, feeFilter, waterTypeValue, fishValue, statusFilter } = this.data
    // 永不空军分组：未加入任何团队时直接展示空状态（无需请求服务端）
    if (mode === 'neverEmpty' && !teamIds.length) {
      this.setData({
        filteredList: [],
        total: 0,
        page: 1,
        hasMore: false,
        hiddenInvalidCount: 0,
        listLoading: false,
        loadingMore: false,
        emptyHidden: false,
        emptyNoTeam: true,
        emptyNoMatch: false,
        emptyNoData: false
      })
      return
    }
    const nextPage = reset ? 1 : this.data.page + 1
    const reqId = ++this._listReqId // 新请求会使旧的 in-flight 请求结果作废（防串页）
    this._pendingList++
    this.setData(reset
      ? { listLoading: true, loadError: '' }
      : { loadingMore: true })

    const payload = {
      action: 'list',
      mode,
      page: nextPage,
      pageSize,
      keyword: searchKeyword,
      fee: feeFilter && feeFilter !== '全部' ? feeFilter : '',
      waterType: waterTypeValue,
      fish: fishValue,
      status: statusFilter
    }
    if (mode === 'neverEmpty') payload.teamIds = teamIds
    else payload.teamId = teamId
    call('dianpointService', payload)
      .then(res => {
        if (reqId !== this._listReqId) return // 已有更新的请求，丢弃本次过期结果
        const list = (res.list || []).map(item => this.normalizeItem(item))
        const filteredList = reset ? list : this.data.filteredList.concat(list)
        const hiddenInvalidCount = res.hiddenInvalidCount || 0
        const isHiddenEmpty = filteredList.length === 0 && hiddenInvalidCount > 0 && statusFilter === '正常'
        this.setData({
          filteredList,
          total: res.total || 0,
          page: res.page || nextPage,
          hasMore: !!res.hasMore,
          hiddenInvalidCount,
          listLoading: false,
          loadingMore: false,
          loadError: '',
          // 空状态文案分支：隐藏作废 / 未加入团队 / 筛选无匹配 / 暂无数据
          emptyHidden: isHiddenEmpty,
          emptyNoTeam: false,
          emptyNoMatch: filteredList.length === 0 && !isHiddenEmpty && this.hasActiveFilter(),
          emptyNoData: filteredList.length === 0 && !isHiddenEmpty && !this.hasActiveFilter()
        })
        // 距离仅做展示计算；分页后保持服务端 createTime 倒序，不再做客户端距离排序
        this.refreshDistances()
      })
      .catch(err => {
        if (reqId !== this._listReqId) return
        console.error('读取钓点失败', err)
        this.setData({
          listLoading: false,
          loadingMore: false,
          loadError: reset ? (err.message || '加载失败，请稍后重试') : ''
        })
        if (!reset) wx.showToast({ title: '加载更多失败，请重试', icon: 'none' })
      })
      .then(() => {
        // 无论成功失败都释放并发标记（等价 finally）
        this._pendingList = Math.max(0, this._pendingList - 1)
      })
  },

  // 列表项数据归一化（字段兼容 + 展示用派生字段）
  normalizeItem(item) {
    const fish = item.fish || []
    return {
      ...item,
      // 兼容历史数据：status 缺省视为正常
      invalid: item.status === '作废',
      // 近期有人上鱼（服务端按最近7天鱼获记录标记）
      recentCatch: !!item.recentCatch,
      fishPreview: fish.slice(0, 3),
      fishMore: fish.length > 3 ? fish.length - 3 : 0,
      cover: (item.images && item.images.length) ? item.images[0] : '',
      feeClass: FEE_CLASS_MAP[item.feeType] || 'tag-gray',
      creatorShort: item.creatorName || (item.createOpenid ? item.createOpenid.slice(-6) : ''),
      distance: '',
      distanceNum: Infinity
    }
  },

  // 计算两点距离（km）
  calcDistance(lat1, lng1, lat2, lng2) {
    const R = 6371
    const rad = d => d * Math.PI / 180
    const dLat = rad(lat2 - lat1)
    const dLng = rad(lng2 - lng1)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  },

  // 计算当前列表项到我的距离（仅展示，不影响排序）
  refreshDistances() {
    const { userLat, userLng, filteredList } = this.data
    if (!userLat || !filteredList.length) return
    const list = filteredList.map(item => {
      let distance = ''
      let distanceNum = Infinity
      if (item.latitude) {
        const d = this.calcDistance(userLat, userLng, item.latitude, item.longitude)
        distanceNum = d
        distance = formatDistance(d)
      }
      // 距离 > 50km 置灰弱化
      return { ...item, distance, distanceNum, distFar: distanceNum > 50 }
    })
    this.setData({ filteredList: list })
  },

  // 当前是否有筛选/搜索条件（驱动空状态文案）
  hasActiveFilter() {
    const { searchKeyword, feeFilter, waterTypeValue, fishValue, statusFilter } = this.data
    // 默认状态筛选「正常」不视为主动筛选：空列表时应提示「暂无钓点」而非「没有符合条件的钓点」
    return !!(searchKeyword || (feeFilter && feeFilter !== '全部') || waterTypeValue || fishValue || (statusFilter && statusFilter !== '正常'))
  },

  // 页面滚动到底部：加载下一页（页面级滚动，天气展开后下滑即可看到列表）
  onReachBottom() {
    if (this.data.hasMore && !this.data.listLoading) this.loadPoints(false)
  },

  // 首页加载失败：点击重试
  onRetry() {
    this.loadPoints(true)
  },

  // ---- 筛选条件持久化 ----
  // 从本地 storage 恢复上次筛选（onLoad 时调用）
  restoreFilters() {
    try {
      const saved = wx.getStorageSync(FILTER_STORAGE_KEY) || {}
      const patch = {}
      if (saved.fee && this.data.feeFilterArr.indexOf(saved.fee) > -1) patch.feeFilter = saved.fee
      if (saved.status && this.data.statusFilterArr.indexOf(saved.status) > -1) patch.statusFilter = saved.status
      if (saved.waterType) patch.waterTypeValue = saved.waterType
      if (saved.fish) patch.fishValue = saved.fish
      this.setData(patch)
      this.refreshFilterTags()
    } catch (e) { /* 存储异常忽略，使用默认值 */ }
  },

  // ---- 更多筛选弹窗 ----
  openFilterPopup() {
    this.setData({ filterOpen: true })
  },
  closeFilterPopup() {
    this.setData({ filterOpen: false })
  },
  // 计算已选筛选标签（驱动标签展示与一键清空；含搜索词）
  buildActiveFilterTags() {
    const { feeFilter, waterTypeValue, waterTypeFilterArr, fishValue, fishFilterArr, statusFilter, searchKeyword } = this.data
    const tags = []
    if (feeFilter && feeFilter !== '全部') tags.push({ key: 'fee', label: feeFilter })
    if (waterTypeValue) {
      const w = waterTypeFilterArr.find(i => i.value === waterTypeValue)
      if (w) tags.push({ key: 'waterType', label: w.label })
    }
    if (fishValue) {
      const f = fishFilterArr.find(i => i.value === fishValue)
      if (f) tags.push({ key: 'fish', label: f.label })
    }
    if (statusFilter && statusFilter !== '正常') tags.push({ key: 'status', label: statusFilter })
    if (searchKeyword) tags.push({ key: 'keyword', label: `「${searchKeyword}」` })
    return tags
  },
  // 刷新已选标签 + "更多筛选"角标数（非默认筛选，不含关键词）
  refreshFilterTags() {
    const activeFilterTags = this.buildActiveFilterTags()
    const filterCount = activeFilterTags.filter(t => t.key !== 'keyword').length
    this.setData({ activeFilterTags, filterCount })
  },
  // 一键清空所有筛选（含搜索词）
  onClearFilters() {
    this.setData({
      feeFilter: '全部',
      waterTypeValue: '',
      waterTypeFilterIdx: 0,
      fishValue: '',
      fishFilterIdx: 0,
      statusFilter: '正常',
      keyword: '',
      searchKeyword: ''
    })
    this.refreshFilterTags()
    this.saveFilters()
    this.loadPoints(true)
  },
  // 移除单个已选筛选标签
  onRemoveFilterTag(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    if (key === 'fee') patch.feeFilter = '全部'
    else if (key === 'waterType') { patch.waterTypeValue = ''; patch.waterTypeFilterIdx = 0 }
    else if (key === 'fish') { patch.fishValue = ''; patch.fishFilterIdx = 0 }
    else if (key === 'status') patch.statusFilter = '正常'
    else if (key === 'keyword') { patch.keyword = ''; patch.searchKeyword = '' }
    if (!Object.keys(patch).length) return
    this.setData(patch)
    this.refreshFilterTags()
    this.saveFilters()
    this.loadPoints(true)
  },

  // 保存当前筛选到本地 storage（筛选变化时调用）
  saveFilters() {
    const { feeFilter, statusFilter, waterTypeValue, fishValue } = this.data
    try {
      wx.setStorageSync(FILTER_STORAGE_KEY, {
        fee: feeFilter,
        status: statusFilter,
        waterType: waterTypeValue,
        fish: fishValue
      })
    } catch (e) { /* 存储失败不影响功能 */ }
  },

  // 选项加载/筛选恢复后，回填 picker 索引与展示文案（值不存在则回退"全部"）
  syncFilterIdx() {
    const { waterTypeFilterArr, fishFilterArr, waterTypeValue, fishValue } = this.data
    let wIdx = waterTypeFilterArr.findIndex(i => i.value === waterTypeValue)
    let fIdx = fishFilterArr.findIndex(i => i.value === fishValue)
    const patch = {}
    if (wIdx < 0) { wIdx = 0; patch.waterTypeValue = '' }
    if (fIdx < 0) { fIdx = 0; patch.fishValue = '' }
    patch.waterTypeFilterIdx = wIdx
    patch.fishFilterIdx = fIdx
    patch.waterTypeLabel = wIdx > 0 ? waterTypeFilterArr[wIdx].label : '水域类型'
    patch.fishLabel = fIdx > 0 ? fishFilterArr[fIdx].label : '目标鱼种'
    this.setData(patch)
  },

  // 收费类型筛选（一级横向标签，变化即持久化并重新分页拉取）
  onFeeFilter(e) {
    const feeFilter = e.currentTarget.dataset.val
    if (feeFilter === this.data.feeFilter) return
    this.setData({ feeFilter })
    this.refreshFilterTags()
    this.saveFilters()
    this.loadPoints(true)
  },
  // 弹窗内：水域类型筛选（chips）
  onPopupWaterTap(e) {
    const val = e.currentTarget.dataset.value
    const idx = this.data.waterTypeFilterArr.findIndex(i => i.value === val)
    if (idx < 0) return
    const item = this.data.waterTypeFilterArr[idx]
    this.setData({
      waterTypeFilterIdx: idx,
      waterTypeValue: item.value || '',
      waterTypeLabel: item.value ? item.label : '水域类型'
    })
    this.refreshFilterTags()
    this.saveFilters()
    this.loadPoints(true)
  },
  // 弹窗内：目标鱼种筛选（chips）
  onPopupFishTap(e) {
    const val = e.currentTarget.dataset.value
    const idx = this.data.fishFilterArr.findIndex(i => i.value === val)
    if (idx < 0) return
    const item = this.data.fishFilterArr[idx]
    this.setData({
      fishFilterIdx: idx,
      fishValue: item.value || '',
      fishLabel: item.value ? item.label : '目标鱼种'
    })
    this.refreshFilterTags()
    this.saveFilters()
    this.loadPoints(true)
  },
  // 钓点状态筛选：全部 / 正常 / 作废
  onStatusFilter(e) {
    const status = e.currentTarget.dataset.val
    if (status === this.data.statusFilter) return
    this.setData({ statusFilter: status })
    this.refreshFilterTags()
    this.saveFilters()
    this.loadPoints(true)
  },

  // ---- 搜索 ----
  // 搜索框输入（仅更新输入态，回车/点搜索才触发查询）
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
  },
  // 提交搜索（键盘"搜索"按钮 / 点击"搜索"按钮）：提交关键词并重新查询
  onSearchConfirm() {
    const keyword = (this.data.keyword || '').trim()
    if (keyword === this.data.searchKeyword) return
    this.setData({ searchKeyword: keyword })
    this.refreshFilterTags()
    this.loadPoints(true)
  },
  // 清空搜索并恢复列表
  onSearchClear() {
    this.setData({ keyword: '', searchKeyword: '' })
    this.refreshFilterTags()
    this.loadPoints(true)
  },

  // 查看附近钓点地图（跟随当前模式/团队；永不空军=聚合全部团队钓点）
  goMapPage() {
    const { mode, teamId, teamIds, currentTitle } = this.data
    if (mode === 'neverEmpty') {
      wx.navigateTo({
        url: `/pages/mapPage/mapPage?mode=teamAll&teamIds=${(teamIds || []).join(',')}&title=${encodeURIComponent(currentTitle)}`
      })
      return
    }
    wx.navigateTo({
      url: `/pages/mapPage/mapPage?mode=${mode}&teamId=${teamId}&title=${encodeURIComponent(currentTitle)}`
    })
  },

  // 点击列表条目跳转详情（批量模式下切换选中；点击已展开删除项仅收起不跳转）
  goDetail(e) {
    const idx = e.currentTarget.dataset.index
    // 长按刚触发过批量模式的本次 tap 忽略，避免误取消选中
    if (Date.now() - (this._longPressAt || 0) < 350) return
    if (this.data.batchMode) {
      this.onCheckTap(e)
      return
    }
    if (this.data.swipeIdx === idx) {
      this.setData({ swipeIdx: -1 })
      return
    }
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    })
  },

  // ---- 批量选择/删除 ----
  // 进入/退出批量选择模式
  toggleBatch() {
    const next = !this.data.batchMode
    this.setData({
      batchMode: next,
      selectedIds: [],
      selectedMap: {},
      swipeIdx: -1,
      swipeX: 0
    })
  },
  // 长按钓点条目：直接进入批量管理模式并选中当前项（轻震动反馈）
  onItemLongPress(e) {
    if (this.data.batchMode) return
    this._longPressAt = Date.now()
    const id = e.currentTarget.dataset.id
    const selectedMap = {}
    if (id) selectedMap[id] = true
    this.setData({
      batchMode: true,
      selectedIds: id ? [id] : [],
      selectedMap,
      swipeIdx: -1,
      swipeX: 0
    })
    try { wx.vibrateShort({ type: 'light' }) } catch (err) { /* 低版本基础库忽略 */ }
  },
  // 切换单个钓点的选中状态
  onCheckTap(e) {
    const id = e.currentTarget.dataset.id
    const selectedIds = [...this.data.selectedIds]
    const selectedMap = { ...this.data.selectedMap }
    const idx = selectedIds.indexOf(id)
    if (idx > -1) {
      selectedIds.splice(idx, 1)
      delete selectedMap[id]
    } else {
      selectedIds.push(id)
      selectedMap[id] = true
    }
    this.setData({ selectedIds, selectedMap })
  },
  // 全选 / 取消全选（基于当前筛选结果）
  onSelectAll() {
    const { filteredList, selectedIds } = this.data
    if (filteredList.length && selectedIds.length === filteredList.length) {
      this.setData({ selectedIds: [], selectedMap: {} })
    } else {
      const selectedMap = {}
      filteredList.forEach(i => { selectedMap[i._id] = true })
      this.setData({ selectedIds: filteredList.map(i => i._id), selectedMap })
    }
  },
  // 批量删除 -> 二次确认 -> 调云函数
  onBatchDelete() {
    const { selectedIds } = this.data
    if (!selectedIds.length) {
      wx.showToast({ title: '请先选择钓点', icon: 'none' })
      return
    }
    wx.showModal({
      title: '批量删除',
      content: `确认删除选中的 ${selectedIds.length} 个钓点？删除后不可恢复`,
      confirmText: '删除',
      confirmColor: '#e64340',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中' })
        call('dianpointService', { action: 'removeMany', ids: selectedIds })
          .then(res => {
            wx.hideLoading()
            wx.showToast({ title: res.failed ? `已删除${res.removed}个，${res.failed}个失败` : `已删除${res.removed}个` })
            this.setData({ batchMode: false, selectedIds: [], selectedMap: {} })
            this.loadPoints()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '删除失败', icon: 'none' })
          })
      }
    })
  },

  // ---- 左滑删除 ----
  onSwipeStart(e) {
    if (this.data.batchMode) return // 批量模式下禁用左滑
    const idx = e.currentTarget.dataset.index
    const t = e.touches[0]
    this.touchStartX = t.clientX
    this.touchStartY = t.clientY
    this.touchItem = idx
    this.horiz = null
  },
  onSwipeMove(e) {
    if (this.touchItem === undefined || this.touchItem === null) return
    const dx = e.touches[0].clientX - this.touchStartX
    const dy = e.touches[0].clientY - this.touchStartY
    if (this.horiz === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      this.horiz = Math.abs(dx) > Math.abs(dy)
      if (!this.horiz) return // 纵向滑动交给页面滚动
    }
    if (!this.horiz) return
    const px2rpx = 750 / this.windowWidth
    let x = dx * px2rpx
    if (this.touchItem === this.data.swipeIdx) x -= 160 // 已展开项的滑动起点
    if (x > 0) x = 0
    if (x < -170) x = -170
    this.setData({ touchIdx: this.touchItem, swipeX: x })
  },
  onSwipeEnd() {
    if (this.touchItem === undefined || this.touchItem === null) return
    const idx = this.touchItem
    const x = this.data.swipeX
    this.touchItem = null
    if (x < -80) {
      this.setData({ swipeIdx: idx, swipeX: 0, touchIdx: -1 })   // 左滑超过阈值 -> 展开删除
    } else {
      this.setData({ swipeIdx: -1, swipeX: 0, touchIdx: -1 })    // 否则全部收起
    }
  },
  // 点击删除按钮 -> 二次确认 -> 删除
  onDeleteTap(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.filteredList[idx]
    if (!item) return
    this.setData({ swipeIdx: -1, swipeX: 0 })
    wx.showModal({
      title: '删除钓点',
      content: `确认删除「${item.name}」？删除后不可恢复`,
      confirmText: '删除',
      confirmColor: '#e64340',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中' })
        call('dianpointService', { action: 'remove', id: item._id })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已删除' })
            this.loadPoints()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '删除失败', icon: 'none' })
          })
      }
    })
  },

  // 归档快捷操作：标记钓点为作废（二次确认）
  onArchiveTap(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.filteredList[idx]
    if (!item) return
    wx.showModal({
      title: '归档钓点',
      content: `确认将「${item.name}」归档（标记为作废）？作废钓点默认不在列表展示`,
      confirmText: '归档',
      confirmColor: '#d48806',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中' })
        call('dianpointService', { action: 'updateStatus', id: item._id, status: '作废' })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已归档' })
            this.loadPoints()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '操作失败', icon: 'none' })
          })
      }
    })
  },
  // 恢复快捷操作：作废 -> 正常
  onRestoreTap(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.filteredList[idx]
    if (!item) return
    wx.showLoading({ title: '处理中' })
    call('dianpointService', { action: 'updateStatus', id: item._id, status: '正常' })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已恢复' })
        this.loadPoints()
      })
      .catch(err => {
        wx.hideLoading()
        wx.showToast({ title: err.message || '操作失败', icon: 'none' })
      })
  },

  // 跳转添加钓点页面（跟随当前模式/团队）
  // 【新增标点】前置登录校验：先静默登录拿到 openid，成功后才进入新增页；
  // 游客点击时触发微信一键授权（静默鉴权，不弹窗）
  goAddPoint() {
    wx.showLoading({ title: '登录中', mask: false })
    ensureLogin()
      .then(() => {
        wx.hideLoading()
        const { mode, teamId, teamIds, myTeams } = this.data
        if (mode === 'team' && teamId) {
          // 团队详情页等指定团队入口进入（编辑链路保留）
          wx.navigateTo({ url: `/pages/addPoint/addPoint?mode=team&teamId=${teamId}` })
        } else if (mode === 'neverEmpty') {
          // 永不空军聚合多个团队：单团队直接进入，多团队先选目标团队
          if (!teamIds.length) {
            wx.showToast({ title: '请先创建或加入团队', icon: 'none' })
            return
          }
          if (teamIds.length === 1) {
            wx.navigateTo({ url: `/pages/addPoint/addPoint?mode=team&teamId=${teamIds[0]}` })
          } else {
            wx.showActionSheet({
              itemList: myTeams.map(t => t.teamName),
              success: (r) => {
                const t = myTeams[r.tapIndex]
                if (t) wx.navigateTo({ url: `/pages/addPoint/addPoint?mode=team&teamId=${t._id}` })
              }
            })
          }
        } else {
          wx.navigateTo({ url: '/pages/addPoint/addPoint?mode=private' })
        }
      })
      .catch(err => {
        wx.hideLoading()
        wx.showToast({ title: (err && err.message) || '登录失败，请稍后重试', icon: 'none' })
      })
  }
})
