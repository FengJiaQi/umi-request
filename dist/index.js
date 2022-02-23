'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var qs = require('qs');
require('isomorphic-fetch');

// 返回一个组合了所有插件的“插件”

function compose(middlewares) {
  if (!Array.isArray(middlewares)) throw new TypeError('Middlewares must be an array!');

  const middlewaresLen = middlewares.length;
  for (let i = 0; i < middlewaresLen; i++) {
    if (typeof middlewares[i] !== 'function') {
      throw new TypeError('Middleware must be componsed of function');
    }
  }

  return function wrapMiddlewares(params, next) {
    let index = -1;
    function dispatch(i) {
      if (i <= index) {
        return Promise.reject(new Error('next() should not be called multiple times in one middleware!'));
      }
      index = i;
      const fn = middlewares[i] || next;
      if (!fn) return Promise.resolve();
      try {
        return Promise.resolve(fn(params, () => dispatch(i + 1)));
      } catch (err) {
        return Promise.reject(err);
      }
    }

    return dispatch(0);
  };
}

// 参考自 puck-core 请求库的插件机制

class Onion {
  constructor(defaultMiddlewares) {
    if (!Array.isArray(defaultMiddlewares)) throw new TypeError('Default middlewares must be an array!');
    this.defaultMiddlewares = [...defaultMiddlewares];
    this.middlewares = [];
  }

  static globalMiddlewares = []; // 全局中间件
  static defaultGlobalMiddlewaresLength = 0; // 内置全局中间件长度
  static coreMiddlewares = []; // 内核中间件
  static defaultCoreMiddlewaresLength = 0; // 内置内核中间件长度

  use(newMiddleware, opts = { global: false, core: false, defaultInstance: false }) {
    let core = false;
    let global = false;
    let defaultInstance = false;

    if (typeof opts === 'number') {
      if (process && process.env && process.env.NODE_ENV === 'development') {
        console.warn(
          'use() options should be object, number property would be deprecated in future，please update use() options to "{ core: true }".'
        );
      }
      core = true;
      global = false;
    } else if (typeof opts === 'object' && opts) {
      global = opts.global || false;
      core = opts.core || false;
      defaultInstance = opts.defaultInstance || false;
    }

    // 全局中间件
    if (global) {
      Onion.globalMiddlewares.splice(
        Onion.globalMiddlewares.length - Onion.defaultGlobalMiddlewaresLength,
        0,
        newMiddleware
      );
      return;
    }
    // 内核中间件
    if (core) {
      Onion.coreMiddlewares.splice(Onion.coreMiddlewares.length - Onion.defaultCoreMiddlewaresLength, 0, newMiddleware);
      return;
    }

    // 默认实例中间件，供开发者使用
    if (defaultInstance) {
      this.defaultMiddlewares.push(newMiddleware);
      return;
    }

    // 实例中间件
    this.middlewares.push(newMiddleware);
  }

  execute(params = null) {
    const fn = compose([
      ...this.middlewares,
      ...this.defaultMiddlewares,
      ...Onion.globalMiddlewares,
      ...Onion.coreMiddlewares,
    ]);
    return fn(params);
  }
}

/**
 * 实现一个简单的Map cache, 稍后可以挪到 utils中, 提供session local map三种前端cache方式.
 * 1. 可直接存储对象   2. 内存无5M限制   3.缺点是刷新就没了, 看反馈后期完善.
 */

class MapCache {
  constructor(options) {
    this.cache = new Map();
    this.timer = {};
    this.extendOptions(options);
  }

  extendOptions(options) {
    this.maxCache = options.maxCache || 0;
  }

  get(key) {
    return this.cache.get(JSON.stringify(key));
  }

  set(key, value, ttl = 60000) {
    // 如果超过最大缓存数, 删除头部的第一个缓存.
    if (this.maxCache > 0 && this.cache.size >= this.maxCache) {
      const deleteKey = [...this.cache.keys()][0];
      this.cache.delete(deleteKey);
      if (this.timer[deleteKey]) {
        clearTimeout(this.timer[deleteKey]);
      }
    }
    const cacheKey = JSON.stringify(key);
    this.cache.set(cacheKey, value);
    if (ttl > 0) {
      this.timer[cacheKey] = setTimeout(() => {
        this.cache.delete(cacheKey);
        delete this.timer[cacheKey];
      }, ttl);
    }
  }

