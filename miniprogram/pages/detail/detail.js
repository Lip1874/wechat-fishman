const { call } = require('../../utils/api')

// 收费类型 -> 标签颜色（与首页风格一致）
const FEE_CLASS_MAP = {
  '免费野钓': 'tag-green',
  '黑坑': 'tag-orange',
  '休闲收费塘': 'tag-blue',
  '禁钓': 'tag-red'
}

Page({
  data:{
    info:null,
    current:0,
    distance:''      // 距离我的位置
  },
  onLoad(options){
    this.pointId = options.id;
    this.share = options.share === '1';
    wx.showShareMenu({withShareTicket:false});
    this.getUserLocation();
  },
  //每次页面显示时刷新（首次进入、从编辑页返回都会重新拉取）
  onShow(){
    if(this.pointId) this.loadDetail();
  },
  //通过云函数加载详情（云函数校验私有本人/团队成员，分享模式可临时查看）
  async loadDetail(){
    try{
      const res = await call('dianpointService',{action:'get',id:this.pointId,share:this.share});
      const p = res.point;
      this.setData({
        info:{
          ...p,
          tagClass: FEE_CLASS_MAP[p.feeType] || 'tag-green',
          creatorShort: p.createOpenid ? p.createOpenid.slice(-6) : ''
        },
        current:0
      });
      this.calcDistanceToUser();
      // 私有钓点可编辑时，预加载我的团队（供「移到团队」使用）
      if (p.canEdit && !p.teamId) this.loadMyTeams();
    }catch(err){
      console.error("加载钓点失败",err);
      wx.showToast({title:err.message || "钓点不存在或已删除",icon:"none"});
      setTimeout(()=>wx.navigateBack(),800);
    }
  },
  //加载我的团队列表（移到团队时选择用）
  loadMyTeams(){
    call('teamService',{action:'getMyTeams'})
      .then(res=>{ this.myTeams = res.teams || [] })
      .catch(()=>{ this.myTeams = [] })
  },
  //把私有钓点移动到团队
  moveToTeam(){
    const p = this.data.info;
    if(!p || p.teamId) return;
    if(!this.myTeams){
      this.myTeams = [];
      this.loadMyTeams();
    }
    if(!this.myTeams.length){
      wx.showModal({
        title:'暂无团队',
        content:'请先创建或加入一个团队，再移动钓点',
        confirmText:'去团队',
        success:(r)=>{ if(r.confirm) wx.navigateTo({url:'/pages/teamList/teamList'}) }
      });
      return;
    }
    wx.showActionSheet({
      itemList: this.myTeams.slice(0,6).map(t=>t.teamName),
      success:(res)=>{
        const team = this.myTeams[res.tapIndex];
        if(team) this.confirmMove(team);
      }
    })
  },
  //二次确认后执行移动
  confirmMove(team){
    const p = this.data.info;
    wx.showModal({
      title:'移动到团队',
      content:`将「${p.name}」移动到「${team.teamName}」？`,
      confirmText:'移动',
      success:(r)=>{
        if(!r.confirm) return;
        wx.showLoading({title:'移动中'});
        call('dianpointService',{action:'moveToTeam',id:this.pointId,teamId:team._id})
          .then(()=>{
            wx.hideLoading();
            wx.showToast({title:'已移动到团队'});
            // 跳回列表页并刷新（首页 onShow 会自动重新拉取）
            setTimeout(()=>wx.reLaunch({url:'/pages/index/index'}),1000);
          })
          .catch(err=>{
            wx.hideLoading();
            wx.showToast({title:err.message||'移动失败',icon:'none'});
          })
      }
    })
  },
  //获取当前定位（用于展示与我的距离）
  getUserLocation(){
    wx.getLocation({
      type:'gcj02',
      success:res=>{
        this.userLat = res.latitude;
        this.userLng = res.longitude;
        this.calcDistanceToUser();
      },
      fail:()=>{
        // 定位失败则不展示距离
      }
    })
  },
  //计算并展示"距离我的位置"
  calcDistanceToUser(){
    const info = this.data.info;
    if(!info || !info.latitude || this.userLat === undefined) return;
    const R = 6371;
    const rad = d => d * Math.PI / 180;
    const dLat = rad(info.latitude - this.userLat);
    const dLng = rad(info.longitude - this.userLng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(this.userLat)) * Math.cos(rad(info.latitude)) * Math.sin(dLng / 2) ** 2;
    const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = d < 1 ? (d * 1000).toFixed(0) + 'm' : d.toFixed(2) + 'km';
    this.setData({distance});
  },
  //轮播滑动时同步当前索引
  onSwiperChange(e){
    this.setData({current:e.detail.current});
  },
  //上一张
  prevImg(){
    const len = this.data.info.images.length;
    this.setData({current:(this.data.current - 1 + len) % len});
  },
  //下一张
  nextImg(){
    const len = this.data.info.images.length;
    this.setData({current:(this.data.current + 1) % len});
  },
  previewImg(e){
    const src = e.target.dataset.src;
    wx.previewImage({
      urls:this.data.info.images,
      current:src
    })
  },
  openNav(){
    const p = this.data.info;
    wx.openLocation({
      latitude:p.latitude,
      longitude:p.longitude,
      name:p.name,
      scale:14
    })
  },
  //进入编辑页（团队钓点带团队参数，私有不带）
  editPoint(){
    const p = this.data.info;
    if(p.teamId){
      wx.navigateTo({
        url:`/pages/addPoint/addPoint?id=${p._id}&mode=team&teamId=${p.teamId}`
      })
    }else{
      wx.navigateTo({
        url:`/pages/addPoint/addPoint?id=${p._id}&mode=private`
      })
    }
  },
  //钓点分享：单条钓点临时分享（好友通过 share=1 可临时查看，不可编辑）
  onShareAppMessage(){
    const p = this.data.info;
    return {
      title: `钓点分享：${p ? p.name : '一个不错的钓点'}`,
      path: `/pages/detail/detail?id=${this.pointId}&share=1`
    }
  }
})
