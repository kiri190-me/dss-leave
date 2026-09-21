/**
 * 휴가 데이터 읽기. 계산 규칙은 rules.ts, 쓰기(신청·결재)는 workflow.ts 에 있다.
 */
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
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
  webRanks,
  webTenureRules,
  type ApprovalStep,
  type Holiday,
  type LeaveRequest,
  type Rank,
} from "@/lib/db/schema";
import { myStepCondition, type Decider } from "./approval-scope";
import { approvalTurnLabel } from "./labels";
import {
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
  opts: { excludeRequestIds?: string[]; q?: Q } = {},
): Promise<LedgerInput> {
  const q = opts.q ?? db;
  const exclude = opts.excludeRequestIds ?? [];

  const requests = await q
    .select()
    .from(webLeaveRequests)
    .where(
      and(
        eq(webLeaveRequests.employeeId, employee.id),
        eq(webLeaveRequests.isDeleted, false),
        eq(webLeaveRequests.deducts, true),
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
    days: requests
      .filter((r) => !exclude.includes(r.id))
      .flatMap((r) => expandLeaveDays(r, r.status === "PENDING", holidays)),
  };
}

/** 잔여 일수. on 을 주면 그날 기준 (예: 지난해 인쇄는 12월 31일 기준) */
export async function getBalance(
  employee: { id: string; hireDate: string },
  ctx?: { holidays: ReadonlySet<string>; rules: readonly TenureRuleRow[] },
  on?: string,
): Promise<Balance> {
  const holidays = ctx?.holidays ?? (await loadHolidaySet());
  const rules = ctx?.rules ?? (await loadRules());
  const input = await loadLedgerInput(employee, holidays, rules);
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
    .where(
      and(
        eq(webApprovalSteps.status, "PENDING"),
        eq(webApprovalSteps.isDeleted, false),
        myStepCondition(deciderOf(viewer.employee, viewer.isApprover)),
        eq(webLeaveRequests.status, "PENDING"),
        eq(webLeaveRequests.isDeleted, false),
        ne(webLeaveRequests.employeeId, viewer.employee.id),
      ),
    )
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
    .where(
      and(
        eq(webApprovalSteps.status, "PENDING"),
        eq(webApprovalSteps.isDeleted, false),
        myStepCondition(deciderOf(viewer.employee, viewer.isApprover)),
        eq(webLeaveRequests.status, "PENDING"),
        eq(webLeaveRequests.isDeleted, false),
        ne(webLeaveRequests.employeeId, viewer.employee.id),
      ),
    );
  return row?.n ?? 0;
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
