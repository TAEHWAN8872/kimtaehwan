// scripts/product-backfill.js
// 최초 1회(또는 필요시 수동으로) 상품별 판매 데이터를 새로 받아서
// data/product-daily.json을 새로 만듭니다. (backfill.js의 상품버전)
//
// [2026-08-26 변경] REQ_CODE 5(일상품정산매출)는 응답에 OPTION_GBN 필드가 없어
// 세트구성품(0원 항목)을 걸러낼 방법이 없다. 그래서 REQ_CODE 6(매출정보 주문내역,
// aggregateOrderDetailToProducts로 OPTION_GBN='S' 제외 후 집계)으로 매장×하루
// 단위로 호출하도록 바꿨다. 대신 호출량이 크게 늘어난다(매장수 × ROLLING_DAYS번).
//
// 상품 단위라 데이터량이 커서, 기본 90일로 제한합니다.
//
// 사용법(Actions): workflow_dispatch 로 tpay-sync.yml의 mode=product-backfill 실행

const fs = require('fs');
const path = require('path');
const {
  kstDateString,
  addDaysYmd,
  sleep,
  fetchOneStoreOrderDetail,
  aggregateOrderDetailToProducts,
} = require('./lib');

const ROLLING_DAYS = Number(process.env.PRODUCT_ROLLING_DAYS || 90);
const DATA_PATH = path.join(__dirname, '..', 'data', 'product-daily.json');
const STORE_MAP_PATH = path.join(__dirname, '..', 'data', 'store-map.json');

function toCompactRows(aggregatedRows) {
  return aggregatedRows.map((r) => [r.SDA_DT, r.CMDT_NM, r.SDC_QTY, r.SDC_AMT_TTL]);
}

/** start ~ end(포함) 사이의 yyyyMMdd 문자열 배열 */
function listDates(start, end) {
  const dates = [];
  let cursor = start;
  while (true) {
    dates.push(cursor);
    if (cursor === end) break;
    cursor = addDaysYmd(cursor, 1);
  }
  return dates;
}

/**
 * 매장 1개, 날짜 여러 개를 REQ_CODE 6으로 하루씩 조회해서 합친다.
 * 반환: { rows: [...압축 전 집계 rows...] } 또는
 *       { rows: [...부분 성공분...], partialError: '...' } 또는
 *       { error: '...' } (전부 실패)
 */
async function fetchStoreProductsDayByDay(token, code, dates) {
  let allRows = [];
  const errors = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const result = await fetchOneStoreOrderDetail(token, code, date);
    if (result.error) {
      errors.push(`${date}: ${result.error}`);
    } else {
      allRows = allRows.concat(aggregateOrderDetailToProducts(result.rows));
    }
    if (i < dates.length - 1) await sleep(150);
  }

  if (errors.length > 0) {
    if (allRows.length === 0) return { error: errors.join(' | ') };
    return { rows: allRows, partialError: errors.join(' | ') };
  }
  return { rows: allRows };
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const storeMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]

  const end = kstDateString(0);
  const start = kstDateString(-ROLLING_DAYS);
  const dates = listDates(start, end);

  console.log(
    `상품별 백필 시작: ${start} ~ ${end} (${dates.length}일), 매장 ${storeMap.length}개 ` +
      `(REQ_CODE 6, 매장당 하루 단위 ${dates.length}회 호출 — 세트구성품 제외)`
  );
  console.log(`총 예상 호출 수: 매장 ${storeMap.length} × ${dates.length}일 = ${storeMap.length * dates.length}회`);

  const stores = {};
  const failed = [];
  const partial = [];

  for (let i = 0; i < storeMap.length; i++) {
    const [name, code] = storeMap[i];
    const result = await fetchStoreProductsDayByDay(token, code, dates);

    if (result.error) {
      failed.push(`${code}(${name}): ${result.error}`);
      stores[code] = { name, rows: [] };
    } else {
      stores[code] = { name, rows: toCompactRows(result.rows) };
      if (result.partialError) partial.push(`${code}(${name}): ${result.partialError}`);
    }

    console.log(`진행: ${i + 1}/${storeMap.length} (${name})`);
    if (i < storeMap.length - 1) await sleep(150);
  }

  const output = {
    START: start,
    END: end,
    FORMAT: ['date', 'productName', 'qty', 'amount'],
    STORES: stores,
    updatedAt: new Date().toISOString(),
    lastRunType: 'product-backfill',
  };

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output));

  const sizeMB = (Buffer.byteLength(JSON.stringify(output)) / 1024 / 1024).toFixed(1);
  console.log(
    `상품별 백필 완료: 완전성공 ${storeMap.length - failed.length - partial.length}개 / ` +
      `부분성공 ${partial.length}개 / 실패 ${failed.length}개 / 파일크기 약 ${sizeMB}MB`
  );
  if (partial.length) console.log('부분 실패 매장(일부 날짜만 누락):\n' + partial.join('\n'));
  if (failed.length) console.log('완전 실패 매장:\n' + failed.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
