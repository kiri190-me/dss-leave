"use server";

/**
 * 휴가 관리자 전용 액션. 모든 함수가 맨 먼저 requireAdmin() 을 부른다.
 * 삭제는 전부 소프트 삭제다.
 */
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import type { ActionState } from "@/lib/action-state";
import { writeAudit } from "@/lib/audit";
import { requireAdmin, type Viewer } from "@/lib/auth/guards";
import { isYmd } from "@/lib/dates";
import { db, type Tx } from "@/lib/db";
import { isUuid } from "@/lib/ids";
import {
  ADJUSTMENT_BUCKETS,
  HOLIDAY_KINDS,
  LEAVE_SETTINGS_ROW_ID,
  USER_ROLES,
  webApprovalRouteSteps,
  webEmployees,
  webHolidays,
  webLeaveAdjustments,
  webLeaveRequests,
  webLeaveSettings,
  webRanks,
  webTenureRules,
  webUsers,
  type AdjustmentBucket,
  type HolidayKind,
  type UserRole,
} from "@/lib/db/schema";
import { loadHolidaySet, loadLeaveSettings } from "@/lib/leave/data";
import { LEAVE_TYPE_INFO, isWorkday, workdaysBetween } from "@/lib/leave/rules";

function text(formData: FormData, key: string, max = 200): string {
  return String(formData.get(key) ?? "").trim().slice(0, max);
}

/** 폼에서 온 ID. UUID 모양이 아니면 빈 문자열 (DB 오류 대신 '찾을 수 없음'으로 끝나게) */
function formId(formData: FormData, key: string): string {
  const value = text(formData, key, 64);
  return isUuid(value) ? value : "";
}

function int(formData: FormData, key: string): number | null {
  const raw = text(formData, key);
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function done(message: string): ActionState {
  revalidatePath("/", "layout");
  return { ok: message };
}

function softDeleteBy(admin: Viewer, reason: string | null) {
  return {
    isDeleted: true,
    deletedAt: new Date(),
    deletedBy: admin.user.id,
    deleteReason: reason,
    updatedAt: new Date(),
  };
}

/**
 * 살아 있는 직급 한 줄. 이름까지 갖고 온다 —
 * 🔴 감사 로그 요약문에 **직급 이름**을 적어야 하기 때문이다(UUID 만 남기면
 * 나중에 로그를 읽는 사람이 무엇이 무엇으로 바뀌었는지 알 수 없다).
 */
async function liveRank(id: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: webRanks.id, name: webRanks.name })
    .from(webRanks)
    .where(and(eq(webRanks.id, id), eq(webRanks.isDeleted, false)))
    .limit(1);
  return row ?? null;
}

async function rankExists(id: string): Promise<boolean> {
  return Boolean(await liveRank(id));
}

/** 감사 로그에 적을 옛 직급 이름. 🔴 지워진 직급도 찾는다 (옛 값이라 남아 있어야 한다) */
async function rankNameOf(id: string): Promise<string> {
  const [row] = await db
    .select({ name: webRanks.name })
    .from(webRanks)
    .where(eq(webRanks.id, id))
    .limit(1);
  return row?.name ?? "(알 수 없음)";
}

/* ------------------------------------------------------------------ */
/* 직원 명단                                                            */
/* ------------------------------------------------------------------ */

export async function createEmployeeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const name = text(formData, "name", 40);
  const rankId = formId(formData, "rankId");
  const hireDate = text(formData, "hireDate");
  if (!name) return { error: "이름을 적어 주세요." };
  if (!(await rankExists(rankId))) return { error: "직급을 골라 주세요." };
  if (!isYmd(hireDate)) return { error: "입사일을 확인하세요." };

  const [created] = await db
    .insert(webEmployees)
    .values({ name, rankId, hireDate, note: text(formData, "note", 300) || null })
    .returning();
  await writeAudit({
    actor: admin.user,
    action: "EMPLOYEE_CREATE",
    summary: `직원 등록: ${name} (입사 ${hireDate})`,
    entityType: "employee",
    entityId: created.id,
  });
  return done(`${name} 님을 명단에 넣었습니다.`);
}

