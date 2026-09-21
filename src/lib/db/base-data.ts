/**
 * 기본 자료 — **시스템이 돌아가려면 반드시 있어야 하는 것**.
 *
 * 🔴 사람(실제 자료)과 갈라 둔다. 직급이 없으면 직원을 **한 명도** 넣을 수
 * 없다(직원 추가 화면의 직급 칸이 필수이고, 고를 것이 없으면 그 화면이
 * 막힌다). 그런데 가짜 데이터 스크립트(scripts/seed-dev.ts)는 직급과 **가짜
 * 사람 이름**을 함께 넣는다 — 실제로 쓸 DB 에 그것을 돌리면 명단에 있지도
 * 않은 사람이 생긴다. 그래서 「기본 자료만 넣기」를 할 수 있게 직급을 여기로
 * 떼어 냈다(scripts/seed-ranks.ts 가 이것만 부른다).
 *
 * 실제 명단·근속 표·공휴일은 여기 없다. 그것은 휴가 관리자가 화면에서 넣을
 * **실제 자료**다.
 */
import { eq } from "drizzle-orm";

import type { Tx } from "./index";
import { webRanks, type Rank } from "./schema";

/**
 * 직급 다섯. 2026-09-21 사용자 확인: 사원 · 대리 · 과장 · 부장 · 대표.
 *
 * - `sortOrder` 는 **클수록 높은 직급**이다. 신청자보다 높은 직급의 결재권자가
 *   모두 승인해야 확정된다(schema.ts 의 web_ranks 주석).
 * - `canApprove` 는 결재권. **과장 이상**이다.
 * - 값은 scripts/seed-dev.ts 가 쓰던 것과 **같다.** 둘이 어긋나면 개발 화면과
 *   실제 화면에서 결재선이 달라진다.
 * - 실장은 일부러 없다 — 결재선에서 빠지고 휴가 관리 대상도 아니다.
 * - 사이사이(20↔30, 30↔50, 50↔90)를 비워 둔 것은 나중에 직급이 끼어들 자리다.
 *   번호를 다시 매기면 이미 결재선을 탄 신청의 뜻이 바뀐다.
 */
export const BASE_RANKS: ReadonlyArray<{
  name: string;
  sortOrder: number;
  canApprove: boolean;
}> = [
  { name: "사원", sortOrder: 10, canApprove: false },
  { name: "대리", sortOrder: 20, canApprove: false },
  { name: "과장", sortOrder: 30, canApprove: true },
  { name: "부장", sortOrder: 50, canApprove: true },
  { name: "대표", sortOrder: 90, canApprove: true },
];

export type EnsureRanksResult = {
  /** 이번에 새로 넣은 직급 이름 */
  added: string[];
  /** 이미 있어서 건드리지 않은 직급 이름 */
  kept: string[];
  /**
   * 이름은 같은데 `sortOrder`·`canApprove` 가 기본값과 다른 것.
   * 🔴 **고치지 않는다** — 관리자가 화면에서 일부러 바꿨을 수 있다.
   * 부르는 쪽이 사람에게 알려 주기만 한다.
   */
  differing: {
    name: string;
    inDb: { sortOrder: number; canApprove: boolean };
    inBaseData: { sortOrder: number; canApprove: boolean };
  }[];
  /** 끝난 뒤 살아 있는 직급 전부 (sortOrder 오름차순) */
  ranks: Rank[];
};

/**
 * 없는 직급만 넣는다. **여러 번 돌려도 안전하다.**
 *
 * 🔴 「없다」의 기준은 **살아 있는 행**이다 — 이름의 유일 색인도
 * `is_deleted = false` 에만 걸려 있다(schema.ts). 지운 직급과 같은 이름을 다시
 * 넣는 것은 막히지 않고, 그게 맞다(되살리면 그 직급을 지운 결정이 조용히
 * 뒤집힌다).
 *
 * 이미 있는 행은 **건드리지 않는다.** 덮어쓰면 관리자가 화면에서 바꾼 결재권·
 * 순서가 스크립트를 한 번 돌리는 것으로 되돌아간다.
 */
export async function ensureRanks(tx: Tx): Promise<EnsureRanksResult> {
  const before = await tx.select().from(webRanks).where(eq(webRanks.isDeleted, false));
  const byName = new Map(before.map((r) => [r.name, r]));

  const missing = BASE_RANKS.filter((r) => !byName.has(r.name));
  if (missing.length > 0) {
    await tx.insert(webRanks).values(missing.map((r) => ({ ...r })));
  }

  const differing: EnsureRanksResult["differing"] = [];
  for (const base of BASE_RANKS) {
    const row = byName.get(base.name);
    if (!row) continue;
    if (row.sortOrder !== base.sortOrder || row.canApprove !== base.canApprove) {
      differing.push({
        name: base.name,
        inDb: { sortOrder: row.sortOrder, canApprove: row.canApprove },
        inBaseData: { sortOrder: base.sortOrder, canApprove: base.canApprove },
      });
    }
  }

  const ranks = await tx.select().from(webRanks).where(eq(webRanks.isDeleted, false));
  ranks.sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    added: missing.map((r) => r.name),
    kept: BASE_RANKS.filter((r) => byName.has(r.name)).map((r) => r.name),
    differing,
    ranks,
  };
}
