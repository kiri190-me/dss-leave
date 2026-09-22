import { NotificationBell } from "@dss/ui";

import { fetchPortalNotifications } from "@/lib/auth/oidc";
import { findPortalActor } from "@/lib/auth/portal-actor";
import { env } from "@/lib/env";
import { pendingApprovalNotifications } from "@/lib/leave/data";
import {
  bellFeedWithOwnFirst,
  buildPortalNotificationFeed,
  type PortalNotificationFeed,
} from "@/lib/leave/portal-notifications";

/**
 * 머리말의 알림 종 — **이 사이트의 결재 대기 + 다른 시스템들의** 알림을 그린다.
 *
 * 사내 시스템이 다섯인데(A/S · 개선요청 · 계측기 · PO/내자 · 휴가) 종은 A/S
 * 에만 있었다. 「어느 시스템에 있든 같은 알림을 본다」를 위해 포털이 모든
 * 시스템에 물어 합쳐 주는 통로를 열었고, 이 조각이 그것을 이 사이트에
 * 끌어온다(부르는 법: dss-auth/docs/사이트-알림-통로.md).
 *
 * ── 🔴 자기 알림은 포털이 주지 않는다 ───────────────────────────────────
 * 포털은 **부른 사이트 자신의 알림을 빼고** 답한다(되돌기 방지 + 30초 캐시가
 * 사이트마다 다른 답을 들고 있어야 하기 때문 — dss-auth 의 site-feed.ts).
 * 그래서 PO·계측기·개선요청에서는 휴가 결재 알림이 뜨는데 휴가 자신의 종에서는
 * 뜨지 않았다(2026-09-22 사용자 확인). 이 조각이 **자기 것을 앞에 이어 붙여**
 * 그 구멍을 막는다.
 *
 * 🔴 자기 줄은 **포털에 내주는 그 함수**가 만든다(buildPortalNotificationFeed
 * — 창구 api/integration/notifications 가 부르는 그것). 화면이 따로 계산하면
 * 「종에 보이는 것」과 「포털에 내주는 것」이 갈라진다. 묶음이 요구하는 세
 * 칸만 덧붙이는 일은 portal-notifications.ts 의 toOwnBellItem 이 한다.
 *
 * ── 🔴 왜 **서버**에서 가져오나 (브라우저가 아니라) ──────────────────────
 * 자격증명이 `client_secret` 이라 브라우저에서는 부를 수 없다. 브라우저에서
 * 가져오려면 이 사이트 안에 중계 통로(route handler)를 하나 더 두고, 거기서
 * 세션을 다시 검증하고, 종을 클라이언트 조각으로 바꾸고, 그 왕복이 도는 동안의
 * 상태까지 다뤄야 한다 — **시크릿을 다루는 자리를 하나 더 만드는** 일이다.
 * 서버에서 부르면 시크릿은 이 프로세스 밖으로 나가지 않고, 종은 지금처럼
 * 자바스크립트 없이도 열리는 서버 조각(@dss/ui 의 `<details>`)으로 남는다.
 *
 * 🔴 그 대신 **모든 화면 이동이 이 왕복만큼 느려지는** 것을 막아야 한다.
 *    그래서 부르는 쪽((internal)/layout.tsx)이 이 조각을 `<Suspense>` 로
 *    감싼다 — 머리말과 본문은 먼저 뜨고 종만 나중에 흘러 들어온다. 포털이
 *    느리거나 죽어도 사람이 기다리는 시간은 늘지 않는다. 왕복 자체에도 상한이
 *    걸려 있다(oidc.ts 의 NOTIFICATIONS_TIMEOUT_MS).
 *
 * ── 🔴 다시 묻는 주기는 두지 않는다 ─────────────────────────────────────
 * 브라우저에서 몇 초마다 다시 묻는 장치를 붙이지 않았다. 포털이 이미 30초
 * 캐시를 들고 있어 그보다 자주 물으면 **같은 답**을 받고, 그 장치를 붙이는
 * 순간 위에서 피한 중계 통로가 도로 필요해진다. 종은 화면을 새로 열 때
 * 갱신된다.
 *
 * ── 확인(onAcknowledge)을 넘기지 않는 이유 ──────────────────────────────
 * 받아 온 알림은 **전부 남의 시스템 것**이다. 「확인했다」를 적을 수 있는 곳은
 * 그 알림을 만든 시스템뿐이고, 이 사이트에는 적을 자리가 없다. 줄을 누르면 그
 * 시스템의 화면으로 건너가고, 거기서 일을 마치면 다음 왕복에서 목록이 줄어든다.
 *
 * 🔴 **자기 줄에도 확인을 붙이지 않는다.** 이 시스템의 알림은 저장된 것이 아니라
 * 「지금 네 차례인 결재」를 그 자리에서 센 값이다 — 결재를 하면 그 줄은 다음
 * 화면에서 저절로 사라진다. 「확인했다」를 적을 곳이 없고, 적을 수 있게 만들면
 * **결재하지 않은 일을 종에서 지울 수** 있게 된다.
 */