  delete(key) {
    const cacheKey = JSON.stringify(key);
    delete this.timer[cacheKey];
    return this.cache.delete(cacheKey);
  }

  clear() {
    this.timer = {};
    return this.cache.clear();
  }
}

/**
 * 请求异常
 */
class RequestError extends Error {
  constructor(text, request, type = 'RequestError') {
    super(text);
    this.name = 'RequestError';
    this.request = request;
    this.type = type;
  }
}

/**
 * 响应异常
 */
class ResponseError extends Error {
  constructor(response, text, data, request, type = 'ResponseError') {
    super(text || response.statusText);
    this.name = 'ResponseError';
    this.data = data;
    this.response = response;
    this.request = request;
    this.type = type;
  }
}

/**
 * http://gitlab.alipay-inc.com/KBSJ/gxt/blob/release_gxt_S8928905_20180531/src/util/request.js#L63
 * 支持gbk
 */
function readerGBK(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.onerror = reject;
    reader.readAsText(file, 'GBK'); // setup GBK decoding
  });
}

/**
 * 安全的JSON.parse
 */
function safeJsonParse(data, throwErrIfParseFail = false, response = null, request = null) {
  try {
    return JSON.parse(data);
  } catch (e) {
    if (throwErrIfParseFail) {
      throw new ResponseError(response, 'JSON.parse fail', data, request, 'ParseError');
    }
  } // eslint-disable-line no-empty
  return data;
}

function timeout2Throw(msec, timeoutMessage, request) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new RequestError(timeoutMessage || `timeout of ${msec}ms exceeded`, request, 'Timeout'));
    }, msec);
  });
}

// If request options contain 'cancelToken', reject request when token has been canceled
function cancel2Throw(opt) {
  return new Promise((_, reject) => {
    if (opt.cancelToken) {
      opt.cancelToken.promise.then(cancel => {
        reject(cancel);
      });
    }
  });
}

const toString = Object.prototype.toString;

// Check env is browser or node
function getEnv() {
  let env;
  // Only Node.JS has a process variable that is of [[Class]] process
  if (typeof process !== 'undefined' && toString.call(process) === '[object process]') {
    // For node use HTTP adapter
    env = 'NODE';
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    env = 'BROWSER';
  }
  return env;
}

function isArray(val) {
  return typeof val === 'object' && Object.prototype.toString.call(val) === '[object Array]';
}

function isURLSearchParams(val) {
  return typeof URLSearchParams !== 'undefined' && val instanceof URLSearchParams;
}

function isDate(val) {
  return typeof val === 'object' && Object.prototype.toString.call(val) === '[object Date]';
}

function isObject(val) {
  return val !== null && typeof val === 'object';
}

function forEach2ObjArr(target, callback) {
  if (!target) return;

  if (typeof target !== 'object') {
    target = [target];
  }

  if (isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      callback.call(null, target[i], i, target);
    }
  } else {
    for (let key in target) {
      if (Object.prototype.hasOwnProperty.call(target, key)) {
        callback.call(null, target[key], key, target);
      }
    }
  }
}

function getParamObject(val) {
  if (isURLSearchParams(val)) {
    return qs.parse(val.toString(), { strictNullHandling: true });
  }
  if (typeof val === 'string') {
    return [val];
  }
  return val;
}

function reqStringify(val) {
  return qs.stringify(val, { arrayFormat: 'repeat', strictNullHandling: true });
}

function mergeRequestOptions(options, options2Merge) {
  return {
    ...options,
    ...options2Merge,
    headers: {
      ...options.headers,
      ...options2Merge.headers,
    },
    params: {
      ...getParamObject(options.params),
      ...getParamObject(options2Merge.params),
    },
    method: (options2Merge.method || options.method || 'get').toLowerCase(),
  };
}

