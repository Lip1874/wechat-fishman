// 记录一次鱼获表单（按设计稿：横向鱼种、信息卡、步进器、饵料、处理方式、位置）
const { saveFishCatch, ensureLogin } = require('../../utils/api')
const { saveDraft, getDraft, clearDraft } = require('../../utils/draft')

// 常见鱼种（与 fishLog 保持一致，避免两份数据不同步）
const FISH_OPTIONS = [
  { name: '翘嘴', fullName: '翘嘴鲌', bg: '#e2eafc', stroke: '#506ac0', desc: '常见做法：清蒸翘嘴、红烧翘嘴、糟溜鱼片', tip: '暂养：原始资料含该鱼保活经验，但未附字段匹配的专项来源；以下仅显示通用现场顺序。' },
  { name: '鲫鱼', fullName: '鲫鱼', bg: '#fde4dc', stroke: '#a04830', desc: '常见做法：鲫鱼豆腐汤、红烧鲫鱼', tip: '底层杂食，喜泥底水草边，早晚窗口明显。' },
  { name: '白条', fullName: '白条鱼', bg: '#eef5e2', stroke: '#7a9650', desc: '常见做法：香煎白条、油炸白条', tip: '中上层小体型，对反光亮片敏感，适合轻型装备。' },
  { name: '青梢', fullName: '青梢红鲌', bg: '#cfe7d9', stroke: '#3a7a5a', desc: '常见做法：干烧、清蒸', tip: '翘嘴近缘种，喜流水与开阔水面，活性高。' },
  { name: '鲤鱼', fullName: '鲤鱼', bg: '#fde2b6', stroke: '#a06a18', desc: '常见做法：糖醋鲤鱼、红烧鲤鱼', tip: '底栖拱泥觅食，对甜香发酵饵偏好明显。' },
  { name: '草鱼', fullName: '草鱼', bg: '#e6f4d8', stroke: '#5a8a30', desc: '常见做法：酸菜鱼、水煮鱼', tip: '草食性，高温季节活性高，喜嫩草、玉米粒。' },
  { name: '青鱼', fullName: '青鱼', bg: '#cfe7d9', stroke: '#3a7a5a', desc: '常见做法：红烧青鱼、熏鱼', tip: '喜食螺蛳、河蚌，个体大，耐力强。' },
  { name: '鲢鳙', fullName: '鲢鳙', bg: '#dde6f8', stroke: '#3a5aa0', desc: '常见做法：剁椒鱼头、鱼头豆腐汤', tip: '滤食性，高温溶氧充足时疯狂追饵。' },
  { name: '黑鱼', fullName: '乌鳢', bg: '#cfd6dc', stroke: '#2a3a48', desc: '常见做法：酸菜鱼、水煮鱼', tip: '伏击型掠食鱼，喜重草区，雷强最佳目标。' },
  { name: '马口', fullName: '马口鱼', bg: '#fae2c8', stroke: '#a05828', desc: '常见做法：香煎、油炸', tip: '溪流代表鱼种，对急流与小亮片反应快。' },
  { name: '罗非', fullName: '罗非鱼', bg: '#fce0cc', stroke: '#b06a30', desc: '常见做法：清蒸、红烧', tip: '喜暖，南方常见，对腥味饵接受度高。' },
  { name: '鲶鱼', fullName: '鲶鱼', bg: '#e0dccc', stroke: '#807040', desc: '常见做法：鲶鱼炖茄子', tip: '夜行性，喜昏暗环境，对腥臭饵敏感。' },
  { name: '黄颡鱼', fullName: '黄颡鱼', bg: '#fde8c4', stroke: '#b07818', desc: '常见做法：黄辣丁汤、红烧', tip: '底栖，喜浑水，夜钓命中率更高。' },
  { name: '鳜鱼', fullName: '鳜鱼', bg: '#f6e8d6', stroke: '#9a6028', desc: '常见做法：清蒸鳜鱼', tip: '伏击型，喜石堆、倒树等结构区。' },
  { name: '鲈鱼', fullName: '鲈鱼', bg: '#dde9ee', stroke: '#406a8a', desc: '常见做法：清蒸鲈鱼', tip: '掠食性，对拟饵反应积极，窗口期明显。' },
  { name: '鳊鱼', fullName: '鳊鱼', bg: '#e0eef8', stroke: '#30689a', desc: '常见做法：清蒸、红烧', tip: '中下层，喜食嫩草、浮游生物。' },
  { name: '鲦鱼', fullName: '鲦鱼', bg: '#eaf3dc', stroke: '#7a9a30', desc: '常见做法：香煎', tip: '群居中上层，俗称“餐条”，适合微物。' },
  { name: '红尾', fullName: '红尾鲴', bg: '#fadcdc', stroke: '#a04038', desc: '常见做法：红烧', tip: '流水型鱼种，对红虫、蚯蚓偏好强。' },
  { name: '鳡鱼', fullName: '鳡鱼', bg: '#dadce0', stroke: '#4a4a52', desc: '常见做法：鱼丸、熏鱼', tip: '顶级掠食者，巡游水面，需大水面搜索。' },
  { name: '其他', fullName: '其他鱼种', bg: '#ece9e3', stroke: '#7a7060', desc: '未列出的鱼种', tip: '可在备注中补充具体鱼种与特征。' }
]

