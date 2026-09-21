/**
 * 휴가 신청·결재 — 상태를 바꾸는 일은 전부 여기서 한다.
 *
 * 호출하는 쪽(서버 액션)이 로그인·권한을 먼저 확인하고 Member/Viewer 를 넘긴다.
 * 그래도 '누구의 휴가인가 · 이 사람이 결재할 수 있는가'는 여기서 DB 를 다시 읽어 확인한다.
 *
 * 결재는 순서가 없다. 신청하면 결재권자 모두의 결재함에 동시에 들어가고,
 * 모두 승인하면 확정, 한 명이라도 반려하면 그 자리에서 끝난다.
 * 폼에서 온 ID 는 대상을 찾는 데만 쓰고 권한 판단에는 쓰지 않는다.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import { writeAudit } from "@/lib/audit";
import type { Member, Viewer } from "@/lib/auth/guards";
import { formatRange, isYmd, todayKst } from "@/lib/dates";
import { db, type Tx } from "@/lib/db";
import { isUuid } from "@/lib/ids";
import {
  LEAVE_TYPES,
  webApprovalSteps,
  webEmployees,
  webLeaveRequests,
  webRanks,
  type LeaveRequest,
  type LeaveType,
} from "@/lib/db/schema";
import { isMyStep } from "./approval-scope";
import {
  approvalChainFor,
  liveSpansOf,
  loadHolidaySet,
  loadLedgerInput,
  loadRules,
} from "./data";
import {
  LEAVE_TYPE_INFO,
  computeLeaveDays,
  expandLeaveDays,
  shortageIfAdded,
  spansOverlap,
} from "./rules";

export type WorkflowResult =
  | { ok: true; message: string; requestId?: string; code: string }
  | { ok: false; error: string };

const fail = (error: string): WorkflowResult => ({ ok: false, error });

function describe(r: Pick<LeaveRequest, "leaveType" | "startDate" | "endDate">): string {
  return `${LEAVE_TYPE_INFO[r.leaveType].label} ${formatRange(r.startDate, r.endDate, true)}`;
}

async function lockRequest(tx: Tx, id: string): Promise<LeaveRequest | null> {
  const rows = await tx
    .select()
    .from(webLeaveRequests)
    .where(and(eq(webLeaveRequests.id, id), eq(webLeaveRequests.isDeleted, false)))
    .for("update");
  return rows[0] ?? null;
}

/** 결재가 모두 끝났을 때 (또는 결재가 필요 없을 때) 효과를 반영한다 */
async function finalize(tx: Tx, req: LeaveRequest): Promise<void> {
  const now = new Date();
  await tx
    .update(webLeaveRequests)
    .set({ status: "APPROVED", decidedAt: now, updatedAt: now })
    .where(eq(webLeaveRequests.id, req.id));

  if (req.kind === "CHANGE" && req.targetRequestId) {
    await tx
      .update(webLeaveRequests)
      .set({ status: "SUPERSEDED", statusNote: "날짜 변경 승인", decidedAt: now, updatedAt: now })
      .where(
        and(eq(webLeaveRequests.id, req.targetRequestId), eq(webLeaveRequests.status, "APPROVED")),
      );
  }
  if (req.kind === "CANCEL" && req.targetRequestId) {
    await tx
      .update(webLeaveRequests)
      .set({ status: "CANCELED", statusNote: "취소 결재 승인", decidedAt: now, updatedAt: now })
      .where(
        and(eq(webLeaveRequests.id, req.targetRequestId), eq(webLeaveRequests.status, "APPROVED")),
      );
  }
}

/**
 * 아직 기다리고 있는 결재자의 이름. 사람으로 박힌 단계는 사람 이름,
 * 전환 전에 만들어진 옛 단계는 직급 이름을 쓴다.
 */
async function remainingApprovers(tx: Tx, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ name: webEmployees.name, rankName: webRanks.name })
    .from(webApprovalSteps)
    .innerJoin(webRanks, eq(webRanks.id, webApprovalSteps.rankId))
    .leftJoin(webEmployees, eq(webEmployees.id, webApprovalSteps.approverEmployeeId))
    .where(
      and(
        eq(webApprovalSteps.requestId, requestId),
        eq(webApprovalSteps.status, "PENDING"),
        eq(webApprovalSteps.isDeleted, false),
      ),
    )
    .orderBy(asc(webApprovalSteps.stepNo));
  return rows.map((r) => r.name ?? r.rankName);
}

