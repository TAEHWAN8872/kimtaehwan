// scripts/debug-settled-channel-filter.js
// 목적: REQ_CODE 4(일정산매출, 정산 확정) 요청 본문에 IFSA_TP(그리고 필요하면
// SDA_TP)를 필터 파라미터로 넣었을 때 실제로 해당 채널만 걸러서 응답하는지
// 확인하기 위한 1회성 진단 스크립트.
//
// 기존 fetchOneStore()는 REQ_CODE/FRANCHISE_CODE/BRAND_CODE/SHOP_NO/
// SALE_START_DATE/SALE_END_DATE만 보내도록 고정돼 있어서, 여기서는 그 함수를
// 안 쓰고 fetch를 직접 호출해서 IFSA_TP/SDA_TP를 자유롭게 추가해본다.
//
// 실행 예시:
//   DEBUG_SHOP_NO=BHD053 DEBUG_START=20260820 DEBUG_END=20260820 \
//   DEBUG_IFSA_TP=OKB node scripts/debug-settled-channel-filter.js
//
//   (IFSA_TP를 비우면 필터 없이 호출 — 기존 결과와 비교하는 baseline용)
//   (DEBUG_SDA_TP를 주면 SDA_TP도 같이 필터 — 예: IFS)

const { TPAY_HOST, FRANCHISE_CODE, BRAND_CODE, sleep } = require('./lib');

async function callReqCode4(token, code, start, end, extra) {
  const body = JSON.stringify({
    REQ_CODE: '4',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
    SALE_START_DATE: start,
    SALE_END_DATE: end,
    ...extra,
  });

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(TPAY_HOST + 'bridge/common/selectPos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'Accept-Encoding': 'utf-8',
        },
        body,
      });
      if (res.ok) {
        try {
          const data = await res.json();
          if (data.RESPONSE_CODE === '0000') return { days: data.SALE_INFO || [], raw: data };
          lastError = data.RESPONSE_MSG || data.RESPONSE_CODE;
        } catch (e) {
          lastError = 'parse error';
        }
      } else {
        lastError = 'HTTP_' + res.status;
      }
    } catch (e) {
      lastError = 'FETCH_EXCEPTION: ' + e.message;
    }
    if (attempt < 2) await sleep(500 * (attempt + 1));
  }
  return { error: lastError || 'unknown error' };
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  const shopNo = process.env.DEBUG_SHOP_NO || 'BHD053';
  const start = process.env.DEBUG_START;
  const end = process.env.DEBUG_END || start;
  const ifsaTp = process.env.DEBUG_IFSA_TP || '';
  const sdaTp = process.env.DEBUG_SDA_TP || '';

  if (!start) {
    console.error('DEBUG_START(yyyymmdd) 환경변수가 필요합니다.');
    process.exit(1);
  }

  const extra = {};
  if (ifsaTp) extra.IFSA_TP = ifsaTp;
  if (sdaTp) extra.SDA_TP = sdaTp;

  console.log(`검증 대상(REQ_CODE 4 + 필터): ${shopNo} / ${start} ~ ${end}`);
  console.log(`추가 필터 파라미터: ${JSON.stringify(extra)} ${Object.keys(extra).length === 0 ? '(없음 = baseline)' : ''}`);

  const result = await callReqCode4(token, shopNo, start, end, extra);

  if (result.error) {
    console.error('조회 실패:', result.error);
    process.exit(1);
  }

  console.log(`\n총 응답 행(row) 수: ${result.days.length}건`);
  result.days.forEach((d, i) => {
    console.log(`\n[행 ${i}] SDA_DT=${d.SDA_DT}`);
    console.log(JSON.stringify(d, null, 2));
  });

  if (result.days.length === 0) {
    console.log('\n응답이 빈 배열입니다. 필터가 적용됐지만 이 채널 매출이 0건이거나, 필터 자체가 무시됐을 수도 있습니다 — 필터 없는 baseline 결과와 꼭 비교해보세요.');
  }
}

main().catch((e) => {
  console.error('스크립트 실행 중 오류:', e);
  process.exit(1);
});
