/**
 * 휴가 규칙 검증 (DB 없이).  npm run test:leave
 *
 * 규칙을 고치면 여기 예시도 함께 고친다.
 */
import assert from "node:assert/strict";

import { PgDialect } from "drizzle-orm/pg-core";

import { addMonths, fullMonths, calendarWeeks } from "../src/lib/dates";
import type { StepStatus } from "../src/lib/db/schema";
import { japanHolidays } from "../src/lib/jp-holidays";
import {
  canOpenApprovalBox,
  isMyStep,
  myStepCondition,
} from "../src/lib/leave/approval-scope";
import { approvalTurnLabel } from "../src/lib/leave/labels";
import {
  allocate,
  anniversaryIn,
  annualEntitlement,
  approvalProgress,
  approversAfter,
  balanceOn,
  computeLeaveDays,
  expandLeaveDays,
  findNextStepToApprove,
  leaveYearOf,
  leaveYearWindow,
  liveApprovers,
  monthlyAccruedOn,
  monthlyInfo,
  shortageIfAdded,
  spansOverlap,
  type LedgerInput,
  type RouteMember,
} from "../src/lib/leave/rules";

const rules = [
  { fromYear: 1, toYear: 2, days: 10 },
  { fromYear: 3, toYear: 4, days: 11 },
];
const noHolidays = new Set<string>();

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

check("말일 처리: 1월 31일 + 1개월 = 2월 말일", () => {
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonths("2027-01-31", 1), "2027-02-28");
});

check("근속은 만 개월로 센다", () => {
  assert.equal(fullMonths("2024-03-04", "2027-01-01"), 33);
  assert.equal(fullMonths("2024-03-04", "2025-03-03"), 11);
  assert.equal(fullMonths("2024-03-04", "2025-03-04"), 12);
});

check("연차 연도는 입사 기념일에 시작해 다음 기념일 전날에 끝난다", () => {
  assert.deepEqual(leaveYearWindow("2020-03-15", 2026), {
    year: 2026,
    start: "2026-03-15",
    end: "2027-03-14",
  });
  assert.equal(leaveYearOf("2020-03-15", "2027-01-10"), 2026); // 해가 바뀌어도 아직 2026년 연차
  assert.equal(leaveYearOf("2020-03-15", "2027-03-14"), 2026);
  assert.equal(leaveYearOf("2020-03-15", "2027-03-15"), 2027);
  assert.equal(anniversaryIn("2024-02-29", 2027), "2027-02-28"); // 2/29 입사자는 평년에 2/28
});

check("2024-03-04 입사 → 2026년 연차는 2026-03-04 부여, 만 2년 → 1~2년차 10일", () => {
  const e = annualEntitlement("2024-03-04", 2026, rules);
  assert.equal(e.start, "2026-03-04");
  assert.equal(e.end, "2027-03-03");
  assert.equal(e.tenureYears, 2);
  assert.equal(e.baseDays, 10);
  assert.equal(e.status, "OK");
});

check("2024-03-04 입사 → 2027년 연차는 만 3년 → 3~4년차 11일", () => {
  const e = annualEntitlement("2024-03-04", 2027, rules);
  assert.equal(e.start, "2027-03-04");
  assert.equal(e.tenureYears, 3);
  assert.equal(e.baseDays, 11);
});

check("입사한 해는 연차 대신 월차", () => {
  const e = annualEntitlement("2026-11-02", 2026, rules);
  assert.equal(e.status, "UNDER_ONE_YEAR");
  assert.equal(e.baseDays, 0);
});

check("1주년이 되는 날 곧바로 첫 연차가 나온다 (비는 기간 없음)", () => {
  const info = monthlyInfo("2026-11-02");
  const e = annualEntitlement("2026-11-02", 2027, rules);
  assert.equal(info.validUntil, "2027-11-01"); // 월차 마지막 날
  assert.equal(e.start, "2027-11-02"); // 그 다음 날 바로 연차
  assert.equal(e.tenureYears, 1);
  assert.equal(e.baseDays, 10);
  assert.equal(e.status, "OK");
});

check("근속 표에 없는 연차면 NO_RULE (관리자 확인)", () => {
  const e = annualEntitlement("2010-01-01", 2027, rules);
  assert.equal(e.status, "NO_RULE");
});

