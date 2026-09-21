/**
 * 서비스 메뉴바 목록을 나르는 서명 쿠키 검사.  npm run test:menu
 *
 * 🔴 DB 에도 네트워크에도 닿지 않는다. 여기서 보는 것은 굽고(createServiceMenuToken)
 * 푸는(parseServiceMenuToken) 순수 함수 둘뿐이다 — 쿠키를 실제로 세우고 읽는
 * 자리는 next/headers 가 필요해 요청 안에서만 돈다.
 *
 * 무엇을 지키는가
 *   1. 클레임이 없으면 **굽지 않는다** — 포털이 그 값을 싣기 전에도 머리말이
 *      예전과 같아야 한다
 *   2. 위조·변조·만료된 토큰은 **빈 목록**이다 (던지지 않는다 — 곁다리 때문에
 *      본문이 안 보이면 안 된다)
 *   3. 서명 키가 왕복 쿠키(leave_sso_tx)의 것과 **다르다** — 한쪽 서명이
 *      다른 쪽에 통하지 않는다
 *   4. 통합 로그인 설정이 없으면 굽지도 풀지도 않고, **던지지도 않는다**
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

// 🔴 .env.local 을 읽지 않는다. 이 검사는 이 파일에 적힌 값으로만 돈다
//    (test-auth.ts 와 같은 이유 — auto 로 두면 Wi-Fi 상태에 따라 결과가 달라진다).
const TX_SECRET = "0123456789abcdef0123456789abcdef";
process.env.SSO_ISSUER = "http://192.168.1.10:3100/";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = "테스트용";
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = TX_SECRET;
process.env.SESSION_HOURS = "12";

import {
  createServiceMenuToken,
  parseServiceMenuToken,
} from "../src/lib/auth/service-menu-cookie";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** 포털이 ID 토큰의 dss_services 클레임에 싣는 모양 그대로. */
const CLAIM = [
  { id: "dss-as", name: "A/S 관리", url: "http://192.168.1.10:3000", icon: "🔧" },
  { id: "dss-leave", name: "휴가 관리", url: "http://192.168.1.10:3700" },
  { id: "dss-improvements", name: "개선요청", url: "http://192.168.1.10:3500", icon: "💡" },
];

/* ------------------------------------------------------------------ */
/* 1. 클레임이 없으면 굽지 않는다                                        */
/* ------------------------------------------------------------------ */

check("🔴 dss_services 클레임이 없으면 토큰이 null — 쿠키를 굽지 않는다(포털이 싣기 전 상태)", () => {
  assert.equal(createServiceMenuToken(undefined), null);
  assert.equal(createServiceMenuToken(null), null);
});

check("🔴 그릴 수 있는 칸이 하나도 없으면 null — 빈 자리도 남기지 않는다", () => {
  assert.equal(createServiceMenuToken([]), null);
  assert.equal(createServiceMenuToken("배열이 아님"), null);
  assert.equal(createServiceMenuToken({ id: "하나만" }), null);
  // 모양이 깨진 칸만 있는 경우도 같다
  assert.equal(createServiceMenuToken([{ id: "", name: "", url: "" }]), null);
});

/* ------------------------------------------------------------------ */
/* 2. 제대로 된 클레임                                                  */
/* ------------------------------------------------------------------ */

check("굽고 풀면 받은 차례 그대로 돌아온다", () => {
  const token = createServiceMenuToken(CLAIM);
  assert.ok(token);
  assert.deepEqual(parseServiceMenuToken(token), CLAIM);
});

check("링크로 그릴 수 없는 칸은 걸러지고 나머지는 남는다", () => {
  const token = createServiceMenuToken([
    { id: "나쁨", name: "가짜", url: "javascript:alert(1)" },
    ...CLAIM,
  ]);
  assert.ok(token);
  assert.deepEqual(parseServiceMenuToken(token), CLAIM);
});

/* ------------------------------------------------------------------ */
/* 3. 위조 · 변조 · 만료                                                */
/* ------------------------------------------------------------------ */

/** 서명 없이 내용만 그럴듯하게 만든 토큰(= 사용자가 제 브라우저에서 고친 값). */
function forge(payload: unknown, key: Buffer | null): string {
  const base64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = key
    ? createHmac("sha256", key).update(base64).digest("base64url")
    : "가짜서명";
  return `${base64}.${signature}`;
}

const after = Math.floor(Date.now() / 1000) + 3600;

check("🔴 서명이 없거나 틀리면 빈 목록 — 브라우저에서 고친 목록은 뜨지 않는다", () => {
  assert.deepEqual(parseServiceMenuToken(forge({ services: CLAIM, expiresAt: after }, null)), []);
  assert.deepEqual(parseServiceMenuToken(""), []);
  assert.deepEqual(parseServiceMenuToken("점이없다"), []);
  assert.deepEqual(parseServiceMenuToken(".서명만"), []);
});

