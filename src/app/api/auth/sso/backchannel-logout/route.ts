/**
 * 포털이 "이 사람 세션 끊어라" 라고 알려 오는 곳
 * (OIDC Back-Channel Logout 1.0).
 *
 * 한 곳에서 나가면 어디서든 나가야 한다. 포털에서 로그아웃했는데 이 화면이
 * 계속 열려 있으면, 공용 PC 에서는 그것이 곧 로그아웃이 안 된 것이다.
 *
 * ⚠️ 이 창구는 **인증 없이 누구나 두드릴 수 있다.** 서명 검증(verifyLogoutToken)이
 * 이 파일의 전부다 — 건너뛰면 아무나 아무 사람이나 로그아웃시킬 수 있는
 * 창구가 된다. 일하는 사람을 계속 튕겨내는 것만으로도 충분히 성가신 공격이다.
 *
 * 🔴 이 시스템은 세션이 **서버 저장형**(web_sessions)이라, 끊는 일이 그 사람의
 * 세션 행에 revoked_at 을 적는 것으로 끝난다. getSessionUser 가 이미 revoked_at
 * 이 비어 있는 행만 보므로 다음 요청부터 곧바로 막힌다. 서명 토큰을 쓰는 이웃
 * 시스템들이 이 자리에서 기준선 칸(sessions_valid_from)을 새로 만들어야 했던
 * 것과 다르다 — 여기서는 **스키마를 건드리지 않는다.**
 *
 * 포털은 이 주소를 **등록해야** 부른다(clients.backchannel_logout_uri).
 * 등록하지 않으면 이 파일은 그냥 조용히 놀고, 로그아웃은 각자 만료될 때까지
 * 살아 있다. 등록할 값은 README 의 「포털에 등록할 값」 표에 있다.
 */
import { verifyLogoutToken } from "@/lib/auth/oidc";
import { revokeSessionsForSubject } from "@/lib/auth/session";

/**
 * 규격이 요구하는 응답 헤더. 이 응답이 캐시되면 다음 통보가 서버에 닿지 않고
 * 캐시로 처리될 수 있다.
 */
const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request) {
  let token: string | null = null;
  try {
    const form = await request.formData();
    const value = form.get("logout_token");
    if (typeof value === "string") token = value;
  } catch {
    // 폼이 아니면 규격을 따르지 않는 요청이다.
  }

  if (!token) {
    return Response.json(
      { error: "invalid_request" },
      { status: 400, headers: NO_STORE },
    );
  }

  // 서명·iss·aud·exp 를 보고, jwtVerify 가 보지 않는 것(🔴 nonce 가 있으면
  // ID 토큰이다 → 거절 · 로그아웃 이벤트 표시 · sub)까지 본다.
  const subject = await verifyLogoutToken(token);
  if (!subject) {
    return Response.json(
      { error: "invalid_request" },
      { status: 400, headers: NO_STORE },
    );
  }

  // sid 가 아니라 sub 단위로 끊는다. 공용 PC 에서 나간 사람에게는 그편이
  // 기대에 맞고, 정지된 사람에게는 반드시 그래야 한다.
  const revoked = await revokeSessionsForSubject(subject);

  // 서비스 메뉴바 목록을 나르는 쿠키(leave_service_menu)는 여기서 지울 자리가
  // 없다 — 이 통로에는 그 사람의 브라우저가 없다(포털의 서버가 두드린다).
  // 그래도 새는 곳은 아니다: 메뉴바는 세션이 있어야 들어가는 구간에서만
  // 그려지는데, 바로 위 한 줄이 그 세션을 끊었다. 쿠키는 다음 로그인이
  // 시작되는 자리에서 지워진다(api/auth/sso/start/route.ts).

  if (revoked) {
    console.info(`[sso] 세션을 끊었습니다: ${subject}`);
  } else {
    // 🔴 이 사이트에 아직 들어온 적 없는 사람일 수 있다 — 오류가 아니다.
    // 규격도 이 경우 성공으로 답하라고 한다(끊을 것이 없는 것도 끊긴 것이다).
    console.info(`[sso] 끊을 세션이 없습니다: ${subject}`);
  }

  return new Response(null, { status: 204, headers: NO_STORE });
}
