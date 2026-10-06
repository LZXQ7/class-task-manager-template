/**
 * P9 · 用户协议 / 隐私政策（非 Tab 二级页）
 * 入口：我的 → 关于 → 用户协议 / 隐私政策
 * 通过 ?type=agreement|privacy 切换文档；内容来自 data/legal.js。
 */
const legal = require('../../data/legal');

const DOCS = {
  agreement: legal.USER_AGREEMENT,
  privacy: legal.PRIVACY_POLICY
};

/** 把「段落 / 条目」摊平成带稳定 key 的块，避免 wx:key 出现重复值告警 */
function toGroups(sections) {
  return (sections || []).map((s, si) => {
    const blocks = [];
    (s.paras || []).forEach((t, i) => {
      blocks.push({ k: 'p' + si + '_' + i, kind: 'p', text: t });
    });
    (s.items || []).forEach((t, i) => {
      blocks.push({ k: 'l' + si + '_' + i, kind: 'li', text: t });
    });
    return { key: 's' + si, title: s.title, blocks: blocks };
  });
}

Page({
  data: {
    doc: null,
    intro: [],
    groups: []
  },

  onLoad(q) {
    const type = (q && q.type === 'privacy') ? 'privacy' : 'agreement';
    const src = DOCS[type] || DOCS.agreement;
    this.setData({
      doc: {
        type: src.id,
        title: src.title,
        name: src.name,
        version: src.version,
        updated: src.updated
      },
      intro: src.intro || [],
      groups: toGroups(src.sections)
    });
  }
});
