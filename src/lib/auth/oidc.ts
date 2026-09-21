/**
 * DSS 통합 로그인 포털(dss-auth)과 이야기하는 유일한 파일.
 *
 * OIDC 를 여기에만 가둔다 — 화면·서버 액션·라우트 어디에서도 포털의 주소나
 * 토큰 형식을 알지 못하게 한다. 나중에 포털이 바뀌어도 고칠 곳은 여기다.
 *
 * 이 사이트는 자체 로그인을 만들지 않는다. 포털이 신원을 확인하고, 여기서는
 * 그 결과(ID 토큰)를 검증해 자기 세션(leave_session)을 발급할 뿐이다.
 *
 * ⚠️ 이 파일의 절차는 A/S 시스템(RF_Service_System) · 계측기 시스템(njlee) ·
 *    개선요청(dss-improvements) · PO/내자(dss-po)의 것과 **같다.** 모두 같은
 *    포털에 붙고 같은 함정을 이미 밟았다. 한쪽에서 프로토콜 쪽을 고치면
 *    나머지도 함께 봐야 한다.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

import { env } from "@/lib/env";

/* ------------------------------------------------------------------ */
/* 로그인 왕복 동안 들고 있어야 하는 값                                  */
/* ------------------------------------------------------------------ */

/**
 * 포털의 dss_sso 와도, 이 사이트의 leave_session 과도 겹치지 않는 이름.
 * 겹치면 안 되는 까닭은 auth/cookie-names.ts 에 적혀 있다.
 */
export { SSO_TX_COOKIE } from "./cookie-names";

/**
 * 이 쿠키는 로그인 왕복에서만 쓰인다. 경로를 좁혀 두면 나머지 요청에
 * 딸려 나가지 않는다.
 */
export const SSO_TX_COOKIE_PATH = "/api/auth/sso";

/**
 * 10분. 카카오 동의 화면에서 잠시 망설일 만큼은 되고, 중간에 그만둔 시도가
 * 오래 살아 있지는 않을 만큼 짧다.
 */
export const SSO_TX_MAX_AGE_SECONDS = 600;

export type SsoTransaction = {
  /** 남의 로그인 응답이 이 브라우저에 떨어지는 것을 막는다. */
  state: string;
  /** 예전 ID 토큰을 다시 들이미는 것을 막는다. */
  nonce: string;
  /** PKCE. 이 값은 이 서버 밖으로 나가지 않으므로 인가 코드만으로는 쓸모가 없다. */
  codeVerifier: string;
  /** 로그인 후 돌아갈 이 사이트 안의 경로. */
  returnTo: string;
  /** 유닉스 초. 쿠키의 Max-Age 는 브라우저의 호의일 뿐이라 값으로도 확인한다. */
  expiresAt: number;
};

/* ------------------------------------------------------------------ */
/* 왕복 쿠키 서명                                                       */
/*                                                                     */
/* 서명이 곧 PKCE 다 — 서명이 없으면 브라우저가 code_verifier 를 제 손으로 */
/* 바꿔 끼울 수 있어 PKCE 가 무의미해진다.                               */
/* ------------------------------------------------------------------ */

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function sealTransaction(tx: SsoTransaction): string {
  const payload = Buffer.from(JSON.stringify(tx), "utf8").toString("base64url");
  return `${payload}.${sign(payload, env.ssoTxSecret)}`;
}

/** 서명이 맞고 만료되지 않았을 때만 값을 돌려준다. 아니면 null. */
export function openTransaction(raw: string | undefined): SsoTransaction | null {
  if (!raw) return null;

  const dot = raw.indexOf(".");
  if (dot <= 0) return null;

  const payload = raw.slice(0, dot);
  const presented = raw.slice(dot + 1);
  const expected = sign(payload, env.ssoTxSecret);

  // 문자열 비교는 앞에서부터 다른 지점까지의 시간이 달라, 서명을 한 글자씩
  // 알아내는 공격이 이론상 가능하다. 길이가 다르면 timingSafeEqual 이 던지므로
  // 먼저 본다.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const tx = parsed as Record<string, unknown>;
  if (
    typeof tx.state !== "string" ||
    typeof tx.nonce !== "string" ||
    typeof tx.codeVerifier !== "string" ||
    typeof tx.returnTo !== "string" ||
    typeof tx.expiresAt !== "number"
  ) {
    return null;
  }

  if (tx.expiresAt <= Math.floor(Date.now() / 1000)) return null;

  return tx as SsoTransaction;
}

