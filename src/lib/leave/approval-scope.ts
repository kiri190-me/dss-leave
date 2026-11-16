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
 * 「내 것인가」가 **한 명**에서 **목록**으로 넓어졌다. 통합 승인함에서 맡긴
 * 결재권 위임을 받은 사람은 맡긴 사람의 단계도 누를 수 있다(설계 B-9).
 * 🔴 **넓히는 자리는 아래 `approvableEmployeeIds` 한 곳**이고 값 판정과 SQL 이
 * 그 **한 함수**를 함께 부른다 — 둘이 같은 말을 한다는 것을 글자로 못 박으려는
 * 것이다.
 *
 * 🔵 **목록이 어디서 오는지는 이 파일이 모른다** — 그래서 2026-11-16 저녁에
 * 자료 출처가 망에서 제 표로 바뀌었을 때(설계 B-12) 이 파일은 한 줄도 안
 * 바뀌었다. 지금 그 목록을 만드는 곳은 auth/portal-delegations.ts 의
 * `loadActingForEmployeeIds` 이고, 읽는 표는 `web_portal_approval_delegations`
 * 다. 🔴 **망 호출은 더 이상 어디에도 없다.**
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
   * (`web_employees.id`). 포털이 써 준 결재권 위임을 **이 집 표에서** 읽은
   * 결과다(auth/portal-delegations.ts 의 `loadActingForEmployeeIds`).
   *
   * 🔵 **없는 것(undefined)은 「위임 없음」이다** — 2026-11-16 저녁까지는 그
   * 자리에 「못 물었다」라는 셋째 상태가 있었는데, 묻는 길을 걷어내면서
   * 없어졌다(설계 B-12). 비워 두고 부르는 곳은 **결재 판정을 DB 없이 돌려 보는
   * 시험·스크립트**뿐이고, 화면이 지나는 길은 전부 값을 싣는다
   * (data.ts 의 `deciderOf` 한 곳이 그것을 싣는다).
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
 *  · **본인이 언제나 맨 앞**이다. 위임이 하나도 없어도 본인 단계는 그대로
 *    눌린다 — 이 함수가 그것을 **값의 모양으로** 보장한다.
 *  · **중복을 걷는다.** 같은 사람에게 기간이 겹치는 위임이 둘 걸려 있을 수
 *    있고, 본인이 섞여 들어올 수도 있다.
 *  · 🔴 **이어 붙이지 않는다.** A→B, B→C 라도 C 는 A 를 못 얻는다 — 읽는 질의가
 *    `delegate_employee_id = 나` 한 줄만 보고 재귀하지 않기 때문이다
 *    (auth/portal-delegations.ts). 여기서 한 번 더 이어 붙이면 아무도 지정하지
 *    않은 결재권이 생긴다.
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
 *   · `canOpenApprovalBox`  결재함 문. 직급의 결재권 **또는** 결재선에 제 이름
 *                           **또는** 지금 유효한 결재권 위임(2026-11-16).
 *
 * 🔴 문을 넓혀도 **결재 권한은 넓어지지 않는다.** 결재함이 보여 주는 것은
 * 내 단계와 내가 처리한 기록뿐이고(data.ts 의 `myPendingApprovalWhere` ·
 * `decidedBy`), 실제 승인·반려는 `decideStep` 이 단계마다 `isMyStep` 으로
 * 다시 막는다. 문이 열려도 남의 단계는 결재할 수 없다.
 *
 * ── 🔴 셋째 갈래가 생겼다 — 위임만 받은 사람 (2026-11-16) ───────────────
 * 조각 5 에서 드러난 결함이다: 위임만 받은 사람(직급에 결재권이 없고 결재선에도
 * 이름이 없는 사원·대리)은 **대신 누를 결재가 생겨도 머리말에 「결재함」 메뉴가
 * 아예 그려지지 않았다.** 배지도 0 이고 알림 종에도 안 떴다 — 주소를 손으로 쳐야
 * 보였다. 묻던 시절에는 그 판정에 포털 왕복이 하나씩 붙어 머리말·종에 달 수
 * 없었는데, 제 표를 읽게 되면서 **공짜가 됐다**(설계 B-12).
 *
 * 🔴 **이것은 권한을 넓히는 일이다.** 그래서 **닫히는 길**을 함께 봐야 한다 —
 * 여는 조건이 「지금 유효한 위임이 있나」이고 그 「지금」을 매 요청마다 다시
 * 재므로(auth/portal-delegations.ts 의 `liveDelegationWhere`), **기간이 끝나면
 * 다음 화면부터 메뉴가 저절로 사라진다.** 어딘가에 「열어 둠」을 적어 두는 칸이
 * 없다는 것이 그 보장이다.
 */
