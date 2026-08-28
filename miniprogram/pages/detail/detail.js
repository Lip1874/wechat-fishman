const { call, getOpenId } = require('../../utils/api')
const { weatherEmoji } = require('../../utils/weather')
const { reverseGeocode, QQ_MAP_KEY } = require('../../utils/geo')
const { formatDistance } = require('../../utils/settings')

// 收费类型 -> 标签颜色（与首页风格一致）
const FEE_CLASS_MAP = {
  '免费野钓': 'tag-green',
  '黑坑': 'tag-orange',
  '休闲收费塘': 'tag-blue',
  '禁钓': 'tag-red'
}

// ---- 编辑表单可选项（与新增钓点页保持一致，复用项目基础字典）----
const FISH_TIME_ARR = ['清晨', '上午', '中午', '下午', '傍晚', '夜间', '全天']
const WATER_LEVEL_ARR = ['平水', '涨水', '落水']
const WIND_WAVE_ARR = ['无风浪', '微风浪', '中风浪', '大风浪']
const STATUS_ARR = ['正常', '作废']
// 兜底默认选项（个人字典无数据时使用，与 addPoint 页一致）
const DEFAULT_WATER = ['江河', '水库', '河道', '塘', '湖泊', '溪流']
const DEFAULT_FISH = ['鲫鱼', '鲤鱼', '草鱼', '青鱼', '鲢鳙', '黑鱼', '翘嘴', '马口', '罗非', '鲶鱼', '黄颡鱼', '白条', '鳜鱼', '其他']

// 保存失败时的友好提示：云函数业务错误（带 code）透出服务端文案；
// 网络层异常（无 code）统一提示网络问题，绝不向用户抛出原始报错
function friendlyError(err) {
  if (!err) return '操作失败，请稍后重试'
  if (err.code) return err.message || '操作失败，请稍后重试'
  return '网络异常，请检查网络后重试'
}