const BAIT_OPTIONS = [
  '卷尾软饵', '蚯蚓', '红虫', '玉米粒', '商品饵',
  '米诺', '亮片', 'VIB', '铅头钩', '波爬', '其他'
]

const HANDLING_OPTIONS = [
  { value: true, label: '已放流', sub: '保护资源，可持续垂钓' },
  { value: false, label: '带走', sub: '已保留，合规带走' }
]

Page({
  data: {
    // 鱼种
    fishOptions: FISH_OPTIONS,
    fishIdx: 0,
    // 数量
    count: 1,
    // 长度
    lengthCm: '',
    // 饵料
    baitOptions: BAIT_OPTIONS,
    baitIdx: -1,
    baitName: '',
    showBaitPanel: false,
    // 处理方式
    handlingOptions: HANDLING_OPTIONS,
    handlingIdx: 0,
    isReleased: true,
    showHandlingPanel: false,
    // 位置
    recordLocation: true,
    locationName: '',
    locationAddress: '',
    location: null,
    // 时间（设计稿未展示时间选择，默认当前时间）
    caughtAtMs: null,
    // 提交
    submitting: false
  },

  onLoad(options) {
    this.setData({ caughtAtMs: Date.now() })
    // 默认选中「翘嘴」，与截图一致
    let idx = 0
    if (options && options.preFish) {
      const found = FISH_OPTIONS.findIndex(f => f.name === options.preFish)
      if (found >= 0) idx = found
    }
    this.setData({ fishIdx: idx })

    // 若有从地图选点带回的位置，则回填
    if (options && options.pointName) {
      this.setData({
        locationName: options.pointName,
        locationAddress: options.address || '',
        location: options.latitude && options.longitude
          ? { latitude: Number(options.latitude), longitude: Number(options.longitude) }
          : null
      })
    } else {
      // 默认开启记录位置时，自动尝试取一次当前位置（失败静默）
      this.fetchCurrentLocation(true)
    }

    // 恢复本地未保存草稿（未填写内容时不打扰）
    this.restoreDraft()
  },

  // ===== 离线草稿：离开自动保存 / 进入自动恢复 / 提交成功清除 =====
  saveDraftNow() {
    // 已提交成功：清理草稿
    if (this._submitted) { clearDraft('addCatch'); return }
    const { fishIdx, count, lengthCm, baitIdx, baitName, isReleased, handlingIdx,
      recordLocation, locationName, locationAddress, location, caughtAtMs } = this.data
    // 无实际填写内容时不落草稿
    const hasContent = Number(count) > 1 || !!lengthCm || !!baitName || !!locationName
    if (!hasContent) { clearDraft('addCatch'); return }
    saveDraft('addCatch', { fishIdx, count, lengthCm, baitIdx, baitName, isReleased, handlingIdx, recordLocation, locationName, locationAddress, location, caughtAtMs })
  },

  restoreDraft() {
    const draft = getDraft('addCatch')
    if (!draft) return
    this.setData({
      fishIdx: typeof draft.fishIdx === 'number' ? draft.fishIdx : this.data.fishIdx,
      count: Number(draft.count) || 1,
      lengthCm: draft.lengthCm || '',
      baitIdx: typeof draft.baitIdx === 'number' ? draft.baitIdx : -1,
      baitName: draft.baitName || '',
      isReleased: typeof draft.isReleased === 'boolean' ? draft.isReleased : true,
      handlingIdx: typeof draft.handlingIdx === 'number' ? draft.handlingIdx : 0,
      recordLocation: typeof draft.recordLocation === 'boolean' ? draft.recordLocation : true,
      locationName: draft.locationName || '',
      locationAddress: draft.locationAddress || '',
      location: draft.location || null,
      caughtAtMs: draft.caughtAtMs || Date.now()
    })
  },

  onUnload() {
    this.saveDraftNow()
  },

  // ===== 鱼种选择 =====
  onFishTap(e) {
    const idx = e.currentTarget.dataset.index
    if (typeof idx !== 'number') return
    this.setData({ fishIdx: idx })
  },

  // ===== 数量步进 =====
  onCountChange(e) {
    const op = e.currentTarget.dataset.op
    let n = Number(this.data.count) || 1
    if (op === 'minus') n = Math.max(1, n - 1)
    else if (op === 'plus') n = Math.min(999, n + 1)
    this.setData({ count: n })
  },

  // ===== 长度步进 / 输入 =====
  onLengthInput(e) {
    this.setData({ lengthCm: e.detail.value })
  },
  onLengthStep(e) {
    const op = e.currentTarget.dataset.op
    let v = parseFloat(this.data.lengthCm)
    if (isNaN(v)) v = 0
    if (op === 'minus') v = Math.max(0, Math.round((v - 1) * 10) / 10)
    else if (op === 'plus') v = Math.min(999, Math.round((v + 1) * 10) / 10)
    this.setData({ lengthCm: v > 0 ? String(v) : '' })
  },

  // ===== 饵料选择 =====
  openBaitPanel() {
    this.setData({ showBaitPanel: true })
  },
  closeBaitPanel() {
    this.setData({ showBaitPanel: false })
  },
  onBaitTap(e) {
    const idx = e.currentTarget.dataset.index
    const name = this.data.baitOptions[idx]
    this.setData({ baitIdx: idx, baitName: name, showBaitPanel: false })
  },

  // ===== 处理方式选择 =====
  openHandlingPanel() {
    this.setData({ showHandlingPanel: true })
  },
  closeHandlingPanel() {
    this.setData({ showHandlingPanel: false })
  },
  onHandlingTap(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.handlingOptions[idx]
    if (!item) return
    this.setData({
      handlingIdx: idx,
      isReleased: item.value,
      showHandlingPanel: false
    })
  },

  // ===== 位置 =====
  onLocationToggle(e) {
    const recordLocation = !!e.detail.value
    this.setData({ recordLocation })
    if (recordLocation && !this.data.location) {
      this.fetchCurrentLocation(true)
    }
  },

  fetchCurrentLocation(silent = false) {
    wx.getLocation({
      type: 'gcj02',
      success: res => {
        const location = { latitude: res.latitude, longitude: res.longitude }
        this.setData({
          location,
          locationName: '当前位置',
          locationAddress: `${res.latitude.toFixed(4)}, ${res.longitude.toFixed(4)}`
        })
        // 尝试逆地址解析出名称
        this.reverseGeocode(location)
      },
      fail: () => {
        if (!silent) wx.showToast({ title: '需要定位权限', icon: 'none' })
      }
    })
  },

  // 简易逆地址：调用云开发内置或腾讯地图；这里先只尝试 wx.chooseLocation 更直接
  reverseGeocode(location) {
    // 预留：后续可接入腾讯地图 SDK 解析地址；
    // 当前仅保持经纬度作为地址展示。
    this.setData({
      locationAddress: `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`
    })
  },

  onCurrentLocation() {
    this.fetchCurrentLocation(false)
  },

  onMapPicker() {
    wx.chooseLocation({
      success: res => {
        this.setData({
          locationName: res.name || '地图选点',
          locationAddress: res.address || '',
          location: { latitude: res.latitude, longitude: res.longitude }
        })
      },
      fail: err => {
        if (err.errMsg && err.errMsg.indexOf('cancel') > -1) return
        wx.showToast({ title: '选点失败', icon: 'none' })
      }
    })
  },

  onMyFavorites() {
    wx.showToast({ title: '我的收藏功能开发中', icon: 'none' })
  },

  // ===== 提交 =====
  async submit() {
    if (this.data.submitting) return
    const loggedIn = await ensureLogin()
    if (!loggedIn) return

    const { fishOptions, fishIdx, count, lengthCm, isReleased, baitName, recordLocation, location, locationName, caughtAtMs } = this.data
    const fish = fishOptions[fishIdx]
    if (!fish) return wx.showToast({ title: '请选择鱼种', icon: 'none' })
    if (!count || count < 1) return wx.showToast({ title: '数量至少为 1', icon: 'none' })

    let finalLocation = null
    let finalPointName = ''
    if (recordLocation && location && typeof location.latitude === 'number') {
      finalLocation = location
      finalPointName = locationName || ''
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '保存中', mask: true })

    try {
      await saveFishCatch({
        fishName: fish.name,
        count,
        weight: '',
        lengthCm: lengthCm === '' ? null : lengthCm,
        isReleased,
        caughtAt: caughtAtMs,
        pointName: finalPointName,
        bait: baitName,
        remark: '',
        location: finalLocation
      })
      wx.hideLoading()
      this._submitted = true
      clearDraft('addCatch')
      wx.showToast({ title: '已加入本次出勤', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)
    } catch (err) {
      wx.hideLoading()
      this.setData({ submitting: false })
      wx.showToast({ title: (err && err.message) || '记录失败', icon: 'none' })
    }
  }
})
