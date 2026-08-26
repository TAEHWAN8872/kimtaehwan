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

  const failed = [];
  let cursor = start;

  while (true) {
    const result = await fetchOneStoreRealtimeWithOrders(token, code, cursor);

    if (result.error) {
      failed.push(`${cursor}: ${result.error}`);
      console.warn(`${cursor} 실패: ${result.error} (기존 channelDays 유지)`);
    } else {
      const channelByDay = aggregateOrdersToChannelDays(result.orders);
      const dayResult = channelByDay[cursor];
      if (dayResult) {
        existingChannelDays[cursor] = dayResult;
        const summary = Object.entries(dayResult)
          .map(([ch, v]) => `${ch}: ${v.amount}원/${v.cnt}건`)
          .join(', ');
        console.log(`${cursor} 완료 — ${summary || '주문 없음'}`);
      } else {
        // 그날 주문이 0건이면 channelByDay 자체에 그 날짜 키가 안 생김.
        // 기존에 값이 있었다면 지우지 않고(있을 이유는 없지만) 그대로 둔다.
        console.log(`${cursor} 완료 — 주문 없음`);
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
