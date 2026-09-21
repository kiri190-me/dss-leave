import type { LeaveRequest } from "@/lib/db/schema";
import type { StepView } from "@/lib/leave/data";
import {
  KIND_LABEL,
  LEAVE_TYPE_INFO,
  STATUS_BADGE,
  STATUS_LABEL,
  STEP_STATUS_SUFFIX,
  TYPE_CHIP,
  approvalTurnLabel,
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
 * 결재 진행 (한 명씩 차례로):
 *   2/3 단계 · 지금 최동욱 차례 → 정민재 ✓ → 최동욱 지금 차례 → 윤성호 차례 기다림
 *
 * 이름은 **그 단계를 맡은 사람**이다. 결재선이 직급이던 때에 만들어진 옛
 * 단계만 직급 이름이 나온다 (labels.ts 의 stepLabel).
 *
 * 🔴 「지금 누구 차례인가」는 `rules.ts` 의 `approvalProgress` 가 고른다 —
 * workflow.ts 가 다음 사람을 깨울 때 쓰는 함수와 **같은 것**이다. 화면이 따로
 * 세면 「지금 ○○○ 차례」라고 적어 놓고 실제로는 다른 사람을 기다리게 된다.
 */
export function StepTrail({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) {
    return <span className="text-xs text-slate-500">결재 없이 등록</span>;
  }
  const turn = approvalTurnLabel(steps);
  const ordered = [...steps].sort((a, b) => a.stepNo - b.stepNo);
  return (
    <ul className="flex flex-wrap items-center gap-1 text-xs">
      <li className="mr-0.5 font-medium text-slate-500">{turn ?? "결재"}</li>
      {ordered.map((s, i) => (
        <li key={s.id} className="flex items-center gap-1">
          {i > 0 && <span className="text-slate-300">→</span>}
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
                    ? "rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900 ring-1 ring-amber-300"
                    : s.status === "WAITING"
                      ? "rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-slate-500"
                      : "rounded px-1.5 py-0.5 text-slate-400"
            }
          >
            {stepLabel(s)}
            {STEP_STATUS_SUFFIX[s.status] ?? ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
