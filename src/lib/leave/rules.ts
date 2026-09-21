/**
 * 휴가 규칙 — 계산만 한다. DB 를 읽지 않는다.
 *
 * 여기 있는 함수는 입력이 같으면 결과가 항상 같다.
 * 그래서 scripts/test-leave-rules.ts 로 화면 없이 검증할 수 있다.
 *
 * 규칙 요약 (REQUIREMENTS.md 3절)
 * - 근속은 달 단위로 센다. 입사 후 만 12개월이 되면 1년.
 * - 연차는 사람마다 **자기 입사 기념일에** 받는다 (2026-09-21 변경, 그전에는 1월 1일 일괄).
 *   그 기념일까지 채운 만 연수로 근속 표를 찾는다.
 * - 입사 1년 미만은 한 달을 채울 때마다 1일(최대 11일). 입사 1주년 전날까지 쓸 수 있다.
 *   1주년이 되는 날 곧바로 첫 연차가 나오므로 비는 기간이 없다.
 * - 못 쓴 연차는 다음 입사 기념일 전날에 사라진다. 넘어가지 않는다.
 * - 휴가는 먼저 사라질 일수부터 차감한다.
 * - 여러 날 휴가는 주말·공휴일·회사 휴무일을 빼고 센다.
 */
import type { LeaveType } from "@/lib/db/schema";
import {
  addDays,
  addMonths,
  eachDay,
  fullMonths,
  isWeekend,
  yearOf,
} from "@/lib/dates";

/* ------------------------------------------------------------------ */
/* 휴가 종류                                                            */
/* ------------------------------------------------------------------ */

export const LEAVE_TYPE_INFO: Record<
  LeaveType,
  { label: string; deducts: boolean; halfDay: boolean }
> = {
  ANNUAL: { label: "연차", deducts: true, halfDay: false },
  AM_HALF: { label: "오전 반차", deducts: true, halfDay: true },
  PM_HALF: { label: "오후 반차", deducts: true, halfDay: true },
  CONDOLENCE: { label: "경조사", deducts: false, halfDay: false },
  HEALTH_CHECK: { label: "건강검진", deducts: false, halfDay: false },
  RESERVE: { label: "예비군·민방위", deducts: false, halfDay: false },
  OTHER: { label: "기타", deducts: false, halfDay: false },
};

/** 한 번에 신청할 수 있는 가장 긴 기간(달력 기준 일수) */
export const MAX_SPAN_DAYS = 60;

/** 월차는 최대 11일 */
export const MONTHLY_MAX = 11;

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* 일수 계산                                                            */
/* ------------------------------------------------------------------ */

export function isWorkday(day: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(day) && !holidays.has(day);
}

export function workdaysBetween(
  start: string,
  end: string,
  holidays: ReadonlySet<string>,
): string[] {
  return eachDay(start, end).filter((d) => isWorkday(d, holidays));
}

export type DaysResult =
  | { ok: true; days: number; dates: string[] }
  | { ok: false; error: string };

/**
 * 신청 일수. 반차는 하루만, 0.5일.
 * 차감 없는 휴가(경조사 등)도 기간 표시를 위해 똑같이 센다.
 */
export function computeLeaveDays(
  type: LeaveType,
  start: string,
  end: string,
  holidays: ReadonlySet<string>,
): DaysResult {
  const info = LEAVE_TYPE_INFO[type];

  if (info.halfDay) {
    if (start !== end) {
      return { ok: false, error: "반차는 하루만 신청할 수 있습니다." };
    }
    if (!isWorkday(start, holidays)) {
      return { ok: false, error: "주말·공휴일에는 반차를 쓸 수 없습니다." };
    }
    return { ok: true, days: 0.5, dates: [start] };
  }

  if (end < start) {
    return { ok: false, error: "끝나는 날이 시작하는 날보다 빠릅니다." };
  }
  if (eachDay(start, end).length > MAX_SPAN_DAYS) {
    return {
      ok: false,
      error: `한 번에 ${MAX_SPAN_DAYS}일보다 긴 기간은 신청할 수 없습니다.`,
    };
  }

  const dates = workdaysBetween(start, end, holidays);
  if (dates.length === 0) {
    return { ok: false, error: "고른 기간이 모두 주말·공휴일입니다." };
  }
  return { ok: true, days: dates.length, dates };
}

