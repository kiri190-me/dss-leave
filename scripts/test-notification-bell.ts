/**
 * 머리말 알림 종 검사.  npm run test:bell
 *
 * 🔴 DB 에 닿지 않고 바깥 망에도 나가지 않는다. 포털 노릇은 이 검사가
 * 127.0.0.1 에 잠깐 띄우는 **가짜 서버**가 한다 — 그래서 503·401·429 같은
 * 거절을 말로가 아니라 **실제로** 받아 본다.
 *
 * ── 알림이 흐르는 길 ────────────────────────────────────────────────────
 *   다른 시스템들(A/S · 계측기 · 개선요청 · PO/내자)이 저마다 가진 알림
 *     → 포털이 모아 합친다 (dss-auth 의 notifications/merge.ts)
 *     → 이 사이트의 **서버**가 client_id/secret 으로 묻는다 (auth/oidc.ts)
 *   🔴 + **이 사이트 자신의 결재 대기**(포털은 부른 사이트 것을 빼고 준다)
 *     → PortalNotificationBell 이 자기 것을 **앞에** 이어 붙인다
 *     → (internal)/layout.tsx 가 <Suspense> 로 감싸 머리말에 내려보내고
 *     → AppHeader 가 줄의 **맨 오른쪽 끝**에 그린다 (@dss/ui 의 NotificationBell)
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────
 *   1. 🔴 **어떤 답이 와도 던지지 않는다.** 503·401·403·429·깨진 본문·응답
 *      없음·설정 누락 전부 빈 목록이다. 이 종은 모든 화면에 딸려 오므로
 *      여기서 나는 오류 하나가 사이트 전체를 못 쓰게 만든다. 이 파일에서
 *      가장 중요한 절이다.
 *   2. 🔴 자격증명은 **머리말(Basic)** 로만 나가고 어디에도 찍히지 않는다.
 *   3. 개수는 **포털이 센 값 그대로**다 — 줄 수로 다시 세지 않는다.
 *   4. 이상한 줄은 **그 줄만** 버린다.
 *   5. 그리는 자리는 줄의 **맨 오른쪽 끝**이고 래퍼가 없다.
 *   6. 🔴 **자기 것이 앞, 받은 것이 뒤**이고 배지는 **두 개수의 합**이다.
 *      포털이 죽어도 자기 알림은 그대로 보이고, 자기 줄에 사유는 없다.
 *   7. 🔴 「보이는 알림 지우기」가 묶어 보내는 열쇠에 **제 줄과 포털 줄이 둘 다**
 *      들어가고, 그 수가 묶음이 단추에 적는 수와 **같다**. 브라우저가 돌려보낸
 *      값은 믿지 않는다(모양·울타리).
 *
 * 레이아웃·머리말은 실제로 불러 볼 수 없다(세션·DB·요청 맥락이 필요하다).
 * 그 자리들만 **소스 글자로** 구조를 못 박는다 — 무르지만 없는 것보다 낫다.
 *
 * 🔴 왜 전부 main() 안에 있나: 이 저장소의 검사는 tsx 가 CJS 로 돌려
 * (package.json 에 type:module 이 없다) 최상위 await 을 쓸 수 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// 🔴 .env.local 을 읽지 않는다. 이 검사는 여기 적힌 값으로만 돈다
//    (test-auth.ts 와 같은 이유 — auto 로 두면 Wi-Fi 상태에 따라 결과가 달라진다).
//    SSO_ISSUER 는 아래에서 가짜 포털의 주소로 바꿔 끼운다.
const FAKE_SECRET = "테스트용-시크릿";
process.env.SSO_CLIENT_ID = "dss-leave";
process.env.SSO_CLIENT_SECRET = FAKE_SECRET;
process.env.SSO_REDIRECT_URI = "http://192.168.1.10:3700/api/auth/sso/callback";
process.env.SSO_TX_SECRET = "0123456789abcdef0123456789abcdef";

import { NotificationBell, type NotificationBellItem } from "@dss/ui";

import {
  MAX_DISMISS_KEYS_AT_ONCE,
  vetDismissKeys,
  visibleNotificationKeys,
} from "../src/lib/auth/notification-keys";
import {
  acknowledgePortalNotification,
  fetchPortalNotifications,
  normalizePortalNotificationFeed,
  type PortalNotificationFeed,
} from "../src/lib/auth/oidc";
import {
  APPROVALS_PATH,
  LEAVE_APPROVAL_KIND,
  OWN_SOURCE_ID_FALLBACK,
  bellFeedWithOwnFirst,
  buildPortalNotificationFeed,
  isOwnBellItem,
  ownNotificationSourceId,
  toOwnBellItem,
  type PendingApprovalRow,
  type PortalActor,
} from "../src/lib/leave/portal-notifications";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** 주석을 걷어 낸 코드. 주석에 적힌 낱말이 검사를 통과시키지 않게. */
const withoutComments = (source: string) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** 포털에 등록된 사람의 sub(포털 users.id)와 같은 모양. */
const SUB = "11111111-2222-4333-8444-555555555555";

/** 포털 답 한 줄. 아홉 칸 전부 글자다(없는 값은 빈 문자열로 온다). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "rf-service-system:APPROVAL:123",
    sourceId: "rf-service-system",
    sourceName: "DSS A/S 관리 시스템",
    id: "APPROVAL:123",
    kind: "APPROVAL",
    kindLabel: "결재 대기",
    subject: "RF-2026-0007",
    detail: "김아무개가 올렸습니다",
    href: "http://192.168.35.215:3000/repair-cases/123",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 이 사이트 자신의 알림 — DB 자리에만 가짜를 끼운다                      */
/* ------------------------------------------------------------------ */

/** 위 SSO_REDIRECT_URI 에서 나오는 이 앱 자신의 주소(env.ts 의 appBaseUrl). */
const OWN_BASE_URL = "http://192.168.1.10:3700";

/** 결재선에 올라 있고 명단에 연결된 사람. 알림을 받을 수 있는 「나」다. */
const ME: PortalActor = {
  role: "MEMBER",
  decider: { employeeId: "emp-1", rankId: "rank-1", isApprover: true },
};

/** 결재함 질의가 돌려주는 한 줄(data.ts 의 pendingApprovalNotifications). */
function approval(overrides: Partial<PendingApprovalRow> = {}): PendingApprovalRow {
  return {
    stepId: "step-1",
    applicantName: "김대리",
    kind: "NEW",
    leaveType: "ANNUAL",
    startDate: "2026-10-05",
    endDate: "2026-10-06",
    days: 2,
    ...overrides,
  };
}

/**
 * 🔴 화면이 자기 알림을 구하는 **그 길** 그대로다 — 창구(route)와 종
 * (PortalNotificationBell)이 함께 부르는 buildPortalNotificationFeed 에
 * DB 자리(findActor · listPendingApprovals)만 가짜를 끼운다.
 */
function ownFeed(rows: PendingApprovalRow[], actor: PortalActor | null = ME) {
  return buildPortalNotificationFeed({
    subject: SUB,
    baseUrl: OWN_BASE_URL,
    findActor: async () => actor,
    listPendingApprovals: async () => rows,
  });
}

/** 받은 것이 하나도 없는 답(포털이 죽었을 때와 같은 모양). */
const NOTHING_RECEIVED: PortalNotificationFeed = {
  items: [],
  count: 0,
  degraded: false,
  dismissed: [],
};

/**
 * 자기 줄의 열쇠 접두사. 🔴 **이 시스템의 client_id 다**(위에서 환경변수로
 * 박아 둔 값과 같아야 한다 — 아래 검사가 그것을 단언한다).
 *
 * 2026-09-22 에는 `self` 였다. 「그만 보겠다」가 포털에 적히게 되면서
 * (2026-10-20) 바뀌었다 — 포털은 `self` 라는 시스템을 모르고, 그 열쇠로 온
 * 지움을 조용히 버린다.
 */
const OWN = "dss-leave";

type Drawn = { type: unknown; props: Record<string, unknown> };

/** 그려진 트리를 납작하게 펼친다 — 무엇이 어느 차례로 그려졌는지 보려고. */
function flatten(node: unknown, out: Drawn[] = []): Drawn[] {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== "object" || node === null || !("props" in node)) return out;
  const element = node as Drawn;
  out.push(element);
  flatten(element.props.children, out);
  return out;
}

/** 그려진 줄들의 열쇠 — 차례 그대로. */
function drawnKeys(feed: { items: readonly NotificationBellItem[]; count: number }): string[] {
  return flatten(NotificationBell(feed))
    .filter((el) => el.type === "a")
    .map((el) => String(el.props["data-notification-key"]));
}

/* ------------------------------------------------------------------ */
/* 가짜 포털 — 127.0.0.1 에만 뜬다                                      */
/* ------------------------------------------------------------------ */