check("월차: 한 달마다 1일, 최대 11일, 1주년 전날까지", () => {
  const info = monthlyInfo("2026-11-02");
  assert.equal(info.accrualDates.length, 11);
  assert.equal(info.accrualDates[0], "2026-12-02");
  assert.equal(info.accrualDates[10], "2027-10-02");
  assert.equal(info.validUntil, "2027-11-01");
  assert.equal(monthlyAccruedOn(info, "2026-12-01"), 0);
  assert.equal(monthlyAccruedOn(info, "2027-01-02"), 2);
});

check("연차 일수: 주말·공휴일 제외", () => {
  const r1 = computeLeaveDays("ANNUAL", "2027-05-07", "2027-05-10", noHolidays);
  assert.ok(r1.ok && r1.days === 2);
  const r2 = computeLeaveDays("ANNUAL", "2027-05-03", "2027-05-07", new Set(["2027-05-05"]));
  assert.ok(r2.ok && r2.days === 4);
});

check("반차는 하루만, 휴일에는 불가", () => {
  const ok = computeLeaveDays("AM_HALF", "2027-05-06", "2027-05-06", noHolidays);
  assert.ok(ok.ok && ok.days === 0.5);
  assert.equal(computeLeaveDays("PM_HALF", "2027-05-08", "2027-05-08", noHolidays).ok, false);
  assert.equal(computeLeaveDays("PM_HALF", "2027-05-06", "2027-05-07", noHolidays).ok, false);
});

const newbie = (days: LedgerInput["days"], adjust: [number, number][] = []): LedgerInput => ({
  hireDate: "2026-11-02",
  rules,
  annualAdjust: new Map(adjust),
  monthlyAdjust: 0,
  days,
});

check("월차는 해가 바뀌어도 쓸 수 있다 (2026년에 생긴 월차를 2027년에)", () => {
  const b = balanceOn(
    newbie([{ date: "2027-01-15", amount: 1, requestId: "a", pending: false }]),
    "2027-01-20",
  );
  assert.equal(b.monthly?.accrued, 2);
  assert.equal(b.monthly?.used, 1);
  assert.equal(b.monthly?.remaining, 1);
  assert.equal(b.shortTotal, 0);
});

check("생긴 월차보다 많이 쓰면 모자란다", () => {
  // 3/8~3/12 (5일). 3/8 까지 생긴 월차 4일
  const days = ["2027-03-08", "2027-03-09", "2027-03-10", "2027-03-11", "2027-03-12"].map(
    (date) => ({ date, amount: 1, requestId: "b", pending: true }),
  );
  assert.equal(shortageIfAdded(newbie([]), days), 1);
});

check("먼저 사라질 주머니부터: 월차가 연차보다 먼저", () => {
  // 2026-07-01 입사 → 월차는 2027-06-30 까지, 첫 연차는 2027-07-01 에 나온다
  const input: LedgerInput = {
    hireDate: "2026-07-01",
    rules,
    annualAdjust: new Map([[2026, 5]]), // 입사한 해엔 연차가 없으니 관리자 조정분 5일
    monthlyAdjust: 0,
    days: [
      { date: "2027-03-02", amount: 1, requestId: "c", pending: false },
      { date: "2027-08-02", amount: 1, requestId: "d", pending: false },
    ],
  };
  const b = balanceOn(input, "2027-03-10");
  assert.equal(b.year, 2026);
  assert.equal(b.monthly?.used, 1); // 3/2 는 월차에서
  assert.equal(b.annual.total, 5);
  assert.equal(b.annual.used, 0);

  const after = balanceOn(input, "2027-08-10");
  assert.equal(after.year, 2027); // 1주년이 지나 다음 연차 연도
  assert.equal(after.annual.total, 10); // 만 1년 → 1~2년차
  assert.equal(after.annual.used, 1); // 8/2 는 연차에서
});

check("입사 기념일에 걸친 휴가는 두 연차 연도로 나뉘어 차감된다", () => {
  // 2020-03-15 입사 → 2026년 연차는 2027-03-14 까지, 2027년 연차는 2027-03-15 부터
  const days = expandLeaveDays(
    { id: "x", leaveType: "ANNUAL", startDate: "2027-03-11", endDate: "2027-03-18", deducts: true },
    false,
    noHolidays,
  );
  assert.equal(days.length, 6); // 주말 이틀 뺀 6일
  const alloc = allocate({
    hireDate: "2020-03-15",
    rules: [{ fromYear: 1, toYear: 40, days: 10 }],
    annualAdjust: new Map(),
    monthlyAdjust: 0,
    days,
  });
  assert.equal(alloc.annual.get(2026)?.used, 2); // 3/11~3/12
  assert.equal(alloc.annual.get(2027)?.used, 4); // 3/15~3/18
  assert.equal(alloc.shortTotal, 0);
});

