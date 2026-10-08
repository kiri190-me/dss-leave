import Link from "next/link";

import { changeLeaveAction } from "@/app/actions/leave";
import { LeaveForm } from "@/components/LeaveForm";
import { requireMember } from "@/lib/auth/guards";
import { formatRange, todayKst } from "@/lib/dates";
import { approvalChainFor, getBalance, loadHolidays, requestById } from "@/lib/leave/data";
import { LEAVE_TYPE_INFO, formatDays } from "@/lib/leave/labels";

/** 결재가 끝난 휴가의 날짜 변경 신청 */
export default async function ChangeLeavePage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireMember();
  const { id } = await params;
  const today = todayKst();
  const req = await requestById(id);

  const problem = !req || req.employeeId !== member.employee.id || req.kind === "CANCEL"
    ? "휴가를 찾을 수 없습니다."
    : req.status !== "APPROVED"
      ? "결재가 끝난 휴가만 날짜를 바꿀 수 있습니다. 결재 중이면 신청을 취소하고 다시 신청하세요."
      : req.startDate < today
        ? "이미 시작했거나 지난 휴가는 바꿀 수 없습니다. 휴가 관리자에게 정정을 요청하세요."
        : req.openFollowUp
          ? "이 휴가에 대한 변경·취소 신청이 이미 결재 중입니다."
          : null;

  if (problem || !req) {
    return (
      <div className="max-w-xl rounded-lg border border-slate-200 bg-white p-6">
        <p className="text-sm text-slate-700">{problem}</p>
        <Link href="/leave" className="mt-4 inline-block text-sm text-slate-500 underline-offset-2 hover:underline">
          내 휴가로 돌아가기
        </Link>
      </div>
    );
  }

  const [holidays, chain, balance] = await Promise.all([
    loadHolidays(),
    approvalChainFor(member.employee),
    getBalance(member.employee),
  ]);
  // 변경이 승인되면 원래 휴가만큼 돌려받으므로 그만큼 더 쓸 수 있다.
  // 🔴 돌려받는 곳은 **그 휴가가 빠졌던 주머니**다 — 연차와 여름휴가를 섞지 않는다.
  const pool = LEAVE_TYPE_INFO[req.leaveType].pool;
  const available = balance.available + (req.deducts ? req.days : 0);
  const summerAvailable = balance.summer.remaining + (pool === "SUMMER" ? req.days : 0);

  return (
    <section className="max-w-3xl rounded-lg border border-slate-200 bg-white p-6">
      <h1 className="text-xl font-semibold text-slate-900">휴가 날짜 변경</h1>
      <p className="mt-1 text-sm text-slate-500">
        지금: {LEAVE_TYPE_INFO[req.leaveType].label} · {formatRange(req.startDate, req.endDate, true)} ·{" "}
        {formatDays(req.days)}
      </p>
      <p className="mb-5 mt-1 text-xs text-slate-500">
        결재권자가 모두 다시 승인해야 바뀝니다. 승인되기 전까지는 원래 휴가가 그대로 유지됩니다.
      </p>
      <LeaveForm
        action={changeLeaveAction}
        holidays={holidays.map((h) => h.day)}
        chainNames={chain.map((r) => r.name)}
        available={available}
        summerAvailable={summerAvailable}
        today={today}
        initial={{
          targetId: req.id,
          leaveType: req.leaveType,
          startDate: req.startDate,
          endDate: req.endDate,
          reason: req.reason ?? "",
        }}
        submitLabel="변경 신청하기"
      />
    </section>
  );
}