export async function updateEmployeeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const name = text(formData, "name", 40);
  const rankId = formId(formData, "rankId");
  const hireDate = text(formData, "hireDate");
  const isActive = formData.get("isActive") === "on";
  const note = text(formData, "note", 300) || null;
  if (!name) return { error: "이름을 적어 주세요." };
  const rank = await liveRank(rankId);
  if (!rank) return { error: "직급을 골라 주세요." };
  if (!isYmd(hireDate)) return { error: "입사일을 확인하세요." };

  const [before] = await db
    .select()
    .from(webEmployees)
    .where(and(eq(webEmployees.id, id), eq(webEmployees.isDeleted, false)))
    .limit(1);
  if (!before) return { error: "직원을 찾을 수 없습니다." };

  await db
    .update(webEmployees)
    .set({ name, rankId, hireDate, isActive, note, updatedAt: new Date() })
    .where(eq(webEmployees.id, id));

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (before.name !== name) changes.name = { from: before.name, to: name };
  if (before.rankId !== rankId) changes.rankId = { from: before.rankId, to: rankId };
  if (before.hireDate !== hireDate) changes.hireDate = { from: before.hireDate, to: hireDate };
  if (before.isActive !== isActive) changes.isActive = { from: before.isActive, to: isActive };
  if (before.note !== note) changes.note = { from: before.note, to: note };

  // 🔴 요약문에 직급은 **이름**으로 적는다. changes 에는 UUID 가 남지만 그것만으로는
  // 감사 로그를 읽는 사람이 무슨 직급이 무엇으로 바뀌었는지 알 수 없다.
  // (setEmployeeRankAction 과 같은 꼴로 적는다 — 한쪽만 고치면 어느 기록을 믿을지 모르게 된다)
  const notes: string[] = [];
  if (changes.rankId) notes.push(`직급 ${await rankNameOf(before.rankId)} → ${rank.name}`);
  if (changes.hireDate) notes.push(`입사일 ${before.hireDate} → ${hireDate}`);

  await writeAudit({
    actor: admin.user,
    action: "EMPLOYEE_UPDATE",
    summary: `직원 수정: ${name}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`,
    entityType: "employee",
    entityId: id,
    changes,
  });
  return done("저장했습니다.");
}

/**
 * 직원 목록에서 **직급만** 바꾼다.
 *
 * 🔴 updateEmployeeAction 을 재사용하지 않는다. 그 액션은 이름·입사일·재직 여부·
 * 메모까지 **전부 읽어 되쓰므로**, 한 칸만 바꾸는 폼에서 부르면 나머지 네 칸을
 * 덮어쓴다. 특히 `isActive` 는 체크박스 규칙(`=== "on"`)이라 hidden 으로 실어
 * 보내다 틀리면 **사람이 조용히 퇴사 처리된다.**
 *
 * 🔴 직급을 바꾸면 **휴가 사유 열람 범위**가 함께 바뀐다(guards.ts 의 canSeeReason
 * 이 직급의 결재권을 본다). 연차 일수(입사일·근속 표만 본다)와 이미 박힌 결재
 * 단계의 주인(approver_employee_id)은 바뀌지 않는다.
 */
export async function setEmployeeRankAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const rankId = formId(formData, "rankId");

  // 지금 직급은 이름까지 함께 읽는다. 직급이 지워져 있어도 찾아야 하므로 id 로만 잇는다.
  const [before] = await db
    .select({ employee: webEmployees, rank: webRanks })
    .from(webEmployees)
    .innerJoin(webRanks, eq(webRanks.id, webEmployees.rankId))
    .where(and(eq(webEmployees.id, id), eq(webEmployees.isDeleted, false)))
    .limit(1);
  if (!before) return { error: "직원을 찾을 수 없습니다." };

  // 🔴 바뀐 것이 없으면 아무것도 하지 않는다 — 같은 직급을 다시 골랐다고
  // 감사 로그를 늘리지 않는다 (setRoleAction 과 같은 꼴).
  if (before.employee.rankId === rankId) return { ok: "바뀐 것이 없습니다." };

  const next = await liveRank(rankId);
  if (!next) return { error: "직급을 골라 주세요." };

  await db
    .update(webEmployees)
    .set({ rankId, updatedAt: new Date() })
    .where(eq(webEmployees.id, id));
  await writeAudit({
    actor: admin.user,
    action: "EMPLOYEE_RANK",
    summary: `직급 변경: ${before.employee.name} ${before.rank.name} → ${next.name}`,
    entityType: "employee",
    entityId: id,
    changes: {
      rankId: { from: before.employee.rankId, to: next.id },
      rankName: { from: before.rank.name, to: next.name },
    },
  });
  // 목록 표 칸 안에 뜨는 문구다 — 칸이 넓어지지 않게 짧게 적는다.
  return done(`${next.name}(으)로 바꿨습니다.`);
}

