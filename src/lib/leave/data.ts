/**
 * 휴가 데이터 읽기. 계산 규칙은 rules.ts, 쓰기(신청·결재)는 workflow.ts 에 있다.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { EmployeeWithRank, Viewer } from "@/lib/auth/guards";
import { canSeeReason } from "@/lib/auth/guards";
// 🔴 **거꾸로 방향**의 위임 조회다 — 「이 결재자들을 누가 대신할 수 있나」.
//    🔵 화면이 쓰는 정방향(`loadActingForEmployeeIds`)을 이 파일이 부르면 안
//    된다: 그쪽은 **로그인한 사람**의 목록이고, 싣는 자리는 아래 `deciderOf`
//    한 곳이어야 「대신 누를 결재가 목록에만 안 뜬다」가 안 생긴다. 여기서
//    읽는 것은 **남 여럿**의 대리인이고, 그 길에는 로그인한 사람이 아예 없다
//    (결재가 저장된 뒤 서버가 혼자 도는 자리다).
import { loadDelegatesForApprovers } from "@/lib/auth/portal-delegations";
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
// 🔴 **모양은 빌려 오고(두 벌로 적지 않는다), 합치는 셈도 거기서 가져온다.**
//    「결재가 생겼다」를 포털에 알리는 판단이 제 계약으로 들고 있는 모양이고,
//    아래 조회가 그 모양으로 돌려준다. 🔵 `withDelegateCandidates` 는 **DB 를
//    모르는 순수 함수**라 저쪽에 둔 것이다 — 아래 `approvalHistoryRole` 과 같은
//    자리이고, 그래야 「대리인이 후보에 드는가」를 DB 없이 잴 수 있다.
import { withDelegateCandidates, type ApprovalNudgeCandidate } from "./approval-nudge";
// 🔴 **가르기는 DB 를 모르는 파일에 있다**(approval-history.ts) — 「내가 눌렀나
//    남이 눌렀나」는 값만 보면 답이 나오는 판단이라, DB 없이 그대로 돌려 볼 수
//    있는 자리에 두었다. 여기서는 조회가 읽어 온 두 칸을 그 함수에 넘기기만 한다.
import { approvalHistoryRole, type ApprovalHistoryRole } from "./approval-history";
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

/**
 * 결재함 질의가 쓰는 「나」. employee 가 붙은 Viewer 에서만 만든다.
 *
 * 🔴 **결재권 위임 목록을 여기서 싣는다**(설계 B-9). 사람을 읽을 때 이미 딸려
 * 온 값이라(auth/guards.ts 의 `loadEmployee`) 부르는 쪽이 따로 넘겨 줄 것이
 * 없다 — 🔴 **넘겨받는 꼴이었다면 빠뜨린 자리에서 「대신 누를 결재가 목록에만
 * 안 뜬다」가 된다.** 2026-11-16 저녁까지는 실제로 넘겨받는 꼴이었고(그때는
 * 포털에 묻는 왕복이라 아무 데서나 부를 수 없었다), 제 표를 읽게 되면서
 * **싣는 자리를 이 한 곳으로 모았다**(설계 B-12).
 *
 * 🟢 그래서 아래 넷이 **같은 목록**을 본다 — 결재함 목록 · 대기 건수 배지 ·
 * 알림 종 · 포털에 내주는 통합 승인함.
 */
