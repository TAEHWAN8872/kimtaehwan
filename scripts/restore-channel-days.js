// scripts/restore-channel-days.js
// [2026-11-24 1회용] 11/24 PC 수동 패치(patch-missing-days.js) 때 채널별 매출 기록
// (channelDays, 8/1~11/23)이 지워진 것을 git 이전 버전에서 되살린다.
// 사용법: node scripts/restore-channel-days.js 04c177a
//   (인자 = channelDays가 온전했던 커밋. 생략하면 04c177a)
// 이전 버전의 날짜별 값을 가져오되, 지금 파일에 이미 있는 날짜(오늘 등)는 지금 값을 유지한다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const commit = process.argv[2] || '04c177a';
const LIVE_PATH = path.join(__dirname, '..', 'data', 'live-daily.json');
const oldJson = execFileSync('git', ['show', `${commit}:data/live-daily.json`], { maxBuffer: 1024 * 1024 * 512 }).toString('utf8');
const old = JSON.parse(oldJson);
const cur = JSON.parse(fs.readFileSync(LIVE_PATH, 'utf8'));

let stores = 0, days = 0;
for (const [code, s] of Object.entries(cur.STORES || {})) {
  const oldCh = (old.STORES[code] && old.STORES[code].channelDays) || {};
  if (!Object.keys(oldCh).length) continue;
  const curCh = s.channelDays || {};
  const merged = { ...oldCh, ...curCh }; // 지금 있는 날짜가 우선
  days += Object.keys(merged).length - Object.keys(curCh).length;
  s.channelDays = merged;
  stores++;
}
fs.writeFileSync(LIVE_PATH + '.tmp', JSON.stringify(cur));
fs.renameSync(LIVE_PATH + '.tmp', LIVE_PATH);
console.log(`채널별 매출 복구 완료: ${stores}개 매장, ${days}일치 되살림 (기준 커밋 ${commit})`);
