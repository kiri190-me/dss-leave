import {
  addRouteStepAction,
  moveRouteStepAction,
  removeRouteStepAction,
} from "@/app/actions/admin";
import { ActionForm } from "@/components/ActionForm";
import { approversAfter, liveApprovers, type RouteMember } from "@/lib/leave/rules";

/**
 * 승인 절차 — **순서 있는 사람 목록 하나**를 만들고 고치는 자리.
 *
 * 🔴 2026-09-21 사용자 결정으로 직급 기반 결재선을 없앴다. 예전에는 「어떤
 * 신청이냐(신청자 직급)」를 고르면 그 직급보다 높은 결재 직급이 줄줄이 나오는
 * 그림이었는데, 이제는 판이 하나뿐이다:
 *
 *   결재선:  김대리 → 박과장 → 이부장 → 최대표
 *   박과장이 신청하면 → 이부장 · 최대표만 결재 (자기 앞사람은 빠진다)
 *   최대표(맨 끝)가 신청하면 → 결재자가 없다 = 바로 확정
 *   결재선에 없는 사람이 신청하면 → 목록 전원
 *
 * 순서는 **누가 결재자가 되는가**를 가르는 것이지 「한 명씩 차례로」가 아니다.
 * 결재는 지금도 동시에 가고 순서 없이 모두 승인하면 확정된다.
 *
 * ── 🔴 화면이 거짓말하지 않는다 ────────────────────────────────────────
 * 예전 화면은 「결재권자: 과장 · 부장」이라 적어 놓고 그 직급에 사람이 없으면
 * 실제로는 결재 없이 바로 등록했다. 같은 정직함을 사람 기반에서도 지킨다:
 * 퇴사한 사람의 줄을 조용히 지우지 않고 그 자리에 「건너뜁니다」라고 적는다.
 * 직급에 결재권이 없어 결재함 메뉴가 안 보이는 사람도 그 자리에 적는다.
 */
