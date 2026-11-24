// scripts/catchup.js
// ─────────────────────────────────────────────────────────────────────────────
// [2026-11-24] PC 꺼짐 대비 "지난 날짜 자동 채우기"
//
// 배경: 11/23부터 tpay가 GitHub 서버(해외 IP)의 접속을 403으로 막아서, 갱신 작업을
// 회사 PC(self-hosted runner)에서 돌리게 됐다. 그런데 daily-update.js는 "오늘"만
// 갱신하기 때문에, PC가 저녁에 꺼지면 그날 마감까지의 매출이, 주말 내내 꺼지면
// 토·일 데이터가 통째로 빠진 채 남는다.
//
// 동작: 하루에 한 번(그날 첫 실행 때) 마지막으로 채운 날짜 다음날 ~ 어제까지를
// 전 매장 다시 조회해서 아래 데이터를 채운다. 오늘 이미 채웠으면 바로 종료(호출 0회).
//   1) 일별 확정 매출(REQ_CODE 4)      → data/live-daily.json STORES[code].days
//   2) 채널별 매출(REQ_CODE 3 주문)    → data/live-daily.json STORES[code].channelDays
//   3) 상품별 매출(REQ_CODE 6 품목)    → data/product-daily.json STORES[code].rows
//   4) 시간대별 매출                    → data/hour/*.json (hour-backfill.js 재사용)
// 다른 항목(todayRaw 등)은 절대 지우지 않고 해당 날짜만 교체한다.
//
// 실패가 많으면(10% 초과) 완료 표시를 하지 않아서, 다음 회차(1시간 뒤)에 자동으로
// 다시 시도한다. 기록: data/catchup-state.json
//
// 환경변수
//   TPAY_TOKEN          (필수)
//   CATCHUP_MAX_DAYS    (선택, 기본 7 — 한 번에 거슬러 올라갈 최대 일수. 연휴 대비)
//   CATCHUP_FORCE=1     (선택, 오늘 이미 했어도 다시 실행)
//   CATCHUP_START/END   (선택, yyyymmdd — 직접 구간 지정. 지정하면 기록과 상관없이 실행)
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  kstDateString,
  addDaysYmd,
  sleep,
  fetchOneStoreRange,
  fetchOneStoreRealtimeWithOrders,
  aggregateOrdersToChannelDays,
  fetchOneStoreOrderDetail,
  aggregateOrderDetailToProducts,
} = require('./lib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LIVE_PATH = path.join(DATA_DIR, 'live-daily.json');
const PRODUCT_PATH = path.join(DATA_DIR, 'product-daily.json');
const STORE_MAP_PATH = path.join(DATA_DIR, 'store-map.json');
const STATE_PATH = path.join(DATA_DIR, 'catchup-state.json');

const MAX_DAYS = Math.max(1, Number(process.env.CATCHUP_MAX_DAYS || 7));
const CALL_DELAY_MS = 250; // 호출 사이 쉬는 시간 (tpay 누적 호출량 제한 대비)
const FAIL_RATE_LIMIT = 0.1; // 실패 비율이 이보다 크면 완료 표시 안 함 → 다음 회차 재시도

function listDates(start, end) {
  const out = [];
  let d = start;
  while (d <= end) { out.push(d); d = addDaysYmd(d, 1); }
  return out;
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonAtomic(p, obj) {
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
  fs.renameSync(p + '.tmp', p);
}

async function main() {
  const token = process.env.TPAY_TOKEN;
  if (!token) throw new Error('TPAY_TOKEN 환경변수가 없습니다.');

  const yesterday = kstDateString(-1);
  const state = readJson(STATE_PATH, {});
  let start, end;

  if (process.env.CATCHUP_START && process.env.CATCHUP_END) {
    start = process.env.CATCHUP_START; end = process.env.CATCHUP_END;
  } else {
    if (state.lastDone && state.lastDone >= yesterday && process.env.CATCHUP_FORCE !== '1') {
      console.log(`지난 날짜 채우기: 이미 ${state.lastDone}까지 완료 — 건너뜀 (API 호출 없음)`);
      return;
    }
    end = yesterday;
    start = state.lastDone ? addDaysYmd(state.lastDone, 1) : yesterday;
    const minStart = addDaysYmd(yesterday, -(MAX_DAYS - 1));
    if (start < minStart) start = minStart;
    if (start > end) start = end;
  }
  const dates = listDates(start, end);
  const storeMap = readJson(STORE_MAP_PATH, []); // [[name, code], ...]
  console.log(`지난 날짜 채우기 시작: ${start} ~ ${end} (${dates.length}일), 매장 ${storeMap.length}개`);

  const live = readJson(LIVE_PATH, { STORES: {} });
  const prod = readJson(PRODUCT_PATH, { STORES: {} });
  live.STORES = live.STORES || {};
  prod.STORES = prod.STORES || {};

  let calls = 0, fails = 0;
  const failLog = [];
  const inRange = (d) => d >= start && d <= end;

  for (let i = 0; i < storeMap.length; i++) {
    const [name, code] = storeMap[i];

    // 1) 일별 확정 매출 — 매장당 1번 호출로 구간 전체
    const r = await fetchOneStoreRange(token, code, start, end); calls++;
    const prevL = live.STORES[code] || { name, days: [] };
    if (r.error) {
      fails++; failLog.push(`${code}(${name}) 일별: ${r.error}`);
    } else {
      const had = (prevL.days || []).some((d) => inRange(d.SDA_DT));
      // 안전장치: 기존에 값이 있었는데 새로 받은 게 비어 있으면 덮어쓰지 않음
      if (r.days.length || !had) {
        const kept = (prevL.days || []).filter((d) => !inRange(d.SDA_DT));
        live.STORES[code] = { ...prevL, name: prevL.name || name, days: [...kept, ...r.days] };
      }
      if (r.partialError) { fails++; failLog.push(`${code}(${name}) 일별 일부: ${r.partialError}`); }
    }
    await sleep(CALL_DELAY_MS);

    // 2)·3) 날짜별: 주문(채널별) + 품목(상품별)
    for (const date of dates) {
      const o = await fetchOneStoreRealtimeWithOrders(token, code, date); calls++;
      if (o.error) {
        fails++; failLog.push(`${code}(${name}) ${date} 채널: ${o.error}`);
      } else if (o.orders && o.orders.length) {
        const ch = aggregateOrdersToChannelDays(o.orders)[date];
        if (ch) {
          const cur = live.STORES[code] || { name, days: [] };
          live.STORES[code] = { ...cur, channelDays: { ...(cur.channelDays || {}), [date]: ch } };
        }
      }
      await sleep(CALL_DELAY_MS);

      const dt = await fetchOneStoreOrderDetail(token, code, date); calls++;
      if (dt.error) {
        fails++; failLog.push(`${code}(${name}) ${date} 상품: ${dt.error}`);
      } else {
        const rows = aggregateOrderDetailToProducts(dt.rows).map((x) => [x.SDA_DT, x.CMDT_NM, x.SDC_QTY, x.SDC_AMT_TTL]);
        const prevP = prod.STORES[code] || { name, rows: [] };
        const had = (prevP.rows || []).some((x) => x[0] === date);
        if (rows.length || !had) { // 안전장치: 기존 값이 있는데 빈 응답이면 유지
          const kept = (prevP.rows || []).filter((x) => x[0] !== date);
          prod.STORES[code] = { ...prevP, name: prevP.name || name, rows: [...kept, ...rows] };
        }
      }
      await sleep(CALL_DELAY_MS);
    }
    if ((i + 1) % 20 === 0) console.log(`  … ${i + 1}/${storeMap.length}개 매장 처리 (실패 ${fails}건)`);
  }

  live.updatedAt = new Date().toISOString();
  prod.updatedAt = new Date().toISOString();
  writeJsonAtomic(LIVE_PATH, live);
  writeJsonAtomic(PRODUCT_PATH, prod);
  console.log(`일별·채널·상품 채우기 완료: 호출 ${calls}회 / 실패 ${fails}건`);
  if (failLog.length) console.log('실패 내역(최대 20개):\n' + failLog.slice(0, 20).join('\n'));

  // 4) 시간대별 — 기존 hour-backfill.js를 같은 구간으로 실행 (자동 재실행 체인은 끔)
  const env = { ...process.env, HOUR_BACKFILL_START: start, HOUR_BACKFILL_END: end, HOUR_BACKFILL_STORE_CODES: '' };
  delete env.GITHUB_OUTPUT;
  const h = spawnSync(process.execPath, [path.join(__dirname, 'hour-backfill.js')], { env, stdio: 'inherit' });
  const hourOk = h.status === 0;

  // 완료 기록: 실패가 적고 시간대별도 정상 종료됐을 때만
  const failRate = calls ? fails / calls : 1;
  if (failRate <= FAIL_RATE_LIMIT && hourOk && !(process.env.CATCHUP_START && process.env.CATCHUP_END)) {
    writeJsonAtomic(STATE_PATH, { lastDone: end, lastRange: `${start}~${end}`, updatedAt: new Date().toISOString() });
    console.log(`✅ 지난 날짜 채우기 완료: ${start} ~ ${end} (다음 채우기는 내일 첫 실행 때)`);
  } else if (process.env.CATCHUP_START && process.env.CATCHUP_END) {
    console.log(`수동 구간 채우기 끝 (${start} ~ ${end}, 실패율 ${(failRate * 100).toFixed(1)}%) — 기록은 바꾸지 않음`);
  } else {
    console.log(`⚠️ 실패율 ${(failRate * 100).toFixed(1)}%${hourOk ? '' : ' / 시간대별 오류'} — 완료 표시 안 함, 다음 회차에 다시 시도합니다.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
