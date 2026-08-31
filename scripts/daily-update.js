// scripts/daily-update.js
// 매번(예: 2시간마다) 실행되는 스크립트. "오늘" 하루치만 다시 받아서
// 기존 data/live-daily.json에 병합합니다. 과거 날짜는 이미 저장된 값을
// 그대로 유지하므로 매번 155개 매장 x 1일치만 호출 -> 빠르고 가볍습니다.
//
// [2026-08-31 변경: 누적 병합 방식으로 전환]
// tpay REQ_CODE 3/6이 같은 요청에도 시점에 따라 일부 주문을 누락해서 응답하는
// 현상이 실측으로 확인됨(BHD053/2026-08-27, 동일 파라미터로 45건 vs 0건).
// 예전 방식은 "이번 호출 결과로 오늘자를 통째로 덮어쓰기"였기 때문에, 어느 한
// 번의 호출이 몇 건을 놓치면 그 주문이 최종 데이터에서 그대로 사라지는 문제가
// 있었다. 이제는 stores[code].todayRaw.ordersByNo / itemsByNo에 SA_NO를 키로
// 오늘 하루 동안의 모든 호출 결과를 계속 누적 병합한다. 즉 하루 안에 단 한
// 번이라도 어떤 주문이 잡히면, 이후 호출이 그 주문을 놓치더라도 최종 데이터에는
// 계속 남는다. 같은 SA_NO가 다시 잡히면 최신 값으로 덮어써서 취소 처리
// (SA_DEL_MK 변경) 등은 정상 반영된다. 날짜가 바뀌면(todayRaw.date !== today)
// 누적을 초기화한다.
//
// [실시간 소스] "오늘"은 REQ_CODE 4(일정산매출, 정산 배치가 끝나야 채워짐) 대신
// fetchOneStoreRealtime()으로 REQ_CODE 3(매출정보 마스터, 주문 건별 원본)을 조회해서
// 직접 합산합니다. 확정값과 합산값이 완전히 일치함을 검증 완료(2026-08-13,
// scripts/debug-realtime-compare.js). 과거 날짜는 이미 정산 확정된 값이 그대로
// 저장되어 있으므로 건드리지 않습니다.
//
// [품목별 상세] 일판매 매출(영수증) 탭에서 주문 클릭 시 품목 내역을 보여주기 위해,
// 주문이 있는 매장에 한해 REQ_CODE 6(매출정보 주문내역)도 함께 조회합니다.
// REQ_CODE 6의 각 라인에는 SA_NO 필드가 그대로 들어있고, 이 값이 REQ_CODE 3의
// SA_NO(주문번호)와 정확히 일치함을 확인했습니다(2026-08-19, scripts/debug-order-detail.js,
// 다산점/부천중동점 실측). SC_NO는 주문번호가 아니라 "그 주문 안에서 몇 번째
// 품목인가"를 나타내는 라인 인덱스라서(같은 주문에 품목이 여러 개면 1,2,3...으로
// 늘어남), 하루치 전체를 SC_NO로 묶으면 서로 다른 주문의 "1번째 품목"들이 한
// 그룹으로 뭉개져 버립니다. 따라서 매칭은 SA_NO 필드로 직접 그룹핑합니다
// (과거에 썼던 "SA_NO % 100 = SC_NO" 방식은 틀린 가정이었음, 폐기).
// 주문이 없는 매장은 이 호출을 건너뛰어 API 부하를 줄입니다.
// 품목상세도 REQ_CODE 3과 마찬가지로 누락 가능성이 있으므로 todayRaw.itemsByNo에
// SA_NO 기준으로 누적 병합한다(이번 호출에서 못 받은 SA_NO는 이전에 캐시된 값 유지).

const fs = require('fs');
const path = require('path');
const {
  kstDateString,
  sleep,
  fetchOneStoreRealtimeWithOrders,
  fetchOneStoreOrderDetail,
  aggregateOrdersToDays,
  aggregateOrdersToChannelDays,
} = require('./lib');

const DATA_PATH = path.join(__dirname, '..', 'data', 'live-daily.json');
const STORE_MAP_PATH = path.join(__dirname, '..', 'data', 'store-map.json');
const RECEIPT_PATH = path.join(__dirname, '..', 'data', 'receipt-today.json');

// 영수증(일판매 매출) 탭에 필요한 필드만 추려서 저장 (용량 절약)
function trimOrder_(o, items) {
  return {
    STR_NM: o.STR_NM,
    SA_NO: o.SA_NO,
    SA_DT: o.SA_DT,
    SA_DEL_MK: o.SA_DEL_MK, // L: 정상(완료), D: 취소
    SA_GET_AMT: Number(o.SA_GET_AMT || 0),   // 판매금액(결제금액)
    SA_CASH_AMT: Number(o.SA_CASH_AMT || 0), // 현금
    SA_CARD_AMT: Number(o.SA_CARD_AMT || 0), // 카드
    SA_DISCOUNT: Number(o.SA_DC_AMT || 0) + Number(o.SA_ADD_AMT || 0), // 단품할인+전체할인
    ITEMS: items || [], // 품목별 상세 (REQ_CODE 6, 못 가져왔으면 빈 배열)
  };
}