/* ------------------------------------------------------------------ */
/* 1단계 — 포털로 보낸다                                                */
/* ------------------------------------------------------------------ */

/**
 * 세 값을 새로 만든다. 각각 다른 구멍을 막는다.
 *   state         로그인 CSRF (남의 로그인 응답이 내 브라우저에 떨어지는 것)
 *   nonce         ID 토큰 재사용 (예전 토큰을 다시 들이미는 것)
 *   codeVerifier  인가 코드 가로채기 (코드만으로는 토큰을 못 받게)
 */
export function beginLogin(returnTo: string): {
  authorizeUrl: string;
  transaction: SsoTransaction;
} {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  // 64바이트 → base64url 86자. RFC 7636 이 정한 43~128자 안이다.
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier, "ascii")
    .digest("base64url");

  const url = new URL(`${env.ssoIssuer}/api/oidc/authorize`);
  url.search = new URLSearchParams({
    client_id: env.ssoClientId,
    redirect_uri: env.ssoRedirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  return {
    authorizeUrl: url.href,
    transaction: {
      state,
      nonce,
      codeVerifier,
      returnTo,
      expiresAt: Math.floor(Date.now() / 1000) + SSO_TX_MAX_AGE_SECONDS,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2단계 — 인가 코드를 ID 토큰으로 바꾼다 (서버 대 서버)                 */
/* ------------------------------------------------------------------ */

/** 실패는 전부 null 이다. 이유는 서버 로그에만 남긴다. */
export async function exchangeCodeForIdToken(
  code: string,
  codeVerifier: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${env.ssoIssuer}/api/oidc/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        // /authorize 에 보낸 값과 문자 단위로 같아야 한다.
        redirect_uri: env.ssoRedirectUri,
        code_verifier: codeVerifier,
        client_id: env.ssoClientId,
        client_secret: env.ssoClientSecret,
      }),
      cache: "no-store",
    });
  } catch (error) {
    console.error("[sso] 포털에 연결할 수 없습니다:", error);
    return null;
  }

  if (!response.ok) {
    // 포털의 오류 본문은 내부 설정을 설명할 수 있다. 화면에는 내보내지 않는다.
    console.error("[sso] 토큰 교환 거절:", response.status);
    return null;
  }

  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") {
    console.error("[sso] 응답에 id_token 이 없습니다.");
    return null;
  }
  return body.id_token;
}

/* ------------------------------------------------------------------ */
/* 3단계 — ID 토큰을 검증한다                                           */
/* ------------------------------------------------------------------ */

/**
 * 한 번 만들어 재사용한다 — jose 가 JWKS 캐시·키 교체·재조회 간격을 알아서
 * 처리한다. 요청마다 만들면 포털을 두드리게 되고 그 캐시가 무의미해진다.
 *
 * 지연 생성인 이유: 이 파일을 불러오는 것만으로 SSO_ISSUER 를 요구하면
 * next build 가 환경변수 없이 돌지 못한다(도커 이미지에는 .env 가 없다).
 */
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks() {
  jwksCache ??= createRemoteJWKSet(new URL(`${env.ssoIssuer}/.well-known/jwks.json`));
  return jwksCache;
}

export type SsoIdentity = {
  /** 포털의 users.id. 이 사이트가 사람을 잇는 유일한 열쇠다. */
  subject: string;
  /** 화면 표시용. 없을 수 있다. */
  name: string | null;
  /** 카카오에서 이메일은 선택 동의라 없을 수 있다. */
  email: string | null;
  /**
   * 이 시스템에서의 역할. 포털이 지정하지 않았으면 아예 실리지 않는다.
   * "안 왔다" 와 "이상한 값이 왔다" 는 다르게 다뤄야 하므로 unknown 으로 둔다 —
   * 무엇인지 정하는 곳은 sso-role.ts 의 decideRole 한 곳뿐이다.
   */
  role: unknown;
};

