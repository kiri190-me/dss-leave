"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin, requireMember, safeReturnTo } from "@/lib/auth/guards";
import { resolvePortalActingDelegations } from "@/lib/auth/portal-delegations";
import { PORTAL_DELEGATION_UNAVAILABLE_NOTICE } from "@/lib/leave/labels";
import {
  adminCancel,
  decideStep,
  skipStep,
  submitCancel,
  submitLeave,
  withdrawRequest,
  type WorkflowResult,
} from "@/lib/leave/workflow";

function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "");
}

/**
 * 성공하면 결과 코드를 달고 화면을 옮긴다 (?done=코드 → 화면 위 안내 문구).
 * 처리한 카드가 목록에서 사라지면 폼 아래 문구도 함께 사라지기 때문이다.
 *
 * 🔴 **「포털에 결재권 위임을 못 물었다」는 실패한 자리에서만 말한다**
 * (설계 B-6·B-7). 못 물어도 결재는 그대로 진행되므로 성공한 사람에게는 할 말이
 * 없고, 막힌 사람에게는 **까닭을 짐작할 유일한 단서**다 — 「권한이 없습니다」만
 * 띄우면 대신 눌러야 하는 사람이 자기 권한을 의심하며 끝낸다.
 * 🔵 성공 쪽에 못 싣는 까닭이 하나 더 있다: 성공하면 이 함수는 `redirect` 로
 * 떠나므로 돌려줄 값 자체가 없다(`?done=` 코드 한 글자만 들고 간다).
 */
function finish(result: WorkflowResult, path: string, code?: string): ActionState {
  if (!result.ok) {
    return {
      error: result.portalDelegationUnavailable
        ? `${result.error} ${PORTAL_DELEGATION_UNAVAILABLE_NOTICE}`
        : result.error,
    };
  }
  revalidatePath("/", "layout");
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}done=${code ?? result.code}`);
}

function leaveInput(formData: FormData) {
  return {
    leaveType: field(formData, "leaveType"),
    startDate: field(formData, "startDate"),
    endDate: field(formData, "endDate"),
    reason: field(formData, "reason"),
  };
}

/** 새 휴가 신청 */
export async function submitLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const member = await requireMember();
  return finish(await submitLeave(member, leaveInput(formData)), "/leave");
}

/** 결재가 끝난 휴가의 날짜 변경 신청 */
export async function changeLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const member = await requireMember();
  const result = await submitLeave(member, leaveInput(formData), field(formData, "targetId"));
  if (!result.ok) return { error: result.error };
  return finish(result, "/leave", result.code === "auto" ? "changed" : "change-submitted");
}

/** 결재가 끝난 휴가의 취소 신청 */
export async function cancelLeaveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const member = await requireMember();
  return finish(await submitCancel(member, field(formData, "targetId"), field(formData, "reason")), "/leave");
}

/** 결재 전 신청 거둬들이기 */
export async function withdrawAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const member = await requireMember();
  return finish(await withdrawRequest(member, field(formData, "requestId")), "/leave");
}

/**
 * 결재 (승인·반려). 어느 버튼을 눌렀는지는 decision 으로 온다.
 *
 * 🔴 문 앞에서 `requireApprover()`(직급의 결재권)를 묻지 않는다. 결재선에
 * 이름이 오른 사람은 직급에 결재권이 없어도 자기 단계를 결재해야 하기
 * 때문이다. 진짜 판정은 `decideStep` 이 **단계마다** 한다 — 내 단계가
 * 아니면 거기서 막힌다 (approval-scope.ts).
 *
 * ── 🔴 포털에 **먼저** 묻는다 — 거래가 열리기 전이다 (2026-11-16) ─────────
 * 결재권 위임은 포털 한 곳에 있다(설계 B-1·B-9). `decideStep` 은 판정을 DB
 * 거래 **안에서** 하므로, 그 안에서 포털을 부르면 거래가 망 지연만큼 열려
 * 있게 된다(설계 C-3). 그래서 여기서 묻고 **값만 들고 들어간다.**
 *
 * 🔵 왕복은 한 번뿐이고 상한은 2초다. 포털이 앓아도 결재는 그대로 진행되고
 * (설계 B-6) 대신 눌러야 하는 사람에게만 안내가 뜬다(위 `finish`).
 */
export async function decideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const member = await requireMember();
  const decision = field(formData, "decision");
  if (decision !== "approve" && decision !== "reject") {
    return { error: "승인 또는 반려를 골라 주세요." };
  }
  // 🔴 묻는 열쇠는 **검증된 세션**의 authSub 다(= 포털 users.id). 폼에서 온
  //    값으로 사람을 고르지 않는다 — 그러면 남의 결재권을 자기 것이라고
  //    주장할 수 있는 문이 된다.
  const portal = await resolvePortalActingDelegations(member.user.authSub);
  const result = await decideStep(
    member,
    field(formData, "stepId"),
    decision === "approve",
    field(formData, "comment"),
    portal,
  );
  return finish(result, "/approvals");
}

/**
 * 휴가 관리자가 막힌 결재 단계를 건너뛴다 (결재자 퇴사 등).
 * 끝나면 보던 화면으로 돌아간다.
 */
export async function skipStepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const back = safeReturnTo(field(formData, "back"));
  return finish(await skipStep(admin, field(formData, "stepId"), field(formData, "reason")), back);
}

/** 휴가 관리자의 정정 (휴가 취소 처리). 끝나면 보던 직원 화면으로 돌아간다 */
export async function adminCancelAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const back = safeReturnTo(field(formData, "back"));
  return finish(await adminCancel(admin, field(formData, "requestId"), field(formData, "reason")), back);
}
