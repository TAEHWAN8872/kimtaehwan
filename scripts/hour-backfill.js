// scripts/hour-backfill.js
// 과거 날짜의 시간대별(1시간 단위) 상품 판매 데이터를 채우는 수동 실행 전용
// 스크립트. hour-update.js(오늘자, data/live-daily.json 재사용)와 달리 이
// 스크립트는 직접 REQ_CODE 3(주문)·REQ_CODE 6(품목상세)을 지정한 기간 전체에
// 대해 하루씩 호출한다 — 과거 날짜는 daily-update.js의 todayRaw에 남아있지
// 않기 때문에 재사용이 불가능하다.
//
// [사전 검증 완료] compare/product-compare 모드로 BHD055(검단신도시점)
// 2026-06-18·2026-01-01·2025(1년 전)와 BHD005(김천점) 2023-03-14를 확인,
// REQ_CODE 3·6 원본이 그 시점까지도 확정 정산값과 정확히 일치함을 확인했다
// (2026-09-17). 즉 2023년 이후 날짜는 원본이 살아있다고 보고 백필을 진행한다.
//
// [2026-09-17 추가: 이상 응답 재시도] 첫 버전으로 2026-01-01~09-15를 실제
// 돌려보니, 154개 매장 전체가 통째로 0건으로 나오는 날이 열흘~20일씩 연속으로
// 나타나는 현상이 확인됐다(154개 매장짜리 체인이 실제로 그렇게 길게 완전
// 무매출일 수는 없음 — daily-update.js/product-daily-update.js에서 이미
// 겪은 "짧은 시간에 같은 요청을 반복하면 통째로 빈 응답을 준다"는 문제와
// 같은 종류로 보인다). 또한 매칭은 됐지만 품목상세(REQ_CODE 6)만 유독 많이
// 빠지는 날도 있었다(예: 2026-01-16, 매칭 2225건인데 품목없음 3749건 — 실패가
// 성공보다 많음). 그래서 이번 버전은:
//   1) 하루 전체(154개 매장 전부)의 REQ_CODE 3 원본 주문 합계가 0건이면
//      "이상 신호"로 보고, 잠시 쉬었다가 그 날짜 전체를 다시 조회한다
//      (최대 HOUR_BACKFILL_ZERO_DAY_MAX_RETRIES회, 기본 2회).
//   2) 매장별로 주문은 있는데 품목상세(REQ_CODE 6)가 완전히 빈 배열로
//      돌아오면, 그 매장의 품목조회만 짧게 쉬었다가 최대 2번 더 재시도한다.
// 그래도 계속 0건이면 실제 휴무일 가능성이 있는 것으로 보고 넘어가되,
// 마지막 요약에 "재시도해도 계속 0건이었던 날짜" 목록을 따로 출력한다 —
// 이 목록에 낀 날짜는 나중에 STORE_CODES 없이 그 날짜만 다시 돌려보는 걸
// 권장한다.
//
// [사용법] GitHub Actions에서 mode=hour-backfill로 수동 실행.
//   HOUR_BACKFILL_START / HOUR_BACKFILL_END (yyyymmdd, 둘 다 포함, 기간이
//   여러 달에 걸쳐도 됨 — 달이 바뀔 때마다 알아서 파일을 나눠 저장한다)
//   HOUR_BACKFILL_STORE_CODES (선택, 콤마구분. 비우면 전체 매장)
//   HOUR_BACKFILL_ZERO_DAY_MAX_RETRIES (선택, 기본 2)
//   HOUR_BACKFILL_ZERO_DAY_RETRY_DELAY_MS (선택, 기본 15000 = 15초)
//
// [진행 방식] 날짜를 하루씩 순회하면서, 그 날짜의 매장별 REQ_CODE 3·6을
// 조회해서 SA_NO로 조인 → 시간대별 상품 집계 → 월별 파일의 해당 일(day)
// 항목만 교체. 달이 바뀌는 시점에 그 전 달 파일을 디스크에 저장하고 다음 달
// 파일을 새로 연다(6시간 잡 제한 중간에 끊겨도 이미 끝난 달은 남아있음 —
// 다음 실행 때 START를 이어서 넣으면 됨). 과거 확정 데이터라 daily-update.js
// 같은 "누적 병합"은 필요 없다 — 하루치를 한 번만 조회해서 그대로 쓴다.

const fs = require('fs');
const path = require('path');
const {
  sleep,
  fetchOneStoreRealtimeWithOrders,
  fetchOneStoreOrderDetail,
  aggregateOrdersAndItemsToHourProducts,
} = require('./lib');

const HOUR_DIR = path.join(__dirname, '..', 'data', 'hour');
const STORE_MAP_PATH = path.join(__dirname, '..', 'data', 'store-map.json');

