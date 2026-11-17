/**
 * ============================================================================
 * 포털의 **어긋남 점검**이 읽어 가는 위임 목록 — 몸통 모양과 상한 (설계 B-14)
 * ============================================================================
 * 2026-11-17, 조각 9a. 포털이 지정·철회하면 세 시스템(A/S·재고관리·휴가)에
 * 전파하고 셋이 다 성공했을 때만 포털에 적는다(B-13). 🔴 **그래도 「전파는
 * 됐는데 포털 저장이 실패하는」 틈은 남는다.** 맞대어 보는 장치가 없으면 그
 * 어긋남은 **영영 조용하다** — 그래서 읽기 갈래를 연다.
 *
 * 🔴 **실제로 한 번 갈렸던 자리다.** 같은 규약을 세 집에 줬는데 규약이
 * 「`revoked_at` 에 널이 오면?」을 안 적어서 A/S 는 안 지우고 재고관리·휴가는
 * 지웠다(설계 B-15). **셋이 제 시험을 전부 통과하면서** 갈려 있었고, 잡은 길은
 * 맞대어 보기뿐이었다. 이 파일은 그 맞대어 보기의 **내주는 쪽**이다.
 *
 * ── 🔴 답에 **사람을 싣지 않는다** — 이 설계의 핵심 ────────────────────────
 * 돌려주는 칸은 넷뿐이다: `id` · `startsAt` · `endsAt` · `revokedAt`.
 *  · 짝 맞추기는 **`id` 하나로 된다** — 포털이 정한 번호가 세 집에 **기본키로
 *    그대로** 들어 있다(이 집 표에 기본값 생성이 없다, schema.ts 의 ⓐ).
 *  · 사람 칸을 빼면 **이 통로가 새는 자료가 사실상 없다.** 🔴
 *    `delegator_employee_id`·`delegate_employee_id`·`reason` 을 실으면 안 된다 —
 *    점검에 쓰이지도 않는데 「회사 전체의 결재 대리 관계」가 토큰 하나로 통째로
 *    나간다.
 * 🔵 그래서 이 집에만 있는 **두 단 변환**(auth_sub → web_users.id →
 * employee_id)을 이 갈래는 **한 번도 쓰지 않는다.** 변환 코드를 끌어오면 그 순간
 * 사람을 실을 수 있게 되고, 다음 사람이 「이왕 읽은 김에」로 싣는다.
 *
 * ── 🔴 **모든 줄을 준다** ─────────────────────────────────────────────────
 * 살아 있는 것·끝난 것·**철회된 것 전부**다. 이 집에 이미 있는
 * `loadAllUnfinishedDelegations`(화면용)는 **안 끝난 줄만** 보므로 그대로 쓰면
 * **철회된 줄이 빠져** 맞대어 보기가 바로 그 자리에서 눈이 먼다 — 「포털은
 * 거뒀는데 집에서는 살아 있는」 줄이 B-13 이 말하는 **더 위험한 쪽**인데, 하필
 * 그것이 안 보인다.
 * ============================================================================
 */

/**
 * 읽기 갈래를 고르는 글자. 🔴 **세 집이 같아야 한다** — 포털 한 곳이 같은 몸통으로
 * 셋을 부른다(쓰기 갈래의 `upsert`·`revoke` 와 같은 약속).
 *
 * 🔴 **`DELEGATION_ACTIONS`(쓰기 갈래의 말 목록)에 더하지 않았다.** 거기에 넣으면
 * `parseDelegationCommand` 가 `list` 를 쓰기 명령으로 받아들여 「id 가 uuid 가
 * 아닙니다」로 거절하게 되고, 무엇보다 **쓰기 토큰으로 읽기 갈래에 들어오는 길**이
 * 생긴다. 두 갈래는 쓰임새(purpose)가 다르므로 **갈라지는 자리가 모양 검사보다
 * 앞**이어야 한다(통로 머리말).
 */
export const DELEGATION_LIST_ACTION = "list";

/**
 * 한 번에 내주는 줄의 상한.
 *
 * 🔵 넉넉하다 — 이 집의 위임은 사람 수에 묶여 있고(한 사람이 여러 줄을 맡기더라도
 * 기간이 겹치는 줄은 몇 개뿐이다) 끝난 줄까지 세어도 해에 수십 줄 자란다.
 * 🔴 **그래도 상한을 둔다.** 없으면 표가 자란 어느 날 점검 한 번이 수만 줄을
 * 한 몸통에 싣고, 그 줄에는 사람이 없으니 아무도 눈치채지 못한 채 느려진다.
 * 🔴 **넘치면 `truncated: true` 로 말한다**(아래). 조용히 자르면 점검이 잘린
 * 줄을 「집에 없다」로 읽고, 그것은 이 점검이 찾으려는 어긋남과 **글자 그대로 같은
 * 모양**이라 거짓 경보가 아니라 **거짓 진짜**가 된다.
 */
