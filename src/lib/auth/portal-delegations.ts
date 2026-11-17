/**
 * ============================================================================
 * 포털이 써 준 결재권 위임 — **제 표에서 읽는다**
 * ============================================================================
 * 2026-11-16 저녁에 방식이 뒤집혔다(설계 B-12). 그 전에는 결재할 때마다 이
 * 시스템이 포털에 **물었고**(B-3), 이제는 포털이 지정·철회할 때 각 시스템에
 * **써 준다**(`api/integration/delegations` → `web_portal_approval_delegations`).
 * 그래서 읽는 쪽은 **망이 아니라 같은 DB 의 표 하나**를 본다.
 *
 * 🟢 **결재 길목에서 망 호출이 사라졌다.** 그 전환으로 이 파일에 있던
 * `resolvePortalActingDelegations`(묻기 배선)와, 「못 물었다」를 나르던
 * leave/approval-delegation.ts · 화면 안내 · `portalDelegationUnavailable` 가
 * 함께 없어졌다 — **「못 물음」이라는 상태 자체가 없기 때문이다**(설계 B-12 의
 * 「없어지는 것들」). 설계 B-6·B-7(못 물었을 때의 처신과 안내)도 같은 까닭으로
 * 이 집에서는 더 읽을 것이 없다.
 *
 * ── 🔴 이 파일에 있는 넷은 **쓰임이 다르다** ──────────────────────────────
 *  · 아래 `loadActingForEmployeeIds` — **판정이 읽는 쪽.** 「지금 내가 대신
 *    결재할 수 있는 사람들」을 결재 판정에 올린다. 돌려주는 것은 **번호뿐**이다.
 *  · 🔵 `loadDelegationsActingFor` · `loadDelegationsGivenBy` ·
 *    `loadAllUnfinishedDelegations` — **화면이 읽는 쪽**(2026-11-17, 조각 3c).
 *    사람에게 보여 줄 **이름과 기간**을 싣는다. 🔴 **판정에 쓰지 마라** —
 *    아직 시작 전인 줄까지 싣기 때문이다(아래 그 절 머리말).
 *  · 🔴 `loadDelegationsForAudit` — **포털의 어긋남 점검이 읽는 쪽**(2026-11-17,
 *    조각 9a · 설계 B-14). 🔴 **거르개가 하나도 없다** — 철회된 줄까지 **전부**
 *    준다. 위 화면용 조회로 대신할 수 없는 까닭이 바로 그것이고, 대신 **사람
 *    칸을 한 개도 안 읽는다.**
 *  · 🔴 `findEmployeeIdsBySubjects` — **받는 쪽**(조각 6)이 쓴다. 포털이 보낸
 *    `sub` 를 이 집 명단 번호로 바꾸는 자리이고, 부르는 곳은
 *    `app/api/integration/delegations/route.ts` 하나다. 🔴 **지우지 마라** —
 *    묻는 길을 걷어낼 때 같이 쓸려 나가기 가장 쉬운 함수인데, 없어지면 포털의
 *    전파가 500 으로 거절되고 **세 시스템의 위임 지정이 통째로 막힌다**(B-13).
 *
 * ── 🔴 열쇠가 **두 단**이다. 이 집에만 있는 사정이다 ──────────────────────
 *
 *     포털 sub → web_users.auth_sub 로 찾기 → web_users.employee_id
 *              → web_employees.id        ← 결재 권한의 실제 열쇠
 *
 * 🟢 **읽을 때는 그 변환이 없다.** 받는 통로가 저장하기 전에 두 단을 끝내
 * `web_employees.id` 로 적어 두기 때문이다(schema.ts 의 그 표 ⓒ). 그래서 읽는
 * 쪽은 **명단 번호 하나로** 묻고 답도 명단 번호로 나간다.
 * ============================================================================
 */