export type ApprovalBoxViewer = {
  /** 직급에 결재권이 있는가 (web_ranks.can_approve) */
  rankCanApprove: boolean;
  /** 결재선(web_approval_route_steps)에 제 이름이 살아 있는가 */
  onApprovalRoute: boolean;
  /**
   * 🔴 **지금 유효한 결재권 위임으로 대신할 수 있는 사람들**. 위 `Decider` 의
   * 같은 이름 칸과 **같은 값**이다 — `getViewer` 가 한 번 읽어 둘에 넘긴다.
   *
   * 🔴 **생략하면 「위임 없음」으로 본다.** 그러면 위임만 받은 사람에게 문이
   * 닫히고, 그 사람은 **오류 하나 없이** 결재함을 못 찾는다. 지금 생략하는 곳은
   * 결재 흐름을 흉내 내는 **스크립트 둘**(scripts/test-workflow.ts ·
   * scripts/seed-dummy-approval.ts)뿐이고, 화면이 지나는 길은
   * auth/guards.ts 의 `getViewer` **한 곳**이다 — 거기서 빠뜨리면
   * scripts/test-approval-delegation.ts 가 잡는다.
   */
  actingForEmployeeIds?: readonly string[];
};

/** 결재함 문을 열 수 있는가 */
export function canOpenApprovalBox(me: ApprovalBoxViewer): boolean {
  return (
    me.rankCanApprove || me.onApprovalRoute || (me.actingForEmployeeIds?.length ?? 0) > 0
  );
}

/**
 * 이 단계는 내 것인가 (SQL 로). 결재함 목록·건수 질의가 함께 쓴다.
 * 🔴 위 `isMyStep` 과 **같은 문장**이어야 한다.
 *
 * 🔴 사람 갈래가 `=` 가 아니라 `in` 인 까닭은 결재권 위임이다 — 목록을 만드는
 * 자리가 값 판정과 **같은 함수**(`approvableEmployeeIds`)라 둘이 어긋날 수
 * 없다. 위임이 없으면 목록은 본인 하나뿐이고 `in ($1)` 은 `= $1` 과 같은 말이다.
 *
 * ── 🔴 왜 **하위 질의로 풀지 않았나** (2026-11-16) ───────────────────────
 * 위임이 이제 **같은 DB 의 표**(`web_portal_approval_delegations`)에 있으므로
 * 여기서 `in (select … )` 로 바로 풀 수도 있다. 그렇게 하지 않은 까닭은 이 파일
 * 머리말의 **그 규칙 하나** 때문이다: 짝인 `isMyStep` 은 **값으로 답하는 순수
 * 함수**라 하위 질의를 돌릴 수가 없다. SQL 쪽만 하위 질의로 바꾸면 두 판정이
 * **서로 다른 문장**이 되고, 그 순간 「결재함에는 보이는데 누르면 거절」(또는 그
 * 반대)이 되돌아온다 — 그것을 막으려고 이 파일이 있다. 목록을 **값으로 먼저
 * 읽어 들고 들어오면** 둘이 같은 함수를 부르는 구조가 그대로 남는다.
 * 🔵 왕복이 하나 는 것은 사실이지만 색인 하나짜리 조회이고
 * (`web_portal_approval_delegations_delegate_idx`), 무엇보다 그 조회는 **화면이
 * 사람을 읽을 때 한 번**만 돈다(auth/guards.ts 의 `loadEmployee`).
 */
export function myStepCondition(me: Decider): SQL {
  const mine = inArray(webApprovalSteps.approverEmployeeId, approvableEmployeeIds(me));
  const legacyByRank = and(
    isNull(webApprovalSteps.approverEmployeeId),
    eq(webApprovalSteps.rankId, me.rankId),
  );
  return (me.isApprover ? or(mine, legacyByRank) : mine)!;
}
