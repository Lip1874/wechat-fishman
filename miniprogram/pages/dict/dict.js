const { call, getAdminInfo } = require('../../utils/api')

// dictType -> 页面标题
const TITLE_MAP = {
  fish_type: '鱼种维护',
  river_type: '河道类型维护'
}

Page({
  data: {
    dictType: '',
    title: '字典维护',
    list: [],       // 我的字典选项（sort 升序，仅自己可见）
    loading: true,
    isAdmin: false, // 非管理员仅只读：隐藏操作按钮与拖拽能力
    saving: false   // 防重复提交
  },

  onLoad(options) {
    const dictType = options.dictType || ''
    const title = TITLE_MAP[dictType] || '字典维护'
    this.setData({ dictType, title })
    wx.setNavigationBarTitle({ title })
    getAdminInfo().then(({ isAdmin }) => this.setData({ isAdmin })).catch(() => {})
    this.checkBaseLib()
    this.loadList()
  },

  // movable-list 拖拽排序需要基础库 3.2.0+，版本过低时给出明确提示
  checkBaseLib() {
    let sdk = ''
    try {
      if (wx.getAppBaseInfo) {
        sdk = (wx.getAppBaseInfo().SDKVersion || '')
      } else if (wx.getSystemInfoSync) {
        sdk = (wx.getSystemInfoSync().SDKVersion || '')
      }
    } catch (err) { /* 忽略 */ }
    const [major, minor] = sdk.split('.').map(n => parseInt(n, 10) || 0)
    if (!sdk || major < 3 || (major === 3 && minor < 2)) {
      wx.showModal({
        title: '基础库版本过低',
        content: `拖拽排序需要基础库 3.2.0 及以上，当前版本 ${sdk || '未知'}。请在开发者工具「详情-本地设置-调试基础库」中切换到 3.2.0 或更高版本后重新编译。`,
        showCancel: false
      })
    }
  },

  onPullDownRefresh() {
    this.loadList().finally(() => wx.stopPullDownRefresh())
  },

  // 加载我的字典列表（云函数按 _openid 过滤，仅返回自己维护的选项）
  async loadList() {
    try {
      const res = await call('dictOperate', { action: 'list', dictType: this.data.dictType })
      this.setData({ list: res.list || [], loading: false })
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  // 新增选项（仅管理员）
  goAdd() {
    if (!this.data.isAdmin) return
    wx.navigateTo({ url: `/pages/dict/editDict?dictType=${this.data.dictType}` })
  },

  // 编辑选项（仅管理员，默认项不可编辑）
  goEdit(e) {
    if (!this.data.isAdmin) return
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(i => i._id === id)
    if (!item) return
    if (item.isDefault) {
      wx.showToast({ title: '默认字典项不可修改', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/dict/editDict?dictType=${this.data.dictType}&id=${id}` })
  },

  // 删除选项（仅管理员，仅自增项可删，二次确认）
  onDelete(e) {
    if (!this.data.isAdmin) return
    const item = this.data.list[e.currentTarget.dataset.index]
    if (!item) return
    if (item.isDefault) {
      wx.showToast({ title: '默认字典项不可删除', icon: 'none' })
      return
    }
    wx.showModal({
      title: '删除选项',
      content: `确定删除「${item.label}」？删除后不可恢复`,
      confirmText: '删除',
      confirmColor: '#e64340',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中' })
        call('dictOperate', { action: 'delete', id: item._id })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已删除' })
            this.loadList()
          })
          .catch(err => {
            wx.hideLoading()
            wx.showToast({ title: err.message || '删除失败', icon: 'none' })
          })
      }
    })
  },

  // 开始拖拽：重置变更标记
  onDragStart() {
    this._orderChanged = false
  },

  // movable-list 排序变化：实时同步本地列表顺序
  onDragChange(e) {
    const detail = e.detail || {}
    if (!detail.changed) return
    if (typeof detail.oldIndex !== 'number' || typeof detail.index !== 'number') return
    this._orderChanged = true
    const list = this.data.list.slice()
    const [item] = list.splice(detail.oldIndex, 1)
    list.splice(detail.index, 0, item)
    this.setData({ list })
  },

  // 拖拽结束（松手）：自动批量保存新顺序
  onDragEnd() {
    if (!this.data.isAdmin || !this._orderChanged || this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中' })
    call('dictOperate', {
      action: 'sortBatch',
      dictType: this.data.dictType,
      ids: this.data.list.map(i => i._id)
    })
      .then(() => {
        wx.hideLoading()
        this.setData({ saving: false })
        wx.showToast({ title: '顺序已保存' })
        this.loadList()
      })
      .catch(err => {
        wx.hideLoading()
        this.setData({ saving: false })
        wx.showToast({ title: err.message || '保存失败', icon: 'none' })
        this.loadList()
      })
  }
})
