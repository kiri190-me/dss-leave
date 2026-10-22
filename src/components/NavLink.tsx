"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * 머리말 메뉴 한 칸의 생김새 — **두 벌**이다 (2026-10-22).
 *
 * 🔴 두 벌인 것은 **생김새뿐**이고 메뉴 목록·가는 곳·자격 규칙은 한 벌이다.
 *    그것을 쥔 자리는 AppHeader 의 ScreenLinks 하나다(거기 주석에 까닭이 있다).
 *
 *  - `bar`   넓은 화면(768px 이상)의 가로 메뉴. 🔴 **2026-10-22 이전과 글자 하나
 *            다르지 않다** — 폰 작업으로 넓은 화면이 달라지지 않게 그대로 옮겨 적었다.
 *  - `panel` ☰ 서랍 안의 세로 메뉴. 같은 링크를 세로로 세운 것뿐이다.
 *            가로로 꽉 차야 손가락에 잡히므로 block 이고, 위아래 여백이 조금 넓다.
 *            🔵 글자를 안 꺾는 울타리를 여기만 붙인다 — 서랍 폭은 고정(16rem)이라
 *            긴 이름이 들어오는 날 칸이 한 자 폭까지 줄어 세로로 서는 것을 막는다.
 *            넓은 화면 쪽에는 붙이지 않았다: 그 줄은 이미 줄바꿈이 켜져 있어 찌그러지는
 *            대신 줄을 바꾸고, 붙이면 넓은 화면이 「한 글자도 안 바뀐다」가 깨진다.
 */
const LOOK = {
  bar: {
    active: "rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white",
    idle: "rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  },
  panel: {
    active:
      "block rounded-md bg-slate-900 px-3 py-2 text-sm font-medium whitespace-nowrap text-white",
    idle: "block rounded-md px-3 py-2 text-sm whitespace-nowrap text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  },
} as const;

export function NavLink({
  href,
  children,
  exact = false,
  look = "bar",
}: {
  href: string;
  children: ReactNode;
  exact?: boolean;
  /** 어디에 서는 칸인가. 기본은 넓은 화면의 가로 메뉴다. */
  look?: keyof typeof LOOK;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={active ? LOOK[look].active : LOOK[look].idle}
    >
      {children}
    </Link>
  );
}
