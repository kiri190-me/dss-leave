/**
 * ============================================================================
 * 포털이 물어 올 때의 판단 — 라우트가 아니라 여기에 둔다
 * ============================================================================
 * 통합 알림 종은 **각 시스템이 포털로 밀어 넣는 것이 아니라** 포털이 각
 * 시스템에 물으러 온다(dss-auth/docs/사이트-알림-통로.md). 그리고 아무도
 * 알림을 저장하지 않는다 — 물어볼 때마다 그 자리에서 계산해 답한다. 이 파일은
 * 그 답의 **모양과 판단**을 정한다.
 *
 * 세 가지를 정한다:
 *  1. 토큰이 실어 온 **포털 쪽 사람**을 이 사이트의 결재자로 되짚는 규칙.
 *  2. 되짚지 못했을 때의 답(🔴 오류가 아니라 **빈 목록**).
 *  3. 알림 설정 통로가 내줄 값(이 시스템에는 설정 표가 없다 — 아래 참조).
 *
 * DB 를 여기서 부르지 않고 **인자로 받는다.** 그래서 이 파일의 판단은 DB 없이
 * 그대로 시험할 수 있고(`npm run test:portal`), 라우트에는 「머리말에서 토큰
 * 꺼내 검증하고 이 함수 부르기」만 남는다. rules.ts 가 DB 를 읽지 않는 것과
 * 같은 자리다.
 *
 * 🔴 **결재 판정을 여기서 다시 쓰지 않는다.** 누구에게 알릴지는 결재함 목록과
 * **글자 그대로 같은 조건**이 고른다(data.ts 의 myPendingApprovalWhere →
 * approval-scope.ts 의 myStepCondition). 여기서 한 줄이라도 다시 적으면
 * 「알림은 왔는데 눌러 보니 결재할 수 없다」가 된다.
 * ============================================================================
 */

import { formatRange } from "@/lib/dates";
import { USER_ROLES, type LeaveType, type RequestKind, type UserRole } from "@/lib/db/schema";
import type { Decider } from "./approval-scope";
import { KIND_LABEL, TYPE_SHORT, formatDays } from "./labels";

/* ------------------------------------------------------------------ */
/* 토큰의 sub 로 이 사이트의 사람을 되짚는다                              */
/* ------------------------------------------------------------------ */

/**
 * 되짚어 낸 이 사이트의 사람 — 판정에 필요한 만큼만.
 *
 * `decider` 가 null 인 것은 **계정은 있는데 명단에 연결되지 않은 사람**이다
 * (확인 대기 상태, guards.ts 의 Viewer.employee 와 같은 뜻). 그 사람에게는
 * 결재할 것이 있을 수 없다.
 */
export type PortalActor = {
  role: UserRole;
  /** 결재 판정에 쓸 「나」. 명단에 연결되지 않았거나 퇴사 처리됐으면 null. */
  decider: Decider | null;
};

/**
 * 포털 쪽 sub 로 이 사이트의 계정을 찾는다. 🔴 **못 찾는 것은 정상이다** —
 * 포털은 여러 시스템에 같은 질문을 던지고, 이 시스템에 아직 들어와 본 적이
 * 없는 사람은 흔하다. 그 사람에게 오류를 돌려주면 포털의 종이 그 줄에서
 * 빨갛게 된다(dss-auth 의 gather.ts: 200 이 아니면 「못 물어봤다」로 친다).
 */
export type FindPortalActor = (subject: string) => Promise<PortalActor | null>;

/**
 * 세션에서 얻는 Viewer 를 위 PortalActor 로 옮긴다.
 *
 * 구조만 받는 이유: 이 파일이 guards.ts(→ next/navigation → DB)를 끌어오면
 * 시험이 돌지 않는다. `Viewer` 가 이 모양에 그대로 들어맞으므로 판정은 하나다 —
 * 화면이 쓰는 `isApprover`(직급의 결재권)를 알림도 그대로 쓴다.
 */