check("못 쓴 연차는 다음 입사 기념일 전날에 사라진다", () => {
  const input: LedgerInput = {
    hireDate: "2024-03-04",
    rules,
    annualAdjust: new Map(),
    monthlyAdjust: 0,
    days: [{ date: "2027-06-01", amount: 1, requestId: "e", pending: false }],
  };
  const before = balanceOn(input, "2028-03-03"); // 2027년 연차의 마지막 날
  const after = balanceOn(input, "2028-03-04"); // 2028년 연차의 첫날
  assert.equal(before.year, 2027);
  assert.equal(before.annual.used, 1);
  assert.equal(before.annual.remaining, 10); // 11 - 1
  assert.equal(after.year, 2028);
  assert.equal(after.annual.used, 0);
  assert.equal(after.annual.remaining, 11); // 남았던 10일은 넘어오지 않는다
});

check("같은 날 오전 반차 + 오후 반차는 겹치지 않는다", () => {
  const am = { leaveType: "AM_HALF" as const, startDate: "2027-05-06", endDate: "2027-05-06" };
  const pm = { leaveType: "PM_HALF" as const, startDate: "2027-05-06", endDate: "2027-05-06" };
  const full = { leaveType: "ANNUAL" as const, startDate: "2027-05-05", endDate: "2027-05-07" };
  assert.equal(spansOverlap(am, pm), false);
  assert.equal(spansOverlap(am, full), true);
});

check("달력은 일요일부터 한 주씩", () => {
  const weeks = calendarWeeks("2027-01");
  assert.equal(weeks[0][0], "2026-12-27");
  assert.ok(weeks.every((w) => w.length === 7));
});

// 일본 내각부(内閣府) 공표 목록과 대조
const jpDays = (y: number) => [...japanHolidays(y).keys()].sort();

check("일본 휴일 2025: 일요일 대체휴일이 이어지는 경우(5/4 일 → 5/6)", () => {
  assert.deepEqual(jpDays(2025), [
    "2025-01-01", "2025-01-13", "2025-02-11", "2025-02-23", "2025-02-24", "2025-03-20",
    "2025-04-29", "2025-05-03", "2025-05-04", "2025-05-05", "2025-05-06", "2025-07-21",
    "2025-08-11", "2025-09-15", "2025-09-23", "2025-10-13", "2025-11-03", "2025-11-23",
    "2025-11-24",
  ]);
});

