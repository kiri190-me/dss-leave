/**
 * ============================================================================
 * 결재 **내역**을 밖으로 내줄 때의 판단 — 라우트가 아니라 여기에 둔다
 * ============================================================================
 * 조각 10a 가 만든 가르기(approval-history.ts)와 조회(data.ts 의
 * `approvalHistoryFor`)를 **통합 승인함이 쓸 모양**으로 옮긴다. 이웃한 통로들
 * (portal-notifications.ts · portal-approvals.ts)과 같은 자리이고 같은 규칙이다:
 * DB 를 여기서 부르지 않고 **인자로 받으므로** 자료 없이 그대로 돌려 볼 수 있고
 * (`npm run test:approval-history-api`), 라우트에는 「머리말에서 토큰 꺼내
 * 검증하고 이 함수 부르기」만 남는다.
 *
 * ── 🔴 세 집(A/S · 재고관리 · 휴가)이 **글자 그대로 같은 계약**이다 ────────
 *     GET /api/integration/approval-history?from=<ISO8601>&to=<ISO8601>
 *     Authorization: Bearer <포털 서비스 토큰>
 *     → { "entries": [ { id, subject, approvalName, decidedAt, decision,
 *                        relation, counterpartName, href } ] }
 * 포털이 셋을 모아 **한 화면**에 그린다. 칸 이름이나 `relation` 의 글자를
 * 한 자라도 바꾸면 **그 집 줄만 조용히 안 그려진다** — 오류가 아니라 빈 화면으로
 * 나타나므로 아무도 신고하지 않는다. 바꾸려면 네 곳(포털 + 셋)을 함께 고친다.
 *
 * ── 🔴 열쇠가 **두 단**을 건넌다 ──────────────────────────────────────────
 * 토큰이 실어 오는 것은 포털 쪽 `sub` 이고, 조회가 받는 것은 이 집의
 * **명단 번호**(`web_employees.id`)다. `auth_sub` → `web_users.id` →
 * `employee_id` 로 두 번 건너야 하는데, 그 길은 이미 `findPortalActor` 한 곳에
 * 있다(알림·승인함이 쓰는 그것). 🔴 **중간에 끊기면 오류가 아니라 빈 목록**이다 —
 * 포털은 세 집에 같은 질문을 던져 한 화면에 모으므로, 한 집이 500 을 뱉으면
 * 나머지 둘까지 못 그릴 수 있다(dss-auth 의 gather.ts 는 200 이 아니면 그 줄을
 * 「못 물어봤다」로 친다). 끊기는 자리는 둘이고 **둘 다 흔한 정상 상태**다:
 *  · 이 시스템에 계정이 아직 없는 사람(포털은 모든 시스템에 같은 질문을 던진다)
 *  · 계정은 있는데 휴가 관리자가 명단에 안 이어 준 사람(확인 대기)
 * 🔵 승인함 통로는 뒤쪽 사정만 `unavailable` 로 갈라 냈는데(portal-approvals.ts),
 *    여기서는 **갈라 내지 않는다** — 계약에 그 칸이 없고, 「이 기간에 결재한 것이
 *    없다」가 결재 내역에서는 드문 일이 아니라 기본값에 가깝기 때문이다.
 *
 * ── 🔴 `SKIPPED` 는 애초에 안 올라온다 ───────────────────────────────────
 * 거르는 자리는 **조회의 WHERE**이지 여기가 아니다(data.ts 의
 * `approvalHistoryWhere` — `status in ('APPROVED','REJECTED')`). 그 조건을 풀면
 * 건너뛴 단계가 전부 **「내 자리를 남이 눌렀다」로 오판된다**(건너뛰기는 누른
 * 사람의 명단 번호를 안 적는다). 여기서 한 번 더 거르지 않는 것은, 거르는 곳이
 * 둘이 되면 한쪽만 고치는 날이 오기 때문이다.
 * ============================================================================
 */
import { formatRange } from "@/lib/dates";
import type { ApprovalHistoryRole } from "./approval-history";
import { approvalHistoryHref } from "./approval-history";
import type { ApprovalHistoryRange, ApprovalHistoryRow } from "./data";
import { KIND_LABEL, TYPE_SHORT, formatDays } from "./labels";
import type { FindPortalActor } from "./portal-notifications";
import {
  LEAVE_REQUEST_APPROVAL_KIND,
  LEAVE_REQUEST_APPROVAL_KIND_LABEL,
} from "./portal-approvals";

