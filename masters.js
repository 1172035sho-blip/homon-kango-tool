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

    /* ============================================================
     * 医療保険：一般の訪問看護加算・療養費（A〜C群）
     * 金額はすべて null（要確認）。amount_tiers は分岐する金額の受け皿で、
     * 各キーの値は一次資料の確認後に入れる。verification_status は3値:
     *   official_confirmed（告示本文で確認済み・合計に含める）
     *   needs_recheck（令和8年度改定で変更の可能性・要再確認）
     *   unconfirmed（未確認）
     * 精神科訪問看護特有の加算は本ツールのスコープ外のため含めない。
     * ============================================================ */

    /* ---- A群：訪問ごとに算定 ---- */
    {
      code: "MED_ADD_EMERGENCY_VISIT",
      name_ja: "緊急訪問看護加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_day",
      amount: null, unit: "円",
      amount_tiers: { within_14days: null, from_15th_day: null }, // 月14日目まで/15日目以降
      requires_notification: true, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "24時間対応体制の届出が前提。当月の緊急訪問通算日数で14日目境界。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_LONG_VISIT",
      name_ja: "長時間訪問看護加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_visit",
      amount: null, unit: "円",
      requires_notification: false, monthly_limit: null, weekly_limit_default: null, weekly_limit_special: null,
      mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "90分超が対象。週1日限度（対象者により週3日）。対象者区分と金額を一次資料で確認"
    },
    {
      code: "MED_ADD_INFANT",
      name_ja: "乳幼児加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_day",
      amount: null, unit: "円",
      amount_tiers: { standard: null, special: null }, // 標準/上位区分
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "6歳未満が対象。上位区分の対象者要件と金額を一次資料で確認"
    },
    {
      code: "MED_ADD_MULTI_VISIT_INTRACTABLE",
      name_ja: "難病等複数回訪問加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_day",
      amount: null, unit: "円",
      // 当日2回/3回以上 × 同一建物以外/同一建物
      amount_tiers: { visits2_other: null, visits2_same: null, visits3plus_other: null, visits3plus_same: null },
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "needs_recheck",
      notes: "別表7該当または特別指示期間中かつ当日2回以上。令和8年度で在宅難治性皮膚疾患処置指導管理が対象追加。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_MULTI_STAFF",
      name_ja: "複数名訪問看護加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_visit",
      amount: null, unit: "円",
      amount_tiers: { i: null, ro: null, ha: null, ni: null }, // イ/ロ/ハ/ニ（同行職種別）
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "同行者の職種でイ〜ニに区分。当日/週の算定回数と金額を一次資料で確認"
    },
    {
      code: "MED_ADD_NIGHT_EARLY",
      name_ja: "夜間・早朝訪問看護加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_visit",
      amount: null, unit: "円",
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: ["MED_ADD_DEEP_NIGHT"],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "18-22時・6-8時。時間帯の境界は time_band_definitions で確認。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_DEEP_NIGHT",
      name_ja: "深夜訪問看護加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_visit",
      amount: null, unit: "円",
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: ["MED_ADD_NIGHT_EARLY"],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "22-6時。時間帯の境界は time_band_definitions で確認。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_SPECIAL_AREA",
      name_ja: "特別地域訪問看護加算（医療）", group: "A",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_visit",
      amount: null, unit: "円", rate: null, // 所定額の50%
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "事業所からの移動1時間以上＋特別地域指定。算定率（所定額の50%）を一次資料で確認"
    },

    /* ---- B群：月次で算定する管理療養費付随加算 ---- */
    {
      code: "MED_ADD_24H_SYSTEM",
      name_ja: "24時間対応体制加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "monthly",
      amount: null, unit: "円",
      amount_tiers: { with_reduction: null, without_reduction: null }, // 業務負担軽減の取組の有無
      requires_notification: true, monthly_limit: 1, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "事業所届出＋利用者同意。取組の有無で金額区分。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_SPECIAL_MGMT",
      name_ja: "特別管理加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "monthly",
      amount: null, unit: "円",
      amount_tiers: { standard: null, severe: null }, // 標準/別表8うち重症度等の高いもの
      requires_notification: true, monthly_limit: 1, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "needs_recheck",
      notes: "別表8該当者。標準/重症の区分は利用者マスタの明示フラグで判定。令和8年度で対象追加。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_DISCHARGE_JOINT",
      name_ja: "退院時共同指導加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_month",
      amount: null, unit: "円", special_mgmt_guidance_amount: null, // 別表8該当者への特別管理指導加算
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "別表7該当者は月2回。別表8該当者には特別管理指導加算を別途。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_DISCHARGE_SUPPORT",
      name_ja: "退院支援指導加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "per_month",
      amount: null, unit: "円",
      amount_tiers: { standard: null, long: null }, // 標準/長時間
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "退院日＋指導実施記録。長時間の場合は上位区分。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_HOME_LIAISON",
      name_ja: "在宅患者連携指導加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "monthly",
      amount: null, unit: "円",
      requires_notification: false, monthly_limit: 1, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "歯科・薬局等との情報共有記録。月1回。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_EMERGENCY_CONF",
      name_ja: "在宅患者緊急時等カンファレンス加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "monthly",
      amount: null, unit: "円",
      requires_notification: false, monthly_limit: 2, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "共同カンファレンスの実施記録。月2回限度。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_SPECIALIST_MGMT",
      name_ja: "専門管理加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "monthly",
      amount: null, unit: "円",
      requires_notification: true, monthly_limit: 1, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "研修修了看護師＋対象者の状態。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_CARE_STAFF_LIAISON",
      name_ja: "看護・介護職員連携強化加算（医療）", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "monthly",
      amount: null, unit: "円",
      requires_notification: false, monthly_limit: 1, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "喀痰吸引等事業者との連携支援記録。金額を一次資料で確認"
    },
    {
      code: "MED_ADD_DX_INFO",
      name_ja: "訪問看護医療DX情報活用加算", group: "B",
      insurance_type: "medical", category: "addition", phase: 2, billing_unit: "monthly",
      amount: null, unit: "円",
      requires_notification: true, monthly_limit: 1, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "needs_recheck",
      notes: "オンライン請求・オンライン資格確認体制の届出。令和8年度の新設・区分見直しに注意。金額を一次資料で確認"
    },

    /* ---- C群：独立した療養費項目 ---- */
    {
      code: "MED_RYO_INFO_PROVIDE",
      name_ja: "訪問看護情報提供療養費Ⅰ／Ⅱ／Ⅲ", group: "C",
      insurance_type: "medical", category: "ryoyohi", phase: 3, billing_unit: "per_month",
      amount: null, unit: "円",
      amount_tiers: { i: null, ii: null, iii: null }, // 市町村等/学校/転院先医療機関
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "提供先で区分。実施記録・提供先を確認。金額を一次資料で確認"
    },
    {
      code: "MED_RYO_TERMINAL",
      name_ja: "訪問看護ターミナルケア療養費Ⅰ／Ⅱ", group: "C",
      insurance_type: "medical", category: "ryoyohi", phase: 3, billing_unit: "per_death",
      amount: null, unit: "円",
      amount_tiers: { i: null, ii: null },
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "死亡日前14日以内に2回以上の訪問＋説明・同意記録。Ⅰ/Ⅱの区分と金額を一次資料で確認"
    },
    {
      code: "MED_ADD_REMOTE_DEATH",
      name_ja: "遠隔死亡診断補助加算（医療）", group: "C",
      insurance_type: "medical", category: "addition", phase: 3, billing_unit: "per_death",
      amount: null, unit: "円",
      requires_notification: false, monthly_limit: null, mutually_exclusive_with: [],
      effective_from: null, effective_until: null, source_reference: null, verification_status: "unconfirmed",
      notes: "特定行為研修修了看護師による実施＋特別地域該当。金額を一次資料で確認"
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
