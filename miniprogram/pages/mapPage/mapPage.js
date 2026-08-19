const { call } = require('../../utils/api')

Page({
  data: {
    centerLat: 39.9042,
    centerLng: 116.4074,
    markers: [],
    includePoints: [],
    title: '钓点地图'
  },

  onLoad(options) {
    this.mode = options.mode || 'private'
    this.teamId = options.teamId || ''
    if (options.title) this.setData({ title: decodeURIComponent(options.title) })
    this.getLocation()
    this.loadPoints()
  },

  // 定位到用户当前位置（作为地图中心候选）
  getLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({
          centerLat: res.latitude,
          centerLng: res.longitude
        })
      },
      fail: () => {}
    })
  },

  // 按当前模式/团队加载钓点标点（云函数校验权限）
  loadPoints() {
    call('dianpointService', { action: 'list', mode: this.mode, teamId: this.teamId })
      .then(res => {
        const markers = (res.list || []).map(item => ({
          id: item._id,
          latitude: item.latitude,
          longitude: item.longitude,
          width: 34,
          height: 34,
          label: {
            content: item.name,
            color: '#ffffff',
            fontSize: 12,
            borderRadius: 8,
            bgColor: '#008844',
            padding: 6,
            anchorX: -20,
            anchorY: -32
          }
        }))
        const includePoints = markers.map(m => ({
          latitude: m.latitude,
          longitude: m.longitude
        }))
        this.setData({
          markers,
          includePoints
        })
        // 用所有标点的几何中心作为地图中心
        if (markers.length) {
          const lat = markers.reduce((s, m) => s + m.latitude, 0) / markers.length
          const lng = markers.reduce((s, m) => s + m.longitude, 0) / markers.length
          this.setData({ centerLat: lat, centerLng: lng })
        }
      })
      .catch(err => {
        wx.showToast({ title: err.message || '加载失败', icon: 'none' })
        if (err.code === 3) {
          setTimeout(() => wx.navigateBack(), 1200)
        }
      })
  },

  // 点击标点跳详情
  markertap(e) {
    wx.navigateTo({
      url: `/pages/detail/detail?id=${e.markerId}`
    })
  },

  // 返回列表页
  back() {
    wx.navigateBack()
  }
})