async function skipOpenSteps(tx: Tx, requestId: string): Promise<void> {
  await tx
    .update(webApprovalSteps)
    .set({ status: "SKIPPED", updatedAt: new Date() })
    .where(
      and(
        eq(webApprovalSteps.requestId, requestId),
        inArray(webApprovalSteps.status, ["WAITING", "PENDING"]),
      ),
    );
}

/**
 * 신청 행과 결재 단계를 만든다. 결재 단계는 모두 동시에 대기.
 * 결재할 사람이 없으면 바로 승인한다.
 *
 * 🔴 **결재선은 신청하는 이 순간 단계 행으로 굳혀 박는다.** 나중에 관리자가
 * 설정의 결재선을 바꿔도 이미 박힌 행은 건드리지 않는다 — 대기 중인 신청의
 * 결재자가 뒤에서 바뀌는 일이 없어야 한다.
 *
 * 단계에는 사람(`approverEmployeeId`)과 **그때 그 사람의 직급**(`rankId`)을
 * 함께 적는다. 직급은 표시용·옛 행과의 호환용이고, 권한 판정은 사람으로 한다.
 */
async function createWithChain(
  tx: Tx,
  member: Member,
  values: Omit<typeof webLeaveRequests.$inferInsert, "employeeId" | "submittedByUserId" | "status">,
): Promise<{ request: LeaveRequest; chainNames: string[] }> {
  const chain = await approvalChainFor(member.employee, tx);
  const [request] = await tx
    .insert(webLeaveRequests)
    .values({
      ...values,
      employeeId: member.employee.id,
      submittedByUserId: member.user.id,
      status: "PENDING",
    })
    .returning();

  if (chain.length === 0) {
    await finalize(tx, request);
  } else {
    await tx.insert(webApprovalSteps).values(
      chain.map((approver, i) => ({
        requestId: request.id,
        stepNo: i + 1,
        rankId: approver.rankId,
        approverEmployeeId: approver.employeeId,
        status: "PENDING" as const,
      })),
    );
  }
  return { request, chainNames: chain.map((a) => a.name) };
}

function submittedMessage(chainNames: string[]): string {
  if (chainNames.length === 0) return "결재 없이 바로 등록되었습니다.";
  return `신청했습니다. ${chainNames.join("·")} 모두 승인하면 확정됩니다.`;
}

/* ------------------------------------------------------------------ */
/* 새 신청 · 날짜 변경 신청                                              */
/* ------------------------------------------------------------------ */

export type LeaveInput = {
  leaveType: string;
  startDate: string;
  endDate: string;
  reason: string;
};

