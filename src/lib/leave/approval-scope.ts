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
 *
 * ── 🔴 결재권 위임이 들어왔다 (2026-11-16) ──────────────────────────
 * 「내 것인가」가 **한 명**에서 **목록**으로 넓어졌다. 포털에 맡긴 결재권
 * 위임을 받은 사람은 맡긴 사람의 단계도 누를 수 있다(설계 B-9,
 * leave/approval-delegation.ts). 🔴 **넓히는 자리는 아래
 * `approvableEmployeeIds` 한 곳**이고 값 판정과 SQL 이 그 **한 함수**를
 * 함께 부른다 — 둘이 같은 말을 한다는 것을 글자로 못 박으려는 것이다.
 */
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";

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
  /**
   * 🔴 **지금 내가 대신 결재할 수 있는 사람들**의 명단 번호
   * (`web_employees.id`). 포털에 맡긴 결재권 위임을 읽은 결과다
   * (leave/approval-delegation.ts).
   *
   * 🔴 **없는 것(undefined)은 「위임이 없다」가 아니라 「안 물었다」**이고, 둘은
   * 여기서 같은 결과가 된다 — 못 물었을 때 위임 없이 진행하기로 한 결정
   * (설계 B-6) 그대로다. 안 물은 까닭과 물은 자리는 그 파일의
   * `NO_PORTAL_DELEGATIONS` 주석에 모아 두었다.
   *
   * 🔴 **본인은 여기 넣지 않아도 된다** — 아래 `approvableEmployeeIds` 가 늘
   * 맨 앞에 둔다. 섞여 들어와도 중복은 걷힌다.
   */
  actingForEmployeeIds?: readonly string[];
};

/**
 * 🔴 **이 사람이 결재할 수 있는 「주인」 번호들** — 값 판정과 SQL 이 **둘 다**
 * 이 함수를 부른다. 두 곳에 같은 문장을 두 번 적지 않으려는 자리다.
 *
 *  · **본인이 언제나 맨 앞**이다. 위임을 못 물었든 포털이 죽었든 본인 단계는
 *    그대로 눌린다(설계 B-6 의 근거).
 *  · **중복을 걷는다** — 포털은 답의 맨 앞에 부른 사람 자신을 넣어 준다.
 *  · 🔴 **이어 붙이지 않는다.** A→B, B→C 라도 C 는 A 를 못 얻는다 — 그 판정은
 *    포털이 이미 했고, 여기 들어오는 목록이 그 답 그대로다.
 */
export function approvableEmployeeIds(me: Decider): string[] {
  return Array.from(new Set([me.employeeId, ...(me.actingForEmployeeIds ?? [])]));
}

/**
 * 이 단계는 내 것인가 (값으로).
 *
 * 🔴 위임은 **사람으로 박힌 단계만** 넓힌다. 사람 칸이 빈 옛 단계는 예전대로
 * 내 **직급**으로만 판정한다 — 포털이 주는 것은 사람뿐이라 맡긴 사람의 직급을
 * 알 수 없고, 직급까지 빌려 오면 「그 직급에 걸린 **남의** 옛 단계」가 통째로
 * 열린다(2026-09-22 에 `isApprover` 의 뜻을 넓히지 않기로 한 것과 같은 까닭,
 * 아래 `canOpenApprovalBox` 머리말). 🔵 옛 단계는 2026-09-21 전환 전에 만들어진
 * 행뿐이고 두 DB 모두 그때 0행이 됐다 — 넓혀서 얻을 것이 애초에 없다.
 */
export function isMyStep(step: StepOwner, me: Decider): boolean {
  if (step.approverEmployeeId !== null) {
    return approvableEmployeeIds(me).includes(step.approverEmployeeId);
  }
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
 *
 * 🔴 사람 갈래가 `=` 가 아니라 `in` 인 까닭은 결재권 위임이다 — 목록을 만드는
 * 자리가 값 판정과 **같은 함수**(`approvableEmployeeIds`)라 둘이 어긋날 수
 * 없다. 위임이 없으면 목록은 본인 하나뿐이고 `in ($1)` 은 `= $1` 과 같은 말이다.
 * 🔴 **망 호출이 여기 들어오지 않는다** — 목록은 이미 값으로 들고 들어온다
 * (설계 C-3: 거래를 열기 전에 묻는다).
 */
export function myStepCondition(me: Decider): SQL {
  const mine = inArray(webApprovalSteps.approverEmployeeId, approvableEmployeeIds(me));
  const legacyByRank = and(
    isNull(webApprovalSteps.approverEmployeeId),
    eq(webApprovalSteps.rankId, me.rankId),
  );
  return (me.isApprover ? or(mine, legacyByRank) : mine)!;
}
