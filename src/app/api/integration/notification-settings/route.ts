import { NextResponse, type NextRequest } from "next/server";

import { findPortalActor } from "@/lib/auth/portal-actor";
import {
  PORTAL_TOKEN_PURPOSES,
  readBearerToken,
  verifyPortalServiceToken,
  type PortalTokenPurpose,
  type PortalTokenResult,
} from "@/lib/auth/portal-service-token";
import { env } from "@/lib/env";
import {
  SETTINGS_READ_ONLY_MESSAGE,
  readPortalNotificationSettings,
} from "@/lib/leave/portal-notifications";

/**
 * ============================================================================
 * 알림 설정을 밖에서 읽고 쓰는 통로
 * ============================================================================
 * 설계 결정(dss-auth 설계서 D-5): **화면만 포털로 옮기고 자료는 각 시스템이
 * 계속 갖는다.** 알림 종류도 역할도 그 시스템 고유의 것이라, 포털이 그것을
 * 가지면 시스템이 늘 때마다 포털을 고쳐 배포해야 한다.
 *
 * 🔴 **이 시스템에는 설정 표가 없다.** 끌 수 있는 것이 없기 때문이다 — 까닭은
 * lib/leave/portal-notifications.ts 의 「알림 설정 통로」 절에 적어 두었다.
 * 그래서 GET 은 **고정된 기본값**을 내주고(역할은 전부 잠김), PUT 은 **언제나
 * 거절한다.** 통로 자체는 열어 둔다 — 404 면 포털이 「지금 볼 수 없다」로
 * 그리는데 그것은 고장과 구별되지 않는다.
 *
 * 모양은 A/S 의 같은 통로와 글자 하나까지 같다. 포털이 그 모양을 그대로
 * 그린다(dss-auth 의 notifications/settings.ts 의 parseSettingsPayload).
 * ============================================================================
 */

const NO_STORE = { "cache-control": "no-store" };

function notEnabled() {
  return NextResponse.json({ error: "not_enabled" }, { status: 404, headers: NO_STORE });
}

function invalidToken() {
  return NextResponse.json(
    { error: "invalid_token" },
    { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
  );
}

/** 두 메서드가 같은 순서로 같은 것을 확인한다 — 한쪽만 느슨해지지 않게 묶어 둔다. */
async function authenticate(
  request: NextRequest,
  purpose: PortalTokenPurpose,
): Promise<PortalTokenResult> {
  return verifyPortalServiceToken(
    readBearerToken(request.headers.get("authorization")),
    purpose,
  );
}

export async function GET(request: NextRequest) {
  if (!env.ssoConfigured) return notEnabled();

  const verified = await authenticate(request, PORTAL_TOKEN_PURPOSES.notificationSettingsRead);
  if (!verified.ok) return invalidToken();

  const result = await readPortalNotificationSettings({
    subject: verified.subject,
    findActor: findPortalActor,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: "forbidden", message: result.message },
      { status: result.status, headers: NO_STORE },
    );
  }
  return NextResponse.json(result.value, { headers: NO_STORE });
}

/**
 * 🔴 **언제나 거절한다.**
 *
 * 본문을 읽지도 않는다 — 무엇을 보냈든 답이 같기 때문이다. 모양을 먼저 보고
 * 400 으로 답하면 「모양만 맞추면 저장된다」는 잘못된 신호가 된다.
 *
 * 403 인 것은 포털이 그것을 **사람에게 보여 줄 답**으로 다루기 때문이다
 * (gather.ts 의 pushNotificationSettings: 403 이면 message 를 그대로 띄운다).
 * 정상 사용에서는 여기까지 오지 않는다 — 포털 관리자 화면은 잠긴 역할을 아예
 * 폼에 싣지 않는다.
 */
export async function PUT(request: NextRequest) {
  if (!env.ssoConfigured) return notEnabled();

  const verified = await authenticate(request, PORTAL_TOKEN_PURPOSES.notificationSettingsWrite);
  if (!verified.ok) return invalidToken();

  return NextResponse.json(
    { error: "forbidden", message: SETTINGS_READ_ONLY_MESSAGE },
    { status: 403, headers: NO_STORE },
  );
}
