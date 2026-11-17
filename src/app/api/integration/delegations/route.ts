import { NextResponse, type NextRequest } from "next/server";

import {
  findEmployeeIdsBySubjects,
  loadDelegationsForAudit,
} from "@/lib/auth/portal-delegations";
import {
  revokePortalDelegation,
  upsertPortalDelegation,
} from "@/lib/auth/portal-delegation-store";
import {
  PORTAL_TOKEN_PURPOSES,
  readBearerToken,
  verifyPortalServiceToken,
} from "@/lib/auth/portal-service-token";
import { env } from "@/lib/env";
import {
  buildDelegationListReply,
  isDelegationListAction,
  readDelegationAction,
} from "@/lib/leave/portal-delegation-list";
import {
  applyDelegationCommand,
  parseDelegationCommand,
} from "@/lib/leave/portal-delegation-sync";

/**
 * ============================================================================
 * 포털과 **결재권 위임을 주고받는** 통로 — 쓰기 갈래 둘 + 읽기 갈래 하나
 * ============================================================================
 * 2026-11-16 저녁에 방식이 뒤집혔다(설계 B-12). 그 전에는 결재할 때마다 이쪽이
 * 포털에 **물었고**(B-3), 이제는 포털이 지정·철회할 때 세 시스템
 * (A/S · 재고관리 · 휴가)에 **써 준다.** 🔴 **세 시스템이 같은 규약**이다 —
 * 포털 한 곳이 같은 본문으로 셋을 부르므로 여기만 바꾸면 그 시스템만 조용히
 * 빠진다.
 *
 *     POST /api/integration/delegations
 *     Authorization: Bearer <포털이 서명한 서비스 토큰>
 *     { action, id, delegatorSub, delegateSub, startsAt, endsAt, reason, revokedAt }
 *
 *     200 { "outcome": "stored" }          적었다
 *     200 { "outcome": "not_applicable" }  이 시스템에는 해당 없다 — 🔴 성공이다
 *     4xx/5xx { error, error_description } 실패. 🔴 포털이 **지정 자체를 거절**한다
 *
 * ── 🔴 여기만 다른 것: 대상이 **토큰이 아니라 본문**에서 온다 ──────────────
 * 이웃한 통로들(notifications · approvals)은 **대상 사용자를 토큰 안에서만**
 * 받는다. 쿼리나 본문으로 받으면 토큰 하나로 **아무의 알림이나** 열리기 때문이다.
 * 🔴 이 통로는 그 규칙이 **그대로 적용되지 않는다** — 묻는 것이 「누구의 자료를
 * 보여 달라」가 아니라 「회사 전체의 위임 장부에 이 줄을 적어라」이기 때문이다.
 * 위임 장부의 주인은 포털이고, 포털은 **사람이 아니라 시스템으로서** 부른다.
 * 그래서 울타리가 다른 자리에 선다:
 *  · 토큰이 **포털의 서명**인가(JWKS) · **우리에게** 발급됐나(aud) ·
 *    **이 일을 하러** 왔나(purpose = 위임 쓰기). 알림을 읽으려고 구운 토큰으로는
 *    이 문이 열리지 않는다.
 *  · 🔴 토큰의 `sub`(부른 사람)는 **쓰지 않는다.** 이 일은 그 사람의 자료를
 *    건드리는 것이 아니고, 권한 판정은 포털이 이미 제 화면에서 했다. 그 값으로
 *    무엇을 더 가리려 하면 「포털이 누구 이름으로 부르는가」라는 약속이 하나 더
 *    생기는데, 규약에 그런 약속이 없다.
 *
 * ── 🟢 읽는 쪽이 이어졌다 (2026-11-16 저녁) ──────────────────────────────
 * 이 통로가 적은 줄을 **결재 판정이 실제로 읽는다.** 사람을 읽을 때 함께 읽고
 * (auth/guards.ts 의 `loadEmployee` → auth/portal-delegations.ts 의
 * `loadActingForEmployeeIds`) 그 목록이 「이 단계가 내 것인가」에 실린다
 * (leave/approval-scope.ts). 포털에 **묻던** 길은 그때 통째로 걷혔다.
 * 🔴 그러니 **여기서 안 적히면 그 사람은 아무 오류 없이 대신 누를 수 없다** —
 * 이 통로가 조용히 실패하면 증상이 저쪽 끝에서만 나타난다.
 *
 * ── 🔴 읽기 갈래가 생겼다 (2026-11-17, 조각 9a · 설계 B-14) ───────────────
 *     POST /api/integration/delegations
 *     Authorization: Bearer <포털이 서명한 서비스 토큰 — 🔴 **읽기 쓰임새**>
 *     action=list                      (JSON `{"action":"list"}` 도 같다)
 *
 *     200 { "delegations": [ { id, startsAt, endsAt, revokedAt } ],
 *           "truncated": false }
 *
 * 🔴 **답에 사람을 싣지 않는다** — 칸은 넷뿐이고 `id` 하나로 포털과 짝이 맞는다.
 * 까닭과 상한은 leave/portal-delegation-list.ts 머리말에 있다. 전파가 다 됐는데
 * **포털 저장만 실패하는 틈**(B-13 이 못 메우는 자리)을 맞대어 보려고 연 길이다.
 *
 * ── 🔴 갈래마다 **쓰임새가 다르다** ──────────────────────────────────────
 *  · 쓰기(`upsert`·`revoke`) — `dss.delegations.write`
 *  · 읽기(`list`)            — `dss.delegations.read`
 * 🔴 **쓰기 토큰으로 읽을 수 없고, 읽기 토큰으로 쓸 수 없다.** 한 벌로 묶으면
 * 「남에게 결재권을 맡기러」 구운 토큰이 **회사 전체의 위임 장부**를 여는 열쇠가
 * 된다. 🔵 포털이 읽기 글자를 굽기 전까지 읽기 갈래는 **전부 401** 이고, 그동안
 * **쓰기 갈래는 한 글자도 안 바뀐다.**
 *
 * 🔴 그래서 **토큰 검증보다 `action` 엿보기가 먼저다.** 어느 쓰임새를 요구할지가
 * 갈래에 달려 있어 차례를 뒤집을 수가 없다. 🔵 엿보기는 **몸통 글자에서 한 칸을
 * 읽을 뿐** 표도 토큰도 건드리지 않고, 못 읽으면 쓰기 갈래로 간다 — 그래서 자격
 * 없는 요청이 받는 답은 **갈래와 무관하게 401 하나**다(모양으로 떠볼 틈이 없다).
 * 🔵 엿보는 것은 **복제본**이다. 원본 몸통은 아래 쓰기 갈래가 예전 그대로
 * `request.json()` 으로 읽는다 — 2026-11-16 에 세 집이 맞춘 자리라 한 글자도
 * 건드리지 않았다.
 * ============================================================================
 */