export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<SsoIdentity | null> {
  try {
    const { payload } = await jwtVerify(idToken, jwks(), {
      issuer: env.ssoIssuer,
      audience: env.ssoClientId,
      // 이 PC 와 포털의 시계 차이 몇 초를 흡수한다. 그 이상은 맞춰야 할
      // 시계지 감싸 줄 일이 아니다.
      clockTolerance: 30,
    });

    // 🔴 jwtVerify 는 서명·iss·aud·exp 까지만 본다. nonce 는 따로 봐야 한다.
    // 건너뛰면 예전 ID 토큰을 다시 들이미는 길이 열린 채로 남는다.
    if (payload.nonce !== expectedNonce) {
      console.error("[sso] nonce 가 일치하지 않습니다.");
      return null;
    }
    if (typeof payload.sub !== "string" || payload.sub === "") {
      console.error("[sso] id_token 에 sub 가 없습니다.");
      return null;
    }

    return {
      subject: payload.sub,
      name: typeof payload.name === "string" ? payload.name : null,
      email: typeof payload.email === "string" ? payload.email : null,
      role: payload.role,
    };
  } catch (error) {
    console.error("[sso] id_token 검증 실패:", error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 백채널 로그아웃 — 포털이 "이 사람 세션 끊어라" 라고 알려 온다          */
/* ------------------------------------------------------------------ */

/** 규격이 정한 표시. 이것이 없으면 로그아웃 통보가 아니다. */
const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/**
 * 서명이 확인된 로그아웃 토큰의 **내용**만 본다. 누구를 끊으라는 것인지
 * 돌려주고, 로그아웃 토큰이 아니면 null.
 *
 * 서명 검증에서 떼어 낸 이유는 하나다: 이 판정은 포털도 네트워크도 없이
 * 시험할 수 있어야 한다(`npm run test:auth`). 서명은 jwtVerify 가 보고,
 * jwtVerify 가 **보지 않는** 것을 여기가 본다.
 */
export function readLogoutClaims(payload: Record<string, unknown>): string | null {
  // 🔴 nonce 가 있으면 ID 토큰이다. 규격이 로그아웃 토큰에 nonce 를 금지하는
  // 이유가 이것이다 — ID 토큰을 여기로 들이밀어 남을 로그아웃시키지 못하게 한다.
  if (payload.nonce !== undefined) {
    console.error("[sso] nonce 가 있는 토큰입니다(ID 토큰일 수 있음).");
    return null;
  }

  const events = payload.events;
  if (
    typeof events !== "object" ||
    events === null ||
    !(LOGOUT_EVENT in (events as Record<string, unknown>))
  ) {
    console.error("[sso] 로그아웃 이벤트 표시가 없습니다.");
    return null;
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    console.error("[sso] 로그아웃 토큰에 sub 가 없습니다.");
    return null;
  }
  return payload.sub;
}

/**
 * 이 창구는 인증 없이 누구나 두드릴 수 있다. 그래서 서명 검증이 전부다 —
 * 건너뛰면 아무나 아무 사람이나 로그아웃시킬 수 있는 창구가 된다.
 */
export async function verifyLogoutToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, jwks(), {
      issuer: env.ssoIssuer,
      audience: env.ssoClientId,
      clockTolerance: 30,
    });
    return readLogoutClaims(payload as Record<string, unknown>);
  } catch (error) {
    console.error("[sso] 로그아웃 토큰 검증 실패:", error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 로그아웃 — 포털 세션까지 끝낸다                                       */
/* ------------------------------------------------------------------ */

/**
 * 🔴 이 사이트 쿠키만 지우면 포털 세션은 그대로 살아 있다. 그러면 로그아웃한
 * 사람이 로그인 버튼을 한 번 누르는 것만으로, 누구인지 다시 묻지도 않고
 * 그대로 들어온다. 공용 PC 에서는 그것이 곧 로그아웃이 안 된 것이다.
 *
 * post_logout_redirect_uri 를 일부러 붙이지 않는다 — 붙이면 이 사이트의
 * 로그인 화면으로 돌아오는데, 그 화면은 "포털로 가세요" 한 장을 더 거치게
 * 할 뿐이다. 방금 모든 시스템에서 나간 사람이 있어야 할 곳은 포털이다.
 * (포털은 이 값을 지원한다 — 나중에 생각이 바뀌면 등록만 하면 된다.)
 */
export function endSessionUrl(): string {
  return `${env.ssoIssuer}/api/oidc/logout`;
}
