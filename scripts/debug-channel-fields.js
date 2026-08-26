// scripts/debug-channel-fields.js
// 목적: REQ_CODE 3(매출정보 마스터) 주문 건별 원본에서 "배민/배민1/쿠팡이츠/요기요/땡겨요" 같은
// 채널명이 실제로 어느 필드에 들어있는지 찾기 위한 1회성 진단 스크립트.
// (기존 debug-single-store.js는 REQ_CODE 4만, debug-realtime-compare.js는 합산값만 찍어서
//  주문 건별 원본 필드를 볼 방법이 없었음 → 이 스크립트로 원본 그대로 확인)
//
// 실행: DEBUG_SHOP_NO, DEBUG_DATE(yyyymmdd) 환경변수로 대상 지정
const { fetchOneStoreRealtimeWithOrders } = require('./lib');

async function main() {
  const token = process.env.TPAY_TOKEN;
  const shopNo = process.env.DEBUG_SHOP_NO || 'BHD053';
  const date = process.env.DEBUG_DATE;

  if (!date) {
    console.error('DEBUG_DATE(yyyymmdd) 환경변수가 필요합니다.');
    process.exit(1);
  }

  console.log(`검증 대상: ${shopNo} / ${date}`);
  const result = await fetchOneStoreRealtimeWithOrders(token, shopNo, date);

  if (result.error) {
    console.error('조회 실패:', result.error);
    process.exit(1);
  }

  const orders = result.orders || [];
  console.log(`총 주문 건수: ${orders.length}건`);

  // 배달 주문으로 추정되는 것(IFSA_TP가 채워져 있는 것) 먼저 표시
  const withIfsa = orders.filter((o) => o.IFSA_TP);
  const withoutIfsa = orders.filter((o) => !o.IFSA_TP);
  console.log(`IFSA_TP 값이 있는 주문: ${withIfsa.length}건 / 없는 주문(포스 추정): ${withoutIfsa.length}건`);

  console.log('\n--- IFSA_TP 있는 주문 원본 전체 (최대 10건) ---');
  withIfsa.slice(0, 10).forEach((o, i) => {
    console.log(`\n[주문 ${i}] SA_NO=${o.SA_NO}`);
    console.log(JSON.stringify(o, null, 2));
  });

  if (withoutIfsa.length > 0) {
    console.log('\n--- 비교용: IFSA_TP 없는(포스 추정) 주문 원본 1건 ---');
    console.log(JSON.stringify(withoutIfsa[0], null, 2));
  }

  // 배민/배민1/쿠팡이츠/요기요/땡겨요 같은 한글 채널명이 어느 필드 값에 들어있는지 자동 탐색
  const CHANNEL_KEYWORDS = ['배민', '쿠팡', '요기요', '땡겨요', '배달의민족'];
  console.log('\n--- 자동 탐색: 채널명 키워드가 들어있는 필드 ---');
  let found = false;
  orders.forEach((o, idx) => {
    Object.entries(o).forEach(([key, val]) => {
      if (typeof val === 'string' && CHANNEL_KEYWORDS.some((kw) => val.includes(kw))) {
        found = true;
        console.log(`[주문 idx=${idx}, SA_NO=${o.SA_NO}] ${key} = "${val}"`);
      }
    });
  });
  if (!found) {
    console.log('키워드가 포함된 필드를 못 찾았습니다. 위 원본 JSON을 직접 눈으로 확인해주세요.');
  }

  // IFSA_TP 값 종류별 건수 요약
  console.log('\n--- IFSA_TP 값별 건수 요약 ---');
  const counts = {};
  orders.forEach((o) => {
    const k = o.IFSA_TP || '(없음/포스)';
    counts[k] = (counts[k] || 0) + 1;
  });
  console.log(JSON.stringify(counts, null, 2));
}

main().catch((e) => {
  console.error('스크립트 실행 중 오류:', e);
  process.exit(1);
});