/* ------------------------------------------------------------------ */
/* 근속과 연차                                                          */
/* ------------------------------------------------------------------ */

export type TenureRuleRow = { fromYear: number; toYear: number; days: number };

export type AnnualEntitlement = {
  /** 연차 연도 = 이 연차를 받은 입사 기념일이 있는 해 */
  year: number;
  /** 받는 날 (= 그해 입사 기념일) */
  start: string;
  /** 사라지는 날 (= 다음 입사 기념일 전날) */
  end: string;
  /** 받는 날 기준 만 근속 개월 */
  tenureMonths: number;
  /** 받는 날 기준 만 근속 연수 (만 12개월 = 1년) */
  tenureYears: number;
  /** 근속 표로 정해진 일수 (조정 전) */
  baseDays: number;
  status:
    | "OK" // 근속 표대로 받음
    | "NOT_HIRED" // 아직 입사 전
    | "UNDER_ONE_YEAR" // 입사한 해 — 1주년 전날까지는 월차(3-3)
    | "NO_RULE"; // 근속 표에 해당 연차가 없음 (관리자 확인 필요)
  rule: TenureRuleRow | null;
};

/* ------------------------------------------------------------------ */
/* 연차 연도 — 입사 기념일에 시작해 다음 기념일 전날에 끝난다              */
/*                                                                      */
/* 사람마다 기간이 다르다. 연도 번호는 그 기간이 시작된 해로 쓴다.         */
/* 예) 2020-03-15 입사 → 2026년 연차 = 2026-03-15 ~ 2027-03-14          */
/* ------------------------------------------------------------------ */

/** 그해의 입사 기념일. 2/29 입사자는 평년이면 2/28 (addMonths 와 같은 규칙) */
export function anniversaryIn(hireDate: string, year: number): string {
  return addMonths(hireDate, 12 * (year - yearOf(hireDate)));
}

export type LeaveYearWindow = { year: number; start: string; end: string };

/** 연차 연도의 기간 */
export function leaveYearWindow(hireDate: string, year: number): LeaveYearWindow {
  return {
    year,
    start: anniversaryIn(hireDate, year),
    end: addDays(anniversaryIn(hireDate, year + 1), -1),
  };
}

/** 그 날짜가 속한 연차 연도 */
export function leaveYearOf(hireDate: string, day: string): number {
  const y = yearOf(day);
  return day < anniversaryIn(hireDate, y) ? y - 1 : y;
}

/** 어떤 날짜 기준 근속 */
export function tenureOn(hireDate: string, on: string) {
  const months = fullMonths(hireDate, on);
  return { months, years: Math.floor(months / 12) };
}

export function findRule(
  rules: readonly TenureRuleRow[],
  years: number,
): TenureRuleRow | null {
  return rules.find((r) => r.fromYear <= years && years <= r.toYear) ?? null;
}

/** 그해 입사 기념일에 받는 연차 */
export function annualEntitlement(
  hireDate: string,
  year: number,
  rules: readonly TenureRuleRow[],
): AnnualEntitlement {
  const { start, end } = leaveYearWindow(hireDate, year);
  if (year < yearOf(hireDate)) {
    return {
      year,
      start,
      end,
      tenureMonths: 0,
      tenureYears: 0,
      baseDays: 0,
      status: "NOT_HIRED",
      rule: null,
    };
  }
  const { months, years } = tenureOn(hireDate, start);
  if (years < 1) {
    // 입사한 해. 1주년 전날까지는 연차가 아니라 월차(3-3)를 쓴다
    return {
      year,
      start,
      end,
      tenureMonths: months,
      tenureYears: years,
      baseDays: 0,
      status: "UNDER_ONE_YEAR",
      rule: null,
    };
  }
  const rule = findRule(rules, years);
  return {
    year,
    start,
    end,
    tenureMonths: months,
    tenureYears: years,
    baseDays: rule ? rule.days : 0,
    status: rule ? "OK" : "NO_RULE",
    rule,
  };
}

/* ------------------------------------------------------------------ */
/* 입사 1년 미만 월차                                                   */
/* ------------------------------------------------------------------ */

export type MonthlyInfo = {
  /** 입사일 */
  validFrom: string;
  /** 입사 1주년 전날. 이날까지 쓸 수 있다 (해가 바뀌어도 유지) */
  validUntil: string;
  /** 1일씩 생기는 날 (입사 후 1~11개월째) */
  accrualDates: string[];
};

