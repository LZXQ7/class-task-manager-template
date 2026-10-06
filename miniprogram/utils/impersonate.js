/**
 * 「切换测试账号」模拟态的全局护栏（v1.0.5）
 * ------------------------------------------------------------
 * 超管点「切换测试账号」后，guard.getContext() 会把**所有云函数的生效身份**替换成目标账号，
 * 于是后续操作（发通知、排班、成员增删、操作日志）全部记在**目标账号名下**。
 *
 * 但界面此前只在「我的」页有一枚小标签 —— 一旦离开「我的」页去首页发通知、
 * 去值日页排班、去课表页调课，就完全无感知，误操作会以别人的名义落库。
 *
 * 而可切换目标里恰好有一位是**真人持有**的假号（罗翊瑄·辅导员，已绑微信，
 * 学号 260805749990 特意放在 99 段供超管进入辅导员视角），
 * 所以这个护栏不是锦上添花：不提示就等于「以她的名义静默操作」。
 *
 * 本模块给 4 个 tab 页提供统一的顶部横幅文案与「恢复本人」动作，
 * 保证停在哪一屏都能一眼看到「我现在不是我自己」。
 */
const api = require('./api');
const util = require('./util');

/** 顶部横幅文案；不在模拟态返回空串（页面据此 wx:if 决定是否渲染） */
function bannerText() {
  const app = typeof getApp === 'function' ? getApp() : null;
  const g = (app && app.globalData) || {};
  if (!g.switched) return '';
  const name = (g.profile && g.profile.name) || '测试账号';
  return '模拟中 · 正在以 ' + name + ' 的身份操作';
}

/** 页面 onShow 里调一次：把横幅文案同步进 data */
function sync(page) {
  if (!page || typeof page.setData !== 'function') return;
  const text = bannerText();
  // 只在变化时 setData，避免每次 onShow 都触发一次无意义渲染
  if (page.data && page.data.impersonateBanner === text) return;
  page.setData({ impersonateBanner: text });
}

/**
 * 「恢复本人」：清 impersonation → 刷新登录态 → 回首页重载。
 * 为什么不原地刷新：模拟态切走后**权限与可见范围整体变了**（A/B 组、班级、可管理范围），
 * 各 tab 页的 data 都建立在旧身份上，逐个打补丁容易漏；reLaunch 是唯一保证一致的手段。
 */
function recover() {
  return api.switchAccount({ memberId: 0 }, { loading: '恢复中' })
    .then(() => {
      const app = getApp();
      return app && app.refreshAuth ? app.refreshAuth() : null;
    })
    .then(() => {
      util.toast('已恢复本人');
      wx.reLaunch({ url: '/pages/home/index' });
    })
    .catch(() => {});
}

module.exports = { bannerText, sync, recover };
