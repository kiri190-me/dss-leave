/**
 * 로그인 판정 검사.  npm run test:auth
 *
 * 🔴 DB 에도 네트워크에도 닿지 않는다. 여기서 보는 것은 전부 순수 함수다 —
 * 사람을 들일지 말지를 정하는 자리라 포털 없이도 늘 돌릴 수 있어야 한다.
 * (DB 가 필요한 흐름 검사는 test:workflow 가 맡는다)
 *
 * 무엇을 지키는가
 *   1. 돌아갈 주소   열린 전달(open redirect) — 우리 도메인이 피싱 미끼가 되는 것
 *   2. 역할 클레임   없으면 유지 / 모르는 값이면 거절
 *   3. sub 모양      uuid 가 아니면 계정을 만들기 전에 거절
 *   4. 로그아웃 토큰 nonce 가 있으면 거절 (ID 토큰을 들이미는 길을 막는다)
 *   5. 왕복 쿠키     서명이 곧 PKCE 다 — 한 글자만 바뀌어도 열리지 않아야 한다
 */
import assert from "node:assert/strict";

// 🔴 .env.local 을 읽지 않는다. 이 검사는 이 파일에 적힌 값으로만 돈다.
//    (auto 로 두면 Wi-Fi 상태에 따라 결과가 달라진다 — 검사가 그러면 안 된다)
process.env.SSO_ISSUER = "http://192.168.1.10:3100/";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";