export function monthlyInfo(hireDate: string): MonthlyInfo {
  const accrualDates: string[] = [];
  for (let k = 1; k <= MONTHLY_MAX; k += 1) {
    accrualDates.push(addMonths(hireDate, k));
  }
  return {
    validFrom: hireDate,
    validUntil: addDays(addMonths(hireDate, 12), -1),
    accrualDates,
  };
}

/** 그날까지 생긴 월차 일수 */
export function monthlyAccruedOn(info: MonthlyInfo, day: string): number {
  return info.accrualDates.filter((d) => d <= day).length;
}

/* ------------------------------------------------------------------ */
/* 차감 배분                                                            */
/*                                                                      */
/* 휴가 하루하루를 날짜 순서대로 '어느 주머니에서 뺄지' 정한다.            */
/* 주머니: 그 연차 연도의 연차(다음 입사 기념일 전날에 사라짐),            */
/*         월차(입사 1주년 전날에 사라짐)                                */
/* 먼저 사라질 주머니부터 뺀다.                                          */
/* ------------------------------------------------------------------ */

export type LeaveDay = {
  date: string;
  /** 1 또는 0.5 */
  amount: number;
  requestId: string;
  /** 결재 대기 중인가 */
  pending: boolean;
};

export type LedgerInput = {
  hireDate: string;
  rules: readonly TenureRuleRow[];
  /** 연차 연도별 조정 합계 */
  annualAdjust: ReadonlyMap<number, number>;
  /** 월차 조정 합계 */
  monthlyAdjust: number;
  /** 차감 대상 휴가 하루하루 (승인 + 대기) */
  days: readonly LeaveDay[];
};

type Usage = { used: number; pending: number };

export type Allocation = {
  annual: Map<number, Usage>;
  monthly: Usage;
  /** 주머니가 모자라 빼지 못한 일수 (신청 건별) */
  shortByRequest: Map<string, number>;
  shortTotal: number;
};

/** 휴가 하루를 펼친다. 차감 없는 휴가는 빈 배열 */
export function expandLeaveDays(
  req: {
    id: string;
    leaveType: LeaveType;
    startDate: string;
    endDate: string;
    deducts: boolean;
  },
  pending: boolean,
  holidays: ReadonlySet<string>,
): LeaveDay[] {
  if (!req.deducts) return [];
  const info = LEAVE_TYPE_INFO[req.leaveType];
  if (info.halfDay) {
    return [{ date: req.startDate, amount: 0.5, requestId: req.id, pending }];
  }
  return workdaysBetween(req.startDate, req.endDate, holidays).map((date) => ({
    date,
    amount: 1,
    requestId: req.id,
    pending,
  }));
}

export function annualTotal(input: LedgerInput, year: number): number {
  const base = annualEntitlement(input.hireDate, year, input.rules).baseDays;
  return round1(base + (input.annualAdjust.get(year) ?? 0));
}

export function allocate(input: LedgerInput): Allocation {
  const monthly = monthlyInfo(input.hireDate);
  const annual = new Map<number, Usage>();
  const monthlyUsage: Usage = { used: 0, pending: 0 };
  const shortByRequest = new Map<string, number>();
  const annualAllocated = new Map<number, number>();
  let monthlyAllocated = 0;

  const sorted = [...input.days].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(a.pending) - Number(b.pending) ||
      a.requestId.localeCompare(b.requestId),
  );

  for (const day of sorted) {
    let need = day.amount;
    const year = leaveYearOf(input.hireDate, day.date);

    const candidates: { kind: "MONTHLY" | "ANNUAL"; expiry: string; avail: number }[] = [];

    if (day.date >= monthly.validFrom && day.date <= monthly.validUntil) {
      const avail =
        monthlyAccruedOn(monthly, day.date) + input.monthlyAdjust - monthlyAllocated;
      if (avail > 0) {
        candidates.push({ kind: "MONTHLY", expiry: monthly.validUntil, avail });
      }
    }

    const annualAvail = annualTotal(input, year) - (annualAllocated.get(year) ?? 0);
    if (annualAvail > 0) {
      candidates.push({
        kind: "ANNUAL",
        expiry: leaveYearWindow(input.hireDate, year).end,
        avail: annualAvail,
      });
    }

    candidates.sort((a, b) => a.expiry.localeCompare(b.expiry));

    for (const c of candidates) {
      if (need <= 0) break;
      const take = Math.min(need, c.avail);
      if (take <= 0) continue;
      need = round1(need - take);

      if (c.kind === "MONTHLY") {
        monthlyAllocated = round1(monthlyAllocated + take);
        if (day.pending) monthlyUsage.pending = round1(monthlyUsage.pending + take);
        else monthlyUsage.used = round1(monthlyUsage.used + take);
      } else {
        annualAllocated.set(year, round1((annualAllocated.get(year) ?? 0) + take));
        const u = annual.get(year) ?? { used: 0, pending: 0 };
        if (day.pending) u.pending = round1(u.pending + take);
        else u.used = round1(u.used + take);
        annual.set(year, u);
      }
    }

    if (need > 0) {
      shortByRequest.set(
        day.requestId,
        round1((shortByRequest.get(day.requestId) ?? 0) + need),
      );
    }
  }

  let shortTotal = 0;
  for (const v of shortByRequest.values()) shortTotal = round1(shortTotal + v);

  return { annual, monthly: monthlyUsage, shortByRequest, shortTotal };
}

