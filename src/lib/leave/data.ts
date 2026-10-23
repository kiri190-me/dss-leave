/**
 * 휴가 데이터 읽기. 계산 규칙은 rules.ts, 쓰기(신청·결재)는 workflow.ts 에 있다.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { EmployeeWithRank, Viewer } from "@/lib/auth/guards";
import { canSeeReason } from "@/lib/auth/guards";
import { todayKst } from "@/lib/dates";
import { db, type Tx } from "@/lib/db";
import { isUuid } from "@/lib/ids";
import {
  webApprovalRouteSteps,
  webApprovalSteps,
  webEmployees,
  webHolidays,
  webLeaveAdjustments,
  webLeaveRequests,
  webLeaveSettings,
  webRanks,
  webTenureRules,
  webUsers,
  type ApprovalStep,
  type Holiday,
  type LeaveRequest,
  type Rank,
} from "@/lib/db/schema";
// 🔴 **타입만** 빌려 온다(import type — 남는 코드가 없다). 「결재가 생겼다」를
//    포털에 알리는 판단이 제 계약으로 들고 있는 모양이고, 아래 조회가 그
//    모양으로 돌려준다. 두 벌로 적지 않으려는 것이다.
import type { ApprovalNudgeCandidate } from "./approval-nudge";
import { myStepCondition, type Decider } from "./approval-scope";
import { approvalTurnLabel } from "./labels";
import {
  DEFAULT_SUMMER_DAYS,
  SUMMER_LEAVE_TYPES,
  approversAfter,
  balanceOn,
  expandLeaveDays,
  liveApprovers,
  round1,
  type Balance,
  type LedgerInput,
  type RouteMember,
  type TenureRuleRow,
} from "./rules";

type Q = typeof db | Tx;

/** 휴가로 '살아 있는' 신청: 새 신청·날짜 변경 중 승인됐거나 결재 중인 것 */
const LIVE_KINDS = ["NEW", "CHANGE"] as const;
const LIVE_STATUSES = ["APPROVED", "PENDING"] as const;

/* ------------------------------------------------------------------ */
/* 기준 정보                                                            */
/* ------------------------------------------------------------------ */

export async function loadHolidays(from?: string, to?: string): Promise<Holiday[]> {
  return db
    .select()
    .from(webHolidays)
    .where(
      and(
        eq(webHolidays.isDeleted, false),
        from ? gte(webHolidays.day, from) : undefined,
        to ? lte(webHolidays.day, to) : undefined,
      ),
    )
    .orderBy(asc(webHolidays.day));
}

export async function loadHolidaySet(): Promise<Set<string>> {
  const rows = await loadHolidays();
  return new Set(rows.map((h) => h.day));
}

export async function loadRules(): Promise<TenureRuleRow[]> {
  const rows = await db
    .select({
      fromYear: webTenureRules.fromYear,
      toYear: webTenureRules.toYear,
      days: webTenureRules.days,
    })
    .from(webTenureRules)
    .where(eq(webTenureRules.isDeleted, false))
    .orderBy(asc(webTenureRules.fromYear));
  return rows;
}

/**
 * 회사 전체 휴가 설정. **한 줄짜리 표**다 (사람마다·해마다 다르지 않다).
 *
 * 🔴 줄이 아직 없으면 기본값을 돌려준다 — 운영 시작 전이라 표가 비어 있어도
 * 잔액 계산과 화면이 그대로 돌아가야 한다. 기본값은 rules.ts 한 곳에 있다.
 */
export async function loadLeaveSettings(q: Q = db): Promise<{ summerDays: number }> {
  const [row] = await q
    .select({ summerDays: webLeaveSettings.summerDays })
    .from(webLeaveSettings)
    .limit(1);
  return { summerDays: row?.summerDays ?? DEFAULT_SUMMER_DAYS };
}

export async function loadRanks(): Promise<Rank[]> {
  return db
    .select()
    .from(webRanks)
    .where(eq(webRanks.isDeleted, false))
    .orderBy(asc(webRanks.sortOrder));
}

/* ------------------------------------------------------------------ */
/* 잔여 일수                                                            */
/* ------------------------------------------------------------------ */