/** 잘못 등록한 직원만 지운다. 휴가 기록이 있으면 '퇴사 처리'를 쓴다 */
export async function deleteEmployeeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const [emp] = await db
    .select()
    .from(webEmployees)
    .where(and(eq(webEmployees.id, id), eq(webEmployees.isDeleted, false)))
    .limit(1);
  if (!emp) return { error: "직원을 찾을 수 없습니다." };

  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webLeaveRequests)
    .where(and(eq(webLeaveRequests.employeeId, id), eq(webLeaveRequests.isDeleted, false)));
  if ((used?.n ?? 0) > 0) {
    return { error: "휴가 기록이 있는 직원은 지울 수 없습니다. '재직 중' 체크를 풀어 퇴사 처리하세요." };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(webUsers)
      .set({ employeeId: null, updatedAt: new Date() })
      .where(eq(webUsers.employeeId, id));
    await tx
      .update(webEmployees)
      .set(softDeleteBy(admin, "잘못 등록"))
      .where(eq(webEmployees.id, id));
  });
  await writeAudit({
    actor: admin.user,
    action: "EMPLOYEE_DELETE",
    summary: `직원 삭제(잘못 등록): ${emp.name}`,
    entityType: "employee",
    entityId: id,
  });
  return done(`${emp.name} 님을 명단에서 지웠습니다.`);
}

/* ------------------------------------------------------------------ */
/* 로그인 계정 ↔ 명단 연결, 역할                                          */
/* ------------------------------------------------------------------ */

export async function linkUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const userId = formId(formData, "userId");
  const employeeId = formId(formData, "employeeId");

  const [user] = await db
    .select()
    .from(webUsers)
    .where(and(eq(webUsers.id, userId), eq(webUsers.isDeleted, false)))
    .limit(1);
  if (!user) return { error: "계정을 찾을 수 없습니다." };

  const [emp] = await db
    .select()
    .from(webEmployees)
    .where(
      and(eq(webEmployees.id, employeeId), eq(webEmployees.isDeleted, false), eq(webEmployees.isActive, true)),
    )
    .limit(1);
  if (!emp) return { error: "명단에서 직원을 골라 주세요." };

  const [taken] = await db
    .select({ id: webUsers.id })
    .from(webUsers)
    .where(and(eq(webUsers.employeeId, employeeId), eq(webUsers.isDeleted, false), ne(webUsers.id, userId)))
    .limit(1);
  if (taken) return { error: `${emp.name} 님은 이미 다른 계정과 연결되어 있습니다.` };

  await db
    .update(webUsers)
    .set({ employeeId, updatedAt: new Date() })
    .where(eq(webUsers.id, userId));
  await writeAudit({
    actor: admin.user,
    action: "USER_LINK",
    summary: `계정 연결: ${user.displayName} → 명단의 ${emp.name}`,
    entityType: "user",
    entityId: userId,
  });
  return done(`${user.displayName} 계정을 ${emp.name} 님과 연결했습니다.`);
}

export async function unlinkUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const userId = formId(formData, "userId");
  const [user] = await db
    .select()
    .from(webUsers)
    .where(and(eq(webUsers.id, userId), eq(webUsers.isDeleted, false)))
    .limit(1);
  if (!user) return { error: "계정을 찾을 수 없습니다." };

  await db
    .update(webUsers)
    .set({ employeeId: null, updatedAt: new Date() })
    .where(eq(webUsers.id, userId));
  await writeAudit({
    actor: admin.user,
    action: "USER_UNLINK",
    summary: `계정 연결 해제: ${user.displayName}`,
    entityType: "user",
    entityId: userId,
  });
  return done("연결을 풀었습니다.");
}

