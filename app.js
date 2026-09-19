/* ============================================================
   汕尾打黑钓点助手 — 主逻辑
   核心：基于黑鱼（乌鳢）习性的规则打分引擎（"老师傅经验"数字化）
   ============================================================ */

/* ---------- 配置区 ---------- */
var CONFIG = {
  // 高德地图 Web 端(JS API) Key —— 请替换成你自己的
  amapKey: '7cfe0686ad3e806dd7a764b4bb7e78aa',
  // 高德安全密钥（新版 JS API 2.0 需要，可选，若无可留空）
  amapSecurityCode: '9074763f8b488f3ee4bf4a095aecf662',
  // 默认城市中心（汕尾）
  cityCenter: [115.375, 22.786], // [lng, lat]
  cityName: '汕尾市',
  // 推荐的钓点数量上限
  maxRecommend: 12,
  // 默认搜索半径（米）
  searchRadius: 20000,
};

/* ---------- 状态 ---------- */
var state = {
  map: null,
  AMap: null,
  markers: [],
  myLocation: null,   // {lng, lat}
  results: [],        // 打分后的钓点
  mySpots: [],        // 我的记录
};

/* ============================================================
   一、黑鱼习性打分引擎（核心）
   ============================================================ */

// 水体类型基础分：黑鱼偏爱静水、水草多、中小型水体
var TYPE_BASE = {
  pond: 60,    // 水塘/野塘/水库 —— 黄金钓点
  canal: 55,   // 沟渠/水渠 —— 黑鱼爱钻，水草多
  dam: 50,     // 拦水坝/蓄水区
  stream: 40,  // 溪流
  river: 35,   // 大江大河 —— 太开阔，需找洄湾
};

// 大小分级调整
var GRADE_ADJ = {
  'S': 10,   // 小型水体，黑鱼最爱
  'M': 5,
  'L': -5,   // 大型水体，需进一步缩小到洄湾
};

// 类型中文名
var TYPE_NAME = {
  pond: '水塘', canal: '沟渠', dam: '蓄水区', stream: '溪流', river: '河流'
};

