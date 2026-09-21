"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { ActionState } from "@/lib/action-state";
import { requireAdmin, requireMember, safeReturnTo } from "@/lib/auth/guards";
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
 */
function finish(result: WorkflowResult, path: string, code?: string): ActionState {
  if (!result.ok) return { error: result.error };
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
 */
export async function decideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const member = await requireMember();
  const decision = field(formData, "decision");
  if (decision !== "approve" && decision !== "reject") {
    return { error: "승인 또는 반려를 골라 주세요." };
  }
  const result = await decideStep(
    member,
    field(formData, "stepId"),
    decision === "approve",
    field(formData, "comment"),
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
