import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
// 머리말 안 서비스 메뉴바(@dss/ui)의 스타일. 그 조각은 CSS 를 스스로 부르지
// 않으므로 — 부르면 번들러 없이는 못 쓰게 되어 그쪽 시험이 깨진다 — 쓰는
// 사이트가 최상위에서 한 번 불러 준다.
import "@dss/ui/styles.css";
// 머리말 오른쪽 끝에 앉는 알림 종(@dss/ui)의 스타일. 🔴 위 메뉴바의
// styles.css 와 **다른 파일**이다 — 그 묶음은 조각마다 CSS 한 장이고, 한
// 장으로 묶으려면 CSS 안에서 @import 를 해야 하는데 그것은 그쪽 시험이
// 막는다(README 7절).
//
// 규칙은 전부 .dss-bell 아래에만 있고, 종은 보여 줄 알림이 **있을 때만**
// 그려진다(없으면 조각이 스스로 null 이다). 로그인 화면에 이 줄이 닿아도
// 바뀌는 것은 없다 — 메뉴바 CSS 와 같은 자리·같은 이유다.
import "@dss/ui/notification-bell.css";

export const metadata: Metadata = {
  title: "DSS 휴가 관리",
  description: "사내 휴가 신청·결재와 남은 연차 확인",
  // 사내 전용. 검색에 나오지 않게 한다.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
