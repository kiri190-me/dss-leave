import type { LeaveRequest } from "@/lib/db/schema";
import type { StepView } from "@/lib/leave/data";
import {
  KIND_LABEL,
  LEAVE_TYPE_INFO,
  STATUS_BADGE,
  STATUS_LABEL,
  TYPE_CHIP,
  stepLabel,
} from "@/lib/leave/labels";

export function StatusBadge({ status }: { status: LeaveRequest["status"] }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function KindBadge({ kind }: { kind: LeaveRequest["kind"] }) {
  if (kind === "NEW") return null;
  return (
    <span className="inline-flex items-center rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-600">
      {KIND_LABEL[kind]}
    </span>
  );
}

export function TypeChip({ type }: { type: LeaveRequest["leaveType"] }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${TYPE_CHIP[type]}`}
    >
      {LEAVE_TYPE_INFO[type].label}
    </span>
  );
}

/**
 * 결재 진행 (순서 없음): 정민재 ✓ · 최동욱 대기 · 윤성호 ✓
 *
 * 이름은 **그 단계를 맡은 사람**이다. 결재선이 직급이던 때에 만들어진 옛
 * 단계만 직급 이름이 나온다 (labels.ts 의 stepLabel).
 */
export function StepTrail({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) {
    return <span className="text-xs text-slate-500">결재 없이 등록</span>;
  }
  return (
    <ul className="flex flex-wrap items-center gap-1 text-xs">
      <li className="mr-0.5 text-slate-400">결재</li>
      {steps.map((s) => (
        <li key={s.id}>
          <span
            title={
              s.decidedByName
                ? `${s.decidedByName}${s.comment ? ` — ${s.comment}` : ""}`
                : undefined
            }
            className={
              s.status === "APPROVED"
                ? "rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800"
                : s.status === "REJECTED"
                  ? "rounded bg-red-50 px-1.5 py-0.5 text-red-700"
                  : s.status === "PENDING"
                    ? "rounded bg-amber-50 px-1.5 py-0.5 text-amber-900 ring-1 ring-amber-300"
                    : "rounded px-1.5 py-0.5 text-slate-400"
            }
          >
            {stepLabel(s)}
            {s.status === "APPROVED" && " ✓"}
            {s.status === "REJECTED" && " ✕"}
            {s.status === "PENDING" && " 대기"}
          </span>
        </li>
      ))}
    </ul>
  );
}
