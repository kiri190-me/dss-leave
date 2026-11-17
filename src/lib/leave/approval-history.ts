/**
 * ============================================================================
 * 결재 **내역** — 「내가 한 결재」와 「내 자리에서 일어난 결재」를 가른다
 * ============================================================================
 * 사용자 요청(2026-11-17): 「내가 했던 결재나 **나를 대신해서** 어떤 결재를 했는지도
 * 특정 날짜 혹은 기간을 선택해서 확인」. 설계 C-4(dss-approvals/DELEGATION_DESIGN.md).
 *
 * 🔵 **화면은 이 집에 안 만든다** — 통합 승인함 한 곳에 둔다(2026-11-17 사용자).
 * 이 파일이 갖는 것은 그 화면이 쓸 **가르기**뿐이고, DB 도 망도 모른다. 그래서
 * `npm run test:approval-history` 가 값으로 그대로 돌려 본다(portal-notifications.ts
 * 가 같은 까닭으로 같은 모양이다).
 *
 * ── 🔴 이 집에는 「대신 눌렀다」를 적는 칸이 없다 ──────────────────────────
 * 2026-11-17 에 세 집을 재 보니 「대신 눌렀다」를 적는 모양이 셋 다 달랐다
 * (설계 C-4 보충). A/S 에는 `delegated_from_user_id` 전용 칸이 있어 결재할 때
 * **미리 계산해 적어 두지만**, 이 집과 재고관리에는 그 칸이 없다. 대신 **한 줄
 * 안의 두 칸을 견준다**:
 *
 *     approver_employee_id     그 단계의 **주인**. 신청하는 순간 굳혀 박는다
 *     decided_by_employee_id   **실제로 누른 사람**
 *
 * 🔵 **뜻은 세 집이 같다** — 주인과 누른 사람이 다르면 대신 누른 것이다. A/S 만
 * 그것을 미리 칸에 적어 둘 뿐이다.
 *
 * 🔴 **「누가 눌렀나」가 이 집에서는 두 칸**(`decided_by_employee_id` ·
 * `decided_by_user_id`)인데, 가르기가 보는 것은 **명단 번호 쪽 하나뿐**이다.
 * 로그인 계정과 직원 명단이 다른 표라 `decideStep` 이 둘을 함께 적는데, 결재
 * 권한의 열쇠는 `web_employees.id` 이기 때문이다(approval-scope.ts).
 *
 * 🔴 **「어느 위임으로 누른 것인지」는 가르지 않는다**(설계 B-16, 사용자가 「구별
 * 없이 간단히」를 골랐다). 출처 칸을 안 만들었으므로 여기서 알아낼 길도 없다.
 * ============================================================================
 */
import { APPROVALS_PATH, absoluteNotificationHref } from "./portal-notifications";

/**
 * 한 줄이 나에게 무엇이었나. 🔴 **셋이 갈려야 한다** — 사용자가 물은 것이
 * 「내가 했던 결재」와 「나를 대신해서 한 결재」 **둘**이고, 그 둘을 한 조회로
 * 가로지르면 **셋째**가 저절로 딸려 온다(내 자리를 남이 누른 줄). 셋째를
 * 지우지 않고 그대로 보여 주는 것은, 결재권을 맡긴 사람이 「내가 없는 동안
 * 무슨 일이 있었나」를 보는 자리가 이것뿐이어서다.
 */
export const APPROVAL_HISTORY_ROLES = ["SELF", "ON_BEHALF", "BY_OTHER"] as const;
export type ApprovalHistoryRole = (typeof APPROVAL_HISTORY_ROLES)[number];

/**
 * 사람이 읽는 이름. 🔴 **함께 내보낸다** — 이 줄은 포털을 거쳐 **다른 시스템의
 * 화면**(통합 승인함)에 그려지는데, 포털은 이 시스템의 코드표를 갖지 않는다
 * (알림·승인함 통로와 같은 규칙, 설계 F-4).
 */