// 매칭된 품목의 합계가 실제 주문금액(SA_GET_AMT)과 맞는지 검증.
// SA_NO로 직접 매칭하므로 평소엔 거의 항상 일치하지만, 할인 처리 방식 차이나
// 취소/재결제 등 예외 케이스에서 어긋날 수 있어 안전장치로 남겨둠.
// 금액이 안 맞으면 잘못된 매칭으로 보고 차라리 빈 배열(품목 없음)을 반환한다.
// (틀린 품목을 보여주는 것보다 "데이터 없음"이 훨씬 안전함)
function validateItems_(order, items, errorLog) {
  if (!items || !items.length) return items;
  const sum = items.reduce((s, it) => s + (it.SC_AMT_TTL || 0), 0);
  const target = Number(order.SA_GET_AMT || 0);
  if (sum === target) return items;
  if (errorLog.length < 10) {
    errorLog.push(
      `${order.STR_NM} SA_NO=${order.SA_NO}(${order.SA_DT}): 품목합계 ${sum}원 ≠ 주문금액 ${target}원 — 매칭 취소, 품목 비움`
    );
  }
  return [];
}

// REQ_CODE 6 원본 라인을 SA_NO(주문번호) 기준으로 그룹핑.
// (SC_NO는 주문번호가 아니라 "그 주문 안에서 몇 번째 품목인가"를 나타내는
// 라인 인덱스라서 그룹핑 키로 쓰면 안 됨 — 위 상단 주석 참고)
// 반환: { [SA_NO]: [{CMDT_NM, SC_QTY, SC_AMT_TTL, SC_FORM}, ...] }
function groupItemsBySaNo_(rows) {
  const byNo = {};
  for (const r of rows) {
    const key = String(r.SA_NO);
    if (!byNo[key]) byNo[key] = [];
    byNo[key].push({
      CMDT_NM: r.CMDT_NM,                 // 상품명
      SC_QTY: Number(r.SC_QTY || 0),      // 수량
      SC_AMT_TTL: Number(r.SC_AMT_TTL || 0), // 라인 금액
      SC_FORM: r.SC_FORM,                 // O:첫주문/A:추가주문/D:취소/C:반품
    });
  }
  return byNo;
}

function loadExisting() {
  if (!fs.existsSync(DATA_PATH)) return { STORES: {} };
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.warn('기존 data/live-daily.json 파싱 실패, 새로 시작합니다:', e.message);
    return { STORES: {} };
  }
}

