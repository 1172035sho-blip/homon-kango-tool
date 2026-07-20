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
  // 加算テスト用に時間帯区分を設定（架空。深夜=22時〜翌6時）
  time_band_definitions: {
    verified: true, source_reference: "テスト用（実在せず）",
    bands: [
      { key: "early_morning", label: "早朝", from: "06:00", to: "08:00" },
      { key: "day",           label: "日中", from: "08:00", to: "18:00" },
      { key: "night",         label: "夜間", from: "18:00", to: "22:00" },
      { key: "deep_night",    label: "深夜", from: "22:00", to: "24:00" },
      { key: "deep_night",    label: "深夜", from: "00:00", to: "06:00" }
    ]
  },
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
    },
    /* --- 加算テスト用（すべて架空金額・実在の点数ではない） --- */
    {
      code: "MED_ADD_EMERGENCY_VISIT", name_ja: "【テスト】緊急訪問看護加算（架空）",
      insurance_type: "medical", category: "addition", billing_unit: "per_day",
      amount: null, unit: "円(架空)", amount_tiers: { within_14days: 900, from_15th_day: 700 },
      monthly_limit: null, mutually_exclusive_with: [],
      effective_from: "2026-06-01", source_reference: "テスト用（実在せず）", verification_status: "official_confirmed"
    },
    {
      code: "MED_ADD_DEEP_NIGHT", name_ja: "【テスト】深夜訪問看護加算（架空）",
      insurance_type: "medical", category: "addition", billing_unit: "per_visit",
      amount: 800, unit: "円(架空)",
      monthly_limit: null, mutually_exclusive_with: ["MED_ADD_NIGHT_EARLY"],
      effective_from: "2026-06-01", source_reference: "テスト用（実在せず）", verification_status: "official_confirmed"
    },
    {
      code: "MED_ADD_NIGHT_EARLY", name_ja: "【テスト】夜間・早朝訪問看護加算（架空）",
      insurance_type: "medical", category: "addition", billing_unit: "per_visit",
      amount: 400, unit: "円(架空)",
      monthly_limit: null, mutually_exclusive_with: ["MED_ADD_DEEP_NIGHT"],
      effective_from: "2026-06-01", source_reference: "テスト用（実在せず）", verification_status: "official_confirmed"
    },
    {
      code: "MED_ADD_SPECIAL_MGMT", name_ja: "【テスト】特別管理加算（架空）",
      insurance_type: "medical", category: "addition", billing_unit: "monthly",
      amount: null, unit: "円(架空)", amount_tiers: { standard: 500, severe: 999 },
      monthly_limit: 1, mutually_exclusive_with: [],
      effective_from: "2026-06-01", source_reference: "テスト用（実在せず）", verification_status: "official_confirmed"
    },
    {
      code: "MED_RYO_TERMINAL", name_ja: "【テスト】ターミナルケア療養費（架空）",
      insurance_type: "medical", category: "ryoyohi", billing_unit: "per_death",
      amount: null, unit: "円(架空)", amount_tiers: { i: null, ii: null },
      monthly_limit: null, mutually_exclusive_with: [],
      effective_from: "2026-06-01", source_reference: "テスト用（実在せず）", verification_status: "official_confirmed"
    }
  ]
};

