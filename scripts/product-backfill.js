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
// [2026-08-27 변경] 90일 넘는 장기간(예: 2023년부터 전체)을 한 번에 돌리면
// 전체 매장×전체날짜 데이터를 메모리에 다 쌓아뒀다가 마지막에 한 번에
// JSON.stringify + writeFileSync 하는 구조라 OOM(exit 134)으로 죽었다.
// 그래서 매장 하나가 끝날 때마다 즉시 스트림으로 파일에 써버리고 메모리에서
// 비우는 구조로 바꿨다. 또한 임시 파일(.tmp)에 다 쓴 다음 성공 시에만
// 원본 파일명으로 rename하도록 해서, 중간에 죽어도 기존 data/product-daily.json은
// 그대로 안전하게 남는다 (예전엔 실행 자체가 통째로 덮어쓰는 방식이라 위험했음).
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
const CONCURRENCY = Number(process.env.PRODUCT_BACKFILL_CONCURRENCY || 8);
const DATA_PATH = path.join(__dirname, '..', 'data', 'product-daily.json');
const TMP_PATH = `${DATA_PATH}.tmp`;
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
 * 예전처럼 전체 결과를 메모리에 다 쌓아두지 않고, 매장 하나의 모든 날짜가
 * 완료되는 즉시 writeStore(code, name, rows)를 호출해 파일에 흘려 쓰고
 * 그 매장의 메모리(storeRows/storeErrors)를 비운다. 매장별 완료 카운터
 * 증가와 완료 체크 사이에 await가 없어서(동기 실행 구간) 같은 매장을
 * 두 워커가 동시에 flush하는 레이스컨디션은 발생하지 않는다.
 */
async function runProductBackfillStreaming(token, storeMap, dates, writeStore) {
  const tasks = [];
  for (const [name, code] of storeMap) {
    for (const date of dates) tasks.push({ name, code, date });
  }

  const storeRows = {};
  const storeErrors = {};
  const storeCompleted = {};
  for (const [, code] of storeMap) {
    storeRows[code] = [];
    storeErrors[code] = [];
    storeCompleted[code] = 0;
  }

  const perStoreTotal = dates.length;
  let nextIndex = 0;
  let completed = 0;
  const total = tasks.length;

  const failedStores = [];
  const partialStores = [];
  let successCount = 0;

  async function flushStoreIfDone(code, name) {
    if (storeCompleted[code] !== perStoreTotal) return;

    const rows = storeRows[code];
    const errors = storeErrors[code];
    let entryRows;

    if (errors.length > 0 && rows.length === 0) {
      failedStores.push(`${code}(${name}): ${errors.join(' | ')}`);
      entryRows = [];
    } else {
      entryRows = toCompactRows(rows);
      if (errors.length > 0) partialStores.push(`${code}(${name}): ${errors.join(' | ')}`);
      else successCount++;
    }

    await writeStore(code, name, entryRows);

    // 파일에 이미 기록됐으니 메모리에서 비운다 — 이게 OOM 방지의 핵심
    delete storeRows[code];
    delete storeErrors[code];
  }

  async function worker() {
    while (true) {
      const myIndex = nextIndex++;
      if (myIndex >= total) return;
      const { name, code, date } = tasks[myIndex];

      const result = await fetchOneStoreOrderDetail(token, code, date);
      if (result.error) {
        storeErrors[code].push(`${date}: ${result.error}`);
      } else {
        storeRows[code].push(...aggregateOrderDetailToProducts(result.rows));
      }

      storeCompleted[code]++;
      completed++;
      if (completed % 200 === 0 || completed === total) {
        console.log(`진행: ${completed}/${total}`);
      }

      await flushStoreIfDone(code, name);
      await sleep(50); // 워커별 최소 간격 — 완전히 쉼 없이 몰아치지 않도록
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { failedStores, partialStores, successCount };
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
      `(REQ_CODE 6, 동시 실행 ${CONCURRENCY}개 — 세트구성품·취소/반품 제외, 스트리밍 저장)`
  );
  console.log(`총 작업 수: 매장 ${storeMap.length} × ${dates.length}일 = ${storeMap.length * dates.length}건`);

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  const out = fs.createWriteStream(TMP_PATH, { encoding: 'utf8' });

  function writeChunk(chunk) {
    return new Promise((resolve, reject) => {
      const ok = out.write(chunk, (err) => (err ? reject(err) : undefined));
      if (ok) resolve();
      else out.once('drain', resolve); // 백프레셔 — 버퍼 비워질 때까지 대기
    });
  }

  await writeChunk(
    `{"START":${JSON.stringify(start)},"END":${JSON.stringify(end)},` +
      `"FORMAT":${JSON.stringify(['date', 'productName', 'qty', 'amount'])},"STORES":{`
  );

  let isFirstStore = true;
  async function writeStore(code, name, rows) {
    const prefix = isFirstStore ? '' : ',';
    isFirstStore = false;
    await writeChunk(
      `${prefix}${JSON.stringify(code)}:{"name":${JSON.stringify(name)},"rows":${JSON.stringify(rows)}}`
    );
  }

  const { failedStores, partialStores, successCount } = await runProductBackfillStreaming(
    token,
    storeMap,
    dates,
    writeStore
  );

  await writeChunk(
    `},"updatedAt":${JSON.stringify(new Date().toISOString())},"lastRunType":"product-backfill"}`
  );

  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });

  // 여기까지 왔다는 건 전체 쓰기가 성공했다는 뜻 — 이제야 원본 파일 교체
  fs.renameSync(TMP_PATH, DATA_PATH);

  const sizeMB = (fs.statSync(DATA_PATH).size / 1024 / 1024).toFixed(1);
  console.log(
    `상품별 백필 완료: 완전성공 ${successCount}개 / 부분성공 ${partialStores.length}개 / ` +
      `실패 ${failedStores.length}개 / 파일크기 약 ${sizeMB}MB`
  );
  if (partialStores.length) console.log('부분 실패 매장(일부 날짜만 누락):\n' + partialStores.join('\n'));
  if (failedStores.length) console.log('완전 실패 매장:\n' + failedStores.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
