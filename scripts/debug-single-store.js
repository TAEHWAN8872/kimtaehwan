// scripts/debug-single-store.js
// 진단 전용: 매장 1곳에 대해 tpay API 원본 응답을 그대로 로그에 출력합니다.
// (SALE_INFO 필드명이 실제 응답과 맞는지, RESPONSE_CODE 외 다른 필드가 있는지 확인용)
//
// 사용법(Actions): workflow_dispatch에서 mode=debug 선택 후 실행
// 사용법(로컬): TPAY_TOKEN=xxx node scripts/debug-single-store.js

const { TPAY_HOST, FRANCHISE_CODE, BRAND_CODE, kstDateString } = require('./lib');

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const code = process.env.DEBUG_SHOP_NO || 'BHD055'; // 검단신도시점 (기존에도 정상 조회됐던 매장)
  const testDays = Number(process.env.DEBUG_DAYS || 7); // 조회 범위(일수) - tpay의 최대 범위 제한을 찾기 위한 값
  const end = kstDateString(0);
  const start = kstDateString(-testDays);

const payload = {
    REQ_CODE: '4',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
    SALE_START_DATE: start,
    SALE_END_DATE: end,
  };


  console.log('요청 payload:', JSON.stringify(payload, null, 2));

  const res = await fetch(TPAY_HOST + 'bridge/common/selectPos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'Accept-Encoding': 'utf-8',
    },
    body: JSON.stringify(payload),
  });

  console.log('HTTP 상태 코드:', res.status);
  const text = await res.text();
  console.log('원본 응답 본문 (그대로):');
  console.log(text);

  try {
    const json = JSON.parse(text);
    console.log('응답 최상위 키 목록:', Object.keys(json));
    console.log(`요청 일수: ${testDays}일 (${start}~${end}) / SALE_INFO 건수: ${(json.SALE_INFO || []).length}건`);
  } catch (e) {
    console.log('JSON 파싱 실패:', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
