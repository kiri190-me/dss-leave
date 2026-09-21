import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
// 머리말 안 서비스 메뉴바(@dss/ui)의 스타일. 그 조각은 CSS 를 스스로 부르지
// 않으므로 — 부르면 번들러 없이는 못 쓰게 되어 그쪽 시험이 깨진다 — 쓰는
// 사이트가 최상위에서 한 번 불러 준다.
import "@dss/ui/styles.css";

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