export async function setRoleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const userId = formId(formData, "userId");
  const role = text(formData, "role") as UserRole;
  if (!(USER_ROLES as readonly string[]).includes(role)) return { error: "역할을 확인하세요." };

  const [user] = await db
    .select()
    .from(webUsers)
    .where(and(eq(webUsers.id, userId), eq(webUsers.isDeleted, false)))
    .limit(1);
  if (!user) return { error: "계정을 찾을 수 없습니다." };
  if (user.role === role) return { ok: "바뀐 것이 없습니다." };

  if (user.role === "LEAVE_ADMIN" && role !== "LEAVE_ADMIN") {
    const [others] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webUsers)
      .where(
        and(
          eq(webUsers.role, "LEAVE_ADMIN"),
          eq(webUsers.isDeleted, false),
          eq(webUsers.isActive, true),
          ne(webUsers.id, userId),
        ),
      );
    if ((others?.n ?? 0) === 0) return { error: "휴가 관리자가 한 명도 없게 되어 바꿀 수 없습니다." };
  }

  await db.update(webUsers).set({ role, updatedAt: new Date() }).where(eq(webUsers.id, userId));
  await writeAudit({
    actor: admin.user,
    action: "USER_ROLE",
    summary: `역할 변경: ${user.displayName} ${user.role} → ${role}`,
    entityType: "user",
    entityId: userId,
  });
  return done(role === "LEAVE_ADMIN" ? "휴가 관리자로 지정했습니다." : "휴가 관리자에서 뺐습니다.");
}

/* ------------------------------------------------------------------ */
/* 일수 조정                                                            */
/* ------------------------------------------------------------------ */

export async function addAdjustmentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const employeeId = formId(formData, "employeeId");
  const bucket = text(formData, "bucket") as AdjustmentBucket;
  const year = int(formData, "year");
  const days = Number(text(formData, "days"));
  const reason = text(formData, "reason", 300);

  if (!(ADJUSTMENT_BUCKETS as readonly string[]).includes(bucket)) return { error: "연차·월차 중 골라 주세요." };
  if (bucket === "ANNUAL" && (year == null || year < 2000 || year > 2100)) return { error: "연도를 확인하세요." };
  if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 30 || Math.round(days * 2) !== days * 2) {
    return { error: "일수는 0.5일 단위로, -30 ~ 30 사이로 적어 주세요. (빼려면 앞에 - )" };
  }
  if (!reason) return { error: "조정 사유를 적어 주세요." };

  const [emp] = await db
    .select()
    .from(webEmployees)
    .where(and(eq(webEmployees.id, employeeId), eq(webEmployees.isDeleted, false)))
    .limit(1);
  if (!emp) return { error: "직원을 찾을 수 없습니다." };

  const [created] = await db
    .insert(webLeaveAdjustments)
    .values({
      employeeId,
      bucket,
      year: bucket === "ANNUAL" ? year : null,
      days,
      reason,
      createdByUserId: admin.user.id,
    })
    .returning();
  await writeAudit({
    actor: admin.user,
    action: "ADJUSTMENT_CREATE",
    summary: `일수 조정: ${emp.name} ${bucket === "ANNUAL" ? `${year}년 연차` : "월차"} ${days > 0 ? "+" : ""}${days}일 — ${reason}`,
    entityType: "adjustment",
    entityId: created.id,
  });
  return done("조정했습니다.");
}

export async function deleteAdjustmentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const [adj] = await db
    .select()
    .from(webLeaveAdjustments)
    .where(and(eq(webLeaveAdjustments.id, id), eq(webLeaveAdjustments.isDeleted, false)))
    .limit(1);
  if (!adj) return { error: "조정 기록을 찾을 수 없습니다." };

  await db
    .update(webLeaveAdjustments)
    .set(softDeleteBy(admin, "관리자 삭제"))
    .where(eq(webLeaveAdjustments.id, id));
  await writeAudit({
    actor: admin.user,
    action: "ADJUSTMENT_DELETE",
    summary: `일수 조정 삭제: ${adj.days}일 — ${adj.reason}`,
    entityType: "adjustment",
    entityId: id,
  });
  return done("조정을 지웠습니다.");
}