check("일본 휴일 2026: 실버위크 국민의 휴일(9/22)", () => {
  assert.deepEqual(jpDays(2026), [
    "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29",
    "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11",
    "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  ]);
  assert.equal(japanHolidays(2026).get("2026-09-22")?.ja, "国民の休日");
});

check("일본 휴일 2027: 춘분 3/21 일요일 → 3/22 대체휴일", () => {
  assert.deepEqual(jpDays(2027), [
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22",
    "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11",
    "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
  ]);
});

/* ------------------------------------------------------------------ */
/* 결재선 — 순서 있는 사람 목록 하나 (2026-09-21: 직급 → 사람)            */
/* ------------------------------------------------------------------ */

/**
 * 🔴 이 규칙은 data.ts 의 `approvalChainFor` 와 **한 쌍**이다. 저쪽은 DB 에서
 * 목록을 읽어 여기 `approversAfter` 에 그대로 먹인다 — 규칙은 한 곳뿐이다.
 * 설정 화면의 「누가 신청하면 누가 결재하나」 표도 같은 함수를 부른다.
 */
const 사람 = (
  stepNo: number,
  name: string,
  rankName: string,
  opts: { active?: boolean; canApprove?: boolean } = {},
): RouteMember => ({
  routeStepId: `rs${stepNo}`,
  stepNo,
  employeeId: `e-${name}`,
  name,
  rankId: `r-${rankName}`,
  rankName,
  rankCanApprove: opts.canApprove ?? true,
  active: opts.active ?? true,
});

const 김대리 = 사람(1, "김대리", "대리", { canApprove: false });
const 박과장 = 사람(2, "박과장", "과장");
const 이부장 = 사람(3, "이부장", "부장");
const 최대표 = 사람(4, "최대표", "대표");
const 결재선 = [김대리, 박과장, 이부장, 최대표];
const 이름 = (chain: RouteMember[]) => chain.map((m) => m.name);

check("결재선: 결재선에 없는 사람이 신청하면 전원에게 간다", () => {
  assert.deepEqual(이름(approversAfter(결재선, "e-한사원")), [
    "김대리",
    "박과장",
    "이부장",
    "최대표",
  ]);
});

check("결재선: 결재선 안에 있으면 자기 뒤 사람들에게만 간다", () => {
  assert.deepEqual(이름(approversAfter(결재선, 박과장.employeeId)), ["이부장", "최대표"]);
  assert.deepEqual(이름(approversAfter(결재선, 김대리.employeeId)), [
    "박과장",
    "이부장",
    "최대표",
  ]);
});

check("🔴 결재선: 맨 끝 사람이 신청하면 결재자가 0명 = 바로 확정", () => {
  assert.deepEqual(approversAfter(결재선, 최대표.employeeId), []);
});

check("🔴 결재선: 결재선이 비어 있으면 누가 신청하든 결재 없이 바로 등록", () => {
  // 「없음 (바로 등록)」으로 가는 길을 막지 않는다 — 절차를 끄는 유일한 출구다.
  assert.deepEqual(approversAfter([], "e-누구"), []);
  assert.deepEqual(approversAfter([], null), []);
});

check("🔴 결재선: 퇴사자는 줄에 남기되 실제 결재에서는 빠진다", () => {
  const 퇴사한부장 = { ...이부장, active: false };
  const chain = approversAfter([김대리, 박과장, 퇴사한부장, 최대표], 박과장.employeeId);
  // 조용히 지우지 않는다 — 왜 빠지는지 화면이 말할 수 있어야 한다
  assert.deepEqual(이름(chain), ["이부장", "최대표"]);
  assert.deepEqual(이름(liveApprovers(chain)), ["최대표"]);
});

check("🔴 결재선: 뒷사람이 모두 퇴사했으면 결재 없이 바로 등록된다", () => {
  const chain = approversAfter([박과장, { ...이부장, active: false }], 박과장.employeeId);
  assert.equal(chain.length, 1);
  assert.deepEqual(liveApprovers(chain), []);
});

check("결재선: 차례(stepNo)가 뒤죽박죽으로 와도 순서대로 셈한다", () => {
  const 뒤섞음 = [최대표, 김대리, 이부장, 박과장];
  assert.deepEqual(이름(approversAfter(뒤섞음, 김대리.employeeId)), [
    "박과장",
    "이부장",
    "최대표",
  ]);
  // 넘겨받은 배열을 뒤집어 놓지 않는다 (부르는 쪽이 같은 배열을 다시 쓴다)
  assert.deepEqual(이름(뒤섞음), ["최대표", "김대리", "이부장", "박과장"]);
});

check("결재선: 직급에 결재권이 없는 사람도 결재선에 들어간다 (사람으로 정한다)", () => {
  // 김대리의 직급에는 결재권이 없지만, 결재선에 이름이 올랐으므로 결재자다.
  const chain = liveApprovers(approversAfter(결재선, "e-한사원"));
  assert.equal(chain[0].name, "김대리");
  assert.equal(chain[0].rankCanApprove, false);
});

/* ------------------------------------------------------------------ */
/* 결재 차례 — 한 명씩 차례로 (2026-09-21)                               */
/* ------------------------------------------------------------------ */

/**
 * 🔴 `findNextStepToApprove` 는 workflow.ts 가 **승인·건너뛰기 뒤에 다음
 * 차례를 깨울 때**와 **확정할 때**를 가르는 함수다. 여기서 깨지면 신청이
 * 영영 멈추거나(깨우지 못함) 첫 승인만으로 확정된다(열린 단계를 못 셈).
 */
const 단계 = (stepNo: number, status: StepStatus) => ({ stepNo, status });

check("차례: 신청 직후에는 첫 단계가 지금 차례다", () => {
  const steps = [단계(1, "PENDING"), 단계(2, "WAITING"), 단계(3, "WAITING")];
  assert.deepEqual(findNextStepToApprove(steps), 단계(1, "PENDING"));
  assert.deepEqual(approvalProgress(steps), {
    total: 3,
    position: 1,
    current: 단계(1, "PENDING"),
  });
});

check("차례: 앞사람이 승인하면 다음 WAITING 이 차례가 된다", () => {
  const steps = [단계(1, "APPROVED"), 단계(2, "WAITING"), 단계(3, "WAITING")];
  assert.deepEqual(findNextStepToApprove(steps), 단계(2, "WAITING"));
  assert.equal(approvalProgress(steps).position, 2);
});

check("🔴 차례: 건너뛴(SKIPPED) 단계도 넘어간다 — 다음 사람이 깨어난다", () => {
  // 앞사람이 막혀도 뒤가 시작조차 못 하면 신청이 영영 멈춘다.
  const steps = [단계(1, "SKIPPED"), 단계(2, "WAITING"), 단계(3, "WAITING")];
  assert.deepEqual(findNextStepToApprove(steps), 단계(2, "WAITING"));
});

check("🔴 차례: 열린 단계가 하나도 없을 때만 null — 그때가 확정할 때다", () => {
  assert.equal(findNextStepToApprove([단계(1, "APPROVED"), 단계(2, "APPROVED")]), null);
  assert.equal(findNextStepToApprove([단계(1, "APPROVED"), 단계(2, "SKIPPED")]), null);
  assert.equal(findNextStepToApprove([]), null);
  // 🔴 WAITING 이 남아 있으면 확정이 아니다 (PENDING 만 세면 여기서 틀린다)
  assert.deepEqual(
    findNextStepToApprove([단계(1, "APPROVED"), 단계(2, "WAITING")]),
    단계(2, "WAITING"),
  );
});

check("차례: 번호가 뒤죽박죽으로 와도 가장 앞선 것을 고른다", () => {
  const steps = [단계(3, "WAITING"), 단계(1, "APPROVED"), 단계(2, "PENDING")];
  assert.deepEqual(findNextStepToApprove(steps), 단계(2, "PENDING"));
  // 넘겨받은 배열을 뒤집어 놓지 않는다
  assert.deepEqual(steps.map((s) => s.stepNo), [3, 1, 2]);
  assert.equal(approvalProgress(steps).position, 2);
});

check("차례: 결재가 다 끝났으면 지금 차례가 없다 (n/m 은 m/m)", () => {
  const steps = [단계(1, "APPROVED"), 단계(2, "REJECTED")];
  assert.deepEqual(approvalProgress(steps), { total: 2, position: 2, current: null });
  assert.deepEqual(approvalProgress([]), { total: 0, position: 0, current: null });
});

check("차례: 화면 글자 — 「n/m 단계 · 지금 ○○○ 차례」", () => {
  const 화면단계 = (stepNo: number, status: StepStatus, name: string) => ({
    stepNo,
    status,
    approverName: name,
    rankName: "과장",
  });
  assert.equal(
    approvalTurnLabel([
      화면단계(1, "APPROVED", "정민재"),
      화면단계(2, "PENDING", "최동욱"),
      화면단계(3, "WAITING", "윤성호"),
    ]),
    "2/3 단계 · 지금 최동욱 차례",
  );
  // 끝났거나 단계가 없으면 붙일 말이 없다
  assert.equal(approvalTurnLabel([화면단계(1, "APPROVED", "정민재")]), null);
  assert.equal(approvalTurnLabel([]), null);
  // 사람 칸이 빈 옛 단계는 직급 이름으로 (labels.ts 의 stepLabel 과 같은 규칙)
  assert.equal(
    approvalTurnLabel([{ stepNo: 1, status: "PENDING", approverName: null, rankName: "부장" }]),
    "1/1 단계 · 지금 부장 차례",
  );
});

/* ------------------------------------------------------------------ */
/* 「이 결재 단계가 내 것인가」 — 값과 SQL 이 같은 말을 해야 한다            */
/* ------------------------------------------------------------------ */

const 나 = { employeeId: "e-박과장", rankId: "r-과장", isApprover: true };
const 결재권없는나 = { employeeId: "e-김대리", rankId: "r-대리", isApprover: false };

check("결재 권한: 사람이 박힌 단계는 그 사람만 (직급은 보지 않는다)", () => {
  assert.equal(isMyStep({ approverEmployeeId: "e-박과장", rankId: "r-부장" }, 나), true);
  assert.equal(isMyStep({ approverEmployeeId: "e-이부장", rankId: "r-과장" }, 나), false);
});

check("결재 권한: 직급에 결재권이 없어도 내 이름이 박힌 단계는 내 것이다", () => {
  assert.equal(
    isMyStep({ approverEmployeeId: "e-김대리", rankId: "r-대리" }, 결재권없는나),
    true,
  );
  assert.equal(isMyStep({ approverEmployeeId: null, rankId: "r-대리" }, 결재권없는나), false);
});

check("🔴 전환: 사람 칸이 빈 옛 단계는 예전처럼 직급으로 판정한다", () => {
  // 사람 기반으로 바뀌기 전에 만들어져 **대기 중이던** 신청이다.
  // 이 줄이 없으면 그 신청이 모든 결재함에서 조용히 사라진다.
  assert.equal(isMyStep({ approverEmployeeId: null, rankId: "r-과장" }, 나), true);
  assert.equal(isMyStep({ approverEmployeeId: null, rankId: "r-부장" }, 나), false);
});

check("🔴 전환: 결재함 질의의 SQL 에도 옛 단계(사람 칸이 빈 것) 갈래가 있다", () => {
  // 값으로 답하는 isMyStep 과 결재함을 거르는 SQL 이 어긋나면, 목록에는
  // 보이는데 누르면 막히거나 그 반대가 된다. SQL 을 직접 들여다본다.
  const { sql: text, params } = new PgDialect().sqlToQuery(myStepCondition(나));
  assert.match(text, /"approver_employee_id" = \$1/);
  assert.match(text, /"approver_employee_id" is null and .*"rank_id" = \$2/);
  assert.deepEqual(params, ["e-박과장", "r-과장"]);
});

check("결재함 질의: 직급에 결재권이 없으면 내 이름이 박힌 단계만 본다", () => {
  const { sql: text, params } = new PgDialect().sqlToQuery(myStepCondition(결재권없는나));
  assert.match(text, /"approver_employee_id" = \$1/);
  assert.equal(/rank_id/.test(text), false);
  assert.deepEqual(params, ["e-김대리"]);
});

/* ------------------------------------------------------------------ */
/* 「결재함 문을 열 수 있는가」 — 결재 권한과 **다른 질문**이다 (2026-09-22) */
/*                                                                      */
/* 인가 판정이라 시험을 남긴다. 고쳐진 결함: 결재선에 이름이 올라 자기      */
/* 차례가 되고 알림까지 받는 사람이, 직급에 결재권이 없으면 머리말에       */
/* 「결재함」 메뉴를 얻지 못해 들어갈 길이 없었다.                         */
/* ------------------------------------------------------------------ */

check("결재함 문: 직급에 결재권이 있으면 열린다 (결재선에 없어도)", () => {
  assert.equal(
    canOpenApprovalBox({ rankCanApprove: true, onApprovalRoute: false }),
    true,
  );
});

check("🔴 결재함 문: 직급에 결재권이 없어도 결재선에 이름이 올라 있으면 열린다", () => {
  // 고쳐진 결함 그 자체다. 이 줄이 false 로 돌아가면 그 사람은 종에 알림이
  // 떠도 들어갈 메뉴가 없다.
  assert.equal(
    canOpenApprovalBox({ rankCanApprove: false, onApprovalRoute: true }),
    true,
  );
});

check("결재함 문: 직급에도 결재선에도 없으면 열리지 않는다", () => {
  assert.equal(
    canOpenApprovalBox({ rankCanApprove: false, onApprovalRoute: false }),
    false,
  );
});

check("🔴 문이 열려도 결재 권한은 넓어지지 않는다 — 남의 단계는 내 것이 아니다", () => {
  // 결재선에만 이름이 오른 사람(직급 결재권 없음). 문은 열린다…
  const 결재선에만오른나 = { employeeId: "e-김대리", rankId: "r-대리", isApprover: false };
  assert.equal(canOpenApprovalBox({ rankCanApprove: false, onApprovalRoute: true }), true);
  // …그래도 남의 이름이 박힌 단계는 내 것이 아니다.
  assert.equal(
    isMyStep({ approverEmployeeId: "e-이부장", rankId: "r-부장" }, 결재선에만오른나),
    false,
  );
  // 🔴 그리고 **사람 칸이 빈 옛 직급 단계**도 보이지 않는다. isApprover 의 뜻
  // (「옛 직급 단계도 볼 수 있는가」)을 결재함 문과 함께 넓히지 않았다는 것 —
  // 넓혔다면 자기 직급에 걸린 남의 옛 단계가 제 결재함에 떴을 것이다.
  assert.equal(
    isMyStep({ approverEmployeeId: null, rankId: "r-대리" }, 결재선에만오른나),
    false,
  );
  const { sql: text, params } = new PgDialect().sqlToQuery(myStepCondition(결재선에만오른나));
  assert.equal(/rank_id/.test(text), false);
  assert.deepEqual(params, ["e-김대리"]);
});

console.log(`\n${passed}개 통과`);

