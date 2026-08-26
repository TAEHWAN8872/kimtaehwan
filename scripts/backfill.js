// scripts/backfill.js
// ROLLING_DAYS(기본 90일)치 데이터를 다시 받아서 기존 data/live-daily.json에
// "병합"한다. 평소 자동 실행되는 스크립트가 아니라 GitHub Actions에서
// workflow_dispatch로 수동 실행하는 용도입니다.
//
// [2026-08-21 수정] 기존에는 fs.writeFileSync로 파일 전체를 새로 써서
// ROLLING_DAYS 범위 밖(과거)의 이력이 통째로 사라지는 위험이 있었음
// (예: rolling_days=20으로 돌리면 최근 20일 빼고 2022년부터의 전체
// 이력이 삭제됨). patch-missing-days.js와 동일한 병합 방식으로 바꿔서,
// 새로 받은 [start, end] 구간만 교체하고 그 밖의 기존 데이터는 보존한다.
//
// tpay API는 조회 범위가 15일을 넘어가면 에러 없이 빈 배열을 반환하는 것으로
// 확인되어(디버그 결과: 14일=정상, 31일 이상=전멸), fetchOneStoreRange()가
// 요청 범위를 15일 단위로 자동으로 쪼개서 여러 번 호출한 뒤 합쳐준다.
//
// 사용법(로컬): TPAY_TOKEN=xxx node scripts/backfill.js
// 사용법(Actions): workflow_dispatch 로 tpay-sync.yml의 backfill job 실행

const fs = require('fs');
const path = require('path');
const { kstDateString, sleep, fetchOneStoreRange } = require('./lib');

const ROLLING_DAYS = Number(process.env.ROLLING_DAYS || 90);
const DATA_PATH = path.join(__dirname, '..', 'data', 'live-daily.json');
const STORE_MAP_PATH = path.join(__dirname, '..', 'data', 'store-map.json');

function loadExisting() {
  if (!fs.existsSync(DATA_PATH)) return { STORES: {} };
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.warn('기존 data/live-daily.json 파싱 실패, 새로 시작합니다:', e.message);
    return { STORES: {} };
  }
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const storeMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]

  const end = kstDateString(0);
  const start = kstDateString(-ROLLING_DAYS);

  const existing = loadExisting();
  const stores = existing.STORES || {};

  console.log(`백필 시작: ${start} ~ ${end}, 매장 ${storeMap.length}개 (15일 단위 자동 분할 조회, 기존 데이터에 병합)`);

  const failed = [];
  const partial = [];

  for (let i = 0; i < storeMap.length; i++) {
    const [name, code] = storeMap[i];
    const result = await fetchOneStoreRange(token, code, start, end);

    if (result.error) {
      failed.push(`${code}(${name}): ${result.error}`);
      // 실패 시 기존 값 유지 (없으면 error 상태로 최초 기록). 기존 데이터를 지우지 않는다.
      if (!stores[code]) stores[code] = { name, error: result.error };
    } else {
      // [start, end] 구간에 해당하는 기존 레코드만 제거하고 새 값으로 교체.
      // 구간 밖의 과거 이력은 그대로 보존된다.
      const prev = stores[code] || { name, days: [] };
      const keptDays = (prev.days || []).filter((d) => d.SDA_DT < start || d.SDA_DT > end);
      stores[code] = { name: prev.name || name, days: [...keptDays, ...result.days] };

      if (result.partialError) {
        partial.push(`${code}(${name}): ${result.partialError}`);
      }
    }

    if (i % 20 === 0) console.log(`진행: ${i + 1}/${storeMap.length}`);
    if (i < storeMap.length - 1) await sleep(150);
  }

  const output = {
    ...existing,
    // START는 기존 값과 이번 조회 시작일 중 더 이른 날짜를 유지 (과거 이력 보존 반영)
    START: existing.START && existing.START < start ? existing.START : start,
    END: end,
    STORES: stores,
    updatedAt: new Date().toISOString(),
    lastRunType: 'backfill',
  };

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output));

  const successCount = storeMap.length - failed.length - partial.length;
  console.log(
    `백필 완료: 완전성공 ${successCount}개 / 부분성공 ${partial.length}개 / 실패 ${failed.length}개 (기존 이력 보존됨)`
  );
  if (partial.length) console.log('부분 실패 매장(일부 구간만 누락):\n' + partial.join('\n'));
  if (failed.length) console.log('완전 실패 매장:\n' + failed.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