/* ------------------------------------------------------------------ */
/* 직급                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 직급을 넣고 고친다.
 *
 * 🔴 `sort_order` 는 **화면에서 사람이 적지 않는다** (2026-09-21). 이 칸은 이제
 * 결재와 아무 상관이 없고 — 결재선은 web_approval_route_steps 의 사람 목록이
 * 정한다 — 직급·직원 목록을 늘어놓는 차례로만 쓴다. 그래서 **수정할 때는
 * 건드리지 않고**, **새로 넣을 때만 지금 가장 큰 값 + 10** 을 자동으로 준다
 * (하나도 없으면 10). 새 직급은 늘 목록 맨 아래에 선다.
 */
export async function saveRankAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const name = text(formData, "name", 20);
  const canApprove = formData.get("canApprove") === "on";
  if (!name) return { error: "직급 이름을 적어 주세요." };

  const [dup] = await db
    .select({ id: webRanks.id })
    .from(webRanks)
    .where(and(eq(webRanks.name, name), eq(webRanks.isDeleted, false), id ? ne(webRanks.id, id) : undefined))
    .limit(1);
  if (dup) return { error: `'${name}' 직급이 이미 있습니다.` };

  if (id) {
    // sortOrder 는 일부러 뺀다 — 화면에 입력칸이 없으니 기존 값을 그대로 둔다.
    await db
      .update(webRanks)
      .set({ name, canApprove, updatedAt: new Date() })
      .where(and(eq(webRanks.id, id), eq(webRanks.isDeleted, false)));
    await writeAudit({
      actor: admin.user,
      action: "RANK_UPDATE",
      summary: `직급 수정: ${name} (결재권 ${canApprove ? "있음" : "없음"})`,
      entityType: "rank",
      entityId: id,
    });
    return done("직급을 저장했습니다.");
  }

  // 새 직급은 목록 맨 아래. 살아 있는 직급 중 가장 큰 값 + 10 (하나도 없으면 10).
  const [top] = await db
    .select({ maxOrder: sql<number | null>`max(${webRanks.sortOrder})::int` })
    .from(webRanks)
    .where(eq(webRanks.isDeleted, false));
  const sortOrder = (top?.maxOrder ?? 0) + 10;

  const [created] = await db.insert(webRanks).values({ name, sortOrder, canApprove }).returning();
  await writeAudit({
    actor: admin.user,
    action: "RANK_CREATE",
    summary: `직급 추가: ${name} (결재권 ${canApprove ? "있음" : "없음"}) — 목록 맨 아래`,
    entityType: "rank",
    entityId: created.id,
  });
  return done(`'${name}' 직급을 추가했습니다.`);
}

export async function deleteRankAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const [inUse] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webEmployees)
    .where(and(eq(webEmployees.rankId, id), eq(webEmployees.isDeleted, false)));
  if ((inUse?.n ?? 0) > 0) return { error: "이 직급의 직원이 있어 지울 수 없습니다." };

  const [rank] = await db
    .update(webRanks)
    .set(softDeleteBy(admin, "관리자 삭제"))
    .where(and(eq(webRanks.id, id), eq(webRanks.isDeleted, false)))
    .returning();
  if (!rank) return { error: "직급을 찾을 수 없습니다." };
  await writeAudit({
    actor: admin.user,
    action: "RANK_DELETE",
    summary: `직급 삭제: ${rank.name}`,
    entityType: "rank",
    entityId: id,
  });
  return done("직급을 지웠습니다.");
}

/* ------------------------------------------------------------------ */
/* 결재선 — 순서 있는 사람 목록 하나 (2026-09-21: 직급 → 사람)            */
/* ------------------------------------------------------------------ */

/**
 * 지금 살아 있는 결재선 줄. 차례대로.
 *
 * 🔴 `step_no` 에 유일 색인을 걸지 않았다. 순서를 바꾸려면 두 줄의 번호를
 * 맞바꿔야 하는데, 유일 색인이 있으면 그 중간 상태에서 걸려 넘어진다
 * (Postgres 의 유일 **색인**은 문장마다 검사하고 미룰 수 없다). 대신 줄을
 * 넣거나 빼거나 옮길 때마다 한 트랜잭션 안에서 1..n 으로 다시 번호를 매긴다.
 */
async function liveRouteSteps(q: typeof db | Tx = db) {
  return q
    .select()
    .from(webApprovalRouteSteps)
    .where(eq(webApprovalRouteSteps.isDeleted, false))
    .orderBy(asc(webApprovalRouteSteps.stepNo), asc(webApprovalRouteSteps.createdAt));
}

