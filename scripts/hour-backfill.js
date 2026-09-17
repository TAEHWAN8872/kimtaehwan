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
// [사용법] GitHub Actions에서 mode=hour-backfill로 수동 실행.
//   HOUR_BACKFILL_START / HOUR_BACKFILL_END (yyyymmdd, 둘 다 포함, 기간이
//   여러 달에 걸쳐도 됨 — 달이 바뀔 때마다 알아서 파일을 나눠 저장한다)
//   HOUR_BACKFILL_STORE_CODES (선택, 콤마구분. 비우면 전체 매장)
//
// [진행 방식] 날짜를 하루씩 순회하면서, 그 날짜의 매장별 REQ_CODE 3·6을
// 조회해서 SA_NO로 조인 → 시간대별 상품 집계 → 월별 파일의 해당 일(day)
// 항목만 교체. 달이 바뀌는 시점에 그 전 달 파일을 디스크에 저장하고 다음 달
// 파일을 새로 연다(6시간 잡 제한 중간에 끊겨도 이미 끝난 달은 남아있음 —
// 다음 실행 때 START를 이어서 넣으면 됨). 과거 확정 데이터라 daily-update.js
// 같은 "누적 병합"은 필요 없다 — 하루치를 한 번만 조회해서 그대로 쓴다
// (실패하면 재시도 3회 후 그 매장/그날은 건너뛰고 로그에 남긴다).

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

  console.log(`시간대별 매출 백필 시작: ${START} ~ ${END}, 매장 ${storeMap.length}개${codeFilter.length ? ' (지정 매장만)' : ''}`);

  let currentYm = null;
  let monthData = null;
  let products = null;
  let productIndexMap = null;

  let totalDays = 0;
  let totalFailed = [];
  let totalMatchedOrders = 0, totalSkippedNoTime = 0, totalSkippedNoItems = 0, totalCarryOrders = 0;

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

    let dateMatched = 0, dateSkippedNoTime = 0, dateSkippedNoItems = 0, dateCarry = 0, dateFailed = 0;

    for (let i = 0; i < storeMap.length; i++) {
      const [name, code] = storeMap[i];

      const orderResult = await fetchOneStoreRealtimeWithOrders(token, code, date);
      if (orderResult.error) {
        dateFailed++;
        totalFailed.push(`${date} ${code}(${name}) 주문조회: ${orderResult.error}`);
        if (i < storeMap.length - 1) await sleep(150);
        continue;
      }

      let hourRows = [];
      if (orderResult.orders.length > 0) {
        const detail = await fetchOneStoreOrderDetail(token, code, date);
        if (detail.error) {
          dateFailed++;
          totalFailed.push(`${date} ${code}(${name}) 품목조회: ${detail.error}`);
        } else {
          const { rows, matchedOrders, skippedNoTime, skippedNoItems, carryOrders } =
            aggregateOrdersAndItemsToHourProducts(orderResult.orders, detail.rows || []);
          hourRows = rows;
          dateMatched += matchedOrders;
          dateSkippedNoTime += skippedNoTime;
          dateSkippedNoItems += skippedNoItems;
          dateCarry += carryOrders;
        }
      }

      const compactRows = hourRows
        .filter((r) => r.SDA_DT === date)
        .map((r) => [day, r.hour, productIndex_(products, productIndexMap, r.CMDT_NM), r.qty, r.amount]);

      const prev = monthData.STORES[code] || { name, rows: [] };
      const prevRows = (prev.rows || []).filter((r) => r[0] !== day);
      monthData.STORES[code] = { name, rows: [...prevRows, ...compactRows] };

      if (i < storeMap.length - 1) await sleep(150);
    }

    totalMatchedOrders += dateMatched;
    totalSkippedNoTime += dateSkippedNoTime;
    totalSkippedNoItems += dateSkippedNoItems;
    totalCarryOrders += dateCarry;
    totalDays++;
    console.log(
      `${date} 완료 — 매칭된 주문 ${dateMatched}건 / 시각없음 ${dateSkippedNoTime}건 / ` +
      `품목없음 ${dateSkippedNoItems}건 / 전일이월 ${dateCarry}건 / 실패 ${dateFailed}건`
    );
  }

  if (monthData) saveMonth_(monthData); // 마지막 달 저장

  console.log(
    `\n백필 완료: ${START} ~ ${END} (${totalDays}일) / ` +
    `매칭된 주문 총 ${totalMatchedOrders}건 / 시각없음 총 ${totalSkippedNoTime}건 / ` +
    `품목없음 총 ${totalSkippedNoItems}건 / 전일이월 총 ${totalCarryOrders}건 / 실패 총 ${totalFailed.length}건`
  );
  if (totalFailed.length) {
    console.log('실패 내역(최대 30개):\n' + totalFailed.slice(0, 30).join('\n'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