// 前后缀拦截
const addfix = (url, options = {}) => {
  const { prefix, suffix } = options;
  if (prefix) {
    url = `${prefix}${url}`;
  }
  if (suffix) {
    url = `${url}${suffix}`;
  }
  return {
    url,
    options,
  };
};

// 是否已经警告过
let warnedCoreType = false;

// 默认缓存判断，开放缓存判断给非 get 请求使用
function __defaultValidateCache(url, options) {
  const { method = 'get' } = options;
  return method.toLowerCase() === 'get';
}

function fetchMiddleware(ctx, next) {
  if (!ctx) return next();
  const { req: { options = {}, url = '' } = {}, cache, responseInterceptors } = ctx;
  const {
    timeout = 0,
    timeoutMessage,
    __umiRequestCoreType__ = 'normal',
    useCache = false,
    method = 'get',
    params,
    ttl,
    validateCache = __defaultValidateCache,
  } = options;

  if (__umiRequestCoreType__ !== 'normal') {
    if (process && process.env && process.env.NODE_ENV === 'development' && warnedCoreType === false) {
      warnedCoreType = true;
      console.warn(
        '__umiRequestCoreType__ is a internal property that use in umi-request, change its value would affect the behavior of request! It only use when you want to extend or use request core.'
      );
    }
    return next();
  }

  const adapter = fetch;

  if (!adapter) {
    throw new Error('Global fetch not exist!');
  }

  // 从缓存池检查是否有缓存数据
  const isBrowser = getEnv() === 'BROWSER';
  const needCache = validateCache(url, options) && useCache && isBrowser;
  if (needCache) {
    let responseCache = cache.get({
      url,
      params,
      method,
    });
    if (responseCache) {
      responseCache = responseCache.clone();
      responseCache.useCache = true;
      ctx.res = responseCache;
      return next();
    }
  }

  let response;
  // 超时处理、取消请求处理
  if (timeout > 0) {
    response = Promise.race([cancel2Throw(options), adapter(url, options), timeout2Throw(timeout, timeoutMessage, ctx.req)]);
  } else {
    response = Promise.race([cancel2Throw(options), adapter(url, options)]);
  }

  // 兼容老版本 response.interceptor
  responseInterceptors.forEach(handler => {
    response = response.then(res => {
      // Fix multiple clones not working, issue: https://github.com/github/fetch/issues/504
      let clonedRes = typeof res.clone === 'function' ? res.clone() : res;
      return handler(clonedRes, options);
    });
  });

  return response.then(res => {
    // 是否存入缓存池
    if (needCache) {
      if (res.status === 200) {
        const copy = res.clone();
        copy.useCache = true;
        cache.set({ url, params, method }, copy, ttl);
      }
    }

    ctx.res = res;
    return next();
  });
}

function parseResponseMiddleware(ctx, next) {
  let copy;

  return next()
    .then(() => {
      if (!ctx) return;
      const { res = {}, req = {} } = ctx;
      const {
        options: {
          responseType = 'json',
          charset = 'utf8',
          getResponse = false,
          throwErrIfParseFail = false,
          parseResponse = true,
        } = {},
      } = req || {};

      if (!parseResponse) {
        return;
      }

      if (!res || !res.clone) {
        return;
      }

      // 只在浏览器环境对 response 做克隆， node 环境如果对 response 克隆会有问题：https://github.com/bitinn/node-fetch/issues/553
      copy = getEnv() === 'BROWSER' ? res.clone() : res;
      copy.useCache = res.useCache || false;

      // 解析数据
      if (charset === 'gbk') {
        try {
          return res
            .blob()
            .then(readerGBK)
            .then(d => safeJsonParse(d, false, copy, req));
        } catch (e) {
          throw new ResponseError(copy, e.message, null, req, 'ParseError');
        }
      } else if (responseType === 'json') {
        return res.text().then(d => safeJsonParse(d, throwErrIfParseFail, copy, req));
      }
      try {
        // 其他如text, blob, arrayBuffer, formData
        return res[responseType]();
      } catch (e) {
        throw new ResponseError(copy, 'responseType not support', null, req, 'ParseError');
      }
    })
    .then(body => {
      if (!ctx) return;
      const { res = {}, req = {} } = ctx;
      const { options: { getResponse = false } = {} } = req || {};

      if (!copy) {
        return;
      }
      if (copy.status >= 200 && copy.status < 300) {
        // 提供源response, 以便自定义处理
        if (getResponse) {
          ctx.res = { data: body, response: copy };
          return;
        }
        ctx.res = body;
        return;
      }
      throw new ResponseError(copy, 'http error', body, req, 'HttpError');
    })
    .catch(e => {
      if (e instanceof RequestError || e instanceof ResponseError) {
        throw e;
      }
      // 对未知错误进行处理
      const { req, res } = ctx;
      e.request = e.request || req;
      e.response = e.response || res;
      e.type = e.type || e.name;
      e.data = e.data || undefined;
      throw e;
    });
}