export const APPROVAL_HISTORY_ROLE_LABEL: Record<ApprovalHistoryRole, string> = {
  SELF: "직접 결재",
  ON_BEHALF: "내가 대신 결재",
  BY_OTHER: "내 자리를 남이 결재",
};

/** 가르는 데 필요한 두 칸. 🔴 다른 칸은 보지 않는다. */
export type StepDecisionOwners = {
  /** 그 단계의 주인. 🔴 2026-09-21 전에 만들어진 옛 단계만 null 이다 */
  approverEmployeeId: string | null;
  /** 실제로 누른 사람의 **명단 번호**. 계정 번호가 아니다 */
  decidedByEmployeeId: string | null;
};

/**
 * 이 줄은 나에게 무엇인가.
 *
 * 🔴 **그 사람이 걸린 줄에만 쓴다.** 고르는 일은 조회가 한다(data.ts 의
 * `approvalHistoryQuery` — `decided_by = 나 OR approver = 나`). 아무 줄이나
 * 넣으면 둘 중 어느 쪽도 내가 아닌 줄이 「내 자리를 남이」로 나온다 — 가르개와
 * 조회는 **짝으로만** 쓰라는 뜻이다.
 *
 * 🔴 **옛 직급 단계(주인 칸이 빈 행)는 「직접」이다.** 그때는 결재자를 직급으로
 * 판정했고(approval-scope.ts 의 둘째 갈래) 결재권 위임이라는 것이 아예 없었다.
 * 주인 칸이 비었다는 이유로 「대신 결재」로 적으면, 2026-09-21 이전 결재가 전부
 * 있지도 않았던 위임으로 둔갑한다. 🔵 두 DB 모두 그때 0행이 되어 지금 걸릴 줄은
 * 없지만, 판정은 **옛 행이 돌아와도 맞는 쪽**으로 둔다.
 */
export function approvalHistoryRole(
  step: StepDecisionOwners,
  meEmployeeId: string,
): ApprovalHistoryRole {
  const pressedByMe = step.decidedByEmployeeId === meEmployeeId;
  if (!pressedByMe) return "BY_OTHER";
  // 내가 눌렀다 — 내 자리였나, 남의 자리였나.
  if (step.approverEmployeeId === null) return "SELF";
  return step.approverEmployeeId === meEmployeeId ? "SELF" : "ON_BEHALF";
}

/**
 * 그 결재로 건너갈 주소. 🔴 **이미 있는 통로와 같은 모양**이다 —
 * `/approvals#approval-{stepId}`(leave/portal-approvals.ts 의 href 절이 그
 * 모양을 정한 자리이고, 결재함의 각 줄에 그 id 가 실제로 붙어 있다).
 *
 * 🔴 **끝난 결재는 그 줄이 거기 없다.** 결재함(`/approvals`)에 나열되는 것은
 * **지금 내 차례인** 신청뿐이라, 내역에서 누르면 결재함이 열리고 조각(#)은
 * 가리킬 데가 없어 맨 위에 선다. 그래도 주소를 싣는 것은 통합 승인함의 줄마다
 * 건너갈 곳이 하나는 있어야 하고 이 집에서 가장 가까운 자리가 그 화면이기
 * 때문이다. 🔵 결재 건별 화면을 새로 만드는 일은 이 조각의 범위가 아니다.
 *
 * 🔵 **기준 주소를 인자로 받는다** — 들어온 Host 머리말을 읽지 않는다. 그 값은
 * 라우트가 설정(`env.appBaseUrl`)에서 꺼내 넘긴다(portal-approvals.ts 와 같은
 * 규칙). 다음 조각의 통로가 그 자리를 잇는다.
 */
export function approvalHistoryHref(stepId: string, baseUrl: string): string {
  return absoluteNotificationHref(`${APPROVALS_PATH}#approval-${stepId}`, baseUrl);
}