import { and, asc, eq, gt, inArray, isNull, lte, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/lib/db";
import { webEmployees, webPortalApprovalDelegations, webUsers } from "@/lib/db/schema";
import {
  DELEGATION_LIST_LIMIT,
  type DelegationAuditRow,
} from "@/lib/leave/portal-delegation-list";
import type { DelegatedApproverRow } from "@/lib/leave/portal-delegation-sync";
import { isValidSubject } from "./sso-role";

/* ------------------------------------------------------------------ */
/* 읽는 쪽 — 결재 판정이 쓴다                                           */
/* ------------------------------------------------------------------ */

/**
 * 🔴 **「살아 있는 위임」의 조건.** 이 집에서 이 문장은 여기 한 곳에만 있다.
 *
 *  · `revoked_at` 이 **비어 있다.** 포털이 거두면 값이 찍히고 줄은 그대로
 *    남는다(portal-delegation-store.ts) — 끝난 위임의 기간을 눌러 그 기간의
 *    결재를 보는 화면이 설계에 있어서다(C-5). 그러니 「줄이 있다」가 아니라
 *    **「거둔 표시가 없다」**로 물어야 한다.
 *  · 🔴 **반열린 구간**이다 — `starts_at <= 지금 < ends_at`. 끝을 `<=` 로 적으면
 *    끝나는 그 순간이 한 번 더 열리고, 그 한 번은 아무 오류도 내지 않는다.
 *    표의 CHECK 가 `ends_at > starts_at` 을 지키므로 「하루도 못 쓰는 위임」은
 *    애초에 들어오지 못한다.
 *
 * ── 🔴 **지금 시각을 인자로 받는다** ──────────────────────────────────────
 * 부르는 쪽이 **매 요청마다 새로** 찍는다. 그래서 기간이 끝나면 다음 화면부터
 * 결재함 메뉴도 배지도 종도 **저절로 닫힌다** — 만료를 적어 두는 칸도, 밤에 도는
 * 작업표도 없다. 🔴 이 값을 어딘가에 캐 두면 「끝났는데 아직 열려 있는」 위임이
 * 생기고, 여는 조건과 닫는 조건이 **같은 함수 하나**라는 이 설계의 안전장치가
 * 바로 그 자리에서 깨진다(설계 D-7 ④ 가 재고관리에서 같은 말을 한다).
 */
export function liveDelegationWhere(delegateEmployeeId: string, now: Date): SQL {
  return and(
    eq(webPortalApprovalDelegations.delegateEmployeeId, delegateEmployeeId),
    unfinishedWhere(now),
    lte(webPortalApprovalDelegations.startsAt, now),
  )!;
}

/**
 * 🔴 **「아직 안 끝난 줄」이지 「살아 있는 줄」이 아니다.** 거둔 표시가 없고 종료
 * 시각 전이면 참이라 **아직 시작 전인 줄까지 들어온다.**
 *
 * 🔴 **판정에 쓰지 마라** — 이것만으로 결재 권한을 열면 **시작 시각 전에 미리
 * 열린다.** 판정이 쓰는 것은 위 `liveDelegationWhere`(여기에 `starts_at <= 지금`
 * 을 더한 것) 하나뿐이다.
 *
 * 🔵 **그럼 왜 가르나** — 화면은 더 넓게 보여야 한다. 통합 승인함에서 **내일부터**로
 * 맡겨 놓고 곧바로 이 시스템을 열어 본 사람에게 「없습니다」만 보이면, 그것이
 * **전파가 안 된 것인지 아직 시작 전인 것인지** 가릴 길이 없다(2026-11-17 에
 * 사용자가 「위임되었다는 내용이 안 뜬다」고 한 바로 그 자리다). 그래서 화면은
 * 시작 전 줄도 싣고 **「시작 전」이라고 적는다**(leave/delegation-view.ts).
 *
 * 🔴 **끝난 줄과 거둔 줄은 양쪽 다 안 보인다** — 「위임이 끝나면 안내도 사라진다」가
 * 이 한 줄에 달려 있다. 끝난 위임을 보여 주는 화면은 설계 C-5 의 다음 조각이다.
 */
function unfinishedWhere(now: Date): SQL {
  return and(
    isNull(webPortalApprovalDelegations.revokedAt),
    gt(webPortalApprovalDelegations.endsAt, now),
  )!;
}

/**
 * 「지금 이 사람이 대신 결재할 수 있는 사람들」을 고르는 질의.
 *
 * 🔴 **질의를 만들기만 하고 돌리지 않는다.** 시험이 이것을 `.toSQL()` 로 **실제로
 * 구워** 반열린 구간과 거둔 줄 거르기를 글자가 아니라 **구워진 SQL** 로 본다
 * (portal-delegation-store.ts 가 같은 까닭으로 같은 모양이다). drizzle 의 질의는
 * `await` 할 때 비로소 돌므로 만들어 두기만 하는 것은 DB 에 닿지 않는다.
 *
 * 🔴 **이어 붙지 않는다** — 고르는 줄은 `delegate_employee_id = 나` 하나뿐이다.
 * A→B, B→C 라도 C 는 A 를 못 얻는다. 재귀 질의를 쓰면 아무도 지정하지 않은
 * 결재권이 생긴다(approval-scope.ts 의 `approvableEmployeeIds` 와 같은 말).
 *
 * 🔵 `selectDistinct` 와 차례를 못 박는 것은 **같은 사람에게 기간이 겹치는 위임이
 * 둘 이상** 있을 수 있어서다. 합치는 자리가 중복을 다시 걷지만(위 함수), 여기서
 * 줄여 두면 결재함 SQL 의 `in (...)` 이 같은 번호를 두 번 싣지 않는다.
 */
export function actingForEmployeeIdsQuery(delegateEmployeeId: string, now: Date) {
  return db
    .selectDistinct({
      delegatorEmployeeId: webPortalApprovalDelegations.delegatorEmployeeId,
    })
    .from(webPortalApprovalDelegations)
    .where(liveDelegationWhere(delegateEmployeeId, now))
    .orderBy(webPortalApprovalDelegations.delegatorEmployeeId);
}

/**
 * 🔴 **이 조각의 입구.** 「지금 내가 대신 결재할 수 있는 사람들」을 이 시스템의
 * `web_employees.id` 목록으로.
 *
 * 🔴 **던지는 것을 삼키지 않는다.** 묻던 시절에는 포털이 앓아도 결재가 그대로
 * 진행되도록 모든 오류를 값으로 바꿔 돌려주었다(설계 B-6). 지금 읽는 곳은
 * **이 시스템 자신의 DB** 라, 여기서 못 읽는 날이면 이 화면은 어차피 한 줄도
 * 그리지 못한다. 삼키면 **위임만 조용히 안 듣는** 상태가 되는데, 그것이 이
 * 저장소들에서 가장 비싼 결함 모양이다.
 *
 * @param delegateEmployeeId 대신 누르는 사람의 **명단 번호**(`web_employees.id`).
 *                           🔴 계정 번호(`web_users.id`)도 포털 번호도 아니다 —
 *                           넣으면 오류 없이 영원히 빈 목록이 나온다.
 * @param now 판정 기준 시각. 기본은 **지금**이고, 부르는 쪽이 요청마다 새로
 *            찍는다(위 `liveDelegationWhere` 의 그 까닭).
 */
export async function loadActingForEmployeeIds(
  delegateEmployeeId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await actingForEmployeeIdsQuery(delegateEmployeeId, now);
  return rows.map((row) => row.delegatorEmployeeId);
}

/* ------------------------------------------------------------------ */
/* 🔵 화면이 읽는 쪽 — 사람에게 보여 줄 **이름과 기간** (조각 3c)         */
/* ------------------------------------------------------------------ */

/**
 * 화면 한 줄. 🔴 **판정에 쓰는 값이 아니다** — 아래 세 조회는 시작 전 줄까지
 * 싣는다(`unfinishedWhere` 머리말).
 *
 * 🔵 **양쪽 이름을 늘 함께 싣는다.** 「받은 것」에 맡긴 사람 이름만, 「맡긴 것」에
 * 대리인 이름만 싣는 꼴로 나누면 조회가 세 벌이 되고, 관리자가 보는 「모두의 것」은
 * 어차피 둘 다 필요하다. 어느 이름을 그릴지는 **그리는 쪽**이 고른다
 * (leave/delegation-view.ts 의 `delegationSentence`).
 */
export type PortalDelegationView = {
  id: string;
  /** 결재권을 맡긴 사람 이름 */
  delegatorName: string;
  /** 대신 결재하는 사람 이름 */
  delegateName: string;
  startsAt: Date;
  endsAt: Date;
  /** 맡긴 까닭. 없으면 빈 글자다(통로 규약) */
  reason: string;
};

/**
 * 🔴 **이름은 이 집 명단에서 읽는다 — 포털에 묻지 않는다.** 받는 통로가 저장할
 * 때 이미 명단 번호로 바꿔 두었으므로(이 파일 머리말의 두 단) 이름은 조인 한 번에
 * 따라온다. 포털에 물으면 화면 하나가 다시 망에 매이고, 그것을 걷어낸 것이 조각
 * 8 이다(설계 B-12).
 *
 * 🔴 **한 표를 두 번 조인한다.** 맡긴 사람과 대리인이 둘 다 `web_employees` 라
 * 별명 없이 쓰면 drizzle 이 같은 표를 한 번만 걸고 **두 이름이 같은 값**이 된다 —
 * 오류 없이 「김○○님이 김○○님에게 맡겼습니다」가 그려진다.
 *
 * 🔵 질의를 **만들기만** 하는 함수를 따로 두는 것은 이 파일의 다른 자리와 같은
 * 까닭이다 — 시험이 `.toSQL()` 로 구워 조건을 글자가 아니라 **구워진 SQL** 로 본다.
 */
function delegationViewQuery(who: SQL | undefined, now: Date) {
  const delegator = alias(webEmployees, "delegator");
  const delegate = alias(webEmployees, "delegate");
  const unfinished = unfinishedWhere(now);
  return db
    .select({
      id: webPortalApprovalDelegations.id,
      delegatorName: delegator.name,
      delegateName: delegate.name,
      startsAt: webPortalApprovalDelegations.startsAt,
      endsAt: webPortalApprovalDelegations.endsAt,
      reason: webPortalApprovalDelegations.reason,
    })
    .from(webPortalApprovalDelegations)
    .innerJoin(delegator, eq(delegator.id, webPortalApprovalDelegations.delegatorEmployeeId))
    .innerJoin(delegate, eq(delegate.id, webPortalApprovalDelegations.delegateEmployeeId))
    .where(who ? and(who, unfinished)! : unfinished)
    // 먼저 시작한 것이 위다 — 진행 중인 줄이 시작 전 줄보다 앞에 선다.
    .orderBy(asc(webPortalApprovalDelegations.startsAt));
}

/** 「내가 대신하고 있는 것」 — 🔴 **대리인으로 찾는다.** */
export function delegationsActingForQuery(delegateEmployeeId: string, now: Date) {
  return delegationViewQuery(
    eq(webPortalApprovalDelegations.delegateEmployeeId, delegateEmployeeId),
    now,
  );
}

/** 「내가 맡긴 것」 — 🔴 **맡긴 사람으로 찾는다.** 위와 방향이 반대다. */
export function delegationsGivenByQuery(delegatorEmployeeId: string, now: Date) {
  return delegationViewQuery(
    eq(webPortalApprovalDelegations.delegatorEmployeeId, delegatorEmployeeId),
    now,
  );
}

/** 「모두의 것」 — 사람 조건이 없다. 🔴 부르기 전에 권한을 묻는 자리는 아래다. */
export function allUnfinishedDelegationsQuery(now: Date) {
  return delegationViewQuery(undefined, now);
}

export async function loadDelegationsActingFor(
  delegateEmployeeId: string,
  now: Date = new Date(),
): Promise<PortalDelegationView[]> {
  return delegationsActingForQuery(delegateEmployeeId, now);
}

export async function loadDelegationsGivenBy(
  delegatorEmployeeId: string,
  now: Date = new Date(),
): Promise<PortalDelegationView[]> {
  return delegationsGivenByQuery(delegatorEmployeeId, now);
}

/**
 * 관리자용 「모두의 결재권 위임」.
 *
 * 🔴 **권한이 없으면 `null` 이다 — DB 에 묻지도 않는다.** 화면에서 가리는 것이
 * 아니라 **없는 것**이어야 한다: 서버 컴포넌트가 읽은 값은 그리지 않아도 HTML 에
 * 실려 나가므로, 「관리자일 때만 그린다」만으로는 **한 줄도 못 막는다.**
 * (A/S 의 같은 묶음이 같은 까닭으로 조회 함수 자신이 거절한다 —
 * `listAllApprovalRouteDelegations`.)
 *
 * 🔵 줄 수에 상한을 두지 않았다. 여기 담기는 것은 **아직 안 끝난 위임**뿐이라
 * 사람 수를 넘지 않는다. 끝난 것까지 보는 화면(설계 C-5)을 만드는 날 상한을
 * 함께 가져와야 한다 — 그쪽은 해가 갈수록 쌓인다.
 */
export async function loadAllUnfinishedDelegations(opts: {
  isAdmin: boolean;
  now?: Date;
}): Promise<PortalDelegationView[] | null> {
  if (!opts.isAdmin) return null;
  return allUnfinishedDelegationsQuery(opts.now ?? new Date());
}

/* ------------------------------------------------------------------ */
/* 🔴 포털의 어긋남 점검이 읽는다 — **거르개가 없는** 자리 (조각 9a)      */
/* ------------------------------------------------------------------ */

/**
 * 「이 집이 지금 가진 위임 전부」. 🔴 **where 가 한 줄도 없는 것이 이 조회의
 * 전부다.** 살아 있는 것·끝난 것·**거둔 것**을 다 준다 — 포털과 맞대어 볼 때
 * 「포털은 거뒀는데 집에서는 살아 있는」 줄이 가장 위험한 어긋남인데(설계 B-13),
 * 거른 목록으로는 그 줄이 **양쪽에서 똑같이 안 보인다.**
 *
 * 🔴 **사람 칸을 안 고른다.** 고른 뒤에 안 싣는 것이 아니라 아예 안 읽는다 —
 * 몸통을 짓는 자리(leave/portal-delegation-list.ts)와 **두 겹**으로 막아 둔 것은,
 * 한 겹만 있으면 다음 사람이 「조회는 다 읽어 두고 고를 때 가리자」로 쉽게
 * 무너뜨리기 때문이다.
 *
 * 🔴 **차례를 못 박는다**(번호 오름차순). 상한에 걸려 잘릴 때 **어느 줄이 잘리는가**가
 * 호출마다 달라지면, 점검이 돌 때마다 다른 줄을 「집에 없다」로 읽는다.
 *
 * 🔴 **상한보다 한 줄 더 읽는다**(`limit + 1`). 그 한 줄이 「넘쳤다」를 가리는 유일한
 * 길이고, 딱 상한만큼 읽으면 **정확히 상한만큼 있는 날**과 **넘친 날**이 같은 답이
 * 된다. 세어서 잘라내는 것은 몸통을 짓는 쪽이다(`buildDelegationListReply`) —
 * 🔴 **그러니 이 함수가 돌려주는 줄 수를 그대로 내보내면 안 된다.**
 *
 * 🔴 **질의를 만들기만 하고 돌리지 않는다** — 이 파일의 다른 자리와 같다. 시험이
 * `.toSQL()` 로 구워 「사람 칸을 안 고르는가」·「거르개가 없는가」·「한 줄 더 묻는가」를
 * 글자가 아니라 **구워진 SQL** 로 본다.
 */
export function delegationsForAuditQuery(limit: number = DELEGATION_LIST_LIMIT) {
  return db
    .select({
      id: webPortalApprovalDelegations.id,
      startsAt: webPortalApprovalDelegations.startsAt,
      endsAt: webPortalApprovalDelegations.endsAt,
      revokedAt: webPortalApprovalDelegations.revokedAt,
    })
    .from(webPortalApprovalDelegations)
    .orderBy(asc(webPortalApprovalDelegations.id))
    .limit(limit + 1);
}

/**
 * 🔴 **읽기 갈래의 입구.** 부르는 곳은 `api/integration/delegations` 하나다.
 *
 * 🔴 **던지는 것을 삼키지 않는다** — 못 읽은 것을 빈 목록으로 답하면 점검이 그것을
 * 「이 집에 위임이 하나도 없다」로 읽고, **DB 가 앓는 날 모든 위임이 어긋난 것으로
 * 보고된다.** 통로가 500 으로 답한다.
 */
export async function loadDelegationsForAudit(
  limit: number = DELEGATION_LIST_LIMIT,
): Promise<DelegationAuditRow[]> {
  return delegationsForAuditQuery(limit);
}

/* ------------------------------------------------------------------ */
/* 🔴 받는 쪽이 쓴다 — 읽는 쪽과 **거르개를 함께 쓰는** 자리              */
/* ------------------------------------------------------------------ */

/**
 * 포털 번호들 → 이 시스템의 계정·명단.
 *
 * 🔴 **부르는 곳은 받는 통로 하나다**(`app/api/integration/delegations`). 포털이
 * 보낸 `sub` 를 명단 번호로 바꿔 표에 적는 두 단 변환의 첫 단이고, 판단 쪽
 * (leave/portal-delegation-sync.ts)이 `lookup` 자리에 이 함수를 꽂는다.
 *
 * 🔴 **못 찾은 번호를 채워 넣지 않는다.** 돌려주는 줄 수가 물어본 번호 수보다
 * 적은 것이 곧 「바꾸지 못한 수」이고, 그것을 가려 읽는 자리는 판단 쪽이다.
 *
 * 🔴 **명단에 안 이어진 계정도 그대로 올려 준다**(`employeeId: null`). 여기서
 * 버리면 「계정이 아예 없는 사람」과 섞여, 휴가 관리자가 계정만 이어 주면 풀릴
 * 일을 영영 못 알아챈다 — 통로가 돌려주는 「해당 없음」의 까닭이 그 둘로 갈린다.
 *
 * 🔴 uuid 모양이 아닌 번호는 **묻기 전에 버린다** — `auth_sub` 는 uuid 열이라
 * 모양이 아닌 값으로 조회하면 드라이버가 던진다(portal-actor.ts 의 같은 줄).
 * 버려진 번호는 줄 수 차이로 셈에 잡힌다.
 */
export async function findEmployeeIdsBySubjects(
  subs: readonly string[],
): Promise<DelegatedApproverRow[]> {
  const asked = subs.filter((sub) => isValidSubject(sub));
  if (asked.length === 0) return [];

  return db
    .select({ authSub: webUsers.authSub, employeeId: webUsers.employeeId })
    .from(webUsers)
    .where(
      and(
        inArray(webUsers.authSub, asked),
        // 🔴 화면·알림과 **같은 조건**이다(portal-actor.ts · findPortalActor).
        eq(webUsers.isActive, true),
        eq(webUsers.isDeleted, false),
      ),
    );
}