/** 남은 줄에 1..n 을 다시 매긴다. 부르는 쪽이 원하는 차례로 정렬해 넘긴다 */
async function renumberRoute(tx: Tx, ordered: { id: string; stepNo: number }[]): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    const stepNo = index + 1;
    if (row.stepNo === stepNo) continue;
    await tx
      .update(webApprovalRouteSteps)
      .set({ stepNo, updatedAt: new Date() })
      .where(eq(webApprovalRouteSteps.id, row.id));
  }
}

/** 감사 로그에 남길 「지금 결재선」 한 줄 */
async function routeSummary(tx: Tx): Promise<string> {
  const rows = await tx
    .select({ name: webEmployees.name, stepNo: webApprovalRouteSteps.stepNo })
    .from(webApprovalRouteSteps)
    .innerJoin(webEmployees, eq(webEmployees.id, webApprovalRouteSteps.approverEmployeeId))
    .where(eq(webApprovalRouteSteps.isDeleted, false))
    .orderBy(asc(webApprovalRouteSteps.stepNo));
  return rows.length === 0 ? "(없음 — 결재 없이 바로 등록)" : rows.map((r) => r.name).join(" → ");
}

export async function addRouteStepAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const employeeId = formId(formData, "employeeId");
  const [emp] = await db
    .select()
    .from(webEmployees)
    .where(
      and(
        eq(webEmployees.id, employeeId),
        eq(webEmployees.isDeleted, false),
        eq(webEmployees.isActive, true),
      ),
    )
    .limit(1);
  if (!emp) return { error: "결재선에 넣을 사람을 골라 주세요." };

  const summary = await db.transaction(async (tx) => {
    const rows = await liveRouteSteps(tx);
    if (rows.some((r) => r.approverEmployeeId === employeeId)) return null;
    await tx.insert(webApprovalRouteSteps).values({
      approverEmployeeId: employeeId,
      stepNo: rows.length + 1,
    });
    return routeSummary(tx);
  });
  if (summary === null) return { error: `${emp.name} 님은 이미 결재선에 있습니다.` };

  await writeAudit({
    actor: admin.user,
    action: "APPROVAL_ROUTE_UPDATE",
    summary: `결재선에 ${emp.name} 추가 → ${summary}`,
    entityType: "approval_route",
  });
  return done(`${emp.name} 님을 결재선 맨 뒤에 넣었습니다.`);
}

export async function removeRouteStepAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");

  const result = await db.transaction(async (tx) => {
    const rows = await liveRouteSteps(tx);
    const target = rows.find((r) => r.id === id);
    if (!target) return null;
    await tx
      .update(webApprovalRouteSteps)
      .set(softDeleteBy(admin, "결재선에서 뺌"))
      .where(eq(webApprovalRouteSteps.id, id));
    await renumberRoute(
      tx,
      rows.filter((r) => r.id !== id),
    );
    const [emp] = await tx
      .select({ name: webEmployees.name })
      .from(webEmployees)
      .where(eq(webEmployees.id, target.approverEmployeeId));
    return { name: emp?.name ?? "그 사람", summary: await routeSummary(tx) };
  });
  if (!result) return { error: "결재선에서 찾을 수 없습니다." };

  await writeAudit({
    actor: admin.user,
    action: "APPROVAL_ROUTE_UPDATE",
    summary: `결재선에서 ${result.name} 뺌 → ${result.summary}`,
    entityType: "approval_route",
  });
  return done(
    `${result.name} 님을 결재선에서 뺐습니다. 🔴 이미 결재 중인 신청의 결재자는 그대로입니다.`,
  );
}