/* ------------------------------------------------------------------ */
/* 기간 — 🔴 쿼리에서 읽는 것은 **이 둘뿐**이다                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 **쿼리에서 읽는 이름 전부.** 사람을 가리키는 값은 여기 없고, 앞으로도 더하면
 * 안 된다 — 대상 사람은 **토큰 안에서만** 온다(portal-service-token.ts 의 8번).
 * 쿼리로 사람을 받는 순간 토큰 하나로 **아무의 결재 내역이나** 보는 문이 된다.
 * 시험이 이 파일에서 읽는 열쇠를 세어 둘인 것을 못 박는다.
 */
export const APPROVAL_HISTORY_PERIOD_PARAMS = ["from", "to"] as const;

/** 못 읽었을 때의 한 가지 답. 🔴 계약에 적힌 글자 그대로다(세 집이 같다). */
export const APPROVAL_HISTORY_PERIOD_ERROR = "invalid_period";

export type ApprovalHistoryPeriod =
  | { ok: true; from: Date; to: Date }
  | { ok: false; error: typeof APPROVAL_HISTORY_PERIOD_ERROR };

/**
 * 🔴 **시간대가 글자에 반드시 들어 있어야 한다. 그리고 모양을 **먼저** 본다.**
 *
 * ── ① `Date` 로 읽어 보는 것만으로는 못 거른다 ───────────────────────────
 * 2026-11-17 실측(이 PC):
 *     new Date("0")                    → 1999-12-31T15:00:00.000Z
 *     new Date("2026")                 → 2026-01-01T00:00:00.000Z
 *     new Date("11/01/2026")           → 2026-10-31T15:00:00.000Z
 *     new Date("2026-11-01T00:00:00")  → 2026-10-31T15:00:00.000Z
 * 🔴 넷 다 `NaN` 이 **아니다.** `Number.isNaN(at.getTime())` 하나만 믿으면
 * `?from=0` 이 **26년치 기간**으로 조용히 통과한다 — 오류도 안 나고 목록도 안
 * 빈다. `11/01/2026` 은 월·일 차례가 나라마다 반대라 **기계 설정에 따라** 11월
 * 1일이 되기도 1월 11일이 되기도 한다.
 *
 * ── ② 시간대가 없으면 **아홉 시간**이 조용히 어긋난다 ────────────────────
 * `2026-11-01T00:00:00` 은 **그 기계의 지역 시간**으로 읽힌다 — 위 실측에서 KST
 * 자정(= UTC 전날 15시)이 됐다. 개발 PC(KST)와 NAS 컨테이너(UTC)가 서로 다른
 * 구간을 보게 되고, 오류가 안 나서 「월말 하루치가 안 보인다」로만 나타난다.
 * 날짜만 적은 `2026-11-01` 도 막는다: 규격상 **UTC 자정**(= 한국 시간 오전 9시)
 * 으로 읽혀 **첫날 아홉 시간이 조용히 빠진다.**
 *
 * ── 🔴 세 집(A/S · 재고관리 · 휴가)이 **이 규칙으로 맞췄다** (2026-11-17) ──
 * 받아들이는 범위가 집마다 다르면 포털이 같은 요청을 셋에 던졌을 때 **한 집만
 * 400** 이 되고, 포털은 그것을 그 집의 **고장**으로 읽는다(승인함에서 그 집 줄만
 * 사라진다). 🔴 **바꾸려면 세 집을 함께 고친다.**
 *
 * ── 🔵 **안 막는 것 하나 — 넘치는 날짜는 조용히 굴러간다** ────────────────
 * 2026-11-17 실측: `new Date("2026-02-30T00:00:00Z")` 는 `NaN` 이 **아니라**
 * `2026-03-02T00:00:00.000Z` 다. 모양 검사도 `\d{2}` 라 통과시킨다 — 🔴 **둘 다
 * 안 막는다는 뜻이고, 알고 두는 것이다.** 막히는 것은 자릿수를 벗어난 값
 * (`2026-13-45…` → `NaN`)뿐이다. 넘치는 날짜는 부르는 쪽의 오타이고 경계가
 * 이틀 밀리는 정도인데, 여기만 더 좁히면 위의 「한 집만 400」이 그대로 일어난다.
 *
 * 🔵 포털이 보내는 값은 `Date.toISOString()` 이라 늘 `Z` 로 끝난다 — 이 울타리는
 * 사람이 손으로 두드려 볼 때와, 언젠가 부르는 쪽이 늘어날 때를 위한 것이다.
 */
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function readInstant(raw: string | null): Date | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (!ISO_WITH_ZONE.test(text)) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * `?from=…&to=…` 를 읽는다. **둘 다 필수**다.
 *
 * 🔴 **반열린 구간 `[from, to)`** — `to` 그 순간은 **안 들어간다.** 조회가 이미
 * 그 모양이고(data.ts 의 `ApprovalHistoryRange`: `from <= decided_at < to`),
 * 여기서는 값을 그대로 넘기기만 한다. 「11월 한 달」을 묻는 쪽은 `to` 에 12월
 * 1일 0시를 준다. 🔵 구간을 이어 붙일 때 경계의 한 순간이 양쪽에 두 번 들어가지
 * 않게 하려는 것이고, 끝난 위임의 기간(`[starts_at, ends_at)`)을 그대로 넘겨
 * 「그 위임 기간에 내가 대신한 결재」를 보는 자리가 설계 C-5 에 있다.
 *
 * 🔴 **`to` 가 `from` 보다 앞서도 거절하지 않고, 둘을 바꿔 끼우지도 않는다.**
 * 계약이 400 을 주라고 적은 것은 「없거나 못 읽을 때」 하나뿐이고, 뒤집힌 구간은
 * **읽히기는 한다** — 반열린 구간의 정의상 비어 있어 **빈 `entries`** 가 나간다.
 * 계약에 없는 400 을 이 집만 내면 포털은 그것을 **이 집의 고장**으로 읽는다
 * (승인함에서 이 집 줄만 사라진다). 친절하게 둘을 바꿔 끼우는 것은 더 나쁘다 —
 * 부르는 쪽의 실수가 **그럴듯한 답**으로 덮여 영영 안 드러난다.
 * 🔵 시험이 이 선택을 값으로 못 박아 둔다 — 나중에 뒤집으려면 세 집을 함께 고친다.
 */
