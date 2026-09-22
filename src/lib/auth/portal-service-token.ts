import { jwtVerify, type JWTPayload } from "jose";

import { env } from "@/lib/env";
import { portalJwks } from "./oidc";

/**
 * ============================================================================
 * 포털이 **사람 대신** 이 시스템에 물으러 올 때의 자격 — 서명 토큰
 * ============================================================================
 * 통합 알림 종은 포털이 각 시스템에 「이 사람의 지금 알림 내놔」라고 물어 모은다
 * (dss-auth/docs/사이트-알림-통로.md). 그 통로는 **남의 알림을 볼 수 있는 문**
 * 이므로, 이 파일의 검증이 그 문의 전부다.
 *
 * 새로 설계하지 않았다 — 포털이 로그아웃을 통보할 때 쓰는 방식을 **그대로
 * 뒤집었다**(oidc.ts 의 verifyLogoutToken). 저쪽은 포털이 서명한 토큰을 우리가
 * 받아 검증하고, 이쪽도 똑같다. 다른 것은 토큰이 무엇을 요구하러 왔는가
 * (`purpose`) 하나뿐이다.
 *
 * ⚠️ A/S 시스템(RF_Service_System)의 src/lib/auth/portal-service-token.ts 와
 *    **같은 판정**이다. 같은 포털이 같은 모양으로 구운 토큰을 받는다 — 한쪽에서
 *    요구를 고치면 다른 쪽도 함께 봐야 한다(lan-address.ts 와 같은 복제 관계다).
 *
 * 확인하는 것:
 *  1. **서명** — 우리가 아는 포털의 공개키(JWKS)로만 검증된다.
 *  2. **발급자**(iss) — 우리가 아는 포털이어야 한다.
 *  3. **수신자**(aud) — 우리 client_id 여야 한다. 다른 시스템에 발급된 토큰을
 *     여기로 들이밀 수 없다.
 *  4. **만료**(exp) — 없으면 거절한다. jose 는 exp 가 아예 없으면 「만료 없음」
 *     으로 통과시킨다. 영원히 사는 토큰은 한 번 새면 영원히 새는 문이다.
 *  5. **수명** — exp − iat 가 너무 길면 거절한다(아래 상수). 짧게 굽는 것은
 *     포털의 몫이지만, 규율을 받는 쪽에서도 한 번 못 박는다.
 *  6. **nonce 가 없을 것** — 있으면 ID 토큰이다. 규격이 로그아웃 토큰에 nonce 를
 *     금지하는 것과 같은 이유로, 로그인 때 받은 ID 토큰을 여기로 재사용하지
 *     못하게 한다.
 *  7. **용도**(purpose) — 이 통로를 위해 구운 토큰인가. 6번이 막지 못하는
 *     경우(포털이 nonce 없이 ID 토큰을 굽는 설정)까지 막는 것이 이 클레임이다.
 *     알림 읽기용 토큰으로 설정을 고칠 수도 없다.
 *  8. **sub 가 있을 것** — 🔴 **누구의 알림인지는 토큰 안에서만 온다.** 쿼리
 *     문자열이나 본문으로 받으면 토큰 하나로 아무 사람의 알림이나 볼 수 있다.
 *
 * ⚠️ 한 번 쓴 토큰을 다시 쓰는 것(replay)은 막지 않는다 — 쓴 jti 를 적어 둘
 * 표가 필요하고, 이번 조각은 스키마를 건드리지 않는다. 수명이 짧고(5번),
 * 토큰이 오가는 곳이 사내망 안의 서버끼리라 지금은 수명으로 막는다. 이 통로가
 * 사내망 밖으로 나가면 다시 볼 것.
 * ============================================================================
 */

/**
 * 토큰이 무엇을 하러 왔는가. 통로마다 다른 값을 요구한다 — 알림을 읽으려고 구운
 * 토큰으로 설정을 고칠 수 없어야 한다(최소 권한).
 *
 * 🔴 포털이 이 글자를 그대로 넣어야 한다(dss-auth 의 oidc/service-token.ts 에
 * 같은 세 글자가 있다). 값을 바꾸면 양쪽을 함께 고쳐야 하고, 한쪽만 바뀌면
 * 그 통로만 조용히 401 이 된다.
 */
export const PORTAL_TOKEN_PURPOSES = {
  /** 「이 사람의 지금 알림」 읽기. */
  notificationsRead: "dss.notifications.read",
  /** 알림 설정 읽기. */
  notificationSettingsRead: "dss.notification-settings.read",
  /** 알림 설정 저장. */
  notificationSettingsWrite: "dss.notification-settings.write",
} as const;

export type PortalTokenPurpose =
  (typeof PORTAL_TOKEN_PURPOSES)[keyof typeof PORTAL_TOKEN_PURPOSES];

/**
 * 토큰 수명의 상한(초). 포털은 이보다 짧게 구워야 한다(지금 120초).
 *
 * 10분으로 둔 것은 종을 한 번 그리는 데 드는 시간보다 한참 길면서, 새어 나간
 * 토큰이 쓸모 있는 시간은 짧게 남기는 선이다. 시계 어긋남(clockTolerance)까지
 * 감안해 넉넉히 잡되, 하루짜리 토큰이 구워져 오는 일은 막는다.
 */
