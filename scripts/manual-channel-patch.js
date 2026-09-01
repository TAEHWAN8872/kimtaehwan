// scripts/manual-channel-patch.js
//
// 목적: REQ_CODE 3(실시간 캐시) 만료로 자동 백필이 안 되는 2026-08-21~08-31 구간을,
// tpay 관리자 화면(판매 관리 > 기간별 판매조회 > 외부주문별) 캡처 원본을 사람이 직접
// 확인해서 그대로 채워 넣기 위한 1회성 수동 패치 스크립트.
//
// 데이터 출처: tpay 관리자 화면 캡처 (2026-08-20 ~ 2026-08-31, 광주수완점, 외부주문 전체),
// "온라인결제" 컬럼 값 기준으로 옮겨 적음 (2026-09-01).
// - 2026-08-20은 이미 REQ_CODE 3으로 정상 백필된 값이 있어서 건드리지 않음(스킵).
// - 2026-08-23, 2026-08-31 중 08-23은 캡처에 외부주문 행 자체가 없어 배달매출 0원으로 간주.
// - 2026-08-31 배민 건(89,200원)은 카드 54,000 + 온라인결제 35,200으로 결제수단이 나뉘어 있어,
//   기존 SA_ON_AMT(온라인 결제금액) 기준과 동일하게 온라인결제분(35,200원)만 반영.
//
// 사용법(로컬):
//   1) 이 파일을 저장소의 scripts/manual-channel-patch.js 로 복사
//   2) 저장소 루트에서: node scripts/manual-channel-patch.js
//   3) git add data/live-daily.json && git commit -m "chore: 8/21~31 배달매출 수동 백필(관리자화면 캡처)" && git push
//
// TPAY_TOKEN 불필요 (API 호출 없음, 로컬 JSON 파일만 수정합니다).

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'live-daily.json');
const SHOP_CODE = 'BHD053'; // 광주수완점

// 캡처에서 옮겨 적은 값 (온라인결제 컬럼 기준). 이미 있는 날짜(20260820)는 포함하지 않음.
const MANUAL_CHANNEL_DAYS = {
  '20260821': {
    '배민1': { amount: 66000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 61500, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260822': {
    '배민': { amount: 32000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '배민1': { amount: 49000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 125900, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260824': {
    '배민': { amount: 36000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '배민1': { amount: 59500, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 110500, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260825': {
    '배민': { amount: 22000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '배민1': { amount: 75000, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260826': {
    '배민': { amount: 22000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '배민1': { amount: 44000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '요기배달': { amount: 18000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 108400, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260827': {
    '배민': { amount: 0, cnt: 0, cxlCnt: 1, code: 'OKB' }, // 전액 취소(22,000원)
    '요기배달': { amount: 18000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 119500, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260828': {
    '배민1': { amount: 42500, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 86200, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260829': {
    '배민': { amount: 37500, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '배민1': { amount: 43000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 147200, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
  '20260831': {
    '배민': { amount: 35200, cnt: 1, cxlCnt: 0, code: 'OKB' }, // 카드 54,000원 별도(제외)
    '배민1': { amount: 104000, cnt: 1, cxlCnt: 0, code: 'OKB' },
    '쿠팡이츠': { amount: 39000, cnt: 1, cxlCnt: 0, code: 'OKB' },
  },
};

function main() {
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`${DATA_PATH} 파일이 없습니다. 저장소 루트에서 실행했는지 확인하세요.`);
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  if (!data.STORES[SHOP_CODE]) {
    throw new Error(`${SHOP_CODE} 매장이 live-daily.json에 없습니다.`);
  }

  const store = data.STORES[SHOP_CODE];
  const existing = store.channelDays || {};

  let addedCount = 0;
  let skippedCount = 0;
  Object.entries(MANUAL_CHANNEL_DAYS).forEach(([ymd, chMap]) => {
    if (existing[ymd]) {
      console.log(`${ymd}: 이미 데이터가 있어서 건너뜀 (기존 값 유지) —`, JSON.stringify(existing[ymd]));
      skippedCount++;
      return;
    }
    existing[ymd] = chMap;
    const summary = Object.entries(chMap)
      .map(([ch, v]) => `${ch}: ${v.amount}원/${v.cnt}건${v.cxlCnt ? `(취소 ${v.cxlCnt}건)` : ''}`)
      .join(', ');
    console.log(`${ymd} 추가 — ${summary}`);
    addedCount++;
  });

  store.channelDays = existing;
  data.updatedAt = new Date().toISOString();

  fs.writeFileSync(DATA_PATH, JSON.stringify(data));
  console.log(`\n완료: ${addedCount}일 추가, ${skippedCount}일 스킵(기존 데이터 유지).`);
  console.log('이제 git add data/live-daily.json && git commit && git push 로 반영하세요.');
}

main();