/* ------------------------------------------------------------------ */
/* 화면에 보여줄 잔여                                                    */
/* ------------------------------------------------------------------ */

export type Balance = {
  today: string;
  /** 오늘이 속한 연차 연도. 기간은 annual.entitlement 의 start~end */
  year: number;
  annual: {
    entitlement: AnnualEntitlement;
    adjust: number;
    total: number;
    used: number;
    pending: number;
    remaining: number;
  };
  /** 입사 1년 미만 기간에만 있다 */
  monthly: {
    info: MonthlyInfo;
    accrued: number;
    adjust: number;
    used: number;
    pending: number;
    remaining: number;
    nextAccrual: string | null;
  } | null;
  /** 지금 더 신청할 수 있는 일수 (결재 대기분을 미리 뺀 값) */
  available: number;
  /** 주머니가 모자라 빼지 못한 일수. 0 이 아니면 관리자 확인 필요 */
  shortTotal: number;
};

export function balanceOn(input: LedgerInput, today: string): Balance {
  const alloc = allocate(input);
  const year = leaveYearOf(input.hireDate, today);

  const entitlement = annualEntitlement(input.hireDate, year, input.rules);
  const adjust = input.annualAdjust.get(year) ?? 0;
  const total = round1(entitlement.baseDays + adjust);
  const usage = alloc.annual.get(year) ?? { used: 0, pending: 0 };
  const annualRemaining = round1(total - usage.used - usage.pending);

  let monthly: Balance["monthly"] = null;
  const info = monthlyInfo(input.hireDate);
  if (today >= info.validFrom && today <= info.validUntil) {
    const accrued = monthlyAccruedOn(info, today);
    const remaining = round1(
      accrued + input.monthlyAdjust - alloc.monthly.used - alloc.monthly.pending,
    );
    monthly = {
      info,
      accrued,
      adjust: input.monthlyAdjust,
      used: alloc.monthly.used,
      pending: alloc.monthly.pending,
      remaining,
      nextAccrual: info.accrualDates.find((d) => d > today) ?? null,
    };
  }

  const available = round1(
    Math.max(0, annualRemaining) + Math.max(0, monthly?.remaining ?? 0),
  );

  return {
    today,
    year,
    annual: {
      entitlement,
      adjust,
      total,
      used: usage.used,
      pending: usage.pending,
      remaining: annualRemaining,
    },
    monthly,
    available,
    shortTotal: alloc.shortTotal,
  };
}

/**
 * 새 신청(또는 변경)이 들어가도 모자라지 않는가.
 * 새 신청을 넣기 전과 후의 '빼지 못한 일수'를 비교한다.
 * (날짜 순서로 배분하므로, 모자람이 새 신청이 아니라 뒤쪽 휴가에 잡힐 수 있다)
 */
export function shortageIfAdded(
  input: LedgerInput,
  added: readonly LeaveDay[],
): number {
  const before = allocate(input).shortTotal;
  const after = allocate({ ...input, days: [...input.days, ...added] }).shortTotal;
  return round1(Math.max(0, after - before));
}