export const PORTAL_TOKEN_MAX_LIFETIME_SECONDS = 600;

/** 서버 둘의 시계가 조금 어긋나도 통과시킨다. ID 토큰·로그아웃 토큰과 같은 값. */
export const PORTAL_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/** 왜 거절했는가. 부르는 쪽으로는 내보내지 않는다 — 서버 로그에만 남긴다. */
export type PortalTokenRejection =
  | "missing_token"
  | "invalid_token"
  | "id_token"
  | "wrong_purpose"
  | "lifetime_too_long"
  | "no_subject";

export type PortalTokenResult =
  | {
      ok: true;
      /** 🔴 포털 쪽 사용자 id(= ID 토큰의 sub). 이 사이트의 web_users.id 가 **아니다**. */
      subject: string;
      payload: JWTPayload;
    }
  | { ok: false; reason: PortalTokenRejection };

/**
 * 검증에 쓸 열쇠. 실제로는 포털의 JWKS 이고, 시험에서는 그 자리에 직접 만든
 * 열쇠를 넣는다 — 그래야 「서명이 틀린 토큰」·「만료된 토큰」을 네트워크 없이
 * 실제로 돌려 볼 수 있다.
 */
type VerifyKey = Parameters<typeof jwtVerify>[1];

/**
 * 열쇠·발급자·수신자를 **인자로 받아** 검증한다. 판정이 전부 여기 있고, 환경을
 * 읽는 것은 아래 wrapper 하나뿐이다(sso-role.ts 를 sso-login.ts 에서 떼어 낸
 * 것과 같은 이유 — 사람을 들일지 정하는 자리에는 시험이 늘 따라붙어야 한다).
 */
export async function verifyPortalTokenWithKey(params: {
  token: string | null;
  key: VerifyKey;
  issuer: string;
  audience: string;
  purpose: PortalTokenPurpose;
}): Promise<PortalTokenResult> {
  if (params.token === null || params.token === "") {
    return { ok: false, reason: "missing_token" };
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(params.token, params.key, {
      issuer: params.issuer,
      audience: params.audience,
      clockTolerance: PORTAL_TOKEN_CLOCK_TOLERANCE_SECONDS,
      // 없으면 「검사할 것이 없다」가 되어 통과한다. 셋 다 반드시 있어야 한다.
      requiredClaims: ["exp", "iat", "sub"],
    }));
  } catch (error) {
    console.error("[portal-token] 토큰 검증 실패:", error);
    return { ok: false, reason: "invalid_token" };
  }

  // jwtVerify 는 서명·iss·aud·exp 까지만 본다. 아래는 우리가 따로 요구한다.

  if (payload.nonce !== undefined) {
    console.error("[portal-token] nonce 가 있는 토큰입니다(ID 토큰일 수 있음).");
    return { ok: false, reason: "id_token" };
  }

  if (payload.purpose !== params.purpose) {
    console.error("[portal-token] 이 통로의 토큰이 아닙니다.");
    return { ok: false, reason: "wrong_purpose" };
  }

  // requiredClaims 가 둘 다 있음을 보장하므로 숫자로 읽을 수 있다.
  const lifetime = Number(payload.exp) - Number(payload.iat);
  if (!Number.isFinite(lifetime) || lifetime > PORTAL_TOKEN_MAX_LIFETIME_SECONDS) {
    console.error("[portal-token] 토큰 수명이 너무 깁니다.");
    return { ok: false, reason: "lifetime_too_long" };
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    console.error("[portal-token] sub 가 없습니다.");
    return { ok: false, reason: "no_subject" };
  }

  return { ok: true, subject: payload.sub, payload };
}

/**
 * 실제 요청이 쓰는 입구 — 환경에서 발급자·수신자를 읽어 위 판정에 넘긴다.
 *
 * 🔴 열쇠는 ID 토큰·로그아웃 토큰과 **같은 JWKS 한 벌**이다(oidc.ts 의
 * portalJwks). 요청마다 새로 만들면 포털을 두드리게 되고 jose 의 캐시·키 교체
 * 처리가 무의미해진다 — 두 벌로 나누면 캐시도 두 벌이 된다.
 */
export async function verifyPortalServiceToken(
  token: string | null,
  purpose: PortalTokenPurpose,
): Promise<PortalTokenResult> {
  return verifyPortalTokenWithKey({
    token,
    key: portalJwks(),
    issuer: env.ssoIssuer,
    audience: env.ssoClientId,
    purpose,
  });
}

/**
 * `Authorization: Bearer <토큰>` 에서 토큰만 꺼낸다. 머리말이 없거나 모양이
 * 다르면 null — 부르는 쪽에는 「토큰 없음」과 같은 답을 준다.
 *
 * 토큰을 쿼리 문자열이 아니라 머리말로 받는 이유: 쿼리는 서버 접근 로그와
 * 브라우저 히스토리에 그대로 남는다.
 */
export function readBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorizationHeader);
  return match ? match[1] : null;
}
