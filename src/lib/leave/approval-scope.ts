/**
 * 「이 결재 단계가 내 것인가」 — 한 곳에서만 답한다.
 *
 * 이 판정은 두 군데에서 쓰인다. 하나는 결재함 질의(data.ts, SQL 의 where),
 * 다른 하나는 승인·반려를 실제로 막는 자리(workflow.ts 의 decideStep).
 * 🔴 **둘이 어긋나면 결재함에는 보이는데 누르면 「권한이 없습니다」가 되거나,
 * 그 반대가 된다.** 그래서 값으로 답하는 함수와 SQL 조각을 나란히 두고
 * 같은 문장을 두 번 쓴다 — 고칠 때 둘을 함께 고치라고.
 *
 * ── 판정 ────────────────────────────────────────────────────────────
 * 1. 단계에 **사람이 박혀 있으면**(approver_employee_id) 그 사람만 결재한다.
 *    직급은 보지 않는다. 결재선에 이름이 오른 사람이 곧 결재권자다.
 * 2. 사람 칸이 **비어 있으면**(옛 행) 예전 규칙대로 **직급**으로 판정한다.
 *    🔴 이 두 번째 줄이 없으면 **전환 순간 대기 중이던 신청이 모든 결재함에서
 *    사라진다.** 사람 기반으로 바뀌기 전에 만들어진 단계는 rank_id 만 있고
 *    approver_employee_id 가 null 이기 때문이다. 옛 신청은 옛 규칙대로 끝까지
 *    흘러가야 한다 (scripts/test-leave-rules.ts 의 「전환」 시험이 못 박는다).
 *
 * 옛 행의 직급 판정에는 예전과 똑같이 `isApprover`(직급의 결재권)를 함께 본다 —
 * 전환 전에 결재할 수 있던 사람의 범위를 넓히지도 좁히지도 않는다.
 *
 * ── 이 파일에는 판정이 **둘** 있다 (2026-09-22) ──────────────────────
 * 위의 「이 단계가 내 것인가」와, 아래의 「결재함 문을 열 수 있는가」
 * (`canOpenApprovalBox`)다. 🔴 **섞이면 안 되므로** 한 파일에 나란히 둔다 —
 * 무엇이 왜 다른지는 아래 함수 머리말에 적었다.
 */
import { and, eq, isNull, or, type SQL } from "drizzle-orm";

import { webApprovalSteps } from "@/lib/db/schema";

/** 결재 단계에서 주인을 가리는 데 필요한 두 칸 */
export type StepOwner = {
  /** 사람으로 박힌 결재자. 옛 행은 null */
  approverEmployeeId: string | null;
  /** 표시용 직급. 옛 행에서는 이것이 유일한 주인 표시다 */
  rankId: string;
};

/** 결재하려는 사람 */
export type Decider = {
  employeeId: string;
  rankId: string;
  /** 직급에 결재권이 있는가 (guards.ts 의 isApprover 그대로) */
  isApprover: boolean;
};

/** 이 단계는 내 것인가 (값으로) */
export function isMyStep(step: StepOwner, me: Decider): boolean {
  if (step.approverEmployeeId !== null) return step.approverEmployeeId === me.employeeId;
  return me.isApprover && step.rankId === me.rankId;
}

/* ------------------------------------------------------------------ */
/* 「결재함 문을 열 수 있는가」 — 위 판정과 **다른 질문**이다               */
/* ------------------------------------------------------------------ */

/**
 * 🔴 **`isApprover` 와 갈라 둔 까닭** (2026-09-22).
 *
 * 「결재함을 열 수 있는가」와 「이 단계를 결재할 수 있는가」는 다른 말인데, 오래
 * 한 값(`isApprover` = 직급의 결재권)이 둘을 함께 맡고 있었다. 결재선이 직급에서
 * **사람**으로 바뀐 뒤(2026-09-21) 그 겹침이 결함이 됐다 — 결재선에 이름이
 * 올랐지만 직급에 결재권이 없는 사람은 자기 차례가 되어 알림까지 받는데
 * **머리말에 「결재함」 메뉴가 그려지지 않는다.**
 *
 * 그렇다고 `isApprover` 를 「결재선에 올랐으면 true」로 넓힐 수는 없다. 그 값은
 * 위 `isMyStep`·`myStepCondition` 에도 넘어가는데, 거기서는 뜻이 전혀 다르다 —
 * 🔴 **「사람 칸이 빈 옛 직급 단계도 볼 수 있는가」**다. 넓히면 결재선에 이름이
 * 올랐다는 이유로 **남의 직급에 걸린 옛 단계까지 제 결재함에 뜬다.** 사유 열람
 * (guards.ts 의 `canSeeReason`)도 같은 값을 보므로 함께 넓어진다.
 *
 * 그래서 값을 둘로 나눈다:
 *   · `isApprover`          직급의 결재권 그대로. **뜻을 넓히지 않는다.**
 *   · `canOpenApprovalBox`  결재함 문. 직급의 결재권 **또는** 결재선에 제 이름.
 *
 * 🔴 문을 넓혀도 **결재 권한은 넓어지지 않는다.** 결재함이 보여 주는 것은
 * 내 단계와 내가 처리한 기록뿐이고(data.ts 의 `myPendingApprovalWhere` ·
 * `decidedBy`), 실제 승인·반려는 `decideStep` 이 단계마다 `isMyStep` 으로
 * 다시 막는다. 문이 열려도 남의 단계는 결재할 수 없다.
 */
export type ApprovalBoxViewer = {
  /** 직급에 결재권이 있는가 (web_ranks.can_approve) */
  rankCanApprove: boolean;
  /** 결재선(web_approval_route_steps)에 제 이름이 살아 있는가 */
  onApprovalRoute: boolean;
};

/** 결재함 문을 열 수 있는가 */
export function canOpenApprovalBox(me: ApprovalBoxViewer): boolean {
  return me.rankCanApprove || me.onApprovalRoute;
}

/**
 * 이 단계는 내 것인가 (SQL 로). 결재함 목록·건수 질의가 함께 쓴다.
 * 🔴 위 `isMyStep` 과 **같은 문장**이어야 한다.
 */
export function myStepCondition(me: Decider): SQL {
  const mine = eq(webApprovalSteps.approverEmployeeId, me.employeeId);
  const legacyByRank = and(
    isNull(webApprovalSteps.approverEmployeeId),
    eq(webApprovalSteps.rankId, me.rankId),
  );
  return (me.isApprover ? or(mine, legacyByRank) : mine)!;
}