export function ApprovalRouteCard({
  route,
  candidates,
}: {
  /** 지금 결재선. 차례대로, 퇴사자도 빠지지 않고 온다 */
  route: RouteMember[];
  /** 결재선에 넣을 수 있는 사람 (재직 중인 직원 전부) */
  candidates: { id: string; name: string; rankName: string; rankCanApprove: boolean }[];
}) {
  const live = liveApprovers(route);
  const inRoute = new Set(route.map((m) => m.employeeId));
  const addable = candidates.filter((c) => !inRoute.has(c.id));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-800">승인 절차 (결재선)</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        결재할 <b>사람</b>을 차례대로 적어 둡니다. 신청자가 이 목록 안에 있으면 <b>자기 뒤에 있는 사람들</b>에게만
        결재를 받고, 목록에 없으면 <b>전원</b>에게 받습니다. 맨 끝 사람의 신청은 결재 없이 바로 등록됩니다. 차례는
        누가 결재자가 되는지를 가를 뿐이고, 결재 자체는 지금처럼 <b>동시에</b> 가서 모두 승인하면 확정됩니다.
      </p>

      {route.length === 0 ? (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          결재선이 비어 있습니다. 지금은 <b>모든 신청이 결재 없이 바로 등록</b>됩니다. 결재를 받으려면 아래에서
          사람을 넣으세요.
        </p>
      ) : (
        live.length === 0 && (
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
            결재선에 사람은 있지만 <b>재직 중인 사람이 한 명도 없습니다.</b> 지금 들어오는 신청은 결재 없이 바로
            등록됩니다.
          </p>
        )
      )}

      {route.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {route.map((m, index) => (
            <li key={m.routeStepId} className="rounded-md border border-slate-100 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-6 shrink-0 text-center text-xs font-medium text-slate-400 tabular">
                  {index + 1}
                </span>
                <span
                  className={`text-sm ${m.active ? "text-slate-900" : "text-slate-400 line-through"}`}
                >
                  {m.name}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                  {m.rankName}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <MoveButton id={m.routeStepId} dir="up" disabled={index === 0} />
                  <MoveButton id={m.routeStepId} dir="down" disabled={index === route.length - 1} />
                  <ActionForm
                    action={removeRouteStepAction}
                    confirm={`결재선에서 ${m.name} 님을 뺄까요? (이미 결재 중인 신청은 그대로입니다)`}
                  >
                    <input type="hidden" name="id" value={m.routeStepId} />
                    <button
                      type="submit"
                      className="text-xs text-red-700 underline-offset-2 hover:underline"
                    >
                      빼기
                    </button>
                  </ActionForm>
                </span>
              </div>
              {!m.active && (
                <p className="mt-1 pl-8 text-[11px] text-amber-700">
                  재직 중이 아닙니다. 새 신청에서는 이 줄을 <b>건너뜁니다</b>. 이미 이 사람을 기다리고 있는 신청은
                  직원 관리 화면의 <b>[건너뛰기]</b>로 풉니다.
                </p>
              )}
              {m.active && !m.rankCanApprove && (
                <p className="mt-1 pl-8 text-[11px] text-amber-700">
                  이 사람의 직급({m.rankName})에는 결재권이 없습니다. 결재는 할 수 있지만 머리말의 「결재함」 메뉴가
                  보이지 않아 첫 화면의 「결재할 휴가 ○건」으로 들어가야 합니다. 위 「직급과 결재권자」에서 [결재]를
                  켜면 메뉴가 보입니다.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <ActionForm
        action={addRouteStepAction}
        className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4"
      >
        <label htmlFor="approval-route-add" className="text-xs font-medium text-slate-700">
          결재선에 넣기
        </label>
        <select
          id="approval-route-add"
          name="employeeId"
          required
          defaultValue=""
          className="min-w-0 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
        >
          <option value="" disabled>
            사람 고르기
          </option>
          {addable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.rankName}){c.rankCanApprove ? "" : " — 직급에 결재권 없음"}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          맨 뒤에 추가
        </button>
        {addable.length === 0 && (
          <span className="text-xs text-slate-400">재직 중인 직원이 모두 결재선에 있습니다.</span>
        )}
      </ActionForm>

      {route.length > 0 && (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <h3 className="text-xs font-medium text-slate-500">누가 신청하면 누가 결재하나</h3>
          {/* 🔴 가로로 길어지면 이 상자 안에서만 밀린다 — 화면 전체가 옆으로 밀리면
              다른 설정까지 못 쓰게 된다(폰 폭에서 실제로 일어난다). */}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <tbody className="divide-y divide-slate-100">
                {[...route, null].map((applicant) => {
                  const chain = liveApprovers(
                    approversAfter(route, applicant ? applicant.employeeId : null),
                  );
                  return (
                    <tr key={applicant?.routeStepId ?? "outside"}>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-slate-600">
                        {applicant ? `${applicant.name} 신청` : "결재선에 없는 직원 신청"}
                      </td>
                      <td className="py-1.5 text-slate-800">
                        {chain.length === 0 ? (
                          <span className="text-slate-500">결재 없이 바로 등록</span>
                        ) : (
                          chain.map((a) => a.name).join(" · ")
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            퇴사자는 위 표에서 이미 빠져 있습니다. 결재자가 한 명도 없는 줄은 그 사람의 신청이 결재 없이 바로
            등록된다는 뜻입니다.
          </p>
        </div>
      )}
    </section>
  );
}

function MoveButton({ id, dir, disabled }: { id: string; dir: "up" | "down"; disabled: boolean }) {
  return (
    <ActionForm action={moveRouteStepAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="dir" value={dir} />
      <button
        type="submit"
        disabled={disabled}
        aria-label={dir === "up" ? "앞으로" : "뒤로"}
        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
      >
        {dir === "up" ? "▲" : "▼"}
      </button>
    </ActionForm>
  );
}