export function parseApprovalHistoryPeriod(query: URLSearchParams): ApprovalHistoryPeriod {
  const from = readInstant(query.get("from"));
  const to = readInstant(query.get("to"));
  if (from === null || to === null) return { ok: false, error: APPROVAL_HISTORY_PERIOD_ERROR };
  return { ok: true, from, to };
}

/* ------------------------------------------------------------------ */
/* 내역 한 줄                                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 **보는 사람 기준**의 네 값. 계약의 글자 그대로다.
 *  · `SELF`        내가 내 자리를 눌렀다
 *  · `ON_BEHALF`   내가 **남을 대신해** 눌렀다 (상대 = 자리 주인)
 *  · `BY_DELEGATE` **내 자리를 남이** 눌렀다 (상대 = 누른 사람)
 *  · `UNKNOWN`     누른 사람이 **안 적힌** 줄 (상대 없음)
 */
export const APPROVAL_HISTORY_RELATIONS = [
  "SELF",
  "ON_BEHALF",
  "BY_DELEGATE",
  "UNKNOWN",
] as const;
export type ApprovalHistoryRelation = (typeof APPROVAL_HISTORY_RELATIONS)[number];

/**
 * ── 🔴 **이 집의 내부 이름과 계약의 낱말이 하나 다르다** ─────────────────────
 * 10a 가 지은 `BY_OTHER` 가 계약의 `BY_DELEGATE` 와 **같은 뜻**이다. 조회의
 * WHERE 가 `decided_by = 나 OR approver = 나` 이므로, 「내가 안 눌렀는데 내
 * 목록에 있다」는 **내 자리를 남이 누른 것** 말고는 될 수가 없다.
 *
 * 🔴 **내부 이름을 개명하지 않고 여기서 옮긴다.** 까닭 둘:
 *  ① **이 집은 「위임으로 눌렀다」를 증명하지 못한다.** 출처 칸을 안 만들었고
 *     (설계 B-16, 사용자가 「구별 없이 간단히」를 골랐다), 가르기가 보는 것은
 *     한 줄 안의 두 칸뿐이다. 안에서까지 `BY_DELEGATE` 라고 적으면 **코드가
 *     모르는 것을 아는 척**하게 된다 — 10a 의 approval-history.ts 머리말이 그
 *     사실을 길게 적어 둔 자리다. 밖에 내줄 때만 계약의 낱말을 쓴다.
 *  ② 10a 가 함께 지은 **사람이 읽는 이름표**가 「내 자리를 남이 결재」다.
 *     이름만 `BY_DELEGATE` 로 바꾸면 **이름과 이름표가 서로 다른 말**을 한다.
 *
 * 🔴 **옮기는 자리는 여기 하나뿐이고, 어긋나도 오류가 안 난다** — 그래서 아래
 * 표를 `Record<ApprovalHistoryRole, …>` 로 적는다. 10a 가 갈래를 하나 늘리는 날
 * **이 줄에서 컴파일이 막힌다**(안 막으면 새 갈래가 조용히 빠진다).
 * 🔵 네 값 중 `UNKNOWN` 만 이 표에 없다 — 그것은 「갈래」가 아니라 **누른 사람이
 * 안 적힌 줄**이라 아래 `approvalHistoryRelationOf` 가 따로 가른다.
 */