// 날짜가 바뀌었으면 초기화, 같은 날이면 기존 누적값 재사용
function loadTodayRaw_(prev, today) {
  if (prev && prev.todayRaw && prev.todayRaw.date === today) {
    return {
      date: today,
      ordersByNo: { ...(prev.todayRaw.ordersByNo || {}) },
      itemsByNo: { ...(prev.todayRaw.itemsByNo || {}) },
    };
  }
  return { date: today, ordersByNo: {}, itemsByNo: {} };
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const storeMap = JSON.parse(fs.readFileSync(STORE_MAP_PATH, 'utf8')); // [[name, code], ...]
  const today = kstDateString(0);
  const existing = loadExisting();
  const prevStores = existing.STORES || {};

  console.log(`일일 갱신 시작(누적 병합): ${today}, 매장 ${storeMap.length}개`);

  const stores = { ...prevStores };
  const failed = [];
  let successCount = 0;
  let itemFetchFailedCount = 0;
  let itemFetchOkCount = 0;
  let newOrderCount = 0; // 이번 회차에서 새로 잡히거나 갱신된 주문 수(진단용)
  const itemFetchErrors = []; // 진단용: 어떤 매장에서 왜 실패했는지 (최대 10개만 기록)
  const allOrders = []; // 오늘자 전 매장 영수증(주문) 원본 — 일판매 매출 탭용

  for (let i = 0; i < storeMap.length; i++) {
    const [name, code] = storeMap[i];
    const prev = stores[code] || { name, days: [] };
    const todayRaw = loadTodayRaw_(prev, today);

    const result = await fetchOneStoreRealtimeWithOrders(token, code, today);

    if (result.error) {
      // 이번 회차 호출 자체가 실패 — 기존 누적값(todayRaw 포함)은 그대로 유지.
      failed.push(`${code}(${name}): ${result.error}`);
      if (!stores[code]) stores[code] = { name, error: result.error };
      // 실패해도 todayRaw는 최소한 저장해둬서 다음 회차가 이어받을 수 있게 함
      if (stores[code] && !stores[code].todayRaw) stores[code].todayRaw = todayRaw;
    } else {
      // 이번 회차에서 받은 주문을 SA_NO 기준으로 누적 병합 (같은 SA_NO는 최신 값으로 갱신)
      for (const o of result.orders) {
        const key = String(o.SA_NO);
        if (!todayRaw.ordersByNo[key]) newOrderCount++;
        todayRaw.ordersByNo[key] = o;
      }

      const mergedOrders = Object.values(todayRaw.ordersByNo);

      // 오늘자 일별 합계(days)는 "이번 회차 결과"가 아니라 "지금까지 누적된 전체"로 계산
      let daysToday = aggregateOrdersToDays(mergedOrders).filter((d) => d.SDA_DT === today);
      if (daysToday.length === 0) {
        // 주문이 아예 없으면(오늘 첫 회차 등) 0원 상태를 명시적으로 채워서 반환
        const zero = { SDA_DT: today, STR_NO: code, STR_NM: name };
        daysToday = [zero];
      }

      // 채널별 매출도 누적된 전체 주문 기준으로 재계산
      const channelToday = aggregateOrdersToChannelDays(mergedOrders);

      const prevDays = (prev.days || []).filter((d) => d.SDA_DT !== today);
      stores[code] = {
        name,
        days: [...prevDays, ...daysToday],
        channelDays: {
          ...(prev.channelDays || {}),
          ...(channelToday[today] ? { [today]: channelToday[today] } : {}),
        },
        todayRaw, // 다음 회차가 이어받을 수 있도록 그대로 저장
      };
      successCount++;

      // 오늘 주문이 있는 매장만 품목 상세(REQ_CODE 6)를 추가로 조회 (불필요한 API 호출 절약)
      if (result.orders.length > 0) {
        const detail = await fetchOneStoreOrderDetail(token, code, today);
        if (detail.error) {
          itemFetchFailedCount++; // 품목상세만 실패 — 이전 회차에 캐시된 값(있다면) 그대로 사용
          if (itemFetchErrors.length < 10) {
            itemFetchErrors.push(`${code}(${name}): ${detail.error}`);
          }
        } else {
          const itemsByNo = groupItemsBySaNo_(detail.rows);
          // 이번 회차에서 받은 품목만 캐시에 병합 (못 받은 SA_NO는 이전 캐시 유지)
          Object.assign(todayRaw.itemsByNo, itemsByNo);

          const matchedCount = mergedOrders.filter(
            (o) => todayRaw.itemsByNo[String(o.SA_NO)]
          ).length;
          if (matchedCount === 0 && detail.rows.length > 0 && itemFetchErrors.length < 10) {
            itemFetchErrors.push(
              `${code}(${name}): 매칭 0건 (라인 ${detail.rows.length}건, 주문 ${mergedOrders.length}건)`
            );
          } else if (matchedCount > 0) {
            itemFetchOkCount++;
          }
        }
      }

      // 영수증(일판매 매출) 탭용: 누적된 전체 주문 + 캐시된 품목 상세 기준으로 구성
      for (const o of mergedOrders) {
        const items = todayRaw.itemsByNo[String(o.SA_NO)];
        allOrders.push(trimOrder_(o, validateItems_(o, items, itemFetchErrors)));
      }
    }

    if (i < storeMap.length - 1) await sleep(150);
  }

  const output = {
    START: existing.START || today,
    END: today,
    STORES: stores,
    updatedAt: new Date().toISOString(),
    lastRunType: 'daily',
    lastRunFailedCount: failed.length,
  };

  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output));

  // 일판매 매출(영수증) 탭용 파일: "오늘" 스냅샷이라 매회 완전히 새로 씀(누적 아님, 취소건 포함)
  allOrders.sort((a, b) => (a.SA_DT < b.SA_DT ? 1 : a.SA_DT > b.SA_DT ? -1 : 0)); // 최신순
  const receiptOutput = {
    DATE: today,
    ORDERS: allOrders,
    updatedAt: new Date().toISOString(),
    lastRunFailedCount: failed.length,
  };
  fs.writeFileSync(RECEIPT_PATH, JSON.stringify(receiptOutput));

  console.log(
    `갱신 완료: 성공 ${successCount}개 / 실패 ${failed.length}개 / 이번 회차 신규·갱신 주문 ${newOrderCount}건 / ` +
    `영수증 ${allOrders.length}건 / 품목상세 매칭성공 ${itemFetchOkCount}개 / 품목상세 실패 ${itemFetchFailedCount}개`
  );
  if (failed.length) console.log('실패 매장:\n' + failed.join('\n'));
  if (itemFetchErrors.length) console.log('품목상세 실패/매칭0건 상세(최대10개):\n' + itemFetchErrors.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