// 对请求参数做处理，实现 query 简化、 post 简化
function simplePostMiddleware(ctx, next) {
  if (!ctx) return next();
  const { req: { options = {} } = {} } = ctx;
  const { method = 'get' } = options;

  if (['post', 'put', 'patch', 'delete'].indexOf(method.toLowerCase()) === -1) {
    return next();
  }

  const { requestType = 'json', data } = options;
  // 数据使用类axios的新字段data, 避免引用后影响旧代码, 如将body stringify多次
  if (data) {
    const dataType = Object.prototype.toString.call(data);
    if (dataType === '[object Object]' || dataType === '[object Array]') {
      if (requestType === 'json') {
        options.headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json;charset=UTF-8',
          ...options.headers,
        };
        options.body = JSON.stringify(data);
      } else if (requestType === 'form') {
        options.headers = {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          ...options.headers,
        };
        options.body = reqStringify(data);
      }
    } else {
      // 其他 requestType 自定义header
      options.headers = {
        Accept: 'application/json',
        ...options.headers,
      };
      options.body = data;
    }
  }
  ctx.req.options = options;

  return next();
}

function paramsSerialize(params, paramsSerializer) {
  let serializedParams;
  let jsonStringifiedParams;
  // 支持参数自动拼装，其他 method 也可用，不冲突
  if (params) {
    if (paramsSerializer) {
      serializedParams = paramsSerializer(params);
    } else if (isURLSearchParams(params)) {
      serializedParams = params.toString();
    } else {
      if (isArray(params)) {
        jsonStringifiedParams = [];
        forEach2ObjArr(params, function(item) {
          if (item === null || typeof item === 'undefined') {
            jsonStringifiedParams.push(item);
          } else {
            jsonStringifiedParams.push(isObject(item) ? JSON.stringify(item) : item);
          }
        });
        // a: [1,2,3] => a=1&a=2&a=3
        serializedParams = reqStringify(jsonStringifiedParams);
      } else {
        jsonStringifiedParams = {};
        forEach2ObjArr(params, function(value, key) {
          let jsonStringifiedValue = value;
          if (value === null || typeof value === 'undefined') {
            jsonStringifiedParams[key] = value;
          } else if (isDate(value)) {
            jsonStringifiedValue = value.toISOString();
          } else if (isArray(value)) {
            jsonStringifiedValue = value;
          } else if (isObject(value)) {
            jsonStringifiedValue = JSON.stringify(value);
          }
          jsonStringifiedParams[key] = jsonStringifiedValue;
        });
        const tmp = reqStringify(jsonStringifiedParams);
        serializedParams = tmp;
      }
    }
  }
  return serializedParams;
}

