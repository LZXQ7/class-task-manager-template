/**
 * 课表适配申请（超管，需求 D-2）
 * ------------------------------------------------------------
 * 成员在「课程表」页点「申请适配」提交 .xlsx 后，这里列出待处理的申请；
 * 超管可「预览并适配」（复用 importTimetable，带申请里的 fileId + classId）→ 确认导入
 * → handleApply 标记 DONE；也可「拒绝」标记 REJECTED，或「查看原文件」预览上传的 .xlsx。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const pageAnim = require('../../utils/page-anim');

Page({
  data: {
    statusBarHeight: 20,
    paReady: false,
    animSeq: 0,
    loading: true,
    isSuper: false,
    list: [],
    empty: false,
    /* 适配预览 */
    importShow: false,
    importPreview: null,
    importBusy: false,
    activeId: 0,
    activeClassId: 0,
    activeFileId: '',
    activeGroup: '',      // 该申请对应的组别（2026-10-05）：A / B / ''=全体课
    activeFileB64: ''     // ⚠️ 2026-10-05：申请文件的 base64（绕开云函数在 VPC 内下载云存储的慢路径）
  },

  onLoad() {
    const app = getApp();
    this.setData({ statusBarHeight: (app && app.globalData && app.globalData.statusBarHeight) || 20 });
    pageAnim.playReady(this, getApp());
  },

  onShow() {
    const app = getApp();
    const isSuper = !!(app && app.isSuper && app.isSuper());
    this.setData({ paReady: true, isSuper });
    if (typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => { if (changed) this._load(); }).catch(() => {});
    }
    this._load();
  },

  _load() {
    if (!this.data.isSuper) { this.setData({ loading: false, empty: true, list: [] }); return; }
    this.setData({ loading: true });
    api.getApplyList({}, { toast: false })
      .then((r) => {
        const list = (r && r.list) || [];
        this.setData({ loading: false, list, empty: list.length === 0 });
      })
      .catch(() => { this.setData({ loading: false, empty: true }); });
  },

  /** 预览并适配：直接用申请里的 fileId + classId + groupScope 跑 importTimetable 预览 */
  onAdapt(e) {
    const id = Number(e.currentTarget.dataset.id);
    const item = (this.data.list || []).find(x => x.id === id);
    if (!item || this.data.importBusy) return;
    // ⚠️ 2026-10-05：组别必须一起带上。A/B 组是两个独立文件，漏传会被当成「全体课」写进去。
    //    `item.groupScope` 为空（老数据没有该列）时**兜底成 'A'**：云端已把 group 改必填。
    const group = item.groupScope === 'B' ? 'B' : 'A';
    // ⚠️ 用 base64 而非 fileId：云函数在 VPC 内回下载云存储极慢（20s 打不完 ⇒ -504005）。
    //    申请时文件已存在 `timetable_apply.file_b64`，这里直接带上，绕开下载。
    const b64 = item.fileB64 || '';
    this.setData({
      importBusy: true, activeId: id, activeClassId: item.classId,
      activeFileId: item.fileId, activeGroup: group, activeFileB64: b64
    });
    wx.showLoading({ title: '解析中', mask: true });
    api.importTimetable({
      fileID: b64 ? '' : item.fileId,   // 有 base64 就不给 fileID（避免云端走慢路径）
      base64: b64,
      classId: item.classId, group, commit: false
    }, { toast: false, loading: '解析中' })
      .then((r) => {
        wx.hideLoading();
        this.setData({ importBusy: false, importShow: true, importPreview: r || null });
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ importBusy: false });
        util.toast((err && err.errMsg) || (err && err.message) || '解析失败，请确认文件是青果导出的 .xlsx');
      });
  },

  onImportClose() {
    this.setData({
      importShow: false, importPreview: null,
      activeId: 0, activeClassId: 0, activeFileId: '', activeGroup: '', activeFileB64: ''
    });
  },

  onConfirmAdapt() {
    const p = this.data.importPreview;
    const id = this.data.activeId;
    const classId = this.data.activeClassId;
    const fileID = this.data.activeFileId;
    const b64 = this.data.activeFileB64;
    const group = this.data.activeGroup;
    if (!p || (!b64 && !fileID) || !id || this.data.importBusy) return;
    this.setData({ importBusy: true });
    // ⚠️ 同预览：优先 base64，避免云端走 VPC 内下载云存储的慢路径（会 20s 超时）
    api.importTimetable({ fileID: b64 ? '' : fileID, base64: b64, classId, group, commit: true }, { loading: '导入中' })
      .then(() => api.handleApply({ id, status: 'DONE' }, { toast: false }))
      .then(() => {
        this.setData({
          importBusy: false, importShow: false, importPreview: null,
          activeId: 0, activeClassId: 0, activeFileId: '', activeGroup: '', activeFileB64: ''
        });
        util.toast('已适配并导入「' + group + ' 组」');
        this._load();
      })
      .catch((err) => {
        this.setData({ importBusy: false });
        util.toast((err && err.errMsg) || (err && err.message) || '适配失败');
      });
  },

  onReject(e) {
    const id = Number(e.currentTarget.dataset.id);
    util.confirm('拒绝后该申请将关闭，成员可重新提交', '拒绝申请').then((ok) => {
      if (!ok) return;
      api.handleApply({ id, status: 'REJECTED' }, { loading: '处理中' })
        .then(() => { util.toast('已拒绝'); this._load(); })
        .catch((err) => util.toast((err && err.errMsg) || '操作失败'));
    });
  },

  onViewFile(e) {
    const id = Number(e.currentTarget.dataset.id);
    wx.showLoading({ title: '获取文件', mask: true });
    api.downloadApply({ id }, { toast: false })
      .then((r) => {
        if (!r || !r.url) { wx.hideLoading(); util.toast('获取文件链接失败'); return; }
        wx.downloadFile({
          url: r.url,
          success: (dl) => {
            wx.hideLoading();
            wx.openDocument({
              filePath: dl.tempFilePath,
              showMenu: true,
              fail: () => util.toast('该文件类型无法预览')
            });
          },
          fail: () => { wx.hideLoading(); util.toast('文件下载失败'); }
        });
      })
      .catch(() => { wx.hideLoading(); util.toast('获取文件链接失败'); });
  },

  noop() {}
});