export async function loadLedgerInput(
  employee: { id: string; hireDate: string },
  holidays: ReadonlySet<string>,
  rules: readonly TenureRuleRow[],
  opts: { excludeRequestIds?: string[]; q?: Q; summerDays?: number } = {},
): Promise<LedgerInput> {
  const q = opts.q ?? db;
  const exclude = opts.excludeRequestIds ?? [];
  const summerDays = opts.summerDays ?? (await loadLeaveSettings(q)).summerDays;

  const requests = await q
    .select()
    .from(webLeaveRequests)
    .where(
      and(
        eq(webLeaveRequests.employeeId, employee.id),
        eq(webLeaveRequests.isDeleted, false),
        // 어느 주머니에선가 빠지는 휴가만. 연차 쪽은 저장된 deducts 로 가르고,
        // 여름휴가는 **제 잔액**이라 그 칸이 false 다 — 종류로 함께 집어 온다.
        or(
          eq(webLeaveRequests.deducts, true),
          inArray(webLeaveRequests.leaveType, SUMMER_LEAVE_TYPES),
        ),
        inArray(webLeaveRequests.kind, [...LIVE_KINDS]),
        // 날짜 변경 신청은 승인되기 전까지 잔여에 넣지 않는다 (원래 휴가가 아직 살아 있다)
        or(
          eq(webLeaveRequests.status, "APPROVED"),
          and(eq(webLeaveRequests.status, "PENDING"), eq(webLeaveRequests.kind, "NEW")),
        ),
      ),
    );

  const adjustments = await q
    .select()
    .from(webLeaveAdjustments)
    .where(
      and(
        eq(webLeaveAdjustments.employeeId, employee.id),
        eq(webLeaveAdjustments.isDeleted, false),
      ),
    );

  const annualAdjust = new Map<number, number>();
  let monthlyAdjust = 0;
  for (const a of adjustments) {
    if (a.bucket === "ANNUAL" && a.year != null) {
      annualAdjust.set(a.year, round1((annualAdjust.get(a.year) ?? 0) + a.days));
    } else if (a.bucket === "MONTHLY") {
      monthlyAdjust = round1(monthlyAdjust + a.days);
    }
  }

  return {
    hireDate: employee.hireDate,
    rules,
    annualAdjust,
    monthlyAdjust,
    summerDays,
    days: requests
      .filter((r) => !exclude.includes(r.id))
      .flatMap((r) => expandLeaveDays(r, r.status === "PENDING", holidays)),
  };
}

/** 잔여 일수. on 을 주면 그날 기준 (예: 지난해 인쇄는 12월 31일 기준) */
export async function getBalance(
  employee: { id: string; hireDate: string },
  ctx?: {
    holidays: ReadonlySet<string>;
    rules: readonly TenureRuleRow[];
    /** 여러 사람의 잔액을 줄줄이 셀 때 한 번만 읽어 넘기면 된다 */
    summerDays?: number;
  },
  on?: string,
): Promise<Balance> {
  const holidays = ctx?.holidays ?? (await loadHolidaySet());
  const rules = ctx?.rules ?? (await loadRules());
  const input = await loadLedgerInput(employee, holidays, rules, {
    summerDays: ctx?.summerDays,
  });
  return balanceOn(input, on ?? todayKst());
}

/* ------------------------------------------------------------------ */
/* 결재선 — 순서 있는 사람 목록 하나 (2026-09-21: 직급 → 사람)            */
/* ------------------------------------------------------------------ */

/**
 * 결재선 전체. 순서대로, **퇴사자도 지우지 않고** 돌려준다.
 * 설정 화면은 이 목록을 그대로 그리고, 결재선 계산은 여기서 걸러 쓴다.
 */
export async function loadApprovalRoute(q: Q = db): Promise<RouteMember[]> {
  const rows = await q
    .select({
      routeStepId: webApprovalRouteSteps.id,
      stepNo: webApprovalRouteSteps.stepNo,
      employeeId: webEmployees.id,
      name: webEmployees.name,
      rankId: webEmployees.rankId,
      rankName: webRanks.name,
      rankCanApprove: webRanks.canApprove,
      isActive: webEmployees.isActive,
      isDeleted: webEmployees.isDeleted,
    })
    .from(webApprovalRouteSteps)
    .innerJoin(webEmployees, eq(webEmployees.id, webApprovalRouteSteps.approverEmployeeId))
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .where(eq(webApprovalRouteSteps.isDeleted, false))
    .orderBy(asc(webApprovalRouteSteps.stepNo), asc(webApprovalRouteSteps.createdAt));

  return rows.map((r) => ({
    routeStepId: r.routeStepId,
    stepNo: r.stepNo,
    employeeId: r.employeeId,
    name: r.name,
    rankId: r.rankId,
    rankName: r.rankName,
    rankCanApprove: r.rankCanApprove,
    active: r.isActive && !r.isDeleted,
  }));
}

