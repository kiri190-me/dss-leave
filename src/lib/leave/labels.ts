/**
 * 화면에 보일 글자와 색. Tailwind 가 클래스를 찾을 수 있게 전부 글자 그대로 적는다.
 */
import type { LeaveType, RequestKind, RequestStatus } from "@/lib/db/schema";
import { approvalProgress, type StepSlot } from "./rules";

export { LEAVE_TYPE_INFO } from "./rules";

/** 달력 칩 색 (휴가 종류별) */
export const TYPE_CHIP: Record<LeaveType, string> = {
  ANNUAL: "bg-red-200 text-red-900 border-red-400",
  AM_HALF: "bg-rose-100 text-rose-900 border-rose-300",
  PM_HALF: "bg-rose-100 text-rose-900 border-rose-300",
  SUMMER: "bg-amber-100 text-amber-900 border-amber-300",
  CONDOLENCE: "bg-violet-100 text-violet-900 border-violet-300",
  HEALTH_CHECK: "bg-blue-100 text-blue-900 border-blue-300",
  RESERVE: "bg-lime-100 text-lime-900 border-lime-300",
  OTHER: "bg-slate-100 text-slate-800 border-slate-300",
};

/** 달력 칩의 짧은 이름 */
export const TYPE_SHORT: Record<LeaveType, string> = {
  ANNUAL: "연차",
  AM_HALF: "오전반차",
  PM_HALF: "오후반차",
  SUMMER: "여름휴가",
  CONDOLENCE: "경조사",
  HEALTH_CHECK: "건강검진",
  RESERVE: "예비군",
  OTHER: "기타",
};

export const STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: "결재 중",
  APPROVED: "승인",
  REJECTED: "반려",
  WITHDRAWN: "신청 취소",
  CANCELED: "취소됨",
  SUPERSEDED: "변경됨",
};

export const STATUS_BADGE: Record<RequestStatus, string> = {
  PENDING: "bg-amber-100 text-amber-900",
  APPROVED: "bg-emerald-100 text-emerald-900",
  REJECTED: "bg-red-100 text-red-800",
  WITHDRAWN: "bg-slate-100 text-slate-600",
  CANCELED: "bg-slate-100 text-slate-600",
  SUPERSEDED: "bg-slate-100 text-slate-600",
};

export const KIND_LABEL: Record<RequestKind, string> = {
  NEW: "휴가 신청",
  CHANGE: "날짜 변경",
  CANCEL: "취소 요청",
};

/**
 * 결재 단계에 적을 이름. 사람이 박혀 있으면 **사람**, 사람 칸이 빈 옛 단계는 직급.
 * (결재선이 직급이던 때에 만들어진 단계만 직급 이름이 나온다)
 */
export function stepLabel(step: { approverName: string | null; rankName: string }): string {
  return step.approverName ?? step.rankName;
}

/** 결재 단계 상태에 붙일 한 마디. 순차라 「지금 차례」와 「차례 기다림」이 갈린다 */
export const STEP_STATUS_SUFFIX: Record<string, string> = {
  APPROVED: " ✓",
  REJECTED: " ✕",
  PENDING: " 지금 차례",
  WAITING: " 차례 기다림",
  SKIPPED: " 건너뜀",
};

/**
 * 「2/3 단계 · 지금 최동욱 차례」 — 결재가 어디까지 왔는지 한 줄로.
 * 결재가 끝났거나 단계가 없으면 `null`(붙일 말이 없다).
 *
 * 🔴 차례를 고르는 셈은 `rules.ts` 의 `approvalProgress` 한 곳에 있다 —
 * workflow.ts 가 다음 사람을 깨울 때 쓰는 함수와 **같은 것**이라야 화면이
 * 「지금 ○○○ 차례」라고 적어 놓고 실제로는 다른 사람을 기다리는 일이 없다.
 */
export function approvalTurnLabel(
  steps: readonly (StepSlot & { approverName: string | null; rankName: string })[],
): string | null {
  const { total, position, current } = approvalProgress(steps);
  if (!current || total === 0) return null;
  return `${position}/${total} 단계 · 지금 ${stepLabel(current)} 차례`;
}

/** 1 → "1일", 0.5 → "0.5일", 2.5 → "2.5일" */
export function formatDays(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1)}일`;
}
