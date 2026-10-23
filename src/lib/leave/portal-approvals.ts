/**
 * ============================================================================
 * 통합 승인함(`dss-approvals`)이 물어 올 때의 판단 — 라우트가 아니라 여기에 둔다
 * ============================================================================
 * 통합 승인함은 사내 시스템마다 「내가 결재할 건」을 **건별로** 물어 한 창에
 * 모은다. [승인하기] 는 그 신청의 화면으로 건너가기만 하고 승인·반려는 거기서
 * 한다(2026-10-23 사용자 결정) — 그래서 이 통로는 **읽기 전용**이고, 이 파일에도
 * 쓰는 함수가 하나도 없다.
 *
 * ── 🔴 왜 통합 알림 통로(portal-notifications.ts)로 안 되는가 ──────────────
 * 그 통로는 **종**을 위한 것이라 링크가 전부 `/approvals`(목록)로만 간다 — 종을
 * 누르면 결재함이 열리는 것으로 충분했기 때문이다. 승인함은 **한 줄 = 한 결재 =
 * 한 [승인하기]** 여야 해서 그 신청 하나로 바로 가는 주소가 있어야 한다. 그래서
 * 알림 통로를 넓히지 않고 전용 통로를 따로 낸다. 응답 모양은 A/S(`dss-rf`)가
 * 먼저 정한 세 시스템 공통 계약을 그대로 따른다 — 칸 이름을 바꾸면 세 시스템을
 * 함께 고쳐야 한다.
 *
 * ── href: 그 신청 하나로 가는 주소 ────────────────────────────────────────
 * 이 시스템에는 결재 건별 화면이 없다(`leave/[id]` 에는 `change` 만 있고 그
 * 자체의 상세 화면이 없다, 결재함은 `/approvals` 한 장에 **모든** 대기 신청을
 * 나열한다). 새 화면을 만들지 않고, 결재함의 각 줄에 `id="approval-{stepId}"`
 * 를 **더해**(app/(internal)/approvals/page.tsx) URL 조각(`#approval-{stepId}`)
 * 으로 그 줄까지 바로 스크롤되게 한다 — 브라우저가 로드 뒤 그 id 로 알아서
 * 넘어가므로 화면 쪽에 새 로직이 필요 없다. 지금 가능한 것 중 가장 좁은 주소다.
 *
 * ── 자격 판정을 새로 짓지 않는다 ────────────────────────────────────────────
 * 「이 사람이 지금 이 신청을 결재할 차례인가」는 **한 줄도 여기 적지 않는다.**
 * data.ts 의 `pendingApprovalsForPortal` 을 인자로 받아 그대로 부른다 — 그
 * 조회는 결재함(`pendingForApprover`)·건수(`pendingCountFor`)·알림
 * (`pendingApprovalNotifications`)과 **같은 조건**(`myPendingApprovalWhere`)을
 * 쓴다. 판정이 두 벌이 되면 한쪽만 고쳐지는 날이 오고, 그것은 권한 구멍이다.
 *
 * ── 🔴 계정은 있는데 명단에 연결되지 않은 사람 ──────────────────────────────
 * 휴가는 포털 번호(`sub`)만으로 결재자를 못 찾는다 — `web_users.auth_sub` →
 * `web_users.employee_id` → `web_employees.id` 두 단계를 거친다(findPortalActor).
 * 관리자가 「계정↔직원」을 잇지 않은 사람은 `actor.decider` 가 `null` 이고,
 * 그 사람에게 **빈 목록**을 그냥 주면 통합함에서는 「결재할 게 없다」와
 * 구별되지 않는다 — 오류가 안 나서 「API 가 고장났나」로 영영 헤맨다. 그래서
 * 이 사정만 `unavailable: "employee_not_linked"` 로 구별해 낸다.
 *
 * 🔴 이 칸은 **선택**이다 — 세 시스템 중 이 시스템에만 있는 사정이고, 재고·A/S
 * 는 이런 중간 단계가 없어 이 칸을 보낼 일이 없다(둘이 안 보내도 괜찮다).
 * 계정 자체가 없는 사람(이 시스템을 아직 한 번도 안 쓴 사람)은 이 칸을 넣지
 * 않는다 — 그것은 포털이 여러 시스템에 같은 질문을 던질 때 흔히 있는 **정상
 * 상태**이고(portal-notifications.ts 의 FindPortalActor 주석), 명단 미연결과
 * 뜻이 다르다.
 * ============================================================================
 */
import { formatRange } from "@/lib/dates";
import { KIND_LABEL, TYPE_SHORT, formatDays } from "./labels";
import { absoluteNotificationHref, APPROVALS_PATH, type FindPortalActor } from "./portal-notifications";
import type { Decider } from "./approval-scope";
import type { PendingApprovalForPortal } from "./data";