type Heard = {
  method?: string;
  path?: string;
  authorization?: string;
  contentType?: string;
  accept?: string;
  body: string;
};

let heard: Heard | null = null;
/** 다음 요청에 무엇으로 답할지. 아무것도 하지 않으면 **영영 답하지 않는다.** */
let answer: (res: ServerResponse) => void = (res) => res.end();

const portal = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += String(chunk)));
  req.on("end", () => {
    heard = {
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      accept: req.headers.accept,
      body,
    };
    answer(res);
  });
});

/** 이 답으로 한 번 물어본다. 찍힌 로그도 함께 돌려준다(자격증명 검사용). */
async function ask(
  reply: (res: ServerResponse) => void,
  subject: string = SUB,
): Promise<{ feed: PortalNotificationFeed; logs: string }> {
  heard = null;
  answer = reply;
  const lines: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const feed = await fetchPortalNotifications(subject);
    return { feed, logs: lines.join("\n") };
  } finally {
    console.error = realError;
  }
}

const json = (status: number, body: unknown) => (res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const EMPTY = { items: [], count: 0, degraded: true, dismissed: [] };

async function main() {
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.SSO_ISSUER = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;

  console.log("\n알림 종\n");

  /* ---------------------------------------------------------------- */
  /* 1. 🔴 어떤 답이 와도 던지지 않는다                                  */
  /* ---------------------------------------------------------------- */

  for (const status of [401, 403, 429, 500, 503]) {
    await checkAsync(`🔴 포털이 ${status} 로 거절해도 던지지 않는다 — 빈 목록이다`, async () => {
      const { feed, logs } = await ask((res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
      });
      assert.deepEqual(feed, EMPTY);
      // 거절 본문은 포털의 내부 설정을 설명할 수 있다. 상태만 남는다.
      assert.ok(logs.includes(String(status)), "상태를 남기지 않는다");
      assert.ok(!logs.includes("nope"), "거절 본문을 통째로 찍는다");
    });
  }

  await checkAsync("🔴 답이 JSON 이 아니어도 던지지 않는다", async () => {
    const { feed } = await ask((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>프록시가 가로챈 화면</html>");
    });
    assert.deepEqual(feed, EMPTY);
  });

  await checkAsync(
    "🔴 포털이 **영영 답하지 않아도** 화면이 멈추지 않는다 — 2초 상한에 걸린다",
    async () => {
      const started = Date.now();
      // 아무 말도 하지 않는다. 상한이 없으면 이 검사가 여기서 멈춘다.
      const { feed } = await ask(() => {});
      const waited = Date.now() - started;
      assert.deepEqual(feed, EMPTY);
      assert.ok(waited >= 1500, `상한 전에 돌아왔다(${waited}ms) — 정말 기다렸는지 의심스럽다`);
      assert.ok(waited < 5000, `🔴 ${waited}ms 나 기다렸다 — 상한이 없거나 너무 길다`);
    },
  );

  await checkAsync("🔴 포털에 아예 닿지 못해도 던지지 않는다", async () => {
    const before = process.env.SSO_ISSUER;
    // 아무도 듣고 있지 않은 자리라 연결이 곧바로 거절된다.
    process.env.SSO_ISSUER = "http://127.0.0.1:1";
    try {
      const { feed } = await ask(json(200, { items: [row()], count: 1 }));
      assert.deepEqual(feed, EMPTY);
    } finally {
      process.env.SSO_ISSUER = before;
    }
  });

  await checkAsync(
    "🔴 설정이 빠져도 던지지 않는다 — env 의 getter 가 던지는 자리까지 삼킨다",
    async () => {
      // .env 가 빈 채로 뜬 PC(임시 로그인만 쓰는 개발기)에서도 머리말은 떠야
      // 한다. env 를 try **밖**에서 읽으면 여기서 걸린다 — 그 getter 는 값이
      // 없으면 던진다.
      const before = { ...process.env };
      delete process.env.SSO_ISSUER;
      delete process.env.SSO_CLIENT_ID;
      delete process.env.SSO_CLIENT_SECRET;
      try {
        const { feed } = await ask(json(200, { items: [row()], count: 1 }));
        assert.deepEqual(feed, EMPTY);
      } finally {
        process.env = before;
      }
    },
  );

  await checkAsync("포털 계정과 이어지지 않은 사람은 아예 묻지 않는다 — 빈 sub", async () => {
    const { feed } = await ask(json(200, { items: [row()], count: 1 }), "");
    assert.deepEqual(feed, EMPTY);
    assert.equal(heard, null, "🔴 빈 sub 로 포털을 두드렸다");
  });

  /* ---------------------------------------------------------------- */
  /* 2. 🔴 자격증명                                                     */
  /* ---------------------------------------------------------------- */

  await checkAsync(
    "🔴 자격증명은 Authorization: Basic 으로만 나간다 — 주소에 싣지 않는다",
    async () => {
      await ask(json(200, { items: [], count: 0 }));
      assert.ok(heard, "포털에 닿지 않았다");
      const asked = heard as Heard;

      assert.equal(asked.method, "POST");
      assert.equal(asked.path, "/api/integration/notifications");
      const authorization = asked.authorization ?? "";
      assert.ok(authorization.startsWith("Basic "), "Basic 머리말이 없다");

      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      assert.equal(
        decoded,
        `dss-leave:${encodeURIComponent(FAKE_SECRET)}`,
        "자격증명이 client_id:client_secret 이 아니다",
      );

      // 🔴 주소에 실리면 포털이 400 으로 거절하고, 그 값은 이미 접근 로그에
      //    남아 **다시 발급**해야 한다(dss-auth/docs/사이트-알림-통로.md).
      assert.ok(!asked.path?.includes("?"), "🔴 주소에 질의 문자열이 붙었다");
      assert.ok(
        !asked.body.includes("client_secret") && !asked.body.includes("client_id"),
        "🔴 자격증명이 몸통에 실린다",
      );
      // 몸통에 실어 보내는 것은 sub 하나뿐이다.
      assert.equal(asked.body, `sub=${SUB}`);
    },
  );

  await checkAsync(
    "🔴 자격증명을 로그에 찍지 않는다 — 남는 것은 오류의 종류와 상태뿐이다",
    async () => {
      const collected: string[] = [];
      collected.push((await ask((res) => res.writeHead(401).end())).logs);
      collected.push((await ask((res) => res.end("깨진 답"))).logs);
      const before = process.env.SSO_ISSUER;
      process.env.SSO_ISSUER = "http://127.0.0.1:1";
      collected.push((await ask(json(200, {}))).logs);
      process.env.SSO_ISSUER = before;

      const all = collected.join("\n");
      assert.ok(!all.includes(FAKE_SECRET), "🔴 로그에 시크릿이 딸려 나온다");
      assert.ok(!all.includes("Basic "), "🔴 로그에 Authorization 머리말이 딸려 나온다");
      // 오류 객체를 통째로 찍지 않는다 — 요청 정보가 딸려 나올 수 있다.
      const source = withoutComments(read("src/lib/auth/oidc.ts"));
      const call = source.slice(source.indexOf("export async function fetchPortalNotifications"));
      assert.ok(call.includes('error instanceof Error ? error.name : "unknown"'));
      assert.equal(/\bthrow\b/.test(call), false, "🔴 알림 통로가 던진다 — 머리말이 깨진다");
    },
  );

  check("답을 캐시하지 않는다 — 방금 처리한 일이 종에 남으면 안 된다", () => {
    const source = withoutComments(read("src/lib/auth/oidc.ts"));
    const call = source.slice(source.indexOf("export async function fetchPortalNotifications"));
    assert.ok(call.includes('cache: "no-store"'));
    assert.ok(call.includes("signal: AbortSignal.timeout(NOTIFICATIONS_TIMEOUT_MS)"));
    const limit = source.match(/const NOTIFICATIONS_TIMEOUT_MS = (\d+);/);
    assert.ok(limit, "상한 값을 찾지 못했다");
    assert.ok(Number(limit[1]) > 0 && Number(limit[1]) <= 5000, "상한이 없거나 너무 길다");
  });

  /* ---------------------------------------------------------------- */
  /* 3. 받은 답을 고르는 일                                              */
  /* ---------------------------------------------------------------- */

  await checkAsync("정상 답은 아홉 칸 그대로 나른다 — 종에 넘길 모양 그대로다", async () => {
    const { feed } = await ask(
      json(200, {
        items: [row()],
        count: 3,
        sources: [{ clientId: "rf-service-system", name: "A/S", ok: true, count: 3 }],
        degraded: false,
      }),
    );
    assert.deepEqual(feed, { items: [row()], count: 3, degraded: false, dismissed: [] });
  });

  check("🔴 모양이 깨진 줄은 **그 줄만** 버린다 — 한 줄 때문에 머리말이 비지 않는다", () => {
    const feed = normalizePortalNotificationFeed({
      items: [
        row({ key: "a" }),
        row({ detail: null }), // 포털은 빈 문자열로 싣는다 — null 은 우리가 모르는 답이다
        null,
        "알림",
        row({ key: "b", href: undefined }),
        row({ key: "c" }),
      ],
      count: 4,
    });
    assert.deepEqual(
      feed.items.map((item) => item.key),
      ["a", "c"],
    );
    // 🔴 개수는 그대로다 — 버린 줄만큼 빼서 다시 세지 않는다.
    assert.equal(feed.count, 4);
  });

  check("🔴 개수는 포털이 센 값 그대로다 — 줄 수로 다시 세지 않는다", () => {
    // A/S 는 「같은 대상은 한 번만」 센다(한 건에 결재가 둘 걸려 있어도 1).
    // 여기서 줄을 세면 A/S 의 종과 이 종이 서로 다른 숫자를 말하게 된다.
    const feed = normalizePortalNotificationFeed({
      items: [row({ key: "a" }), row({ key: "b" }), row({ key: "c" })],
      count: 2,
    });
    assert.equal(feed.count, 2);
  });

  check("개수가 숫자가 아니면 0 이다 — 배지만 안 그려지고 목록은 그대로 보인다", () => {
    for (const count of ["3", null, undefined, Number.NaN, -1]) {
      const feed = normalizePortalNotificationFeed({ items: [row()], count });
      assert.equal(feed.count, 0, `count=${String(count)} 에서 0 이 아니다`);
      assert.equal(feed.items.length, 1, "목록까지 버렸다");
    }
  });

  check("알 수 없는 답(빈 몸통·글자·배열 아님)은 못 물어본 것으로 친다", () => {
    for (const body of [null, "", 7, [], { items: "없음" }]) {
      const feed = normalizePortalNotificationFeed(body);
      assert.deepEqual(feed.items, [], `${JSON.stringify(body)} 에서 목록이 생겼다`);
    }
  });

  check("degraded 는 「알림이 없다」와 다른 말이라 값을 버리지 않는다", () => {
    assert.equal(normalizePortalNotificationFeed({ items: [], degraded: true }).degraded, true);
    assert.equal(normalizePortalNotificationFeed({ items: [] }).degraded, false);
  });

  /* ---------------------------------------------------------------- */
  /* 4. 그리는 자리                                                      */
  /* ---------------------------------------------------------------- */

  check("🔴 이 사이트는 **서버**에서 묻는다 — 브라우저로 나가는 중계 통로를 두지 않았다", () => {
    // 자격증명이 client_secret 이라 브라우저에서는 부를 수 없다. 중계 통로를
    // 두면 시크릿을 다루는 자리가 하나 더 생긴다.
    const bell = withoutComments(read("src/components/PortalNotificationBell.tsx"));
    assert.equal(bell.includes('"use client"'), false, "종을 그리는 조각이 클라이언트로 넘어갔다");
    assert.ok(bell.includes("fetchPortalNotifications(subject)"), "이 조각이 포털에 묻지 않는다");
    assert.equal(bell.includes("colorScheme"), false, "다크는 @dss/ui 기본값에 맡긴다");
  });

  check("🔴 자기 것과 받은 것을 **나란히** 부른다 — 자기 알림이 포털을 기다리지 않는다", () => {
    // 줄줄이 부르면 포털 왕복(상한 2초)이 끝나야 자기 결재가 뜬다. 포털이
    // 느린 날 「내 차례인 결재」가 늦게 나타날 이유가 없다.
    const bell = withoutComments(read("src/components/PortalNotificationBell.tsx"));
    const parallel = bell.indexOf("await Promise.all([");
    assert.ok(parallel > 0, "🔴 두 곳을 줄줄이 부른다");
    assert.ok(bell.indexOf("ownNotifications(subject)") > parallel);
    assert.ok(bell.indexOf("fetchPortalNotifications(subject)") > parallel);
  });

  check("🔴 묻는 열쇠는 검증된 세션의 authSub 다 — 클라이언트가 보낸 값이 아니다", () => {
    const layout = withoutComments(read("src/app/(internal)/layout.tsx"));
    assert.ok(layout.includes("const viewer = await requireViewer();"));
    assert.ok(layout.includes("<PortalNotificationBell subject={viewer.user.authSub} />"));
  });

  check("🔴 <Suspense> 가 감싼다 — 포털이 느려도 모든 화면 이동이 느려지지 않는다", () => {
    const layout = withoutComments(read("src/app/(internal)/layout.tsx"));
    const bellAt = layout.indexOf("<PortalNotificationBell");
    const suspenseAt = layout.indexOf("<Suspense fallback={null}>");
    assert.ok(suspenseAt > 0, "🔴 종이 <Suspense> 밖에 있다 — 머리말이 포털을 기다린다");
    assert.ok(suspenseAt < bellAt, "감싸는 차례가 뒤집혔다");
    assert.ok(layout.includes("notificationBell={"), "머리말에 내려보내지 않는다");
  });

  check("🔴 종은 줄의 **맨 오른쪽 끝**이다 — 아니면 폰에서 펼친 목록이 잘린다", () => {
    // 펼친 목록은 종에 오른쪽 끝을 맞춰 왼쪽으로 펼쳐지고(아래 CSS 검사) 폭이
    // 폰에서 320px 이다. 종이 가운데쯤 앉으면 목록 왼쪽이 화면 밖으로 나간다.
    const header = withoutComments(read("src/components/AppHeader.tsx"));
    const bellAt = header.indexOf("{notificationBell}");
    assert.ok(bellAt > 0, "머리말이 종을 그리지 않는다");
    assert.ok(bellAt > header.indexOf("로그아웃"), "🔴 종이 나가는 단추보다 앞에 있다");
    assert.ok(bellAt > header.indexOf("{serviceMenu}"), "🔴 종이 메뉴바보다 앞에 있다");
    // 받는 것은 다 그려진 노드다 — 이 파일이 @dss/ui 를 몰라야 한다(메뉴바와 같다).
    assert.equal(header.includes("@dss/ui"), false, "머리말이 @dss/ui 를 직접 부른다");
  });

  check("🔴 종을 래퍼 <div> 로 감싸지 않는다 — 알림이 없을 때 빈 자리와 여백이 남는다", () => {
    const header = withoutComments(read("src/components/AppHeader.tsx"));
    assert.equal(
      /<div[^>]*>\s*\{notificationBell\}/.test(header),
      false,
      "종을 감쌌다 — 알림이 없어도 flex 항목 하나와 gap-x-3 12px 이 남는다",
    );
  });

  check("생김새를 사이트가 한 번 부른다 — 메뉴바와 **다른 파일**이다", () => {
    const rootLayout = read("src/app/layout.tsx");
    assert.match(rootLayout, /^import "@dss\/ui\/notification-bell\.css";$/m);
    assert.match(rootLayout, /^import "@dss\/ui\/styles\.css";$/m);
    // 🔴 경로 별칭이 없으면 tsc 는 통과해도 화면에서 CSS 가 통째로 빠진다.
    assert.match(read("tsconfig.json"), /"@dss\/ui\/notification-bell\.css":/);
    // 별칭이 가리키는 파일이 실제로 있는지까지 본다(포인터가 옛 커밋이면 없다).
    assert.ok(read("vendor/dss-ui/src/notification-bell/notification-bell.css").length > 0);
  });

  /* ---------------------------------------------------------------- */
  /* 5. 종이 실제로 그리는 것                                            */
  /* ---------------------------------------------------------------- */

  check("🔴 알림이 없으면 종 자체가 없다 — fallback 이 null 인 것과 같은 모습이다", () => {
    // 이것이 참이라서 (1) <Suspense fallback={null}> 이 자리를 들썩이지 않고
    // (2) 머리말이 래퍼 없이 그대로 두어도 빈 자리가 남지 않는다.
    assert.equal(NotificationBell({ items: [], count: 0 }), null);
  });

  check("받은 알림은 받은 차례 그대로, 받은 주소 그대로 그려진다", () => {
    const feed = normalizePortalNotificationFeed({
      items: [
        row({ key: "a", href: "http://192.168.35.215:3000/repair-cases/1" }),
        row({ key: "b", href: "http://192.168.35.215:3300/instruments/2" }),
      ],
      count: 2,
    });
    const rendered = NotificationBell({ items: feed.items, count: feed.count });
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (typeof node !== "object" || node === null || !("props" in node)) return;
      const element = node as { type: unknown; props: Record<string, unknown> };
      if (element.type === "a" && typeof element.props.href === "string") {
        found.push(element.props.href);
      }
      walk(element.props.children);
    };
    walk(rendered);
    assert.deepEqual(found, [
      "http://192.168.35.215:3000/repair-cases/1",
      "http://192.168.35.215:3300/instruments/2",
    ]);
  });

  check("🔴 서브모듈에 종이 실려 있고, 펼친 목록이 오른쪽에 붙는다 — 자리 판단의 근거", () => {
    // 포인터가 옛 커밋이면 이 파일 자체가 없다(위 read 에서 걸린다).
    const css = read("vendor/dss-ui/src/notification-bell/notification-bell.css");
    const listRule = css.match(/\.dss-bell__list \{([\s\S]*?)\n\}/);
    assert.ok(listRule, "펼친 목록 규칙을 찾지 못했다");
    assert.match(listRule[1], /position: absolute;/);
    assert.match(listRule[1], /right: 0;/, "왼쪽에 붙으면 종을 맨 끝에 둘 이유가 사라진다");
    assert.match(listRule[1], /width: min\(20rem, calc\(100vw - 2rem\)\);/);
  });

  /* ---------------------------------------------------------------- */
  /* 6. 🔴 자기 알림을 앞에 이어 붙인다                                  */
  /*    포털은 부른 사이트 자신의 알림을 빼고 답한다 — 그래서 PO·계측기·  */
  /*    개선요청에서는 휴가 결재가 뜨는데 휴가에서는 뜨지 않았다.          */
  /* ---------------------------------------------------------------- */

  await checkAsync("🔴 자기 것이 앞, 받은 것이 뒤 — 받은 차례는 다시 섞지 않는다", async () => {
    const own = await ownFeed([
      approval({ stepId: "s-1" }),
      approval({ stepId: "s-2", applicantName: "박사원" }),
    ]);
    const received = normalizePortalNotificationFeed({
      items: [row({ key: "rf-service-system:APPROVAL:1" }), row({ key: "njlee:CAL:2" })],
      count: 2,
    });

    const bell = bellFeedWithOwnFirst({ own, received });
    const expected = [
      `${OWN}:${LEAVE_APPROVAL_KIND}:s-1`,
      `${OWN}:${LEAVE_APPROVAL_KIND}:s-2`,
      "rf-service-system:APPROVAL:1",
      "njlee:CAL:2",
    ];
    assert.deepEqual(
      bell.items.map((item) => item.key),
      expected,
    );
    // 실제로 그려지는 차례까지 같다.
    assert.deepEqual(drawnKeys(bell), expected);
  });

  await checkAsync("🔴 배지는 **자기 개수 + 받은 개수**다 — 줄 수로 다시 세지 않는다", async () => {
    const own = await ownFeed([approval({ stepId: "s-1" })]);
    // 포털은 줄 셋을 주면서 2 라고 센다(A/S 는 같은 대상을 한 번만 센다).
    // 🔴 그 값을 고치지 않는다 — 고치면 A/S 의 종과 다른 숫자를 말한다.
    const received = normalizePortalNotificationFeed({
      items: [row({ key: "a" }), row({ key: "b" }), row({ key: "c" })],
      count: 2,
    });

    const bell = bellFeedWithOwnFirst({ own, received });
    assert.equal(bell.count, 3, "1(내 것) + 2(포털이 센 값) 이 아니다");
    assert.equal(bell.items.length, 4, "줄은 넷이다 — 배지와 다를 수 있다");

    const badge = flatten(NotificationBell(bell)).find(
      (el) => el.props.className === "dss-bell__badge",
    );
    assert.equal(badge?.props.children, 3, "배지에 찍힌 숫자가 합이 아니다");
  });

  await checkAsync("🔴 포털이 죽어도 자기 알림은 그대로 보인다", async () => {
    const own = await ownFeed([approval()]);
    // 실제로 503 을 받아 본다(말로가 아니라).
    const { feed: received } = await ask((res) => res.writeHead(503).end());
    assert.deepEqual(received, EMPTY, "503 인데 빈 목록이 아니다");

    const bell = bellFeedWithOwnFirst({ own, received });
    assert.equal(bell.items.length, 1);
    assert.equal(bell.count, 1);
    assert.notEqual(NotificationBell(bell), null, "🔴 포털이 죽어 종까지 사라졌다");
    assert.deepEqual(drawnKeys(bell), [`${OWN}:${LEAVE_APPROVAL_KIND}:step-1`]);
  });

  await checkAsync("자기 것도 받은 것도 없으면 종 자체가 없다 — 지금과 같은 모습이다", async () => {
    const bell = bellFeedWithOwnFirst({ own: await ownFeed([]), received: NOTHING_RECEIVED });
    assert.deepEqual(bell, { items: [], count: 0 });
    assert.equal(NotificationBell(bell), null);
  });

  await checkAsync("결재할 것이 없는 사람에게는 받은 것만 보인다", async () => {
    // 명단에 연결되지 않은 계정(확인 대기)은 결재할 것이 있을 수 없다.
    const own = await ownFeed([approval()], { role: "MEMBER", decider: null });
    const received = normalizePortalNotificationFeed({ items: [row({ key: "a" })], count: 1 });
    const bell = bellFeedWithOwnFirst({ own, received });
    assert.deepEqual(drawnKeys(bell), ["a"]);
    assert.equal(bell.count, 1);
  });

  await checkAsync("🔴 자기 줄에도 휴가 사유는 실리지 않는다", async () => {
    // 사유는 본인과 결재권 직급에게만 보이는 값이고(guards.ts 의 canSeeReason),
    // 자기 화면이라도 **같은 함수**가 만든 줄이라 실릴 자리가 없다. 결재함에
    // 들어가서 본다.
    const leaked = { ...approval(), reason: "병원 진료" };
    const own = await ownFeed([leaked]);
    const bell = bellFeedWithOwnFirst({ own, received: NOTHING_RECEIVED });
    assert.equal(
      JSON.stringify(bell.items).includes("병원"),
      false,
      "🔴 알림 줄에 사유가 딸려 나왔다",
    );
  });

  await checkAsync("🔴 자기 줄의 열쇠 접두사는 **client_id** 다 — 아니면 지움이 안 통한다", async () => {
    // 🔴 2026-10-20 에 뒤집힌 판단이다. 그전에는 `self` 로 적어 「포털 것과
    //    글자까지 같아지는 것」을 피했는데, 「그만 보겠다」가 포털에 적히게
    //    되면서 **같은 알림은 어디서 보든 같은 열쇠여야** 한다 — 포털은
    //    client_id 로 어느 시스템의 줄인지 가르고, 모르는 시스템(`self`)의
    //    열쇠는 조용히 버린다. 접두사가 어긋나면 「계측기에서 지웠는데 휴가에서는
    //    그대로 남는」 상태가 되고, 아무 오류도 나지 않는다.
    assert.equal(ownNotificationSourceId(), OWN, "열쇠 접두사가 client_id 가 아니다");

    const own = await ownFeed([approval({ stepId: "s-1" })]);
    const mine = toOwnBellItem(own.items[0]);
    // 포털이 이 줄을 남의 종에 실을 때 적는 열쇠와 **글자까지 같다**(merge.ts
    // 의 `{client_id}:{id}`). 그래서 어느 종에서 지우든 같은 줄이 지워진다.
    assert.equal(mine.key, `${OWN}:${LEAVE_APPROVAL_KIND}:s-1`);
    assert.equal(mine.key, `${mine.sourceId}:${mine.id}`);
  });

  await checkAsync("🔴 합쳐진 목록에 **같은 열쇠가 두 번** 있지 않다", async () => {
    // 🔴 **되살린 검사다.** 이 줄이 지키는 것은 접두사 규칙이 아니라 「합친
    //    목록 안에서 열쇠가 유일한가」 하나다 — @dss/ui 가 그 값을 React key 로
    //    쓰므로, 겹치면 그리기가 어긋나 **줄을 잘못 지운다**(그쪽 types.ts 의
    //    `key`). 접두사가 무엇이든 이것은 참이어야 한다.
    //
    // 🔴 겹칠 여지는 줄어든 것이 아니라 **늘었다.** 예전에는 우리 접두사가
    //    `self` 라 포털 것과 글자가 달라 겹칠 수가 **없었는데**, 지금은 양쪽
    //    모양이 같아졌다(`{client_id}:{id}`). 포털이 우리 줄을 **함께 보내게
    //    되는 날** — portal-notifications.ts 의 `ownNotificationSourceId` 주석이
    //    말하는 그 날, 필요한 것은 접두사를 다시 가르는 것이 아니라 중복
    //    제거다 — **이 검사가 먼저 운다.**
    const own = await ownFeed([
      approval({ stepId: "s-1" }),
      approval({ stepId: "s-2", applicantName: "박사원" }),
    ]);
    const received = normalizePortalNotificationFeed({
      items: [row({ key: "rf-service-system:APPROVAL:1" }), row({ key: "njlee:CAL:2" })],
      count: 2,
    });

    const keys = bellFeedWithOwnFirst({ own, received }).items.map((item) => item.key);

    // 🔴 **표본이 비어서 공짜로 통과하지 않게** 한다. 빈 목록도, 한쪽만 있는
    //    목록도 「열쇠가 전부 다르다」를 만족한다 — 겹침은 **양쪽이 한자리에
    //    모였을 때만** 생기므로, 둘 다 하나 이상이 실제로 실렸는지 먼저 본다.
    assert.ok(own.items.length > 0, "우리 줄 표본이 없다");
    assert.ok(received.items.length > 0, "포털 줄 표본이 없다");
    assert.equal(
      keys.length,
      own.items.length + received.items.length,
      "합치다 줄이 샜다 — 한쪽만 세고 있으면 겹침을 영영 못 본다",
    );
    assert.ok(keys.includes("njlee:CAL:2"), "포털 줄이 합친 목록에 없다");

    assert.equal(new Set(keys).size, keys.length, `🔴 열쇠가 겹쳤다: ${keys.join(" / ")}`);
  });

  check("🔴 설정이 없어도 **던지지 않는다** — 종은 모든 화면에 딸려 온다", () => {
    // 임시 로그인만 쓰는 PC 에는 SSO_CLIENT_ID 가 아예 없다. 여기서 던지면
    // 종 하나 때문에 화면 전체가 500 이 된다.
    const before = process.env.SSO_CLIENT_ID;
    delete process.env.SSO_CLIENT_ID;
    try {
      assert.equal(ownNotificationSourceId(), OWN_SOURCE_ID_FALLBACK);
      // 줄은 예전 그대로 그려진다 — 물러섰을 때 안 되는 것은 **제 줄 지움을
      // 포털에 적는 것**뿐이다(포털이 `self` 를 모른다).
      const drawn = toOwnBellItem({
        id: `${LEAVE_APPROVAL_KIND}:s-1`,
        kind: LEAVE_APPROVAL_KIND,
        kindLabel: "휴가 결재 대기",
        subject: "김대리",
        detail: "연차",
        href: `${OWN_BASE_URL}${APPROVALS_PATH}`,
      });
      assert.equal(drawn.key, `${OWN_SOURCE_ID_FALLBACK}:${LEAVE_APPROVAL_KIND}:s-1`);
    } finally {
      process.env.SSO_CLIENT_ID = before;
    }
  });

  await checkAsync("🔴 포털이 지웠다고 한 **우리 줄**을 뺀다 — 개수도 함께 줄인다", async () => {
    // 안 거르면 「휴가에서 지웠는데 휴가 종에만 그대로 뜬다」가 된다.
    const own = await ownFeed([approval({ stepId: "s-1" }), approval({ stepId: "s-2" })]);
    const received = normalizePortalNotificationFeed({
      items: [row({ key: "njlee:CAL:2" })],
      count: 1,
      // 🔴 포털은 **이 사이트 몫의 열쇠만** 싣는다. 남의 줄은 제 손으로 이미
      //    걸러서 보낸다(items·count 양쪽에서 빠져 있다).
      dismissed: [`${OWN}:${LEAVE_APPROVAL_KIND}:s-1`],
    });

    const bell = bellFeedWithOwnFirst({ own, received });
    assert.deepEqual(drawnKeys(bell), [`${OWN}:${LEAVE_APPROVAL_KIND}:s-2`, "njlee:CAL:2"]);
    assert.equal(bell.count, 2, "1(남은 내 것) + 1(포털이 센 값) 이 아니다");
  });

  check("🔴 `dismissed` 를 모르는 판의 답에도 예전 그대로 돈다", () => {
    // 칸이 없거나 글자가 아닌 것이 섞여 와도 Set 에 쓰레기가 들어가지 않는다.
    assert.deepEqual(normalizePortalNotificationFeed({ items: [], count: 0 }).dismissed, []);
    assert.deepEqual(
      normalizePortalNotificationFeed({ dismissed: ["a", 7, null, "b"] }).dismissed,
      ["a", "b"],
    );
  });

  await checkAsync("자기 줄에는 시스템 이름을 적지 않는다 — 여기가 휴가다", async () => {
    const own = await ownFeed([approval()]);
    const mine = toOwnBellItem(own.items[0]);
    assert.equal(mine.sourceName, "", "자기 줄에 시스템 이름을 적었다");
    assert.equal(mine.sourceId, OWN);

    const drawn = flatten(NotificationBell({ items: [mine], count: 1 }));
    assert.equal(
      drawn.some((el) => el.props.className === "dss-bell__source"),
      false,
      "빈 이름인데 시스템 이름 칸이 그려졌다",
    );
    // 종류 이름은 그린다 — 남의 줄과 구별되는 것은 이것뿐이다.
    const kind = drawn.find((el) => el.props.className === "dss-bell__kind");
    assert.equal(kind?.props.children, "휴가 결재 대기");
  });

  await checkAsync("자기 줄은 창구가 내주는 아홉 칸에 세 칸만 덧붙인 것이다", async () => {
    const own = await ownFeed([approval({ stepId: "s-1", applicantName: "김대리" })]);
    const source = own.items[0];
    const mine = toOwnBellItem(source);

    assert.deepEqual(Object.keys(mine).sort(), [
      "detail",
      "href",
      "id",
      "key",
      "kind",
      "kindLabel",
      "sourceId",
      "sourceName",
      "subject",
    ]);
    // 나머지 여섯 칸은 창구가 내주는 값 그대로다 — 링크도 손대지 않는다.
    assert.equal(mine.id, source.id);
    assert.equal(mine.kind, LEAVE_APPROVAL_KIND);
    assert.equal(mine.subject, "김대리");
    assert.equal(mine.detail, source.detail);
    assert.equal(mine.href, `${OWN_BASE_URL}${APPROVALS_PATH}`);
  });

  check("🔴 화면이 결재 판정을 다시 쓰지 않는다 — 창구가 부르는 그 함수를 그대로 부른다", () => {
    // 화면이 따로 계산하면 「종에 보이는 것」과 「포털에 내주는 것」이 갈라진다.
    const bell = withoutComments(read("src/components/PortalNotificationBell.tsx"));
    const route = withoutComments(read("src/app/api/integration/notifications/route.ts"));
    for (const [name, source] of [
      ["종", bell],
      ["창구", route],
    ] as const) {
      assert.ok(source.includes("buildPortalNotificationFeed({"), `${name}: 그 함수를 안 부른다`);
      assert.ok(source.includes("findActor: findPortalActor"), `${name}: 사람 되짚기가 다르다`);
      assert.ok(
        source.includes("listPendingApprovals: pendingApprovalNotifications"),
        `${name}: 고르는 질의가 다르다`,
      );
    }
    assert.equal(
      /myPendingApprovalWhere|myStepCondition|drizzle-orm/.test(bell),
      false,
      "🔴 종이 결재 판정을 손으로 다시 적었다",
    );
    // 🔴 2026-10-22 까지는 여기서 「자기 알림에 확인 기능을 붙이지 않았다」를
    //    단언했다. 이제는 **붙인다** — 대신 제 줄이면 isOwnBellItem 이 걸러
    //    acknowledgeNotificationAction 안에서 멈춘다(아래 「8. 확인」절).
    //    「결재하지 않은 일을 종에서 지우기」가 생기지 않는 것은 그 울타리가
    //    지킨다 — 여기서는 결재 판정을 다시 쓰지 않는지만 본다.
  });

  check("🔴 자기 알림을 읽다 실패해도 화면이 500 이 되지 않는다", () => {
    // 이 종은 모든 화면에 딸려 오고 <Suspense> 안에 error boundary 가 없다.
    const bell = withoutComments(read("src/components/PortalNotificationBell.tsx"));
    const own = bell.slice(bell.indexOf("async function ownNotifications"));
    assert.ok(own.includes("try {"), "감싸지 않았다");
    assert.ok(
      own.indexOf("env.appBaseUrl") > own.indexOf("try {"),
      "🔴 설정이 없으면 던지는 getter 를 try 밖에서 읽는다",
    );
    assert.ok(own.includes("return NO_OWN;"), "실패했을 때 빈 목록을 돌려주지 않는다");
    assert.equal(/\bthrow\b/.test(own), false, "🔴 자기 알림 통로가 던진다");
    // 오류 객체를 통째로 찍지 않는다 — 접속 문자열이 딸려 나올 수 있다.
    assert.ok(own.includes('error instanceof Error ? error.name : "unknown"'));
  });

  /* ---------------------------------------------------------------- */
  /* 7. 🔴 보이는 알림 지우기 (일괄)                                     */
  /*    묶음이 단추·글자·개수를 그리고(@dss/ui 1210d11), 사이트는 지울    */
  /*    열쇠를 묶어 넘기기만 한다. 🔴 이 사이트에는 **제 알림이 있어서**  */
  /*    받은 목록만 묶으면 「전부 지우기를 눌렀는데 내 알림만 남는다」.    */
  /* ---------------------------------------------------------------- */

  await checkAsync(
    "🔴 열쇠에 **제 줄과 포털 줄이 둘 다** 들어간다 — 받은 것만 묶으면 내 알림만 남는다",
    async () => {
      const own = await ownFeed([
        approval({ stepId: "s-1" }),
        approval({ stepId: "s-2", applicantName: "박사원" }),
      ]);
      const received = normalizePortalNotificationFeed({
        items: [row({ key: "rf-service-system:APPROVAL:1" }), row({ key: "njlee:CAL:2" })],
        count: 2,
      });

      // 🔴 화면이 묶는 그 목록이다 — **합쳐진 뒤**의 items(bellFeedWithOwnFirst).
      const bell = bellFeedWithOwnFirst({ own, received });
      const keys = visibleNotificationKeys(bell.items);

      assert.deepEqual(keys, [
        `${OWN}:${LEAVE_APPROVAL_KIND}:s-1`,
        `${OWN}:${LEAVE_APPROVAL_KIND}:s-2`,
        "rf-service-system:APPROVAL:1",
        "njlee:CAL:2",
      ]);
      // 표본이 한쪽만이면 이 검사가 공짜로 통과한다 — 양쪽이 실제로 실렸는지 본다.
      assert.equal(own.items.length, 2, "우리 줄 표본이 없다");
      assert.equal(received.items.length, 2, "포털 줄 표본이 없다");
      assert.ok(
        keys.some((key) => key.startsWith(`${OWN}:`)),
        "🔴 제 줄의 열쇠가 하나도 없다 — 눌러도 내 결재 알림만 남는다",
      );
      assert.ok(
        keys.some((key) => !key.startsWith(`${OWN}:`)),
        "🔴 포털 줄의 열쇠가 하나도 없다",
      );
    },
  );

  await checkAsync("🔴 포털이 지웠다고 한 제 줄은 열쇠에서도 빠진다", async () => {
    // 종에서 빠진 줄이 열쇠에는 남아 있으면, 이미 지운 것을 한 번 더 보낸다.
    const own = await ownFeed([approval({ stepId: "s-1" }), approval({ stepId: "s-2" })]);
    const received = normalizePortalNotificationFeed({
      items: [row({ key: "njlee:CAL:2" })],
      count: 1,
      dismissed: [`${OWN}:${LEAVE_APPROVAL_KIND}:s-1`],
    });

    const bell = bellFeedWithOwnFirst({ own, received });
    assert.deepEqual(visibleNotificationKeys(bell.items), [
      `${OWN}:${LEAVE_APPROVAL_KIND}:s-2`,
      "njlee:CAL:2",
    ]);
  });

  await checkAsync(
    "🔴 단추에 적힌 **수**와 묶어 보내는 열쇠 수가 같다 — 그릴 수 없는 주소는 양쪽에서 빠진다",
    async () => {
      // 묶음은 그릴 수 없는 주소의 줄을 **안 그리고** 단추의 수도 그렇게 남은
      // 줄 수다. 여기서 거르지 않으면 「3건」을 눌렀는데 4건이 지워진다.
      const own = await ownFeed([approval({ stepId: "s-1" })]);
      const received = normalizePortalNotificationFeed({
        items: [
          row({ key: "a" }),
          // 🔴 거르는지 보려고 일부러 넣는다 — 눌리면 그 화면에서 남의 코드가 돈다.
          row({ key: "나쁜줄", href: "javascript:alert(1)" }),
          row({ key: "b", href: "//evil.example/x" }),
          row({ key: "c" }),
        ],
        count: 4,
      });

      const bell = bellFeedWithOwnFirst({ own, received });
      // 합친 목록에는 다섯 줄이 다 있다 — 거르는 일은 그리는 자리와 여기서 한다.
      assert.equal(bell.items.length, 5, "표본이 줄었다 — 거를 줄이 없으면 검사가 공짜다");

      const keys = visibleNotificationKeys(bell.items);
      assert.deepEqual(keys, [`${OWN}:${LEAVE_APPROVAL_KIND}:s-1`, "a", "c"]);

      // 🔴 묶음이 실제로 그리는 줄과 **같은 수**인지 맞대어 본다.
      assert.deepEqual(drawnKeys(bell), keys, "그려지는 줄과 묶는 열쇠가 다르다");

      // 🔴 그리고 단추에 적히는 글자와도 같다.
      const button = flatten(NotificationBell({ ...bell, onDismissAll: () => {} })).find(
        (el) => el.props.className === "dss-bell__dismissall",
      );
      assert.equal(
        button?.props.children,
        `보이는 알림 지우기 ${keys.length}건`,
        "🔴 단추에 적힌 수와 보내는 열쇠 수가 다르다",
      );
    },
  );

  check("🔴 함수를 넘겨야만 단추가 선다 — 안 넘기면 마크업이 예전 그대로다", () => {
    const feed = normalizePortalNotificationFeed({ items: [row({ key: "a" })], count: 1 });
    const before = flatten(NotificationBell(feed)).some(
      (el) => el.props.className === "dss-bell__dismissall",
    );
    assert.equal(before, false, "안 넘겼는데 단추가 그려졌다");
    const after = flatten(NotificationBell({ ...feed, onDismissAll: () => {} })).some(
      (el) => el.props.className === "dss-bell__dismissall",
    );
    assert.equal(after, true, "넘겼는데 단추가 없다");
  });

  check("🔴 묶는 목록은 **합쳐진 것**이다 — 소스에서 못 박는다", () => {
    const bell = withoutComments(read("src/components/PortalNotificationBell.tsx"));
    assert.ok(
      bell.includes("visibleNotificationKeys(bell.items)"),
      "🔴 합쳐진 목록이 아닌 것으로 묶는다 — 제 알림이 안 지워진다",
    );
    assert.equal(
      /visibleNotificationKeys\(\s*received/.test(bell),
      false,
      "🔴 받은 목록만으로 묶었다",
    );
    // 🔴 값을 미리 묶어 넘긴다 — 서버 컴포넌트라 평범한 화살표 함수는 경계를
    //    못 건넌다. `onDismissAll={() => …}` 로 적으면 그 자리에서 터진다.
    assert.ok(
      bell.includes("dismissAllNotificationsAction.bind(") && bell.includes("onDismissAll={"),
      "묶어 넘기지 않는다",
    );
    assert.equal(
      /onDismissAll=\{\s*(\(|async)/.test(bell),
      false,
      "🔴 화살표 함수를 넘겼다 — 클라이언트 경계를 못 건넌다",
    );
    assert.equal(bell.includes('"use client"'), false, "종이 클라이언트로 넘어갔다");
  });

  check("🔴 빈 열쇠는 보내지 않는다 — 포털이 그 묶음을 400 으로 거절한다", () => {
    assert.deepEqual(
      visibleNotificationKeys([
        { ...row({ key: "" }), key: "" } as unknown as NotificationBellItem,
        row({ key: "a" }) as unknown as NotificationBellItem,
      ]),
      ["a"],
    );
  });

  check("🔴 브라우저가 돌려보낸 값을 믿지 않는다 — 배열이 아니면 아무 일도 없다", () => {
    // 이 목록은 bind 로 브라우저에 내려갔다가 **되돌아오는** 값이다. tsc 가
    // 지키는 범위 밖이라 모양을 여기서 가린다.
    for (const bad of [null, undefined, "열쇠", 7, { 0: "a" }]) {
      assert.equal(vetDismissKeys(bad), null, `${JSON.stringify(bad)} 를 받아들였다`);
    }
    // 🔴 「보낼 것이 없다」와 「믿을 수 없다」는 다른 답이다.
    assert.deepEqual(vetDismissKeys([]), []);
  });

  check("모양이 틀린 칸은 **그 칸만** 버린다 — 한 칸 때문에 단추가 죽지 않는다", () => {
    assert.deepEqual(vetDismissKeys(["a", 7, null, "", { key: "b" }, "c"]), ["a", "c"]);
  });

  check("🔴 울타리를 넘으면 **잘라 보내지 않고 통째로 거절한다**", () => {
    // 잘라 보내면 단추에 적힌 「n건」과 실제로 지워진 수가 달라진다.
    const many = Array.from({ length: MAX_DISMISS_KEYS_AT_ONCE }, (_, i) => `k:${i}`);
    assert.equal(vetDismissKeys(many)?.length, MAX_DISMISS_KEYS_AT_ONCE, "상한 딱 맞는데 거절했다");
    assert.equal(vetDismissKeys([...many, "k:넘침"]), null, "🔴 상한을 넘었는데 통과했다");
  });

  check("🔴 울타리는 **정직한 종**이 들 수 있는 양 위에 있다", () => {
    // 포털은 한 시스템당 200줄에서 자르고(dss-auth 의 merge.ts), 부른 사이트
    // 자신에게는 묻지 않는다 — 사내 일곱 중 여섯 × 200 = 1200 이 받는 쪽 상한이다.
    // 제 줄(지금 내 차례인 결재)에는 DB 상한이 없어 그 위 여유가 몫이다.
    const RECEIVED_CEILING = 6 * 200;
    assert.ok(
      MAX_DISMISS_KEYS_AT_ONCE > RECEIVED_CEILING,
      `🔴 울타리(${MAX_DISMISS_KEYS_AT_ONCE})가 받는 쪽 상한(${RECEIVED_CEILING}) 아래다 — 정직한 누름이 거절된다`,
    );
  });

  check("🔴 일괄 지움도 `sub` 을 인자로 받지 않는다 — 서버가 제 세션에서 읽는다", () => {
    // 받으면 브라우저가 아무 번호나 실어 남의 알림을 지울 수 있다.
    const source = withoutComments(read("src/app/actions/notifications.ts"));
    const all = source.slice(source.indexOf("export async function dismissAllNotificationsAction"));
    assert.ok(all.includes("dismissAllNotificationsAction(keys: readonly string[])"));
    assert.equal(/sub|authSub[^.]/.test(all.split("\n")[0]), false, "🔴 인자에 sub 이 있다");
    assert.ok(all.includes("const viewer = await getViewer();"), "세션을 다시 읽지 않는다");
    assert.ok(all.includes("viewer.user.authSub"), "제 세션의 값을 쓰지 않는다");
    // 🔴 `redirect` 하는 requireViewer 가 아니다 — 세션이 막 끊겼다고 보던
    //    화면이 로그인으로 튀어서는 안 된다(✕ 와 같은 판단).
    assert.equal(/requireViewer|requireSession/.test(all), false, "🔴 튕기는 문지기를 썼다");
  });

  check("🔴 일괄 지움은 던지지 않고, 열쇠도 건수도 로그에 찍지 않는다", () => {
    // @dss/ui 의 곁들이 조각이 이 함수를 누름 처리 한가운데서 부른다 — 여기서
    // 예외가 새면 그 누름의 나머지 처리가 통째로 멈춘다.
    const source = withoutComments(read("src/app/actions/notifications.ts"));
    const all = source.slice(source.indexOf("export async function dismissAllNotificationsAction"));
    assert.ok(all.includes("try {"), "감싸지 않았다");
    assert.equal(/\bthrow\b/.test(all), false, "🔴 일괄 지움이 던진다");
    assert.ok(all.includes('name: error instanceof Error ? error.name : "unknown"'));
    // 열쇠에는 결재 단계 id 가 들어 있다. 찍는 것은 오류의 종류뿐이다.
    assert.equal(/console\.error\([^)]*\b(keys|wanted)\b/.test(all), false, "🔴 열쇠를 찍는다");
    assert.equal(/\.length\s*\)/.test(all.slice(all.indexOf("catch"))), false, "🔴 건수를 찍는다");
  });

  check("🔴 일괄은 「전부 적혔는가」를 **보지 않고** 되살린다 — 줄 하나짜리 ✕ 와 반대다", () => {
    // 열쇠가 200개를 넘으면 포털로 여러 묶음이 나가고(oidc.ts), 돌아오는 값은
    // 「전부 적혔는가」다 — 가운데 하나가 거절돼도 나머지는 적혔다. 그때 안
    // 되살리면 이미 지워진 줄이 종에 그대로 남는다.
    const source = withoutComments(read("src/app/actions/notifications.ts"));
    const one = source.slice(
      source.indexOf("export async function dismissNotificationAction"),
      source.indexOf("export async function dismissAllNotificationsAction"),
    );
    const all = source.slice(source.indexOf("export async function dismissAllNotificationsAction"));

    // 줄 하나짜리는 적힌 것을 보고서야 되살린다(지금 모습 그대로다).
    assert.ok(one.includes("if (!recorded) return;"), "✕ 쪽의 판단이 바뀌었다");
    // 일괄은 답을 받아 두지 않는다 — 기다리기만 하고 곧바로 되살린다.
    assert.ok(all.includes("await dismissPortalNotifications(viewer.user.authSub, wanted);"));
    assert.equal(/recorded|if \(!await/.test(all), false, "🔴 「전부 적혔는가」로 갈랐다");
    assert.ok(all.includes('revalidatePath("/", "layout");'), "되살리지 않는다");
  });

  check("🔴 울타리에 걸린 값은 포털까지 가지 않는다 — 부르기 **전에** 멈춘다", () => {
    const source = withoutComments(read("src/app/actions/notifications.ts"));
    const all = source.slice(source.indexOf("export async function dismissAllNotificationsAction"));
    const vetAt = all.indexOf("vetDismissKeys(keys)");
    const sendAt = all.indexOf("dismissPortalNotifications(");
    assert.ok(vetAt > 0 && sendAt > vetAt, "🔴 가리기 전에 포털을 부른다");
    assert.ok(all.includes("if (wanted === null) return;"), "거절 값을 그냥 보낸다");
    assert.ok(all.includes("if (wanted.length === 0) return;"), "빈 묶음을 보낸다");
  });

  /* ---------------------------------------------------------------- */
  /* 8. 🔴 확인(onAcknowledge) — 제 줄은 포털을 부르지 않는다 (2026-10-22)  */
  /*    남의 시스템 줄은 포털에 「확인했다」를 적을 수 있지만, 이 사이트    */
  /*    자신의 결재 대기(「지금 내 차례인 휴가 결재」)는 포털이 애초에      */
  /*    모르는 목록이라 보내면 조용히 버려지고, 분류가 바뀌면 결재 대기가  */
  /*    조용히 사라지는 길이 열린다 — 그래서 제 줄은 아예 보내지 않는다.   */
  /* ---------------------------------------------------------------- */

  const notificationsAction = withoutComments(read("src/app/actions/notifications.ts"));

  /** 자기 줄 하나 — toOwnBellItem 이 실제로 만드는 그 모양. */
  function ownBellItem(): NotificationBellItem {
    return toOwnBellItem({
      id: `${LEAVE_APPROVAL_KIND}:s-1`,
      kind: LEAVE_APPROVAL_KIND,
      kindLabel: "휴가 결재 대기",
      subject: "김대리",
      detail: "연차",
      href: `${OWN_BASE_URL}${APPROVALS_PATH}`,
    });
  }

  check("🔴 isOwnBellItem — 제 줄은 true, 포털 줄은 false다", () => {
    const mine = ownBellItem();
    assert.equal(mine.sourceId, OWN, "자기 줄의 sourceId 가 이 시스템의 client_id 가 아니다");
    assert.equal(isOwnBellItem(mine), true, "🔴 제 줄인데 포털 줄로 읽힌다");

    // 포털이 주는 줄(row())의 sourceId 는 다른 시스템의 client_id 다.
    assert.equal(isOwnBellItem(row() as unknown as NotificationBellItem), false, "🔴 포털 줄인데 제 줄로 읽힌다");
    assert.equal(isOwnBellItem({ sourceId: "" }), false);
    assert.equal(isOwnBellItem({ sourceId: "njlee" }), false, "남의 시스템과 우리 것을 헷갈렸다");
  });

  check(
    "🔴 설정이 없는 PC 에서도 — 자기 줄은 OWN_SOURCE_ID_FALLBACK 로 여전히 걸린다",
    () => {
      // ownNotificationSourceId() 가 물러서는 값("self")과 isOwnBellItem 이
      // 비교하는 값은 **같은 호출**이라 환경이 무엇이든 어긋나지 않는다.
      const before = process.env.SSO_CLIENT_ID;
      delete process.env.SSO_CLIENT_ID;
      try {
        assert.equal(ownNotificationSourceId(), OWN_SOURCE_ID_FALLBACK);
        assert.equal(isOwnBellItem({ sourceId: OWN_SOURCE_ID_FALLBACK }), true);
      } finally {
        process.env.SSO_CLIENT_ID = before;
      }
    },
  );

  await checkAsync(
    "🔴 확인은 포털의 **확인** 통로로 나간다 — 지움 통로가 아니다",
    async () => {
      heard = null;
      answer = json(200, { recorded: 1, dropped: 0, skipped: 0 });
      const recorded = await acknowledgePortalNotification(SUB, "njlee:CAL:2");
      assert.equal(recorded, true);

      assert.ok(heard, "포털에 닿지 않았다");
      const asked = heard as Heard;
      assert.equal(
        asked.path,
        "/api/integration/notification-acknowledgements",
        "🔴 확인이 엉뚱한 통로로 나간다",
      );
      assert.equal(
        asked.path?.includes("notification-dismissals"),
        false,
        "🔴 지움 통로로 갔다",
      );
      assert.equal(asked.method, "POST");
      assert.ok((asked.authorization ?? "").startsWith("Basic "));
      assert.equal(asked.contentType, "application/x-www-form-urlencoded");
      // 칸 이름은 열쇠가 하나여도 `keys` 다 — 지움 통로와 같은 모양이다.
      assert.equal(asked.body, `sub=${SUB}&keys=njlee%3ACAL%3A2`);
    },
  );

  await checkAsync(
    "🔴 ***제 줄을 넘기면 포털을 안 부른다*** — 이 조각에서 가장 중요한 시험",
    async () => {
      // 🔴 실제 서버 액션(acknowledgeNotificationAction)은 세션(DB)이 있어야
      //    불러 볼 수 있다 — 이 검사는 DB 에 닿지 않는 것이 이 파일의 약속이라
      //    (머리말 참조) 그 함수를 직접 부르지 못한다. 그래서 그 함수가 **실제로
      //    쓰는 두 재료** — isOwnBellItem(판정)과 acknowledgePortalNotification
      //    (전송) — 를 **그 함수와 같은 차례**로 실행해 재고, 그 차례가 소스와
      //    글자까지 같은지는 바로 아래 절이 맞댄다.
      const mine = ownBellItem();

      heard = null;
      answer = json(200, { recorded: 1, dropped: 0, skipped: 0 });

      // acknowledgeNotificationAction 의 몸통과 같은 차례: 가르고 나서야 보낸다.
      if (!isOwnBellItem(mine)) {
        await acknowledgePortalNotification(SUB, mine.key);
      }
      assert.equal(heard, null, "🔴 제 줄인데 포털에 닿았다 — skipped 로 조용히 버려질 값이다");

      // 대조군: 남의 줄이면 같은 차례로 실제 호출이 나간다.
      const theirs = row({ key: "njlee:CAL:9" }) as unknown as NotificationBellItem;
      if (!isOwnBellItem(theirs)) {
        await acknowledgePortalNotification(SUB, theirs.key);
      }
      assert.ok(heard, "🔴 남의 줄인데도 포털에 안 닿았다 — 울타리가 전부를 막았다");
      assert.equal((heard as Heard).body, `sub=${SUB}&keys=njlee%3ACAL%3A9`);
    },
  );

  check(
    "🔴 실제 액션도 **같은 차례** — isOwnBellItem 으로 먼저 거르고서야 포털을 부른다",
    () => {
      const at = notificationsAction.indexOf(
        "export async function acknowledgeNotificationAction",
      );
      assert.notEqual(at, -1, "acknowledgeNotificationAction 을 찾지 못했다");
      const body = notificationsAction.slice(at, notificationsAction.indexOf("\n}\n", at) + 3);
      assert.ok(body.length > 50, "잘라 낸 토막이 비었다 — 시험이 아무것도 못 본다");

      const gateAt = body.indexOf("if (isOwnBellItem(item)) return;");
      const sendAt = body.indexOf("acknowledgePortalNotification(");
      assert.ok(gateAt > 0, "🔴 제 줄을 거르는 울타리가 없다");
      assert.ok(sendAt > gateAt, "🔴 포털을 부른 **뒤에** 가른다 — 이미 늦었다");
    },
  );

  check("🔴 종에 확인 서버 액션을 넘긴다 — 안 넘기면 눌러도 아무 일도 안 일어난다", () => {
    const bell = withoutComments(read("src/components/PortalNotificationBell.tsx"));
    assert.match(
      bell,
      /import \{[\s\S]*?\backnowledgeNotificationAction\b[\s\S]*?\} from "@\/app\/actions\/notifications";/,
    );
    assert.match(
      bell,
      /<NotificationBell[\s\S]*?onAcknowledge=\{acknowledgeNotificationAction\}[\s\S]*?\/>/,
    );
  });

  check("🔴 [X] 와 「보이는 알림 지우기」는 **그대로** 지움으로 간다 — 확인으로 안 옮겨 갔다", () => {
    const bell = withoutComments(read("src/components/PortalNotificationBell.tsx"));
    assert.match(
      bell,
      /<NotificationBell[\s\S]*?onDismiss=\{dismissNotificationAction\}[\s\S]*?\/>/,
    );
    assert.match(bell, /<NotificationBell[\s\S]*?onDismissAll=\{dismissAll\}[\s\S]*?\/>/);

    const dismissAt = notificationsAction.indexOf(
      "export async function dismissNotificationAction",
    );
    // 🔴 이 함수 바로 다음에 오는 것은 acknowledgeNotificationAction 이다
    //    (dismissAllNotificationsAction 이 아니다) — 그걸로 자르면 그 사이의
    //    acknowledgeNotificationAction 몸통까지 슬라이스에 딸려 들어와
    //    "acknowledgePortalNotification" 글자가 **엉뚱하게** 걸린다.
    const nextAt = notificationsAction.indexOf(
      "export async function acknowledgeNotificationAction",
    );
    const dismissOne = notificationsAction.slice(dismissAt, nextAt);
    assert.ok(dismissOne.length > 50, "dismissNotificationAction 토막이 비었다");
    assert.equal(
      dismissOne.includes("acknowledgePortalNotification"),
      false,
      "🔴 ✕ 가 확인까지 적는다 — 지운 줄이 재로그인해도 안 돌아온다",
    );
  });

  check("🔴 확인 액션이 사람 번호를 인자로 받지 않는다 — 세션에서 읽는다", () => {
    const at = notificationsAction.indexOf("export async function acknowledgeNotificationAction");
    const open = notificationsAction.indexOf("{", at);
    const head = notificationsAction.slice(at, open);
    assert.equal(/\bsub\b|subject/.test(head), false, "🔴 사람 번호를 인자로 받는다");
    assert.match(
      head,
      /acknowledgeNotificationAction\(\s*item: NotificationBellItem,?\s*\)/,
      "받는 모양이 바뀌었다",
    );
    const at2 = notificationsAction.indexOf(
      "export async function acknowledgeNotificationAction",
    );
    const tail = notificationsAction.slice(at2);
    assert.ok(tail.includes("const viewer = await getViewer();"), "세션에서 다시 읽지 않는다");
    assert.ok(tail.includes("viewer.user.authSub"), "제 세션의 값을 쓰지 않는다");
    assert.equal(
      /requireViewer|requireSession/.test(tail.slice(0, tail.indexOf("}"))),
      false,
      "🔴 종 하나 때문에 화면이 포털 로그인으로 튄다",
    );
  });

  check("🔴 확인 액션이 던지지 않는다 — 이 함수는 화면 이동 한가운데서 불린다", () => {
    const at = notificationsAction.indexOf("export async function acknowledgeNotificationAction");
    const tail = notificationsAction.slice(at, notificationsAction.indexOf("\n}\n", at) + 3);
    assert.ok(tail.includes("try {"), "감싸지 않았다");
    assert.ok(tail.includes("} catch (error) {"), "거절을 받아 주지 않는다");
    assert.equal(/\bthrow\b/.test(tail), false, "🔴 확인 액션이 던진다 — 이동까지 흔들린다");
  });

  check(
    "🔴 @dss/ui 가 확인 함수를 try 로 감싼다 — 던져도 이동이 막히지 않는다",
    () => {
      // 이동은 평범한 <a href> 가 한다. 누름 한가운데서 예외가 새면 그 이동까지
      // 흔들리므로, vendor/dss-ui 가 한 겹 받아 준다. 포인터가 옛 커밋이면
      // 이 자리가 없어 여기서 걸린다.
      const behavior = withoutComments(
        read("vendor/dss-ui/src/notification-bell/BellBehavior.tsx"),
      );
      const squeeze = (s: string) => s.replace(/\s+/g, " ");
      assert.match(
        squeeze(behavior),
        /try \{ onAcknowledge\(item\); \} catch \{/,
        "🔴 @dss/ui 가 확인 함수를 감싸지 않는다",
      );
    },
  );

  check("🔴 낡아진 까닭이 주석에 남아 있지 않다 — 메모(제 알림이 생기면)는 남는다", () => {
    const bellRaw = read("src/components/PortalNotificationBell.tsx");
    assert.equal(
      bellRaw.includes("확인(onAcknowledge)을 넘기지 않는 이유"),
      false,
      "🔴 낡은 까닭 제목이 그대로 있다",
    );
    assert.equal(
      bellRaw.includes("이 사이트에는 적을 자리가 없다. 줄을"),
      false,
      "🔴 낡은 까닭의 본문이 그대로 있다 — 「적을 곳이 없다」전제는 사라졌다",
    );
    // 🔴 가르는 자리(제 줄 울타리)가 **이름으로** 남아야 한다 — 다음 사람이
    //    여기를 읽고 isOwnBellItem 을 찾아갈 수 있어야 한다.
    assert.ok(bellRaw.includes("isOwnBellItem"), "🔴 제 줄 울타리를 가리키는 이름이 주석에 없다");
  });

  portal.closeAllConnections();
  await new Promise<void>((resolve) => portal.close(() => resolve()));

  console.log(`\n${passed}개 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