/**
 * 이 사람이 지금 신청하면 **실제로 결재할 사람들**.
 *
 * 규칙은 `rules.ts` 의 `approversAfter` 한 곳에 있다 (여기는 DB 에서 목록을
 * 읽어 먹이기만 한다): 결재선 안에 있으면 **자기 뒤 사람들**, 없으면 **전원**.
 * 퇴사·삭제된 사람은 `liveApprovers` 가 뺀다 — 남는 사람이 없으면 빈 배열이고,
 * 그것은 **결재 없이 바로 등록**을 뜻한다 (맨 끝 사람의 신청도 마찬가지다).
 */
export async function approvalChainFor(
  applicant: Pick<EmployeeWithRank, "id">,
  q: Q = db,
): Promise<RouteMember[]> {
  const route = await loadApprovalRoute(q);
  return liveApprovers(approversAfter(route, applicant.id));
}

/** 결재선에 넣을 수 있는 사람 — 재직 중인 직원 전부 (이미 든 사람은 화면이 뺀다) */
export async function loadRouteCandidates(): Promise<
  { id: string; name: string; rankName: string; rankCanApprove: boolean }[]
> {
  const rows = await db
    .select({
      id: webEmployees.id,
      name: webEmployees.name,
      rankName: webRanks.name,
      rankCanApprove: webRanks.canApprove,
    })
    .from(webEmployees)
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .where(and(eq(webEmployees.isDeleted, false), eq(webEmployees.isActive, true)))
    .orderBy(desc(webRanks.sortOrder), asc(webEmployees.name));
  return rows;
}

/* ------------------------------------------------------------------ */
/* 결재 단계 (진행 표시용)                                               */
/* ------------------------------------------------------------------ */

export type StepView = ApprovalStep & {
  rankName: string;
  /**
   * 이 단계를 맡은 사람. 사람으로 박힌 뒤로는 늘 있고, 전환 전에 만들어진
   * 옛 단계(직급에 걸린 것)만 null 이다 — 그때는 화면이 직급을 보여 준다.
   */
  approverName: string | null;
  decidedByName: string | null;
};