export const DELEGATION_LIST_LIMIT = 2000;

/**
 * 점검이 보는 줄. 🔴 **사람 칸이 없다**(이 파일 머리말). 표에서 고르는 칸도
 * 이것뿐이어야 한다 — 고른 뒤에 안 싣는 것이 아니라 **애초에 안 읽는다.**
 */
export type DelegationAuditRow = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  /** 비어 있으면 살아 있는 줄. 🔴 **거둔 줄도 반드시 함께 내준다.** */
  revokedAt: Date | null;
};

/** 몸통에 실리는 한 줄. 시각은 ISO 8601(UTC, `Z`)로 나간다. */
export type DelegationListEntry = {
  id: string;
  startsAt: string;
  endsAt: string;
  revokedAt: string | null;
};

export type DelegationListReply = {
  delegations: DelegationListEntry[];
  /** 🔴 상한에 걸려 **잘렸는가.** 잘렸으면 포털은 「없다」로 읽으면 안 된다. */
  truncated: boolean;
};

/** 몸통이 폼 인코딩인가. 🔵 `; charset=utf-8` 이 붙어 와도 같은 말이다. */
const FORM_ENCODED = /^application\/x-www-form-urlencoded\s*(;|$)/i;

/**
 * 몸통에서 **`action` 한 칸만** 엿본다. 🔴 모양 검사가 아니다 — 어느 갈래로 갈지
 * (= 어느 쓰임새의 토큰을 요구할지)만 정한다. 읽지 못하면 `null` 이고, 그러면
 * 통로는 **예전 그대로** 쓰기 갈래로 간다(모르는 값의 거절 규칙을 새로 만들지
 * 않는다).
 *
 * ── 🔴 몸통 모양 **둘을 다 받는다** ──────────────────────────────────────
 * 쓰기 갈래는 처음부터 **JSON** 이었고(세 집 규약, 2026-11-16), 이 갈래의 지시서는
 * **`application/x-www-form-urlencoded`** 로 적혀 있었다 — 포털이 **제 화면에**
 * 쓰는 위임 통로(dss-auth 의 `delegation-request.ts`)가 폼 인코딩이라 그 모양이
 * 따라온 것으로 보인다. 🔴 **어느 쪽으로 불러도 같은 답을 준다.** 규약이 안 정한
 * 빈칸에서 집마다 다르게 간 것이 B-15 에서 실제로 일어났고, 그때 비용은 「세 집이
 * 제 시험을 전부 통과하면서 갈려 있는」 상태였다. 여기서 한쪽만 받으면 **포털이
 * 어느 모양으로 부르느냐에 따라 집 하나만 400** 이 되는데, 그 400 은 점검
 * 스크립트에서 「못 쟀다」로 보여 어긋남과 섞인다.
 */
export function readDelegationAction(raw: string, contentType: string | null): string | null {
  if (FORM_ENCODED.test((contentType ?? "").trim())) {
    return new URLSearchParams(raw).get("action");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 🔵 여기서 400 을 내지 않는다. 읽히지 않는 몸통은 **쓰기 갈래의 일**이고,
    //    거기서는 토큰을 먼저 보고 거절한다(통로 머리말의 차례).
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const action = (parsed as Record<string, unknown>).action;
  return typeof action === "string" ? action : null;
}

/** 읽기 갈래인가. */
export function isDelegationListAction(action: string | null): boolean {
  return action === DELEGATION_LIST_ACTION;
}

/**
 * 표에서 읽은 줄을 몸통으로.
 *
 * 🔴 **상한보다 한 줄 더 받아서** 넘쳤는지를 가린다 — 부르는 쪽이
 * `limit + 1` 로 물어야 한다(auth/portal-delegations.ts 의 `loadDelegationsForAudit`).
 * 딱 `limit` 만 읽으면 **정확히 상한만큼 있는 날**과 **넘친 날**을 가를 수 없고,
 * 둘 중 뒤쪽에서만 `truncated` 가 참이어야 한다.
 *
 * 🔴 **칸을 하나씩 적어 싣는다.** `...row` 로 펼치면 표에 칸이 하나 늘거나 조회가
 * 칸을 더 고르는 날 **사람 번호가 조용히 몸통에 실린다** — 오류도 경고도 없고,
 * 받는 쪽(포털)은 더 온 칸을 그냥 버리므로 아무도 모른다.
 */
export function buildDelegationListReply(
  rows: readonly DelegationAuditRow[],
  limit: number = DELEGATION_LIST_LIMIT,
): DelegationListReply {
  const truncated = rows.length > limit;
  return {
    delegations: rows.slice(0, limit).map((row) => ({
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    })),
    truncated,
  };
}
