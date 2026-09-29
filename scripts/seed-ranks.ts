/**
 * 기본 자료 넣기 — **직급만.**  npm run seed:ranks
 *
 * 🔴 왜 따로 있나: 직급이 없으면 직원을 한 명도 넣을 수 없다(직원 추가 화면의
 * 직급 칸이 필수다). 그런데 가짜 데이터 스크립트(seed-dev.ts)는 직급과 **가짜
 * 사람 이름**을 함께 넣어, 실제로 쓸 DB 에는 돌릴 수 없다. 이 스크립트는
 * 직급 다섯만 넣는다 — 사람도, 휴가 신청도, 근속 표도, 공휴일도 건드리지
 * 않는다.
 *
 * 🔴 **여러 번 돌려도 안전하다.** 없는 것만 넣고 이미 있는 것은 그대로 둔다
 *    (기준은 src/lib/db/base-data.ts 의 ensureRanks).
 * 🔴 **운영 DB 에도 돌리는 스크립트다.** 그래서 seed-dev.ts 와 달리
 *    DEV_FAKE_LOGIN_ENABLED 를 요구하지 않는다.
 *
 * 다른 DB 에 넣으려면 환경변수로 덮어쓴다 (Node 는 환경 변수를 .env.local
 * 보다 우선한다):
 *
 *   DATABASE_URL="…/dss_leave_test" npm run seed:ranks
 */

// .env.local 이 없어도 죽지 않는다 — NAS 의 도구 컨테이너에는 그 파일이 아예 없다
// (.dockerignore 가 .env* 를 막는다). 운영에서는 DATABASE_URL 을 컨테이너 환경변수로
// 받는다. 개발 PC 에서는 파일이 있으므로 예전처럼 읽는다.
// 값이 정말로 없으면 아래 `../src/lib/db` 를 불러오는 순간 env.ts 가 분명한 오류로
// 죽인다 — 조용히 넘어가지 않는다. (drizzle.config.ts 도 같은 모양이다.)
try {
  process.loadEnvFile(".env.local");
} catch {
  // 파일이 없을 때만 지나간다.
}

async function main() {
  // .env.local 을 읽은 뒤에 불러와야 DB 주소가 잡힌다
  const { db } = await import("../src/lib/db");
  const { ensureRanks } = await import("../src/lib/db/base-data");

  // 어느 DB 에 넣는지 먼저 보여 준다. 비밀번호는 찍지 않는다.
  const where = new URL(process.env.DATABASE_URL ?? "postgres://?/?");
  console.log(`대상 DB: ${where.hostname}:${where.port}${where.pathname}`);

  const result = await db.transaction((tx) => ensureRanks(tx));

  if (result.added.length > 0) {
    console.log(`새로 넣은 직급: ${result.added.join(" · ")}`);
  }
  if (result.kept.length > 0) {
    console.log(`이미 있어 그대로 둔 직급: ${result.kept.join(" · ")}`);
  }
  for (const d of result.differing) {
    console.warn(
      `⚠ ${d.name}: DB 값(순서 ${d.inDb.sortOrder}, 결재권 ${d.inDb.canApprove})이 ` +
        `기본값(순서 ${d.inBaseData.sortOrder}, 결재권 ${d.inBaseData.canApprove})과 다릅니다. ` +
        `일부러 바꾼 것일 수 있어 건드리지 않았습니다.`,
    );
  }

  console.log("\n지금 살아 있는 직급 (낮은 순):");
  for (const r of result.ranks) {
    console.log(`  ${String(r.sortOrder).padStart(3)}  ${r.name}${r.canApprove ? "  (결재권)" : ""}`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
