import Link from "next/link";

import { cancelLeaveAction, withdrawAction } from "@/app/actions/leave";
import { ActionForm } from "@/components/ActionForm";
import { BalanceCard } from "@/components/BalanceCard";
import { DoneBanner } from "@/components/DoneBanner";
import { KindBadge, StatusBadge, StepTrail, TypeChip } from "@/components/badges";
import { requireMember } from "@/lib/auth/guards";
import { formatRange, todayKst } from "@/lib/dates";
import { getBalance, myRequests, type RequestView } from "@/lib/leave/data";
import { formatDays } from "@/lib/leave/labels";
import { leaveYearOf, leaveYearWindow } from "@/lib/leave/rules";


export default async function MyLeavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  const sp = await searchParams;
  const today = todayKst();
  // 목록은 이번 연차 연도(입사 기념일 ~ 다음 기념일 전날)가 시작된 날부터 보여준다
  const hireDate = member.employee.hireDate;
  const thisWindow = leaveYearWindow(hireDate, leaveYearOf(hireDate, today));
  const [balance, requests] = await Promise.all([
    getBalance(member.employee),
    myRequests(member.employee.id, thisWindow.start),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">내 휴가</h1>
          <div className="flex items-center gap-2">
            <Link
              href="/leave/print"
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              🖨 휴가 내역 인쇄
            </Link>
            <Link
              href="/leave/new"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              + 휴가 신청
            </Link>
          </div>
        </div>

        <DoneBanner code={sp.done} />

        {requests.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-400">
            이번 연차 연도에 신청한 휴가가 없습니다.
          </p>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => (
              <RequestCard key={r.id} r={r} today={today} />
            ))}
          </ul>
        )}
      </section>

      <aside>
        <BalanceCard balance={balance} detailed />
      </aside>
    </div>
  );
}

function RequestCard({ r, today }: { r: RequestView; today: string }) {
  const dimmed = ["WITHDRAWN", "CANCELED", "SUPERSEDED", "REJECTED"].includes(r.status);
  const canFollowUp =
    r.kind !== "CANCEL" && r.status === "APPROVED" && r.startDate >= today && !r.openFollowUp;

  return (
    <li className={`rounded-lg border border-slate-200 bg-white p-4 ${dimmed ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <TypeChip type={r.leaveType} />
        <KindBadge kind={r.kind} />
        <span className="text-sm font-medium text-slate-900">{formatRange(r.startDate, r.endDate, true)}</span>
        <span className="text-sm text-slate-500">
          {formatDays(r.days)}
          {!r.deducts && " · 연차 차감 없음"}
        </span>
        <span className="ml-auto">
          <StatusBadge status={r.status} />
        </span>
      </div>

      {r.kind === "CHANGE" && r.target && (
        <p className="mt-1 text-xs text-slate-500">
          변경 전: {formatRange(r.target.startDate, r.target.endDate, true)} ({formatDays(r.target.days)})
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <StepTrail steps={r.steps} />
      </div>

      {r.reason && <p className="mt-2 text-xs text-slate-600">사유: {r.reason}</p>}
      {r.status === "REJECTED" && r.statusNote && (
        <p className="mt-1 text-xs text-red-700">반려 사유: {r.statusNote}</p>
      )}
      {r.status === "CANCELED" && r.statusNote && (
        <p className="mt-1 text-xs text-slate-500">{r.statusNote}</p>
      )}
      {r.openFollowUp && (
        <p className="mt-2 text-xs font-medium text-amber-800">
          {r.openFollowUp.kind === "CANCEL" ? "취소" : "날짜 변경"} 신청이 결재 중입니다.
        </p>
      )}

      {(r.status === "PENDING" || canFollowUp) && (
        <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-slate-100 pt-3">
          {r.status === "PENDING" && (
            <ActionForm action={withdrawAction} confirm="이 신청을 취소할까요?" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="requestId" value={r.id} />
              <button
                type="submit"
                className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                휴가 신청 취소
              </button>
            </ActionForm>
          )}
          {canFollowUp && (
            <>
              <Link
                href={`/leave/${r.id}/change`}
                className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                날짜 변경
              </Link>
              <ActionForm
                action={cancelLeaveAction}
                confirm="이 휴가의 취소를 신청할까요? 결재선의 결재자가 차례로 모두 승인해야 취소됩니다."
                className="flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="targetId" value={r.id} />
                <input
                  name="reason"
                  maxLength={200}
                  placeholder="취소 사유 (선택)"
                  className="w-44 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  취소 신청
                </button>
              </ActionForm>
            </>
          )}
        </div>
      )}
    </li>
  );
}
