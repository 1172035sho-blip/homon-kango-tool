/* =========================================================================
 * 報酬・加算マスタ（既定値）
 * =========================================================================
 * 【最重要】このファイルの金額・算定要件・有効期間はすべて null（未設定）です。
 * 学習データや推測による仮の数値は一切入れていません。
 * 必ず一次資料（厚労省の告示・通知、または請求ソフトのマスタ出力）を確認のうえ、
 * 値を入力し verified を true にしてください。
 * 名称・区分も「※要検証」の付いたものは令和8年度改定の一次資料で確認が必要です。
 *
 * 各項目のフィールド:
 *   code                    : 内部コード（本ツール内で一意）
 *   name_ja                 : 名称（※要検証 = 一次資料で正式名称の確認が必要）
 *   insurance_type          : "medical"（医療保険）| "kaigo"（介護保険）
 *   category                : "basic"（基本報酬）| "addition"（加算）| "reduction"（減算）
 *   phase                   : 実装フェーズ（1=基本報酬, 2=優先加算, 3=その他）
 *   applies_to              : 自動マッチング条件。null のフィールドは「未確認」を意味し、
 *                             エンジンは自動判定せず「要確認」として出力する。
 *     roles                 : 対象職種の配列（null = 未確認）
 *     same_building         : true/false/null（null = 区別なし or 未確認）
 *     duration_brackets     : [{ max_minutes, amount }] 所要時間ブラケット（null = 未確認）
 *   amount                  : 単価（null = 未設定。duration_brackets を使う場合も null のまま）
 *   unit                    : "円" | "点" | "単位" | null（null = 未確認）
 *   eligibility_conditions  : 算定要件（条件キーの配列。null = 未確認）
 *   monthly_limit           : 月あたり算定回数上限（null = 未確認）
 *   mutually_exclusive_with : 併算定不可コードの配列
 *   effective_from/until    : 有効期間（null = 未確認）
 *   source_reference        : 根拠となる告示・通知番号（null = 未確認）
 *   verified                : true になるまでエンジンは金額を合計に含めない
 * ========================================================================= */