export async function PortalNotificationBell({ subject }: { subject: string }) {
  // 🔴 둘을 **나란히** 부른다. 줄줄이 부르면 자기 알림이 포털 왕복(상한 2초)
  //    뒤에야 나타난다 — 포털이 느린 날 「내 결재」가 늦게 뜰 이유가 없다.
  // 🔴 둘 다 던지지 않는다(아래 ownNotifications · oidc.ts).
  const [own, received] = await Promise.all([
    ownNotifications(subject),
    fetchPortalNotifications(subject),
  ]);

  // 🔴 자기 것이 앞, 받은 것이 뒤. 개수는 양쪽이 센 값을 더한 값이다
  //    (다시 세지 않는다 — @dss/ui README 7절). 목록이 비면 그 조각이 스스로
  //    null 이라 머리말에 종 자체가 생기지 않는다.
  //
  // 🔴 colorScheme 은 넘기지 않는다. 이 사이트는 globals.css 에서
  //    color-scheme: light 고정이고, 기본값 "host" 는 조상에 .dark 가 있을
  //    때만 어두워진다(메뉴바에서 한 판단과 같다).
  const bell = bellFeedWithOwnFirst({ own, received });
  return <NotificationBell items={bell.items} count={bell.count} />;
}

/** 자기 알림이 없을 때(그리고 읽지 못했을 때)의 답. 🔴 오류가 아니다. */
const NO_OWN: PortalNotificationFeed = { items: [], count: 0 };

/**
 * 「지금 내 차례인 휴가 결재」 — 포털이 물어 올 때 창구가 내주는 것과 **같은
 * 값**이다. 토큰 검증과 HTTP 만 빼고 같은 길을 간다.
 *
 * 🔴 **던지지 않는다.** 이 종은 모든 화면에 딸려 오고 `<Suspense>` 안에 error
 * boundary 가 없으므로, 여기서 나는 오류 하나가 화면 전체를 500 으로 만든다.
 * 실제로 던질 수 있는 자리가 둘 있다 — DB 가 대답하지 않을 때, 그리고
 * `env.appBaseUrl` (설정이 없으면 던지는 getter다. 임시 로그인만 쓰는 PC 에서는
 * 자기 알림도 빠지는데, 그 PC 에는 「밖에서 이 앱에 닿는 주소」가 아예 없어
 * 링크를 만들 수 없다).
 *
 * 남기는 것은 오류의 **종류 이름**뿐이다(oidc.ts 와 같은 판단 — 오류 객체를
 * 통째로 찍으면 접속 문자열이 딸려 나올 수 있다).
 */
async function ownNotifications(subject: string): Promise<PortalNotificationFeed> {
  try {
    return await buildPortalNotificationFeed({
      subject,
      baseUrl: env.appBaseUrl,
      findActor: findPortalActor,
      listPendingApprovals: pendingApprovalNotifications,
    });
  } catch (error) {
    console.error(
      "[bell] 이 사이트의 알림을 읽지 못했습니다:",
      error instanceof Error ? error.name : "unknown",
    );
    return NO_OWN;
  }
}
