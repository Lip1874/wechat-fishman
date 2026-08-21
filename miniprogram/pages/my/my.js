const { getAdminInfo } = require('../../utils/api')

Page({
  data: {
    openidShort: '',   // openid 后6位展示
    isAdmin: false,    // 管理员才可见「基础数据」分组
    groups: [
      {
        id: 'base',
        title: '基础数据',
        adminOnly: true,   // 仅管理员可见（标题+子项整体隐藏）
        expanded: false,
        items: [
          { icon: '🐟', text: '鱼种维护', desc: '维护自己的鱼种选项（仅自己可见）', type: 'fish_type' },
          { icon: '🌊', text: '河道类型维护', desc: '维护自己的河道类型选项（仅自己可见）', type: 'river_type' }
        ]
      },
      {
        id: 'other',
        title: '其他',
        adminOnly: false,
        expanded: false,
        items: [
          { icon: 'ℹ️', text: '关于钓点地图', desc: '版本与说明', action: 'about' }
        ]
      }
    ]
  },

  onShow() {
    // 获取当前用户标识 + 管理员状态
    getAdminInfo().then(({ openid, isAdmin }) => {
      this.setData({ openidShort: openid ? openid.slice(-6) : '', isAdmin })
    }).catch(() => {})
  },

  // 点击分组标题：切换展开/收起（各分组独立状态，可同时展开）
  toggleGroup(e) {
    const id = e.currentTarget.dataset.id
    const groups = this.data.groups.map(g =>
      g.id === id ? Object.assign({}, g, { expanded: !g.expanded }) : g
    )
    this.setData({ groups })
  },

  // 子菜单点击分发（保留原有跳转逻辑）
  onItemTap(e) {
    const { action, type } = e.currentTarget.dataset
    if (action === 'about') {
      this.onAbout()
      return
    }
    if (type) {
      this.goDict(type)
    }
  },

  // 跳转字典维护页（人人可维护自己的字典项）
  goDict(dictType) {
    wx.navigateTo({ url: `/pages/dict/dict?dictType=${dictType}` })
  },

  onAbout() {
    wx.showModal({
      title: '钓点地图',
      content: '微信云开发钓点工具 v1.0.0\n你可以在「基础数据」中维护个人的鱼种、河道类型等字典选项，选项仅自己可见，会同步到首页筛选和新增钓点下拉。',
      showCancel: false
    })
  }
})
