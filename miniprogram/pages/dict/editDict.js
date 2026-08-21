const { call } = require('../../utils/api')

Page({
  data: {
    dictType: '',
    id: '',        // 编辑模式记录ID（空=新增）
    isEdit: false,
    title: '新增字典选项',
    form: { label: '', value: '', sort: '' }
  },

  onLoad(options) {
    const dictType = options.dictType || ''
    const id = options.id || ''
    this.setData({
      dictType,
      id,
      isEdit: !!id,
      title: id ? '编辑字典选项' : '新增字典选项'
    })
    wx.setNavigationBarTitle({ title: this.data.title })
    if (id) this.loadDetail(id, dictType)
  },

  // 编辑回显：从该分类列表中定位记录
  async loadDetail(id, dictType) {
    try {
      const res = await call('dictOperate', { action: 'list', dictType })
      const item = (res.list || []).find(i => i._id === id)
      if (item) {
        this.setData({ form: { label: item.label, value: item.value, sort: String(item.sort) } })
      } else {
        wx.showToast({ title: '记录不存在或已删除', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
      }
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const form = this.data.form
    form[key] = e.detail.value
    this.setData({ form })
  },

  // 提交（新增/编辑全部走云函数，云函数内校验管理员权限与 value 唯一性）
  async submit() {
    const f = this.data.form
    const label = (f.label || '').trim()
    const value = (f.value || '').trim()
    const sort = parseInt(f.sort)
    if (!label) return wx.showToast({ title: '请填写展示名称', icon: 'none' })
    if (!value) return wx.showToast({ title: '请填写存储值', icon: 'none' })
    if (isNaN(sort) || sort < 0) return wx.showToast({ title: '排序号需为不小于0的数字', icon: 'none' })

    wx.showLoading({ title: '提交中' })
    try {
      const payload = {
        action: this.data.isEdit ? 'update' : 'add',
        dictType: this.data.dictType,
        label,
        value,
        sort
      }
      if (this.data.isEdit) payload.id = this.data.id
      await call('dictOperate', payload)
      wx.hideLoading()
      wx.showToast({ title: this.data.isEdit ? '保存成功' : '新增成功' })
      setTimeout(() => wx.navigateBack(), 800)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
    }
  }
})