export async function stepsFor(requestIds: string[]): Promise<Map<string, StepView[]>> {
  const map = new Map<string, StepView[]>();
  if (requestIds.length === 0) return map;
  const decider = alias(webEmployees, "decider");
  const approver = alias(webEmployees, "approver");
  const rows = await db
    .select({
      step: webApprovalSteps,
      rankName: webRanks.name,
      approverName: approver.name,
      decidedByName: decider.name,
    })
    .from(webApprovalSteps)
    .innerJoin(webRanks, eq(webRanks.id, webApprovalSteps.rankId))
    .leftJoin(approver, eq(approver.id, webApprovalSteps.approverEmployeeId))
    .leftJoin(decider, eq(decider.id, webApprovalSteps.decidedByEmployeeId))
    .where(
      and(
        inArray(webApprovalSteps.requestId, requestIds),
        eq(webApprovalSteps.isDeleted, false),
      ),
    )
    .orderBy(asc(webApprovalSteps.stepNo));
  for (const r of rows) {
    const list = map.get(r.step.requestId) ?? [];
    list.push({
      ...r.step,
      rankName: r.rankName,
      approverName: r.approverName,
      decidedByName: r.decidedByName,
    });
    map.set(r.step.requestId, list);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 달력                                                                 */
/* ------------------------------------------------------------------ */

export type CalendarEntry = {
  requestId: string;
  employeeId: string;
  employeeName: string;
  rankName: string;
  leaveType: LeaveRequest["leaveType"];
  kind: LeaveRequest["kind"];
  startDate: string;
  endDate: string;
  days: number;
  pending: boolean;
  /**
   * 결재 중이면 「2/3 단계 · 지금 최동욱 차례」. 승인된 휴가나 단계가 없는
   * 신청은 null. 한 명씩 차례로 결재하므로 「대기」만으로는 누구 차례인지
   * 알 수 없어 함께 싣는다 (labels.ts 의 approvalTurnLabel).
   */
  turnLabel: string | null;
  /** 볼 권한이 없으면 null */
  reason: string | null;
  isMine: boolean;
};

/** 기간과 겹치는 휴가 (승인 + 결재 중). 사유는 권한이 있을 때만 싣는다 */
export async function calendarEntries(
  from: string,
  to: string,
  viewer: Viewer,
): Promise<CalendarEntry[]> {
  const rows = await db
    .select({ req: webLeaveRequests, name: webEmployees.name, rankName: webRanks.name, rankOrder: webRanks.sortOrder })
    .from(webLeaveRequests)
    .innerJoin(webEmployees, eq(webEmployees.id, webLeaveRequests.employeeId))
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .where(
      and(
        eq(webLeaveRequests.isDeleted, false),
        inArray(webLeaveRequests.kind, [...LIVE_KINDS]),
        inArray(webLeaveRequests.status, [...LIVE_STATUSES]),
        lte(webLeaveRequests.startDate, to),
        gte(webLeaveRequests.endDate, from),
      ),
    )
    .orderBy(desc(webRanks.sortOrder), asc(webEmployees.name), asc(webLeaveRequests.startDate));

  // 결재 중인 것만 단계를 읽는다 — 확정된 휴가에는 보여 줄 차례가 없다
  const steps = await stepsFor(
    rows.filter((r) => r.req.status === "PENDING").map((r) => r.req.id),
  );

  return rows.map((r) => ({
    requestId: r.req.id,
    employeeId: r.req.employeeId,
    employeeName: r.name,
    rankName: r.rankName,
    leaveType: r.req.leaveType,
    kind: r.req.kind,
    startDate: r.req.startDate,
    endDate: r.req.endDate,
    days: r.req.days,
    pending: r.req.status === "PENDING",
    turnLabel:
      r.req.status === "PENDING" ? approvalTurnLabel(steps.get(r.req.id) ?? []) : null,
    reason: canSeeReason(viewer, r.req.employeeId) ? r.req.reason : null,
    isMine: viewer.employee?.id === r.req.employeeId,
  }));
}

/* ------------------------------------------------------------------ */
/* 신청 목록                                                            */
/* ------------------------------------------------------------------ */

export type RequestView = LeaveRequest & {
  steps: StepView[];
  target: LeaveRequest | null;
  /** 이 휴가를 대상으로 결재 중인 변경·취소 신청 */
  openFollowUp: LeaveRequest | null;
};

async function attach(requests: LeaveRequest[]): Promise<RequestView[]> {
  const ids = requests.map((r) => r.id);
  const targetIds = requests
    .map((r) => r.targetRequestId)
    .filter((x): x is string => Boolean(x));

  const [steps, targets, followUps] = await Promise.all([
    stepsFor(ids),
    targetIds.length
      ? db.select().from(webLeaveRequests).where(inArray(webLeaveRequests.id, targetIds))
      : Promise.resolve([] as LeaveRequest[]),
    ids.length
      ? db
          .select()
          .from(webLeaveRequests)
          .where(
            and(
              inArray(webLeaveRequests.targetRequestId, ids),
              eq(webLeaveRequests.status, "PENDING"),
              eq(webLeaveRequests.isDeleted, false),
            ),
          )
      : Promise.resolve([] as LeaveRequest[]),
  ]);

  const targetMap = new Map(targets.map((t) => [t.id, t]));
  const followMap = new Map(followUps.map((f) => [f.targetRequestId!, f]));

  return requests.map((r) => ({
    ...r,
    steps: steps.get(r.id) ?? [],
    target: r.targetRequestId ? targetMap.get(r.targetRequestId) ?? null : null,
    openFollowUp: followMap.get(r.id) ?? null,
  }));
}

/** 내 신청: 이번 연차 연도가 시작된 날 이후 휴가 + 결재 중인 것 전부 */
export async function myRequests(employeeId: string, since: string): Promise<RequestView[]> {
  const rows = await db
    .select()
    .from(webLeaveRequests)
    .where(
      and(
        eq(webLeaveRequests.employeeId, employeeId),
        eq(webLeaveRequests.isDeleted, false),
        or(
          gte(webLeaveRequests.endDate, since),
          eq(webLeaveRequests.status, "PENDING"),
        ),
      ),
    )
    .orderBy(desc(webLeaveRequests.startDate), desc(webLeaveRequests.createdAt));
  return attach(rows);
}

/** 그 기간에 걸친 휴가 (새 신청·날짜 변경분). 인쇄용 — 날짜 순 */
export async function requestsInWindow(
  employeeId: string,
  from: string,
  to: string,
): Promise<RequestView[]> {
  const rows = await db
    .select()
    .from(webLeaveRequests)
    .where(
      and(
        eq(webLeaveRequests.employeeId, employeeId),
        eq(webLeaveRequests.isDeleted, false),
        inArray(webLeaveRequests.kind, [...LIVE_KINDS]),
        lte(webLeaveRequests.startDate, to),
        gte(webLeaveRequests.endDate, from),
      ),
    )
    .orderBy(asc(webLeaveRequests.startDate), asc(webLeaveRequests.createdAt));
  return attach(rows);
}

export async function requestById(id: string): Promise<RequestView | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(webLeaveRequests)
    .where(and(eq(webLeaveRequests.id, id), eq(webLeaveRequests.isDeleted, false)))
    .limit(1);
  if (!rows[0]) return null;
  return (await attach(rows))[0];
}

/* ------------------------------------------------------------------ */
/* 결재함                                                               */
/* ------------------------------------------------------------------ */

export type ApprovalItem = RequestView & {
  stepId: string;
  applicantName: string;
  applicantRank: string;
  applicantHireDate: string;
};

/** 결재함 질의가 쓰는 「나」. employee 가 붙은 Viewer 에서만 만든다 */
function deciderOf(employee: EmployeeWithRank, isApprover: boolean): Decider {
  return { employeeId: employee.id, rankId: employee.rankId, isApprover };
}

/**
 * **지금 내 차례인 신청**을 고르는 조건. 아래 셋이 이 한 문장을 함께 쓴다 —
 * 결재함 목록(pendingForApprover) · 결재함 건수(pendingCountFor) · 포털에 내주는
 * 알림(pendingApprovalNotifications).
 *
 * 🔴 **사본을 만들지 마라.** 「이 단계가 내 것인가」는 approval-scope.ts 한 곳이
 * 답하고(myStepCondition), 「지금 차례인가」는 여기 한 곳이 답한다. 셋 중 하나만
 * 어긋나면 「결재함에는 보이는데 눌러도 안 된다」거나 「알림은 왔는데 결재함이
 * 비어 있다」가 된다.
 *
 * 무엇을 보는가:
 *  · 단계가 `PENDING` — 🔴 `WAITING` 은 아직 내 차례가 아니다(한 명씩 차례로
 *    가므로 앞사람이 처리해야 깨어난다). `APPROVED`·`REJECTED`·`SKIPPED` 는
 *    이미 끝난 단계다.
 *  · 그 단계가 내 것이다 (approval-scope.ts).
 *  · 신청 자체도 아직 결재 중이다.
 *  · 🔴 내 신청은 뺀다 — 자기 휴가를 자기가 결재하지 않는다.
 */
export function myPendingApprovalWhere(me: Decider): SQL {
  return and(
    eq(webApprovalSteps.status, "PENDING"),
    eq(webApprovalSteps.isDeleted, false),
    myStepCondition(me),
    eq(webLeaveRequests.status, "PENDING"),
    eq(webLeaveRequests.isDeleted, false),
    ne(webLeaveRequests.employeeId, me.employeeId),
  )!;
}

/**
 * 내 승인을 기다리는 결재 (내 신청은 빼고).
 *
 * 🔴 「내 것인가」의 판정은 `approval-scope.ts` 한 곳에 있다 — 사람으로 박힌
 * 단계는 그 사람의 것이고, 옛 단계(사람 칸이 빈 것)는 예전처럼 직급으로
 * 판정한다. 뒤엣것이 없으면 **전환 순간 대기 중이던 신청이 모든 결재함에서
 * 사라진다.**
 *
 * 🔴 문 앞의 `isApprover` 검사를 뺐다. 결재선에 이름이 오른 사람은 직급에
 * 결재권이 없어도 자기 단계를 결재해야 하기 때문이다. 대신 질의가 **내
 * 단계만** 돌려주므로 남의 것이 보일 길은 없다 (옛 직급 단계는 조건 안에서
 * 여전히 `isApprover` 를 함께 본다).
 */
export async function pendingForApprover(viewer: Viewer): Promise<ApprovalItem[]> {
  if (!viewer.employee) return [];
  const rows = await db
    .select({
      stepId: webApprovalSteps.id,
      req: webLeaveRequests,
      applicantName: webEmployees.name,
      applicantRank: webRanks.name,
      applicantHireDate: webEmployees.hireDate,
    })
    .from(webApprovalSteps)
    .innerJoin(webLeaveRequests, eq(webLeaveRequests.id, webApprovalSteps.requestId))
    .innerJoin(webEmployees, eq(webEmployees.id, webLeaveRequests.employeeId))
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .where(myPendingApprovalWhere(deciderOf(viewer.employee, viewer.isApprover)))
    .orderBy(asc(webLeaveRequests.startDate));

  const views = await attach(rows.map((r) => r.req));
  return views.map((v, i) => ({
    ...v,
    stepId: rows[i].stepId,
    applicantName: rows[i].applicantName,
    applicantRank: rows[i].applicantRank,
    applicantHireDate: rows[i].applicantHireDate,
  }));
}

export async function pendingCountFor(viewer: Viewer): Promise<number> {
  if (!viewer.employee) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webApprovalSteps)
    .innerJoin(webLeaveRequests, eq(webLeaveRequests.id, webApprovalSteps.requestId))
    .where(myPendingApprovalWhere(deciderOf(viewer.employee, viewer.isApprover)));
  return row?.n ?? 0;
}

