// scripts/debug-settled-channel-fields.js
// 목적: REQ_CODE 4(일정산매출, 정산 확정 데이터)의 원본 응답에 채널명 필드
// (예: SDA_PIC, IFSA_TP_NM, SDA_ORDER_CHANNEL_NAME 등, 사용자가 공유한
// "기간별 판매 조회" SQL의 sale_daily_accnt.sda_pic / sda_order_channel_name과
// 대응되는 필드)가 실제로 들어있는지 확인하기 위한 1회성 진단 스크립트.
//
// REQ_CODE 3(실시간 캐시)은 과거 날짜에서 계속 빈 응답만 나와서(캐시 유효기간
// 문제로 추정) 과거 채널 백필에 쓸 수 없는 것으로 보인다. REQ_CODE 4는 정산
// 확정 데이터라 과거 날짜도 항상 존재하므로, 이 응답 안에 채널 필드가 있다면
// 그걸로 backfill-channel-sales.js를 다시 만들 수 있다.
//
// 실행: DEBUG_SHOP_NO, DEBUG_START, DEBUG_END(둘 다 yyyymmdd) 환경변수로 대상 지정
const { fetchOneStore } = require('./lib');

async function main() {
  const token = process.env.TPAY_TOKEN;
  const shopNo = process.env.DEBUG_SHOP_NO || 'BHD053';
  const start = process.env.DEBUG_START;
  const end = process.env.DEBUG_END || start;

  if (!start) {
    console.error('DEBUG_START(yyyymmdd) 환경변수가 필요합니다.');
    process.exit(1);
  }

  console.log(`검증 대상(REQ_CODE 4): ${shopNo} / ${start} ~ ${end}`);
  const result = await fetchOneStore(token, shopNo, start, end);

  if (result.error) {
    console.error('조회 실패:', result.error);
    process.exit(1);
  }

  const days = result.days || [];
  console.log(`총 응답 행(row) 수: ${days.length}건`);

  if (days.length === 0) {
    console.log('응답이 비어있습니다. (이 기간에 매출이 없거나, REQ_CODE 4도 뭔가 문제가 있을 수 있음)');
    return;
  }

  console.log('\n--- 원본 행 전체 (최대 5건) ---');
  days.slice(0, 5).forEach((d, i) => {
    console.log(`\n[행 ${i}]`);
    console.log(JSON.stringify(d, null, 2));
  });

  // sda_pic / sda_order_channel_name 계열 필드가 있는지 대소문자 무시하고 탐색
  console.log('\n--- 자동 탐색: 채널/PIC 관련 필드명 ---');
  const KEY_PATTERNS = ['pic', 'channel', 'ifsa'];
  const foundKeys = new Set();
  days.forEach((d) => {
    Object.keys(d).forEach((k) => {
      const lower = k.toLowerCase();
      if (KEY_PATTERNS.some((p) => lower.includes(p))) foundKeys.add(k);
    });
  });
  if (foundKeys.size > 0) {
    console.log('찾은 필드:', Array.from(foundKeys).join(', '));
    console.log('\n--- 날짜별 해당 필드 값 목록 ---');
    days.forEach((d) => {
      const vals = {};
      foundKeys.forEach((k) => { vals[k] = d[k]; });
      console.log(`${d.SDA_DT || d.SA_DT || '(날짜필드불명)'}:`, JSON.stringify(vals));
    });
  } else {
    console.log('pic/channel/ifsa 관련 필드를 못 찾았습니다. 위 원본 JSON을 직접 눈으로 확인해주세요.');
    console.log('전체 필드 목록:', Object.keys(days[0]).join(', '));
  }
}

main().catch((e) => {
  console.error('스크립트 실행 중 오류:', e);
  process.exit(1);
});
