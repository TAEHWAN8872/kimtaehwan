'use strict';
/**
 * 메뉴 월별 파일 자동 갱신 (data/product-daily.json → data/menu-MM.json)
 *
 * - data/menu-products.json 의 products(상품명 → 상품분류)에 있는 상품만 집계한다.
 *   (상품명은 앞뒤 공백을 제거한 뒤 비교. 비닐봉투·커피·배달료 등은 자연스럽게 제외됨)
 * - 기본 동작: 이번 달(KST)을 다시 만든다. 매월 1~3일에는 지난달도 한 번 더 마감 반영한다.
 * - 수동 지정: MENU_MONTHS=202610,202609 처럼 YYYYMM을 콤마로 주면 그 달만 만든다.
 * - 목록에 없는 새 상품이 월 판매량 reportMinQty 이상이면 data/menu-unmapped.json 에 보고한다.
 * - 마지막에 data/menu-index.json(데이터가 있는 월 목록)을 갱신한다. index.html이 이 파일을 읽는다.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || 'data';
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));

const cfg = readJson('menu-products.json');
const CAT = cfg.products || {};
const CAT_ORDER = cfg.categoryOrder || [];
const MIN_REPORT = cfg.reportMinQty == null ? 100 : cfg.reportMinQty;
const IGNORE_RES = (cfg.ignorePatterns || []).map((p) => new RegExp(p));
const IGNORE_EXACT = new Set((cfg.ignoreExact || []).map((s) => s.trim()));
const YEAR = cfg.year;

// ── 대상 월 결정 ──
function pickMonths() {
  if (process.env.MENU_MONTHS && process.env.MENU_MONTHS.trim()) {
    return process.env.MENU_MONTHS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth() + 1, d = kst.getUTCDate();
  const ym = (yy, mm) => String(yy) + String(mm).padStart(2, '0');
  const list = [ym(y, m)];
  if (d <= 3 && m > 1) list.push(ym(y, m - 1)); // 월초에는 지난달 마감 반영
  return list;
}

const months = pickMonths().filter((ym) => {
  if (!/^\d{6}$/.test(ym)) { console.log(`::warning::잘못된 월 형식 무시: ${ym}`); return false; }
  if (Number(ym.slice(0, 4)) !== YEAR) {
    console.log(`::warning::${ym}은(는) menu-products.json의 year(${YEAR})와 달라 건너뜁니다. 연도가 바뀌면 파일명·index.html 규칙부터 손봐야 합니다.`);
    return false;
  }
  return true;
});
if (!months.length) { console.log('대상 월 없음, 종료'); process.exit(0); }
console.log('대상 월:', months.join(', '));

// ── 집계 ──
const pd = readJson('product-daily.json');
const sums = {};      // ym -> Map(key -> qty)
const unmapped = {};  // ym -> { name -> {qty, stores:Set} }
months.forEach((ym) => { sums[ym] = new Map(); unmapped[ym] = {}; });

for (const s of Object.values(pd.STORES || {})) {
  const store = s.name;
  for (const [dt, rawName, qty] of s.rows || []) {
    const ym = String(dt).slice(0, 6);
    if (!sums[ym]) continue;
    const name = String(rawName).trim();
    if (CAT[name]) {
      const key = name + '\u0000' + store;
      sums[ym].set(key, (sums[ym].get(key) || 0) + qty);
    } else if (!IGNORE_EXACT.has(name) && !IGNORE_RES.some((re) => re.test(name))) {
      const u = unmapped[ym][name] || (unmapped[ym][name] = { qty: 0, stores: new Set() });
      u.qty += qty; u.stores.add(store);
    }
  }
}

// ── 월별 파일 쓰기 ──
const catIdx = (c) => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 999 : i; };
for (const ym of months) {
  const mm = ym.slice(4);
  const rows = [];
  for (const [key, qty] of sums[ym]) {
    if (qty <= 0) continue;
    const [name, store] = key.split('\u0000');
    rows.push({ '상품분류': CAT[name], '상품명': name, '매장': store, '수량': qty });
  }
  if (!rows.length) { console.log(`${ym}: 집계된 행이 없어 menu-${mm}.json 은 만들지 않습니다.`); continue; }
  rows.sort((a, b) => catIdx(a['상품분류']) - catIdx(b['상품분류'])
    || (a['상품명'] < b['상품명'] ? -1 : a['상품명'] > b['상품명'] ? 1 : 0)
    || (a['매장'] < b['매장'] ? -1 : a['매장'] > b['매장'] ? 1 : 0));
  fs.writeFileSync(path.join(DATA_DIR, `menu-${mm}.json`), JSON.stringify(rows));
  const total = rows.reduce((t, r) => t + r['수량'], 0);
  console.log(`${ym}: menu-${mm}.json 저장 — ${rows.length}행, 상품 ${new Set(rows.map((r) => r['상품명'])).size}종, 매장 ${new Set(rows.map((r) => r['매장'])).size}곳, 수량 합계 ${total.toLocaleString()}`);
}

// ── 새 상품 보고 ──
const repPath = path.join(DATA_DIR, 'menu-unmapped.json');
let report = {};
try { report = JSON.parse(fs.readFileSync(repPath, 'utf8')); } catch (e) { report = {}; }
report.안내 = '메뉴 목록(menu-products.json)에 없는데 판매량이 많은 상품입니다. 메뉴면 products에 추가, 아니면 ignoreExact/ignorePatterns에 추가하세요.';
report.updatedAt = new Date().toISOString();
report.months = report.months || {};
for (const ym of months) {
  const list = Object.entries(unmapped[ym])
    .filter(([, v]) => v.qty >= MIN_REPORT)
    .map(([name, v]) => ({ name, qty: v.qty, stores: v.stores.size }))
    .sort((a, b) => b.qty - a.qty);
  report.months[ym] = list;
  if (list.length) {
    console.log(`::warning::${ym} 메뉴 목록에 없는 상품 ${list.length}개 (menu-unmapped.json 참고): ` + list.slice(0, 5).map((x) => `${x.name}(${x.qty})`).join(', '));
  }
}
fs.writeFileSync(repPath, JSON.stringify(report, null, 1));

// ── 월 목록 인덱스 ──
const have = fs.readdirSync(DATA_DIR)
  .map((f) => /^menu-(\d{2})\.json$/.exec(f)).filter(Boolean)
  .map((m) => Number(m[1])).sort((a, b) => a - b);
fs.writeFileSync(path.join(DATA_DIR, 'menu-index.json'), JSON.stringify({ year: YEAR, months: have, updatedAt: new Date().toISOString() }));
console.log('menu-index.json:', have.join(','));