/**
 * 포털에 내줄 알림 목록 — 결재함과 **같은 조건**으로 고른 뒤, 한 줄에 실을
 * 것만 얇게 읽는다.
 *
 * pendingForApprover 를 그대로 쓰지 않는 이유는 그쪽이 화면용이기 때문이다 —
 * 단계 이력·대상 휴가·뒤따르는 신청까지 붙이고(attach), 신청자마다 잔여 일수를
 * 다시 계산한다. 알림 한 줄에는 이름과 기간뿐이라 그 값을 치를 이유가 없다.
 * 🔴 **고르는 조건은 한 문장을 함께 쓴다**(myPendingApprovalWhere).
 *
 * 🔴 사유(reason)를 읽지 않는다 — 이 목록은 포털을 거쳐 다른 시스템의 화면에
 * 그려진다(leave/portal-notifications.ts 의 그 주석).
 */
export type PendingApprovalNotification = {
  stepId: string;
  applicantName: string;
  kind: LeaveRequest["kind"];
  leaveType: LeaveRequest["leaveType"];
  startDate: string;
  endDate: string;
  days: number;
};

export async function pendingApprovalNotifications(
  me: Decider,
): Promise<PendingApprovalNotification[]> {
  return db
    .select({
      stepId: webApprovalSteps.id,
      applicantName: webEmployees.name,
      kind: webLeaveRequests.kind,
      leaveType: webLeaveRequests.leaveType,
      startDate: webLeaveRequests.startDate,
      endDate: webLeaveRequests.endDate,
      days: webLeaveRequests.days,
    })
    .from(webApprovalSteps)
    .innerJoin(webLeaveRequests, eq(webLeaveRequests.id, webApprovalSteps.requestId))
    .innerJoin(webEmployees, eq(webEmployees.id, webLeaveRequests.employeeId))
    .where(myPendingApprovalWhere(me))
    .orderBy(asc(webLeaveRequests.startDate));
}