// 获取当前季节（北半球）
function getSeason(now) {
  var m = now.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

var SEASON_NAME = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

// 季节说明
var SEASON_TIP = {
  spring: '春季产卵期，黑鱼靠岸护窝、攻击性强，浅水草区最佳',
  summer: '夏季高温，早晚窗口期活跃，午后转深水阴凉处',
  autumn: '秋季进食旺季，全水域活跃，一年黄金季',
  winter: '冬季低温，黑鱼蛰伏深水，活性低，钓获难度大',
};

// 距离换算（球面距离，单位米）
function distanceMeters(lng1, lat1, lng2, lat2) {
  var R = 6371000;
  var rad = Math.PI / 180;
  var dLat = (lat2 - lat1) * rad;
  var dLng = (lng2 - lng1) * rad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 距离加分（打黑讲究就近，权重加强）
function distanceScore(m) {
  if (m < 1000) return 25;
  if (m < 2000) return 20;
  if (m < 3000) return 16;
  if (m < 5000) return 12;
  if (m < 8000) return 8;
  if (m < 12000) return 5;
  if (m < 20000) return 2;
  return 0;
}

// 生成单个水体的推荐理由
function buildReasons(w, season, distKm) {
  var rs = [];
  var tname = TYPE_NAME[w.t] || w.t;
  var tcn = w.n || '无名' + tname;

  // 类型理由
  if (w.t === 'pond') rs.push({ k: '水体', v: '静水' + tname + '，黑鱼最爱的藏身环境' });
  if (w.t === 'canal') rs.push({ k: '水体', v: '沟渠水草丰茂，黑鱼爱钻边' });
  if (w.t === 'river') rs.push({ k: '水体', v: '河流开阔，建议找洄湾、入水口' });
  if (w.t === 'stream') rs.push({ k: '水体', v: '溪流缓水区，浅滩水草带可试' });
  if (w.t === 'dam') rs.push({ k: '水体', v: '蓄水区，找坝根、乱石结构' });

  // 大小理由
  if (w.g === 'S') rs.push({ k: '体量', v: '小型水体，标点集中、好找鱼' });
  if (w.g === 'M') rs.push({ k: '体量', v: '中型水体，深浅结构丰富' });
  if (w.g === 'L') rs.push({ k: '体量', v: '大型水体，优先搜洄湾、岸边浅滩' });

  // 命名（野塘人少）
  if (!w.n && w.t === 'pond') rs.push({ k: '环境', v: '无名野塘，钓友少、资源可能更好' });
  if (w.n && w.n.indexOf('水库') >= 0) rs.push({ k: '环境', v: '水库稳定，找库尾浅滩、水草湾' });

  // 季节理由
  if (season === 'spring') rs.push({ k: '季节', v: '产卵期靠岸，优先浅水+水草区' });
  if (season === 'summer') rs.push({ k: '季节', v: '夏季选早晚，午后找深水阴凉' });
  if (season === 'autumn') rs.push({ k: '季节', v: '秋食旺季，全天可钓' });
  if (season === 'winter') rs.push({ k: '季节', v: '冬季低温难钓，找深水、背风向阳' });

  // 距离理由
  rs.push({ k: '距离', v: '距你约 ' + (distKm < 1 ? Math.round(distKm * 1000) + ' 米' : distKm.toFixed(1) + ' 公里') });

  return rs;
}

// 主打分函数：返回 { score, reasons }
function scoreWaterBody(w, now, myLoc) {
  var score = TYPE_BASE[w.t] || 60;
  score += GRADE_ADJ[w.g] || 0;

  // 季节调整
  var season = getSeason(now);
  if (season === 'spring') {
    if (w.t === 'pond' || w.t === 'canal') score += 8; // 产卵靠岸
  } else if (season === 'summer') {
    if (w.t === 'dam') score += 5;
    if (w.t === 'pond' && w.g === 'S') score -= 2; // 小水塘午后易闷
  } else if (season === 'autumn') {
    score += 3; // 黄金季
  } else if (season === 'winter') {
    score -= 12; // 整体难钓
    if (w.g === 'L') score += 6; // 深水稍好
  }

  // 命名微调：无名野塘 +4（少人钓）
  if (!w.n && (w.t === 'pond' || w.t === 'canal')) score += 4;

  // 距离
  var dist = 0;
  if (myLoc) {
    dist = distanceMeters(myLoc.lng, myLoc.lat, w.x, w.y);
    score += distanceScore(dist);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  var distKm = myLoc ? dist / 1000 : 0;
  return {
    score: score,
    season: season,
    distKm: distKm,
    reasons: buildReasons(w, season, distKm),
  };
}

// 一键分析：对附近水体打分排序
function analyzeAll(now, myLoc) {
  var out = [];
  for (var i = 0; i < WATER_DATA.length; i++) {
    var w = WATER_DATA[i];
    // 距离过滤
    if (myLoc) {
      var d = distanceMeters(myLoc.lng, myLoc.lat, w.x, w.y);
      if (d > CONFIG.searchRadius) continue;
    }
    var r = scoreWaterBody(w, now, myLoc);
    out.push({ water: w, score: r.score, season: r.season, distKm: r.distKm, reasons: r.reasons });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  return out;
}

/* ============================================================
   二、地图初始化
   ============================================================ */

function loadAMap(cb) {
  if (window.AMap) { cb(window.AMap); return; }
  // 动态加载高德 JS API
  if (CONFIG.amapSecurityCode) {
    window._AMapSecurityConfig = { securityJsCode: CONFIG.amapSecurityCode };
  }
  var script = document.createElement('script');
  script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(CONFIG.amapKey) + '&callback=__amapReady';
  window.__amapReady = function () { cb(window.AMap); };
  script.onerror = function () {
    showToast('地图加载失败，请检查高德 Key 配置');
  };
  document.head.appendChild(script);
}

function initMap() {
  loadAMap(function (AMap) {
    state.AMap = AMap;
    state.map = new AMap.Map('map', {
      zoom: 12,
      center: CONFIG.cityCenter,
      viewMode: '2D',
      mapStyle: 'amap://styles/darkblue',
    });
    // 添加定位控件
    state.map.plugin(['AMap.Geolocation'], function () {
      var geolocation = new AMap.Geolocation({
        enableHighAccuracy: true,
        timeout: 8000,
        zoomToAccuracy: true,
      });
      state.map.addControl(geolocation);
      geolocation.getCurrentPosition(function (status, result) {
        if (status === 'complete' && result.position) {
          state.myLocation = { lng: result.position.lng, lat: result.position.lat };
          state.map.setCenter([result.position.lng, result.position.lat]);
          showMyLocation(result.position);
          setLocText('已定位');
        } else {
          setLocText('定位失败，用城市中心');
        }
      });
    });
    setLocText('地图已加载');
  });
}

function showMyLocation(pos) {
  var AMap = state.AMap;
  var marker = new AMap.Marker({
    position: [pos.lng, pos.lat],
    icon: new AMap.Icon({
      size: new AMap.Size(18, 18),
      imageSize: new AMap.Size(18, 18),
      image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="7" fill="#3d7bff" stroke="#fff" stroke-width="2.5"/></svg>'
      ),
    }),
    zIndex: 200,
  });
  state.map.add(marker);
}

/* ============================================================
   三、标记渲染
   ============================================================ */

var SCORE_COLOR = function (s) {
  if (s >= 85) return '#ff5d5d';
  if (s >= 75) return '#ff9d3d';
  if (s >= 65) return '#ffd166';
  if (s >= 55) return '#2ec4b6';
  return '#5b7083';
};

function renderMarkers(results) {
  var AMap = state.AMap;
  // 清除旧标记
  state.markers.forEach(function (m) { state.map.remove(m); });
  state.markers = [];

  var top = results.slice(0, CONFIG.maxRecommend);
  top.forEach(function (r, idx) {
    var w = r.water;
    var color = SCORE_COLOR(r.score);
    var label = r.score >= 75 ? '★' : '';
    var content =
      '<div style="position:relative;width:34px;height:34px;display:flex;align-items:center;justify-content:center;">' +
      '<div style="position:absolute;inset:0;border-radius:50%;background:' + color + ';opacity:.25;"></div>' +
      '<div style="position:relative;width:24px;height:24px;border-radius:50%;background:' + color + ';border:2px solid #fff;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">' +
      (idx + 1) + '</div></div>';
    var marker = new AMap.Marker({
      position: [w.x, w.y],
      content: content,
      offset: new AMap.Pixel(-17, -17),
      zIndex: 100 + (top.length - idx),
    });
    marker.on('click', function () { showDetail(r); });
    state.map.add(marker);
    state.markers.push(marker);
  });
  state.results = top;
}

/* ============================================================
   四、详情 & 导航
   ============================================================ */

function showDetail(r) {
  var w = r.water;
  var tname = w.n || (TYPE_NAME[w.t] + '（无名）');
  var color = SCORE_COLOR(r.score);
  var reasonsHtml = r.reasons.map(function (x) {
    return '<div class="r"><b>' + x.k + '</b><span>' + x.v + '</span></div>';
  }).join('');

  var el = document.getElementById('detail');
  el.innerHTML =
    '<div class="d-title">' + tname + '</div>' +
    '<div class="d-score" style="color:' + color + '">推荐度 ' + r.score + ' 分 · ' + SEASON_NAME[r.season] + '季</div>' +
    '<div class="d-reasons">' + reasonsHtml + '</div>' +
    '<div class="d-actions">' +
    '<button class="d-btn nav" onclick="navigate(' + w.x + ',' + w.y + ',\'' + tname.replace(/'/g, '') + '\')">🧭 导航过去</button>' +
    '<button class="d-btn mark" onclick="markSpot(' + w.x + ',' + w.y + ',\'' + tname.replace(/'/g, '') + '\',' + r.score + ')">⭐ 收藏</button>' +
    '</div>';
  el.classList.add('show');
}

function hideDetail() {
  document.getElementById('detail').classList.remove('show');
}

function navigate(lng, lat, name) {
  // 唤起高德地图 App 导航
  var url = 'https://uri.amap.com/navigation?to=' + lng + ',' + lat + ',' + encodeURIComponent(name) +
    '&mode=car&src=shanweiFishing';
  window.open(url, '_blank');
}

/* ============================================================
   五、我的点（记录，localStorage 本地存储，预留云端同步）
   ============================================================ */

function loadMySpots() {
  try {
    state.mySpots = JSON.parse(localStorage.getItem('sw_mySpots') || '[]');
  } catch (e) { state.mySpots = []; }
}

function saveMySpots() {
  localStorage.setItem('sw_mySpots', JSON.stringify(state.mySpots));
}

function markSpot(lng, lat, name, score) {
  loadMySpots();
  // 去重
  var exist = state.mySpots.find(function (s) {
    return Math.abs(s.x - lng) < 0.001 && Math.abs(s.y - lat) < 0.001;
  });
  if (exist) { showToast('这个点已经收藏过了'); hideDetail(); return; }
  state.mySpots.push({
    id: Date.now(), name: name, x: lng, y: lat, score: score,
    status: null, // null=未去, 'got'=钓获, 'empty'=空军
    depth: '', weed: '', note: '', photo: '', time: Date.now(),
  });
  saveMySpots();
  showToast('已收藏 ✓');
  hideDetail();
}

function renderMySpots() {
  loadMySpots();
  var body = document.getElementById('mine-body');
  if (state.mySpots.length === 0) {
    body.innerHTML = '<div class="empty">还没有收藏的钓点。<br>在地图上点开钓点 → 点「⭐ 收藏」即可加入。</div>';
    return;
  }
  var html = '';
  state.mySpots.forEach(function (s, i) {
    var badge = '';
    if (s.status === 'got') badge = '<span class="mine-badge got">钓获</span>';
    else if (s.status === 'empty') badge = '<span class="mine-badge empty">空军</span>';
    else badge = '<span class="mine-badge" style="background:var(--line);color:var(--txt2)">未去</span>';
    var meta = [];
    if (s.depth) meta.push('水深:' + s.depth);
    if (s.weed) meta.push('水草:' + s.weed);
    if (s.note) meta.push('备注:' + s.note);
    html +=
      '<div class="mine-item">' +
      '<div class="mine-head"><span class="mine-name">' + s.name + '</span>' + badge + '</div>' +
      '<div class="mine-meta">' + (meta.join(' · ') || '点击记录实战情况') + '</div>' +
      '<div style="margin-top:8px;display:flex;gap:6px;">' +
      '<button class="d-btn mark" style="height:34px;font-size:12px" onclick="recordSpot(' + i + ',\'got\')">✓ 钓获</button>' +
      '<button class="d-btn mark" style="height:34px;font-size:12px" onclick="recordSpot(' + i + ',\'empty\')">✗ 空军</button>' +
      '<button class="d-btn nav" style="height:34px;font-size:12px" onclick="navigate(' + s.x + ',' + s.y + ',\'' + s.name.replace(/'/g, '') + '\')">导航</button>' +
      '<button class="mine-del" onclick="delSpot(' + i + ')">删除</button>' +
      '</div>' +
      '</div>';
  });
  body.innerHTML = html;
}

function recordSpot(idx, status) {
  loadMySpots();
  var s = state.mySpots[idx];
  if (!s) return;
  s.status = status;
  // 简单提示输入备注
  var depth = prompt('水深大概多少？（可留空）');
  var weed = prompt('水草情况？（多/少/芦苇/荷塘等，可留空）');
  var note = prompt('补充备注（可留空）');
  if (depth !== null) s.depth = depth;
  if (weed !== null) s.weed = weed;
  if (note !== null) s.note = note;
  s.time = Date.now();
  saveMySpots();
  renderMySpots();
  showToast('已记录 ✓');
}

function delSpot(idx) {
  if (!confirm('确定删除这个钓点？')) return;
  loadMySpots();
  state.mySpots.splice(idx, 1);
  saveMySpots();
  renderMySpots();
}

/* ============================================================
   六、UI 交互
   ============================================================ */

function setLocText(t) {
  document.getElementById('tb-loc').textContent = t;
}

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { t.classList.remove('show'); }, 1800);
}

function togglePanel(id) {
  var p = document.getElementById(id);
  var show = !p.classList.contains('show');
  document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('show'); });
  if (show) p.classList.add('show');
  hideDetail();
}

// 一键找钓点
function findSpots() {
  if (!state.map) { showToast('地图还没加载好'); return; }
  if (!state.myLocation) { showToast('还没定位，先用城市中心'); }
  var loading = showLoading('正在分析附近水域…');
  setTimeout(function () {
    var now = new Date();
    var results = analyzeAll(now, state.myLocation);
    renderMarkers(results);
    renderList(results);
    hideLoading(loading);
    if (results.length === 0) {
      showToast('附近暂未找到合适水体');
    } else {
      showToast('找到 ' + results.length + ' 个候选钓点，已按推荐度排序');
      // 视野适配
      if (state.myLocation) {
        state.map.setZoomAndCenter(13, [state.myLocation.lng, state.myLocation.lat]);
      }
    }
  }, 300);
}

function renderList(results) {
  var body = document.getElementById('list-body');
  if (results.length === 0) {
    body.innerHTML = '<div class="empty">暂无可推荐钓点</div>';
    return;
  }
  var top = results.slice(0, CONFIG.maxRecommend);
  var html = '<div class="rec-item" style="background:transparent;padding:4px 12px;border:none;cursor:default"><span style="font-size:13px;color:var(--txt2)">' + SEASON_TIP[top[0].season] + '</span></div>';
  top.forEach(function (r, i) {
    var w = r.water;
    var tname = w.n || (TYPE_NAME[w.t] + '（无名）');
    var rankClass = i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : 'rn';
    var tags = '<span class="tag">' + TYPE_NAME[w.t] + '</span>';
    if (r.score >= 85) tags += '<span class="tag hot">强烈推荐</span>';
    else if (r.score >= 75) tags += '<span class="tag ok">值得一试</span>';
    if (!w.n) tags += '<span class="tag">野塘</span>';
    html +=
      '<div class="rec-item" onclick="focusSpot(' + i + ')">' +
      '<div class="rec-rank ' + rankClass + '">' + (i + 1) + '</div>' +
      '<div class="rec-main"><div class="rec-name">' + tname + '</div><div class="rec-tags">' + tags + '</div></div>' +
      '<div class="rec-score"><div class="score-num">' + r.score + '</div><div class="score-label">推荐度</div></div>' +
      '</div>';
  });
  body.innerHTML = html;
  body._results = top;
}

function focusSpot(i) {
  var r = document.getElementById('list-body')._results[i];
  if (!r) return;
  state.map.setZoomAndCenter(15, [r.water.x, r.water.y]);
  showDetail(r);
}

function showLoading(text) {
  var d = document.createElement('div');
  d.className = 'loading';
  d.innerHTML = '<div class="spinner"></div><p>' + text + '</p>';
  document.body.appendChild(d);
  return d;
}
function hideLoading(d) { if (d && d.parentNode) d.parentNode.removeChild(d); }

/* ---------- 事件绑定 ---------- */
document.addEventListener('DOMContentLoaded', function () {
  var toast = document.createElement('div');
  toast.id = 'toast';
  document.body.appendChild(toast);

  document.getElementById('btn-find').addEventListener('click', findSpots);
  document.getElementById('btn-list').addEventListener('click', function () {
    if (state.results.length === 0) { showToast('先点「一键找钓点」'); }
    togglePanel('panel-list');
  });
  document.getElementById('btn-mine').addEventListener('click', function () {
    renderMySpots();
    togglePanel('panel-mine');
  });
  document.querySelectorAll('.panel-close').forEach(function (b) {
    b.addEventListener('click', function () {
      document.getElementById(b.dataset.close).classList.remove('show');
    });
  });
  document.getElementById('map').addEventListener('click', hideDetail);

  loadMySpots();
  initMap();
});
