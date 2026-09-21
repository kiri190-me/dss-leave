import { decideAction } from "@/app/actions/leave";
import { ActionForm } from "@/components/ActionForm";
import { KindBadge, StatusBadge, StepTrail, TypeChip } from "@/components/badges";
import { DoneBanner } from "@/components/DoneBanner";
import { requireMember } from "@/lib/auth/guards";
import { formatRange } from "@/lib/dates";
import {
  decidedBy,
  getBalance,
  loadHolidaySet,
  loadRules,
  pendingForApprover,
} from "@/lib/leave/data";
import { KIND_LABEL, formatDays } from "@/lib/leave/labels";

/**
 * 결재함: 내 승인을 기다리는 신청 + 내가 처리한 기록.
 *
 * 🔴 문 앞에서 직급의 결재권(`requireApprover`)을 묻지 않는다 — 결재선에 이름이
 * 오른 사람은 직급에 결재권이 없어도 자기 단계를 결재해야 하기 때문이다.
 * 이 화면이 보여 주는 것은 **내 단계와 내가 처리한 기록뿐**이라(data.ts 의
 * pendingForApprover · decidedBy) 결재할 것이 없는 사람에게는 빈 화면이 된다.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  const sp = await searchParams;
  const [items, history, holidays, rules] = await Promise.all([
    pendingForApprover(member),
    decidedBy(member.employee.id),
    loadHolidaySet(),
    loadRules(),
  ]);

  // 결재할 때 신청자의 남은 휴가를 함께 본다
  const balances = new Map(
    await Promise.all(
      items.map(
        async (it) =>
          [
            it.id,
            await getBalance({ id: it.employeeId, hireDate: it.applicantHireDate }, { holidays, rules }),
          ] as const,
      ),
    ),
  );

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">결재함</h1>
        <DoneBanner code={sp.done} className="mb-4" />
        <p className="mb-4 text-sm text-slate-500">
          내 승인을 기다리는 신청입니다. 결재선의 결재자가 순서 없이 모두 승인하면 확정되고, 한 명이라도 반려하면 그 자리에서 끝납니다.
        </p>

        {items.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-400">
            결재할 신청이 없습니다.
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((it) => {
              const bal = balances.get(it.id);
              return (
                <li key={it.id} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{it.applicantName}</span>
                    <span className="text-xs text-slate-500">{it.applicantRank}</span>
                    <KindBadge kind={it.kind} />
                    <TypeChip type={it.leaveType} />
                    <span className="text-sm text-slate-800">{formatRange(it.startDate, it.endDate, true)}</span>
                    <span className="text-sm text-slate-500">
                      {formatDays(it.days)}
                      {!it.deducts && " · 연차 차감 없음"}
                    </span>
                  </div>

                  {it.kind !== "NEW" && it.target && (
                    <p className="mt-1 text-xs text-slate-600">
                      {it.kind === "CHANGE" ? "변경 전" : "취소할 휴가"}:{" "}
                      {formatRange(it.target.startDate, it.target.endDate, true)} ({formatDays(it.target.days)})
                    </p>
                  )}

                  <p className="mt-1 text-sm text-slate-700">
                    {it.reason ? <>사유: {it.reason}</> : <span className="text-slate-400">사유 없음</span>}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                    <StepTrail steps={it.steps} />
                    {bal && (
                      <span>
                        신청자 남은 휴가 {formatDays(bal.available)}
                        {bal.annual.pending + (bal.monthly?.pending ?? 0) > 0 && " (결재 대기분 뺀 값)"}
                      </span>
                    )}
                  </div>

                  <ActionForm action={decideAction} className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    <input type="hidden" name="stepId" value={it.stepId} />
                    <input
                      name="comment"
                      maxLength={300}
                      placeholder="의견 (반려할 때는 꼭 적어 주세요)"
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none sm:max-w-md"
                    />
                    <button
                      type="submit"
                      name="decision"
                      value="approve"
                      className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      {it.kind === "NEW" ? "승인" : `${KIND_LABEL[it.kind]} 승인`}
                    </button>
                    <button
                      type="submit"
                      name="decision"
                      value="reject"
                      className="rounded-md border border-red-300 px-4 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      반려
                    </button>
                  </ActionForm>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-slate-800">내가 처리한 결재</h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-400">아직 없습니다.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">처리</th>
                  <th className="px-3 py-2 font-medium">신청자</th>
                  <th className="px-3 py-2 font-medium">내용</th>
                  <th className="px-3 py-2 font-medium">기간</th>
                  <th className="px-3 py-2 font-medium">지금 상태</th>
                  <th className="px-3 py-2 font-medium">의견</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map(({ step, req, applicantName }) => (
                  <tr key={step.id}>
                    <td className="px-3 py-2">
                      <span className={step.status === "APPROVED" ? "text-emerald-700" : "text-red-700"}>
                        {step.status === "APPROVED" ? "승인" : "반려"}
                      </span>
                    </td>
                    <td className="px-3 py-2">{applicantName}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <TypeChip type={req.leaveType} />
                        <KindBadge kind={req.kind} />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{formatRange(req.startDate, req.endDate)}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={req.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{step.comment ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