/**
 * 통합 승인함(`dss-approvals`)에 내줄 목록 — **같은 조건**(myPendingApprovalWhere),
 * 위 알림과 거의 같은 투영이지만 `requestedAt` 을 더 싣는다.
 *
 * 🔴 `pendingApprovalNotifications` 에 칸을 얹지 않고 **따로 둔 것**은, 그 함수가
 * 이미 포털 종 통로가 쓰고 있어 거기 칸을 늘리면 종 쪽도 다시 시험해야 하기
 * 때문이다 — 이 시스템의 질의 셋(목록·건수·알림)이 이미 같은 모양으로 나뉘어
 * 있는 것과 같은 자리다. 조건은 넷 다 `myPendingApprovalWhere` 하나를 그대로
 * 부른다 — 승인함만 다른 문장을 쓰면 「알림에는 떴는데 승인함엔 없다」가 된다.
 */
export type PendingApprovalForPortal = PendingApprovalNotification & {
  /**
   * 이 신청이 지금 결재를 기다리기 시작한 때(web_leave_requests.created_at).
   * 변경·취소 요청은 원본과 **다른 신청 행**이라 다시 올린 시각이 그대로 찍힌다
   * — 기다린 시간을 실제로 센 값이다.
   */
  requestedAt: Date;
};

export async function pendingApprovalsForPortal(
  me: Decider,
): Promise<PendingApprovalForPortal[]> {
  return db
    .select({
      stepId: webApprovalSteps.id,
      applicantName: webEmployees.name,
      kind: webLeaveRequests.kind,
      leaveType: webLeaveRequests.leaveType,
      startDate: webLeaveRequests.startDate,
      endDate: webLeaveRequests.endDate,
      days: webLeaveRequests.days,
      requestedAt: webLeaveRequests.createdAt,
    })
    .from(webApprovalSteps)
    .innerJoin(webLeaveRequests, eq(webLeaveRequests.id, webApprovalSteps.requestId))
    .innerJoin(webEmployees, eq(webEmployees.id, webLeaveRequests.employeeId))
    .where(myPendingApprovalWhere(me))
    .orderBy(asc(webLeaveRequests.createdAt));
}

/* ------------------------------------------------------------------ */
/* 거꾸로 — 「이 결재는 누구에게 생겼나」 (포털 쿡 찌르기, 2026-10-24)     */
/* ------------------------------------------------------------------ */