window.DEFAULT_FEE_MASTER = {
  meta: {
    master_name: "既定マスタ（未検証・全項目要確認）",
    created: "2026-07-03",
    note: "金額・要件はすべて null。一次資料の取込後に更新すること。",
    target_revision: "令和8年度改定（2026-06-01施行）の内容を一次資料で確認して反映すること"
  },

  /* 時間帯区分の定義（早朝/日中/夜間/深夜の境界時刻）。
     制度上の定義も算定要件の一部のため、一次資料で確認するまで null。 */
  time_band_definitions: {
    verified: false,
    source_reference: null,
    bands: null
    /* 確認後の記入例:
    bands: [
      { key: "early_morning", label: "早朝", from: "06:00", to: "08:00" },
      { key: "day",           label: "日中", from: "08:00", to: "18:00" },
      ...
    ] */
  },

  /* PT/OT/ST訪問割合による減算の基準（介護保険）。
     基準割合・減算率とも一次資料で確認するまで null。 */
  ptotst_ratio_reduction_rule: {
    verified: false,
    threshold_ratio: null,
    reduction_rate: null,
    source_reference: null
  },

  items: [
    /* ---------------- 介護保険：基本報酬 ---------------- */
    {
      code: "KAIGO_BASIC_PTOTST",
      name_ja: "訪問看護費（理学療法士・作業療法士・言語聴覚士による訪問）※名称・区分要検証",
      insurance_type: "kaigo", category: "basic", phase: 1,
      applies_to: { roles: ["PT", "OT", "ST"], same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "20分単位の区分・1日の回数による減算等の有無を一次資料で確認すること"
    },
    {
      code: "KAIGO_BASIC_NURSE",
      name_ja: "訪問看護費（看護職員による訪問・時間区分別）※名称・区分要検証",
      insurance_type: "kaigo", category: "basic", phase: 1,
      applies_to: { roles: ["NS", "PHN", "LPN"], same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "20分未満/30分未満/30〜60分/60〜90分等の区分を一次資料で確認すること"
    },
    {
      code: "KAIGO_RED_PTOTST_RATIO",
      name_ja: "理学療法士等の訪問割合が基準超過の場合の減算 ※要検証",
      insurance_type: "kaigo", category: "reduction", phase: 1,
      applies_to: { roles: ["PT", "OT", "ST"], same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: ["office.ptotst_ratio_exceeds_threshold"],
      monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "基準割合・減算率は ptotst_ratio_reduction_rule に記入"
    },
    {
      code: "KAIGO_RED_SAME_BUILDING",
      name_ja: "同一建物等居住者への訪問に係る減算 ※要検証",
      insurance_type: "kaigo", category: "reduction", phase: 1,
      applies_to: { roles: null, same_building: true, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "減算率・対象人数要件を一次資料で確認すること"
    },

    /* ---------------- 医療保険：基本報酬 ---------------- */
    {
      code: "MED_BASIC_RYOYOHI_1",
      name_ja: "訪問看護基本療養費（Ⅰ）※名称・区分要検証（令和8年度改定での包括型の新設有無も確認）",
      insurance_type: "medical", category: "basic", phase: 1,
      applies_to: { roles: null, same_building: false, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "職種別（看護師/PT等）・週3日目まで/4日目以降の区分を一次資料で確認すること"
    },
    {
      code: "MED_BASIC_RYOYOHI_2",
      name_ja: "訪問看護基本療養費（Ⅱ）（同一建物居住者）※名称・区分要検証",
      insurance_type: "medical", category: "basic", phase: 1,
      applies_to: { roles: null, same_building: true, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: ""
    },
    {
      code: "MED_KANRI_RYOYOHI",
      name_ja: "訪問看護管理療養費 ※名称・区分（機能強化型等）要検証",
      insurance_type: "medical", category: "basic", phase: 1,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "月の初日/2日目以降の区分、機能強化型1〜3の区分を一次資料で確認すること"
    },

    /* ---------------- Phase 2 予定：優先加算（要件・金額とも未整備） ---------------- */
    {
      code: "MED_ADD_URGENT",
      name_ja: "緊急時訪問看護加算（医療）※要検証",
      insurance_type: "medical", category: "addition", phase: 2,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "令和6年度改定で24時間対応体制加算との関係が変わっている可能性。最新一次資料で確認"
    },
    {
      code: "MED_ADD_SPECIAL_MGMT",
      name_ja: "特別管理加算（医療）※要検証",
      insurance_type: "medical", category: "addition", phase: 2,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "別表8該当者。重症度別の区分を一次資料で確認"
    },
    {
      code: "MED_ADD_MULTI_STAFF",
      name_ja: "複数名訪問看護加算（医療）※要検証",
      insurance_type: "medical", category: "addition", phase: 2,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: "同行職種の組み合わせ別の区分を一次資料で確認"
    },
    {
      code: "MED_ADD_LONG_VISIT",
      name_ja: "長時間訪問看護加算（医療）※要検証",
      insurance_type: "medical", category: "addition", phase: 2,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: ""
    },
    {
      code: "KAIGO_ADD_URGENT",
      name_ja: "緊急時訪問看護加算（介護）※要検証",
      insurance_type: "kaigo", category: "addition", phase: 2,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: ["office.urgent_visit_registered"],
      monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: ""
    },
    {
      code: "KAIGO_ADD_SPECIAL_MGMT",
      name_ja: "特別管理加算（介護）※要検証",
      insurance_type: "kaigo", category: "addition", phase: 2,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: ""
    },
    {
      code: "KAIGO_ADD_FIRST_VISIT",
      name_ja: "初回加算（介護）※要検証",
      insurance_type: "kaigo", category: "addition", phase: 2,
      applies_to: { roles: null, same_building: null, duration_brackets: null },
      amount: null, unit: null,
      eligibility_conditions: null, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verified: false,
      notes: ""
    }
  ]
};
