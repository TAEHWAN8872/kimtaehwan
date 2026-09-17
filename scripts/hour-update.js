// scripts/hour-update.js
// 매번(daily-update.js와 같은 스케줄) 실행되는 스크립트. "오늘" 하루치
// 시간대별(1시간 단위) 상품 판매 데이터를 월별 파일 data/hour/hour-YYYYMM.json에
// 병합합니다.
//
// [2026-09-16 변경: API 재호출 방식 폐기 → data/live-daily.json 재사용으로 전환]
// 처음에는 이 스크립트가 자체적으로 REQ_CODE 3(주문)·REQ_CODE 6(품목)을 다시
// 호출했는데, 실제로 돌려보니 같은 매장·날짜로 daily-update.js(1번째) →
// product-daily-update.js(2번째)에 이어 세 번째로 REQ_CODE 6을 호출하자 154개
// 매장 전부에서 품목이 0건 매칭되는 현상이 확인됐다(2026-09-16 실측). 같은 요청을
// 짧은 시간에 반복 호출하면 일부만 누락되는 정도가 아니라 통째로 빈 응답을 주는
// 것으로 보인다.
//
// 그런데 daily-update.js는 이미 REQ_CODE 3 주문(SA_DT=시각 포함)과 REQ_CODE 6
// 품목을 SA_NO로 조인해서 store.todayRaw.ordersByNo / itemsByNo에 저장해두고,
// 그 결과를 data/live-daily.json에 그대로 커밋한다. 이 스크립트는 daily-update.js
// 바로 다음 스텝으로 실행되므로(같은 GitHub Actions job = 같은 체크아웃 디렉토리),
// API를 다시 부르지 않고 그 파일을 그대로 읽어서 재사용한다. 즉 이 스크립트는
// TPAY_TOKEN도, 네트워크 호출도 필요 없는 순수 로컬 변환 스크립트다.
//
// [중요한 한계] daily-update.js의 todayRaw는 "오늘" 하루치만 유지되므로(날짜가
// 바뀌면 초기화), 이 스크립트도 "오늘" 하루치 시간대만 매번 다시 계산해서 채운다.
// 과거 날짜의 시간대별 데이터는 애초에 tpay 정산 확정 리포트(REQ_CODE 4/5)에
// 시간 정보가 없어 만들 수 없다 — 이 스크립트가 매일 실행되기 시작한 시점부터
// 데이터가 쌓인다.
//
// [저장 포맷] 용량 절약을 위해 상품명은 월별 파일 전체가 공유하는 PRODUCTS
// 배열의 인덱스로 저장한다. 매장별 rows는 [일(1~31), 시(0~23), 상품인덱스,
// 수량, 금액] 압축 배열이다.

const fs = require('fs');
const path = require('path');
const { kstDateString, aggregateOrdersAndItemsToHourProducts } = require('./lib');

const LIVE_DATA_PATH = path.join(__dirname, '..', 'data', 'live-daily.json');
const HOUR_DIR = path.join(__dirname, '..', 'data', 'hour');

function hourPath_(ym) {
  return path.join(HOUR_DIR, `hour-${ym}.json`);
}

function loadExistingMonth_(ym) {
  const p = hourPath_(ym);
  if (!fs.existsSync(p)) return { YM: ym, PRODUCTS: [], STORES: {} };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(data.PRODUCTS)) data.PRODUCTS = [];
    if (!data.STORES) data.STORES = {};
    return data;
  } catch (e) {
    console.warn(`기존 ${p} 파싱 실패, 새로 시작합니다:`, e.message);
    return { YM: ym, PRODUCTS: [], STORES: {} };
  }
}

// 상품명 -> 인덱스. 없으면 PRODUCTS 배열 끝에 추가(기존 인덱스는 절대 바꾸지 않음).
function productIndex_(productsArr, indexMap, name) {
  if (indexMap[name] !== undefined) return indexMap[name];
  const idx = productsArr.length;
  productsArr.push(name);
  indexMap[name] = idx;
  return idx;
}