check("🔴 내용을 한 글자라도 바꾸면 빈 목록", () => {
  const token = createServiceMenuToken(CLAIM)!;
  const [payload, signature] = token.split(".");
  const tampered = Buffer.from(
    JSON.stringify({ services: CLAIM, issuedAt: 0, expiresAt: after }),
    "utf8",
  ).toString("base64url");
  assert.notEqual(tampered, payload);
  assert.deepEqual(parseServiceMenuToken(`${tampered}.${signature}`), []);
});

check("🔴 만료된 토큰은 빈 목록 — Max-Age 는 브라우저의 호의일 뿐이다", () => {
  const now = Math.floor(Date.now() / 1000);
  const key = createHmac("sha256", TX_SECRET).update("leave:service-menu:v1").digest();
  const expired = forge({ services: CLAIM, issuedAt: now - 10, expiresAt: now - 1 }, key);
  assert.deepEqual(parseServiceMenuToken(expired), []);
  // 만료 시각이 아예 없는 옛 토큰도 믿지 않는다
  assert.deepEqual(parseServiceMenuToken(forge({ services: CLAIM }, key)), []);
});

check("서명은 맞아도 안에 든 값이 목록이 아니면 빈 목록", () => {
  const key = createHmac("sha256", TX_SECRET).update("leave:service-menu:v1").digest();
  assert.deepEqual(parseServiceMenuToken(forge({ services: "배열이 아님", expiresAt: after }, key)), []);
  assert.deepEqual(parseServiceMenuToken(forge({ services: [1, 2, 3], expiresAt: after }, key)), []);
  assert.deepEqual(parseServiceMenuToken(forge("객체가 아님", key)), []);
});

/* ------------------------------------------------------------------ */
/* 4. 서명 키를 갈라 쓴다                                               */
/* ------------------------------------------------------------------ */

check("🔴 왕복 쿠키(leave_sso_tx)의 비밀값을 그대로 쓴 서명은 통하지 않는다 — 키를 갈라 쓴다", () => {
  // SSO_TX_SECRET 을 **가르지 않고** 그대로 키로 쓴 토큰.
  const raw = Buffer.from(TX_SECRET, "utf8");
  assert.deepEqual(parseServiceMenuToken(forge({ services: CLAIM, expiresAt: after }, raw)), []);
});

/* ------------------------------------------------------------------ */
/* 5. 통합 로그인 설정이 없을 때                                         */
/* ------------------------------------------------------------------ */

check("🔴 통합 로그인 설정이 없으면 굽지도 풀지도 않는다 — 던지지 않는다(머리말 장식이다)", () => {
  const saved = process.env.SSO_TX_SECRET;
  delete process.env.SSO_TX_SECRET;
  try {
    assert.equal(createServiceMenuToken(CLAIM), null);
    // 예전에 구워 둔 토큰이 브라우저에 남아 있어도 조용히 빈 목록이다
    assert.deepEqual(parseServiceMenuToken("아무거나.아무거나"), []);
  } finally {
    process.env.SSO_TX_SECRET = saved;
  }
});

/* ------------------------------------------------------------------ */
/* 6. 배선 — 클레임이 콜백까지 오는 길                                   */
/* ------------------------------------------------------------------ */

/**
 * 🔴 굽고 푸는 함수가 아무리 옳아도 **클레임이 거기까지 오지 않으면** 메뉴바는
 * 영영 안 뜬다. 실제로 그 네 줄이 빠진 채로 한동안 있었다(2026-09-21).
 * 쿠키를 세우는 자리는 요청 안에서만 돌아 여기서 부를 수 없으므로, 길이
 * 이어져 있는지를 **소스 글자로** 본다. 무르지만 없는 것보다 낫다.
 */
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

check("🔴 oidc.ts 가 dss_services 클레임을 SsoIdentity 에 실어 준다", () => {
  const oidc = read("src/lib/auth/oidc.ts");
  assert.ok(oidc.includes("services: unknown"), "SsoIdentity 에 services 칸이 없다");
  assert.ok(
    oidc.includes("services: payload.dss_services"),
    "verifyIdToken 이 dss_services 를 싣지 않는다",
  );
});

check("🔴 콜백이 세션을 준 **뒤에** 목록을 굽는다", () => {
  const callback = read("src/app/api/auth/sso/callback/route.ts");
  const sessionAt = callback.indexOf("await createSession(");
  const cookieAt = callback.indexOf("await writeServiceMenuCookie(identity.services);");
  assert.ok(sessionAt > 0, "createSession 을 부르지 않는다");
  assert.ok(cookieAt > 0, "writeServiceMenuCookie 를 부르지 않는다 — 메뉴바가 영영 안 뜬다");
  assert.ok(cookieAt > sessionAt, "세션보다 먼저 굽고 있다");
});

check("🔴 로그인 시작과 로그아웃에서 남은 목록을 지운다 — 공용 PC", () => {
  assert.ok(read("src/app/api/auth/sso/start/route.ts").includes("clearServiceMenuCookie()"));
  assert.ok(read("src/app/actions/auth.ts").includes("clearServiceMenuCookie()"));
});

console.log(`\n${passed}개 통과`);