export const APPROVAL_HISTORY_RELATION_OF_ROLE: Record<
  ApprovalHistoryRole,
  ApprovalHistoryRelation
> = {
  SELF: "SELF",
  ON_BEHALF: "ON_BEHALF",
  BY_OTHER: "BY_DELEGATE",
};

/** 관계를 가리는 데 필요한 두 칸. 🔴 다른 칸은 보지 않는다. */
export type ApprovalHistoryRelationInput = {
  role: ApprovalHistoryRole;
  /** 실제로 누른 사람 이름. 🔴 번호가 안 적힌 줄에서만 null 이다(아래 참조) */
  decidedByName: string | null;
};

/**
 * 한 줄이 보는 사람에게 무엇인가 — **계약의 낱말로**.
 *
 * 🔴 **`UNKNOWN` 은 이 집에서 나오지 않는다. 그래도 가른다.** 「내가 안 눌렀다」와
 * 「아무도 안 적혀 있다」는 다른 말인데, 이 집의 `BY_OTHER` 는 둘을 한 값으로
 * 뭉쳐 들고 있다(10a 의 `approvalHistoryRole` 은 누른 사람 칸이 비면 그냥
 * `BY_OTHER` 를 돌려준다). 지금 그런 줄이 올라오지 않는 것은 **조회가 상태를
 * 승인·반려로 좁히기 때문**이고 — 누른 사람 칸을 비워 두는 길은 건너뛰기
 * (`skipStep` · `skipOpenSteps`)뿐이다 — 그 조건이 느슨해지는 날 「누가 눌렀는지
 * 모르는 줄」이 **상대 이름 없는 「남이 결재」**로 나간다. 그것은 화면에서
 * 「누군가 내 자리를 눌렀는데 이름이 안 뜬다」로 읽혀 없던 사고처럼 보인다.
 *
 * 🔵 **판정을 이름으로 한다.** 조회가 번호 두 칸을 걷어 내고 이름만 돌려주기
 * 때문이다(data.ts 의 `approvalHistoryFor`). 이 집은 **물리 삭제를 하지 않아**
 * 그만둔 사람의 행도 남아 이름이 풀리므로, 이름이 비는 것은 사실상 **번호가 안
 * 적힌 줄** 하나뿐이다.
 */
export function approvalHistoryRelationOf(
  row: ApprovalHistoryRelationInput,
): ApprovalHistoryRelation {
  const relation = APPROVAL_HISTORY_RELATION_OF_ROLE[row.role];
  if (relation === "BY_DELEGATE" && row.decidedByName === null) return "UNKNOWN";
  return relation;
}

