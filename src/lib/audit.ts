/**
 * 감사 로그. append-only — 화면에서 개별 레코드를 지울 수 있게 만들지 않는다.
 */
import { headers } from "next/headers";

import { db, type Tx } from "@/lib/db";
import { webAuditLogs, type WebUser } from "@/lib/db/schema";

export type AuditAction =
  | "LOGIN"
  | "LOGOUT"
  | "LEAVE_REQUEST"
  | "LEAVE_WITHDRAW"
  | "LEAVE_CHANGE_REQUEST"
  | "LEAVE_CANCEL_REQUEST"
  | "APPROVAL_APPROVE"
  | "APPROVAL_REJECT"
  /** 관리자가 막힌 단계를 건너뜀 (결재자 퇴사 등). 승인이 아니다 */
  | "APPROVAL_SKIP"
  /** 결재선(사람 순서 목록)을 고침 */
  | "APPROVAL_ROUTE_UPDATE"
  | "LEAVE_ADMIN_CANCEL"
  | "EMPLOYEE_CREATE"
  | "EMPLOYEE_UPDATE"
  /**
   * 직원의 **직급만** 바꿨다 (직원 관리 목록에서 바로).
   * 🔴 직급은 휴가 사유 열람 범위를 정하므로 EMPLOYEE_UPDATE 에 묻지 않고 따로 남긴다.
   */
  | "EMPLOYEE_RANK"
  | "EMPLOYEE_DELETE"
  | "USER_LINK"
  | "USER_UNLINK"
  | "USER_ROLE"
  | "RANK_CREATE"
  | "RANK_UPDATE"
  | "RANK_DELETE"
  /** 회사 전체 휴가 설정을 고침 (여름휴가 일수) */
  | "LEAVE_SETTINGS_UPDATE"
  | "TENURE_RULE_CREATE"
  | "TENURE_RULE_UPDATE"
  | "TENURE_RULE_DELETE"
  | "HOLIDAY_CREATE"
  | "HOLIDAY_DELETE"
  | "ADJUSTMENT_CREATE"
  | "ADJUSTMENT_DELETE";

async function clientIp(): Promise<string | null> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
    return h.get("x-real-ip");
  } catch {
    // 요청 밖(스크립트)에서 부르면 headers() 가 없다.
    return null;
  }
}

export async function writeAudit(
  input: {
    actor: Pick<WebUser, "id" | "displayName"> | null;
    action: AuditAction;
    summary: string;
    entityType?: string;
    entityId?: string;
    changes?: Record<string, unknown>;
  },
  tx?: Tx,
): Promise<void> {
  const values = {
    actorUserId: input.actor?.id ?? null,
    actorName: input.actor?.displayName ?? "(알 수 없음)",
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: input.summary,
    changes: input.changes ?? null,
    ip: await clientIp(),
  };

  // 트랜잭션 안에서 부르면 본 작업과 함께 기록된다 (본 작업이 취소되면 로그도 취소).
  if (tx) {
    await tx.insert(webAuditLogs).values(values);
    return;
  }

  try {
    await db.insert(webAuditLogs).values(values);
  } catch (error) {
    // 감사 로그 실패가 본 작업을 막지는 않게 한다. 대신 서버 로그에는 남긴다.
    console.error("감사 로그 기록 실패", error);
  }
}