/** 위임 장부가 캐시되면 거둔 위임이 살아 있는 것처럼 남는다. */
const NO_STORE = { "cache-control": "no-store" };

function notEnabled() {
  return NextResponse.json({ error: "not_enabled" }, { status: 404, headers: NO_STORE });
}

/**
 * 🔴 왜 거절했는지는 밖으로 내보내지 않는다 — 맞혀 가며 두드릴 실마리가 된다.
 * 까닭은 서버 로그에 남는다(portal-service-token.ts).
 */
function invalidToken() {
  return NextResponse.json(
    { error: "invalid_token" },
    { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
  );
}

/**
 * 🔴 **까닭을 글로 돌려준다.** 모양이 틀린 것은 부르는 쪽(포털)의 일이고, 포털은
 * 이 글을 지정 화면에 그대로 띄워 사람에게 보여 준다. 여기 쓰이는 글에는 사람을
 * 가리키는 값이 들어가지 않는다(leave/portal-delegation-sync.ts 가 짓는다).
 */
function invalidRequest(description: string) {
  return NextResponse.json(
    { error: "invalid_request", error_description: description },
    { status: 400, headers: NO_STORE },
  );
}

/**
 * 🔴 **읽기 갈래의 몸통.** 돌려주는 칸은 넷뿐이고 사람이 없다 —
 * leave/portal-delegation-list.ts 가 모양을 쥔다.
 *
 * 🔴 **못 읽으면 500 이다. 빈 목록으로 답하지 않는다.** 빈 목록은 「이 집에 위임이
 * 하나도 없다」는 **뜻 있는 답**이고, 점검은 그것을 「포털에만 있다 = 어긋남」으로
 * 읽는다. 읽기에 실패한 것을 그 모양으로 답하면 **DB 가 앓는 날 모든 위임이
 * 어긋난 것으로 보고된다.**
 */
async function listDelegations() {
  let rows;
  try {
    rows = await loadDelegationsForAudit();
  } catch (error) {
    // 🔵 남기는 것은 오류의 **종류**뿐이다(쓰기 갈래와 같은 처신).
    console.error(
      "[delegation-list] 위임 목록을 읽지 못했습니다:",
      error instanceof Error ? error.name : "unknown",
    );
    return NextResponse.json(
      { error: "storage_failed", error_description: "위임 목록을 읽지 못했습니다." },
      { status: 500, headers: NO_STORE },
    );
  }
  return NextResponse.json(buildDelegationListReply(rows), { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  // 임시 로그인만 쓰는 PC 에는 포털도, 포털의 서명도 없다(이웃 통로와 같은 판단).
  if (!env.ssoConfigured) return notEnabled();

  // 🔴 갈래를 먼저 가린다 — 요구할 쓰임새가 갈래마다 다르다(머리말). 🔵 복제본만
  //    읽으므로 아래 쓰기 갈래의 몸통은 손대지 않은 채로 남는다.
  const action = readDelegationAction(
    await request.clone().text(),
    request.headers.get("content-type"),
  );

  if (isDelegationListAction(action)) {
    const verified = await verifyPortalServiceToken(
      readBearerToken(request.headers.get("authorization")),
      // 🔴 **읽기 쓰임새**다. 쓰기 토큰으로 장부를 통째로 읽을 수 없어야 한다.
      PORTAL_TOKEN_PURPOSES.delegationsRead,
    );
    if (!verified.ok) return invalidToken();
    return listDelegations();
  }

  // ── 아래는 2026-11-16 의 쓰기 갈래. 🔴 차례까지 그대로다 ──────────────────
  const verified = await verifyPortalServiceToken(
    readBearerToken(request.headers.get("authorization")),
    PORTAL_TOKEN_PURPOSES.delegationsWrite,
  );
  if (!verified.ok) return invalidToken();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest("본문이 JSON 이 아닙니다.");
  }

  const parsed = parseDelegationCommand(body);
  if (!parsed.ok) return invalidRequest(parsed.error);

  let result;
  try {
    result = await applyDelegationCommand(parsed.command, {
      // 🔴 묻는 쪽과 **같은 조회**다. 거르는 조건이 두 벌이 되면 「읽을 때는
      //    되는데 쓸 때는 안 되는」 사람이 생긴다.
      lookup: findEmployeeIdsBySubjects,
      upsert: upsertPortalDelegation,
      revoke: revokePortalDelegation,
    });
  } catch (error) {
    // 🔴 **성공한 척하지 않는다.** 포털은 전파 실패를 보고 지정 자체를
    //    거절한다(설계 B-13) — 「맡겼는데 여기서만 안 듣는」 상태를 안 만드는
    //    것이 그 결정의 전부다. 🔵 남기는 것은 오류의 **종류**뿐이다.
    console.error(
      "[delegation-sync] 위임을 적지 못했습니다:",
      error instanceof Error ? error.name : "unknown",
    );
    return NextResponse.json(
      { error: "storage_failed", error_description: "위임을 저장하지 못했습니다." },
      { status: 500, headers: NO_STORE },
    );
  }

  if (result.outcome === "invalid") return invalidRequest(result.error);

  if (result.outcome === "not_applicable") {
    // 🔴 까닭은 **로그에만** 남는다(규약의 답은 한 가지다). 특히
    //    `*_unlinked` 는 휴가 관리자가 「직원 관리」에서 계정을 이어 주면 풀리는
    //    상태라, 안 남기면 그 사람만 오류 없이 조용히 위임이 안 걸린다.
    console.warn(`[delegation-sync] 이 시스템에는 해당 없음: ${result.reason}`);
    return NextResponse.json({ outcome: "not_applicable" }, { headers: NO_STORE });
  }

  return NextResponse.json({ outcome: "stored" }, { headers: NO_STORE });
}