/* ------------------------------------------------------------------ */
/* 날짜 겹침                                                            */
/* ------------------------------------------------------------------ */

type Span = { leaveType: LeaveType; startDate: string; endDate: string };

/** 두 휴가가 겹치는가. 같은 날 오전 반차 + 오후 반차는 겹치지 않는다 */
export function spansOverlap(a: Span, b: Span): boolean {
  if (a.startDate > b.endDate || b.startDate > a.endDate) return false;
  const halves = new Set([a.leaveType, b.leaveType]);
  if (
    a.startDate === a.endDate &&
    b.startDate === b.endDate &&
    halves.has("AM_HALF") &&
    halves.has("PM_HALF")
  ) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 결재선 — 「누가 결재하는가」                                           */
/* 🔴 2026-09-21: 직급이 아니라 **사람**이다 (사용자 결정)                */
/* ------------------------------------------------------------------ */

/**
 * 결재선 한 자리에 앉은 사람.
 *
 * 결재선은 **순서가 있는 사람 목록 하나**다 (web_approval_route_steps).
 * 신청자 직급별로 다른 결재선을 두지 않는다 — 판이 하나뿐이라 이 목록이 전부다.
 */
export type RouteMember = {
  /** 결재선 줄의 id (web_approval_route_steps.id). 화면의 [▲][▼][빼기]가 쓴다 */
  routeStepId: string;
  /** 목록에서의 차례. 1부터. 「자신 이후」를 가르는 기준이다 */
  stepNo: number;
  employeeId: string;
  name: string;
  /**
   * 신청 시점의 직급. 결재 단계(web_approval_steps.rank_id)에 함께 적어 둔다 —
   * 표시용이고, 권한 판정에는 쓰지 않는다 (사람으로 판정한다).
   */
  rankId: string;
  rankName: string;
  /** 재직 중인가 (퇴사·삭제가 아닌가). false 면 결재 단계를 **아예 만들지 않는다** */
  active: boolean;
  /** 이 사람의 직급에 결재권(can_approve)이 있는가. 화면이 사실대로 말하는 데만 쓴다 */
  rankCanApprove: boolean;
};

/**
 * 「이 사람이 신청하면 누가 결재하는가」를 값으로만 답한다.
 *
 * 사용자 설계(2026-09-21) 그대로다:
 * - 신청자가 결재선 **안에 있으면 자기 뒤에 있는 사람들**에게만 받는다.
 *   맨 끝 사람이 신청하면 뒤가 없으므로 **결재자가 0명** = 바로 확정.
 * - 신청자가 결재선에 **없으면 목록 전원**에게 받는다.
 *
 * 🔴 data.ts 의 `approvalChainFor` 와 **같은 규칙**이다 — 저쪽은 이 함수에
 * DB 에서 읽은 목록을 먹인다. 규칙을 바꾸면 `npm run test:leave` 의 예시도
 * 함께 고친다.
 *
 * 🔴 **퇴사자도 지우지 않고 돌려준다**(`active: false`). 조용히 빼면 절차가
 * 원래 짧았던 것처럼 보이고 「왜 결재가 안 가지」를 아무도 답할 수 없다.
 * 줄은 그대로 두고 왜 빠지는지를 그 자리에 적는 것이 화면의 몫이다.
 * 실제로 단계를 만들 때만 `liveApprovers` 로 거른다.
 *
 * 넘겨받은 배열을 뒤집어 놓지 않는다 (부르는 쪽이 같은 배열을 다시 쓴다).
 */
export function approversAfter(
  route: readonly RouteMember[],
  applicantEmployeeId: string | null,
): RouteMember[] {
  const ordered = [...route].sort((a, b) => a.stepNo - b.stepNo);
  const index = ordered.findIndex((m) => m.employeeId === applicantEmployeeId);
  return index === -1 ? ordered : ordered.slice(index + 1);
}

/**
 * 실제로 결재가 가는 사람만. 비어 있으면 그 신청은 결재 없이 바로 등록된다.
 * 🔴 0명이 되는 길을 막지 않는다 — 결재선이 비었을 때도, 맨 끝 사람이 신청할
 * 때도, 뒷사람이 모두 퇴사했을 때도 0명이고, 셋 다 바로 확정이 옳다.
 */
export function liveApprovers(chain: readonly RouteMember[]): RouteMember[] {
  return chain.filter((m) => m.active);
}