export function portalActorOf(viewer: {
  user: { role: UserRole };
  employee: { id: string; rankId: string } | null;
  isApprover: boolean;
}): PortalActor {
  return {
    role: viewer.user.role,
    decider: viewer.employee
      ? {
          employeeId: viewer.employee.id,
          rankId: viewer.employee.rankId,
          isApprover: viewer.isApprover,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* 알림 한 줄                                                           */
/* ------------------------------------------------------------------ */

/**
 * 이 시스템이 내주는 알림 종류. 지금은 하나다.
 *
 * 🔴 사람이 읽는 이름(`kindLabel`)을 **함께** 보낸다. 포털은 각 시스템의 종류
 * 코드표를 갖지 않으므로(설계서 F-4), 코드만 보내면 남의 종에
 * `LEAVE_APPROVAL_PENDING` 이 그대로 찍힌다.
 */
export const LEAVE_APPROVAL_KIND = "LEAVE_APPROVAL_PENDING";
export const LEAVE_APPROVAL_KIND_LABEL = "휴가 결재 대기";
export const LEAVE_APPROVAL_KIND_DESCRIPTION =
  "지금 내 차례인 휴가 결재입니다. 휴가 결재는 결재선을 따라 한 명씩 차례로 가므로, " +
  "앞사람이 처리하기 전까지는 뒷사람에게 뜨지 않습니다. 누구에게 가는지는 신청할 때 " +
  "굳혀 박은 결재선이 정합니다.";

/** 눌렀을 때 갈 곳. 이 시스템에는 결재 건별 화면이 없고 결재함 한 장이다. */
export const APPROVALS_PATH = "/approvals";

/** 밖으로 내보내는 알림 한 줄. 칸 이름은 포털 규격 그대로다(merge.ts). */
export type ExternalNotificationItem = {
  id: string;
  kind: string;
  /** 사람이 읽는 종류 이름. 받는 쪽이 코드표를 갖지 않게 하려고 함께 보낸다. */
  kindLabel: string;
  subject: string;
  detail: string;
  /** 🔴 절대 주소. 다른 사이트에서 눌러도 휴가 시스템으로 온다. */
  href: string;
};

/** 알림 한 줄을 만드는 데 필요한 것. data.ts 의 조회가 이 모양으로 돌려준다. */
export type PendingApprovalRow = {
  /** web_approval_steps.id. 한 신청에 내 열린 단계는 하나뿐이라 줄의 열쇠가 된다. */
  stepId: string;
  applicantName: string;
  kind: RequestKind;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
};

export type PortalNotificationFeed = {
  items: ExternalNotificationItem[];
  /** 🔴 배지에 찍을 숫자. 포털은 이 값을 그대로 쓴다 — 참말을 넣는다. */
  count: number;
};

/** 되짚지 못했거나 결재할 것이 없을 때의 답. 🔴 오류가 아니다. */
const EMPTY_FEED: PortalNotificationFeed = { items: [], count: 0 };

/** 스킴이 붙어 있는가(`http:` 등). 이미 절대 주소면 손대지 않는다. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 경로 하나에 기준 주소를 붙인다.
 *
 * 화면 안의 링크는 상대경로가 맞다 — 주소를 박아 두면 LAN/프록시/NAS 로 옮길
 * 때마다 전부 틀린 값이 된다. 그런데 이 링크는 **포털이나 다른 사이트의 화면에**
 * 그려진다. 거기서 `/approvals` 를 누르면 그 사이트 안의 없는 주소로 간다.
 * 그래서 밖으로 내보내는 길목에서만 자기 주소를 붙인다.
 *
 * 🔴 앞의 슬래시를 **한 칸으로 줄인다.** `//example.com` 은 브라우저가 스킴만
 * 생략한 절대 주소로 읽는다(프로토콜 상대 주소) — 그대로 이어 붙이면 남의
 * 사이트로 가는 링크가 된다.
 *
 * 기준 주소가 비어 있으면 던진다. 조용히 상대경로를 돌려주면 이 함수가 있는
 * 이유가 그대로 사라지고, 증상은 남의 사이트에서만 나타난다.
 *
 * (A/S 시스템 domain/notification-links.ts 의 absoluteNotificationHref 와 같다.)
 */
export function absoluteNotificationHref(href: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base === "") {
    throw new Error("기준 주소가 비어 있습니다. 알림 링크를 절대 주소로 만들 수 없습니다.");
  }
  if (HAS_SCHEME.test(href)) return href;
  const path = href.startsWith("/") ? href.replace(/^\/+/, "/") : `/${href}`;
  return `${base}${path}`;
}

/**
 * 한 줄을 밖으로 내보낼 모양으로.
 *
 * 🔴 **사유(reason)를 싣지 않는다.** 휴가 사유는 본인과 결재권 직급에게만
 * 보이는 값이고(guards.ts 의 canSeeReason), 이 줄은 포털을 거쳐 **다른
 * 시스템의 화면**에 그려지며 포털은 그것을 30초 동안 들고 있다. 결재함 화면에
 * 들어가서 보면 된다.
 *
 * `subject` 는 사람이 알아볼 식별자(신청자 이름), `detail` 은 무슨 일인가.
 */
export function toExternalNotificationItem(
  row: PendingApprovalRow,
  baseUrl: string,
): ExternalNotificationItem {
  return {
    id: `${LEAVE_APPROVAL_KIND}:${row.stepId}`,
    kind: LEAVE_APPROVAL_KIND,
    kindLabel: LEAVE_APPROVAL_KIND_LABEL,
    subject: row.applicantName,
    detail:
      `${KIND_LABEL[row.kind]} · ${TYPE_SHORT[row.leaveType]} ` +
      `${formatRange(row.startDate, row.endDate, true)} (${formatDays(row.days)})`,
    href: absoluteNotificationHref(APPROVALS_PATH, baseUrl),
  };
}

/**
 * 「이 사람이 지금 결재할 차례인 휴가 신청」.
 *
 * 🔴 개수는 **줄 수**다. 한 신청에 내 열린 단계는 하나뿐이므로(결재는 한 명씩
 * 차례로 간다 — 첫 단계만 PENDING, 나머지는 WAITING) 줄 수가 곧 건수다.
 * 결재함 배지(pendingCountFor)와 같은 말을 한다.
 */
export async function buildPortalNotificationFeed(params: {
  subject: string;
  baseUrl: string;
  findActor: FindPortalActor;
  listPendingApprovals: (me: Decider) => Promise<PendingApprovalRow[]>;
}): Promise<PortalNotificationFeed> {
  const actor = await params.findActor(params.subject);
  // 계정이 없거나, 있어도 명단에 연결되지 않은 사람은 결재할 것이 없다.
  if (!actor?.decider) return EMPTY_FEED;

  const items = (await params.listPendingApprovals(actor.decider)).map((row) =>
    toExternalNotificationItem(row, params.baseUrl),
  );
  return { items, count: items.length };
}

/* ------------------------------------------------------------------ */
/* 알림 설정 통로                                                        */
/* ------------------------------------------------------------------ */

/**
 * ── 🔴 이 시스템에는 알림 설정 표가 없다 ─────────────────────────────────
 * A/S 는 종류 8가지 × 역할 5가지를 표 두 개에 저장하고 관리자가 켜고 끈다.
 * 휴가에는 그런 표가 없고, 만들려면 마이그레이션이 필요하다(지금 있는 것은
 * `0000_init.sql`·`0001_…` 둘뿐이다).
 *
 * 만들지 않는 편이 맞다 — 끌 수 있는 것이 없기 때문이다. 이 시스템의 알림은
 * 「지금 네 차례다」 하나뿐이고, 그것은 역할로 정해지지 않는다. 신청할 때 굳혀
 * 박은 결재선이 정하고, 받는 사람은 그 결재를 **해야만 하는** 사람이다. 역할
 * 스위치로 끄면 「결재자인데 알림을 못 받는」 상태가 되는데, 그 상태에서는 휴가
 * 하나가 아무도 모르게 멈춰 선다.
 *
 * 그래서 이 통로는 **고정된 기본값을 내주고, 바꾸기는 거절한다.**
 * 응답의 모양은 A/S 와 글자 하나까지 같다 — 포털이 그 모양을 그대로 그린다
 * (dss-auth 의 notifications/settings.ts 의 parseSettingsPayload).
 */

/** 그 시스템의 역할 한 줄. `editable` 이 false 면 포털 화면이 그 줄을 잠근다. */
export type PortalNotificationRole = {
  code: UserRole;
  label: string;
  editable: boolean;
};

/** 종류 × 역할 한 칸. 기본값을 함께 보내 「기본에서 바뀐 칸」을 그릴 수 있게 한다. */
export type PortalNotificationRoleCell = {
  receives: boolean;
  defaultReceives: boolean;
};

export type PortalNotificationKind = {
  kind: string;
  label: string;
  description: string;
  enabled: boolean;
  defaultEnabled: boolean;
  /** 열쇠는 위 역할의 `code`. */
  roles: Record<string, PortalNotificationRoleCell>;
};

export type PortalNotificationSettings = {
  roles: PortalNotificationRole[];
  kinds: PortalNotificationKind[];
};

/**
 * 역할의 사람이 읽는 이름. 🔴 포털은 이 시스템의 역할 어휘를 모른다 — 코드만
 * 보내면 포털 화면에 `LEAVE_ADMIN` 이 그대로 찍히고, 포털이 번역표를 가지는
 * 순간 역할을 하나 늘릴 때마다 포털을 고쳐 배포해야 한다(설계서 F-4).
 */
export const USER_ROLE_LABELS: Record<UserRole, string> = {
  MEMBER: "직원",
  LEAVE_ADMIN: "휴가 관리자",
};

/**
 * 포털이 그릴 역할 목록. 차례는 언제나 USER_ROLES 그대로다.
 *
 * 🔴 **전부 잠긴다(`editable: false`).** 위 머리말대로 이 시스템에는 끌 수 있는
 * 것이 없다. 포털 관리자 화면은 잠긴 역할을 아예 폼에 싣지 않으므로, 이 값이
 * 곧 「여기는 건드릴 것이 없다」는 표시가 된다.
 */
export function portalNotificationRoles(): PortalNotificationRole[] {
  return USER_ROLES.map((code) => ({
    code,
    label: USER_ROLE_LABELS[code],
    editable: false,
  }));
}

/**
 * 포털에 내줄 설정 전부. 저장된 값이 없으므로 언제나 같은 답이다.
 *
 * 두 역할 모두 `receives: true` 인 것은 **참말이다** — 이 알림은 역할이 아니라
 * 결재선이 고르므로, 직원이든 휴가 관리자든 자기 차례가 되면 받는다.
 */
export function portalNotificationSettings(): PortalNotificationSettings {
  const roles = portalNotificationRoles();
  return {
    roles,
    kinds: [
      {
        kind: LEAVE_APPROVAL_KIND,
        label: LEAVE_APPROVAL_KIND_LABEL,
        description: LEAVE_APPROVAL_KIND_DESCRIPTION,
        enabled: true,
        defaultEnabled: true,
        roles: Object.fromEntries(
          roles.map((role) => [role.code, { receives: true, defaultReceives: true }]),
        ),
      },
    ],
  };
}

export type PortalSettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 403; message: string };

/**
 * 설정을 **읽는** 것도 이 시스템에 쓸 수 있는 계정이 있어야 한다.
 *
 * A/S 는 여기서 한 걸음 더 나아가 「관리자 이상만」을 요구한다 — 저쪽은 어느
 * 역할이 무엇을 받는지가 그 자체로 조직 구성 정보이기 때문이다. 이쪽 답은
 * 사람과 무관한 고정값 한 줄이라 그 걱정이 없고, 대신 이 시스템을 아예 쓰지
 * 않는 사람에게까지 내주지는 않는다.
 */
export async function readPortalNotificationSettings(params: {
  subject: string;
  findActor: FindPortalActor;
}): Promise<PortalSettingsResult<PortalNotificationSettings>> {
  const actor = await params.findActor(params.subject);
  if (!actor) {
    return { ok: false, status: 403, message: "이 시스템에 쓸 수 있는 계정이 없습니다." };
  }
  return { ok: true, value: portalNotificationSettings() };
}

/**
 * 🔴 저장은 **언제나 거절한다.** 누가 물어도 같은 답이다 — 바꿀 수 있는 값이
 * 아예 없기 때문이지 그 사람의 권한이 모자라서가 아니다.
 *
 * 통로 자체는 열어 둔다: 포털은 설정 통로가 404 면 그 시스템을 「지금 볼 수
 * 없다」로 그리는데(gather.ts), 그것은 고장과 구별되지 않는다. 403 과 이 한
 * 줄이면 포털 화면에 까닭이 그대로 뜬다.
 */
export const SETTINGS_READ_ONLY_MESSAGE =
  "휴가 결재 알림은 끄거나 대상을 바꿀 수 없습니다. 결재선에서 자기 차례가 된 사람에게만 가고, " +
  "끄면 휴가 하나가 아무도 모르게 멈춰 섭니다.";