export async function submitLeave(
  member: Member,
  input: LeaveInput,
  targetId?: string,
): Promise<WorkflowResult> {
  const leaveType = input.leaveType as LeaveType;
  if (!(LEAVE_TYPES as readonly string[]).includes(leaveType)) {
    return fail("휴가 종류를 고르세요.");
  }
  const info = LEAVE_TYPE_INFO[leaveType];
  const startDate = input.startDate;
  const endDate = info.halfDay ? input.startDate : input.endDate || input.startDate;
  if (!isYmd(startDate) || !isYmd(endDate)) return fail("날짜를 확인하세요.");

  const reason = input.reason.trim().slice(0, 500) || null;
  const today = todayKst();
  const holidays = await loadHolidaySet();

  const computed = computeLeaveDays(leaveType, startDate, endDate, holidays);
  if (!computed.ok) return fail(computed.error);

  // 날짜 변경이면 원래 휴가를 확인한다
  let target: LeaveRequest | null = null;
  if (targetId !== undefined) {
    const check = await checkFollowUpTarget(member, targetId, today);
    if (!check.ok) return fail(check.error);
    target = check.target;
    if (
      target.leaveType === leaveType &&
      target.startDate === startDate &&
      target.endDate === endDate &&
      (target.reason ?? null) === reason
    ) {
      return fail("바뀐 내용이 없습니다.");
    }
  }

  // 내 다른 휴가와 겹치는가
  const spans = await liveSpansOf(member.employee.id);
  const clash = spans.find(
    (s) => s.id !== target?.id && spansOverlap(s, { leaveType, startDate, endDate }),
  );
  if (clash) {
    return fail(
      `이미 신청한 휴가(${formatRange(clash.startDate, clash.endDate)})와 날짜가 겹칩니다.`,
    );
  }

  // 남은 일수가 모자라지 않는가
  if (info.deducts) {
    const rules = await loadRules();
    const ledger = await loadLedgerInput(member.employee, holidays, rules, {
      excludeRequestIds: target ? [target.id] : [],
    });
    const added = expandLeaveDays(
      { id: "__new__", leaveType, startDate, endDate, deducts: true },
      true,
      holidays,
    );
    const short = shortageIfAdded(ledger, added);
    if (short > 0) return fail(`남은 휴가가 ${short}일 모자랍니다.`);
  }

  const result = await db.transaction(async (tx) => {
    if (target) {
      // 그사이 다른 변경·취소 신청이 들어가지 않았는지 잠그고 다시 본다
      const locked = await lockRequest(tx, target.id);
      if (!locked || locked.status !== "APPROVED") return null;
    }
    const created = await createWithChain(tx, member, {
      kind: target ? "CHANGE" : "NEW",
      targetRequestId: target?.id ?? null,
      leaveType,
      startDate,
      endDate,
      days: computed.days,
      deducts: info.deducts,
      reason,
    });
    await writeAudit(
      {
        actor: member.user,
        action: target ? "LEAVE_CHANGE_REQUEST" : "LEAVE_REQUEST",
        summary: target
          ? `${member.employee.name} 휴가 변경 신청: ${describe(target)} → ${describe(created.request)}`
          : `${member.employee.name} 휴가 신청: ${describe(created.request)} (${computed.days}일)`,
        entityType: "leave_request",
        entityId: created.request.id,
      },
      tx,
    );
    return created;
  });

  if (!result) return fail("원래 휴가의 상태가 바뀌었습니다. 새로고침 후 다시 확인하세요.");
  return {
    ok: true,
    message: submittedMessage(result.chainNames),
    requestId: result.request.id,
    code: result.chainNames.length === 0 ? "auto" : "submitted",
  };
}

/* ------------------------------------------------------------------ */
/* 결재 후 취소 신청                                                     */
/* ------------------------------------------------------------------ */

export async function submitCancel(
  member: Member,
  targetId: string,
  reasonRaw: string,
): Promise<WorkflowResult> {
  const today = todayKst();
  const check = await checkFollowUpTarget(member, targetId, today);
  if (!check.ok) return fail(check.error);
  const target = check.target;

  const result = await db.transaction(async (tx) => {
    const locked = await lockRequest(tx, target.id);
    if (!locked || locked.status !== "APPROVED") return null;
    const created = await createWithChain(tx, member, {
      kind: "CANCEL",
      targetRequestId: target.id,
      leaveType: target.leaveType,
      startDate: target.startDate,
      endDate: target.endDate,
      days: target.days,
      deducts: target.deducts,
      reason: reasonRaw.trim().slice(0, 500) || null,
    });
    await writeAudit(
      {
        actor: member.user,
        action: "LEAVE_CANCEL_REQUEST",
        summary: `${member.employee.name} 휴가 취소 신청: ${describe(target)}`,
        entityType: "leave_request",
        entityId: created.request.id,
      },
      tx,
    );
    return created;
  });

  if (!result) return fail("원래 휴가의 상태가 바뀌었습니다. 새로고침 후 다시 확인하세요.");
  return {
    ok: true,
    message:
      result.chainNames.length === 0
        ? "휴가를 취소했습니다."
        : `취소를 신청했습니다. ${result.chainNames.join("·")} 모두 승인하면 취소됩니다.`,
    requestId: result.request.id,
    code: result.chainNames.length === 0 ? "canceled" : "cancel-submitted",
  };
}

