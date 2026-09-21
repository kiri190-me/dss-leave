import Link from "next/link";

import {
  createHolidayAction,
  deleteHolidayAction,
  deleteRankAction,
  deleteTenureRuleAction,
  saveRankAction,
  saveTenureRuleAction,
} from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { ApprovalRouteCard } from "@/components/ApprovalRouteCard";
import { requireAdmin } from "@/lib/auth/guards";
import { formatDay, todayKst, yearOf } from "@/lib/dates";
import { db } from "@/lib/db";
import { webTenureRules } from "@/lib/db/schema";
import {
  loadApprovalRoute,
  loadHolidays,
  loadRanks,
  loadRouteCandidates,
} from "@/lib/leave/data";
import { and, asc, eq } from "drizzle-orm";

const input =
  "rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none";
const saveBtn = "rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50";
const addBtn = "rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700";
const delBtn = "text-xs text-red-700 underline-offset-2 hover:underline";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const thisYear = yearOf(todayKst());
  const yearParam = typeof sp.year === "string" ? Number(sp.year) : NaN;
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= 2100 ? yearParam : thisYear;

  const [rules, ranks, holidays, route, routeCandidates] = await Promise.all([
    db
      .select()
      .from(webTenureRules)
      .where(and(eq(webTenureRules.isDeleted, false)))
      .orderBy(asc(webTenureRules.fromYear)),
    loadRanks(),
    loadHolidays(`${year}-01-01`, `${year}-12-31`),
    loadApprovalRoute(),
    loadRouteCandidates(),
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold text-slate-900">휴가 설정</h1>

      {/* 근속 연차별 일수 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">근속 연차별 연차 일수</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          사람마다 자기 입사 기념일에, 그날까지 채운 만 근속으로 이 표를 찾아 그해 연차를 줍니다. 만 12개월 = 1년.
          1년이 안 된 직원은 이 표 대신 한 달마다 1일(월차)을 받습니다.
        </p>
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2">
              <ActionForm action={saveTenureRuleAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={r.id} />
                <input name="fromYear" type="number" min={1} defaultValue={r.fromYear} className={`w-16 ${input}`} />
                <span className="text-sm text-slate-500">~</span>
                <input name="toYear" type="number" min={1} defaultValue={r.toYear} className={`w-16 ${input}`} />
                <span className="text-sm text-slate-500">년차 →</span>
                <input name="days" type="number" step="0.5" defaultValue={r.days} className={`w-20 ${input}`} />
                <span className="text-sm text-slate-500">일</span>
                <button type="submit" className={saveBtn}>
                  저장
                </button>
              </ActionForm>
              <ActionForm action={deleteTenureRuleAction} confirm="이 줄을 지울까요?">
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" className={delBtn}>
                  지우기
                </button>
              </ActionForm>
            </div>
          ))}
          {rules.length === 0 && <p className="text-sm text-slate-400">아직 없습니다.</p>}
        </div>
        <ActionForm action={saveTenureRuleAction} className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <input name="fromYear" type="number" min={1} required placeholder="1" className={`w-16 ${input}`} />
          <span className="text-sm text-slate-500">~</span>
          <input name="toYear" type="number" min={1} required placeholder="2" className={`w-16 ${input}`} />
          <span className="text-sm text-slate-500">년차 →</span>
          <input name="days" type="number" step="0.5" required placeholder="10" className={`w-20 ${input}`} />
          <span className="text-sm text-slate-500">일</span>
          <button type="submit" className={addBtn}>
            줄 추가
          </button>
        </ActionForm>
      </section>

      {/* 승인 절차 — 결재선(사람 순서 목록). 결재를 정하는 곳은 여기 하나다 */}
      <ApprovalRouteCard route={route} candidates={routeCandidates} />

      {/* 직급 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-800">직급</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          순서 숫자가 클수록 높은 직급입니다. 🔴 <b>누가 결재하는지는 직급이 아니라 위 「승인 절차」의 사람 목록이
          정합니다</b> (2026-09-21 변경). 여기 &lsquo;결재&rsquo; 체크는 이제 <b>휴가 사유를 볼 수 있는 직급</b>과
          머리말에 「결재함」 메뉴가 보이는 직급만 정합니다.
        </p>
        <div className="space-y-2">
          {ranks.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2">
              <ActionForm action={saveRankAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={r.id} />
                <input name="name" required defaultValue={r.name} className={`w-24 ${input}`} />
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  순서
                  <input name="sortOrder" type="number" defaultValue={r.sortOrder} className={`w-16 ${input}`} />
                </label>
                <label className="flex items-center gap-1 text-sm text-slate-700">
                  <input name="canApprove" type="checkbox" defaultChecked={r.canApprove} />
                  결재
                </label>
                <button type="submit" className={saveBtn}>
                  저장
                </button>
              </ActionForm>
              <ActionForm action={deleteRankAction} confirm={`'${r.name}' 직급을 지울까요?`}>
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" className={delBtn}>
                  지우기
                </button>
              </ActionForm>
            </div>
          ))}
        </div>
        <ActionForm action={saveRankAction} className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <input name="name" required placeholder="예: 차장" className={`w-24 ${input}`} />
          <label className="flex items-center gap-1 text-xs text-slate-500">
            순서
            <input name="sortOrder" type="number" required placeholder="40" className={`w-16 ${input}`} />
          </label>
          <label className="flex items-center gap-1 text-sm text-slate-700">
            <input name="canApprove" type="checkbox" />
            결재
          </label>
          <button type="submit" className={addBtn}>
            직급 추가
          </button>
        </ActionForm>
      </section>

      {/* 공휴일 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-800">공휴일 · 회사 휴무일</h2>
          <span className="ml-auto flex items-center gap-1 text-sm">
            <Link href={`/admin/settings?year=${year - 1}`} className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100">
              ◀
            </Link>
            <span className="font-medium">{year}년</span>
            <Link href={`/admin/settings?year=${year + 1}`} className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100">
              ▶
            </Link>
          </span>
        </div>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">
          여러 날 휴가의 일수를 셀 때 이 날들은 뺍니다. 미리 넣어 둔 공휴일은 확인이 필요합니다 (임시공휴일·대체공휴일은 정부 발표 후 추가).
        </p>
        {holidays.length === 0 ? (
          <p className="text-sm text-slate-400">{year}년 휴일이 없습니다.</p>
        ) : (
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {holidays.map((h) => (
              <li key={h.id} className="flex items-center gap-2 py-1 text-sm">
                <span className="w-32 tabular text-slate-600">{formatDay(h.day)}</span>
                <span className="flex-1 text-slate-800">
                  {h.name}
                  {h.kind === "COMPANY" && <span className="ml-1 text-xs text-indigo-700">회사</span>}
                </span>
                <ActionForm action={deleteHolidayAction} confirm={`${h.day} ${h.name}을(를) 지울까요?`}>
                  <input type="hidden" name="id" value={h.id} />
                  <button type="submit" className={delBtn}>
                    지우기
                  </button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={createHolidayAction} className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <input name="day" type="date" required className={input} />
          <input name="name" required maxLength={40} placeholder="이름 (예: 창립기념일)" className={`w-48 ${input}`} />
          <select name="kind" defaultValue="COMPANY" className={input}>
            <option value="COMPANY">회사 휴무일</option>
            <option value="PUBLIC">공휴일</option>
          </select>
          <button type="submit" className={addBtn}>
            추가
          </button>
        </ActionForm>
      </section>
    </div>
  );
}
