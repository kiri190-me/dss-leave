import Link from "next/link";
import { redirect } from "next/navigation";

import { devLoginAsAction, devLoginNewAction } from "@/app/actions/auth";
import { getViewer, RETURN_TO_FALLBACK, safeReturnTo } from "@/lib/auth/guards";
import { devLoginEnabled, listDevUsers } from "@/lib/auth/dev-login";
import { env } from "@/lib/env";

/**
 * 로그인이 **거절됐을 때** 보여줄 문구.
 *
 * 🔴 자세히 적지 않는다. 자세히 적으면 이 화면이 「누가 이 시스템 사용자인지」
 * 를 확인해 주는 조회 도구가 된다 — 아무나 열 수 있는 화면이다. 사람이 할 수
 * 있는 일(다시 시도 / 관리자에게 문의)이 갈리는 만큼만 나눈다.
 */
const ERROR_MESSAGES: Record<string, string> = {
  expired: "로그인 시도가 만료되었습니다. 다시 시도해 주세요.",
  state: "로그인 시도가 만료되었습니다. 다시 시도해 주세요.",
  sso: "로그인하지 못했습니다. 다시 시도해 주세요.",
  unknown_role: "이 시스템을 쓸 수 있도록 설정되지 않았습니다. 관리자에게 문의해 주세요.",
  inactive: "이 시스템을 쓸 수 있도록 설정되지 않았습니다. 관리자에게 문의해 주세요.",
  deleted: "이 시스템을 쓸 수 있도록 설정되지 않았습니다. 관리자에게 문의해 주세요.",
  not_configured: "통합 로그인이 아직 설정되지 않았습니다. 관리자에게 문의해 주세요.",
  // 임시 로그인에서 오는 값
  "1": "로그인하지 못했습니다. 다시 시도해 주세요.",
};

/**
 * 로그인 화면.
 *
 * 🔴 여기서 포털로 **자동으로 보내지 않는다.** 거절당해 돌아온 사람을 자동으로
 * 다시 보내면 무한 왕복이 된다. 문지기(guards.ts 의 requireSession)가 포털로
 * 곧장 보내므로, 이 화면을 실제로 보는 사람은 대개 거절당해 돌아온 사람이거나
 * 손으로 /login 을 친 사람이다.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  if (await getViewer()) redirect("/");

  const returnTo = safeReturnTo(typeof sp.returnTo === "string" ? sp.returnTo : undefined);
  const errorMessage =
    typeof sp.error === "string" ? (ERROR_MESSAGES[sp.error] ?? ERROR_MESSAGES.sso) : null;

  const ssoReady = env.ssoConfigured;
  // 🔴 돌아갈 주소는 safeReturnTo 를 거친 값만 싣는다.
  const ssoHref =
    returnTo === RETURN_TO_FALLBACK
      ? "/api/auth/sso/start"
      : `/api/auth/sso/start?returnTo=${encodeURIComponent(returnTo)}`;

  const enabled = devLoginEnabled();
  const users = enabled ? await listDevUsers() : [];
  const linked = users.filter((u) => u.employeeName);
  const unlinked = users.filter((u) => !u.employeeName);

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">DSS 휴가 관리</h1>
          <p className="mt-1 text-sm text-slate-500">휴가 신청·결재와 남은 연차 확인</p>
        </div>

        {errorMessage && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </p>
        )}

        {ssoReady ? (
          <Link
            href={ssoHref}
            prefetch={false}
            className="block rounded-lg bg-slate-900 px-5 py-3 text-center text-sm font-medium text-white hover:bg-slate-700"
          >
            DSS 통합 로그인으로 들어가기
          </Link>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white px-5 py-6 text-sm text-slate-600">
            통합 로그인 포털 연결을 준비하고 있습니다.
          </div>
        )}

        {enabled && (
          <div className="space-y-3">
            {/* 통합 로그인이 막혔을 때 들어갈 뒷문. 기본값은 꺼짐 */}
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              <strong>개발용 임시 로그인</strong>입니다. 실제로는 위의 통합 로그인 포털(카카오)로
              들어옵니다. 아래 이름은 모두 <strong>가짜 데이터</strong>입니다. 누구로 들어갈지 고르세요.
            </p>

            <div className="rounded-lg border border-slate-200 bg-white">
              <p className="border-b border-slate-200 px-5 py-2.5 text-xs font-semibold text-slate-500">
                직원 계정
              </p>
              <ul className="divide-y divide-slate-100">
                {linked.map(({ user, employeeName, rankName }) => (
                  <li key={user.id}>
                    <form action={devLoginAsAction}>
                      <input type="hidden" name="userId" value={user.id} />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <button
                        type="submit"
                        className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-sm hover:bg-slate-50"
                      >
                        <span className="font-medium text-slate-900">{employeeName}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{rankName}</span>
                        {user.role === "LEAVE_ADMIN" && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700">휴가 관리자</span>
                        )}
                      </button>
                    </form>
                  </li>
                ))}
                {linked.length === 0 && <li className="px-5 py-4 text-sm text-slate-400">-</li>}
              </ul>
            </div>

            {unlinked.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white">
                <p className="border-b border-slate-200 px-5 py-2.5 text-xs font-semibold text-slate-500">
                  명단에 아직 연결되지 않은 계정
                </p>
                <ul className="divide-y divide-slate-100">
                  {unlinked.map(({ user }) => (
                    <li key={user.id}>
                      <form action={devLoginAsAction}>
                        <input type="hidden" name="userId" value={user.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <button
                          type="submit"
                          className="w-full px-5 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
                        >
                          {user.displayName}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <form action={devLoginNewAction} className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="mb-2 text-xs font-semibold text-slate-500">
                처음 들어오는 사람 흉내 내기 (관리자 확인 대기 화면이 나옵니다)
              </p>
              <div className="flex gap-2">
                <input
                  name="name"
                  required
                  maxLength={40}
                  placeholder="이름"
                  className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
                >
                  들어가기
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
