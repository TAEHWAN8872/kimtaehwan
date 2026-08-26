// scripts/product-backfill.js
// 최초 1회(또는 필요시 수동으로) 상품별 판매 데이터를 새로 받아서
// data/product-daily.json을 새로 만듭니다. (backfill.js의 상품버전)
//
// [2026-08-26 변경] REQ_CODE 5(일상품정산매출)는 응답에 OPTION_GBN 필드가 없어
// 세트구성품(0원 항목)을 걸러낼 방법이 없다. 그래서 REQ_CODE 6(매출정보 주문내역,
// aggregateOrderDetailToProducts로 OPTION_GBN='S' 세트구성품 + SC_FORM='D'/'C'
// 취소/반품 제외 후 집계)으로 매장×하루 단위로 호출하도록 바꿨다. 대신 호출량이
// 크게 늘어난다(매장수 × ROLLING_DAYS번). 순차 처리 시 실행 시간이 너무 길어서
// (매장 153개×91일 기준 약 1시간 반) 워커 풀로 병렬 처리하도록 다시 바꿨다
// (CONCURRENCY, 기본 8).
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
// [2026-08-26 추가] 매장×하루를 완전 순차로 돌리면 매장수×일수(예: 153×91=13,923회)
// 호출이 한 줄로 쌓여서 실행 시간이 1시간 반 가까이 걸렸다. 매장끼리는 서로 독립적인
// 요청이라 여러 개를 동시에 처리하도록 워커 풀로 바꿔서 시간을 줄인다.
// ⚠️ tpay API의 초당 요청 제한(레이트리밋) 여부를 확인한 적이 없다 — 동시 실행 수를
// 너무 높이면 오히려 실패율이 올라갈 수 있으니, 처음엔 작게 시작해서 실패 카운트를
// 보고 조절할 것.
const CONCURRENCY = Number(process.env.PRODUCT_BACKFILL_CONCURRENCY || 8);
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
 * (매장, 날짜) 작업 목록을 CONCURRENCY개의 워커가 나눠서 병렬로 처리한다.
 * 각 워커는 공유 큐(작업 배열 + 인덱스 커서)에서 다음 작업을 하나씩 꺼내 가므로,
 * 매장별 날짜 수가 균등하지 않아도 노는 워커 없이 고르게 분배된다.
 * 결과는 매장코드별로 { rows: [...], errors: [...] }에 누적된다.
 * (JS는 싱글 스레드라 배열 push 자체는 레이스컨디션 걱정 없음 — await 지점에서만
 * 다른 워커로 제어권이 넘어간다.)
 */
async function runProductBackfill(token, storeMap, dates) {
  const tasks = [];
  for (const [name, code] of storeMap) {
    for (const date of dates) tasks.push({ name, code, date });
  }

  const storeRows = {};
  const storeErrors = {};
  for (const [, code] of storeMap) {
    storeRows[code] = [];
    storeErrors[code] = [];
  }

  let nextIndex = 0;
  let completed = 0;
  const total = tasks.length;

  async function worker() {
    while (true) {
      const myIndex = nextIndex++;
      if (myIndex >= total) return;
      const { code, date } = tasks[myIndex];

      const result = await fetchOneStoreOrderDetail(token, code, date);
      if (result.error) {
        storeErrors[code].push(`${date}: ${result.error}`);
      } else {
        storeRows[code].push(...aggregateOrderDetailToProducts(result.rows));
      }

      completed++;
      if (completed % 200 === 0 || completed === total) {
        console.log(`진행: ${completed}/${total}`);
      }
      await sleep(50); // 워커별 최소 간격 — 완전히 쉼 없이 몰아치지 않도록
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { storeRows, storeErrors };
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
      `(REQ_CODE 6, 동시 실행 ${CONCURRENCY}개 — 세트구성품·취소/반품 제외)`
  );
  console.log(`총 작업 수: 매장 ${storeMap.length} × ${dates.length}일 = ${storeMap.length * dates.length}건`);

  const { storeRows, storeErrors } = await runProductBackfill(token, storeMap, dates);

  const stores = {};
  const failed = [];
  const partial = [];

  for (const [name, code] of storeMap) {
    const rows = storeRows[code];
    const errors = storeErrors[code];

    if (errors.length > 0 && rows.length === 0) {
      failed.push(`${code}(${name}): ${errors.join(' | ')}`);
      stores[code] = { name, rows: [] };
    } else {
      stores[code] = { name, rows: toCompactRows(rows) };
      if (errors.length > 0) partial.push(`${code}(${name}): ${errors.join(' | ')}`);
    }
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