const ZERO_DAY_MAX_RETRIES = Number(process.env.HOUR_BACKFILL_ZERO_DAY_MAX_RETRIES || 2);
const ZERO_DAY_RETRY_DELAY_MS = Number(process.env.HOUR_BACKFILL_ZERO_DAY_RETRY_DELAY_MS || 15000);
const ITEM_EMPTY_MAX_RETRIES = 2; // 품목상세가 완전히 빈 배열로 오면 매장 단위로 짧게 재시도
const ITEM_EMPTY_RETRY_DELAY_MS = 800;

function hourPath_(ym) {
  return path.join(HOUR_DIR, `hour-${ym}.json`);
}

function loadMonth_(ym) {
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

function saveMonth_(monthData) {
  fs.mkdirSync(HOUR_DIR, { recursive: true });
  monthData.updatedAt = new Date().toISOString();
  fs.writeFileSync(hourPath_(monthData.YM), JSON.stringify(monthData));
  console.log(`  💾 ${monthData.YM} 저장 완료 (매장 ${Object.keys(monthData.STORES).length}개)`);
}

function productIndex_(productsArr, indexMap, name) {
  if (indexMap[name] !== undefined) return indexMap[name];
  const idx = productsArr.length;
  productsArr.push(name);
  indexMap[name] = idx;
  return idx;
}

function nextDate_(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// REQ_CODE 6이 완전히 빈 배열로 돌아오면(네트워크 에러는 아니지만 품목이 하나도
// 없는 응답) 실제로 품목이 없어서인지, 짧은 시간 반복 호출로 인한 일시적 빈
// 응답인지 구분할 수 없으므로, 짧게 쉬었다가 최대 몇 번 더 시도해서 하나라도
// 잡히면 그걸 쓴다.
async function fetchOrderDetailWithRetry_(token, code, date) {
  let last = { rows: [] };
  for (let attempt = 0; attempt <= ITEM_EMPTY_MAX_RETRIES; attempt++) {
    const detail = await fetchOneStoreOrderDetail(token, code, date);
    if (detail.error) {
      last = detail;
      if (attempt < ITEM_EMPTY_MAX_RETRIES) await sleep(ITEM_EMPTY_RETRY_DELAY_MS);
      continue;
    }
    if ((detail.rows || []).length > 0) return detail; // 하나라도 잡히면 바로 사용
    last = detail;
    if (attempt < ITEM_EMPTY_MAX_RETRIES) await sleep(ITEM_EMPTY_RETRY_DELAY_MS);
  }
  return last;
}

// 지정한 하루치를 전 매장에 대해 한 번 조회한다. 월별 파일에 바로 쓰지 않고
// 결과만 반환한다 — 이상 신호(전체 0건)가 감지되면 이 결과를 버리고 다시
// 호출할 수 있도록 하기 위함.
async function processDateOnce_(token, date, storeMap) {
  const perStore = {}; // code -> { name, hourRows }
  let rawOrders = 0, matched = 0, skippedNoTime = 0, skippedNoItems = 0, carry = 0, itemRetries = 0;
  const dateFailed = [];

  for (let i = 0; i < storeMap.length; i++) {
    const [name, code] = storeMap[i];

    const orderResult = await fetchOneStoreRealtimeWithOrders(token, code, date);
    if (orderResult.error) {
      dateFailed.push(`${date} ${code}(${name}) 주문조회: ${orderResult.error}`);
      if (i < storeMap.length - 1) await sleep(150);
      continue;
    }
    rawOrders += orderResult.orders.length;

    let hourRows = [];
    if (orderResult.orders.length > 0) {
      const detail = await fetchOrderDetailWithRetry_(token, code, date);
      if (detail.error) {
        dateFailed.push(`${date} ${code}(${name}) 품목조회: ${detail.error}`);
      } else {
        if ((detail.rows || []).length === 0) itemRetries++; // 재시도해도 끝내 빈 경우 카운트(진단용)
        const { rows, matchedOrders, skippedNoTime: sn, skippedNoItems: si, carryOrders } =
          aggregateOrdersAndItemsToHourProducts(orderResult.orders, detail.rows || []);
        hourRows = rows;
        matched += matchedOrders;
        skippedNoTime += sn;
        skippedNoItems += si;
        carry += carryOrders;
      }
    }
    perStore[code] = { name, hourRows };

    if (i < storeMap.length - 1) await sleep(150);
  }

  return { perStore, rawOrders, matched, skippedNoTime, skippedNoItems, carry, dateFailed, itemRetries };
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const START = process.env.HOUR_BACKFILL_START;
  const END = process.env.HOUR_BACKFILL_END;
  if (!START || !END) throw new Error('HOUR_BACKFILL_START / HOUR_BACKFILL_END(yyyymmdd)가 필요합니다.');
  if (START > END) throw new Error('시작일이 종료일보다 늦을 수 없습니다.');

  const codeFilter = (process.env.HOUR_BACKFILL_STORE_CODES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const allStoreMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]
  const storeMap = codeFilter.length
    ? allStoreMap.filter(([, code]) => codeFilter.includes(code))
    : allStoreMap;

  console.log(
    `시간대별 매출 백필 시작: ${START} ~ ${END}, 매장 ${storeMap.length}개${codeFilter.length ? ' (지정 매장만)' : ''} ` +
    `(0건 전체 재시도 최대 ${ZERO_DAY_MAX_RETRIES}회, ${ZERO_DAY_RETRY_DELAY_MS / 1000}초 간격)`
  );

  let currentYm = null;
  let monthData = null;
  let products = null;
  let productIndexMap = null;

  let totalDays = 0;
  let totalFailed = [];
  let totalMatchedOrders = 0, totalSkippedNoTime = 0, totalSkippedNoItems = 0, totalCarryOrders = 0, totalRawOrders = 0;
  const stillZeroDates = []; // 재시도해도 끝내 0건이었던 날짜(진짜 휴무 or API 문제 — 나중에 수동 확인 권장)

  for (let date = START; date <= END; date = nextDate_(date)) {
    const ym = date.slice(0, 6);
    const day = Number(date.slice(6, 8));

    if (ym !== currentYm) {
      if (monthData) saveMonth_(monthData); // 달이 바뀌기 전에 이전 달 저장
      currentYm = ym;
      monthData = loadMonth_(ym);
      products = monthData.PRODUCTS;
      productIndexMap = {};
      products.forEach((name, i) => { productIndexMap[name] = i; });
    }

    let result = await processDateOnce_(token, date, storeMap);
    let retries = 0;
    while (result.rawOrders === 0 && retries < ZERO_DAY_MAX_RETRIES) {
      retries++;
      console.log(
        `  ⚠️ ${date} 전체 매장(${storeMap.length}개) 원본 주문 0건 — 이상 신호로 보고 ` +
        `${ZERO_DAY_RETRY_DELAY_MS / 1000}초 후 재시도 (${retries}/${ZERO_DAY_MAX_RETRIES})`
      );
      await sleep(ZERO_DAY_RETRY_DELAY_MS);
      result = await processDateOnce_(token, date, storeMap);
    }
    if (result.rawOrders === 0 && retries > 0) {
      console.log(`  ⚠️ ${date}는 재시도해도 계속 0건입니다 — 실제 휴무이거나 API 문제일 수 있어요. 나중에 따로 확인해보세요.`);
      stillZeroDates.push(date);
    }

    // 이번 날짜 결과를 월별 파일에 반영 (fetch 자체가 실패한 매장은 건드리지 않고 기존 값 유지)
    for (const [code, { name, hourRows }] of Object.entries(result.perStore)) {
      const compactRows = hourRows
        .filter((r) => r.SDA_DT === date)
        .map((r) => [day, r.hour, productIndex_(products, productIndexMap, r.CMDT_NM), r.qty, r.amount]);
      const prev = monthData.STORES[code] || { name, rows: [] };
      const prevRows = (prev.rows || []).filter((r) => r[0] !== day);
      monthData.STORES[code] = { name, rows: [...prevRows, ...compactRows] };
    }

    totalRawOrders += result.rawOrders;
    totalMatchedOrders += result.matched;
    totalSkippedNoTime += result.skippedNoTime;
    totalSkippedNoItems += result.skippedNoItems;
    totalCarryOrders += result.carry;
    totalFailed.push(...result.dateFailed);
    totalDays++;

    const itemFailRate = result.rawOrders > 0 ? Math.round((result.skippedNoItems / result.rawOrders) * 100) : 0;
    console.log(
      `${date} 완료 — 원본주문 ${result.rawOrders}건 / 매칭 ${result.matched}건 / 시각없음 ${result.skippedNoTime}건 / ` +
      `품목없음 ${result.skippedNoItems}건(${itemFailRate}%) / 전일이월 ${result.carry}건 / 실패 ${result.dateFailed.length}건` +
      (retries > 0 ? ` [재시도 ${retries}회]` : '')
    );
  }

  if (monthData) saveMonth_(monthData); // 마지막 달 저장

  console.log(
    `\n백필 완료: ${START} ~ ${END} (${totalDays}일) / ` +
    `원본주문 총 ${totalRawOrders}건 / 매칭 총 ${totalMatchedOrders}건 / 시각없음 총 ${totalSkippedNoTime}건 / ` +
    `품목없음 총 ${totalSkippedNoItems}건 / 전일이월 총 ${totalCarryOrders}건 / 실패 총 ${totalFailed.length}건`
  );
  if (stillZeroDates.length) {
    console.log(
      `\n⚠️ 재시도해도 끝내 0건이었던 날짜 ${stillZeroDates.length}개 (실제 휴무 또는 API 문제 가능성 — 수동 확인 권장):\n` +
      stillZeroDates.join(', ')
    );
  }
  if (totalFailed.length) {
    console.log('\n실패 내역(최대 30개):\n' + totalFailed.slice(0, 30).join('\n'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
