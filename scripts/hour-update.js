// scripts/hour-update.js
// 매번(예: 2시간마다, daily-update.js/product-daily-update.js와 같은 스케줄) 실행되는
// 스크립트. "오늘" 하루치 시간대별(1시간 단위) 상품 판매 데이터를 다시 받아서
// 월별 파일 data/hour/hour-YYYYMM.json에 병합합니다.
//
// [왜 별도 스크립트인가]
// 시간대별 매출은 REQ_CODE 3(매출정보 마스터, 주문에 SA_DT=시각 포함)과
// REQ_CODE 6(주문내역, 상품별 라인)을 SA_NO로 조인해야 나옵니다. 이미
// daily-update.js/product-daily-update.js도 각자 REQ_CODE 3·6을 따로 호출하고
// 있어서(스크립트별 독립 상태를 유지하는 이 프로젝트의 기존 패턴), 이 스크립트도
// 같은 방식으로 독립적으로 호출·누적합니다.
//
// [중요한 한계] REQ_CODE 3/6은 스펙상 "하루치만" 조회되고, 정산 확정 리포트
// (REQ_CODE 4/5)에는애초에 시간 정보가 없습니다. 즉 이 스크립트가 실행되기
// 시작한 시점부터의 데이터만 쌓이고, 과거 날짜는 백필이 불가능합니다.
//
// [누적 병합 방식] daily-update.js/product-daily-update.js와 동일한 이유(REQ_CODE
// 3/6이 같은 요청에도 시점에 따라 일부를 누락해서 응답하는 현상이 실측 확인됨)로,
// stores[code].todayRaw에 "오늘" 하루 동안 받은 주문(ordersByNo, SA_NO 키)과
// 품목 라인(itemLinesByKey, SA_NO+SC_NO 키)을 계속 누적한 뒤, 매 회차 그 누적본
// 전체를 기준으로 시간대별 상품 집계를 다시 계산합니다. 날짜가 바뀌면
// (todayRaw.date !== today) 누적을 초기화합니다.
//
// [저장 포맷] 용량 절약을 위해 상품명은 월별 파일 전체가 공유하는 PRODUCTS
// 배열의 인덱스로 저장합니다. 매장별 rows는 [일(1~31), 시(0~23), 상품인덱스,
// 수량, 금액] 압축 배열입니다.

const fs = require('fs');
const path = require('path');
const {
  kstDateString,
  sleep,
  fetchOneStoreRealtimeWithOrders,
  fetchOneStoreOrderDetail,
  aggregateOrdersAndItemsToHourProducts,
} = require('./lib');

const HOUR_DIR = path.join(__dirname, '..', 'data', 'hour');
const STORE_MAP_PATH = path.join(__dirname, '..', 'data', 'store-map.json');

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

// 날짜가 바뀌었으면 초기화, 같은 날이면 기존 누적값 재사용
function loadTodayRaw_(prev, today) {
  if (prev && prev.todayRaw && prev.todayRaw.date === today) {
    return {
      date: today,
      ordersByNo: { ...(prev.todayRaw.ordersByNo || {}) },
      itemLinesByKey: { ...(prev.todayRaw.itemLinesByKey || {}) },
    };
  }
  return { date: today, ordersByNo: {}, itemLinesByKey: {} };
}