function deciderOf(employee: EmployeeWithRank, isApprover: boolean): Decider {
  return {
    employeeId: employee.id,
    rankId: employee.rankId,
    isApprover,
    actingForEmployeeIds: employee.actingForEmployeeIds,
  };
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
 *  · 그 단계가 내 것이다 (approval-scope.ts). 🔵 결재권 위임을 받았으면 맡긴
 *    사람의 단계도 「내 것」이다 — 넓히는 자리는 그 파일 한 곳이다.
 *  · 신청 자체도 아직 결재 중이다.
 *  · 🔴 내 신청은 뺀다 — 자기 휴가를 자기가 결재하지 않는다. **위임으로도 못
 *    넘는다**: 여기서 보는 것은 `me.employeeId`, 곧 **실제로 누르는 사람**이지
 *    결재권을 맡긴 사람이 아니다. 남의 결재권을 빌렸다고 제 휴가가 제 결재함에
 *    서면 결재가 통째로 무의미해진다(workflow.ts 의 decideStep 이 같은 울타리를
 *    한 번 더 친다).
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
 *
 * 🔵 결재권 위임으로 **대신 눌러야 할 결재**도 여기 함께 뜬다 — 싣는 자리는 위
 * `deciderOf` 한 곳이다.
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
 * 🔴 **어느 단계를 보는가 — 이 한 곳이 정한다**(2026-11-17).
 *
 * 아래 두 조회가 이것을 함께 쓴다: 「걸릴 수 있는 사람들」과 「단계에 박힌
 * 결재자들」(위임을 되짚는 쪽). 🔴 **둘이 다른 단계를 보면** 대리인에게만
 * 알림이 더 가거나 덜 간다 — 알림이 **더** 가는 쪽은 아무 오류도 안 내고
 * 받는 사람에게만 보인다.
 *
 * 🔴 **열린 단계 하나뿐이다.** `WAITING` 은 아직 차례가 아니고
 * `APPROVED`·`REJECTED`·`SKIPPED` 는 끝난 단계다. 🔴 **위임을 더하는 조각이
 * 이 조건을 넓히지 않았다**(설계 D-8 ①) — 넓힌 것은 **사람**이지 **대상
 * 단계**가 아니다. 여기에 상태를 하나라도 보태면 건너뛴 단계의 결재자에게
 * 「결재가 생겼다」가 가기 시작한다.
 */
function nudgeStepWhere(requestId: string): SQL {
  return and(
    eq(webApprovalSteps.requestId, requestId),
    eq(webApprovalSteps.status, "PENDING"),
    eq(webApprovalSteps.isDeleted, false),
  )!;
}

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
 * 🔵 `async` 가 아니다. drizzle 의 질의 만들개는 `await` 하는 순간에야 DB 에
 * 붙으므로, `async` 를 떼면 **만들어진 SQL 을 DB 없이 펼쳐 볼 수 있다**(검사가
 * `.toSQL()` 로 읽는다 — scripts/test-approval-nudge.ts). 여기는 이 저장소에서
 * 유일하게 「조건을 거꾸로 적은」 자리라, 누가 뒤에 좁히는 줄을 한 줄 더하면
 * 조용히 결재자가 빠진다. 그것을 잡는 검사가 이 한 줄에 기대고 있다.
 *
 * 🔴 **이것은 이제 후보의 절반이다**(2026-11-17, 설계 D-8 ①). 포털 위임을 받은
 * 대리인은 이 질의에 **잡힐 길이 없다** — 단계에는 맡긴 사람의 번호만 박혀 있기
 * 때문이다. 나머지 절반을 더해 내보내는 자리는 아래 `approvalNudgeCandidates`
 * 이고, **부르는 쪽(workflow.ts)이 쓰는 것은 그쪽**이다.
 */
export function approvalNudgeStepCandidatesQuery(
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
    .where(nudgeStepWhere(requestId));
}

/**
 * 🔴 **단계에 「사람으로 박힌」 결재자들** — 위임을 거꾸로 되짚을 **출발점**이다
 * (2026-11-17, 설계 D-8 ①).
 *
 * 🔴 **왜 위 조회의 결과를 그대로 쓰지 않나.** 위는 **옛 직급 단계**에서 그
 * 직급의 직원을 전부 긁으므로, 거기서 나온 번호를 맡긴 사람으로 보고 되짚으면
 * **아무도 맡긴 적 없는 사람의 대리인**이 후보에 올라온다. 여기서는 단계의
 * `approver_employee_id` 만 본다 — 자리의 주인이 번호로 적혀 있는 줄뿐이다.
 *
 * ── 🔴 **옛 직급 단계는 위임을 못 받는다. 못 하는 것이라 적어 둔다** ────────
 * 사람 칸이 빈 옛 단계(2026-09-21 전환 전에 만들어진 행)에는 **자리 주인이
 * 번호로 적혀 있지 않다.** 포털의 위임은 사람 번호끼리 맺는 약속이라
 * (`delegator_employee_id`), 주인을 번호로 모르면 「그 사람을 대신할 사람」도
 * 구할 길이 없다. 직급으로 꿰맞출 수도 있지만 **그러면 안 된다** — 결재 판정이
 * 바로 그 자리를 막아 두었기 때문이다(approval-scope.ts 의 `isMyStep`:
 * 「위임은 사람으로 박힌 단계만 넓힌다」, 넓히면 그 직급에 걸린 **남의** 옛
 * 단계가 통째로 열린다). 여기서만 꿰맞추면 **알림은 가는데 눌러 보면 거절되는**
 * 사람이 생긴다 — 받는 사람 눈에는 그냥 고장이다.
 * 🔵 두 DB 모두 2026-09-21 에 옛 단계가 0행이 됐으므로 지금 잃는 것은 없다.
 *
 * 🔵 보는 단계는 위와 **같은 조건**이다(`nudgeStepWhere`) — 한 줄 더 붙은 것은
 * 「사람이 박혀 있는가」뿐이고, 그것은 대상 단계를 **좁히는** 쪽이다.
 */
export function nudgeStepApproverIdsQuery(requestId: string) {
  return db
    .selectDistinct({ approverEmployeeId: webApprovalSteps.approverEmployeeId })
    .from(webApprovalSteps)
    .where(and(nudgeStepWhere(requestId), isNotNull(webApprovalSteps.approverEmployeeId))!);
}

/**
 * 대리인들의 **직급과 계정** — 후보 한 줄에 필요한 나머지 칸이다.
 *
 * 🔴 **거르는 줄을 위 조회와 글자까지 맞춘다.** 직원의 생사는 보지 않고(공용
 * 조건이 보지 않으므로), 계정은 정지·삭제를 거른다(`findPortalActor` 가 그
 * 조건으로 되물어 빈 답을 주기 때문이다). 한쪽만 달라지면 「단계에 걸렸을
 * 때는 알림이 가는데 위임으로 걸리면 안 가는」 사람이 생긴다.
 *
 * 🔵 이미 단계로 걸린 사람은 **묻지 않는다** — 부르는 쪽이 빼고 넘긴다.
 */
export function nudgeDelegateRowsQuery(
  employeeIds: readonly string[],
): Promise<ApprovalNudgeCandidate[]> {
  return db
    .selectDistinct({
      employeeId: webEmployees.id,
      rankId: webEmployees.rankId,
      isApprover: webRanks.canApprove,
      authSub: webUsers.authSub,
    })
    .from(webEmployees)
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .leftJoin(
      webUsers,
      and(
        eq(webUsers.employeeId, webEmployees.id),
        eq(webUsers.isActive, true),
        eq(webUsers.isDeleted, false),
      )!,
    )
    .where(inArray(webEmployees.id, [...employeeIds]))
    .orderBy(asc(webEmployees.id));
}

/**
 * 🔴 **알릴 후보 전부** — 단계에 걸린 사람 **더하기** 그들을 지금 대신할 수 있는
 * 사람 (2026-11-17, 설계 D-8 ①). 포털을 찌르는 배선(workflow.ts)이 부르는 것이
 * 이 함수다.
 *
 * ── 🔴 왜 이 조각이 필요했나 ──────────────────────────────────────────────
 * 조각 8 이후로 포털 위임을 받은 대리인은 결재함·배지·종·통합 승인함에 모두
 * 떴다 — 판정(`myStepCondition`)이 위임 목록을 보기 때문이다. 그런데 **「결재가
 * 생겼다」 알림만** 안 갔다: 알릴 사람을 뽑는 질의가 단계에 박힌 번호 하나만
 * 보고, 그 사람을 **누가 대신할 수 있나**는 묻지 않았다. 🔴 그래서 대리인은
 * 결재함을 **제 발로 열어 봐야** 대신 누를 건이 있다는 것을 알았다.
 *
 * ── 🔴 판정을 새로 짓지 않는다 ────────────────────────────────────────────
 * 여기서 하는 일은 후보를 **넓히는 것**뿐이고, 그 후보는 한 명씩 공용 조건에
 * 되물어 걸러진다(approval-nudge.ts 의 `isPendingFor`). 대리인 줄에 실어 보내는
 * 「내가 대신할 수 있는 사람들」은 화면이 쓰는 값과 **같은 자리**에서 읽었다 —
 * 읽는 조건이 `auth/portal-delegations.ts` 한 곳이기 때문이다(정방향
 * `loadActingForEmployeeIds` 와 거꾸로 `loadDelegatesForApprovers` 가 같은
 * `liveNowParts` 를 쓴다). 그래서 **결재함에 뜨는 사람과 알림을 받는 사람이
 * 어긋날 수 없다.**
 *
 * 🔵 **세 번 묻는다**(단계 후보 · 단계 주인 · 위임). 앞의 둘은 나란히 돌고, 셋째는
 * 맡긴 사람 번호가 있을 때만 돈다. 결재가 **생길 때만** 지나는 길이고, 이 함수
 * 뒤에는 어차피 후보마다 되묻는 질의가 한 번씩 더 붙는다.
 *
 * @param now 위임이 살아 있는지 보는 기준 시각. 기본은 **지금**이다 —
 *            🔴 어딘가에 캐 두면 「끝났는데 아직 알림이 가는」 위임이 생긴다
 *            (auth/portal-delegations.ts 의 그 까닭).
 */
export async function approvalNudgeCandidates(
  requestId: string,
  now: Date = new Date(),
): Promise<ApprovalNudgeCandidate[]> {
  const [onSteps, owners] = await Promise.all([
    approvalNudgeStepCandidatesQuery(requestId),
    nudgeStepApproverIdsQuery(requestId),
  ]);

  const pairs = await loadDelegatesForApprovers(
    // 🔵 `is not null` 로 이미 걸렀지만 타입은 그것을 모른다.
    owners.map((row) => row.approverEmployeeId).filter((id): id is string => id !== null),
    now,
  );
  // 🔵 흔한 정상이다 — 위임이 하나도 없으면 **이 조각 이전과 글자 하나 다르지
  //    않은** 목록이 그대로 나간다.
  if (pairs.length === 0) return onSteps;

  const onStepIds = new Set(onSteps.map((row) => row.employeeId));
  const toRead = [...new Set(pairs.map((pair) => pair.delegateEmployeeId))].filter(
    (id) => !onStepIds.has(id),
  );
  const delegates = toRead.length === 0 ? [] : await nudgeDelegateRowsQuery(toRead);

  // 🔴 합치는 셈(중복 걷기·차례)은 **DB 를 모르는 파일**에 있다 — 이 파일의
  //    `approvalHistoryRole` 과 같은 자리다. 그래야 「대리인이 후보에 드는가」를
  //    DB 없이 그대로 재 볼 수 있다(scripts/test-approval-nudge-delegation.ts).
  return withDelegateCandidates({ onSteps, pairs, delegates });
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

/**
 * 내가 처리한 결재 (최근 순) — **결재함 화면의 아래쪽 표**가 쓴다.
 *
 * 🔴 **아래 `approvalHistoryFor` 와 일부러 나란히 둔 것이다**(2026-11-17).
 * 넓히지 않고 둘로 둔 까닭:
 *  · **뜻이 다르다.** 여기는 「**내가 누른** 결재」 하나뿐이고, 아래는 「**내
 *    자리에서 일어난** 결재」까지 가로지른다. 여기에 `approver_employee_id = 나`
 *    를 보태면 결재함의 「내가 처리한 결재」 표에 **남이 대신 누른 줄**이 섞여
 *    제목이 거짓말을 한다 — 제목을 고치는 것은 화면 일이고, 🔵 **이 조각은
 *    화면을 만들지도 고치지도 않는다**(화면은 통합 승인함 한 곳, 2026-11-17 사용자).
 *  · **묻는 모양이 다르다.** 여기는 기간이 없고 최근 30건으로 끊는다. 아래는
 *    기간이 **필수**다(사용자가 물은 것이 「특정 날짜 혹은 기간」이다).
 *
 * 🔴 **여기에 상태 조건이 없는데도 건너뛴 단계가 안 섞이는 것은 우연이 아니다** —
 * `skipStep` 은 `decided_by_user_id`(계정)만 적고 `decided_by_employee_id`(명단)는
 * 비워 두므로, 명단 번호로 묻는 이 조건에 **건너뛴 줄이 애초에 걸리지 않는다.**
 * 🔴 누가 `skipStep` 에 명단 번호를 적는 날 이 표에 `SKIPPED` 줄이 조용히 들어오고,
 * 화면은 그것을 **「반려」로 그린다**(approvals/page.tsx 가 `APPROVED` 가 아니면
 * 반려로 적는다). 그래서 아래 조회는 같은 것을 **상태로** 못 박는다.
 */
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

/* ------------------------------------------------------------------ */
/* 결재 **내역** — 기간·사람으로 가로지른다 (2026-11-17, 설계 C-4)       */
/* ------------------------------------------------------------------ */

/**
 * 「언제부터 언제까지」. 🔴 **반열린 구간이다** — `from <= decided_at < to`.
 *
 * 끝을 `<=` 로 적으면 **구간을 이어 붙일 때 경계의 한 순간이 양쪽에 두 번**
 * 들어간다. 이 집에서 그 이어 붙임이 실제로 일어나는 자리가 있다: 설계 C-5 는
 * 끝난 위임의 기간(`[starts_at, ends_at)`)을 그대로 이 조회에 넘겨 「그 위임
 * 기간에 내가 대신한 결재」를 보여 준다 — 위임 기간이 **이미 반열린 구간**이라
 * (auth/portal-delegations.ts 의 `liveDelegationWhere`) 여기서도 같은 모양이어야
 * 두 칸이 어긋나지 않는다.
 *
 * 🔴 **그래서 「11월 1일 ~ 11월 30일」을 묻는 쪽은 `to` 에 12월 1일 0시를 준다.**
 * 사람이 고른 날짜를 시각으로 바꾸는 일은 부르는 쪽(다음 조각의 통로)의 몫이다 —
 * 이 조회는 시각만 안다. `decided_at` 은 timestamptz 라 한국 시간으로 자르려면
 * 그쪽이 KST 기준 경계를 만들어 넘겨야 한다.
 */
export type ApprovalHistoryRange = {
  from: Date;
  /** 🔴 이 시각은 **안 들어간다**(위 머리말). */
  to: Date;
  /**
   * 울타리. 🔴 **쪽 나누기가 아니다** — 넘치면 **조용히 잘린다.** 「더 있나」를
   * 알아야 하면 부르는 쪽이 보고 싶은 수 **+1** 을 달라고 해서 줄 수로 가른다.
   * 기본값은 아래 `APPROVAL_HISTORY_MAX_ROWS`.
   */
  limit?: number;
};

/**
 * 한 번에 돌려주는 줄 수의 상한.
 *
 * 🔵 「아직 안 끝난 위임」을 읽는 조회에는 상한을 안 두었다 — 거기 담기는 줄은
 * 사람 수를 넘지 못한다. 결재 내역은 반대다: **해가 갈수록 쌓이고** 기간을 넓게
 * 잡는 것을 막을 길이 없다(auth/portal-delegations.ts 의
 * `loadAllUnfinishedDelegations` 가 「끝난 것까지 보는 화면을 만드는 날 상한을
 * 함께 가져와야 한다」고 적어 둔 그 자리다). 한 사람이 1년에 처리하는 결재가
 * 수백 줄이라 500 이면 한 해를 통째로 물어도 남는다.
 */
export const APPROVAL_HISTORY_MAX_ROWS = 500;

/** 결재 내역 한 줄. 🔴 사유(reason)를 싣지 않는다 — 아래 조회 머리말 참조. */
export type ApprovalHistoryRow = {
  stepId: string;
  requestId: string;
  stepNo: number;
  /** 🔴 `APPROVED` · `REJECTED` 둘뿐이다 — 조회가 그 둘로 좁힌다 */
  status: ApprovalStep["status"];
  /** 🔴 늘 값이 있다 — 기간 조건이 빈 줄을 통과시키지 않는다 */
  decidedAt: Date;
  /** 승인·반려 의견. 없으면 null */
  comment: string | null;
  /** 🔴 이 줄이 **나에게** 무엇이었나 — 셋이 갈린다(approval-history.ts) */
  role: ApprovalHistoryRole;
  /** 그 단계의 주인 이름. 옛 직급 단계만 null */
  approverName: string | null;
  /** 실제로 누른 사람 이름 */
  decidedByName: string | null;
  /** 누구의 무슨 휴가인가 */
  applicantName: string;
  kind: LeaveRequest["kind"];
  leaveType: LeaveRequest["leaveType"];
  startDate: string;
  endDate: string;
  days: number;
  /** 그 **신청**이 지금 어떻게 됐나. 내 단계는 승인했는데 뒤에서 반려될 수 있다 */
  requestStatus: LeaveRequest["status"];
};

/**
 * 🔴 **고르는 조건 — 이 집에만 있는 함정이 여기 다 들어 있다.**
 *
 * ① **주인과 누른 사람을 OR 로 묶는다.** 「내가 한 결재」만 보면 **내가 자리를
 *    비운 동안 남이 대신 누른 결재**가 안 보이고, 그것이 사용자가 물은 둘째
 *    줄이다. 가르는 일은 읽어 온 뒤 `approvalHistoryRole` 이 한다.
 *
 * ② 🔴 **`SKIPPED` 를 뺀다. 이것이 이 집의 핵심이다.** 건너뛴 단계는
 *    `decided_by_employee_id` 가 **비어 있다** — 관리자 건너뛰기(`skipStep`)는
 *    계정 번호(`decided_by_user_id`)만 적고 명단 번호는 안 적는다. 안 거르면
 *    주인은 나인데 누른 사람이 비어 있는 줄이 전부 **「내 자리를 남이 눌렀다」로
 *    오판된다** — 아무 오류도 안 나고, 건너뛴 수만큼 없던 대리 결재가 생긴다.
 *    🔵 사용자가 **「건너뛰기는 내역에서 뺀다」**를 골랐다(설계 B-18): 건너뛰기는
 *    결재가 아니라 그 관문을 지운 것이다.
 *
 *    🔴 **건너뛰기에 두 갈래가 있다는 것도 알아 둘 것.** 관리자가 명시적으로
 *    건너뛴 것(`skipStep`)은 「누가·언제·왜」가 남지만, **반려·신청 취소로 인한
 *    연쇄 건너뜀**(`skipOpenSteps`)은 상태만 바꾸고 **아무것도 안 남긴다**
 *    (`decided_at` 조차 null 이다). 같은 `SKIPPED` 인데 기록 농도가 다르다 —
 *    🔴 나중에 「건너뛰기도 보여 주자」가 나오면 **한 갈래는 통째로 빈칸**이 된다.
 *    지금은 둘 다 빠지므로 문제가 안 된다.
 *
 * ③ **`WAITING`·`PENDING` 도 같은 조건에 함께 빠진다.** 아직 안 끝난 단계는
 *    내역이 아니다. 🔵 기간 조건만으로도 빠지지만(`decided_at` 이 null 이라 어떤
 *    비교도 참이 안 된다) **그것에 기대지 않는다** — 기간을 선택으로 바꾸는 날
 *    조용히 섞여 들어온다.
 *
 * ④ 🔴 **상태 목록과 `is_deleted` 를 바인딩 자리가 아니라 글자로 적는다.**
 *    부분 색인(`web_approval_steps_decided_by_idx` ·
 *    `…_decided_approver_idx`)의 조건과 **상수끼리** 견주어야 계획기가 「이 질의는
 *    저 색인 안에 담긴다」를 증명한다. `$1` 로 나가면 준비된 질의를 되쓸 때 값을
 *    모른 채 계획을 세우므로 증명이 깨지고 색인을 안 탄다 — 🔴 **결과는 똑같아서
 *    아무도 모르고 느려지기만 한다.** schema.ts 의 그 색인 주석과 짝이다.
 *    🔵 사람 번호와 기간은 그대로 바인딩한다(값이 매번 다르고, 색인은 **조건**만
 *    증명하면 된다).
 */
function approvalHistoryWhere(employeeId: string, range: ApprovalHistoryRange): SQL {
  return and(
    or(
      eq(webApprovalSteps.decidedByEmployeeId, employeeId),
      eq(webApprovalSteps.approverEmployeeId, employeeId),
    ),
    gte(webApprovalSteps.decidedAt, range.from),
    lt(webApprovalSteps.decidedAt, range.to),
    // 🔴 이 두 줄의 **차례까지** 색인의 부분 조건과 맞춰 둔다. 계획기는 차례를
    //    따지지 않지만, 글자가 똑같으면 시험이 둘을 **그대로 맞대어** 볼 수
    //    있다(scripts/test-approval-history.ts). 어긋나는 날을 글자로 잡는 것이
    //    「조용히 느려지기만 한다」를 막는 유일한 길이다.
    sql`${webApprovalSteps.isDeleted} = false`,
    sql`${webApprovalSteps.status} in ('APPROVED', 'REJECTED')`,
  )!;
}

/**
 * 「이 사람이 이 기간에 한 / 대신한 / 대신 받은 결재」를 고르는 질의.
 *
 * 🔴 **질의를 만들기만 하고 돌리지 않는다.** 시험이 이것을 `.toSQL()` 로 **실제로
 * 구워** 상태 거르기와 기간 경계를 글자가 아니라 **구워진 SQL** 로 본다
 * (auth/portal-delegations.ts 가 같은 까닭으로 같은 모양이다). drizzle 의 질의는
 * `await` 할 때 비로소 DB 에 붙으므로 만들어 두기만 하는 것은 아무 데도 안 닿는다.
 * 🔵 개발 DB 에 결재 기록이 사실상 없어(단계 1행, 그것도 미결) **값으로 잴 수가
 * 없다** — 이 집이 자료 없이 재는 수법을 쓰는 까닭이다.
 *
 * 🔴 **이름은 조인으로 읽고, 지워진 직원도 걸러 내지 않는다.** 소프트 삭제라 행이
 * 남아 이름이 그대로 풀린다 — `stepsFor` 가 하는 그대로다. 내역에서 사람 이름이
 * 비면 그게 더 큰 결함이고, 그만둔 사람이 과거에 한 결재는 지워지는 것이 아니다.
 * 🔴 **한 표를 세 번 조인한다**(신청자·주인·누른 사람이 전부 `web_employees`).
 * 별명 없이 쓰면 drizzle 이 같은 표를 한 번만 걸어 **세 이름이 같은 값**이 된다.
 *
 * 🔴 **사유(reason)를 읽지 않는다.** 이 줄은 포털을 거쳐 **다른 시스템의 화면**에
 * 그려진다(portal-notifications.ts · portal-approvals.ts 의 같은 규칙). 휴가 사유는
 * 본인과 결재권 직급에게만 보이는 값이다(`canSeeReason`).
 *
 * 🔵 **신청 행의 `is_deleted` 는 보지 않는다** — 이 시스템에는 신청을 지우는 길이
 * 아예 없다(2026-11-17 실측: `softDeleteBy` 를 쓰는 여섯 자리에 신청 표가 없다).
 * 있지도 않은 조건을 걸면 색인 증명만 복잡해진다. `decidedBy` 도 같다.
 */
export function approvalHistoryQuery(employeeId: string, range: ApprovalHistoryRange) {
  const applicant = alias(webEmployees, "applicant");
  const approver = alias(webEmployees, "approver");
  const decider = alias(webEmployees, "decider");
  return db
    .select({
      stepId: webApprovalSteps.id,
      requestId: webApprovalSteps.requestId,
      stepNo: webApprovalSteps.stepNo,
      status: webApprovalSteps.status,
      decidedAt: webApprovalSteps.decidedAt,
      comment: webApprovalSteps.comment,
      // 🔴 가르기에 쓰는 두 칸. 이름이 아니라 **번호**로 견준다 — 동명이인이
      //    있으면 이름 비교는 조용히 틀린다.
      approverEmployeeId: webApprovalSteps.approverEmployeeId,
      decidedByEmployeeId: webApprovalSteps.decidedByEmployeeId,
      approverName: approver.name,
      decidedByName: decider.name,
      applicantName: applicant.name,
      kind: webLeaveRequests.kind,
      leaveType: webLeaveRequests.leaveType,
      startDate: webLeaveRequests.startDate,
      endDate: webLeaveRequests.endDate,
      days: webLeaveRequests.days,
      requestStatus: webLeaveRequests.status,
    })
    .from(webApprovalSteps)
    .innerJoin(webLeaveRequests, eq(webLeaveRequests.id, webApprovalSteps.requestId))
    .innerJoin(applicant, eq(applicant.id, webLeaveRequests.employeeId))
    .leftJoin(approver, eq(approver.id, webApprovalSteps.approverEmployeeId))
    .leftJoin(decider, eq(decider.id, webApprovalSteps.decidedByEmployeeId))
    .where(approvalHistoryWhere(employeeId, range))
    // 최근 순. 🔵 단계 번호를 뒤에 붙이는 것은 **차례를 못 박기 위해서**다 —
    // 같은 시각에 닫힌 줄이 둘이면(되살린 자료·한 거래 안의 여러 줄) 차례가
    // 실행마다 달라져, 상한에 걸릴 때 보이는 줄이 흔들린다.
    .orderBy(desc(webApprovalSteps.decidedAt), asc(webApprovalSteps.id))
    .limit(range.limit ?? APPROVAL_HISTORY_MAX_ROWS);
}

/**
 * 🔴 **이 조각의 입구.** 위 질의를 돌리고, 줄마다 **나에게 무엇이었나**를 붙인다.
 *
 * @param employeeId 보는 사람의 **명단 번호**(`web_employees.id`). 🔴 계정
 *                   번호(`web_users.id`)도 포털 번호도 아니다 — 넣으면 오류 없이
 *                   영원히 빈 목록이 나온다(결재 권한의 열쇠가 명단 번호라서다).
 */
export async function approvalHistoryFor(
  employeeId: string,
  range: ApprovalHistoryRange,
): Promise<ApprovalHistoryRow[]> {
  const rows = await approvalHistoryQuery(employeeId, range);
  return rows.map(({ approverEmployeeId, decidedByEmployeeId, decidedAt, ...rest }) => {
    if (decidedAt === null) {
      // 🔴 여기 올 수 없다 — 기간 조건이 null 을 통과시키지 않는다. 그래도 `!` 로
      //    타입만 눌러 끄지 않는 것은, 누가 기간을 선택으로 바꾸는 날 이 자리가
      //    **조용히 거짓말을 시작**하기 때문이다(시각 없는 줄이 내역에 선다).
      throw new Error("결재 내역에 결재 시각이 없는 줄이 섞였다 — 기간 조건이 빠졌다");
    }
    return {
      ...rest,
      decidedAt,
      role: approvalHistoryRole({ approverEmployeeId, decidedByEmployeeId }, employeeId),
    };
  });
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