/**
 * 이 시스템이 내주는 결재 갈래. 지금은 하나뿐이다.
 *
 * 🔴 사람이 읽는 이름(`kindLabel`)을 함께 보낸다 — 승인함은 여러 시스템의 줄이
 * 한 화면에 섞여 서고, 포털은 이 시스템의 코드표를 갖지 않는다(알림 통로와
 * 같은 규칙, 설계서 F-4).
 */
export const LEAVE_REQUEST_APPROVAL_KIND = "LEAVE_REQUEST";
export const LEAVE_REQUEST_APPROVAL_KIND_LABEL = "휴가 신청 결재";

/** 승인함에 서는 한 줄. 🔴 이 모양이 세 시스템의 계약이다 — 칸 이름을 바꾸지 않는다. */
export type PortalApprovalItem = {
  /** 이 시스템 안에서 이 결재 단계를 가리키는 값. 다시 물어도 같다(단계 id 는 불변). */
  id: string;
  /** 기계가 읽는 갈래. */
  kind: string;
  /** 사람이 읽는 갈래 이름. */
  kindLabel: string;
  /** 한 줄 제목 — 누구의 무슨 휴가인가. */
  subject: string;
  /** 한 줄 보탬 — 기간·일수. */
  detail: string;
  /** ISO 8601. 이 신청이 지금 결재를 기다리기 시작한 때. */
  requestedAt: string;
  /** 🔴 절대 주소 — 그 신청이 선 결재함 줄로 바로 스크롤된다. */
  href: string;
};

export type PortalApprovalInbox = {
  items: PortalApprovalItem[];
  /** 배지에 찍을 숫자. 🔴 알림과 같은 말 — 한 신청에 내 열린 단계는 하나뿐이라 줄 수가 곧 건수다. */
  count: number;
  /**
   * 계정은 있는데 명단에 연결되지 않아 못 읽었을 때만 들어간다. 위 머리말 참조.
   * 🔴 다른 두 시스템은 이 칸을 보내지 않아도 되는 **선택 칸**이다.
   */
  unavailable?: "employee_not_linked";
};

/** 계정 자체가 없을 때의 답. 🔴 오류가 아니다 — 포털은 여러 시스템에 같은 질문을 던진다. */
const EMPTY_INBOX: PortalApprovalInbox = { items: [], count: 0 };

/**
 * 한 줄을 밖으로 내보낼 모양으로.
 *
 * 🔴 사유(reason)를 싣지 않는다 — 이 줄은 포털을 거쳐 **다른 시스템의 화면**에
 * 그려진다(portal-notifications.ts 의 toExternalNotificationItem과 같은 규칙).
 * `subject` 에 「누구의 무슨 휴가인가」를, `detail` 에 기간·일수를 담아 나눈다.
 */
export function toPortalApprovalItem(
  row: PendingApprovalForPortal,
  baseUrl: string,
): PortalApprovalItem {
  return {
    id: `${LEAVE_REQUEST_APPROVAL_KIND}:${row.stepId}`,
    kind: LEAVE_REQUEST_APPROVAL_KIND,
    kindLabel: LEAVE_REQUEST_APPROVAL_KIND_LABEL,
    subject: `${row.applicantName} · ${TYPE_SHORT[row.leaveType]} ${KIND_LABEL[row.kind]}`,
    detail: `${formatRange(row.startDate, row.endDate, true)} (${formatDays(row.days)})`,
    requestedAt: row.requestedAt.toISOString(),
    // 결재함(/approvals)은 대기 중인 신청을 한 장에 나열한다 — 그 줄까지 바로
    // 스크롤되도록 단계 id 로 조각(#)을 붙인다(위 머리말의 href 절 참조).
    href: absoluteNotificationHref(`${APPROVALS_PATH}#approval-${row.stepId}`, baseUrl),
  };
}

/**
 * 「이 사람이 지금 결재해야 할 휴가 신청」 전부.
 *
 * 🔴 대상 사람은 **`subject` 하나로만** 정해진다 — 토큰이 실어 온 값이고,
 * 라우트는 쿼리 문자열을 읽지 않는다.
 */
export async function buildPortalApprovalInbox(params: {
  subject: string;
  baseUrl: string;
  findActor: FindPortalActor;
  listPendingApprovals: (me: Decider) => Promise<PendingApprovalForPortal[]>;
}): Promise<PortalApprovalInbox> {
  const actor = await params.findActor(params.subject);
  // 이 시스템에 계정이 없다 — 흔한 정상 상태다(findPortalActor 주석).
  if (!actor) return EMPTY_INBOX;
  // 계정은 있는데 명단에 연결되지 않았다 — 위 머리말의 그 사정. 빈 목록과
  // 구별해서 내보낸다.
  if (!actor.decider) return { items: [], count: 0, unavailable: "employee_not_linked" };

  const items = (await params.listPendingApprovals(actor.decider)).map((row) =>
    toPortalApprovalItem(row, params.baseUrl),
  );
  return { items, count: items.length };
}
