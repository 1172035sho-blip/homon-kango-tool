/* =========================================================================
 * テストスイート（Phase 1: 保険種別判定＋基本報酬マッチング）
 * -------------------------------------------------------------------------
 * 【重要】TEST_MASTER の金額（100/200/300）は実在しない架空のテスト用数値です。
 * エンジンの計算ロジック（時間区分の選択・合計・要確認の伝播）を検証するための
 * ものであり、実際の報酬額とは無関係です。実運用のマスタには使用しないこと。
 * ========================================================================= */
"use strict";

const TEST_MASTER = {
  meta: { master_name: "テスト専用マスタ（架空値・実在の点数ではない）" },
  time_band_definitions: { verified: false, bands: null, source_reference: null },
  ptotst_ratio_reduction_rule: { verified: false, threshold_ratio: null, reduction_rate: null, source_reference: null },
  items: [
    {
      code: "TEST_KAIGO_PTOTST",
      name_ja: "【テスト】介護・PT等訪問 基本（架空値）",
      insurance_type: "kaigo", category: "basic", phase: 1,
      applies_to: {
        roles: ["PT", "OT", "ST"],
        same_building: null,
        duration_brackets: [
          { max_minutes: 20, amount: 100 },
          { max_minutes: 40, amount: 200 },
          { max_minutes: 60, amount: 300 }
        ]
      },
      amount: null, unit: "単位(架空)",
      eligibility_conditions: [], monthly_limit: null, mutually_exclusive_with: [],
      effective_from: "2026-06-01", effective_until: null,
      source_reference: "テスト用（実在せず）", verified: true, notes: ""
    },
    {
      code: "TEST_MED_BASIC",
      name_ja: "【テスト】医療・基本療養費（架空値・金額未設定）",
      insurance_type: "medical", category: "basic", phase: 1,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false, notes: ""
    }
  ]
};

const TEST_OFFICE = { urgent_visit_registered: null, ptotst_visit_ratio: null, notes: "" };