const TEST_OFFICE = {
  urgent_visit_registered: null, ptotst_visit_ratio: null,
  system_24h_registered: null, dx_info_registered: null, special_area: null, notes: ""
};

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
  },

  /* ===== 医療加算のシナリオ（架空マスタで金額まで検証） ===== */
  {
    name: "加算C: 別表8該当（留置カテーテル・標準）→ 特別管理加算（標準・架空500）",
    patient: {
      patient_id: "TK", birth_date: "1990-01-01", care_level: null,
      designated_disease_hyou7: false, designated_disease_16_of_40to64: false, psychiatric_non_dementia: false,
      beppyou8_applicable: true, beppyou8_severe: false, beppyou8_items: "留置カテーテル",
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visits: [
      { visit_id: "VT-K1", patient_id: "TK", date: "2026-07-03", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false }
    ],
    probeVisitIndex: 0,
    expect: {
      insurance: "medical",
      monthlyAdditions: [{ code: "MED_ADD_SPECIAL_MGMT", status: "matched", amount: 500 }]
    }
  },
  {
    name: "加算D: 月5日目・深夜0時に緊急訪問 → 緊急訪問看護加算（架空900）＋深夜訪問看護加算（架空800）",
    office: {
      urgent_visit_registered: null, ptotst_visit_ratio: null,
      system_24h_registered: true, dx_info_registered: null, special_area: null, notes: ""
    },
    patient: {
      patient_id: "TL", birth_date: "1970-01-01", care_level: null,
      designated_disease_hyou7: true, designated_disease_16_of_40to64: null, psychiatric_non_dementia: false,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visits: [
      { visit_id: "VT-L1", patient_id: "TL", date: "2026-07-01", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false, is_emergency: true },
      { visit_id: "VT-L2", patient_id: "TL", date: "2026-07-02", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false, is_emergency: true },
      { visit_id: "VT-L3", patient_id: "TL", date: "2026-07-03", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false, is_emergency: true },
      { visit_id: "VT-L4", patient_id: "TL", date: "2026-07-04", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false, is_emergency: true },
      { visit_id: "VT-L5", patient_id: "TL", date: "2026-07-05", start_time: "00:00", duration_minutes: 40, role: "NS", same_building: false, is_emergency: true }
    ],
    probeVisitIndex: 4,
    expect: {
      insurance: "medical",
      visitAdditions: [
        { code: "MED_ADD_EMERGENCY_VISIT", status: "matched", amount: 900 },
        { code: "MED_ADD_DEEP_NIGHT", status: "matched", amount: 800 }
      ]
    }
  },
  {
    name: "加算E: 死亡日前10日・5日・当日に訪問 → ターミナルケア療養費（前14日2回以上を充足）",
    patient: {
      patient_id: "TM", birth_date: "1990-01-01", care_level: null,
      designated_disease_hyou7: false, designated_disease_16_of_40to64: false, psychiatric_non_dementia: false,
      death_date: "2026-07-15", terminal_consent: true,
      instruction_sheet: { issued_date: "2026-06-01", valid_until: "2026-08-31", special_instruction_period: null }
    },
    visits: [
      { visit_id: "VT-M1", patient_id: "TM", date: "2026-07-05", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false },
      { visit_id: "VT-M2", patient_id: "TM", date: "2026-07-10", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false },
      { visit_id: "VT-M3", patient_id: "TM", date: "2026-07-15", start_time: "10:00", duration_minutes: 40, role: "NS", same_building: false }
    ],
    probeVisitIndex: 2,
    expect: {
      insurance: "medical",
      monthlyAdditions: [{ code: "MED_RYO_TERMINAL", statusNot: "needs_check", reasonIncludes: "2回以上" }]
    }
  }
];

/** テスト実行。app.js の Engine を受け取り、結果配列を返す */
window.runTestSuite = function (Engine) {
  const results = [];
  for (const sc of SCENARIOS) {
    const office = sc.office || TEST_OFFICE;
    // 加算シナリオは visits（複数）を集計する。従来シナリオは単一 visit。
    const visits = sc.visits || [sc.visit];
    const probe = visits[sc.probeVisitIndex || 0];
    const monthCtx = Engine.buildMonthContext(sc.patient.patient_id, visits, visits);
    const r = Engine.judgeVisit(probe, sc.patient, office, TEST_MASTER, monthCtx);
    const checks = [];

    checks.push({
      label: "保険種別",
      expected: sc.expect.insurance,
      actual: r.insurance,
      pass: r.insurance === sc.expect.insurance
    });

    // 訪問ごとの加算（probe 訪問）
    if (sc.expect.visitAdditions) {
      for (const exp of sc.expect.visitAdditions) {
        const hit = (r.additions || []).find(x => x.item.code === exp.code);
        checks.push({ label: `加算[${exp.code}]`, expected: exp.status, actual: hit ? hit.status : "(なし)", pass: hit && hit.status === exp.status });
        if (hit && exp.amount != null) {
          checks.push({ label: `加算額[${exp.code}]`, expected: String(exp.amount), actual: String(hit.amount), pass: hit.amount === exp.amount });
        }
      }
    }

    // 月次の加算・療養費
    if (sc.expect.monthlyAdditions) {
      const monthly = Engine.medMonthlyAdditions(sc.patient, office, TEST_MASTER, monthCtx, (probe.date || "").slice(0, 7));
      for (const exp of sc.expect.monthlyAdditions) {
        const hit = monthly.find(x => x.item.code === exp.code);
        if (exp.status) {
          checks.push({ label: `月次[${exp.code}]`, expected: exp.status, actual: hit ? hit.status : "(なし)", pass: hit && hit.status === exp.status });
        }
        if (exp.statusNot) {
          checks.push({ label: `月次[${exp.code}]≠`, expected: "≠" + exp.statusNot, actual: hit ? hit.status : "(なし)", pass: hit && hit.status !== exp.statusNot });
        }
        if (hit && exp.amount != null) {
          checks.push({ label: `月次額[${exp.code}]`, expected: String(exp.amount), actual: String(hit.amount), pass: hit.amount === exp.amount });
        }
        if (hit && exp.reasonIncludes) {
          const ok = hit.reasons.some(s => s.indexOf(exp.reasonIncludes) >= 0);
          checks.push({ label: `月次根拠[${exp.code}]`, expected: "含:" + exp.reasonIncludes, actual: ok ? "含む" : "含まない", pass: ok });
        }
      }
    }
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
