// scripts/backfill-channel-sales.js
// 지정한 매장/기간에 대해 REQ_CODE 3(매출정보 마스터)을 하루씩 호출해서
// 채널별(배민/쿠팡이츠 등) 매출을 live-daily.json의 STORES[code].channelDays에 백필한다.
//
// [왜 하루씩 호출하나] fetchOneStoreRealtimeWithOrders(REQ_CODE 3)는 "오늘"처럼
// 단일 날짜 조회용으로 만들어졌지만 date 파라미터를 그대로 받으므로 과거 날짜에도
// 재사용할 수 있다. 다만 스펙상 REQ_CODE 3의 날짜 범위 제한이 확인되지 않았기
// 때문에(daily-update.js 상단 주석 참고), 안전하게 하루 단위로만 호출한다.
//
// [채널 코드 매핑 미완성 주의] lib.js의 CHANNEL_NAME_MAP이 비어있는 동안은
// IFSA_TP 코드값(예: 'OKB')이 그대로 채널명으로 저장된다. 나중에 매핑표를
// 채운 뒤 이 스크립트를 다시 돌리면 채널명이 갱신된다(덮어쓰기 방식이라 안전).
//
// 사용법(로컬): TPAY_TOKEN=xxx BACKFILL_SHOP_NO=BHD053 BACKFILL_START=20260820 node scripts/backfill-channel-sales.js
// 사용법(Actions): workflow_dispatch로 실행, 위 3개 입력값을 파라미터로 전달

const fs = require('fs');
const path = require('path');
const {
  kstDateString,
  addDaysYmd,
  sleep,
  fetchOneStoreRealtimeWithOrders,
  aggregateOrdersToChannelDays,
} = require('./lib');

const DATA_PATH = path.join(__dirname, '..', 'data', 'live-daily.json');

function loadExisting() {
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`${DATA_PATH} 파일이 없습니다. daily-update.js를 먼저 한 번 이상 실행하세요.`);
  }
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  // 기본값: 광주수완점, 배달매출 테스트 시작일(8/20)부터 어제까지
  const code = process.env.BACKFILL_SHOP_NO || 'BHD053';
  const start = process.env.BACKFILL_START || '20260820';
  const end = process.env.BACKFILL_END || kstDateString(-1);

  const data = loadExisting();
  if (!data.STORES[code]) {
    throw new Error(`${code} 매장이 live-daily.json에 없습니다. daily-update.js/backfill.js를 먼저 돌리세요.`);
  }

  const name = data.STORES[code].name;
  const existingChannelDays = data.STORES[code].channelDays || {};

  console.log(`채널별 매출 백필 시작: ${name}(${code}), ${start} ~ ${end} (하루 단위 REQ_CODE 3 호출)`);

  // [2026-08-31 daily-update.js와 동일한 이유로 추가]
  // REQ_CODE 3은 같은 파라미터로 여러 번 호출해도 시점에 따라 일부 주문을
  // 누락해서 응답하는 현상이 실측 확인됨(BHD053/2026-08-27, 동일 파라미터로
  // 45건 vs 0건). 하루당 딱 1번만 호출하면 그 순간 빈 응답이 오는 경우
  // "주문 없음"으로 잘못 확정돼버린다. 같은 날짜를 여러 번 호출해서 SA_NO
  // 기준으로 누적 병합한 뒤 채널 집계하도록 바꾼다(daily-update.js의
  // todayRaw.ordersByNo 누적 병합과 동일한 아이디어).
  const RETRY_COUNT = 3; // 하루당 호출 횟수 (필요시 조정)
  const RETRY_DELAY_MS = 500;

  const failed = [];
  const flaky = []; // 진단용: 호출마다 건수가 달랐던 날짜 기록
  let cursor = start;

  while (true) {
    const ordersByNo = {};
    let lastError = null;
    let sawZero = false; // 0건짜리 응답을 한 번이라도 봤는지 (진단용)
    let sawNonZero = false;

    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      const result = await fetchOneStoreRealtimeWithOrders(token, code, cursor);
      if (result.error) {
        lastError = result.error;
      } else {
        if (result.orders.length === 0) sawZero = true; else sawNonZero = true;
        for (const o of result.orders) {
          ordersByNo[String(o.SA_NO)] = o; // 같은 SA_NO는 최신 값으로 덮어씀
        }
      }
      if (attempt < RETRY_COUNT - 1) await sleep(RETRY_DELAY_MS);
    }

    if (sawZero && sawNonZero) {
      flaky.push(cursor); // 호출마다 응답이 들쭉날쭉했던 날짜 — 실측 근거 남기기
    }

    const mergedOrders = Object.values(ordersByNo);

    if (mergedOrders.length === 0 && lastError) {
      failed.push(`${cursor}: ${lastError}`);
      console.warn(`${cursor} 실패: ${lastError} (기존 channelDays 유지)`);
    } else {
      const channelByDay = aggregateOrdersToChannelDays(mergedOrders);
      const dayResult = channelByDay[cursor];
      if (dayResult) {
        existingChannelDays[cursor] = dayResult;
        const summary = Object.entries(dayResult)
          .map(([ch, v]) => `${ch}: ${v.amount}원/${v.cnt}건`)
          .join(', ');
        console.log(`${cursor} 완료 — ${summary || '주문 없음'} (호출 ${RETRY_COUNT}회 병합, 원본건수 ${mergedOrders.length})`);
      } else {
        console.log(`${cursor} 완료 — 주문 없음 (호출 ${RETRY_COUNT}회 병합)`);
      }
    }

    if (cursor === end) break;
    cursor = addDaysYmd(cursor, 1);
    await sleep(200);
  }

  data.STORES[code].channelDays = existingChannelDays;
  data.updatedAt = new Date().toISOString();

  fs.writeFileSync(DATA_PATH, JSON.stringify(data));

  console.log(`백필 저장 완료. 실패한 날짜 ${failed.length}건${failed.length ? ':\n' + failed.join('\n') : ''}`);
  if (flaky.length) {
    console.log(`\n⚠ 호출마다 건수가 들쭉날쭉했던 날짜 ${flaky.length}건 (REQ_CODE 3 플레이키 이슈 실측, 병합 처리됨):\n${flaky.join(', ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
