import { submitLeaveAction } from "@/app/actions/leave";
import { BalanceCard } from "@/components/BalanceCard";
import { LeaveForm } from "@/components/LeaveForm";
import { requireMember } from "@/lib/auth/guards";
import { todayKst } from "@/lib/dates";
import { approvalChainFor, getBalance, loadHolidays } from "@/lib/leave/data";

export default async function NewLeavePage() {
  const member = await requireMember();
  const [holidays, chain, balance] = await Promise.all([
    loadHolidays(),
    approvalChainFor(member.employee),
    getBalance(member.employee),
  ]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="mb-5 text-xl font-semibold text-slate-900">휴가 신청</h1>
        <LeaveForm
          action={submitLeaveAction}
          holidays={holidays.map((h) => h.day)}
          chainNames={chain.map((r) => r.name)}
          available={balance.available}
          summerAvailable={balance.summer.remaining}
          today={todayKst()}
          submitLabel="신청하기"
        />
      </section>
      <aside>
        <BalanceCard balance={balance} />
      </aside>
    </div>
  );
}