Page({
  data: {
    info: null,
    current: 0,
    distance: '',                // 距离我的位置
    weather: null,               // 钓点点位实况天气
    weatherAddr: '',             // 逆地址解析出的钓点具体地址
    weatherStatus: 'loading',    // loading=加载中 ok=正常 error=接口异常 nopos=无坐标
    weatherError: '',            // 接口异常时的具体原因（便于排查）
    // ---- 编辑状态 ----
    isEdit: false,               // 是否处于编辑模式
    saving: false,               // 保存中标记（防重复提交）
    feeTypeArr: ['免费野钓', '黑坑', '休闲收费塘', '禁钓'],
    feeTypeIdx: 0,
    waterTypeArr: [],            // 河道/水域类型字典 [{label,value}]
    waterTypeIdx: -1,
    fishArr: [],                 // 鱼种字典
    fishOptions: [],             // 带选中态的面板选项 [{label,value,checked}]
    fishSelected: [],            // 已选目标鱼种
    fishTimeArr: FISH_TIME_ARR,
    fishTimeIdx: -1,
    waterLevelArr: WATER_LEVEL_ARR,
    waterLevelIdx: -1,
    windWaveArr: WIND_WAVE_ARR,
    windWaveIdx: -1,
    statusArr: STATUS_ARR,
    statusIdx: 0,
    showFishPanel: false,        // 鱼种多选面板是否显示
    panelOptions: [],            // 当前鱼种面板展示的选项
    panelCount: 0,               // 当前面板已选数量
    tempImages: [],              // 编辑中的图片（云端 fileID 或本地临时路径）
    mapMarkers: [],
    showMapPicker: false,        // 自定义地图选点弹层是否显示
    pickerLat: 39.9042,          // 弹层地图中心/当前选中点
    pickerLng: 116.4074,
    searchKeyword: '',           // 地点搜索关键词
    searchResults: [],           // 搜索结果 [{id,title,address,latitude,longitude}]
    form: {
      name: '',
      feeType: '',
      waterType: '',
      fishStr: '',
      depth: '',
      fishTime: '',
      bait: '',
      waterLevel: '',
      windWave: '',
      status: '正常',
      park: '',
      remark: '',
      longitude: '',
      latitude: '',
      images: []
    }
  },
  onLoad(options) {
    this.pointId = options.id;
    this.share = options.share === '1';
    wx.showShareMenu({ withShareTicket: false });
    this.getUserLocation();
  },
  // 每次页面显示时刷新（首次进入、从其他页返回都会重新拉取）
  // 编辑模式下不重载，避免覆盖用户未保存的修改
  onShow() {
    if (this.pointId && !this.data.isEdit) this.loadDetail();
  },
  // 通过云函数加载详情（云函数校验私有本人/团队成员，分享模式可临时查看）
  async loadDetail() {
    try {
      const res = await call('dianpointService', { action: 'get', id: this.pointId, share: this.share });
      const p = res.point;
      // 兼容历史数据：status 缺省视为正常
      const invalid = p.status === '作废';
      this.setData({
        info: {
          ...p,
          invalid,
          fishCaught: p.fishCaught || [],
          weatherSnap: p.weather || null,
          weatherSnapEmoji: (p.weather && p.weather.icon) ? weatherEmoji(p.weather.icon) : '🌤',
          tagClass: FEE_CLASS_MAP[p.feeType] || 'tag-green',
          creatorShort: p.creatorName || (p.createOpenid ? p.createOpenid.slice(-6) : '')
        },
        current: 0
      });
      this.calcDistanceToUser();
      // 使用钓点自身经纬度获取实况天气（不获取手机定位）
      this.loadPointWeather(p);
      // 私有钓点可编辑时，预加载我的团队（供「移到团队」使用）
      if (p.canEdit && !p.teamId) this.loadMyTeams();
    } catch (err) {
      console.error("加载钓点失败", err);
      wx.showToast({ title: err.message || "钓点不存在或已删除", icon: "none" });
      if (this._quietLoad) {
        // 保存成功后的静默刷新：失败仅提示，不自动返回（避免刷新抖动）
        this._quietLoad = false;
      } else {
        setTimeout(() => wx.navigateBack(), 800);
      }
    }
  },
  // 使用钓点保存的经纬度获取实况天气（失败仅降级展示，不影响备注/鱼种等查看）
  loadPointWeather(p) {
    if (p.latitude && p.longitude) {
      this.fetchWeather(p.latitude, p.longitude);
    } else {
      this.setData({ weatherStatus: 'nopos' });
    }
  },
  // 调用 getWeather 云函数拉取实况天气
  fetchWeather(lat, lng) {
    if (!lat || !lng) return;
    // 逆地址解析钓点坐标 -> 具体地址（仅展示用，失败静默降级到和风反查的区县名）
    reverseGeocode(lat, lng).then(addr => {
      if (addr) this.setData({ weatherAddr: addr })
    }).catch(() => { });
    call('getWeather', { lat, lon: lng, type: 'now' })
      .then(res => {
        if (!res.weather) throw new Error('无天气数据');
        this.setData({
          weather: Object.assign({}, res.weather, { emoji: weatherEmoji(res.weather.icon) }),
          weatherStatus: 'ok'
        });
      })
      .catch(err => {
        console.error('获取钓点天气失败', err);
        this.setData({
          weatherStatus: 'error',
          weatherError: (err && err.message) || '天气暂时不可用'
        });
      });
  },
  // 手动刷新钓点位天气（仍使用钓点自身坐标）
  onRefreshWeather() {
    const p = this.data.info;
    if (!p) return;
    this.setData({ weatherStatus: 'loading' });
    this.loadPointWeather(p);
  },
  // 加载我的团队列表（移到团队时选择用）
  loadMyTeams() {
    call('teamService', { action: 'getMyTeams' })
      .then(res => { this.myTeams = res.teams || [] })
      .catch(() => { this.myTeams = [] })
  },
  // 把私有钓点移动到团队
  moveToTeam() {
    const p = this.data.info;
    if (!p || p.teamId) return;
    if (!this.myTeams) {
      this.myTeams = [];
      this.loadMyTeams();
    }
    if (!this.myTeams.length) {
      wx.showModal({
        title: '暂无团队',
        content: '请先创建或加入一个团队，再移动钓点',
        confirmText: '去团队',
        success: (r) => { if (r.confirm) wx.switchTab({ url: '/pages/teamList/teamList' }) }
      });
      return;
    }
    wx.showActionSheet({
      itemList: this.myTeams.slice(0, 6).map(t => t.teamName),
      success: (res) => {
        const team = this.myTeams[res.tapIndex];
        if (team) this.confirmMove(team);
      }
    })
  },
  // 二次确认后执行移动
  confirmMove(team) {
    const p = this.data.info;
    wx.showModal({
      title: '移动到团队',
      content: `将「${p.name}」移动到「${team.teamName}」？`,
      confirmText: '移动',
      success: (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '移动中' });
        call('dianpointService', { action: 'moveToTeam', id: this.pointId, teamId: team._id })
          .then(() => {
            wx.hideLoading();
            wx.showToast({ title: '已移动到团队' });
            // 跳回列表页并刷新（首页 onShow 会自动重新拉取）
            setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 1000);
          })
          .catch(err => {
            wx.hideLoading();
            wx.showToast({ title: err.message || '移动失败', icon: 'none' });
          })
      }
    })
  },
  // 获取当前定位（用于展示与我的距离）
  getUserLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: res => {
        this.userLat = res.latitude;
        this.userLng = res.longitude;
        this.calcDistanceToUser();
      },
      fail: () => {
        // 定位失败则不展示距离
      }
    })
  },
  // 计算并展示"距离我的位置"
  calcDistanceToUser() {
    const info = this.data.info;
    if (!info || !info.latitude || this.userLat === undefined) return;
    const R = 6371;
    const rad = d => d * Math.PI / 180;
    const dLat = rad(info.latitude - this.userLat);
    const dLng = rad(info.longitude - this.userLng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(this.userLat)) * Math.cos(rad(info.latitude)) * Math.sin(dLng / 2) ** 2;
    const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    this.setData({ distance: formatDistance(d) });
  },
  // 轮播滑动时同步当前索引
  onSwiperChange(e) {
    this.setData({ current: e.detail.current });
  },
  // 上一张
  prevImg() {
    const len = this.data.info.images.length;
    this.setData({ current: (this.data.current - 1 + len) % len });
  },
  // 下一张
  nextImg() {
    const len = this.data.info.images.length;
    this.setData({ current: (this.data.current + 1) % len });
  },
  previewImg(e) {
    const src = e.target.dataset.src;
    wx.previewImage({
      urls: this.data.info.images,
      current: src
    })
  },
  openNav() {
    const p = this.data.info;
    wx.openLocation({
      latitude: p.latitude,
      longitude: p.longitude,
      name: p.name,
      scale: 14
    })
  },

  // ================= 内联编辑 =================
  // 进入编辑模式：从详情数据快照出表单，切换所有可修改字段为可输入/可选择状态
  startEdit() {
    const p = this.data.info;
    if (!p || !p.canEdit) return;
    // 数据快照：取消编辑时据此恢复原始详情数据
    this._origin = Object.assign({}, p);
    const fishArr = (p.fish || []).slice();
    const form = {
      name: p.name || '',
      feeType: p.feeType || '',
      waterType: p.waterType || '',
      fishStr: fishArr.join(','),
      depth: p.depth || '',
      fishTime: p.fishTime || '',
      bait: p.bait || '',
      waterLevel: p.waterLevel || '',
      windWave: p.windWave || '',
      status: p.status || '正常',
      park: p.park || '',
      remark: p.remark || '',
      longitude: p.longitude || '',
      latitude: p.latitude || '',
      images: p.images || []
    };
    const feeTypeIdx = this.data.feeTypeArr.indexOf(p.feeType);
    const waterTypeIdx = p.waterType ? this.data.waterTypeArr.findIndex(i => i.value === p.waterType) : -1;
    const fishTimeIdx = FISH_TIME_ARR.indexOf(p.fishTime || '');
    const waterLevelIdx = WATER_LEVEL_ARR.indexOf(p.waterLevel || '');
    const windWaveIdx = WIND_WAVE_ARR.indexOf(p.windWave || '');
    const statusIdx = STATUS_ARR.indexOf(p.status || '正常');
    this.setData({
      isEdit: true,
      form,
      feeTypeIdx: feeTypeIdx >= 0 ? feeTypeIdx : 0,
      waterTypeIdx: waterTypeIdx >= 0 ? waterTypeIdx : -1,
      fishTimeIdx: fishTimeIdx >= 0 ? fishTimeIdx : -1,
      waterLevelIdx: waterLevelIdx >= 0 ? waterLevelIdx : -1,
      windWaveIdx: windWaveIdx >= 0 ? windWaveIdx : -1,
      statusIdx: statusIdx >= 0 ? statusIdx : 0,
      fishSelected: fishArr,
      tempImages: (p.images || []).slice(),
      mapMarkers: p.latitude ? [{ id: 0, latitude: p.latitude, longitude: p.longitude, width: 32, height: 32 }] : []
    });
    this.syncFishOptions();
    // 懒加载河道类型/鱼种字典（point_option），加载完成后自动回填选中索引
    this.initOptions();
    wx.setNavigationBarTitle({ title: '编辑钓点' });
    // 回到顶部，便于用户从第一项开始修改
    setTimeout(() => wx.pageScrollTo({ scrollTop: 0, duration: 250 }), 100);
  },
  // 取消编辑：恢复只读详情（info 未被修改，直接退出编辑态即可）
  cancelEdit() {
    if (this.data.saving) return;
    wx.showModal({
      title: '放弃编辑',
      content: '确定放弃本次修改吗？未保存的改动将丢失',
      confirmText: '放弃',
      cancelText: '继续编辑',
      success: (r) => {
        if (r.confirm) this.exitEdit();
      }
    })
  },
  // 退出编辑态：清理编辑相关状态，标题恢复
  exitEdit() {
    this._origin = null;
    this.setData({
      isEdit: false,
      saving: false,
      showFishPanel: false,
      showMapPicker: false
    });
    wx.setNavigationBarTitle({ title: '钓点详情' });
  },
  // 保存修改：必填校验 -> 上传图片 -> 调用云函数更新 -> 成功切回只读并刷新
  async saveEdit() {
    if (this.data.saving) return;
    const f = this.data.form;
    // 必填项校验（与服务端一致，避免无谓请求）
    if (!f.name) return wx.showToast({ title: '请填写钓点名称', icon: 'none' });
    if (!f.feeType) return wx.showToast({ title: '请选择收费类型', icon: 'none' });
    if (!f.longitude || !f.latitude) return wx.showToast({ title: '请选择钓点位置', icon: 'none' });
    // 水深范围校验，防止手误填离谱数字
    if (f.depth) {
      const d = parseFloat(f.depth);
      if (isNaN(d) || d <= 0 || d > 30) {
        return wx.showToast({ title: '水深需在 0.1-30 米之间', icon: 'none' });
      }
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    try {
      const imgIds = await this.uploadImages();
      const fishArr = f.fishStr.split(/[,，]/).filter(s => s.trim());
      // 钓获鱼种/天气快照详情页不展示编辑控件，原样保留不覆盖
      const origin = this._origin || this.data.info || {};
      const payload = {
        name: f.name,
        feeType: f.feeType,
        waterType: f.waterType,
        fish: fishArr,
        fishCaught: origin.fishCaught || [],
        depth: f.depth,
        fishTime: f.fishTime,
        bait: f.bait,
        waterLevel: f.waterLevel,
        windWave: f.windWave,
        park: f.park,
        remark: f.remark,
        longitude: f.longitude,
        latitude: f.latitude,
        images: imgIds,
        status: f.status || '正常'
      };
      await call('dianpointService', {
        action: 'save',
        id: this.pointId,
        mode: origin.teamId ? 'team' : 'private',
        teamId: origin.teamId || '',
        data: payload
      });
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showToast({ title: '保存成功' });
      // 切回只读详情状态并重新拉取最新数据（静默刷新，失败不回退页面）
      this.exitEdit();
      this._quietLoad = true;
      setTimeout(() => this.loadDetail(), 600);
    } catch (err) {
      wx.hideLoading();
      this.setData({ saving: false });
      console.error('保存钓点失败', err);
      wx.showToast({ title: friendlyError(err), icon: 'none' });
    }
  },
  // ---- 表单输入 ----
  onInput(e) {
    const key = e.target.dataset.key;
    const form = this.data.form;
    form[key] = e.detail.value;
    this.setData({ form });
  },
  // 收费类型标签选择
  onTagTap(e) {
    const idx = e.currentTarget.dataset.index;
    const val = this.data.feeTypeArr[idx];
    if (!val) return;
    const form = this.data.form;
    form.feeType = val;
    this.setData({ form, feeTypeIdx: idx });
  },
  // 河道/水域类型下拉（picker 显示 label，存储 value）
  onWaterTypePicker(e) {
    const idx = e.detail.value;
    const item = this.data.waterTypeArr[idx];
    if (!item) return;
    const form = this.data.form;
    form.waterType = item.value;
    this.setData({ form, waterTypeIdx: idx });
  },
  // 作钓时间选择
  onFishTimePicker(e) {
    const idx = e.detail.value;
    const val = this.data.fishTimeArr[idx];
    if (!val) return;
    const form = this.data.form;
    form.fishTime = val;
    this.setData({ form, fishTimeIdx: idx });
  },
  // 水位选择
  onWaterLevelPicker(e) {
    const idx = e.detail.value;
    const val = this.data.waterLevelArr[idx];
    if (!val) return;
    const form = this.data.form;
    form.waterLevel = val;
    this.setData({ form, waterLevelIdx: idx });
  },
  // 风浪选择
  onWindWavePicker(e) {
    const idx = e.detail.value;
    const val = this.data.windWaveArr[idx];
    if (!val) return;
    const form = this.data.form;
    form.windWave = val;
    this.setData({ form, windWaveIdx: idx });
  },
  // 钓点状态选择（正常/作废）
  onStatusTap(e) {
    const idx = e.currentTarget.dataset.index;
    const val = this.data.statusArr[idx];
    if (!val) return;
    const form = this.data.form;
    form.status = val;
    this.setData({ form, statusIdx: idx });
  },
  // ---- 鱼种多选面板 ----
  openFishPanel() {
    this.setData({ showFishPanel: true, panelOptions: this.data.fishOptions, panelCount: this.data.fishSelected.length });
  },
  closeFishPanel() {
    this.setData({ showFishPanel: false });
  },
  // 根据已选数组生成面板选项（label 展示、value 存储）
  buildFishOptions(selected) {
    return this.data.fishArr.map(item => ({
      label: item.label,
      value: item.value,
      checked: selected.indexOf(item.value) > -1
    }));
  },
  // 刷新鱼种面板的选中态
  syncFishOptions() {
    const fishOptions = this.buildFishOptions(this.data.fishSelected);
    this.setData({ fishOptions, panelOptions: fishOptions, panelCount: this.data.fishSelected.length });
  },
  onFishToggle(e) {
    const val = e.currentTarget.dataset.value;
    const selected = this.data.fishSelected.slice();
    const pos = selected.indexOf(val);
    if (pos >= 0) selected.splice(pos, 1);
    else selected.push(val);
    const fishOptions = this.buildFishOptions(selected);
    this.setData({ fishSelected: selected, fishOptions, panelOptions: fishOptions, panelCount: selected.length });
  },
  confirmFish() {
    const form = this.data.form;
    form.fishStr = this.data.fishSelected.join(',');
    this.setData({ form, showFishPanel: false });
  },
  removeFish(e) {
    const idx = e.currentTarget.dataset.index;
    const selected = this.data.fishSelected.slice();
    selected.splice(idx, 1);
    const form = this.data.form;
    form.fishStr = selected.join(',');
    const fishOptions = this.buildFishOptions(selected);
    this.setData({ fishSelected: selected, fishOptions, panelOptions: fishOptions, form });
  },
  // 从数据库加载「自己名下」的下拉选项（point_option 集合，dictType 区分 river_type/fish_type）
  // 前端只读：point_option 权限为「所有用户可读」；进入编辑时懒加载
  async initOptions() {
    try {
      const openid = await getOpenId();
      const db = wx.cloud.database();
      const res = await db.collection('point_option').where({ _openid: openid }).orderBy('sort', 'asc').limit(100).get();
      this.applyOptions(res.data);
    } catch (err) {
      console.error('读取下拉选项失败', err);
      this.applyOptions([]);
    }
  },
  applyOptions(list) {
    const waterTypeArr = [], fishArr = [];
    list.forEach(i => {
      // 兼容新旧数据：新结构 dictType；旧结构 category(waterType/fish)
      const type = i.dictType || (i.category === 'waterType' ? 'river_type' : i.category === 'fish' ? 'fish_type' : '');
      const label = i.label || i.value || '';
      const value = i.value || label;
      if (!label) return;
      if (type === 'river_type') waterTypeArr.push({ label, value });
      else if (type === 'fish_type') fishArr.push({ label, value });
    });
    // 名下无个人数据时使用默认兜底
    const water = waterTypeArr.length ? waterTypeArr : DEFAULT_WATER.map(v => ({ label: v, value: v }));
    const fish = fishArr.length ? fishArr : DEFAULT_FISH.map(v => ({ label: v, value: v }));
    // 基于最终 fish 列表构建面板选项（不能依赖 this.data.fishArr，setData 尚未生效）
    const fishOptions = fish.map(item => ({
      label: item.label,
      value: item.value,
      checked: this.data.fishSelected.indexOf(item.value) > -1
    }));
    // 字典加载完成后，回填当前表单河道类型的选中索引（编辑模式下保证 picker 定位正确）
    const wtIdx = this.data.form.waterType
      ? water.findIndex(i => i.value === this.data.form.waterType)
      : -1;
    this.setData({
      waterTypeArr: water,
      fishArr: fish,
      fishOptions,
      waterTypeIdx: wtIdx >= 0 ? wtIdx : -1
    });
  },
  // ---- 地图选点（编辑坐标，复用新增页交互：搜索 + 点击地图取点）----
  selectMapPoint() {
    const { form } = this.data;
    this.setData({
      showMapPicker: true,
      pickerLat: form.latitude || 39.9042,
      pickerLng: form.longitude || 116.4074,
      mapMarkers: form.latitude ? [{ id: 0, latitude: form.latitude, longitude: form.longitude, width: 32, height: 32 }] : []
    });
  },
  // 点击地图任意位置 -> 实时取该点经纬度（同时收起搜索结果）
  onMapTap(e) {
    const { latitude, longitude } = e.detail;
    this.setData({
      pickerLat: latitude,
      pickerLng: longitude,
      mapMarkers: [{ id: 0, latitude, longitude, width: 32, height: 32 }],
      searchResults: []
    });
  },
  // 搜索地点：腾讯位置服务关键词搜索（以当前地图中心为原点）
  searchPlaces() {
    const keyword = (this.data.searchKeyword || '').trim();
    if (!keyword) return wx.showToast({ title: '请输入搜索关键词', icon: 'none' });
    if (!QQ_MAP_KEY) return wx.showToast({ title: '未配置腾讯地图Key', icon: 'none' });
    const { pickerLat, pickerLng } = this.data;
    wx.request({
      url: 'https://apis.map.qq.com/ws/place/v1/search',
      data: {
        keyword,
        boundary: `nearby(${pickerLat},${pickerLng},3000)`,
        page_size: 20,
        key: QQ_MAP_KEY
      },
      success: res => {
        const d = res.data || {};
        if (d.status === 0 && d.data) {
          this.setData({
            searchResults: d.data.map((p, i) => ({
              id: p.id || i,
              title: p.title,
              address: p.address || '',
              latitude: p.location.lat,
              longitude: p.location.lng
            }))
          });
        } else {
          this.setData({ searchResults: [] });
          const msg = d.message ? `${d.message}(${d.status})` : '未找到相关地点';
          console.error('地点搜索失败', d);
          wx.showToast({ title: msg, icon: 'none' });
        }
      },
      fail: () => {
        wx.showToast({ title: '搜索失败，请检查网络', icon: 'none' });
      }
    });
  },
  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value });
  },
  // 点击搜索结果 -> 地图定位到该地点并落标
  onResultTap(e) {
    const item = this.data.searchResults[e.currentTarget.dataset.index];
    if (!item) return;
    this.setData({
      pickerLat: item.latitude,
      pickerLng: item.longitude,
      mapMarkers: [{ id: 0, latitude: item.latitude, longitude: item.longitude, width: 32, height: 32 }],
      searchResults: [],
      searchKeyword: item.title
    });
  },
  // 确定选点：回填坐标（编辑不覆盖原天气快照）
  confirmMapPick() {
    const form = this.data.form;
    form.longitude = this.data.pickerLng;
    form.latitude = this.data.pickerLat;
    this.setData({ form, showMapPicker: false });
  },
  // 关闭选点弹层
  closeMapPicker() {
    this.setData({ showMapPicker: false });
  },
  // ---- 实拍图片编辑 ----
  chooseEditImg() {
    wx.chooseMedia({
      count: 6 - this.data.tempImages.length,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: res => {
        const paths = res.tempFiles.map(i => i.tempFilePath);
        this.setData({ tempImages: [...this.data.tempImages, ...paths] });
      }
    })
  },
  removeEditImg(e) {
    const idx = e.currentTarget.dataset.index;
    const tempImages = this.data.tempImages.slice();
    tempImages.splice(idx, 1);
    this.setData({ tempImages });
  },
  previewEditImg(e) {
    const url = e.currentTarget.dataset.url;
    wx.previewImage({ current: url, urls: this.data.tempImages });
  },
  // 上传图片到云存储（已上传过的 cloud:// 图片直接复用）
  async uploadImages() {
    const temp = this.data.tempImages;
    const uploadUrls = [];
    for (const path of temp) {
      if (path.indexOf('cloud://') === 0) {
        uploadUrls.push(path);
        continue;
      }
      const suffix = path.split('.').pop();
      const cloudPath = `fishing_img/${Date.now()}_${Math.random()}.${suffix}`;
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: path });
      uploadUrls.push(up.fileID);
    }
    return uploadUrls;
  },
  // 钓点分享：单条钓点临时分享（好友通过 share=1 可临时查看，不可编辑）
  onShareAppMessage() {
    const p = this.data.info;
    return {
      title: `钓点分享：${p ? p.name : '一个不错的钓点'}`,
      path: `/pages/detail/detail?id=${this.pointId}&share=1`
    }
  }
})