/** 결재 후 변경·취소의 대상이 될 수 있는 휴가인가 */
async function checkFollowUpTarget(
  member: Member,
  targetId: string,
  today: string,
): Promise<{ ok: true; target: LeaveRequest } | { ok: false; error: string }> {
  if (!isUuid(targetId)) return { ok: false, error: "휴가를 찾을 수 없습니다." };
  const rows = await db
    .select()
    .from(webLeaveRequests)
    .where(and(eq(webLeaveRequests.id, targetId), eq(webLeaveRequests.isDeleted, false)))
    .limit(1);
  const target = rows[0];
  if (!target || target.employeeId !== member.employee.id) {
    return { ok: false, error: "휴가를 찾을 수 없습니다." };
  }
  if (target.kind === "CANCEL" || target.status !== "APPROVED") {
    return { ok: false, error: "결재가 끝난 휴가만 바꾸거나 취소할 수 있습니다." };
  }
  if (target.startDate < today) {
    return {
      ok: false,
      error: "이미 시작했거나 지난 휴가는 바꿀 수 없습니다. 휴가 관리자에게 정정을 요청하세요.",
    };
  }
  const open = await db
    .select({ id: webLeaveRequests.id })
    .from(webLeaveRequests)
    .where(
      and(
        eq(webLeaveRequests.targetRequestId, target.id),
        eq(webLeaveRequests.status, "PENDING"),
        eq(webLeaveRequests.isDeleted, false),
      ),
    )
    .limit(1);
  if (open[0]) {
    return { ok: false, error: "이 휴가에 대한 변경·취소 신청이 이미 결재 중입니다." };
  }
  return { ok: true, target };
}

/* ------------------------------------------------------------------ */
/* 결재 전 신청 취소                                                     */
/* ------------------------------------------------------------------ */

