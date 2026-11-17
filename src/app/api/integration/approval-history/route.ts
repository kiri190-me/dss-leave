import { NextResponse, type NextRequest } from "next/server";

import { findPortalActor } from "@/lib/auth/portal-actor";
import {
  PORTAL_TOKEN_PURPOSES,
  readBearerToken,
  verifyPortalServiceToken,
} from "@/lib/auth/portal-service-token";
import { env } from "@/lib/env";
import { approvalHistoryFor } from "@/lib/leave/data";
import {
  APPROVAL_HISTORY_PERIOD_ERROR,
  buildPortalApprovalHistory,
  parseApprovalHistoryPeriod,
} from "@/lib/leave/portal-approval-history";

/**
 * ============================================================================
 * 「이 사람이 이 기간에 한 결재」를 밖으로 내주는 통로 — 통합 승인함이 쓴다
 * ============================================================================
 * 사용자 요청(2026-11-17): 「내가 했던 결재나 **나를 대신해서** 어떤 결재를 했는지도
 * 특정 날짜 혹은 기간을 선택해서 확인」. 설계 C-4. 화면은 이 집에 안 만들고
 * 통합 승인함 한 곳에 둔다 — 포털이 **세 집**(A/S · 재고관리 · 휴가)에 같은
 * 질문을 던져 한 화면에 모은다.
 *
 *     GET /api/integration/approval-history?from=<ISO8601>&to=<ISO8601>
 *     Authorization: Bearer <포털이 서명한 서비스 토큰>
 *
 *     200 { "entries": [ … ] }        줄이 없어도 200 이다
 *     400 { "error": "invalid_period" }  from·to 가 없거나 못 읽는다
 *     401 { "error": "invalid_token" }
 *     404 { "error": "not_enabled" }     포털 설정이 없는 PC
 *
 * 🔴 **틀은 옆 통로(../approvals/route.ts)를 그대로 따른다.** 왜 그래야 하는지는
 * 그 파일과 그 위의 알림 통로 주석에 다 적혀 있다 — 여기서는 같은 규칙을 다시
 * 못 박는 것뿐이다:
 *  · 🔴 **대상 사용자는 토큰 안에서만** 온다. 쿼리에서 사람을 읽지 않는다 —
 *    읽는 순간 토큰 하나로 **아무의 결재 내역이나** 보는 문이 된다. 이 통로는
 *    쿼리를 읽기는 하지만 읽는 열쇠는 **기간 둘뿐**이고, 그 둘을 읽는 자리도
 *    여기가 아니라 판단 쪽 한 곳이다(leave/portal-approval-history.ts 의
 *    `parseApprovalHistoryPeriod` — 시험이 거기서 읽는 열쇠를 세어 둘인 것을
 *    못 박는다).
 *  · 링크는 절대 주소이고, 기준 주소는 요청의 Host 가 아니라 환경에서 온다
 *    (env.ts 의 appBaseUrl — Host 머리말은 부르는 쪽이 마음대로 적는다).
 *  · 응답을 캐시하지 않는다.
 *  · GET 인 것은 읽기뿐이기 때문이고, 토큰을 쿼리가 아니라 `Authorization`
 *    머리말로 받는 것은 쿼리가 접근 로그에 그대로 남기 때문이다.
 *
 * ── 🔴 거절하는 **차례**가 뜻을 갖는다 ───────────────────────────────────
 * 토큰을 **먼저** 본다. 기간을 먼저 보면 자격 없는 호출에게 「기간은 맞다/틀리다」를
 * 알려 주게 되고, 그것은 맞혀 가며 두드릴 실마리가 된다(토큰 거절에 까닭을 안
 * 싣는 것과 같은 판단).
 *
 * ── 🔴 토큰의 쓰임새는 아직 알림 읽기 그대로다 ──────────────────────────
 * `PORTAL_TOKEN_PURPOSES.notificationsRead` 를 요구한다. 옆 통로(승인함)가 같은
 * 판단으로 같은 값을 쓰고, 그 까닭은 거기 적혀 있다 — 쓰임새 글자는 포털과의
 * **약속**이라 `dss-auth` 가 새 값을 굽기 시작한 뒤에야 여기서 요구할 수 있다
 * (먼저 바꾸면 이 통로가 통째로 401 이 된다). 🔴 세 집이 같은 값을 써야 한다.
 * 🔵 지금 상태가 새 자료를 여는 것은 아니다 — 내주는 것은 그 사람 **자신이
 * 걸린** 결재 줄뿐이고, 고르는 조건은 10a 의 조회 한 곳에 있다.
 * ============================================================================
 */

/** 이 응답이 캐시되면 방금 한 결재가 한참 뒤에야 내역에 뜬다. */
const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: NextRequest) {
  // 임시 로그인만 쓰는 PC 에는 포털도, 포털의 서명도 없다(이웃 통로와 같은 판단).
  if (!env.ssoConfigured) {
    return NextResponse.json({ error: "not_enabled" }, { status: 404, headers: NO_STORE });
  }

  const verified = await verifyPortalServiceToken(
    readBearerToken(request.headers.get("authorization")),
    PORTAL_TOKEN_PURPOSES.notificationsRead,
  );
  if (!verified.ok) {
    // 왜 거절했는지는 밖으로 내보내지 않는다 — 까닭은 서버 로그에 남는다
    // (portal-service-token.ts).
    return NextResponse.json(
      { error: "invalid_token" },
      { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
    );
  }

  // 🔴 `request.url` 을 쓰지 않는다 — next dev 에서는 들어온 Host 가 아니라
  //    localhost 가 보인다. 여기서는 쿼리만 쓰므로 결과가 같지만, 그 글자가
  //    이 파일에 있으면 다음 사람이 거기서 기준 주소를 뽑는다.
  const period = parseApprovalHistoryPeriod(request.nextUrl.searchParams);
  if (!period.ok) {
    // 🔴 계약이 정한 글자 그대로다. 세 집이 같은 답을 해야 포털이 「이 집만
    //    못 물었다」를 가릴 수 있다.
    return NextResponse.json(
      { error: APPROVAL_HISTORY_PERIOD_ERROR },
      { status: 400, headers: NO_STORE },
    );
  }

  const history = await buildPortalApprovalHistory({
    subject: verified.subject,
    range: { from: period.from, to: period.to },
    baseUrl: env.appBaseUrl,
    // 🔴 열쇠를 되짚는 길을 새로 짓지 않는다 — 알림·승인함이 쓰는 그 함수다
    //    (auth_sub → web_users → employee_id 두 단).
    findActor: findPortalActor,
    // 🔴 고르는 조건을 새로 적지 않는다 — 10a 가 만든 조회를 그대로 넘긴다
    //    (leave/data.ts 의 approvalHistoryFor). 거기 `SKIPPED` 거르기와 부분
    //    색인에 맞춘 글자 조건이 들어 있다.
    listHistory: approvalHistoryFor,
  });

  // 🔴 이 시스템에 계정이 없거나 명단에 안 이어진 사람은 빈 목록이다 — 오류가
  //    아니다(leave/portal-approval-history.ts 머리말 참조).
  return NextResponse.json(history, { headers: NO_STORE });
}
