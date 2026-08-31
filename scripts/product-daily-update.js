// scripts/product-daily-update.js
// 매번(예: 2시간마다) 실행. "오늘" 하루치 상품별 판매 데이터만 다시 받아서
// 기존 data/product-daily.json에 병합합니다. (daily-update.js의 상품버전)
//
// 저장 포맷은 용량을 줄이기 위해 [날짜, 상품명, 수량, 금액] 배열로 압축 저장합니다.
//
// [2026-08-31 변경: 누적 병합 방식으로 전환]
// daily-update.js와 동일한 이유(REQ_CODE 6이 같은 요청에도 시점에 따라 일부 라인을
// 누락해서 응답하는 현상이 실측으로 확인됨)로, "이번 호출 결과로 오늘자를 통째로
// 덮어쓰기"하던 방식을 버리고, stores[code].todayRawRows에 원본 라인을 계속
// 누적 병합한 뒤 그 누적본을 기준으로 상품별 합계를 매번 다시 계산합니다.
// 라인 고유 키는 SA_NO(주문번호) + 그 응답 안에서 같은 주문 내 라인 순번을
// 조합해서 만듭니다(SC_NO 필드가 있으면 그 값을, 없으면 같은 SA_NO 그룹 내
// 등장 순서를 사용). 날짜가 바뀌면(todayRawRows.date !== today) 누적을 초기화합니다.
// ※ 주의: SC_NO가 매 응답마다 항상 같은 라인에 같은 값으로 붙는다는 보장은
// 100% 검증되지 않았습니다. 만약 나중에 상품별 수량이 실제보다 부풀거나
// 줄어드는 현상이 보이면, 이 키 구성 방식(SA_NO+SC_NO)부터 의심해보세요.
//
// [실시간 소스] "오늘"은 REQ_CODE 5(일상품정산매출, 정산 배치가 끝나야 채워짐) 대신
// REQ_CODE 6(주문내역, 상품별 건별 원본)을 조회해서 직접 합산합니다. 확정값과
// 합산값이 완전히 일치함을 검증 완료(2026-08-13, BHD055/8월12일,
// scripts/product-realtime-compare.js). 과거 날짜는 이미 정산 확정된 값이 그대로
// 저장되어 있으므로 건드리지 않습니다.

const fs = require('fs');
const path = require('path');
const {
  kstDateString,
  sleep,
  fetchOneStoreOrderDetail,
  aggregateOrderDetailToProducts,
} = require('./lib');

const DATA_PATH = path.join(__dirname, '..', 'data', 'product-daily.json');
const STORE_MAP_PATH = path.join(__dirname, '..', 'data', 'store-map.json');

function loadExisting() {
  if (!fs.existsSync(DATA_PATH)) return { STORES: {} };
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.warn('기존 data/product-daily.json 파싱 실패, 새로 시작합니다:', e.message);
    return { STORES: {} };
  }
}

function toCompactRows(rawRows) {
  // [날짜, 상품명, 수량(취소제외), 실판매금액]
  return rawRows.map((r) => [r.SDA_DT, r.CMDT_NM, r.SDC_QTY, r.SDC_AMT_TTL]);
}

// 날짜가 바뀌었으면 초기화, 같은 날이면 기존 누적값 재사용
function loadTodayRawRows_(prev, today) {
  if (prev && prev.todayRawRows && prev.todayRawRows.date === today) {
    return { date: today, byKey: { ...(prev.todayRawRows.byKey || {}) } };
  }
  return { date: today, byKey: {} };
}

// REQ_CODE 6 원본 라인 배열을 받아 SA_NO + (SC_NO 또는 같은 주문 내 등장 순서)로
// 고유 키를 만들어 todayRawRows.byKey에 병합한다.
function mergeRawRowsByKey_(todayRawRows, rows) {
  const seenPerSaNo = {}; // SC_NO가 없을 때 같은 SA_NO 안에서의 등장 순서 카운터
  for (const r of rows) {
    const saNo = String(r.SA_NO);
    let lineKey;
    if (r.SC_NO !== undefined && r.SC_NO !== null && r.SC_NO !== '') {
      lineKey = `${saNo}_${r.SC_NO}`;
    } else {
      seenPerSaNo[saNo] = (seenPerSaNo[saNo] || 0) + 1;
      lineKey = `${saNo}_idx${seenPerSaNo[saNo]}`;
    }
    todayRawRows.byKey[lineKey] = r;
  }
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const storeMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]
  const today = kstDateString(0);
  const existing = loadExisting();
  const prevStores = existing.STORES || {};

  console.log(`상품별 일일 갱신 시작(누적 병합): ${today}, 매장 ${storeMap.length}개`);

  const stores = { ...prevStores };
  const failed = [];
  let successCount = 0;
  let newLineCount = 0; // 이번 회차에서 새로 잡힌 라인 수(진단용)

  for (let i = 0; i < storeMap.length; i++) {
    const [name, code] = storeMap[i];
    const prev = stores[code] || { name, rows: [] };
    const todayRawRows = loadTodayRawRows_(prev, today);

    const result = await fetchOneStoreOrderDetail(token, code, today);

    if (result.error) {
      // 이번 회차 호출 실패 — 기존 누적값 그대로 유지, 다음 회차가 이어받게 함
      failed.push(`${code}(${name}): ${result.error}`);
      if (!stores[code]) stores[code] = { name, rows: [] };
      if (stores[code] && !stores[code].todayRawRows) stores[code].todayRawRows = todayRawRows;
    } else {
      const beforeKeys = Object.keys(todayRawRows.byKey).length;
      mergeRawRowsByKey_(todayRawRows, result.rows || []);
      newLineCount += Object.keys(todayRawRows.byKey).length - beforeKeys;

      // 오늘자 상품별 합계는 "이번 회차 결과"가 아니라 "지금까지 누적된 전체 라인"으로 계산
      const mergedRows = Object.values(todayRawRows.byKey);
      const productsToday = aggregateOrderDetailToProducts(mergedRows).filter(
        (r) => r.SDA_DT === today
      );

      const prevRows = (prev.rows || []).filter((r) => r[0] !== today);
      stores[code] = {
        name,
        rows: [...prevRows, ...toCompactRows(productsToday)],
        todayRawRows, // 다음 회차가 이어받을 수 있도록 그대로 저장
      };
      successCount++;
    }

    if (i < storeMap.length - 1) await sleep(150);
  }

  const output = {
    START: existing.START || today,
    END: today,
    FORMAT: ['date', 'productName', 'qty', 'amount'],
    STORES: stores,
    updatedAt: new Date().toISOString(),
    lastRunType: 'daily',
    lastRunFailedCount: failed.length,
  };

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output));

  console.log(
    `상품별 갱신 완료: 성공 ${successCount}개 / 실패 ${failed.length}개 / 이번 회차 신규 라인 ${newLineCount}건`
  );
  if (failed.length) console.log('실패 매장:\n' + failed.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