// 对请求参数做处理，实现 query 简化、 post 简化
function simpleGetMiddleware(ctx, next) {
  if (!ctx) return next();
  const { req: { options = {} } = {} } = ctx;
  const { paramsSerializer, params } = options;
  let { req: { url = '' } = {} } = ctx;
  // 将 method 改为大写
  options.method = options.method ? options.method.toUpperCase() : 'GET';

  // 设置 credentials 默认值为 same-origin，确保当开发者没有设置时，各浏览器对请求是否发送 cookies 保持一致的行为
  // - omit: 从不发送cookies.
  // - same-origin: 只有当URL与响应脚本同源才发送 cookies、 HTTP Basic authentication 等验证信息.(浏览器默认值,在旧版本浏览器，例如safari 11依旧是omit，safari 12已更改)
  // - include: 不论是不是跨域的请求,总是发送请求资源域在本地的 cookies、 HTTP Basic authentication 等验证信息.
  options.credentials = options.credentials || 'same-origin';

  // 支持类似axios 参数自动拼装, 其他method也可用, 不冲突.
  let serializedParams = paramsSerialize(params, paramsSerializer);
  ctx.req.originUrl = url;
  if (serializedParams) {
    const urlSign = url.indexOf('?') !== -1 ? '&' : '?';
    ctx.req.url = `${url}${urlSign}${serializedParams}`;
  }

  ctx.req.options = options;

  return next();
}

// 初始化全局和内核中间件
const globalMiddlewares = [simplePostMiddleware, simpleGetMiddleware, parseResponseMiddleware];
const coreMiddlewares = [fetchMiddleware];

Onion.globalMiddlewares = globalMiddlewares;
Onion.defaultGlobalMiddlewaresLength = globalMiddlewares.length;
Onion.coreMiddlewares = coreMiddlewares;
Onion.defaultCoreMiddlewaresLength = coreMiddlewares.length;

class Core {
  constructor(initOptions) {
    this.onion = new Onion([]);
    this.fetchIndex = 0; // 【即将废弃】请求中间件位置
    this.mapCache = new MapCache(initOptions);
    this.initOptions = initOptions;
    this.instanceRequestInterceptors = [];
    this.instanceResponseInterceptors = [];
  }
  // 旧版拦截器为共享
  static requestInterceptors = [addfix];
  static responseInterceptors = [];

  // 请求拦截器 默认 { global: true } 兼容旧版本拦截器
  static requestUse(handler, opt = { global: true }) {
    if (typeof handler !== 'function') throw new TypeError('Interceptor must be function!');
    if (opt.global) {
      Core.requestInterceptors.push(handler);
    } else {
      this.instanceRequestInterceptors.push(handler);
    }
  }

  // 响应拦截器 默认 { global: true } 兼容旧版本拦截器
  static responseUse(handler, opt = { global: true }) {
    if (typeof handler !== 'function') throw new TypeError('Interceptor must be function!');
    if (opt.global) {
      Core.responseInterceptors.push(handler);
    } else {
      this.instanceResponseInterceptors.push(handler);
    }
  }

  use(newMiddleware, opt = { global: false, core: false }) {
    this.onion.use(newMiddleware, opt);
    return this;
  }

  extendOptions(options) {
    this.initOptions = mergeRequestOptions(this.initOptions, options);
    this.mapCache.extendOptions(options);
  }

  // 执行请求前拦截器
  dealRequestInterceptors(ctx) {
    const reducer = (p1, p2) =>
      p1.then((ret = {}) => {
        ctx.req.url = ret.url || ctx.req.url;
        ctx.req.options = ret.options || ctx.req.options;
        return p2(ctx.req.url, ctx.req.options);
      });
    const allInterceptors = [...Core.requestInterceptors, ...this.instanceRequestInterceptors];
    return allInterceptors.reduce(reducer, Promise.resolve()).then((ret = {}) => {
      ctx.req.url = ret.url || ctx.req.url;
      ctx.req.options = ret.options || ctx.req.options;
      return Promise.resolve();
    });
  }

  request(url, options) {
    const { onion } = this;
    const obj = {
      req: { url, options: { ...options, url } },
      res: null,
      cache: this.mapCache,
      responseInterceptors: [...Core.responseInterceptors, ...this.instanceResponseInterceptors],
    };
    if (typeof url !== 'string') {
      throw new Error('url MUST be a string');
    }

    return new Promise((resolve, reject) => {
      this.dealRequestInterceptors(obj)
        .then(() => onion.execute(obj))
        .then(() => {
          resolve(obj.res);
        })
        .catch(error => {
          const { errorHandler } = obj.req.options;
          if (errorHandler) {
            try {
              const data = errorHandler(error);
              resolve(data);
            } catch (e) {
              reject(e);
            }
          } else {
            reject(error);
          }
        });
    });
  }
}

