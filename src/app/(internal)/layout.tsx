import type { ReactNode } from "react";

import { AppHeader } from "@/components/AppHeader";
import { requireViewer } from "@/lib/auth/guards";
import { devLoginEnabled } from "@/lib/auth/dev-login";
import { pendingCountFor } from "@/lib/leave/data";

/**
 * 사내 구간. 여기 아래는 전부 로그인해야 볼 수 있다.
 * 명단에 연결되지 않은 계정은 확인 대기 화면으로 보낸다.
 * (데이터를 바꾸는 서버 액션은 각각 다시 검증한다)
 */
export default async function InternalLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  const pendingCount = await pendingCountFor(viewer);

  return (
    <div className="flex min-h-full flex-col">
      {devLoginEnabled() && (
        // 임시 로그인이 켜져 있다는 표시. 운영에서는 꺼져 있어 나오지 않는다.
        <div className="no-print bg-amber-100 px-4 py-1 text-center text-xs text-amber-900">
          개발용 임시 로그인이 켜져 있습니다
        </div>
      )}
      <AppHeader viewer={viewer} pendingCount={pendingCount} />
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
