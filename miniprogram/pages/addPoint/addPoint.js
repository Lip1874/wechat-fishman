const db = wx.cloud.database();

// 兜底默认选项（数据库无数据时写入/使用）
const DEFAULT_WATER = ['江河','水库','河道','塘','湖泊','溪流'];
const DEFAULT_FISH = ['鲫鱼','鲤鱼','草鱼','青鱼','鲢鳙','黑鱼','翘嘴','马口','罗非','鲶鱼','黄颡鱼','白条','鳜鱼','其他111'];

const { call, getOpenId } = require('../../utils/api');

// 腾讯位置服务 WebService Key（免费申请：https://lbs.qq.com -> 控制台 -> 创建应用 -> 添加Key
// 类型选「微信小程序」，绑定本小程序 AppID：wx94171f60adb395c8）
const QQ_MAP_KEY = '37JBZ-2VFCL-6HQPJ-M3U7A-WAYL3-LRBVQ'; // TODO: 填入你的腾讯地图 Key

Page({
  data:{
    feeTypeArr:["免费野钓","黑坑","休闲收费塘","禁钓"],
    feeTypeIdx:0,
    isEdit:false,
    pointId:"",
    mode:'private',     // private=私有 / team=团队
    teamId:"",
    canEdit:true,       // 是否有编辑/删除权限（云函数校验返回）
    teamName:"",        // 团队名称（团队模式下展示）
    creatorShort:"",    // 录入人（编辑回填时展示）
    waterTypeArr:[],
    waterTypeIdx:-1,
    fishArr:[],
    fishOptions:[],   //带选中态的面板选项 [{value,checked}]
    fishSelected:[],
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

    if(options && options.id){
      this.setData({isEdit:true,pointId:options.id});
      wx.setNavigationBarTitle({title:"编辑钓点"});
      this.loadPoint(options.id);
    }else{
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
    }
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
  //编辑模式：通过云函数回填钓点数据（云函数已校验权限）
  async loadPoint(id){
    try{
      const res = await call('dianpointService',{action:'get',id});
      const p = res.point;
      if(!p.canEdit){
        wx.showToast({title:"无权限编辑该钓点",icon:"none"});
        setTimeout(()=>wx.navigateBack(),800);
        return;
      }
      const waterTypeIdx = p.waterType ? this.data.waterTypeArr.findIndex(i=>i.value===p.waterType) : -1;
      this.setData({
        mode: p.teamId ? 'team' : 'private',
        teamId: p.teamId || '',
        teamName: p.teamName || '',
        canEdit:true,
        creatorShort: p.createOpenid ? p.createOpenid.slice(-6) : '',
        form:{
          name:p.name || "",
          feeType:p.feeType || "",
          waterType:p.waterType || "",
          fishStr:(p.fish || []).join(","),
          depth:p.depth || "",
          park:p.park || "",
          remark:p.remark || "",
          longitude:p.longitude || "",
          latitude:p.latitude || "",
          images:p.images || []
        },
        feeTypeIdx:this.data.feeTypeArr.indexOf(p.feeType) >= 0 ? this.data.feeTypeArr.indexOf(p.feeType) : 0,
        waterTypeIdx:waterTypeIdx >= 0 ? waterTypeIdx : -1,
        fishSelected:p.fish || [],
        tempImages:p.images || [],
        mapMarkers: p.latitude ? [{id:0, latitude:p.latitude, longitude:p.longitude, width:32, height:32}] : []
      });
      this.syncFishOptions();
    }catch(err){
      console.error("加载钓点失败",err);
      wx.showToast({title:err.message || "加载失败",icon:"none"});
    }
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
  //目标鱼种选择面板
  openFishPanel(){
    this.setData({showFishPanel:true});
  },
  closeFishPanel(){
    this.setData({showFishPanel:false});
  },
  onFishToggle(e){
    const val = e.currentTarget.dataset.value;
    const fishSelected = this.data.fishSelected.slice();
    const pos = fishSelected.indexOf(val);
    if(pos>=0) fishSelected.splice(pos,1);
    else fishSelected.push(val);
    this.setData({fishSelected});
    this.syncFishOptions();
  },
  //根据已选鱼种重建面板选中态（label 展示、value 存储）
  syncFishOptions(){
    const selected = this.data.fishSelected;
    const fishOptions = this.data.fishArr.map(item => ({
      label: item.label,
      value: item.value,
      checked: selected.indexOf(item.value) > -1
    }));
    this.setData({fishOptions});
  },
  confirmFish(){
    let form = this.data.form;
    form.fishStr = this.data.fishSelected.join(',');
    this.setData({form,showFishPanel:false});
  },
  removeFish(e){
    const idx = e.currentTarget.dataset.index;
    const fishSelected = this.data.fishSelected.slice();
    fishSelected.splice(idx,1);
    let form = this.data.form;
    form.fishStr = fishSelected.join(',');
    this.setData({fishSelected,form});
    this.syncFishOptions();
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
    this.setData({
      waterTypeArr: water,
      fishArr: fish,
      fishOptions: fish.map(item=>({
        label: item.label,
        value: item.value,
        checked: this.data.fishSelected.indexOf(item.value) > -1
      }))
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
  //确定选点：回填表单
  confirmMapPick(){
    const form = this.data.form;
    form.longitude = this.data.pickerLng;
    form.latitude = this.data.pickerLat;
    this.setData({ form, showMapPicker: false });
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
  //提交表单（新增/编辑全部走云函数，云函数校验私有本人/团队成员）
  async submit(){
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
      await call('dianpointService',{
        action:'save',
        id:this.data.isEdit ? this.data.pointId : '',
        mode:this.data.mode,
        teamId:this.data.teamId,
        data:{
          name:f.name,
          feeType:f.feeType,
          waterType:f.waterType,
          fish:fishArr,
          depth:f.depth,
          park:f.park,
          remark:f.remark,
          longitude:f.longitude,
          latitude:f.latitude,
          images:imgIds
        }
      });
      wx.hideLoading();
      wx.showToast({title:this.data.isEdit?"保存成功":"新增成功"});
      setTimeout(()=>wx.navigateBack(),1200);
    }catch(err){
      wx.hideLoading();
      wx.showToast({title:err.message || "提交失败",icon:"none"});
      console.error(err);
    }
  }
})
