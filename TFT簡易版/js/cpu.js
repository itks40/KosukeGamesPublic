// 役割（攻撃/防衛）に応じてCPUの編成を組む。
// 攻撃側=25G全てをユニットに。防衛側=23Gでユニットを組み、残金で防衛設備を1個だけ建設する。
function buildCpuSide(role = 'attacker') {
  let budget = roleStartGold(role);

  // 防衛側は設備1個分の予算を少しだけ確保してからユニットを編成する（設備は最大3G）。
  const facilityReserve = role === 'defender' ? 1 + Math.floor(Math.random() * 3) : 0; // 1〜3G

  const shuffledUnits = [...UNITS_DATA].sort(() => Math.random() - 0.5);
  const team = [];
  for (const unit of shuffledUnits) {
    if (team.length >= MAX_TEAM_SIZE) break;
    if (unit.cost <= budget - facilityReserve) {
      team.push({ ...unit, maxMp: unitMaxMp(unit) });
      budget -= unit.cost;
    }
  }
  // 予約が過剰でユニットが0体になった場合の保険（最低1体は雇う）
  if (team.length === 0) {
    for (const unit of shuffledUnits) {
      if (unit.cost <= budget) { team.push({ ...unit, maxMp: unitMaxMp(unit) }); budget -= unit.cost; break; }
    }
  }

  // 防衛側は残った資金でランダムに設備を1個だけ建設（MAX_FACILITIES上限・予算内）
  const facilities = [];
  if (role === 'defender') {
    const shuffledFacilities = [...FACILITIES_LIST].sort(() => Math.random() - 0.5);
    for (const facility of shuffledFacilities) {
      if (facilities.length >= MAX_FACILITIES) break;
      if (facility.cost <= budget) {
        facilities.push(facility.id);
        budget -= facility.cost;
      }
    }
  }

  return { team, facilities };
}