/**
 * 当执行 “取消请求” 操作时会抛出 Cancel 对象作为异常
 * @class
 * @param {string=} message The message.
 */
function Cancel(message) {
  this.message = message;
}

Cancel.prototype.toString = function toString() {
  return this.message ? `Cancel: ${this.message}` : 'Cancel';
};

Cancel.prototype.__CANCEL__ = true;

/**
 * 通过 CancelToken 来取消请求操作
 *
 * @class
 * @param {Function} executor The executor function.
 */
function CancelToken(executor) {
  if (typeof executor !== 'function') {
    throw new TypeError('executor must be a function.');
  }

  var resolvePromise;
  this.promise = new Promise(function promiseExecutor(resolve) {
    resolvePromise = resolve;
  });

  var token = this;
  executor(function cancel(message) {
    if (token.reason) {
      // 取消操作已被调用过
      return;
    }

    token.reason = new Cancel(message);
    resolvePromise(token.reason);
  });
}

/**
 * 如果请求已经取消，抛出 Cancel 异常
 */
CancelToken.prototype.throwIfRequested = function throwIfRequested() {
  if (this.reason) {
    throw this.reason;
  }
};

/**
 * 通过 source 来返回 CancelToken 实例和取消 CancelToken 的函数
 */
CancelToken.source = function source() {
  var cancel;
  var token = new CancelToken(function executor(c) {
    cancel = c;
  });
  return {
    token: token,
    cancel: cancel,
  };
};

function isCancel(value) {
  return !!(value && value.__CANCEL__);
}

// 通过 request 函数，在 core 之上再封装一层，提供原 umi/request 一致的 api，无缝升级
const request = (initOptions = {}) => {
  const coreInstance = new Core(initOptions);
  const umiInstance = (url, options = {}) => {
    const mergeOptions = mergeRequestOptions(coreInstance.initOptions, options);
    return coreInstance.request(url, mergeOptions);
  };

  // 中间件
  umiInstance.use = coreInstance.use.bind(coreInstance);
  umiInstance.fetchIndex = coreInstance.fetchIndex;

  // 拦截器
  umiInstance.interceptors = {
    request: {
      use: Core.requestUse.bind(coreInstance),
    },
    response: {
      use: Core.responseUse.bind(coreInstance),
    },
  };

  // 请求语法糖： reguest.get request.post ……
  const METHODS = ['get', 'post', 'delete', 'put', 'patch', 'head', 'options', 'rpc'];
  METHODS.forEach(method => {
    umiInstance[method] = (url, options) => umiInstance(url, { ...options, method });
  });

  umiInstance.Cancel = Cancel;
  umiInstance.CancelToken = CancelToken;
  umiInstance.isCancel = isCancel;

  umiInstance.extendOptions = coreInstance.extendOptions.bind(coreInstance);

  // 暴露各个实例的中间件，供开发者自由组合
  umiInstance.middlewares = {
    instance: coreInstance.onion.middlewares,
    defaultInstance: coreInstance.onion.defaultMiddlewares,
    global: Onion.globalMiddlewares,
    core: Onion.coreMiddlewares,
  };

  return umiInstance;
};

/**
 * extend 方法参考了ky, 让用户可以定制配置.
 * initOpions 初始化参数
 * @param {number} maxCache 最大缓存数
 * @param {string} prefix url前缀
 * @param {function} errorHandler 统一错误处理方法
 * @param {object} headers 统一的headers
 */
const extend = initOptions => request(initOptions);

/**
 * 暴露 fetch 中间件，保障依旧可以使用
 */
const fetch$1 = request({ parseResponse: false });

var request$1 = request({});

exports.Onion = Onion;
exports.RequestError = RequestError;
exports.ResponseError = ResponseError;
exports.default = request$1;
exports.extend = extend;
exports.fetch = fetch$1;