export async function moveRouteStepAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const dir = text(formData, "dir", 4);
  if (dir !== "up" && dir !== "down") return { error: "옮길 방향을 알 수 없습니다." };

  const summary = await db.transaction(async (tx) => {
    const rows = await liveRouteSteps(tx);
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) return null;
    const swapWith = dir === "up" ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= rows.length) return "EDGE" as const;

    // 두 줄이 서로의 번호를 갖는다. 먼저 한 줄을 아무도 쓰지 않는 번호(0)로
    // 비켜 두고 맞바꾼다 — 그래야 나중에 step_no 에 유일 색인을 걸어도 안전하다.
    const me = rows[index];
    const other = rows[swapWith];
    const now = new Date();
    await tx
      .update(webApprovalRouteSteps)
      .set({ stepNo: 0, updatedAt: now })
      .where(eq(webApprovalRouteSteps.id, me.id));
    await tx
      .update(webApprovalRouteSteps)
      .set({ stepNo: me.stepNo, updatedAt: now })
      .where(eq(webApprovalRouteSteps.id, other.id));
    await tx
      .update(webApprovalRouteSteps)
      .set({ stepNo: other.stepNo, updatedAt: now })
      .where(eq(webApprovalRouteSteps.id, me.id));
    return routeSummary(tx);
  });
  if (summary === null) return { error: "결재선에서 찾을 수 없습니다." };
  if (summary === "EDGE") return { ok: "더 옮길 곳이 없습니다." };

  await writeAudit({
    actor: admin.user,
    action: "APPROVAL_ROUTE_UPDATE",
    summary: `결재선 순서 변경 → ${summary}`,
    entityType: "approval_route",
  });
  return done("결재선 순서를 바꿨습니다.");
}

/* ------------------------------------------------------------------ */
/* 회사 전체 휴가 설정 — 여름휴가 일수                                    */
/* 🔴 사람마다·해마다 다르지 않다. 표에 줄이 하나뿐이다                    */
/* ------------------------------------------------------------------ */

export async function saveLeaveSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const summerDays = int(formData, "summerDays");
  // 🔴 여름휴가에 반차가 없으므로 **하루 단위**만 받는다 (0.5일을 막는다).
  if (summerDays == null || summerDays < 0 || summerDays > 60) {
    return { error: "여름휴가 일수는 0~60 사이의 정수로 적어 주세요." };
  }

  const before = (await loadLeaveSettings()).summerDays;
  if (before === summerDays) return done("그대로입니다.");

  await db
    .insert(webLeaveSettings)
    .values({ id: LEAVE_SETTINGS_ROW_ID, summerDays })
    .onConflictDoUpdate({
      target: webLeaveSettings.id,
      set: { summerDays, updatedAt: new Date() },
    });

  await writeAudit({
    actor: admin.user,
    action: "LEAVE_SETTINGS_UPDATE",
    summary: `여름휴가 일수 ${before}일 → ${summerDays}일`,
    entityType: "leave_settings",
    changes: { summerDays: { from: before, to: summerDays } },
  });
  return done(`여름휴가를 연 ${summerDays}일로 저장했습니다.`);
}

/* ------------------------------------------------------------------ */
/* 근속 연차별 일수                                                      */
/* ------------------------------------------------------------------ */

export async function saveTenureRuleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const fromYear = int(formData, "fromYear");
  const toYear = int(formData, "toYear");
  const days = Number(text(formData, "days"));
  if (fromYear == null || toYear == null || fromYear < 1 || toYear < fromYear || toYear > 60) {
    return { error: "근속 연차를 확인하세요. (1 이상, 앞 숫자 ≤ 뒤 숫자)" };
  }
  if (!Number.isFinite(days) || days < 0 || days > 60 || Math.round(days * 2) !== days * 2) {
    return { error: "일수는 0.5일 단위로 적어 주세요." };
  }

  const others = await db
    .select()
    .from(webTenureRules)
    .where(and(eq(webTenureRules.isDeleted, false), id ? ne(webTenureRules.id, id) : undefined));
  const clash = others.find((r) => r.fromYear <= toYear && fromYear <= r.toYear);
  if (clash) {
    return { error: `${clash.fromYear}~${clash.toYear}년차 줄과 겹칩니다.` };
  }

  if (id) {
    await db
      .update(webTenureRules)
      .set({ fromYear, toYear, days, updatedAt: new Date() })
      .where(and(eq(webTenureRules.id, id), eq(webTenureRules.isDeleted, false)));
    await writeAudit({
      actor: admin.user,
      action: "TENURE_RULE_UPDATE",
      summary: `근속 표 수정: ${fromYear}~${toYear}년차 ${days}일`,
      entityType: "tenure_rule",
      entityId: id,
    });
    return done("저장했습니다.");
  }

  const [created] = await db.insert(webTenureRules).values({ fromYear, toYear, days }).returning();
  await writeAudit({
    actor: admin.user,
    action: "TENURE_RULE_CREATE",
    summary: `근속 표 추가: ${fromYear}~${toYear}년차 ${days}일`,
    entityType: "tenure_rule",
    entityId: created.id,
  });
  return done(`${fromYear}~${toYear}년차 ${days}일을 추가했습니다.`);
}

