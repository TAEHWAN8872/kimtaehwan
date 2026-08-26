// scripts/lib.js
// tpay API 공통 함수 모음. Apps Script 버전의 fetchOneStore_/callTpay_ 로직을 그대로 이식.
//
// [범위 제한 대응] tpay API는 SALE_START_DATE~SALE_END_DATE 조회 범위가
// 15일을 넘어가면 조용히 빈 배열을 반환하는 것으로 확인됨(에러 없이 0건).
// 그래서 15일보다 긴 범위는 fetchOneStoreRange()가 15일 단위 청크로 쪼개서
// 여러 번 호출한 뒤 합쳐준다. 단일 날짜(오늘자) 조회처럼 원래부터 15일
// 이내인 경우는 기존 fetchOneStore()를 그대로 써도 안전하다.

const TPAY_HOST = 'http://gw-api.tpay.co.kr/';
const FRANCHISE_CODE = 'AF0076';
const BRAND_CODE = 'BOKHD';

// tpay API가 안전하게 응답하는 것으로 확인된 최대 조회 일수(경계값은 15~30일
// 사이 어딘가로만 확인됐고, 정확한 경계까지는 좁히지 않았으므로 보수적으로 15 사용)
const MAX_RANGE_DAYS = 15;

/** KST 기준 yyyyMMdd 문자열 (오늘 또는 offsetDays만큼 이전 날짜) */
function kstDateString(offsetDays = 0) {
  const now = new Date();
  // UTC 기준시각 + 9시간 = KST
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 86400000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** yyyyMMdd 문자열 -> UTC 기준 Date 객체 (달력 계산용, 시각 정보는 무시) */
function parseYmd(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  return new Date(Date.UTC(y, m, d));
}

/** UTC 기준 Date 객체 -> yyyyMMdd 문자열 */
function formatYmd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** yyyyMMdd 문자열에 days일을 더한 yyyyMMdd 문자열 */
function addDaysYmd(s, days) {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + days);
  return formatYmd(d);
}

/**
 * [start, end] 범위를 최대 chunkDays일짜리 구간들로 쪼갠다.
 * 예: splitDateRange('20260101', '20260201', 15)
 *  -> [['20260101','20260115'], ['20260116','20260130'], ['20260131','20260201']]
 */
