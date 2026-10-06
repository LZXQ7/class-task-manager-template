/**
 * 统一响应 envelope 与业务错误（开发文档 8.1 / 17.1）
 */
class BizError extends Error {
  constructor(errCode, errMsg, data) {
    super(errMsg || 'error');
    this.errCode = errCode;
    this.errMsg = errMsg;
    this.data = data === undefined ? null : data;
  }
}

function ok(data) {
  return { errCode: 0, errMsg: 'ok', data: data === undefined ? null : data };
}

function fail(errCode, errMsg, data) {
  return { errCode, errMsg, data: data === undefined ? null : data };
}

module.exports = { BizError, ok, fail };