/* 架空の利用者シナリオ。expected は本ツールの仕様（骨子）から導いた期待値。 */
const SCENARIOS = [
  {
    name: "A: 70歳・要介護2・別表7非該当・PT40分 → 介護保険",
    patient: {
      patient_id: "TA", birth_date: "1956-01-15", care_level: "要介護2",
      designated_disease_hyou7: false, designated_disease_16_of_40to64: null,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-A", patient_id: "TA", date: "2026-07-03", duration_minutes: 40, role: "PT", same_building: false },
    expect: { insurance: "kaigo", appliedCode: "TEST_KAIGO_PTOTST", appliedAmount: 200 }
  },
  {
    name: "B: 55歳・ALS（特定疾病かつ別表7該当） → 医療保険優先",
    patient: {
      patient_id: "TB", birth_date: "1971-02-10", care_level: "要介護3",
      designated_disease_hyou7: true, designated_disease_16_of_40to64: true,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-B", patient_id: "TB", date: "2026-07-03", duration_minutes: 60, role: "NS", same_building: false },
    expect: { insurance: "medical" }
  },
  {
    name: "C: 45歳・特定疾病非該当 → 医療保険",
    patient: {
      patient_id: "TC", birth_date: "1981-05-20", care_level: null,
      designated_disease_hyou7: false, designated_disease_16_of_40to64: false,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-C", patient_id: "TC", date: "2026-07-03", duration_minutes: 30, role: "PT", same_building: false },
    expect: { insurance: "medical" }
  },
  {
    name: "D: 67歳・別表7未確認 → 自動判定せず要確認",
    patient: {
      patient_id: "TD", birth_date: "1959-03-03", care_level: "要介護1",
      designated_disease_hyou7: null, designated_disease_16_of_40to64: null,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-D", patient_id: "TD", date: "2026-07-03", duration_minutes: 40, role: "PT", same_building: false },
    expect: { insurance: "unknown", hasConfirm: true }
  },
  {
    name: "E: 68歳・要介護1・特別指示書期間中 → 医療保険優先",
    patient: {
      patient_id: "TE", birth_date: "1958-04-01", care_level: "要介護1",
      designated_disease_hyou7: false, designated_disease_16_of_40to64: null,
      psychiatric_non_dementia: false,
      instruction_sheet: {
        issued_date: "2026-06-01", valid_until: "2026-08-31",
        special_instruction_period: { start: "2026-06-25", end: "2026-07-08" }
      }
    },
    visit: { visit_id: "VT-E", patient_id: "TE", date: "2026-07-03", duration_minutes: 60, role: "NS", same_building: false },
    expect: { insurance: "medical" }
  },
  {
    name: "F: 72歳・要介護認定なし → 自動判定せず要確認（仕様どおり）",
    patient: {
      patient_id: "TF", birth_date: "1954-06-10", care_level: "なし（非該当・未申請）",
      designated_disease_hyou7: false, designated_disease_16_of_40to64: null,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-F", patient_id: "TF", date: "2026-07-03", duration_minutes: 40, role: "PT", same_building: false },
    expect: { insurance: "unknown", hasConfirm: true }
  },
  {
    name: "G: 50歳・特定疾病該当・別表7非該当・要介護2 → 介護保険",
    patient: {
      patient_id: "TG", birth_date: "1976-01-01", care_level: "要介護2",
      designated_disease_hyou7: false, designated_disease_16_of_40to64: true,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-G", patient_id: "TG", date: "2026-07-03", duration_minutes: 20, role: "PT", same_building: false },
    expect: { insurance: "kaigo", appliedCode: "TEST_KAIGO_PTOTST", appliedAmount: 100 }
  },
  {
    name: "H: 生年月日未入力 → 要確認",
    patient: {
      patient_id: "TH", birth_date: null, care_level: "要介護2",
      designated_disease_hyou7: false, designated_disease_16_of_40to64: null,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-H", patient_id: "TH", date: "2026-07-03", duration_minutes: 40, role: "PT", same_building: false },
    expect: { insurance: "unknown", hasConfirm: true }
  },
  {
    name: "I: 医療保険・マスタ金額未設定 → 適用0件・未確定として出る（勝手に金額を出さない）",
    patient: {
      patient_id: "TI", birth_date: "1971-02-10", care_level: "要介護3",
      designated_disease_hyou7: true, designated_disease_16_of_40to64: true,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-I", patient_id: "TI", date: "2026-07-03", duration_minutes: 60, role: "NS", same_building: false },
    expect: { insurance: "medical", appliedCount: 0, confirmedTotal: 0 }
  },
  {
    name: "J: 指示書有効期限切れ → 警告が出る",
    patient: {
      patient_id: "TJ", birth_date: "1956-01-15", care_level: "要介護2",
      designated_disease_hyou7: false, designated_disease_16_of_40to64: null,
      psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-03-01", valid_until: "2026-05-31", special_instruction_period: null }
    },
    visit: { visit_id: "VT-J", patient_id: "TJ", date: "2026-07-03", duration_minutes: 40, role: "PT", same_building: false },
    expect: { insurance: "kaigo", hasSheetWarning: true }
  }
];

/** テスト実行。app.js の Engine を受け取り、結果配列を返す */
window.runTestSuite = function (Engine) {
  const results = [];
  for (const sc of SCENARIOS) {
    const r = Engine.judgeVisit(sc.visit, sc.patient, TEST_OFFICE, TEST_MASTER);
    const checks = [];

    checks.push({
      label: "保険種別",
      expected: sc.expect.insurance,
      actual: r.insurance,
      pass: r.insurance === sc.expect.insurance
    });
    if (sc.expect.hasConfirm) {
      checks.push({ label: "要確認あり", expected: "1件以上", actual: `${r.confirm.length}件`, pass: r.confirm.length > 0 });
    }
    if (sc.expect.hasSheetWarning) {
      checks.push({ label: "指示書警告", expected: "1件以上", actual: `${r.sheetWarnings.length}件`, pass: r.sheetWarnings.length > 0 });
    }
    if (sc.expect.appliedCode) {
      const hit = r.items.applied.find(x => x.item.code === sc.expect.appliedCode);
      checks.push({ label: "基本報酬コード", expected: sc.expect.appliedCode, actual: hit ? hit.item.code : "(なし)", pass: !!hit });
      if (hit && sc.expect.appliedAmount != null) {
        checks.push({ label: "架空金額", expected: String(sc.expect.appliedAmount), actual: String(hit.amount), pass: hit.amount === sc.expect.appliedAmount });
      }
    }
    if (sc.expect.appliedCount != null) {
      checks.push({ label: "適用（確定）件数", expected: String(sc.expect.appliedCount), actual: String(r.items.applied.length), pass: r.items.applied.length === sc.expect.appliedCount });
    }
    if (sc.expect.confirmedTotal != null) {
      checks.push({ label: "確定合計", expected: String(sc.expect.confirmedTotal), actual: String(r.total.confirmed), pass: r.total.confirmed === sc.expect.confirmedTotal });
    }

    const failed = checks.filter(c => !c.pass);
    results.push({
      name: sc.name,
      pass: failed.length === 0,
      expected: checks.map(c => `${c.label}=${c.expected}`).join(", "),
      actual: checks.map(c => `${c.label}=${c.actual}`).join(", "),
      note: failed.length ? "不一致: " + failed.map(c => c.label).join(", ") : ""
    });
  }
  return results;
};

window.TEST_SCENARIOS = SCENARIOS;
window.TEST_MASTER = TEST_MASTER;
