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
 *
 * 🔵 2026-11-16 저녁까지 여기서 「포털에 결재권 위임을 못 물었습니다」 한 줄을
 * 실패 쪽에 덧붙였다(설계 B-7). 위임을 포털이 **써 주는** 방식으로 뒤집히면서
 * (B-12) 「못 물음」이라는 상태가 없어져 함께 걷어냈다.
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
 *
 * ── 🔴 결재권 위임은 **거래가 열리기 전에** 읽힌다 (2026-11-16) ───────────
 * 위임 목록은 `requireMember()` 가 사람을 읽을 때 이미 딸려 온다
 * (auth/guards.ts 의 `loadEmployee` → auth/portal-delegations.ts). `decideStep`
 * 은 판정을 DB 거래 **안에서** 하므로, 그 안에서 또 조회를 던지면 결재 행 잠금을
 * 쥔 채로 한 왕복을 더 기다리게 된다(설계 C-3). 그래서 **값만 들고 들어간다.**
 *
 * 🔴 **그 목록의 열쇠는 검증된 세션에서 왔다.** 폼에서 온 값으로 사람을 고르는
 * 자리가 한 군데도 없다 — 그러면 남의 결재권을 자기 것이라고 주장할 수 있는
 * 문이 된다.
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
    // 🔴 넘기지 않으면 **대신 누를 결재가 목록에는 뜨는데 눌리지 않는다** —
    //    결재함 조회는 같은 값을 제 손으로 싣기 때문이다(data.ts 의 deciderOf).
    member.employee.actingForEmployeeIds,
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
