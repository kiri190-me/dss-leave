/**
 * 로그인 왕복의 시작. 포털(dss-auth)로 사람을 보낸다.
 *
 *   GET /api/auth/sso/start?returnTo=/어디로
 *
 * 여기서 만든 state·nonce·code_verifier 를 서명한 쿠키에 담아 두었다가
 * 돌아왔을 때 대조한다. 무엇이 무엇을 막는지는 lib/auth/oidc.ts 에 적혀 있다.
 */
import { cookies } from "next/headers";

import { safeReturnTo } from "@/lib/auth/guards";
import {
  beginLogin,
  sealTransaction,
  SSO_TX_COOKIE,
  SSO_TX_COOKIE_PATH,
  SSO_TX_MAX_AGE_SECONDS,
} from "@/lib/auth/oidc";
import { clearServiceMenuCookie } from "@/lib/auth/service-menu-cookie";
import { getSessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";

function redirectTo(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "cache-control": "no-store" },
  });
}

export async function GET(request: Request) {
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));

  // 포털에 아직 등록하기 전이면 여기서 던지는 대신 로그인 화면으로 돌려보낸다.
  // 그 화면에 임시 로그인 뒷문이 있다.
  if (!env.ssoConfigured) {
    console.error("[sso] SSO_* 환경변수가 설정되지 않았습니다.");
    return redirectTo("/login?error=not_configured");
  }

  // 이미 들어와 있는 사람을 포털까지 다녀오게 할 이유가 없다.
  if (await getSessionUser()) {
    return redirectTo(returnTo);
  }

  // 🔴 여기서부터는 **새 사람의 로그인**이다. 앞사람이 남긴 서비스 메뉴 목록을
  // 지운다 — 안 지우면 공용 PC 에서 앞사람의 시스템 목록이 뒷사람 화면 머리말
  // 위에 그대로 뜬다. 위의 "이미 들어와 있는 사람" 은 이 줄에 닿지 않는다 —
  // 그 사람 것은 지울 이유가 없다.
  await clearServiceMenuCookie();

  const { authorizeUrl, transaction } = beginLogin(returnTo);

  (await cookies()).set(SSO_TX_COOKIE, sealTransaction(transaction), {
    httpOnly: true,
    sameSite: "lax",
    // 사내망 HTTP 단계에서 켜면 쿠키가 저장되지 않아 로그인이 조용히 실패한다.
    secure: env.sessionCookieSecure,
    path: SSO_TX_COOKIE_PATH,
    maxAge: SSO_TX_MAX_AGE_SECONDS,
  });

  return redirectTo(authorizeUrl);
}