/** 🔴 계약이 정한 두 값. 조회가 상태를 이 둘로 좁혀 둔다. */
export type ApprovalHistoryDecision = "APPROVED" | "REJECTED";

/**
 * 밖으로 나가는 한 줄. 🔴 **이 여덟 칸이 세 집의 계약이다** — 이름을 바꾸지 않는다.
 */
export type ApprovalHistoryEntry = {
  /** 이 시스템 안에서 유일. 다시 물어도 같다(단계 id 는 불변). */
  id: string;
  /** 사람이 알아보는 글자 — 누구의 무슨 휴가인가. */
  subject: string;
  /** 무슨 결재인가. */
  approvalName: string;
  /** ISO 8601. */
  decidedAt: string;
  decision: ApprovalHistoryDecision;
  relation: ApprovalHistoryRelation;
  /** 상대 사람 이름. 상대가 없는 갈래(SELF·UNKNOWN)는 null. */
  counterpartName: string | null;
  /** 🔴 절대 주소. */
  href: string;
};

export type PortalApprovalHistory = { entries: ApprovalHistoryEntry[] };

/** 되짚지 못했을 때의 답. 🔴 오류가 아니다 — 이 파일 머리말 참조. */
const EMPTY_HISTORY: PortalApprovalHistory = { entries: [] };

/**
 * 상대가 누구인가 — **갈래마다 반대쪽 사람**이다.
 *
 * 🔴 두 갈래가 **서로 반대 칸**을 본다. 바꿔 적으면 「내가 대신 눌러 준 사람」
 * 자리에 **내 이름**이 뜨고, 그래도 아무 오류가 안 난다(두 칸 다 사람 이름이다).
 * 그래서 시험이 둘을 **서로 다른 가짜 이름**으로 세워 맞대어 본다.
 */
function counterpartNameOf(
  relation: ApprovalHistoryRelation,
  row: Pick<ApprovalHistoryRow, "approverName" | "decidedByName">,
): string | null {
  switch (relation) {
    // 내가 남을 대신해 눌렀다 — 상대는 **그 자리의 주인**이다.
    case "ON_BEHALF":
      return row.approverName;
    // 내 자리를 남이 눌렀다 — 상대는 **누른 사람**이다.
    case "BY_DELEGATE":
      return row.decidedByName;
    // 상대가 없다(내가 내 자리를) · 상대를 모른다(안 적힌 줄).
    case "SELF":
    case "UNKNOWN":
      return null;
  }
}

/**
 * 상태를 계약의 두 값으로.
 *
 * 🔴 **던진다.** 조회가 `status in ('APPROVED','REJECTED')` 로 좁혀 두었으므로
 * 여기 올 수 없는 값이다. 그래도 `as` 로 눌러 끄지 않는 것은, 누가 그 조건을
 * 푸는 날 **`SKIPPED` 가 「반려」로 그려지는** 길이 열리기 때문이다 — 결재함
 * 화면이 이미 그렇게 그린다(`APPROVED` 가 아니면 반려로 적는다). 10a 가
 * `decidedAt` 이 null 인 줄에 같은 까닭으로 같은 모양을 두었다.
 */
function decisionOf(status: ApprovalHistoryRow["status"]): ApprovalHistoryDecision {
  if (status === "APPROVED" || status === "REJECTED") return status;
  throw new Error(`결재 내역에 승인·반려가 아닌 줄이 섞였다(${status}) — 조회의 상태 조건이 풀렸다`);
}

