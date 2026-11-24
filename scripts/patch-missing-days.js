// scripts/patch-missing-days.js
// 특정 매장의 특정 날짜 구간만 재조회해서 기존 data/live-daily.json에 "병합"한다.
// backfill.js와 달리 지정한 매장/구간 외의 기존 데이터는 절대 건드리지 않는다
// (backfill.js는 파일 전체를 새로 쓰기 때문에 rolling_days 바깥의 과거 이력이
// 전부 사라지는 위험이 있음 — 이 스크립트는 그 문제를 피하기 위해 별도로 작성).
//
// 사용법(로컬):
//   TPAY_TOKEN=xxx STORE_CODES=BHD106,BHD087 START=20260812 END=20260812 node scripts/patch-missing-days.js
//
// 사용법(Actions):
//   tpay-sync.yml에 워크플로우 입력(patch_store_codes, patch_start, patch_end)과
//   mode=patch 스텝을 추가해서 workflow_dispatch로 수동 실행.

const fs = require('fs');
const path = require('path');
const { fetchOneStoreRange, sleep } = require('./lib');

const DATA_PATH = path.join(__dirname, '..', 'data', 'live-daily.json');
const STORE_MAP_PATH = path.join(__dirname, '..', 'data', 'store-map.json');

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const codesArg = (process.env.STORE_CODES || '').trim();
  const start = process.env.START;
  const end = process.env.END;
  if (!start || !end) throw new Error('START, END 환경변수가 필요합니다 (yyyymmdd 형식).');
  if (!codesArg) throw new Error('STORE_CODES 환경변수가 필요합니다 (콤마로 구분, 예: BHD106,BHD087). 전체 매장 대상 실행은 지원하지 않음 — 안전을 위해 명시적으로 지정할 것.');

  const storeMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]
  const nameByCode = Object.fromEntries(storeMap.map(([name, code]) => [code, name]));

  const codes = codesArg.split(',').map((s) => s.trim()).filter(Boolean);

  const existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const stores = existing.STORES || {};

  console.log(`패치 시작: ${start} ~ ${end}, 대상 매장 ${codes.length}개`);
  console.log(codes.join(', '));

  const failed = [];
  const fixed = [];

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const name = nameByCode[code] || (stores[code] && stores[code].name) || code;
    const result = await fetchOneStoreRange(token, code, start, end);

    if (result.error) {
      failed.push(`${code}(${name}): ${result.error}`);
      console.log(`[실패] ${code}(${name}): ${result.error}`);
      if (i < codes.length - 1) await sleep(150);
      continue;
    }

    // 지정한 구간에 해당하는 기존 레코드만 제거하고, 새로 받은 값으로 교체.
    // 구간 밖의 기존 데이터(과거 전체 이력)는 그대로 유지된다.
    const prev = stores[code] || { name, days: [] };
    const keptDays = (prev.days || []).filter((d) => d.SDA_DT < start || d.SDA_DT > end);
    // [2026-11-24] channelDays(채널별 매출)·todayRaw 등 다른 항목은 그대로 두고 days만 교체
    // (이전에는 {name, days}로 통째로 바꿔서 채널별 매출 기록이 전부 지워지는 문제가 있었음)
    stores[code] = { ...prev, name: prev.name || name, days: [...keptDays, ...result.days] };

    if (result.partialError) {
      failed.push(`${code}(${name}) 일부 구간 실패: ${result.partialError}`);
      console.log(`[부분성공] ${code}(${name}): ${result.partialError}`);
    } else {
      fixed.push(`${code}(${name})`);
      console.log(`[성공] ${code}(${name}): ${result.days.length}건`);
    }

    if (i < codes.length - 1) await sleep(150);
  }

  const output = {
    ...existing,
    STORES: stores,
    // START/END는 건드리지 않는다 — 이 스크립트는 전체 범위가 아니라
    // 일부 매장의 일부 구간만 패치하는 용도이므로 기존 범위를 그대로 유지.
    updatedAt: new Date().toISOString(),
    lastRunType: 'patch',
    lastPatchRange: `${start}~${end}`,
    lastPatchStores: codes,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(output));

  console.log(`패치 완료: 성공 ${fixed.length}개 / 문제 ${failed.length}개`);
  if (failed.length) console.log('문제 매장:\n' + failed.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