/**
 * 결재를 기다리는 단계에 **걸릴 수 있는 사람** 한 줄.
 *
 * 🔴 모양을 여기서 다시 적지 않는다 — 이 줄을 받아 쓰는 판단
 * (leave/approval-nudge.ts)이 제 계약으로 들고 있고, 여기서는 **그것을 그대로
 * 빌려 쓴다.** 두 벌로 적으면 칸 하나가 어긋나도 tsc 가 침묵하는 자리가
 * 생긴다(같은 이름의 타입 둘은 모양이 같은 동안 서로 통한다).
 *
 * 🔴 「걸린다」가 아니라 **「걸릴 수 있다」**다. 아래 조회는 일부러 넓게 고르고,
 * 정말 그 사람 차례인지는 `hasPendingApprovalFor` 가 **공용 조건**
 * (`myPendingApprovalWhere`)으로 다시 가른다. 까닭은 그 함수 머리말에 있다.
 */
export type { ApprovalNudgeCandidate };

/**
 * 이 신청의 **지금 열린 단계**에 걸릴 수 있는 사람들. 포털을 쿡 찌르기 직전에
 * 「누구에게 생겼나」를 모으는 자리다.
 *
 * ── 🔴 왜 일부러 넓게 고르는가 ──────────────────────────────────────────
 * 「이 사람이 지금 이 신청을 결재할 차례인가」의 답은 이 저장소에 **한 곳**
 * 뿐이다(`myPendingApprovalWhere` → `myStepCondition`). 그것을 거꾸로 — 「이
 * 단계는 누구 것인가」로 — 다시 적으면 판정이 두 벌이 되고, 한쪽만 고쳐지는
 * 날 「결재함엔 떴는데 메일이 안 왔다」(또는 그 반대)가 된다.
 *
 * 그래서 여기서는 **후보만** 모은다. 좁히는 조건(내 신청 제외 · 직급 결재권 ·
 * 신청이 아직 결재 중인가)은 하나도 적지 않고, 바로 아래
 * `hasPendingApprovalFor` 가 그 공용 조건 **그대로**로 한 명씩 가른다. 넓게
 * 골라 좁히는 쪽이 안전하다 — 후보가 남아도는 것은 쓸데없는 확인 질의 한 번
 * 으로 끝나지만, 후보에서 빠지면 그 사람에게는 메일이 영영 안 간다.
 *
 * 넓게 고른다는 것은 구체적으로 이렇다:
 *  · 사람으로 박힌 단계(지금 만들어지는 모든 단계)는 그 사람.
 *  · 사람 칸이 빈 **옛 단계**는 그 직급의 직원 **전부** — 직급의 결재권을 여기서
 *    보지 않는다(공용 조건이 본다).
 *  · 신청자 자신도 빼지 않는다(공용 조건의 `ne(...employeeId)` 가 뺀다).
 *  · 퇴사·삭제된 직원도 빼지 않는다 — 공용 조건이 직원의 생사를 보지 않기
 *    때문이다. 그 사람을 불러도 포털은 **제 통로로 다시 물어**(이 파일의
 *    `pendingApprovalsForPortal` → findPortalActor → loadEmployee) 빈 답을
 *    받으므로 메일이 나가지 않는다. 여기서 미리 거르면 공용 조건에 없는
 *    규칙을 한 줄 새로 쓰는 셈이 된다.
 *
 * 🔴 **계정 쪽은 거른다** — 정지·삭제된 계정은 `findPortalActor` 가 없는 것으로
 * 보므로(auth/portal-actor.ts) 그 번호로 포털을 불러 봐야 포털이 다시 물었을
 * 때 빈 답이 나온다. 조건을 **그 함수와 글자까지 맞춰** 둔다.
 *
 * 🔵 이 파일에서 이 함수만 `async` 가 아니다. drizzle 의 질의 만들개는
 * `await` 하는 순간에야 DB 에 붙으므로, `async` 를 떼면 **만들어진 SQL 을 DB
 * 없이 펼쳐 볼 수 있다**(검사가 `.toSQL()` 로 읽는다 —
 * scripts/test-approval-nudge.ts). 여기는 이 저장소에서 유일하게 「조건을
 * 거꾸로 적은」 자리라, 누가 뒤에 좁히는 줄을 한 줄 더하면 조용히 결재자가
 * 빠진다. 그것을 잡는 검사가 이 한 줄에 기대고 있다. 부르는 쪽에서 `await`
 * 하는 것은 똑같다.
 */
