var WidgetMetadata = {
  id: "afosne_shortdrama",
  title: "短剧 · Afosne",
  description: "获取在线短剧：搜索、详情、选集、播放链接（m3u8/直链）",
  author: "你 + ChatGPT",
  site: "https://linux.do/t/topic/853971",
  version: "1.0.2",
  requiredVersion: "0.0.1",
  modules: [
    {
      title: "短剧搜索",
      description: "按关键词搜索短剧",
      requiresWebView: false,
      functionName: "getShortDramas",
      params: [
        { name: "keyword", title: "关键词", type: "text", placeholder: "输入短剧名称 / 角色 / 主题" },
        { name: "page", title: "页数", type: "page" }
      ]
    }
  ]
};

// 配置
var config = {
  API_BASE: "https://api.r2afosne.dpdns.org",
  TIMEOUT_MS: 12000,
  UA: "ForwardWidget/Afosne"
};

// 简单 GET（不使用可选链，避免解析差异）
async function httpGet(url, params) {
  var headers = { "User-Agent": config.UA, "Accept": "application/json, text/plain, */*" };
  return Widget.http.get(url, { params: params || {}, headers: headers, timeout: config.TIMEOUT_MS });
}

// 规范化条目
function normalizeItem(it) {
  it = it || {};
  return {
    id: String(it.id || it.vid || it.rid || it.url || it.link || ""),
    title: it.title || it.name || "未命名",
    type: "url",
    posterPath: it.cover || it.pic || it.poster || it.img || "",
    link: it.link || it.url || ""
  };
}

// 规范化列表
function pickArray(payload) {
  if (!payload) return [];
  if (payload.data && payload.data.list && Array.isArray(payload.data.list)) return payload.data.list;
  if (payload.list && Array.isArray(payload.list)) return payload.list;
  if (payload.results && Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload)) return payload;
  return [];
}

// 搜索短剧（与 WidgetMetadata.functionName 对齐）
async function getShortDramas(params) {
  params = params || {};
  if (!params.keyword) throw new Error("请输入关键词");
  var page = params.page || 1;

  // 依次尝试常见搜索路径与参数
  var paths = ["/search", "/api/search", "/v1/search"];
  var keyParams = [
    { key: "key", page: "page" },
    { key: "keyword", page: "page" },
    { key: "wd", page: "pg" },
    { key: "q", page: "page" }
  ];

  for (var i = 0; i < paths.length; i++) {
    for (var j = 0; j < keyParams.length; j++) {
      try {
        var qp = {};
        qp[keyParams[j].key] = params.keyword;
        qp[keyParams[j].page] = page;
        var resp = await httpGet(config.API_BASE + paths[i], qp);
        if (!resp || !resp.data) continue;
        var arr = pickArray(resp.data);
        if (!arr.length) continue;
        var list = [];
        for (var k = 0; k < arr.length; k++) list.push(normalizeItem(arr[k]));
        if (list.length) return list;
      } catch (e) {}
    }
  }
  return [];
}

// 详情（Forward 会在卡片点击时调用）
async function loadDetail(link) {
  // 尝试 detail 接口，不行就把 link 当直链兜底
  var detailPaths = ["/detail", "/api/detail", "/v1/detail", "/short/detail", "/video/detail"];
  var idKeys = ["id", "vid", "rid", "sid"];

  // 如果 link 已经是完整的详情 URL，直接请求
  if (/^https?:\/\//i.test(link) && link.indexOf(config.API_BASE) === 0) {
    try {
      var r0 = await httpGet(link);
      var det0 = buildDetail(r0 && r0.data);
      if (det0) return det0;
    } catch (e0) {}
  }

  for (var i = 0; i < detailPaths.length; i++) {
    for (var j = 0; j < idKeys.length; j++) {
      try {
        var qp = {};
        qp[idKeys[j]] = link;
        var r = await httpGet(config.API_BASE + detailPaths[i], qp);
        var det = buildDetail(r && r.data);
        if (det) return det;
      } catch (e) {}
    }
  }

  // 兜底：把 link 当成可播放直链
  return {
    id: link,
    type: "url",
    title: "详情加载失败（直链兜底）",
    posterPath: "",
    mediaType: "movie",
    videoUrl: link
  };
}

// 从响应构造详情对象（不使用可选链）
function buildDetail(payload) {
  if (!payload) return null;
  var d = null;
  if (payload.data) d = payload.data;
  if (!d && payload.item) d = payload.item;
  if (!d && typeof payload === "object") d = payload;

  if (!d) return null;

  var title = d.title || d.name || "未命名";
  var poster = d.cover || d.pic || d.poster || d.picture || "";
  var desc = d.desc || d.brief || d.intro || "";
  var raw = d.episodes || d.epList || d.sources || d.playlist || [];
  var eps = [];
  if (Array.isArray(raw)) {
    for (var i = 0; i < raw.length; i++) {
      var ep = raw[i] || {};
      var eid = String(ep.id || ep.eid || ep.episodeId || ep.url || ((d.id || "sid") + "_" + (i + 1)));
      var name = ep.name || ep.title || ("第" + (i + 1) + "集");
      var url = ep.url || ep.link || "";
      eps.push({ id: eid, type: "url", title: name, videoUrl: url });
    }
  }

  var mediaType = eps.length > 1 ? "tv" : "movie";
  var videoUrl = d.current && d.current.link ? d.current.link : (d.link || "");

  return {
    id: d.id || videoUrl || "",
    type: "url",
    title: title,
    posterPath: poster,
    overview: desc,
    mediaType: mediaType,
    videoUrl: videoUrl,
    episode: eps.length || undefined,
    episodeItems: eps.length ? eps : undefined
  };
}
