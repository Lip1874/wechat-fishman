const db = wx.cloud.database();

// 兜底默认选项（数据库无数据时写入/使用）
const DEFAULT_WATER = ['江河','水库','河道','塘','湖泊','溪流'];
const DEFAULT_FISH = ['鲫鱼','鲤鱼','草鱼','青鱼','鲢鳙','黑鱼','翘嘴','马口','罗非','鲶鱼','黄颡鱼','白条','鳜鱼','其他'];

const { call, getOpenId, ensureLogin } = require('../../utils/api');
const { weatherEmoji } = require('../../utils/weather');
const { QQ_MAP_KEY } = require('../../utils/geo');
const { saveDraft, getDraft, clearDraft } = require('../../utils/draft');

// 本次需求新增字段的可选项
const FISH_TIME_ARR = ['清晨', '上午', '中午', '下午', '傍晚', '夜间', '全天'];
const WATER_LEVEL_ARR = ['平水', '涨水', '落水'];
const WIND_WAVE_ARR = ['无风浪', '微风浪', '中风浪', '大风浪'];

Page({
  data:{
    feeTypeArr:["免费野钓","黑坑","休闲收费塘","禁钓"],
    feeTypeIdx:0,
    mode:'private',     // private=私有 / team=团队
    teamId:"",
    teamName:"",        // 团队名称（团队模式下展示）
    waterTypeArr:[],
    waterTypeIdx:-1,
    fishArr:[],
    fishOptions:[],   //带选中态的面板选项 [{value,checked}]
    fishSelected:[],
    // ---- 本次新增：作钓时间 / 饵料 / 水位 / 风浪 ----
    fishTimeArr: FISH_TIME_ARR,
    fishTimeIdx:-1,
    waterLevelArr: WATER_LEVEL_ARR,
    waterLevelIdx:-1,
    windWaveArr: WIND_WAVE_ARR,
    windWaveIdx:-1,
    panelOptions:[],          // 当前鱼种面板展示的选项
    panelCount:0,             // 当前面板已选数量
    pointWeather:null,        // 当前选点天气快照（新增时自动记录到钓点）
    weatherFetching:false,    // 天气拉取中标记
    showFishPanel:false,
    tempImages:[],
    mapMarkers:[],
    showMapPicker:false,  // 自定义地图选点弹层是否显示
    pickerLat:39.9042,    // 弹层地图中心/当前选中点
    pickerLng:116.4074,
    searchKeyword:'',     // 地点搜索关键词
    searchResults:[],     // 搜索结果 [{id,title,address,latitude,longitude}]
    form:{
      name:"",
      feeType:"",
      waterType:"",
      fishStr:"",
      depth:"",
      fishTime:"",
      bait:"",
      waterLevel:"",
      windWave:"",
      status:"正常",
      park:"",
      remark:"",
      longitude:"",
      latitude:"",
      images:[]
    }
  },
  async onLoad(options){
    await this.initOptions();
    // 模式与团队参数
    if(options.mode) this.setData({mode:options.mode});
    if(options.teamId) this.setData({teamId:options.teamId});

    // 新增场景：默认高亮的第一项收费类型同步到表单，避免提交时提示未选择
    let form = this.data.form;
    form.feeType = this.data.feeTypeArr[this.data.feeTypeIdx] || '';
    this.setData({form});
    if(this.data.mode === 'team'){
      wx.setNavigationBarTitle({title:"新增团队钓点"});
      this.loadTeamName();
    }else{
      wx.setNavigationBarTitle({title:"新增钓点"});
    }
    // 恢复本地未保存草稿
    this.restoreDraft();
  },
  // ===== 离线草稿：离开自动保存 / 进入自动恢复 / 提交成功清除 =====
  // 判断当前表单是否有可保存内容（无内容不落草稿，避免产生空草稿）
  buildDraft(){
    const { form, tempImages, fishSelected, feeTypeIdx, waterTypeIdx, fishTimeIdx, waterLevelIdx, windWaveIdx, mode, teamId } = this.data;
    const f = form;
    const hasContent = !!(f.name || f.fishStr || f.depth || f.bait || f.park || f.remark ||
      f.waterType || f.fishTime || f.waterLevel || f.windWave || f.longitude ||
      (tempImages && tempImages.length));
    if(!hasContent) return null;
    return { form, tempImages, fishSelected, feeTypeIdx, waterTypeIdx, fishTimeIdx, waterLevelIdx, windWaveIdx, mode, teamId };
  },
  saveDraftNow(){
    // 已提交成功：不落草稿并清理历史草稿
    if(this._submitted){ clearDraft('addPoint'); return; }
    const draft = this.buildDraft();
    if(draft) saveDraft('addPoint', draft);
    else clearDraft('addPoint');
  },
  restoreDraft(){
    const draft = getDraft('addPoint');
    if(!draft) return;
    // 草稿模式与当前入口不一致时不恢复（如私有钓点草稿不误填到团队钓点）
    if(draft.mode && draft.mode !== this.data.mode) return;
    const form = Object.assign({}, this.data.form, draft.form || {});
    const tempImages = Array.isArray(draft.tempImages) ? draft.tempImages : [];
    const fishSelected = Array.isArray(draft.fishSelected) ? draft.fishSelected : [];
    this.setData({
      form,
      tempImages,
      fishSelected,
      feeTypeIdx: typeof draft.feeTypeIdx === 'number' ? draft.feeTypeIdx : 0,
      waterTypeIdx: typeof draft.waterTypeIdx === 'number' ? draft.waterTypeIdx : -1,
      fishTimeIdx: typeof draft.fishTimeIdx === 'number' ? draft.fishTimeIdx : -1,
      waterLevelIdx: typeof draft.waterLevelIdx === 'number' ? draft.waterLevelIdx : -1,
      windWaveIdx: typeof draft.windWaveIdx === 'number' ? draft.windWaveIdx : -1
    });
    this.syncFishOptions();
  },
  // 离开页面（返回/切换）时自动保存草稿
  onUnload(){
    this.saveDraftNow();
  },
  //团队模式下拉取团队名用于展示
  loadTeamName(){
    if(!this.data.teamId) return;
    call('teamService',{action:'getTeamDetail',teamId:this.data.teamId})
      .then(res=>{
        this.setData({teamName:res.team.teamName});
      })
      .catch(()=>{});
  },
  onInput(e){
    const key = e.target.dataset.key;
    let form = this.data.form;
    form[key] = e.detail.value;
    this.setData({form});
  },
  onTagTap(e){
    const idx = e.currentTarget.dataset.index;
    const val = this.data.feeTypeArr[idx];
    let form = this.data.form;
    form.feeType = val;
    this.setData({form,feeTypeIdx:idx});
  },
  //水域类型下拉（picker 显示 label，存储 value）
  onWaterTypePicker(e){
    const idx = e.detail.value;
    const item = this.data.waterTypeArr[idx];
    if(!item) return;
    let form = this.data.form;
    form.waterType = item.value;
    this.setData({form,waterTypeIdx:idx});
  },
  //鱼种选择面板
  openFishPanel(){
    this.setData({showFishPanel:true, panelOptions:this.data.fishOptions, panelCount:this.data.fishSelected.length});
  },
  closeFishPanel(){
    this.setData({showFishPanel:false});
  },
  //根据已选数组生成面板选项（label 展示、value 存储）
  buildFishOptions(selected){
    return this.data.fishArr.map(item => ({
      label: item.label,
      value: item.value,
      checked: selected.indexOf(item.value) > -1
    }));
  },
  //刷新鱼种面板的选中态
  syncFishOptions(){
    const fishOptions = this.buildFishOptions(this.data.fishSelected);
    this.setData({fishOptions, panelOptions: fishOptions, panelCount: this.data.fishSelected.length});
  },
  onFishToggle(e){
    const val = e.currentTarget.dataset.value;
    const selected = this.data.fishSelected.slice();
    const pos = selected.indexOf(val);
    if(pos>=0) selected.splice(pos,1);
    else selected.push(val);
    const fishOptions = this.buildFishOptions(selected);
    this.setData({fishSelected:selected, fishOptions, panelOptions:fishOptions, panelCount:selected.length});
  },
  confirmFish(){
    let form = this.data.form;
    form.fishStr = this.data.fishSelected.join(',');
    this.setData({form, showFishPanel:false});
  },
  removeFish(e){
    const idx = e.currentTarget.dataset.index;
    const selected = this.data.fishSelected.slice();
    selected.splice(idx,1);
    let form = this.data.form;
    form.fishStr = selected.join(',');
    const fishOptions = this.buildFishOptions(selected);
    this.setData({fishSelected:selected, fishOptions, panelOptions:fishOptions, form});
  },
  //作钓时间选择（picker 存储字符串）
  onFishTimePicker(e){
    const idx = e.detail.value;
    const val = this.data.fishTimeArr[idx];
    if(!val) return;
    let form = this.data.form;
    form.fishTime = val;
    this.setData({form, fishTimeIdx:idx});
  },
  //水位选择
  onWaterLevelPicker(e){
    const idx = e.detail.value;
    const val = this.data.waterLevelArr[idx];
    if(!val) return;
    let form = this.data.form;
    form.waterLevel = val;
    this.setData({form, waterLevelIdx:idx});
  },
  //风浪选择
  onWindWavePicker(e){
    const idx = e.detail.value;
    const val = this.data.windWaveArr[idx];
    if(!val) return;
    let form = this.data.form;
    form.windWave = val;
    this.setData({form, windWaveIdx:idx});
  },
  //从数据库加载「自己名下」的下拉选项（point_option 集合，dictType 区分 river_type/fish_type；兼容旧 category 字段）
  //前端只读：point_option 权限为「所有用户可读」，写操作全部走 dictOperate 云函数（写入时归属本人，不与他人共享）
  async initOptions(){
    try{
      const openid = await getOpenId();
      const res = await db.collection('point_option').where({_openid:openid}).orderBy('sort','asc').limit(100).get();
      this.applyOptions(res.data);
    }catch(err){
      console.error('读取下拉选项失败', err);
      this.applyOptions([]);
    }
  },
  applyOptions(list){
    const waterTypeArr = [], fishArr = [];
    list.forEach(i=>{
      // 兼容新旧数据：新结构 dictType；旧结构 category(waterType/fish)
      const type = i.dictType || (i.category==='waterType' ? 'river_type' : i.category==='fish' ? 'fish_type' : '');
      const label = i.label || i.value || '';
      const value = i.value || label;
      if(!label) return;
      if(type==='river_type') waterTypeArr.push({label, value});
      else if(type==='fish_type') fishArr.push({label, value});
    });
    // 名下无个人数据时使用默认兜底（在「我的-基础数据」首次打开会自动生成个人标准选项）
    const water = waterTypeArr.length ? waterTypeArr : DEFAULT_WATER.map(v=>({label:v,value:v}));
    const fish = fishArr.length ? fishArr : DEFAULT_FISH.map(v=>({label:v,value:v}));
    // 基于最终 fish 列表构建面板选项：不能依赖 this.data.fishArr（setData 尚未生效，仍为旧空数组）
    const fishOptions = fish.map(item=>({
      label: item.label,
      value: item.value,
      checked: this.data.fishSelected.indexOf(item.value) > -1
    }));
    this.setData({
      waterTypeArr: water,
      fishArr: fish,
      fishOptions
    });
  },
  //当前时间格式化（天气快照记录时间用）
  formatNow(){
    const d = new Date();
    const p = n => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  //自动拉取当前选点实况天气（新增时保存进钓点；失败静默降级，不阻塞保存）
  fetchPointWeather(lat, lng){
    if(!lat || !lng) return Promise.resolve();
    this.setData({weatherFetching:true});
    return call('getWeather',{lat, lon:lng, type:'now'})
      .then(res=>{
        const w = res.weather;
        if(!w) throw new Error('无天气数据');
        this.setData({
          pointWeather:{
            place: w.place || '',
            icon: w.icon || '',
            emoji: weatherEmoji(w.icon),
            text: w.text || '',
            temp: w.temp || '',
            feelsLike: w.feelsLike || '',
            windDir: w.windDir || '',
            windScale: w.windScale || '',
            humidity: w.humidity || '',
            pressure: w.pressure || '',
            fishing: w.fishing ? {category:w.fishing.category, text:w.fishing.text} : null,
            updateTime: this.formatNow()
          },
          weatherFetching:false
        });
      })
      .catch(err=>{
        console.error('获取选点天气失败', err);
        this.setData({pointWeather:null, weatherFetching:false});
      });
  },
  //地图选点：打开自定义全屏地图，点击地图任意位置取经纬度
  selectMapPoint(){
    const { form } = this.data;
    this.setData({
      showMapPicker: true,
      pickerLat: form.latitude || 39.9042,
      pickerLng: form.longitude || 116.4074,
      mapMarkers: form.latitude ? [{id:0, latitude: form.latitude, longitude: form.longitude, width:32, height:32}] : []
    });
  },
  //点击地图任意位置 -> 实时取该点经纬度（同时收起搜索结果）
  onMapTap(e){
    const { latitude, longitude } = e.detail;
    this.setData({
      pickerLat: latitude,
      pickerLng: longitude,
      mapMarkers: [{id:0, latitude, longitude, width:32, height:32}],
      searchResults: []
    });
  },
  //搜索地点：腾讯位置服务关键词搜索（以当前地图中心为原点）
  searchPlaces(){
    const keyword = (this.data.searchKeyword || '').trim();
    if(!keyword) return wx.showToast({title:'请输入搜索关键词',icon:'none'});
    if(!QQ_MAP_KEY) return wx.showToast({title:'未配置腾讯地图Key',icon:'none'});
    const { pickerLat, pickerLng } = this.data;
    wx.request({
      url:'https://apis.map.qq.com/ws/place/v1/search',
      data:{
        keyword,
        boundary:`nearby(${pickerLat},${pickerLng},3000)`,
        page_size:20,
        key:QQ_MAP_KEY
      },
      success:res=>{
        const d = res.data || {};
        if(d.status === 0 && d.data){
          this.setData({
            searchResults: d.data.map((p,i)=>({
              id:p.id || i,
              title:p.title,
              address:p.address || '',
              latitude:p.location.lat,
              longitude:p.location.lng
            }))
          });
        }else{
          this.setData({ searchResults: [] });
          // 透出接口真实错误，便于定位（Key类型/配额/白名单等）
          const msg = d.message ? `${d.message}(${d.status})` : '未找到相关地点';
          console.error('地点搜索失败', d);
          wx.showToast({title:msg, icon:'none'});
        }
      },
      fail:()=>{
        wx.showToast({title:'搜索失败，请检查网络',icon:'none'});
      }
    });
  },
  onSearchInput(e){
    this.setData({ searchKeyword: e.detail.value });
  },
  //点击搜索结果 -> 地图定位到该地点并落标
  onResultTap(e){
    const item = this.data.searchResults[e.currentTarget.dataset.index];
    if(!item) return;
    this.setData({
      pickerLat: item.latitude,
      pickerLng: item.longitude,
      mapMarkers: [{id:0, latitude:item.latitude, longitude:item.longitude, width:32, height:32}],
      searchResults: [],
      searchKeyword: item.title
    });
  },
  //确定选点：回填表单，并自动拉取该点天气（保存时随钓点记录）
  confirmMapPick(){
    const form = this.data.form;
    form.longitude = this.data.pickerLng;
    form.latitude = this.data.pickerLat;
    this.setData({ form, showMapPicker: false });
    this.fetchPointWeather(form.latitude, form.longitude);
  },
  //关闭选点弹层
  closeMapPicker(){
    this.setData({ showMapPicker: false });
  },
  //选择图片
  chooseImage(){
    wx.chooseMedia({
      count:6 - this.data.tempImages.length,
      mediaType:['image'],
      sourceType:['album','camera'],
      success:res=>{
        const paths = res.tempFiles.map(i=>i.tempFilePath);
        this.setData({tempImages:[...this.data.tempImages,...paths]});
      }
    })
  },
  //删除图片
  removeImage(e){
    const idx = e.currentTarget.dataset.index;
    const tempImages = this.data.tempImages.slice();
    tempImages.splice(idx,1);
    this.setData({tempImages});
  },
  //预览图片
  previewImage(e){
    const url = e.currentTarget.dataset.url;
    wx.previewImage({current:url,urls:this.data.tempImages});
  },
  //上传图片到云存储
  async uploadImages(){
    const temp = this.data.tempImages;
    let uploadUrls = [];
    for(let path of temp){
      // 已上传过的云存储图片直接复用，无需重新上传
      if(path.indexOf("cloud://") === 0){
        uploadUrls.push(path);
        continue;
      }
      const suffix = path.split(".").pop();
      const cloudPath = `fishing_img/${Date.now()}_${Math.random()}.${suffix}`;
      const up = await wx.cloud.uploadFile({cloudPath,filePath:path});
      uploadUrls.push(up.fileID);
    }
    return uploadUrls;
  },
  //提交表单（新增钓点走云函数，云函数校验私有本人/团队成员）
  async submit(){
    // 未登录（未完善资料）不允许创建钓点
    const loggedIn = await ensureLogin();
    if(!loggedIn) return;
    const f = this.data.form;
    if(!f.name) return wx.showToast({title:"填写钓点名称",icon:"none"});
    if(!f.feeType) return wx.showToast({title:"选择收费类型",icon:"none"});
    if(!f.longitude) return wx.showToast({title:"地图选取位置",icon:"none"});
    //水深范围校验，防止手误填离谱数字
    if(f.depth){
      const d = parseFloat(f.depth);
      if(isNaN(d) || d <= 0 || d > 30){
        return wx.showToast({title:"水深需在 0.1-30 米之间",icon:"none"});
      }
    }

    wx.showLoading({title:"提交中"});
    try{
      const imgIds = await this.uploadImages();
      const fishArr = f.fishStr.split(/[,，]/).filter(s=>s.trim());
      // 自动把当前点位天气信息存入钓点记录：
      // 优先用选点后已拉取的快照；若未拉取到（网络失败），保存前兜底再拉一次，仍失败则不携带（不阻塞新增）
      let weather = null;
      if(this.data.pointWeather){
        weather = this.data.pointWeather;
      }else if(f.longitude){
        await this.fetchPointWeather(f.latitude, f.longitude);
        weather = this.data.pointWeather;
      }
      const payload = {
        name:f.name,
        feeType:f.feeType,
        waterType:f.waterType,
        fish:fishArr,
        // 添加页已移除钓获鱼种选择，新增时为空数组
        fishCaught: [],
        depth:f.depth,
        fishTime:f.fishTime,
        bait:f.bait,
        waterLevel:f.waterLevel,
        windWave:f.windWave,
        park:f.park,
        remark:f.remark,
        longitude:f.longitude,
        latitude:f.latitude,
        images:imgIds
      };
      if(weather) payload.weather = weather;
      await call('dianpointService',{
        action:'save',
        id:'',
        mode:this.data.mode,
        teamId:this.data.teamId,
        data:payload
      });
      wx.hideLoading();
      this._submitted = true;
      clearDraft('addPoint');
      wx.showToast({title:"新增成功"});
      setTimeout(()=>wx.navigateBack(),1200);
    }catch(err){
      wx.hideLoading();
      wx.showToast({title:err.message || "提交失败",icon:"none"});
      console.error(err);
    }
  }
})