import {
  RETURN_TO_FALLBACK,
  RETURN_TO_MAX_LENGTH,
  safeReturnTo,
} from "../src/lib/auth/return-to";
import { decideRole, isValidSubject } from "../src/lib/auth/sso-role";
import {
  beginLogin,
  openTransaction,
  readLogoutClaims,
  sealTransaction,
} from "../src/lib/auth/oidc";
import {
  SERVICE_MENU_COOKIE,
  SESSION_COOKIE,
  SSO_TX_COOKIE,
} from "../src/lib/auth/cookie-names";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** 거절 경로는 일부러 console.error 를 찍는다. 검사 출력이 그것에 묻히지 않게 한다. */
function quiet<T>(fn: () => T): T {
  const error = console.error;
  const warn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

/** 글자로 적으면 도구를 거치며 한 겹이 사라진다. 코드로 만든다. */
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const RETURN = String.fromCharCode(13);
const BACKSLASH = String.fromCharCode(0x5c);
const NUL = String.fromCharCode(0);

/* ------------------------------------------------------------------ */
/* 1. 돌아갈 주소                                                       */
/* ------------------------------------------------------------------ */

const F = RETURN_TO_FALLBACK;

check("🔴 다른 사이트를 가리키는 값은 전부 첫 화면으로 떨군다", () => {
  assert.equal(safeReturnTo("//evil.example"), F);
  assert.equal(safeReturnTo("//evil.example/leave"), F);
  assert.equal(safeReturnTo("https://evil.example"), F);
  assert.equal(safeReturnTo("http://evil.example/leave"), F);
  assert.equal(safeReturnTo("javascript:alert(1)"), F);
  assert.equal(safeReturnTo("JavaScript:alert(1)"), F);
  assert.equal(safeReturnTo("data:text/html,<script>"), F);
  assert.equal(safeReturnTo("leave"), F); // 상대경로 — '/' 로 시작하지 않는다
});

check("🔴 제어문자가 섞인 값은 거절한다 — 브라우저가 조용히 지우면 '//' 가 된다", () => {
  // "/(탭)/evil.example" 은 탭을 지우고 나면 "//evil.example" 이다.
  assert.equal(safeReturnTo("/" + TAB + "/evil.example"), F);
  assert.equal(safeReturnTo("/" + NEWLINE + "/evil.example"), F);
  assert.equal(safeReturnTo("/" + RETURN + "/evil.example"), F);
  assert.equal(safeReturnTo("/" + NUL + "/evil.example"), F);
  // 뒤쪽에 섞여 있어도 마찬가지다.
  assert.equal(safeReturnTo("/leave" + NEWLINE + "X"), F);
});

check("🔴 한 겹 풀면 다른 사이트가 되는 값도 거절한다", () => {
  assert.equal(safeReturnTo("/%2F%2Fevil.example"), F);
  assert.equal(safeReturnTo("/%2f%2fevil.example"), F);
  assert.equal(safeReturnTo("/%09/evil.example"), F); // 탭
  assert.equal(safeReturnTo("/%0A/evil.example"), F); // 줄바꿈
  assert.equal(safeReturnTo("%2F%2Fevil.example"), F);
  assert.equal(safeReturnTo("/%zz"), F); // 반쪽짜리 이스케이프 — 무엇이 될지 모른다
});

check("🔴 역슬래시가 든 값은 거절한다 — 브라우저가 '/' 처럼 다루는 경우가 있다", () => {
  assert.equal(safeReturnTo(BACKSLASH + BACKSLASH + "evil.example"), F);
  assert.equal(safeReturnTo("/" + BACKSLASH + "evil.example"), F);
  assert.equal(safeReturnTo("/leave" + BACKSLASH + "x"), F);
  assert.equal(safeReturnTo("/%5C%5Cevil.example"), F);
});

check("🔴 로그인 통로 자신을 가리키는 값은 거절한다 — 무한 되돌기가 된다", () => {
  assert.equal(safeReturnTo("/api/auth/sso/start"), F);
  assert.equal(safeReturnTo("/api/auth/sso/start?returnTo=/leave"), F);
  assert.equal(safeReturnTo("/api/auth/sso/callback"), F);
  assert.equal(safeReturnTo("/api/auth/sso/backchannel-logout"), F);
  assert.equal(safeReturnTo("/API/Auth/SSO/start"), F); // 글자 모양에 기대지 않는다
  assert.equal(safeReturnTo("/api/auth"), F);
});

check("값이 없으면 첫 화면이다", () => {
  assert.equal(safeReturnTo(null), F);
  assert.equal(safeReturnTo(undefined), F);
  assert.equal(safeReturnTo(""), F);
  // 화면에서 넘어오는 값은 string 이 아닐 수도 있다 (searchParams 는 배열을 준다)
  assert.equal(safeReturnTo(["/leave"] as unknown as string), F);
});

check("이 사이트 안의 주소는 그대로 살아 돌아온다", () => {
  assert.equal(safeReturnTo("/"), "/");
  assert.equal(safeReturnTo("/leave"), "/leave");
  assert.equal(safeReturnTo("/leave/new"), "/leave/new");
  assert.equal(safeReturnTo("/approvals?year=2026"), "/approvals?year=2026");
  assert.equal(safeReturnTo("/leave/print?year=2026#top"), "/leave/print?year=2026#top");
});

check("🔴 한글이 든 주소는 머리말에 실을 수 있는 모습으로 정규화된다 (500 방지)", () => {
  const canonical = safeReturnTo("/approvals?q=결재");
  assert.equal(canonical, "/approvals?q=%EA%B2%B0%EC%9E%AC");

  // 응답 머리말은 ByteString(0~255)이다. 이 값이 실릴 수 있어야 한다.
  for (const character of canonical) {
    const code = character.codePointAt(0) ?? 0;
    assert.ok(code >= 0x21 && code <= 0x7e, `머리말에 실을 수 없는 글자: ${character}`);
  }
  // 실제로 Response 를 만들어 본다 — 예전에 여기서 TypeError 가 났다.
  const response = new Response(null, { status: 303, headers: { Location: canonical } });
  assert.equal(response.headers.get("Location"), canonical);

  // 주소창과 화면의 searchParams 에서는 원래 글자 그대로다.
  assert.equal(new URL(canonical, "http://x").searchParams.get("q"), "결재");
});

check("한 번 더 거쳐도 같은 값이다 — 통로를 오가며 겹겹이 인코딩되지 않는다", () => {
  for (const value of ["/leave", "/approvals?q=결재", "/leave/print?year=2026#top"]) {
    const once = safeReturnTo(value);
    assert.equal(safeReturnTo(once), once);
  }
});

check("🔴 길이 상한을 넘으면 거절한다 — leave_sso_tx 쿠키가 통째로 싣고 다닌다", () => {
  const justFits = "/" + "a".repeat(RETURN_TO_MAX_LENGTH - 1);
  assert.equal(justFits.length, RETURN_TO_MAX_LENGTH);
  assert.equal(safeReturnTo(justFits), justFits);
  assert.equal(safeReturnTo(justFits + "a"), F);

  // 정규화한 뒤의 길이로 본다. 한글은 한 글자가 9자로 부푼다.
  const korean = "/" + "결".repeat(80); // 날것 81자 → 정규화하면 721자
  assert.equal(safeReturnTo(korean), F);
});

check("🔴 상한 길이의 주소를 담아도 leave_sso_tx 쿠키가 브라우저 한도(4096) 안이다", () => {
  const longest = "/" + "a".repeat(RETURN_TO_MAX_LENGTH - 1);
  const { transaction } = beginLogin(safeReturnTo(longest));
  const cookieValue = sealTransaction(transaction);
  const wholeCookie = `${SSO_TX_COOKIE}=${cookieValue}; Path=/api/auth/sso; Max-Age=600; HttpOnly; SameSite=Lax`;
  assert.ok(
    wholeCookie.length < 4096,
    `쿠키가 너무 크다: ${wholeCookie.length}바이트`,
  );
});

/* ------------------------------------------------------------------ */
/* 2. 역할 클레임                                                       */
/* ------------------------------------------------------------------ */

check("🔴 role 클레임이 없으면 유지(KEEP) — 없다고 거절하면 아무도 못 들어온다", () => {
  assert.deepEqual(decideRole(undefined), { kind: "KEEP" });
  assert.deepEqual(decideRole(null), { kind: "KEEP" });
});

check("이 시스템이 아는 역할은 그대로 적용(APPLY)한다", () => {
  assert.deepEqual(decideRole("MEMBER"), { kind: "APPLY", role: "MEMBER" });
  assert.deepEqual(decideRole("LEAVE_ADMIN"), { kind: "APPLY", role: "LEAVE_ADMIN" });
});

check("🔴 모르는 역할 값이면 거절(REJECT) — 안전한 쪽으로 실패하기 위해서다", () => {
  quiet(() => {
    // 개선요청·A/S 의 값이다. 이 시스템은 MEMBER · LEAVE_ADMIN 둘뿐이다.
    assert.deepEqual(decideRole("ADMIN"), { kind: "REJECT" });
    assert.deepEqual(decideRole("SUPER_ADMIN"), { kind: "REJECT" });
    assert.deepEqual(decideRole("member"), { kind: "REJECT" }); // 대소문자가 다르다
    assert.deepEqual(decideRole("LEAVE_ADMlN"), { kind: "REJECT" }); // 오타
    assert.deepEqual(decideRole(""), { kind: "REJECT" });
    assert.deepEqual(decideRole(123), { kind: "REJECT" });
    assert.deepEqual(decideRole(["LEAVE_ADMIN"]), { kind: "REJECT" });
    assert.deepEqual(decideRole({ role: "LEAVE_ADMIN" }), { kind: "REJECT" });
  });
});

/* ------------------------------------------------------------------ */
/* 3. sub 모양                                                          */
/* ------------------------------------------------------------------ */

check("🔴 sub 가 uuid 형식이 아니면 거절 — auth_sub 가 uuid 열이라 insert 가 터진다", () => {
  assert.equal(isValidSubject("3f7b2c1a-4d5e-4f60-8a91-0b2c3d4e5f60"), true);
  assert.equal(isValidSubject("3F7B2C1A-4D5E-4F60-8A91-0B2C3D4E5F60"), true);

  assert.equal(isValidSubject("not-a-uuid"), false);
  assert.equal(isValidSubject("12345"), false);
  assert.equal(isValidSubject(""), false);
  assert.equal(isValidSubject("3f7b2c1a4d5e4f608a910b2c3d4e5f60"), false); // 하이픈 없음
  assert.equal(isValidSubject("3f7b2c1a-4d5e-4f60-8a91-0b2c3d4e5f6g"), false); // g 는 16진수가 아니다
  assert.equal(isValidSubject("3f7b2c1a-4d5e-4f60-8a91-0b2c3d4e5f60 "), false);
  assert.equal(isValidSubject("'; drop table web_users; --"), false);
  assert.equal(isValidSubject(undefined), false);
  assert.equal(isValidSubject(12345), false);
});

/* ------------------------------------------------------------------ */
/* 4. 로그아웃 토큰                                                     */
/* ------------------------------------------------------------------ */

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const SUBJECT = "3f7b2c1a-4d5e-4f60-8a91-0b2c3d4e5f60";
const logoutPayload = () => ({ sub: SUBJECT, events: { [LOGOUT_EVENT]: {} } });

check("올바른 로그아웃 토큰이면 끊을 사람을 돌려준다", () => {
  assert.equal(readLogoutClaims(logoutPayload()), SUBJECT);
});

check("🔴 로그아웃 토큰에 nonce 가 있으면 거절 — ID 토큰을 들이미는 길을 막는다", () => {
  quiet(() => {
    assert.equal(readLogoutClaims({ ...logoutPayload(), nonce: "abc" }), null);
    // 빈 문자열도 "있는" 것이다. undefined 가 아닌 모든 값을 거절한다.
    assert.equal(readLogoutClaims({ ...logoutPayload(), nonce: "" }), null);
    assert.equal(readLogoutClaims({ ...logoutPayload(), nonce: null }), null);
  });
});

check("로그아웃 이벤트 표시가 없으면 거절한다", () => {
  quiet(() => {
    assert.equal(readLogoutClaims({ sub: SUBJECT }), null);
    assert.equal(readLogoutClaims({ sub: SUBJECT, events: {} }), null);
    assert.equal(readLogoutClaims({ sub: SUBJECT, events: null }), null);
    assert.equal(readLogoutClaims({ sub: SUBJECT, events: "로그아웃" }), null);
    assert.equal(
      readLogoutClaims({ sub: SUBJECT, events: { "http://example.com/other": {} } }),
      null,
    );
  });
});

check("sub 가 없는 로그아웃 토큰은 거절한다", () => {
  quiet(() => {
    assert.equal(readLogoutClaims({ events: { [LOGOUT_EVENT]: {} } }), null);
    assert.equal(readLogoutClaims({ sub: "", events: { [LOGOUT_EVENT]: {} } }), null);
    assert.equal(readLogoutClaims({ sub: 123, events: { [LOGOUT_EVENT]: {} } }), null);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 포털로 보내는 주소와 왕복 쿠키                                     */
/* ------------------------------------------------------------------ */

check("🔴 포털로 보내는 주소에 PKCE(S256)·state·nonce 가 모두 붙는다", () => {
  const { authorizeUrl, transaction } = beginLogin("/leave");
  const url = new URL(authorizeUrl);
  const q = url.searchParams;

  // issuer 끝의 슬래시는 떨어져 있어야 한다 — iss 대조가 문자 단위다.
  assert.equal(url.origin + url.pathname, "http://192.168.1.10:3100/api/oidc/authorize");

  assert.equal(q.get("client_id"), "dss-leave");
  assert.equal(
    q.get("redirect_uri"),
    "http://192.168.1.10:3700/api/auth/sso/callback",
  );
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("scope"), "openid profile email");
  assert.equal(q.get("code_challenge_method"), "S256");

  assert.equal(q.get("state"), transaction.state);
  assert.equal(q.get("nonce"), transaction.nonce);
  assert.ok((q.get("state") ?? "").length >= 43);
  assert.ok((q.get("nonce") ?? "").length >= 43);

  // 🔴 code_verifier 자체는 절대 나가지 않는다. 나가면 PKCE 가 무의미하다.
  assert.equal(q.get("code_verifier"), null);
  assert.ok(!authorizeUrl.includes(transaction.codeVerifier));
  // RFC 7636 이 정한 43~128자 안
  assert.ok(transaction.codeVerifier.length >= 43 && transaction.codeVerifier.length <= 128);
});

check("로그인을 두 번 시작하면 state·nonce·code_verifier 가 매번 새로 나온다", () => {
  const a = beginLogin("/leave").transaction;
  const b = beginLogin("/leave").transaction;
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.codeVerifier, b.codeVerifier);
});

check("🔴 왕복 쿠키는 서명이 맞을 때만 열린다 — 이 서명이 곧 PKCE 다", () => {
  const { transaction } = beginLogin("/approvals?q=%EA%B2%B0%EC%9E%AC");
  const sealed = sealTransaction(transaction);

  assert.deepEqual(openTransaction(sealed), transaction);

  // 한 글자만 바꿔도 열리지 않는다 (내용 쪽 · 서명 쪽 둘 다)
  const dot = sealed.indexOf(".");
  const payload = sealed.slice(0, dot);
  const signature = sealed.slice(dot + 1);
  assert.equal(openTransaction(`${payload}x.${signature}`), null);
  assert.equal(openTransaction(`${payload}.${signature}x`), null);
  assert.equal(openTransaction(`${payload}.`), null);
  assert.equal(openTransaction(payload), null);
  assert.equal(openTransaction(undefined), null);
  assert.equal(openTransaction(""), null);

  // 서명 없이 제 손으로 지어낸 값 — code_verifier 를 바꿔 끼우려는 시도다
  const forged = Buffer.from(
    JSON.stringify({ ...transaction, codeVerifier: "내가정한값" }),
    "utf8",
  ).toString("base64url");
  assert.equal(openTransaction(`${forged}.${signature}`), null);
});

check("만료된 왕복 쿠키는 열리지 않는다 — Max-Age 는 브라우저의 호의일 뿐이다", () => {
  const { transaction } = beginLogin("/leave");
  const expired = { ...transaction, expiresAt: Math.floor(Date.now() / 1000) - 1 };
  assert.equal(openTransaction(sealTransaction(expired)), null);
});

/* ------------------------------------------------------------------ */
/* 6. 쿠키 이름                                                         */
/* ------------------------------------------------------------------ */

check("🔴 쿠키 이름이 다른 시스템과 겹치지 않는다 — 쿠키는 포트를 가리지 않는다", () => {
  const names = [SESSION_COOKIE, SSO_TX_COOKIE, SERVICE_MENU_COOKIE];
  // localhost:3700 과 localhost:3000 이 같은 쿠키 통을 쓴다. 이름이 겹치면
  // 한쪽 로그인이 다른 쪽을 덮어쓴다(A/S 에서 실제로 났던 구멍).
  for (const name of names) {
    assert.ok(name.startsWith("leave_"), `leave_ 로 시작하지 않는다: ${name}`);
  }
  assert.equal(new Set(names).size, names.length);
  // 포털의 쿠키
  assert.ok(!names.includes("dss_sso"));
});

console.log(`\n${passed}개 통과`);
