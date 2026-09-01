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

  // [2026-09-01 진단 강화]
  // RESPONSE_CODE '0000' + SALE_INFO 빈 배열도 lib.js에서는 "정상 성공(0건)"으로
  // 처리되기 때문에, 기존 재시도 로직(HTTP 에러/예외만 재시도)은 "0000인데
  // 데이터가 비어있는" 케이스를 애초에 재시도 대상으로 보지 않았다.
  // 실측 결과, 짧은 시간에 반복 호출할 때 특정 날짜들이 통째로 비어서 오는
  // 패턴이 "시작일+11일"에서만 성공하는 등 너무 규칙적으로 나타나는 것으로
  // 보아, 게이트웨이가 여러 백엔드/캐시 노드로 요청을 분산하고 그중 일부
  // 노드만 실제 데이터를 갖고 있을 가능성이 있다(벤더 인프라 이슈 의심).
  // 재시도 횟수/간격을 늘리고, 매 시도(attempt)마다 원본 건수를 전부 로그로
  // 남겨서 이 패턴이 재현되는지, 어느 정도 간격을 둬야 성공률이 오르는지
  // 증거를 모은다. 이 로그는 tpay 벤더에 문의할 때 그대로 첨부할 수 있다.
  const RETRY_COUNT = Number(process.env.BACKFILL_RETRY_COUNT || 8); // 하루당 호출 횟수
  const RETRY_DELAY_BASE_MS = Number(process.env.BACKFILL_RETRY_DELAY_MS || 1500); // 기본 대기
  const RETRY_JITTER_MS = 800; // 무작위 지터(백엔드 노드가 매번 다르게 걸리길 기대)

  function delayWithJitter() {
    return RETRY_DELAY_BASE_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
  }

  const failed = [];
  const flaky = []; // 진단용: 시도마다 건수가 달랐던 날짜 기록
  const attemptLog = []; // 진단용: 날짜별 시도별 원본 건수 전체 기록 (벤더 문의용 증거)
  let cursor = start;

  while (true) {
    const ordersByNo = {};
    let lastError = null;
    const attemptCounts = []; // 이 날짜의 시도별 orders.length 기록

    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      const result = await fetchOneStoreRealtimeWithOrders(token, code, cursor);
      if (result.error) {
        lastError = result.error;
        attemptCounts.push('ERROR:' + result.error);
      } else {
        attemptCounts.push(result.orders.length);
        for (const o of result.orders) {
          ordersByNo[String(o.SA_NO)] = o; // 같은 SA_NO는 최신 값으로 덮어씀
        }
      }
      if (attempt < RETRY_COUNT - 1) await sleep(delayWithJitter());
    }

    attemptLog.push(`${cursor}: [${attemptCounts.join(', ')}]`);
    const numericCounts = attemptCounts.filter((c) => typeof c === 'number');
    if (numericCounts.length > 0 && new Set(numericCounts).size > 1) {
      flaky.push(cursor); // 시도마다 응답 건수가 달랐던 날짜 — 실측 근거 남기기
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
        console.log(`${cursor} 완료 — ${summary || '주문 없음'} (시도별 건수: [${attemptCounts.join(', ')}], 병합 후 ${mergedOrders.length}건)`);
      } else {
        console.log(`${cursor} 완료 — 주문 없음 (시도별 건수: [${attemptCounts.join(', ')}])`);
      }
    }

    if (cursor === end) break;
    cursor = addDaysYmd(cursor, 1);
    await sleep(delayWithJitter());
  }

  data.STORES[code].channelDays = existingChannelDays;
  data.updatedAt = new Date().toISOString();

  fs.writeFileSync(DATA_PATH, JSON.stringify(data));

  console.log(`백필 저장 완료. 실패한 날짜 ${failed.length}건${failed.length ? ':\n' + failed.join('\n') : ''}`);
  if (flaky.length) {
    console.log(`\n⚠ 시도마다 건수가 들쭉날쭉했던 날짜 ${flaky.length}건 (REQ_CODE 3 플레이키 이슈 실측, 병합 처리됨):\n${flaky.join(', ')}`);
  }
  console.log(`\n--- 날짜별 시도별 원본 건수 전체 로그 (벤더 문의 시 첨부용) ---\n${attemptLog.join('\n')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