// daily-update.js가 저장한 itemsByNo({ [SA_NO]: [{CMDT_NM,SC_QTY,SC_AMT_TTL,SC_FORM,OPTION_GBN}] })를
// SA_NO 필드가 각 라인에 실려있는 평평한 배열로 펼친다 (lib.aggregateOrdersAndItemsToHourProducts가
// 받는 rawItemRows 형태에 맞추기 위함).
function flattenItemsByNo_(itemsByNo) {
  const rows = [];
  for (const [saNo, items] of Object.entries(itemsByNo || {})) {
    for (const it of items) rows.push({ ...it, SA_NO: saNo });
  }
  return rows;
}

function main() {
  if (!fs.existsSync(LIVE_DATA_PATH)) {
    throw new Error(`${LIVE_DATA_PATH}가 없습니다. daily-update.js를 먼저 실행해주세요.`);
  }
  const live = JSON.parse(fs.readFileSync(LIVE_DATA_PATH, 'utf8'));
  const liveStores = live.STORES || {};

  const today = kstDateString(0);
  const ym = today.slice(0, 6);
  const todayDay = Number(today.slice(6, 8));

  const existing = loadExistingMonth_(ym);
  const products = existing.PRODUCTS.slice();
  const productIndexMap = {};
  products.forEach((name, i) => { productIndexMap[name] = i; });

  const prevStores = existing.STORES || {};
  const stores = { ...prevStores };

  let updatedCount = 0;
  let skippedNoTodayRaw = 0;
  let totalMatchedOrders = 0, totalSkippedNoTime = 0, totalSkippedNoItems = 0, totalCarryOrders = 0;

  for (const [code, s] of Object.entries(liveStores)) {
    const todayRaw = s.todayRaw;
    if (!todayRaw || todayRaw.date !== today) {
      skippedNoTodayRaw++;
      continue; // 오늘자 원본이 없는 매장(이번 회차 fetch 실패 등) — 기존 hour 데이터 그대로 유지
    }

    const mergedOrders = Object.values(todayRaw.ordersByNo || {});
    const mergedItemRows = flattenItemsByNo_(todayRaw.itemsByNo);
    const { rows: hourRows, matchedOrders, skippedNoTime, skippedNoItems, carryOrders } =
      aggregateOrdersAndItemsToHourProducts(mergedOrders, mergedItemRows);
    totalMatchedOrders += matchedOrders;
    totalSkippedNoTime += skippedNoTime;
    totalSkippedNoItems += skippedNoItems;
    totalCarryOrders += carryOrders;

    const todayCompactRows = hourRows
      .filter((r) => r.SDA_DT === today)
      .map((r) => [todayDay, r.hour, productIndex_(products, productIndexMap, r.CMDT_NM), r.qty, r.amount]);

    const prev = stores[code] || { name: s.name, rows: [] };
    const prevRows = (prev.rows || []).filter((r) => r[0] !== todayDay);
    stores[code] = { name: s.name, rows: [...prevRows, ...todayCompactRows] };
    updatedCount++;
  }

  const output = {
    YM: ym,
    PRODUCTS: products,
    STORES: stores,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(HOUR_DIR, { recursive: true });
  fs.writeFileSync(hourPath_(ym), JSON.stringify(output));

  console.log(
    `시간대별 매출 갱신 완료(data/live-daily.json 재사용): ${today}, ` +
    `갱신 ${updatedCount}개 매장 / 오늘자 원본 없어 건너뜀 ${skippedNoTodayRaw}개 / ` +
    `매칭된 주문 ${totalMatchedOrders}건 / 시각없음 제외 ${totalSkippedNoTime}건 / 품목상세 없음 ${totalSkippedNoItems}건 / ` +
    `전일 마감 이월 ${totalCarryOrders}건`
  );
}

main();