// REQ_CODE 6 원본 라인 배열을 SA_NO + (SC_NO 또는 같은 주문 내 등장 순서)로
// 고유 키를 만들어 todayRaw.itemLinesByKey에 병합한다.
// (product-daily-update.js의 mergeRawRowsByKey_와 동일한 키 구성 방식)
function mergeItemLines_(todayRaw, rows) {
  const seenPerSaNo = {};
  for (const r of rows) {
    const saNo = String(r.SA_NO);
    let lineKey;
    if (r.SC_NO !== undefined && r.SC_NO !== null && r.SC_NO !== '') {
      lineKey = `${saNo}_${r.SC_NO}`;
    } else {
      seenPerSaNo[saNo] = (seenPerSaNo[saNo] || 0) + 1;
      lineKey = `${saNo}_idx${seenPerSaNo[saNo]}`;
    }
    todayRaw.itemLinesByKey[lineKey] = r;
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

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const storeMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]
  const today = kstDateString(0);
  const ym = today.slice(0, 6);
  const todayDay = Number(today.slice(6, 8));

  const existing = loadExistingMonth_(ym);
  const products = existing.PRODUCTS.slice();
  const productIndexMap = {};
  products.forEach((name, i) => { productIndexMap[name] = i; });

  const prevStores = existing.STORES || {};
  const stores = { ...prevStores };

  console.log(`시간대별 매출 갱신 시작(누적 병합): ${today}, 매장 ${storeMap.length}개`);

  const failed = [];
  let successCount = 0;
  let totalMatchedOrders = 0, totalSkippedNoTime = 0, totalSkippedNoItems = 0;

  for (let i = 0; i < storeMap.length; i++) {
    const [name, code] = storeMap[i];
    const prev = stores[code] || { name, rows: [] };
    const todayRaw = loadTodayRaw_(prev, today);

    const orderResult = await fetchOneStoreRealtimeWithOrders(token, code, today);

    if (orderResult.error) {
      failed.push(`${code}(${name}) 주문조회: ${orderResult.error}`);
      if (!stores[code]) stores[code] = { name, rows: [] };
      if (stores[code] && !stores[code].todayRaw) stores[code].todayRaw = todayRaw;
      if (i < storeMap.length - 1) await sleep(150);
      continue;
    }

    // 이번 회차 주문을 SA_NO 기준으로 누적 병합 (시간/영업일 계산에 필요한 필드만 저장)
    for (const o of orderResult.orders) {
      todayRaw.ordersByNo[String(o.SA_NO)] = { SA_NO: o.SA_NO, SA_DT: o.SA_DT, SDA_DT: o.SDA_DT };
    }

    // 주문이 있는 매장만 품목 상세(REQ_CODE 6) 조회 (불필요한 API 호출 절약)
    if (orderResult.orders.length > 0) {
      const detail = await fetchOneStoreOrderDetail(token, code, today);
      if (detail.error) {
        failed.push(`${code}(${name}) 품목조회: ${detail.error}`);
        // 품목상세만 실패 — 이전 회차에 캐시된 라인 그대로 사용
      } else {
        mergeItemLines_(todayRaw, detail.rows || []);
      }
    }

    // 지금까지 누적된 전체(주문+품목)로 오늘자 시간대별 상품 집계를 다시 계산
    const mergedOrders = Object.values(todayRaw.ordersByNo);
    const mergedItemRows = Object.values(todayRaw.itemLinesByKey);
    const { rows: hourRows, matchedOrders, skippedNoTime, skippedNoItems } =
      aggregateOrdersAndItemsToHourProducts(mergedOrders, mergedItemRows);
    totalMatchedOrders += matchedOrders;
    totalSkippedNoTime += skippedNoTime;
    totalSkippedNoItems += skippedNoItems;

    const todayCompactRows = hourRows
      .filter((r) => r.SDA_DT === today)
      .map((r) => [todayDay, r.hour, productIndex_(products, productIndexMap, r.CMDT_NM), r.qty, r.amount]);

    const prevRows = (prev.rows || []).filter((r) => r[0] !== todayDay);
    stores[code] = {
      name,
      rows: [...prevRows, ...todayCompactRows],
      todayRaw,
    };
    successCount++;

    if (i < storeMap.length - 1) await sleep(150);
  }

  const output = {
    YM: ym,
    PRODUCTS: products,
    STORES: stores,
    updatedAt: new Date().toISOString(),
    lastRunType: 'daily',
    lastRunFailedCount: failed.length,
  };

  fs.mkdirSync(HOUR_DIR, { recursive: true });
  fs.writeFileSync(hourPath_(ym), JSON.stringify(output));

  console.log(
    `시간대별 갱신 완료: 성공 ${successCount}개 / 실패 ${failed.length}개 / ` +
    `매칭된 주문 ${totalMatchedOrders}건 / 시각없음 제외 ${totalSkippedNoTime}건 / 품목상세 대기중 ${totalSkippedNoItems}건`
  );
  if (failed.length) console.log('실패 내역:\n' + failed.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