export function approvalNudgeCandidates(
  requestId: string,
): Promise<ApprovalNudgeCandidate[]> {
  return db
    .selectDistinct({
      employeeId: webEmployees.id,
      rankId: webEmployees.rankId,
      isApprover: webRanks.canApprove,
      authSub: webUsers.authSub,
    })
    .from(webApprovalSteps)
    // 사람으로 박힌 단계는 그 사람, 사람 칸이 빈 옛 단계는 그 직급의 직원 전부.
    // 🔴 이 두 갈래는 approval-scope.ts 의 `myStepCondition` 과 같은 갈래다 —
    //    거기가 바뀌면 여기도 함께 넓혀야 한다(좁히는 일은 저쪽이 한다).
    .innerJoin(
      webEmployees,
      or(
        eq(webApprovalSteps.approverEmployeeId, webEmployees.id),
        and(
          isNull(webApprovalSteps.approverEmployeeId),
          eq(webApprovalSteps.rankId, webEmployees.rankId),
        ),
      )!,
    )
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .leftJoin(
      webUsers,
      and(
        eq(webUsers.employeeId, webEmployees.id),
        eq(webUsers.isActive, true),
        eq(webUsers.isDeleted, false),
      )!,
    )
    .where(
      and(
        eq(webApprovalSteps.requestId, requestId),
        eq(webApprovalSteps.status, "PENDING"),
        eq(webApprovalSteps.isDeleted, false),
      ),
    );
}

/**
 * 「이 신청이 지금 이 사람의 결재함에 서 있는가」 — 결재함·건수·알림·승인함이
 * 쓰는 그 **한 문장**(`myPendingApprovalWhere`)에 신청 하나를 더 좁혀 묻는다.
 *
 * 🔴 조건을 한 줄도 다시 적지 않는다. 포털을 찌르는 쪽이 「누구에게 갈까」를
 * 스스로 판단하면 그 판단이 결재함과 갈라지고, 갈라진 쪽이 메일이면 「결재할
 * 것이 없는 사람에게 결재 메일이 간다」가 된다. 받는 사람은 그 메일이 진짜인지
 * 아닌지 구별할 방법이 없다.
 */
export async function hasPendingApprovalFor(me: Decider, requestId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(webApprovalSteps)
    .innerJoin(webLeaveRequests, eq(webLeaveRequests.id, webApprovalSteps.requestId))
    .where(and(myPendingApprovalWhere(me), eq(webApprovalSteps.requestId, requestId)))
    .limit(1);
  return row !== undefined;
}

/** 내가 처리한 결재 (최근 순) */
export async function decidedBy(employeeId: string, limit = 30) {
  const applicant = alias(webEmployees, "applicant");
  return db
    .select({
      step: webApprovalSteps,
      req: webLeaveRequests,
      applicantName: applicant.name,
    })
    .from(webApprovalSteps)
    .innerJoin(webLeaveRequests, eq(webLeaveRequests.id, webApprovalSteps.requestId))
    .innerJoin(applicant, eq(applicant.id, webLeaveRequests.employeeId))
    .where(
      and(
        eq(webApprovalSteps.decidedByEmployeeId, employeeId),
        eq(webApprovalSteps.isDeleted, false),
      ),
    )
    .orderBy(desc(webApprovalSteps.decidedAt))
    .limit(limit);
}

/** 관리자 화면: 직원별 신청 (사유 없이) */
export async function requestsOfEmployee(employeeId: string): Promise<RequestView[]> {
  const rows = await db
    .select()
    .from(webLeaveRequests)
    .where(and(eq(webLeaveRequests.employeeId, employeeId), eq(webLeaveRequests.isDeleted, false)))
    .orderBy(desc(webLeaveRequests.startDate), desc(webLeaveRequests.createdAt))
    .limit(100);
  return attach(rows);
}

/** 겹침 검사용: 이 직원의 살아 있는 휴가 (승인 + 결재 중 + 결재 중인 변경) */
export async function liveSpansOf(employeeId: string, q: Q = db) {
  return q
    .select({
      id: webLeaveRequests.id,
      leaveType: webLeaveRequests.leaveType,
      startDate: webLeaveRequests.startDate,
      endDate: webLeaveRequests.endDate,
    })
    .from(webLeaveRequests)
    .where(
      and(
        eq(webLeaveRequests.employeeId, employeeId),
        eq(webLeaveRequests.isDeleted, false),
        inArray(webLeaveRequests.kind, [...LIVE_KINDS]),
        inArray(webLeaveRequests.status, [...LIVE_STATUSES]),
      ),
    );
}