export async function withdrawRequest(member: Member, requestId: string): Promise<WorkflowResult> {
  if (!isUuid(requestId)) return fail("신청을 찾을 수 없습니다.");
  const done = await db.transaction(async (tx) => {
    const req = await lockRequest(tx, requestId);
    if (!req || req.employeeId !== member.employee.id) return "NOT_FOUND" as const;
    if (req.status !== "PENDING") return "NOT_PENDING" as const;

    await tx
      .update(webLeaveRequests)
      .set({ status: "WITHDRAWN", decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(webLeaveRequests.id, req.id));
    await skipOpenSteps(tx, req.id);
    await writeAudit(
      {
        actor: member.user,
        action: "LEAVE_WITHDRAW",
        summary: `${member.employee.name} 결재 전 신청 취소: ${describe(req)}`,
        entityType: "leave_request",
        entityId: req.id,
      },
      tx,
    );
    return "OK" as const;
  });

  if (done === "NOT_FOUND") return fail("신청을 찾을 수 없습니다.");
  if (done === "NOT_PENDING") return fail("이미 결재가 끝난 신청입니다.");
  return { ok: true, message: "신청을 취소했습니다.", code: "withdrawn" };
}

/* ------------------------------------------------------------------ */
/* 결재 (승인 · 반려)                                                   */
/* ------------------------------------------------------------------ */

export async function decideStep(
  member: Member,
  stepId: string,
  approve: boolean,
  commentRaw: string,
): Promise<WorkflowResult> {
  const comment = commentRaw.trim().slice(0, 300) || null;
  if (!isUuid(stepId)) return fail("결재를 찾을 수 없습니다.");
  if (!approve && !comment) return fail("반려 사유를 적어 주세요.");

  const outcome = await db.transaction(async (tx) => {
    const [step] = await tx
      .select()
      .from(webApprovalSteps)
      .where(and(eq(webApprovalSteps.id, stepId), eq(webApprovalSteps.isDeleted, false)))
      .for("update");
    if (!step || step.status !== "PENDING") return { error: "이미 처리되었거나 없는 결재입니다." };

    const req = await lockRequest(tx, step.requestId);
    if (!req || req.status !== "PENDING") return { error: "이미 처리된 신청입니다." };

    // 권한: 이 단계가 내 것이어야 하고, 자기 신청은 결재할 수 없다.
    // 🔴 「내 것인가」는 approval-scope.ts 한 곳에서 답한다 — 결재함 목록을
    // 거르는 SQL 과 같은 문장이라야 목록에는 보이는데 누르면 막히는 일이 없다.
    // 직급 결재권(isApprover)을 문 앞에서 따로 묻지 않는다: 사람으로 박힌
    // 단계는 그 사람의 것이고, 옛 단계는 저 판정 안에서 직급과 함께 본다.
    const mine = isMyStep(step, {
      employeeId: member.employee.id,
      rankId: member.employee.rankId,
      isApprover: member.isApprover,
    });
    if (!mine || req.employeeId === member.employee.id) {
      return { error: "이 결재를 처리할 권한이 없습니다." };
    }

    const now = new Date();
    await tx
      .update(webApprovalSteps)
      .set({
        status: approve ? "APPROVED" : "REJECTED",
        decidedByEmployeeId: member.employee.id,
        decidedByUserId: member.user.id,
        comment,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(webApprovalSteps.id, step.id));

    let finished = false;
    let waitingFor: string[] = [];
    if (approve) {
      // 아직 승인하지 않은 결재자가 남았는가. 신청 행을 잠근 뒤라 동시에 승인해도 한 번만 확정된다
      const remaining = await remainingApprovers(tx, req.id);
      if (remaining.length === 0) {
        await finalize(tx, req);
        finished = true;
      } else {
        waitingFor = remaining;
      }
    } else {
      await tx
        .update(webLeaveRequests)
        .set({ status: "REJECTED", statusNote: comment, decidedAt: now, updatedAt: now })
        .where(eq(webLeaveRequests.id, req.id));
      await skipOpenSteps(tx, req.id);
    }

    const kindLabel = req.kind === "CHANGE" ? "변경" : req.kind === "CANCEL" ? "취소" : "휴가";
    await writeAudit(
      {
        actor: member.user,
        action: approve ? "APPROVAL_APPROVE" : "APPROVAL_REJECT",
        summary: `${member.employee.name}(${member.employee.rank.name}) ${kindLabel} ${
          approve ? "승인" : "반려"
        }: ${describe(req)}${comment ? ` — ${comment}` : ""}`,
        entityType: "leave_request",
        entityId: req.id,
      },
      tx,
    );
    return { finished, waitingFor };
  });

  if ("error" in outcome) return fail(outcome.error ?? "처리하지 못했습니다.");
  if (!approve) return { ok: true, message: "반려했습니다.", code: "rejected" };
  return {
    ok: true,
    message: outcome.finished
      ? "승인했습니다. 모든 결재권자가 승인해 확정되었습니다."
      : `승인했습니다. ${outcome.waitingFor.join("·")}의 승인을 기다립니다.`,
    code: outcome.finished ? "finished" : "approved",
  };
}

/* ------------------------------------------------------------------ */
/* 관리자: 이 단계 건너뛰기                                              */
/* ------------------------------------------------------------------ */

/**
 * 결재를 기다리는 동안 그 결재자가 퇴사했을 때, 휴가 관리자가 그 단계만
 * 건너뛴다 (2026-09-21 사용자 결정).
 *
 * 🔴 **막힌 신청을 살리는 유일한 출구다.** 결재선이 직급이던 때에는 같은 직급의
 * 다른 사람이 대신 결재할 수 있어 막히는 일이 없었는데, 사람으로 고정하면서
 * 그 안전망이 사라졌다. 결재자가 퇴사하거나 오래 자리를 비우면 그 신청은
 * 영영 대기 상태로 남는다.
 *
 * 승인이 아니다 — 단계 상태는 `SKIPPED` 이고, 누가 왜 건너뛰었는지 단계의
 * 의견과 감사 로그에 남는다. 남은 대기가 없으면 그 자리에서 확정된다.
 */
export async function skipStep(
  admin: Viewer,
  stepId: string,
  reasonRaw: string,
): Promise<WorkflowResult> {
  if (!admin.isAdmin) return fail("휴가 관리자만 단계를 건너뛸 수 있습니다.");
  if (!isUuid(stepId)) return fail("결재를 찾을 수 없습니다.");
  const reason = reasonRaw.trim().slice(0, 300);
  if (!reason) return fail("건너뛰는 사유를 적어 주세요.");

  const outcome = await db.transaction(async (tx) => {
    const [step] = await tx
      .select()
      .from(webApprovalSteps)
      .where(and(eq(webApprovalSteps.id, stepId), eq(webApprovalSteps.isDeleted, false)))
      .for("update");
    if (!step || step.status !== "PENDING") {
      return { error: "이미 처리되었거나 없는 결재입니다." };
    }

    const req = await lockRequest(tx, step.requestId);
    if (!req || req.status !== "PENDING") return { error: "이미 처리된 신청입니다." };

    const [who] = await tx
      .select({ name: webEmployees.name, rankName: webRanks.name })
      .from(webApprovalSteps)
      .innerJoin(webRanks, eq(webRanks.id, webApprovalSteps.rankId))
      .leftJoin(webEmployees, eq(webEmployees.id, webApprovalSteps.approverEmployeeId))
      .where(eq(webApprovalSteps.id, step.id));
    const label = who?.name ?? who?.rankName ?? "결재자";

    const now = new Date();
    await tx
      .update(webApprovalSteps)
      .set({
        status: "SKIPPED",
        comment: `관리자 건너뛰기: ${reason}`,
        decidedByUserId: admin.user.id,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(webApprovalSteps.id, step.id));

    const remaining = await remainingApprovers(tx, req.id);
    if (remaining.length === 0) await finalize(tx, req);

    await writeAudit(
      {
        actor: admin.user,
        action: "APPROVAL_SKIP",
        summary: `관리자 건너뛰기 — ${label} 단계: ${describe(req)} — ${reason}`,
        entityType: "leave_request",
        entityId: req.id,
      },
      tx,
    );
    return { finished: remaining.length === 0, waitingFor: remaining, label };
  });

  if ("error" in outcome) return fail(outcome.error ?? "처리하지 못했습니다.");
  return {
    ok: true,
    message: outcome.finished
      ? `${outcome.label} 단계를 건너뛰었습니다. 남은 결재가 없어 확정되었습니다.`
      : `${outcome.label} 단계를 건너뛰었습니다. ${outcome.waitingFor.join("·")}의 승인을 기다립니다.`,
    code: outcome.finished ? "step-skipped-finished" : "step-skipped",
  };
}

/* ------------------------------------------------------------------ */
/* 관리자 정정: 휴가 취소                                                */
/* ------------------------------------------------------------------ */

export async function adminCancel(
  admin: Viewer,
  requestId: string,
  reasonRaw: string,
): Promise<WorkflowResult> {
  if (!admin.isAdmin) return fail("휴가 관리자만 정정할 수 있습니다.");
  if (!isUuid(requestId)) return fail("휴가를 찾을 수 없습니다.");
  const reason = reasonRaw.trim().slice(0, 300);
  if (!reason) return fail("정정 사유를 적어 주세요.");

  const done = await db.transaction(async (tx) => {
    const req = await lockRequest(tx, requestId);
    if (!req || req.kind === "CANCEL") return "NOT_FOUND" as const;
    if (req.status !== "APPROVED" && req.status !== "PENDING") return "NOT_LIVE" as const;

    const now = new Date();
    await tx
      .update(webLeaveRequests)
      .set({ status: "CANCELED", statusNote: `관리자 정정: ${reason}`, decidedAt: now, updatedAt: now })
      .where(eq(webLeaveRequests.id, req.id));
    await skipOpenSteps(tx, req.id);

    // 이 휴가를 대상으로 결재 중이던 변경·취소 신청도 함께 거둔다
    const followUps = await tx
      .select({ id: webLeaveRequests.id })
      .from(webLeaveRequests)
      .where(
        and(eq(webLeaveRequests.targetRequestId, req.id), eq(webLeaveRequests.status, "PENDING")),
      );
    for (const f of followUps) {
      await tx
        .update(webLeaveRequests)
        .set({ status: "WITHDRAWN", statusNote: "원래 휴가가 관리자 정정으로 취소됨", updatedAt: now })
        .where(eq(webLeaveRequests.id, f.id));
      await skipOpenSteps(tx, f.id);
    }

    await writeAudit(
      {
        actor: admin.user,
        action: "LEAVE_ADMIN_CANCEL",
        summary: `관리자 정정 — 휴가 취소: ${describe(req)} — ${reason}`,
        entityType: "leave_request",
        entityId: req.id,
      },
      tx,
    );
    return "OK" as const;
  });

  if (done === "NOT_FOUND") return fail("휴가를 찾을 수 없습니다.");
  if (done === "NOT_LIVE") return fail("이미 취소되었거나 끝난 신청입니다.");
  return { ok: true, message: "휴가를 취소 처리했습니다.", code: "admin-canceled" };
}
