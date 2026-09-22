import { Suspense, type ReactNode } from "react";

import { ServiceMenuBar } from "@dss/ui";

import { AppHeader } from "@/components/AppHeader";
import { PortalNotificationBell } from "@/components/PortalNotificationBell";
import { requireViewer } from "@/lib/auth/guards";
import { devLoginEnabled } from "@/lib/auth/dev-login";
import { portalAppsUrl } from "@/lib/auth/oidc";
import { readServiceMenu } from "@/lib/auth/service-menu-cookie";
import { env } from "@/lib/env";
import { pendingCountFor } from "@/lib/leave/data";

/**
 * 사내 구간. 여기 아래는 전부 로그인해야 볼 수 있다.
 * 명단에 연결되지 않은 계정은 확인 대기 화면으로 보낸다.
 * (데이터를 바꾸는 서버 액션은 각각 다시 검증한다)
 */
export default async function InternalLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const pendingCount = await pendingCountFor(viewer);

  // 머리말 **안**에 앉는 서비스 오가기 목록. 포털이 로그인 ID 토큰에 실어 보낸
  // 것을 통합 로그인 콜백이 별도 서명 쿠키에 구워 두었다
  // (auth/service-menu-cookie.ts).
  //
  // 🔴 쿠키가 없거나 못 믿을 것이면 빈 배열이고, 그때 ServiceMenuBar 는
  // 아무것도 그리지 않는다 — 빈 자리도 남기지 않으므로 머리말이 예전과 같다.
  // 포털이 이 시스템에 그 클레임을 싣기 전까지는 늘 이 상태다.
  const services = await readServiceMenu();
  // 「지금 여기」로 눌러 그릴 칸을 고르는 열쇠 — 이 시스템의 client_id(= ID
  // 토큰의 aud)다. 🔴 이름이 아니라 식별자로 견준다(이름은 사람이 바꾼다).
  // 목록이 있을 때만 읽는다: 목록이 있다는 것은 통합 로그인이 설정돼 있다는
  // 뜻이라(설정이 없으면 서명 키가 없어 쿠키를 풀지 못한다) env 가 던지지 않는다.
  const currentServiceId = services.length > 0 ? env.ssoClientId : null;

  // 머리말의 「통합 로그인으로」가 갈 곳 — 포털의 앱 런처다.
  //
  // 🔴 메뉴바와 다른 것이다. 메뉴바는 **다른 시스템**으로 건너뛰는 길이고,
  // 이것은 **포털 자신**으로 돌아가는 길이다. 포털은 자기 자신을 서비스 목록에
  // 넣지 않으므로(포털의 `clients` 표에 포털이 없다) 메뉴바 어디에도 포털로
  // 가는 칸이 없다 — 이 한 줄이 없으면 포털로 돌아갈 방법이 아예 없다.
  //
  // 🔴 로그아웃과도 다르다. 세션을 끊지 않으므로 갔다가 돌아오면 그대로
  // 들어와 있다(oidc.ts 의 endSessionUrl 과 portalAppsUrl 비교).
  //
  // 🔴 설정이 없으면 **null 이다 — 단추를 아예 그리지 않는다.** 두 가지
  // 이유다. 첫째, portalAppsUrl() 은 env.ssoIssuer 를 읽는데 그 getter 는
  // 설정이 없으면 던진다. 감싸지 않고 부르면 머리말이 아니라 이 화면 전체가
  // 500 이 된다. 둘째, 설정이 없다는 것은 포털이 어디 있는지 모른다는 뜻이라
  // 그릴 수 있는 주소 자체가 없다. **눌러서 아무 데도 못 가는 단추보다 없는
  // 편이 낫다** — 임시 로그인으로 들어온 사람에게는 포털이 처음부터 남의
  // 이야기고, 나가는 길은 옆의 「로그아웃」이 이미 맡고 있다.
  const portalUrl = env.ssoConfigured ? portalAppsUrl() : null;

  return (
    <div className="flex min-h-full flex-col">
      {devLoginEnabled() && (
        // 임시 로그인이 켜져 있다는 표시. 운영에서는 꺼져 있어 나오지 않는다.
        <div className="no-print bg-amber-100 px-4 py-1 text-center text-xs text-amber-900">
          개발용 임시 로그인이 켜져 있습니다
        </div>
      )}
      <AppHeader
        viewer={viewer}
        pendingCount={pendingCount}
        portalUrl={portalUrl}
        serviceMenu={
          /*
            🔴 머리말 **위**가 아니라 **안**에 앉힌다(variant="inline") —
            위에 띠를 따로 두면 화면 맨 위가 두 층이 되고 본문이 한 줄만큼
            줄어든다(A/S·개선요청이 먼저 같은 결정을 했다). 모습은 드롭다운
            단추 하나라 서비스가 몇이든 머리말이 잡아먹는 폭이 그대로다.

            🔴 노치 인셋을 여기서 켜지 않는다. 머리말 **안**으로 들였으므로
            화면 맨 위 요소는 다시 머리말이고, inline 모습은 그 패딩을 0 으로
            못 박아 둔다. 둘 다 두면 아이폰에서 노치 높이만큼 두 번 밀린다.

            🔴 colorScheme 도 넘기지 않는다. 이 사이트는 globals.css 에서
            color-scheme: light 로 고정이고, 기본값 "host" 는 조상에 .dark 가
            있을 때만 어두워지므로 그대로 두는 것이 옳다.

            🔴 이 파일에 "use client" 를 붙이지 않는다. 딸려 오는 클라이언트
            조각(바깥 눌러 접기·Esc)은 그 묶음 안에 있고 prop 을 하나도 받지
            않아, 서버에서 그려도 그대로 된다.
          */
          <ServiceMenuBar
            services={services}
            currentServiceId={currentServiceId}
            variant="inline"
          />
        }
        notificationBell={
          /*
            알림 종(@dss/ui). 다른 시스템들(A/S · 계측기 · 개선요청 ·
            PO/내자)의 알림은 포털이 합쳐 주고, 🔴 **휴가 자신의 결재 대기는
            이 사이트가 앞에 이어 붙인다** — 포털은 부른 사이트 자신의 알림을
            빼고 답하기 때문이다(2026-09-22). 두 가지를 구해 합치는 자리는
            PortalNotificationBell 안이다.

            🔴 `<Suspense>` 가 이 조각의 전부다. 이 레이아웃은 모든 화면에
            딸려 오므로, 감싸지 않으면 **모든 화면 이동이 포털 왕복만큼
            느려진다**(포털이 느리면 더). 감싸면 머리말과 본문이 먼저 뜨고
            종만 나중에 흘러 들어온다.

            fallback 이 null 인 이유: 알림이 없을 때 종이 아예 안 그려지는
            것과 **같은 모습**이라 자리가 들썩이지 않는다. 뼈대(skeleton)를
            두면 알림이 없는 사람에게는 「있다가 사라지는 종」이 된다.

            🔴 실패는 이 자리에 오지 않는다 — fetchPortalNotifications 가
            어떤 거절(401·403·429·503·시간 초과·설정 누락)도 삼키고 빈
            목록을 돌려준다. 그래서 error boundary 가 필요 없고, 포털이
            죽어도 이 머리말은 예전과 똑같이 뜬다.

            🔴 묻는 열쇠는 **검증된 세션**의 authSub 다(= 포털 users.id).
            임시 로그인으로 들어온 사람은 포털에 없는 sub 라 빈 목록이 온다.
          */
          <Suspense fallback={null}>
            <PortalNotificationBell subject={viewer.user.authSub} />
          </Suspense>
        }
      />
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