export async function deleteTenureRuleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const [rule] = await db
    .update(webTenureRules)
    .set(softDeleteBy(admin, "관리자 삭제"))
    .where(and(eq(webTenureRules.id, id), eq(webTenureRules.isDeleted, false)))
    .returning();
  if (!rule) return { error: "찾을 수 없습니다." };
  await writeAudit({
    actor: admin.user,
    action: "TENURE_RULE_DELETE",
    summary: `근속 표 삭제: ${rule.fromYear}~${rule.toYear}년차 ${rule.days}일`,
    entityType: "tenure_rule",
    entityId: id,
  });
  return done("지웠습니다.");
}

/* ------------------------------------------------------------------ */
/* 공휴일 · 회사 휴무일                                                  */
/* ------------------------------------------------------------------ */

/**
 * 휴일을 넣거나 빼면, 그날을 걸친 휴가의 일수를 다시 센다.
 * (새로 쉬는 날로 정해진 날에 휴가를 냈다면 그날은 휴가에서 빠져야 한다)
 */
async function recomputeDaysAround(day: string): Promise<number> {
  const holidays = await loadHolidaySet();
  const rows = await db
    .select()
    .from(webLeaveRequests)
    .where(
      and(
        eq(webLeaveRequests.isDeleted, false),
        inArray(webLeaveRequests.status, ["APPROVED", "PENDING"]),
        lte(webLeaveRequests.startDate, day),
        gte(webLeaveRequests.endDate, day),
      ),
    );
  let changed = 0;
  for (const r of rows) {
    const n = LEAVE_TYPE_INFO[r.leaveType].halfDay
      ? isWorkday(r.startDate, holidays)
        ? 0.5
        : 0
      : workdaysBetween(r.startDate, r.endDate, holidays).length;
    if (n !== r.days) {
      await db
        .update(webLeaveRequests)
        .set({ days: n, updatedAt: new Date() })
        .where(eq(webLeaveRequests.id, r.id));
      changed += 1;
    }
  }
  return changed;
}

export async function createHolidayAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const day = text(formData, "day");
  const name = text(formData, "name", 40);
  const kind = text(formData, "kind") as HolidayKind;
  if (!isYmd(day)) return { error: "날짜를 확인하세요." };
  if (!name) return { error: "이름을 적어 주세요. (예: 창립기념일)" };
  if (!(HOLIDAY_KINDS as readonly string[]).includes(kind)) return { error: "종류를 골라 주세요." };

  const [dup] = await db
    .select({ id: webHolidays.id })
    .from(webHolidays)
    .where(and(eq(webHolidays.day, day), eq(webHolidays.isDeleted, false)))
    .limit(1);
  if (dup) return { error: "그날은 이미 휴일로 등록되어 있습니다." };

  const [created] = await db.insert(webHolidays).values({ day, name, kind }).returning();
  await writeAudit({
    actor: admin.user,
    action: "HOLIDAY_CREATE",
    summary: `휴일 추가: ${day} ${name}`,
    entityType: "holiday",
    entityId: created.id,
  });
  const changed = await recomputeDaysAround(day);
  return done(
    `${day} ${name}을(를) 추가했습니다.${changed ? ` 그날에 걸친 휴가 ${changed}건의 일수를 다시 셌습니다.` : ""}`,
  );
}

export async function deleteHolidayAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = formId(formData, "id");
  const [h] = await db
    .update(webHolidays)
    .set(softDeleteBy(admin, "관리자 삭제"))
    .where(and(eq(webHolidays.id, id), eq(webHolidays.isDeleted, false)))
    .returning();
  if (!h) return { error: "찾을 수 없습니다." };
  await writeAudit({
    actor: admin.user,
    action: "HOLIDAY_DELETE",
    summary: `휴일 삭제: ${h.day} ${h.name}`,
    entityType: "holiday",
    entityId: id,
  });
  const changed = await recomputeDaysAround(h.day);
  return done(`지웠습니다.${changed ? ` 그날에 걸친 휴가 ${changed}건의 일수를 다시 셌습니다.` : ""}`);
}