function splitDateRange(start, end, chunkDays = MAX_RANGE_DAYS) {
  const ranges = [];
  const endDate = parseYmd(end);
  let cursorStart = start;

  while (true) {
    const cursorStartDate = parseYmd(cursorStart);
    let cursorEndDate = new Date(cursorStartDate.getTime());
    cursorEndDate.setUTCDate(cursorEndDate.getUTCDate() + (chunkDays - 1));
    if (cursorEndDate.getTime() > endDate.getTime()) cursorEndDate = endDate;

    const cursorEnd = formatYmd(cursorEndDate);
    ranges.push([cursorStart, cursorEnd]);

    if (cursorEnd === end) break;
    cursorStart = addDaysYmd(cursorEnd, 1);
  }

  return ranges;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 단건 매장 조회 + 실패 시 재시도 (3회 + 백오프).
 * 반환: { days: [...] } 또는 { error: '...' }
 * 주의: 이 함수는 범위 제한을 검사하지 않는다. 15일을 넘는 범위는
 * fetchOneStoreRange()를 사용할 것.
 */
async function fetchOneStore(token, code, start, end) {
  const body = JSON.stringify({
    REQ_CODE: '4',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
    SALE_START_DATE: start,
    SALE_END_DATE: end,
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
          if (data.RESPONSE_CODE === '0000') return { days: data.SALE_INFO || [] };
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

/**
 * 단건 매장 조회, 단 [start, end]가 MAX_RANGE_DAYS(기본 15일)를 넘으면
 * 자동으로 15일 단위 청크로 쪼개서 여러 번 호출한 뒤 결과를 합쳐준다.
 *
 * 반환:
 *  - 모든 청크 성공: { days: [...] }
 *  - 일부만 성공: { days: [...성공분...], partialError: '실패한 구간 목록' }
 *  - 전부 실패(또는 첫 청크부터 실패): { error: '실패한 구간 목록' }
 */
async function fetchOneStoreRange(token, code, start, end, chunkDays = MAX_RANGE_DAYS) {
  const ranges = splitDateRange(start, end, chunkDays);

  // 원래부터 한 번에 끝나는 범위면 기존 fetchOneStore와 동일하게 동작
  if (ranges.length === 1) {
    return fetchOneStore(token, code, ranges[0][0], ranges[0][1]);
  }

  let allDays = [];
  const errors = [];

  for (let i = 0; i < ranges.length; i++) {
    const [rStart, rEnd] = ranges[i];
    const result = await fetchOneStore(token, code, rStart, rEnd);
    if (result.error) {
      errors.push(`${rStart}~${rEnd}: ${result.error}`);
    } else {
      allDays = allDays.concat(result.days);
    }
    if (i < ranges.length - 1) await sleep(150);
  }

  if (errors.length > 0) {
    if (allDays.length === 0) return { error: errors.join(' | ') };
    return { days: allDays, partialError: errors.join(' | ') };
  }
  return { days: allDays };
}

// REQ_CODE 3(매출정보 마스터, 주문 건별 원본)을 합산할 때 쓰는 금액/인원 필드.
// REQ_CODE 4(일정산매출, 정산 확정값)의 필드명과 1:1 동일 — debug-realtime-compare.js로
// 확정값과 합산값이 완전히 일치함을 검증 완료(2026-08-13).
const REALTIME_SUM_FIELDS = [
  'SA_AMOUNT', 'SA_DEL_AMT', 'SA_DC_AMT', 'SA_AMT_TTL', 'SA_ADD_AMT',
  'SA_GET_AMT', 'SA_RL_AMT', 'SA_VAT_AMT', 'SA_TF_AMT', 'SA_CASH_AMT',
  'SA_CARD_AMT', 'SA_CPN_AMT', 'SA_ON_AMT', 'SA_RCV_AMT', 'SA_LC_AMT',
  'SA_RSV_AMT', 'SA_PREPAID_AMT', 'SA_CASH_BILL_AMT', 'SA_CXL_AMT',
  'SA_GUEST_M', 'SA_GUEST_F',
];

/**
 * 매출정보 마스터(REQ_CODE 3) 주문 건별 원본을 SDA_DT(영업일) 기준으로 합산해서
 * 일정산매출(REQ_CODE 4)과 동일한 모양의 day 객체 배열로 변환한다.
 * 각 day 객체에는 STR_NO/STR_NM/BRD_CD/FRC_CD와 REALTIME_SUM_FIELDS 합계가 들어간다.
 */
function aggregateOrdersToDays(orders) {
  const byDay = {};
  for (const o of orders) {
    const day = o.SDA_DT;
    if (!byDay[day]) {
      byDay[day] = {
        SDA_DT: day,
        STR_NO: o.STR_NO,
        STR_NM: o.STR_NM,
        BRD_CD: o.BRD_CD,
        FRC_CD: o.FRC_CD,
      };
      for (const f of REALTIME_SUM_FIELDS) byDay[day][f] = 0;
    }
    for (const f of REALTIME_SUM_FIELDS) {
      byDay[day][f] += Number(o[f] || 0);
    }
  }
  return Object.values(byDay);
}

// IFSA_TP 코드 -> 채널 한글명 매핑. 실측(2026-08-26, BHD053/8월19~26일)으로 'OKB'
// 코드가 배달 주문(SA_TP='D')에 붙는 것을 확인했으나, 이게 정확히 어느 배달앱인지
// 및 배민/배민1/요기요/땡겨요에 해당하는 다른 코드값은 아직 표본에 없어 미확인.
// TODO: tpay 담당자에게 IFSA_TP 코드-이름 전체 매핑표(COMMON_CD, CCG_CD='IFSA_TP')를
// 요청해서 채워 넣을 것. 모르는 코드는 원본 코드값을 그대로 노출하므로 화면에서
// "OKB" 같은 코드가 보이면 아직 매핑이 안 된 것.
const CHANNEL_NAME_MAP = {
  // 'OKB': '쿠팡이츠',   // 확인 후 주석 해제
  // 'MTC': '배달의민족',
  // 'FDT': '요기요',
};

function channelName_(code) {
  if (!code) return '포스';
  return CHANNEL_NAME_MAP[code] || code; // 모르는 코드는 원본 코드 그대로 표시
}

/**
 * 매출정보 마스터(REQ_CODE 3) 주문 건별 원본을 SDA_DT(영업일) + IFSA_TP(채널) 기준으로
 * 이중 그룹핑해서, 일자별 채널별 매출 내역을 반환한다.
 * IFSA_TP가 비어있으면 '포스'(매장/포장 등 자체 주문)로 분류한다.
 * 취소(SA_DEL_MK==='D') 건은 매출 합계·건수에서 제외하고 cxlCnt로만 집계한다
 * (daily-update.js의 trimOrder_와 달리 여기서는 취소분을 정상 매출에 포함하지 않음).
 *
 * 반환 형태: { [SDA_DT]: { [channelName]: { amount, cnt, cxlCnt, code } } }
 * - amount: 해당 채널의 순매출 합계 (SA_GET_AMT 기준)
 * - cnt: 정상 주문 건수 ("배달횟수"로 쓸 수 있음)
 * - cxlCnt: 취소 건수
 * - code: 원본 IFSA_TP 코드 (매핑 안 된 채널명을 나중에 역추적할 때 참고용)
 */
function aggregateOrdersToChannelDays(orders) {
  const byDay = {};
  for (const o of orders) {
    const day = o.SDA_DT;
   const code = o.IFSA_TP || '';
// 2026-08-26 벤더(오케이포스) 수정 반영: IFSA_TP_NM이 이제 배민/배민1/쿠팡이츠 등
// 실제 채널명을 정확히 준다. 코드(IFSA_TP)가 아니라 이 값을 채널명으로 써야 한다.
const name = !code ? '포스' : (o.IFSA_TP_NM || channelName_(code));
    if (!byDay[day]) byDay[day] = {};
    if (!byDay[day][name]) byDay[day][name] = { amount: 0, cnt: 0, cxlCnt: 0, code };

    if (o.SA_DEL_MK === 'D') {
      byDay[day][name].cxlCnt += 1;
    } else {
      byDay[day][name].amount += Number(o.SA_GET_AMT || 0);
      byDay[day][name].cnt += 1;
    }
  }
  return byDay;
}

/**
 * 매출정보 마스터(REQ_CODE 3)로 단일 날짜를 조회해서 합산한 실시간 매출을 반환.
 * "오늘"처럼 아직 정산(REQ_CODE 4)이 안 끝난 날짜의 실시간 값을 보려 할 때 사용.
 * 반환: { days: [...] } (주문이 0건이면 금액 0으로 채워진 day 1개) 또는 { error: '...' }
 * 주의: fetchOneStore와 달리 REQ_CODE 3은 날짜 범위 제한을 확인하지 않았으므로
 * 반드시 단일 날짜(start === end, 오늘자)로만 호출할 것.
 */
async function fetchOneStoreRealtime(token, code, date) {
  const body = JSON.stringify({
    REQ_CODE: '3',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
    SALE_START_DATE: date,
    SALE_END_DATE: date,
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
          if (data.RESPONSE_CODE === '0000') {
            const orders = data.SALE_INFO || [];
            const days = aggregateOrdersToDays(orders);
            // 주문이 0건이면 그날짜 항목 자체가 안 나오므로, 0원 상태를 명시적으로 채워서 반환
            if (days.length === 0) {
              const zero = { SDA_DT: date, STR_NO: code };
              for (const f of REALTIME_SUM_FIELDS) zero[f] = 0;
              days.push(zero);
            }
            return { days };
          }
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

/**
 * REQ_CODE 3(매출정보 마스터, 주문 건별 원본)으로 단일 날짜를 조회해서
 * 매장별 합산 day 데이터와 원본 주문(영수증) 배열을 함께 반환한다.
 * fetchOneStoreRealtime과 동일한 API 호출 1번으로 두 가지를 모두 얻는다
 * (일판매 매출/영수증 조회 탭에서 사용, API 호출량 추가 없음).
 * 반환: { days: [...], orders: [...] } 또는 { error: '...' }
 */
async function fetchOneStoreRealtimeWithOrders(token, code, date) {
  const body = JSON.stringify({
    REQ_CODE: '3',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
    SALE_START_DATE: date,
    SALE_END_DATE: date,
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
          if (data.RESPONSE_CODE === '0000') {
            const orders = data.SALE_INFO || [];
            const days = aggregateOrdersToDays(orders);
            // 주문이 0건이면 그날짜 항목 자체가 안 나오므로, 0원 상태를 명시적으로 채워서 반환
            if (days.length === 0) {
              const zero = { SDA_DT: date, STR_NO: code };
              for (const f of REALTIME_SUM_FIELDS) zero[f] = 0;
              days.push(zero);
            }
            return { days, orders };
          }
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

/**
 * 매출정보 주문내역(REQ_CODE 6) 조회 + 실패 시 재시도(3회+백오프).
 * 상품별 판매의 "건별" 원본(SC_QTY, SC_AMT_TTL 등)을 반환한다. 스펙상 하루치만 조회 가능.
 * 취소(SC_FORM='D')/반품(SC_FORM='C') 라인이 별도로 섞여 나올 수 있어, 정산값(REQ_CODE 5)과
 * 맞는지는 product-realtime-compare.js로 검증 후 사용할 것.
 * 반환: { rows: [...] } 또는 { error: '...' }
 */
async function fetchOneStoreOrderDetail(token, code, date) {
  const body = JSON.stringify({
    REQ_CODE: '6',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
    SALE_START_DATE: date,
    SALE_END_DATE: date,
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
          if (data.RESPONSE_CODE === '0000') return { rows: data.SALE_INFO || [] };
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

/**
 * 단건 매장 상품별 정산 조회 (REQ_CODE 5) + 실패 시 재시도(3회+백오프).
 * 반환: { rows: [...] } 또는 { error: '...' }
 */
async function fetchOneStoreProducts(token, code, start, end) {
  const body = JSON.stringify({
    REQ_CODE: '5',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
    SALE_START_DATE: start,
    SALE_END_DATE: end,
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
          if (data.RESPONSE_CODE === '0000') return { rows: data.SALE_INFO || [] };
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

/**
 * 상품별 정산 조회, [start, end]가 15일을 넘으면 자동으로 청크로 쪼개서 호출.
 */
async function fetchOneStoreProductsRange(token, code, start, end, chunkDays = MAX_RANGE_DAYS) {
  const ranges = splitDateRange(start, end, chunkDays);

  if (ranges.length === 1) {
    return fetchOneStoreProducts(token, code, ranges[0][0], ranges[0][1]);
  }

  let allRows = [];
  const errors = [];

  for (let i = 0; i < ranges.length; i++) {
    const [rStart, rEnd] = ranges[i];
    const result = await fetchOneStoreProducts(token, code, rStart, rEnd);
    if (result.error) {
      errors.push(`${rStart}~${rEnd}: ${result.error}`);
    } else {
      allRows = allRows.concat(result.rows);
    }
    if (i < ranges.length - 1) await sleep(150);
  }

  if (errors.length > 0) {
    if (allRows.length === 0) return { error: errors.join(' | ') };
    return { rows: allRows, partialError: errors.join(' | ') };
  }
  return { rows: allRows };
}

/**
 * 매출정보 주문내역(REQ_CODE 6) 건별 라인을 (SDA_DT, CMDT_NM) 기준으로 합산해서
 * 일상품정산매출(REQ_CODE 5)과 동일한 필드명(SDA_DT, CMDT_NM, SDC_QTY, SDC_AMT_TTL)으로
 * 반환한다. product-realtime-compare.js로 확정값과 합산값이 완전히 일치함을
 * 검증 완료(2026-08-13, BHD055/8월12일, 상품 15종 전부 일치).
 *
 * [2026-08-26 추가] OPTION_GBN === 'S'인 행은 세트구성품(세트 메뉴를 구성하는
 * 개별 품목이 0원으로 같이 찍히는 행)으로 보고 집계에서 제외한다.
 * ⚠️ 미검증: OPTION_GBN 필드가 REQ_CODE 6 응답에 실제로 존재하는지, 'S' 값이
 * 세트구성품을 정확히 가리키는지는 별도 검증이 필요하다. 확인 전이라면
 * 이 필터를 끄고(FILTER_SET_COMPONENTS = false) 원본 그대로 집계하도록 되돌릴 것.
 *
 * [2026-08-26 추가 2] SC_FORM === 'D'(취소) / 'C'(반품) 행도 집계에서 제외한다.
 * 실측 확인(BHD136/2026-08-26): 주문 전체가 취소된 건(SA_DEL_MK='D',
 * SA_GET_AMT=0)의 라인이 SC_FORM='D'로 찍히는데, 이때 SC_AMT_TTL은 0으로
 * 내려오지만 SC_QTY는 취소 전 수량이 그대로 남아있어서, 필터링 없이 합산하면
 * "수량은 있는데 금액은 0"인 항목이 생긴다. OPTION_GBN='S' 필터와는 별개 원인이다.
 * 'C'(반품)는 실측 샘플이 아직 없어 추정으로 같이 제외한다 — 반품 라인의 실제
 * SC_QTY/SC_AMT_TTL 부호나 값이 확인되면 이 부분을 재검증할 것.
 */
const FILTER_SET_COMPONENTS = true;
const FILTER_CANCELLED = true;
const CANCELLED_SC_FORMS = ['D', 'C'];

function aggregateOrderDetailToProducts(rows) {
  const byKey = {};
  for (const r of rows) {
    if (FILTER_SET_COMPONENTS && r.OPTION_GBN === 'S') continue; // 세트구성품 제외
    if (FILTER_CANCELLED && CANCELLED_SC_FORMS.includes(r.SC_FORM)) continue; // 취소/반품 제외
    const key = r.SDA_DT + '|' + r.CMDT_NM;
    if (!byKey[key]) byKey[key] = { SDA_DT: r.SDA_DT, CMDT_NM: r.CMDT_NM, SDC_QTY: 0, SDC_AMT_TTL: 0 };
    byKey[key].SDC_QTY += Number(r.SC_QTY || 0);
    byKey[key].SDC_AMT_TTL += Number(r.SC_AMT_TTL || 0);
  }
  return Object.values(byKey);
}

/**
 * 매출정보 주문내역(REQ_CODE 6)으로 단일 날짜를 조회해서 상품별로 합산한 실시간
 * 판매를 반환한다. "오늘"처럼 아직 정산(REQ_CODE 5)이 안 끝난 날짜에 사용.
 * 반환: { rows: [...] } (일상품정산매출과 동일한 필드 모양) 또는 { error: '...' }
 * 주의: 스펙상 REQ_CODE 6은 하루치만 조회 가능 — 반드시 date 하나만 넘길 것.
 */
async function fetchOneStoreProductsRealtime(token, code, date) {
  const result = await fetchOneStoreOrderDetail(token, code, date);
  if (result.error) return result;
  return { rows: aggregateOrderDetailToProducts(result.rows) };
}

/**
 * 상품정보(상품 마스터) 조회 (REQ_CODE 2) + 실패 시 재시도(3회+백오프).
 * 날짜 범위가 필요 없는 조회로 확인됨(SALE_START_DATE/SALE_END_DATE 없이도 동일 응답).
 * 반환: { products: [...] } 또는 { error: '...' }
 * 각 항목은 { CMDTG_CD, CMDTG_NM, CMDT_CD, CMDT_NM, CMDT_DEL_MK, ... } 형태로 확인됨.
 */
async function fetchProductCategories(token, code) {
  const body = JSON.stringify({
    REQ_CODE: '2',
    FRANCHISE_CODE,
    BRAND_CODE,
    SHOP_NO: code,
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
          if (data.RESPONSE_CODE === '0000') {
            return { products: data.ITEM_INFO || [] };
          }
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

/**
 * fetchProductCategories 결과를 { [상품명]: 분류명 } 매핑 객체로 변환.
 * 같은 상품명이 여러 매장/여러 건 나와도 마지막 값으로 덮어써 정리됨.
 * CMDT_DEL_MK(사용여부, Y:사용/N:중지)가 'N'인 상품은 매핑에서 제외한다.
 * (스펙문서 확인 완료 — POS_매출연동규격서 '2.상품정보조회' 응답 항목)
 */
function buildProductCategoryMap(products) {
  const map = {};
  for (const p of products) {
    if (p.CMDT_DEL_MK === 'N') continue; // 중지된 상품은 제외
    const name = p.CMDT_NM;
    const category = p.CMDTG_NM;
    if (name && category) map[name] = category;
  }
  return map;
}

module.exports = {
  TPAY_HOST,
  FRANCHISE_CODE,
  BRAND_CODE,
  MAX_RANGE_DAYS,
  kstDateString,
  parseYmd,
  formatYmd,
  addDaysYmd,
  splitDateRange,
  sleep,
  fetchOneStore,
  fetchOneStoreRange,
  fetchOneStoreRealtime,
  fetchOneStoreRealtimeWithOrders,
  aggregateOrdersToChannelDays,
  fetchOneStoreProducts,
  fetchOneStoreProductsRange,
  fetchOneStoreOrderDetail,
  fetchOneStoreProductsRealtime,
  aggregateOrderDetailToProducts,
  fetchProductCategories,
  buildProductCategoryMap,
};