/**
 * 조회 한 줄을 밖으로 내보낼 모양으로.
 *
 * 🔴 **사유(reason)를 싣지 않는다** — 조회가 애초에 읽지 않는다(data.ts). 이 줄은
 * 포털을 거쳐 **다른 시스템의 화면**에 그려지고, 휴가 사유는 본인과 결재권
 * 직급에게만 보이는 값이다(guards.ts 의 `canSeeReason`).
 *
 * 🔴 **`id` 를 승인함 줄과 **같은 모양**으로 짓는다**(`LEAVE_REQUEST:<단계 id>`).
 * 같은 단계는 어느 목록에서 보든 같은 열쇠여야 포털이 둘을 맞대어 볼 수 있고,
 * 한 단계가 두 목록에 **동시에** 설 수는 없다(한쪽은 끝난 줄, 한쪽은 지금
 * 차례다). 열쇠를 새로 짓는 식이 두 벌이 되면 한쪽만 고치는 날이 온다.
 *
 * 🔵 **기간·일수를 `subject` 에 함께 적는다.** 계약에 `detail` 칸이 없어 그것
 * 말고는 실을 데가 없는데, 「○○○ · 연차 휴가 신청」만으로는 같은 사람의 줄이
 * 여럿일 때 서로 구별되지 않는다. `decidedAt` 은 **결재한 날**이지 휴가 날이
 * 아니다. 🔵 앞부분은 승인함 줄의 `subject` 와 글자까지 같게 두었다 — 포털
 * 화면에서 같은 결재가 두 목록에 같은 말로 선다.
 */
export function toApprovalHistoryEntry(
  row: ApprovalHistoryRow,
  baseUrl: string,
): ApprovalHistoryEntry {
  const relation = approvalHistoryRelationOf(row);
  return {
    id: `${LEAVE_REQUEST_APPROVAL_KIND}:${row.stepId}`,
    subject:
      `${row.applicantName} · ${TYPE_SHORT[row.leaveType]} ${KIND_LABEL[row.kind]} ` +
      `(${formatRange(row.startDate, row.endDate, true)} · ${formatDays(row.days)})`,
    // 🔵 이 집의 결재 단계에는 **이름이 없다** — 순서 있는 사람 목록이라
    //    「몇 번째인가」가 그 자리의 전부다(approval-scope.ts). 갈래 이름을
    //    앞에 붙이는 것은 포털 화면에 여러 시스템의 줄이 섞여 서기 때문이다.
    approvalName: `${LEAVE_REQUEST_APPROVAL_KIND_LABEL} ${row.stepNo}단계`,
    decidedAt: row.decidedAt.toISOString(),
    decision: decisionOf(row.status),
    relation,
    counterpartName: counterpartNameOf(relation, row),
    href: approvalHistoryHref(row.stepId, baseUrl),
  };
}

/**
 * 「이 사람이 이 기간에 한 / 대신한 / 대신 받은 결재」 전부.
 *
 * 🔴 대상 사람은 **`subject` 하나로만** 정해진다 — 토큰이 실어 온 값이고,
 * 라우트는 쿼리에서 사람을 읽지 않는다(이 파일 머리말).
 *
 * 🔴 **기간은 그대로 넘긴다.** 여기서 넓히거나 자르지 않는다 — 조회가 반열린
 * 구간을 그대로 쓰고, 한 번에 돌려주는 줄 수의 상한도 그쪽이 들고 있다
 * (data.ts 의 `APPROVAL_HISTORY_MAX_ROWS` = 500). 🔵 상한에 걸리면 **조용히
 * 잘린다** — 계약에 「더 있다」를 적을 칸이 없다. 한 사람이 한 해에 처리하는
 * 결재가 수백 줄이라 한 해를 통째로 물어도 남는다는 것이 그쪽의 판단이다.
 */
export async function buildPortalApprovalHistory(params: {
  subject: string;
  range: ApprovalHistoryRange;
  baseUrl: string;
  findActor: FindPortalActor;
  listHistory: (employeeId: string, range: ApprovalHistoryRange) => Promise<ApprovalHistoryRow[]>;
}): Promise<PortalApprovalHistory> {
  const actor = await params.findActor(params.subject);
  // 🔴 계정이 없거나(흔한 정상 상태) 명단에 안 이어진 사람은 **빈 목록**이다.
  //    여기서 오류를 뱉으면 포털이 모으는 다른 두 집까지 못 그릴 수 있다.
  if (!actor?.decider) return EMPTY_HISTORY;

  // 🔴 조회가 받는 것은 **명단 번호**다. 계정 번호를 넣으면 오류 없이 영원히 빈
  //    목록이 나온다(data.ts 의 `approvalHistoryFor` 머리말).
  const rows = await params.listHistory(actor.decider.employeeId, params.range);
  return { entries: rows.map((row) => toApprovalHistoryEntry(row, params.baseUrl)) };
}
