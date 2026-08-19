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

const { call } = require('../../utils/api')

Page({
  data: {
    userLat: 39.9042,
    userLng: 116.4074,
    pointList: [],      // 全量钓点（含距离/排序）
    filteredList: [],   // 筛选后展示列表
    swipeIdx: -1,       // 左滑展开的列表项索引（-1=无）
    swipeX: 0,          // 左滑跟手位移（rpx）
    touchIdx: -1,       // 正在触摸滑动的列表项索引
    batchMode: false,   // 是否处于批量选择模式
    selectedIds: [],    // 批量模式下已选中的钓点ID
    selectedMap: {},    // 批量模式下已选中ID映射（id->true，驱动模板选中态）
    // 筛选条件
    feeFilterArr: ['全部','免费野钓','黑坑','休闲收费塘','禁钓'],
    feeFilter: '全部',
    waterTypeFilterArr: ['全部'],
    waterTypeFilterIdx: 0,
    waterTypeFilter: '',
    fishFilterArr: ['全部'],
    fishFilterIdx: 0,
    fishFilter: '',
    // 模式与团队
    mode: 'private',      // private=我的私有 / team=团队
    teamId: '',           // 当前团队ID
    myTeams: [],          // 我的团队列表
    currentTitle: '我的私有钓点'
  },

  onLoad(options) {
    this.windowWidth = (wx.getSystemInfoSync().windowWidth) || 375
    // 通过团队邀请卡片进入：?joinTeam=团队ID
    if (options.joinTeam) this.pendingJoinTeam = options.joinTeam
    // 通过指定团队进入（可后续扩展）
    if (options.teamId) this.pendingSwitchTeam = options.teamId
  },

  // 每次页面显示时刷新（首次进入、从新增/编辑/详情/团队页返回都会重新拉取）
  async onShow() {
    this.initOptions()
    this.getUserLocation()
    await this.migratePrivate()
    this.loadMyTeams()
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
      this.setData({ myTeams })

      // 优先处理：通过邀请卡片加入团队
      if (this.pendingJoinTeam) {
        const joinTeamId = this.pendingJoinTeam
        this.pendingJoinTeam = null
        this.joinTeamById(joinTeamId)
        return
      }
      // 指定团队进入：校验是否为成员
      if (this.pendingSwitchTeam) {
        const tid = this.pendingSwitchTeam
        this.pendingSwitchTeam = null
        const team = myTeams.find(t => t._id === tid)
        if (team) {
          this.setData({ mode: 'team', teamId: tid, currentTitle: team.teamName })
        } else {
          wx.showModal({ title: '提示', content: '无权限访问该团队', showCancel: false, success: () => {} })
        }
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
        this.setData({ mode: 'team', teamId, currentTitle: res.teamName })
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
    this.setData({ mode: 'private', teamId: '', currentTitle: '我的私有钓点' })
    this.loadPoints()
  },

  // 切换团队
  switchTeam(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.mode === 'team' && this.data.teamId === id) return
    const team = this.data.myTeams.find(t => t._id === id)
    this.setData({ mode: 'team', teamId: id, currentTitle: team ? team.teamName : '' })
    this.loadPoints()
  },

  // 跳转团队管理页
  goTeamList() {
    wx.navigateTo({ url: '/pages/teamList/teamList' })
  },

  // 加载筛选选项（水域/鱼种，来自 point_option 集合）
  async initOptions() {
    const db = wx.cloud.database()
    let water = [], fish = []
    try {
      const res = await db.collection('point_option').orderBy('sort','asc').limit(100).get()
      res.data.forEach(i => {
        if (i.category === 'waterType') water.push(i.value)
        else if (i.category === 'fish') fish.push(i.value)
      })
    } catch (err) {
      console.error('读取筛选选项失败', err)
    }
    if (!water.length) water = DEFAULT_WATER
    if (!fish.length) fish = DEFAULT_FISH
    this.setData({
      waterTypeFilterArr: ['全部', ...water],
      fishFilterArr: ['全部', ...fish]
    })
  },

  // 获取当前定位
  getUserLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({
          userLat: res.latitude,
          userLng: res.longitude
        })
        this.refreshDistances()
      },
      fail: () => {
        wx.showToast({ title: '定位失败', icon: 'none' })
      }
    })
  },

  // 按当前模式/团队加载钓点（全部走云函数校验权限）
  loadPoints() {
    const { mode, teamId } = this.data
    call('dianpointService', { action: 'list', mode, teamId })
      .then(res => {
        const pointList = (res.list || []).map(item => {
          const fish = item.fish || []
          return {
            ...item,
            fishPreview: fish.slice(0, 3),
            fishMore: fish.length > 3 ? fish.length - 3 : 0,
            cover: (item.images && item.images.length) ? item.images[0] : '',
            feeClass: FEE_CLASS_MAP[item.feeType] || 'tag-gray',
            creatorShort: item.createOpenid ? item.createOpenid.slice(-6) : '',
            distance: '',
            distanceNum: Infinity
          }
        })
        this.setData({ pointList })
        this.refreshDistances()
      })
      .catch(err => {
        console.error('读取钓点失败', err)
        if (err.code === 3) {
          // 无权限（如被移出团队）-> 提示并回到私有模式
          wx.showModal({
            title: '提示',
            content: '无权限访问该团队',
            showCancel: false,
            success: () => {
              this.setData({ mode: 'private', teamId: '', currentTitle: '我的私有钓点' })
              this.loadPoints()
            }
          })
        } else {
          wx.showToast({ title: err.message || '加载失败', icon: 'none' })
        }
      })
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

  // 计算距离并按距离升序排序，然后应用筛选
  refreshDistances() {
    const { userLat, userLng, pointList } = this.data
    if (!userLat || !pointList.length) {
      this.applyFilter()
      return
    }
    const list = pointList.map(item => {
      let distance = ''
      let distanceNum = Infinity
      if (item.latitude) {
        const d = this.calcDistance(userLat, userLng, item.latitude, item.longitude)
        distanceNum = d
        distance = d < 1 ? (d * 1000).toFixed(0) + 'm' : d.toFixed(1) + 'km'
      }
      return { ...item, distance, distanceNum }
    }).sort((a, b) => a.distanceNum - b.distanceNum)
    this.setData({ pointList: list })
    this.applyFilter()
  },

  // 按当前筛选条件过滤
  applyFilter() {
    const { pointList, feeFilter, waterTypeFilter, fishFilter, selectedIds } = this.data
    let list = pointList
    if (feeFilter && feeFilter !== '全部') {
      list = list.filter(i => i.feeType === feeFilter)
    }
    if (waterTypeFilter) {
      list = list.filter(i => i.waterType === waterTypeFilter)
    }
    if (fishFilter) {
      list = list.filter(i => (i.fish || []).indexOf(fishFilter) > -1)
    }
    // 筛选变化时，清掉已不在列表中的选中项（避免计数虚高）
    const ids = selectedIds.filter(id => list.some(i => i._id === id))
    const selectedMap = {}
    ids.forEach(id => { selectedMap[id] = true })
    this.setData({ filteredList: list, selectedIds: ids, selectedMap })
  },

  // 收费类型筛选
  onFeeFilter(e) {
    this.setData({ feeFilter: e.currentTarget.dataset.val })
    this.applyFilter()
  },
  // 水域类型筛选
  onWaterTypeFilter(e) {
    const idx = e.detail.value
    const val = this.data.waterTypeFilterArr[idx]
    this.setData({
      waterTypeFilterIdx: idx,
      waterTypeFilter: val === '全部' ? '' : val
    })
    this.applyFilter()
  },
  // 鱼种筛选
  onFishFilter(e) {
    const idx = e.detail.value
    const val = this.data.fishFilterArr[idx]
    this.setData({
      fishFilterIdx: idx,
      fishFilter: val === '全部' ? '' : val
    })
    this.applyFilter()
  },

  // 查看附近钓点地图（跟随当前模式/团队）
  goMapPage() {
    const { mode, teamId, currentTitle } = this.data
    wx.navigateTo({
      url: `/pages/mapPage/mapPage?mode=${mode}&teamId=${teamId}&title=${encodeURIComponent(currentTitle)}`
    })
  },

  // 点击列表条目跳转详情（批量模式下切换选中；点击已展开删除项仅收起不跳转）
  goDetail(e) {
    const idx = e.currentTarget.dataset.index
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

  // 跳转添加钓点页面（跟随当前模式/团队）
  goAddPoint() {
    const { mode, teamId } = this.data
    if (mode === 'team') {
      wx.navigateTo({ url: `/pages/addPoint/addPoint?mode=team&teamId=${teamId}` })
    } else {
      wx.navigateTo({ url: '/pages/addPoint/addPoint?mode=private' })
    }
  }
})
