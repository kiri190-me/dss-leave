import { NextResponse, type NextRequest } from "next/server";

import { findPortalActor } from "@/lib/auth/portal-actor";
import {
  PORTAL_TOKEN_PURPOSES,
  readBearerToken,
  verifyPortalServiceToken,
} from "@/lib/auth/portal-service-token";
import { env } from "@/lib/env";
import { pendingApprovalsForPortal } from "@/lib/leave/data";
import { buildPortalApprovalInbox } from "@/lib/leave/portal-approvals";

/**
 * ============================================================================
 * 「이 사람이 결재할 휴가 신청」을 밖으로 내주는 통로 — 통합 승인함이 쓴다
 * ============================================================================
 * 새 사이트 `dss-approvals`(통합 승인함)가 사내 시스템마다 이 통로에 물어 한
 * 창에 모은다. 응답의 모양과 판단은 전부 leave/portal-approvals.ts 에 있고,
 * 여기 남은 일은 「머리말에서 토큰 꺼내 검증하고 그 함수 부르기」뿐이다.
 *
 * 🔴 **틀은 알림 통로(../notifications/route.ts)를 그대로 따른다.** 왜 그래야
 * 하는지는 그 파일의 주석에 다 적혀 있다 — 여기서는 같은 규칙을 다시 못 박는
 * 것뿐이다:
 *  · 대상 사용자는 **토큰 안에서만** 온다. 쿼리 문자열을 읽지 않는다 — 읽으면
 *    토큰 하나로 **아무의 결재함이나** 볼 수 있는 문이 된다.
 *  · 링크는 절대 주소다. 기준 주소는 요청의 Host 가 아니라 환경에서 온다
 *    (env.ts 의 appBaseUrl).
 *  · 응답을 캐시하지 않는다. 처리한 결재가 남의 승인함에 계속 남으면 안 된다.
 *  · GET 인 것은 읽기뿐이기 때문이고, 토큰을 쿼리가 아니라 `Authorization`
 *    머리말로 받는 것은 쿼리가 접근 로그에 그대로 남기 때문이다.
 *
 * 🔴 **승인·반려를 실행하는 길은 여기 없다.** 이 통로는 읽기 전용이고,
 * [승인하기] 는 `href` 가 가리키는 이 시스템의 결재함 화면으로 **건너가기만**
 * 한다(2026-10-23 사용자 결정). 그래서 이 파일에 POST 가 없다.
 *
 * ── 🔴 토큰의 쓰임새는 아직 알림 읽기 그대로다 ──────────────────────────
 * `PORTAL_TOKEN_PURPOSES.notificationsRead` 를 요구한다. 「결재할 건」은 종과
 * 다른 것이라 쓰임새를 따로 두는 편이 최소 권한에 맞지만, 쓰임새 글자는 포털과의
 * **약속**이라 `dss-auth` 가 그 값을 굽기 시작한 뒤에야 여기서 요구할 수 있다
 * (먼저 바꾸면 승인함이 통째로 401 이 된다). A/S(RF_Service_System)의 같은
 * 통로도 같은 판단으로 같은 쓰임새를 쓴다 — 양쪽을 함께 고치는 날
 * `dss.approvals.read` 로 옮긴다.
 * 🔵 지금 상태가 새 자료를 여는 것은 아니다 — 이 통로가 내주는 결재는 종이 이미
 * 같은 토큰으로 내주던 그 사람 자신의 건이고, 자격 판정도 같은 조회가 한다.
 * ============================================================================
 */

/** 이 응답이 캐시되면 처리된 결재가 남의 승인함에 계속 남는다. */
const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: NextRequest) {
  // 임시 로그인만 쓰는 PC 에는 포털도, 포털의 서명도 없다. 열어 둘 이유가
  // 없다(알림 통로와 같은 판단).
  if (!env.ssoConfigured) {
    return NextResponse.json({ error: "not_enabled" }, { status: 404, headers: NO_STORE });
  }

  const verified = await verifyPortalServiceToken(
    readBearerToken(request.headers.get("authorization")),
    PORTAL_TOKEN_PURPOSES.notificationsRead,
  );
  if (!verified.ok) {
    // 왜 거절했는지는 밖으로 내보내지 않는다 — 부르는 쪽이 맞혀 가며 두드릴
    // 실마리가 된다. 까닭은 서버 로그에 남는다(portal-service-token.ts).
    return NextResponse.json(
      { error: "invalid_token" },
      { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
    );
  }

  const inbox = await buildPortalApprovalInbox({
    subject: verified.subject,
    baseUrl: env.appBaseUrl,
    findActor: findPortalActor,
    // 🔴 자격 판정을 새로 짓지 않는다 — 결재함·건수·알림과 같은 조건
    // (myPendingApprovalWhere)으로 고른 조회를 그대로 넘긴다
    // (leave/data.ts 의 pendingApprovalsForPortal).
    listPendingApprovals: pendingApprovalsForPortal,
  });

  // 🔴 이 시스템에 계정이 없는 사람은 빈 목록이다 — 오류가 아니다. 계정은
  // 있는데 명단에 연결되지 않은 사람은 `unavailable` 칸으로 구별된다
  // (leave/portal-approvals.ts 머리말 참조).
  return NextResponse.json(inbox, { headers: NO_STORE });
}
