// scripts/product-patch.js
// 특정 매장의 특정 날짜 구간만 REQ_CODE 6으로 재조회해서 기존
// data/product-daily.json에 "병합"한다. product-backfill.js와 달리 지정한
// 매장/구간 외의 기존 데이터는 절대 건드리지 않는다 (product-backfill.js는
// 파일 전체를 새로 쓰기 때문에, 특정 매장 며칠치만 비어있는 걸 고치려고
// 돌리기엔 너무 무겁고 다른 매장까지 다시 받는 위험도 있음).
//
// (patch-missing-days.js의 상품 버전 — 같은 목적, 같은 사용법)
//
// 사용법(로컬):
//   TPAY_TOKEN=xxx STORE_CODES=BHD097 START=20260808 END=20260809 node scripts/product-patch.js
//
// 사용법(Actions):
//   tpay-sync.yml에 워크플로우 입력(patch_store_codes, patch_start, patch_end)을
//   재사용해서 mode=product-patch 스텝을 추가해 workflow_dispatch로 수동 실행.
//
// 날짜가 떨어져 있어도(예: 8/8,8/9 + 8/16 + 8/23 + 8/29,8/30) 한 번에 넣을 수
// 있도록 START~END 구간을 통으로 재조회한다 — REQ_CODE 6은 하루치씩만
// 조회되므로(fetchOneStoreOrderDetail), 구간 안의 모든 날짜를 순회해서
// 개별 호출한 뒤 합친다. 이미 데이터가 있던 날짜도 같이 재조회되지만, 그
// 날짜의 기존 값은 새로 받은 값으로 그대로 교체되므로 결과에 문제는 없다.

const fs = require('fs');
const path = require('path');
const {
  addDaysYmd,
  sleep,
  fetchOneStoreOrderDetail,
  aggregateOrderDetailToProducts,
} = require('./lib');

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

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const codesArg = (process.env.STORE_CODES || '').trim();
  const start = process.env.START;
  const end = process.env.END;
  if (!start || !end) throw new Error('START, END 환경변수가 필요합니다 (yyyymmdd 형식).');
  if (!codesArg) throw new Error('STORE_CODES 환경변수가 필요합니다 (콤마로 구분, 예: BHD097,BHD055). 전체 매장 대상 실행은 지원하지 않음 — 안전을 위해 명시적으로 지정할 것.');

  const storeMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]
  const nameByCode = Object.fromEntries(storeMap.map(([name, code]) => [code, name]));

  const codes = codesArg.split(',').map((s) => s.trim()).filter(Boolean);
  const dates = listDates(start, end);

  const existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const stores = existing.STORES || {};

  console.log(`상품별 패치 시작: ${start} ~ ${end} (${dates.length}일), 대상 매장 ${codes.length}개`);
  console.log(codes.join(', '));

  const failed = [];
  const fixed = [];

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const name = nameByCode[code] || (stores[code] && stores[code].name) || code;

    let newRows = [];
    const dayErrors = [];
    for (const date of dates) {
      const result = await fetchOneStoreOrderDetail(token, code, date);
      if (result.error) {
        dayErrors.push(`${date}: ${result.error}`);
      } else {
        newRows.push(...aggregateOrderDetailToProducts(result.rows));
      }
      await sleep(150);
    }

    const prev = stores[code] || { name, rows: [] };
    const compactNew = toCompactRows(newRows);

    // [안전장치] API 호출은 전부 에러 없이 "성공"했는데(dayErrors=0) 정작 상품 행이
    // 하나도 안 나온 경우, 정상적으로 매출이 0인 날짜들이었을 수도 있지만 토큰 만료/
    // 권한 문제 등으로 API가 조용히 빈 응답(RESPONSE_CODE 0000 + 빈 배열)을 준 것일
    // 수도 있다. 이 상태로 그대로 병합하면 기존에 있던 정상 데이터까지 빈 값으로
    // 덮어써버리는 사고가 나므로(2026-09-04 BHD097 8월 데이터 유실 사고 실제 발생),
    // 기존 구간 안에 이미 데이터가 있었는데 새로 받은 게 0행이면 병합을 건너뛰고
    // 경고만 남긴다. 정말로 매출이 0인 신규 매장/구간이라면(기존 데이터 자체가 없었음)
    // 정상 진행한다.
    const existingInRange = (prev.rows || []).filter((r) => r[0] >= start && r[0] <= end);
    if (dayErrors.length === 0 && compactNew.length === 0 && existingInRange.length > 0) {
      failed.push(
        `${code}(${name}) 의심스러운 결과: API 호출은 전부 성공했지만 상품 행이 0개 ` +
        `(기존에 이 구간 데이터 ${existingInRange.length}행 있었음) — 토큰 만료 등 API 응답 ` +
        `이상 가능성이 있어 병합을 건너뜀. 기존 데이터는 그대로 유지됨.`
      );
      console.log(`[건너뜀-의심] ${code}(${name}): 0행이지만 기존 ${existingInRange.length}행 보존, 병합 안 함`);
      if (i < codes.length - 1) await sleep(150);
      continue;
    }

    // 지정한 구간에 해당하는 기존 행만 제거하고, 새로 받은 값으로 교체.
    // 구간 밖의 기존 데이터(과거 전체 이력)는 그대로 유지된다.
    const keptRows = (prev.rows || []).filter((r) => r[0] < start || r[0] > end);
    stores[code] = { name: prev.name || name, rows: [...keptRows, ...compactNew] };

    if (dayErrors.length > 0) {
      failed.push(`${code}(${name}) 일부 날짜 실패: ${dayErrors.join(' | ')}`);
      console.log(`[부분성공] ${code}(${name}): ${dayErrors.join(' | ')}`);
    } else {
      fixed.push(`${code}(${name})`);
      console.log(`[성공] ${code}(${name}): ${compactNew.length}행`);
    }

    if (i < codes.length - 1) await sleep(150);
  }

  const output = {
    ...existing,
    STORES: stores,
    // START/END(전체 수집 범위)는 건드리지 않는다 — 이 스크립트는 일부
    // 매장의 일부 구간만 패치하는 용도이므로 기존 범위를 그대로 유지.
    updatedAt: new Date().toISOString(),
    lastRunType: 'product-patch',
    lastPatchRange: `${start}~${end}`,
    lastPatchStores: codes,
  };

  fs.writeFileSync(TMP_PATH, JSON.stringify(output));
  fs.renameSync(TMP_PATH, DATA_PATH);

  console.log(`상품별 패치 완료: 성공 ${fixed.length}개 / 문제 ${failed.length}개`);
  if (failed.length) console.log('문제 매장:\n' + failed.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
