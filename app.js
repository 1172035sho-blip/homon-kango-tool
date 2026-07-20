/* =========================================================================
 * 訪問看護 算定判定支援ツール
 * -------------------------------------------------------------------------
 * ・判定・計算はすべて決定的なルールベース（テーブル参照・条件分岐）。
 *   LLM等による生成的判断は一切行わない。
 * ・不明な値は必ず「要確認」として明示し、推測で埋めない。
 * ・本ツールは算定支援・シミュレーション用であり、公式な請求根拠ではない。
 * ========================================================================= */
"use strict";

/* ============================ 定数・語彙 ============================ */

const ROLES = {
  PT:  "理学療法士",
  OT:  "作業療法士",
  ST:  "言語聴覚士",
  NS:  "看護師",
  PHN: "保健師",
  LPN: "准看護師"
};

const CARE_LEVELS_CERTIFIED = ["要支援1", "要支援2", "要介護1", "要介護2", "要介護3", "要介護4", "要介護5"];
const CARE_LEVELS_ALL = [...CARE_LEVELS_CERTIFIED, "なし（非該当・未申請）", "申請中", "不明"];

const INSURANCE_LABEL = { medical: "医療保険", kaigo: "介護保険", unknown: "要確認" };

const CONDITION_LABELS = {
  "office.urgent_visit_registered": "緊急時訪問看護（24時間対応）体制の届出",
  "office.ptotst_ratio_exceeds_threshold": "理学療法士等の訪問割合が基準を超過"
};

/* 報酬マスタ項目の検証状態（3値）。official_confirmed のみ合計に含める。 */
const VERIFICATION_LABELS = {
  official_confirmed: "検証済",
  needs_recheck: "要再確認",
  unconfirmed: "未検証"
};

/* 複数名訪問看護加算の同行者職種（イ/ロ/ハ/ニの区分は一次資料で確認）。 */
const PARTNER_ROLES = {
  NS:  "看護師等",
  PT:  "理学療法士等（PT/OT/ST）",
  LPN: "准看護師",
  AIDE: "看護補助者",
  OTHER: "その他"
};

/* 訪問時に「実施した記録」のチェック項目。B群・C群の加算判定に使用する。
   実施の有無は記録から入力する事実であり、本ツールが推測で埋めることはしない。 */
const VISIT_ACTIVITIES = {
  discharge_support:  "退院支援指導を実施",
  home_liaison:       "在宅患者連携指導（歯科・薬局等との情報共有）を実施",
  emergency_conf:     "在宅患者緊急時等カンファレンスを実施",
  specialist_mgmt:    "専門管理（研修修了看護師による管理）を実施",
  care_staff_liaison: "喀痰吸引等事業者との連携支援を実施",
  info_provide_1:     "情報提供療養費Ⅰ（市町村等へ提供）",
  info_provide_2:     "情報提供療養費Ⅱ（学校等へ提供）",
  info_provide_3:     "情報提供療養費Ⅲ（転院・入院先医療機関へ提供）",
  remote_death:       "遠隔死亡診断の補助を実施"
};

/* ============================ 汎用ヘルパー ============================ */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function isBlank(v) { return v === null || v === undefined || v === ""; }

/** 誕生日から基準日時点の年齢（満年齢）。入力不備は null */
function calcAge(birthDate, onDate) {
  if (isBlank(birthDate) || isBlank(onDate)) return null;
  const b = birthDate.split("-").map(Number);
  const o = onDate.split("-").map(Number);
  if (b.length !== 3 || o.length !== 3 || b.some(isNaN) || o.some(isNaN)) return null;
  let age = o[0] - b[0];
  if (o[1] < b[1] || (o[1] === b[1] && o[2] < b[2])) age--;
  return age >= 0 ? age : null;
}

/** ISO日付文字列に n 日を加減した ISO日付を返す（入力不備は元の文字列を返す） */
function addDaysISO(iso, n) {
  if (isBlank(iso)) return iso;
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  d.setDate(d.getDate() + n);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO日付文字列 date が period {start,end} 内か。判定不能は null */
function isWithinPeriod(date, period) {
  if (!period || isBlank(period.start) || isBlank(period.end) || isBlank(date)) return null;
  return date >= period.start && date <= period.end;
}

/* ============================ 判定エンジン ============================ */
/* すべて純粋関数。trace（判定過程）と confirm（要確認事項）を必ず返す。 */

const Engine = {

  /** 三値フラグの表示 */
  triLabel(v) {
    if (v === true) return "該当";
    if (v === false) return "非該当";
    return "未確認";
  },

  /** マスタ項目の検証状態（3値）。旧 verified(boolean) は後方互換でマッピング。 */
  verState(item) {
    if (item && item.verification_status) return item.verification_status;
    if (item && item.verified === true) return "official_confirmed";
    return "unconfirmed";
  },
  /** 合計に含めてよいか（告示本文で確認済み かつ 金額あり のみ true） */
  isOfficial(item) { return Engine.verState(item) === "official_confirmed"; },

  /**
   * 保険種別判定
   * 骨子はユーザー指定仕様に基づく。詳細な適用条件は一次資料での確認が前提。
   * @returns { insurance, reasons[], confirm[], trace[] }
   */
  judgeInsurance(patient, visitDate) {
    const trace = [];
    const confirm = [];
    const reasons = [];
    const done = (insurance) => ({ insurance, reasons, confirm, trace });

    // 年齢は生年月日から算出する。かんたん判定など生年月日を持たない入力のために
    // age_at_visit（訪問日時点の満年齢）での直接指定も受け付ける。
    const direct = patient.age_at_visit;
    const age = (direct === null || direct === undefined || direct === "" || isNaN(Number(direct)))
      ? calcAge(patient.birth_date, visitDate)
      : Number(direct);
    if (age === null) {
      trace.push({ step: "年齢の算出", result: "不可", note: "生年月日または訪問日が未入力・不正" });
      confirm.push("生年月日が未入力のため年齢を判定できません");
      return done("unknown");
    }
    trace.push({
      step: "年齢の算出",
      result: `${age}歳`,
      note: (direct === null || direct === undefined || direct === "")
        ? `生年月日 ${patient.birth_date} / 基準日 ${visitDate}`
        : `年齢を直接入力 / 基準日 ${visitDate}`
    });

    const hyou7 = patient.designated_disease_hyou7;           // 別表7該当
    const tokutei = patient.designated_disease_16_of_40to64;  // 特定疾病（16疾病）該当
    const psychNonDementia = patient.psychiatric_non_dementia; // 精神科訪問看護対象（認知症除く）
    const careLevel = patient.care_level;
    const certified = CARE_LEVELS_CERTIFIED.includes(careLevel) ? true
      : (careLevel === "なし（非該当・未申請）" ? false : null);

    // 特別訪問看護指示書の期間中か
    const sp = (patient.instruction_sheet && patient.instruction_sheet.special_instruction_period) || null;
    const inSpecial = isWithinPeriod(visitDate, sp);
    if (sp && (sp.start || sp.end)) {
      trace.push({
        step: "特別訪問看護指示書の期間判定",
        result: inSpecial === true ? "期間内" : inSpecial === false ? "期間外" : "判定不能",
        note: `期間 ${sp.start || "?"} 〜 ${sp.end || "?"}`
      });
      if (inSpecial === null) confirm.push("特別指示書の期間の入力が不完全です");
    }

    /* --- 医療保険が優先されるケース（年齢によらず先に判定） --- */
    if (inSpecial === true) {
      reasons.push("特別訪問看護指示書の交付期間中のため医療保険が優先");
      trace.push({ step: "医療保険優先の判定", result: "医療保険", note: "特別指示期間中" });
      return done("medical");
    }
    if (hyou7 === true) {
      reasons.push("厚生労働大臣が定める疾病等（別表7）に該当するため医療保険が優先");
      trace.push({ step: "医療保険優先の判定", result: "医療保険", note: "別表7該当" });
      return done("medical");
    }

    /* --- 40歳未満 --- */
    if (age < 40) {
      reasons.push("40歳未満は介護保険の被保険者に該当しないため医療保険");
      trace.push({ step: "年齢区分", result: "医療保険", note: "40歳未満" });
      if (hyou7 === null) confirm.push("別表7該当の有無が未確認です（保険種別には影響しませんが加算判定に必要）");
      return done("medical");
    }

    /* --- 40〜64歳（第2号被保険者） --- */
    if (age < 65) {
      trace.push({ step: "年齢区分", result: "40〜64歳（第2号被保険者相当）", note: "" });
      if (tokutei === null) {
        confirm.push("介護保険の特定疾病（16疾病）該当の有無が未確認です");
        trace.push({ step: "特定疾病の判定", result: "判定不能", note: "未確認" });
        return done("unknown");
      }
      if (tokutei === false) {
        reasons.push("40〜64歳で介護保険の特定疾病に非該当のため医療保険");
        trace.push({ step: "特定疾病の判定", result: "医療保険", note: "特定疾病 非該当" });
        return done("medical");
      }
      // 特定疾病該当 → 介護保険の可能性。ただし別表7未確認なら決め打ちしない
      trace.push({ step: "特定疾病の判定", result: "該当", note: "" });
      if (hyou7 === null) {
        confirm.push("別表7該当の有無が未確認です（該当なら医療保険が優先されます）");
        return done("unknown");
      }
      if (certified === true) {
        reasons.push("40〜64歳・特定疾病該当・要介護認定ありのため介護保険");
        trace.push({ step: "要介護認定の確認", result: "介護保険", note: `認定区分: ${careLevel}` });
        return done("kaigo");
      }
      confirm.push("特定疾病該当ですが要介護認定の状況が「" + (careLevel || "未入力") + "」のため、自動判定しません");
      trace.push({ step: "要介護認定の確認", result: "判定不能", note: "認定状況が確認できない" });
      return done("unknown");
    }

    /* --- 65歳以上（第1号被保険者） --- */
    trace.push({ step: "年齢区分", result: "65歳以上（第1号被保険者相当）", note: "" });
    if (psychNonDementia === true) {
      reasons.push("精神科訪問看護（認知症を除く）の対象のため医療保険が優先");
      trace.push({ step: "医療保険優先の判定", result: "医療保険", note: "精神科訪問看護（認知症除く）" });
      return done("medical");
    }
    if (hyou7 === null) {
      confirm.push("別表7該当の有無が未確認です（該当なら医療保険が優先されます）");
      trace.push({ step: "別表7の確認", result: "判定不能", note: "未確認" });
      return done("unknown");
    }
    if (psychNonDementia === null) {
      confirm.push("精神科訪問看護（認知症を除く）の該当有無が未確認です");
      trace.push({ step: "精神科訪問看護の確認", result: "判定不能", note: "未確認" });
      return done("unknown");
    }
    if (certified === true) {
      reasons.push("65歳以上・要介護（要支援）認定ありのため原則どおり介護保険");
      trace.push({ step: "要介護認定の確認", result: "介護保険", note: `認定区分: ${careLevel}` });
      return done("kaigo");
    }
    // 認定なし・申請中・不明は自動判定しない（仕様どおり）
    confirm.push("要介護認定が「" + (careLevel || "未入力") + "」のため自動判定しません（認定なしの場合は医療保険となる可能性がありますが、一次資料と認定状況を確認してください）");
    trace.push({ step: "要介護認定の確認", result: "判定不能", note: "認定なし／申請中／不明" });
    return done("unknown");
  },

  /** 指示書の有効性チェック（構造チェックのみ。要件の詳細は一次資料で確認） */
  checkInstructionSheet(patient, visitDate) {
    const warnings = [];
    const sheet = patient.instruction_sheet || {};
    if (isBlank(sheet.issued_date) && isBlank(sheet.valid_until)) {
      warnings.push("訪問看護指示書の情報が未入力です（有効な指示書がない訪問は算定できません）");
      return warnings;
    }
    if (!isBlank(sheet.valid_until) && visitDate > sheet.valid_until) {
      warnings.push(`訪問日が指示書の有効期限（${sheet.valid_until}）を過ぎています`);
    }
    if (!isBlank(sheet.issued_date) && visitDate < sheet.issued_date) {
      warnings.push(`訪問日が指示書の交付日（${sheet.issued_date}）より前です`);
    }
    return warnings;
  },

  /** 時間帯区分。マスタの定義が未検証なら「要確認」を返す */
  getTimeBand(visit, master) {
    if (isBlank(visit.start_time)) {
      return { band: null, label: "未入力", confirm: "開始時刻が未入力のため時間帯（早朝/日中/夜間/深夜）を判定できません" };
    }
    const def = master.time_band_definitions;
    if (!def || !def.verified || !def.bands) {
      return { band: null, label: "定義未設定", confirm: "時間帯区分の境界時刻がマスタ未設定です（一次資料で確認して設定してください）" };
    }
    for (const b of def.bands) {
      if (visit.start_time >= b.from && visit.start_time < b.to) {
        return { band: b.key, label: b.label, confirm: null };
      }
    }
    return { band: null, label: "判定不能", confirm: "開始時刻がどの時間帯定義にも一致しません（マスタの定義を確認してください）" };
  },

  /** 事業所・訪問の文脈から算定要件キーを評価。true/false/null(未確認) */
  evalCondition(key, ctx) {
    if (key === "office.urgent_visit_registered") {
      return ctx.office ? toTri(ctx.office.urgent_visit_registered) : null;
    }
    if (key === "office.ptotst_ratio_exceeds_threshold") {
      const rule = ctx.master.ptotst_ratio_reduction_rule;
      const ratio = ctx.office ? ctx.office.ptotst_visit_ratio : null;
      if (!rule || !rule.verified || rule.threshold_ratio == null || ratio == null) return null;
      return Number(ratio) > Number(rule.threshold_ratio);
    }
    return null; // 未知の条件キーは評価しない＝要確認

    function toTri(v) { return v === true ? true : v === false ? false : null; }
  },

  /**
   * マスタ項目1件を訪問に対して評価する。
   * @returns { status: "matched"|"matched_unconfirmed"|"needs_check"|"excluded",
   *            amount, reasons[], confirms[] }
   */
  evaluateItem(item, ctx) {
    const reasons = [];   // 該当・非該当の根拠
    const confirms = [];  // 未確認事項
    let excluded = false;
    let unknown = false;

    const ap = item.applies_to || {};
    const { visit } = ctx;

    // 職種
    if (ap.roles === null || ap.roles === undefined) {
      confirms.push("対象職種がマスタ未設定");
      unknown = true;
    } else if (ap.roles.includes(visit.role)) {
      reasons.push(`対象職種（${ROLES[visit.role] || visit.role}）に該当`);
    } else {
      reasons.push(`対象職種外（この項目の対象: ${ap.roles.map(r => ROLES[r] || r).join("・")}）`);
      excluded = true;
    }

    // 同一建物
    if (ap.same_building === true || ap.same_building === false) {
      if (visit.same_building === null || visit.same_building === undefined) {
        confirms.push("同一建物居住者か否かが訪問記録に未入力");
        unknown = true;
      } else if (visit.same_building === ap.same_building) {
        reasons.push(ap.same_building ? "同一建物居住者への訪問に該当" : "同一建物居住者以外への訪問に該当");
      } else {
        reasons.push(ap.same_building ? "同一建物居住者ではないため対象外" : "同一建物居住者のため対象外");
        excluded = true;
      }
    }

    // 有効期間
    if (isBlank(item.effective_from)) {
      confirms.push("有効開始日がマスタ未設定（改定をまたぐ適用可否を確認できません）");
      unknown = true;
    } else {
      if (visit.date < item.effective_from) { reasons.push(`有効開始日（${item.effective_from}）前の訪問のため対象外`); excluded = true; }
      else if (!isBlank(item.effective_until) && visit.date > item.effective_until) { reasons.push(`有効終了日（${item.effective_until}）後の訪問のため対象外`); excluded = true; }
      else reasons.push("マスタの有効期間内の訪問");
    }

    // 算定要件（条件キー）
    if (item.eligibility_conditions === null || item.eligibility_conditions === undefined) {
      confirms.push("算定要件がマスタ未設定（一次資料で確認が必要）");
      unknown = true;
    } else {
      for (const key of item.eligibility_conditions) {
        const label = CONDITION_LABELS[key] || key;
        const v = Engine.evalCondition(key, ctx);
        if (v === true) reasons.push(`要件「${label}」を満たす`);
        else if (v === false) { reasons.push(`要件「${label}」を満たさない`); excluded = true; }
        else { confirms.push(`要件「${label}」が未確認（事業所設定またはマスタが未入力）`); unknown = true; }
      }
    }

    // 金額（所要時間ブラケット or 単一金額）
    let amount = null;
    if (ap.duration_brackets && Array.isArray(ap.duration_brackets)) {
      const d = visit.duration_minutes;
      if (d == null) {
        confirms.push("所要時間が未入力のため時間区分を判定できません");
        unknown = true;
      } else {
        const sorted = [...ap.duration_brackets].sort((a, b) => a.max_minutes - b.max_minutes);
        const hit = sorted.find(b => d <= b.max_minutes);
        if (hit) { amount = hit.amount; reasons.push(`所要時間${d}分 → ${hit.max_minutes}分以下の区分`); }
        else { reasons.push(`所要時間${d}分がどの時間区分（最大${sorted[sorted.length - 1].max_minutes}分）にも該当しません`); confirms.push("時間区分の上限を超えています（長時間の扱いを一次資料で確認）"); unknown = true; }
      }
    } else if (item.amount != null) {
      amount = item.amount;
    } else {
      confirms.push("金額（単価・点数・単位数）がマスタ未設定");
    }

    const vstate = Engine.verState(item);
    if (vstate !== "official_confirmed") {
      confirms.push(vstate === "needs_recheck"
        ? "この項目は令和8年度改定で変更の可能性があり要再確認です（一次資料と照合するまで合計に含めません）"
        : "この項目は未検証です（一次資料と照合し検証済にするまで合計に含めません）");
    }

    let status;
    if (excluded) status = "excluded";
    else if (unknown) status = "needs_check";
    else if (vstate === "official_confirmed" && amount != null) status = "matched";
    else status = "matched_unconfirmed";

    return { status, amount, reasons, confirms };
  },

  /**
   * 訪問1件の総合判定：保険種別 → 基本報酬・減算の評価 → 合計 → 訪問ごとの医療加算
   * monthCtx（同一利用者・同一月の集計）が渡された場合のみ、訪問ごとの医療加算を評価する。
   */
  judgeVisit(visit, patient, office, master, monthCtx) {
    const result = {
      visit, patient,
      insurance: null,
      judgment: null,
      timeBand: null,
      sheetWarnings: [],
      items: { applied: [], unconfirmed: [], needsCheck: [], excluded: [] },
      additions: [],
      total: { confirmed: 0, unit: null, complete: false },
      confirm: []
    };

    if (!patient) {
      result.insurance = "unknown";
      result.confirm.push(`利用者 ${visit.patient_id} が利用者マスタに存在しません`);
      return result;
    }

    result.judgment = Engine.judgeInsurance(patient, visit.date);
    result.insurance = result.judgment.insurance;
    result.confirm.push(...result.judgment.confirm);

    result.sheetWarnings = Engine.checkInstructionSheet(patient, visit.date);
    result.timeBand = Engine.getTimeBand(visit, master);
    if (result.timeBand.confirm) result.confirm.push(result.timeBand.confirm);

    if (result.insurance === "unknown") {
      result.confirm.push("保険種別が確定しないため、基本報酬・加算の評価を行いません");
      return result;
    }

    const ctx = { visit, patient, office, master };
    const units = new Set();
    for (const item of master.items) {
      if (item.insurance_type !== result.insurance) continue;
      // 医療保険の加算・療養費は専用の加算エンジン（medVisitAdditions/medMonthlyAdditions）で
      // 評価するため、基本報酬ループでは二重に処理しない。
      if (result.insurance === "medical" && (item.category === "addition" || item.category === "ryoyohi")) continue;
      const ev = Engine.evaluateItem(item, ctx);
      const row = { item, ...ev };
      if (ev.status === "matched") {
        result.items.applied.push(row);
        result.total.confirmed += ev.amount;
        if (item.unit) units.add(item.unit);
      } else if (ev.status === "matched_unconfirmed") {
        result.items.unconfirmed.push(row);
      } else if (ev.status === "needs_check") {
        result.items.needsCheck.push(row);
      } else {
        result.items.excluded.push(row);
      }
    }
    result.total.unit = units.size === 1 ? [...units][0] : (units.size > 1 ? "混在" : null);
    result.total.complete =
      result.items.unconfirmed.length === 0 && result.items.needsCheck.length === 0 && result.confirm.length === 0;

    const nCheck = result.items.unconfirmed.length + result.items.needsCheck.length;
    if (nCheck > 0) {
      result.confirm.push(`評価できない・未検証の項目が${nCheck}件あります（合計は確定金額のみの参考値です）`);
    }

    // 医療保険：訪問ごとに算定する加算（A群）。月コンテキストがある場合のみ評価。
    if (result.insurance === "medical" && monthCtx) {
      result.additions = Engine.medVisitAdditions(visit, patient, office, master, monthCtx);
    }
    return result;
  },

  /* ===================== 医療保険 加算判定（A〜C群） =====================
   * すべて決定的なルールベース。金額はマスタから取得し、未設定は null のまま
   * 「要確認」として出力する（推測で埋めない）。実施の有無は記録からの入力事実。 */

  /** 同一利用者・同一月の訪問を集計したコンテキストを作る。
   *  allVisits を渡すと、月をまたぐ判定（ターミナル死亡前14日等）にも対応する。 */
  buildMonthContext(patientId, monthVisits, allVisits) {
    const mv = monthVisits
      .filter(v => v.patient_id === patientId)
      .slice()
      .sort((a, b) => (a.date + (a.start_time || "")).localeCompare(b.date + (b.start_time || "")));
    const byDate = {};
    mv.forEach(v => { (byDate[v.date] = byDate[v.date] || []).push(v); });
    const emergencyDates = [...new Set(mv.filter(v => v.is_emergency).map(v => v.date))].sort();
    const av = (allVisits || monthVisits).filter(v => v.patient_id === patientId);
    return { patientId, visits: mv, allVisits: av, byDate, emergencyDates };
  },

  /** 加算1件分の結果行を作る。master に該当コードがなければ最小の item を合成する。 */
  addRow(master, code, name, res) {
    const item = (master.items || []).find(i => i.code === code)
      || { code, name_ja: name, unit: null, source_reference: null, verification_status: "unconfirmed" };
    return {
      item,
      status: res.status,
      amount: res.amount == null ? null : res.amount,
      reasons: res.reasons || [],
      confirms: res.confirms || []
    };
  },

  /** 加算の状態を決める。missing=判定に必要な入力が欠けている。 */
  addStatus(item, amount, missing) {
    if (missing) return "needs_check";
    if (item && Engine.isOfficial(item) && amount != null) return "matched";
    return "matched_unconfirmed";
  },

  /** 訪問ごとの医療加算（A群）を評価して行の配列を返す。 */
  medVisitAdditions(visit, patient, office, master, ctx) {
    const rows = [];
    const items = master.items || [];
    const find = (code) => items.find(i => i.code === code) || null;
    const tier = (item, key) => (item && item.amount_tiers) ? item.amount_tiers[key] : null;
    const push = (code, name, res) => rows.push(Engine.addRow(master, code, name, res));

    const sp = patient.instruction_sheet && patient.instruction_sheet.special_instruction_period;
    const inSpecial = isWithinPeriod(visit.date, sp) === true;
    const hyou7 = patient.designated_disease_hyou7;
    const sameBuilding = visit.same_building === true;

    /* 1. 緊急訪問看護加算（当月の緊急訪問通算日数で14日目境界） */
    if (visit.is_emergency === true) {
      const item = find("MED_ADD_EMERGENCY_VISIT");
      const reasons = [], confirms = [];
      const idx = ctx.emergencyDates.indexOf(visit.date) + 1;
      let amount = null;
      if (idx >= 1) {
        const within14 = idx <= 14;
        reasons.push(`当月${idx}日目の緊急訪問（${within14 ? "14日目まで" : "15日目以降"}の区分）`);
        amount = tier(item, within14 ? "within_14days" : "from_15th_day");
      }
      let missing = false;
      const reg = office ? office.system_24h_registered : null;
      if (reg === true) reasons.push("24時間対応体制の届出あり");
      else if (reg === false) confirms.push("24時間対応体制の届出がないため算定できない可能性（要確認）");
      else { confirms.push("24時間対応体制の届出状況が未確認（事業所設定で入力）"); missing = true; }
      if (amount == null) confirms.push("金額がマスタ未設定");
      push("MED_ADD_EMERGENCY_VISIT", "緊急訪問看護加算", { status: Engine.addStatus(item, amount, missing), amount, reasons, confirms });
    }

    /* 2. 長時間訪問看護加算（90分超・週回数制限） */
    if (visit.duration_minutes != null && visit.duration_minutes > 90) {
      const item = find("MED_ADD_LONG_VISIT");
      const reasons = [`所要時間${visit.duration_minutes}分（90分超）`], confirms = [];
      const special = hyou7 === true || inSpecial;
      reasons.push(special ? "別表7該当または特別指示期間中（週3日まで対象の可能性）" : "対象者区分は標準（原則週1日）と推定");
      confirms.push("対象者区分（週1日／週3日）と当週の算定回数上限は一次資料で確認");
      const amount = item ? item.amount : null;
      if (amount == null) confirms.push("金額がマスタ未設定");
      push("MED_ADD_LONG_VISIT", "長時間訪問看護加算", { status: Engine.addStatus(item, amount, false), amount, reasons, confirms });
    }

    /* 3. 乳幼児加算（6歳未満） */
    const age = calcAge(patient.birth_date, visit.date);
    if (age === null) {
      // 生年月日未入力：6歳未満かもしれないため要確認（保険種別側でも警告済み）
    } else if (age < 6) {
      const item = find("MED_ADD_INFANT");
      const reasons = [`訪問日時点${age}歳（6歳未満）`], confirms = [];
      confirms.push("対象者区分（標準／別表7・特別管理等による上位区分）は一次資料で確認");
      const amount = tier(item, "standard");
      if (amount == null) confirms.push("金額がマスタ未設定");
      push("MED_ADD_INFANT", "乳幼児加算", { status: Engine.addStatus(item, amount, false), amount, reasons, confirms });
    }

    /* 4. 難病等複数回訪問加算（別表7該当 or 特別指示期間中 かつ 当日2回以上） */
    const todays = (ctx.byDate[visit.date] || []).length;
    if ((hyou7 === true || inSpecial) && todays >= 2) {
      const item = find("MED_ADD_MULTI_VISIT_INTRACTABLE");
      const reasons = [], confirms = [];
      reasons.push(hyou7 === true ? "別表7該当" : "特別訪問看護指示書の交付期間中");
      reasons.push(`当日の訪問回数 ${todays}回`);
      const three = todays >= 3;
      const key = (three ? "visits3plus_" : "visits2_") + (sameBuilding ? "same" : "other");
      reasons.push(`区分: ${three ? "3回以上" : "2回"} × ${sameBuilding ? "同一建物" : "同一建物以外"}`);
      let missing = false;
      if (visit.same_building == null) { confirms.push("同一建物居住者か否かが未入力（区分判定に必要）"); missing = true; }
      const amount = tier(item, key);
      if (amount == null) confirms.push("金額がマスタ未設定");
      push("MED_ADD_MULTI_VISIT_INTRACTABLE", "難病等複数回訪問加算", { status: Engine.addStatus(item, amount, missing), amount, reasons, confirms });
    } else if ((hyou7 === true || inSpecial) && todays < 2) {
      // 対象者ではあるが当日1回：非該当のため表示しない
    }

    /* 5. 複数名訪問看護加算（同行者あり） */
    if (visit.accompanied === true) {
      const item = find("MED_ADD_MULTI_STAFF");
      const reasons = [], confirms = [];
      const pr = visit.partner_role;
      reasons.push(`同行者: ${PARTNER_ROLES[pr] || "未入力"}`);
      let missing = false;
      if (!pr) { confirms.push("同行者の職種が未入力（イ／ロ／ハ／ニの区分に必要）"); missing = true; }
      else confirms.push("同行職種と区分（イ／ロ／ハ／ニ）の対応・当日/週の算定回数は一次資料で確認");
      confirms.push("金額がマスタ未設定");
      push("MED_ADD_MULTI_STAFF", "複数名訪問看護加算", { status: Engine.addStatus(item, null, missing), amount: null, reasons, confirms });
    }

    /* 6. 夜間・早朝／深夜訪問看護加算（時間帯区分は master の定義に依存） */
    if (!isBlank(visit.start_time)) {
      const tb = Engine.getTimeBand(visit, master);
      if (tb.band === "deep_night") {
        const item = find("MED_ADD_DEEP_NIGHT");
        const amount = item ? item.amount : null;
        const confirms = amount == null ? ["金額がマスタ未設定"] : [];
        push("MED_ADD_DEEP_NIGHT", "深夜訪問看護加算", { status: Engine.addStatus(item, amount, false), amount, reasons: [`開始時刻 ${visit.start_time}（深夜帯）`], confirms });
      } else if (tb.band === "early_morning" || tb.band === "night") {
        const item = find("MED_ADD_NIGHT_EARLY");
        const amount = item ? item.amount : null;
        const confirms = amount == null ? ["金額がマスタ未設定"] : [];
        push("MED_ADD_NIGHT_EARLY", "夜間・早朝訪問看護加算", { status: Engine.addStatus(item, amount, false), amount, reasons: [`開始時刻 ${visit.start_time}（夜間・早朝帯）`], confirms });
      } else if (tb.band === null) {
        // 時間帯区分の定義がマスタ未設定 → 判定不能
        push("MED_ADD_NIGHT_EARLY", "夜間・早朝／深夜訪問看護加算", { status: "needs_check", amount: null, reasons: [`開始時刻 ${visit.start_time}`], confirms: [tb.confirm || "時間帯区分の境界時刻がマスタ未設定（要確認）"] });
      }
    }

    /* 7. 特別地域訪問看護加算（事業所が特別地域指定 かつ 移動1時間以上） */
    if (office && office.special_area === true) {
      const item = find("MED_ADD_SPECIAL_AREA");
      const confirms = ["事業所からの移動時間が1時間以上であることの記録を確認", "算定率（所定額の50%）と金額をマスタで確認"];
      push("MED_ADD_SPECIAL_AREA", "特別地域訪問看護加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: ["事業所が特別地域の指定に該当"], confirms });
    }

    return rows;
  },

  /** 月次で算定する医療加算（B群）と独立療養費（C群）を、利用者・月単位で評価する。 */
  medMonthlyAdditions(patient, office, master, ctx, month) {
    const rows = [];
    const items = master.items || [];
    const find = (code) => items.find(i => i.code === code) || null;
    const tier = (item, key) => (item && item.amount_tiers) ? item.amount_tiers[key] : null;
    const push = (code, name, res) => rows.push(Engine.addRow(master, code, name, res));
    const hyou7 = patient.designated_disease_hyou7;
    // 当月の訪問で「実施した記録」に含まれる活動キーの集合
    const recorded = {};
    ctx.visits.forEach(v => (v.recorded_activities || []).forEach(k => { recorded[k] = (recorded[k] || 0) + 1; }));
    const has = (k) => !!recorded[k];

    /* 8. 24時間対応体制加算 */
    {
      const reg = office ? office.system_24h_registered : null;
      const consent = patient.consent_24h;
      if (reg === true || consent === true) {
        const item = find("MED_ADD_24H_SYSTEM");
        const reasons = [], confirms = [];
        let missing = false;
        if (reg === true) reasons.push("事業所が24時間対応体制を届出済み");
        else { confirms.push("24時間対応体制の届出状況が未確認（事業所設定）"); missing = true; }
        if (consent === true) reasons.push("利用者の同意あり");
        else if (consent === false) confirms.push("利用者の同意がないため算定不可（要確認）");
        else { confirms.push("利用者の同意有無が未確認"); missing = true; }
        confirms.push("業務負担軽減の取組の有無で金額区分（区分は一次資料で確認）／金額がマスタ未設定");
        push("MED_ADD_24H_SYSTEM", "24時間対応体制加算", { status: Engine.addStatus(item, null, missing), amount: null, reasons, confirms });
      }
    }

    /* 9. 特別管理加算（別表8。重症度の高いものは上位区分） */
    if (patient.beppyou8_applicable === true) {
      const item = find("MED_ADD_SPECIAL_MGMT");
      const severe = patient.beppyou8_severe;
      const reasons = ["別表8に該当（指示書の記載に基づく）"], confirms = [];
      let key, missing = false;
      if (severe === true) { key = "severe"; reasons.push("うち重症度等の高いものに該当 → 上位区分（5,000円相当）"); }
      else if (severe === false) { key = "standard"; reasons.push("重症度等の高いものには非該当 → 標準区分（2,500円相当）"); }
      else { key = "standard"; confirms.push("「重症度等の高いもの」該当有無が未確認（標準/上位の区分に必要）"); missing = true; }
      if (patient.beppyou8_items) reasons.push(`該当項目（記載）: ${patient.beppyou8_items}`);
      const amount = tier(item, key);
      if (amount == null) confirms.push("金額がマスタ未設定");
      push("MED_ADD_SPECIAL_MGMT", "特別管理加算", { status: Engine.addStatus(item, amount, missing), amount, reasons, confirms });
    } else if (patient.beppyou8_applicable == null) {
      const item = find("MED_ADD_SPECIAL_MGMT");
      push("MED_ADD_SPECIAL_MGMT", "特別管理加算", { status: "needs_check", amount: null, reasons: [], confirms: ["別表8該当有無が未確認（利用者マスタで指示書の記載を入力）"] });
    }

    /* 10. 退院時共同指導加算（＋特別管理指導加算） */
    if (patient.discharge_joint_guidance === true) {
      const item = find("MED_ADD_DISCHARGE_JOINT");
      const reasons = ["退院時共同指導を実施"], confirms = [];
      reasons.push(hyou7 === true ? "別表7該当のため月2回まで算定可（要確認）" : "原則月1回");
      if (patient.beppyou8_applicable === true) reasons.push("別表8該当 → 特別管理指導加算を別途算定可（金額別途・要確認）");
      confirms.push("金額がマスタ未設定");
      push("MED_ADD_DISCHARGE_JOINT", "退院時共同指導加算", { status: Engine.addStatus(item, null, false), amount: null, reasons, confirms });
    }

    /* 11. 退院支援指導加算 */
    if (!isBlank(patient.discharge_date) && has("discharge_support")) {
      const item = find("MED_ADD_DISCHARGE_SUPPORT");
      const confirms = ["長時間の指導かどうかで金額区分（標準／長時間）を一次資料で確認", "金額がマスタ未設定"];
      push("MED_ADD_DISCHARGE_SUPPORT", "退院支援指導加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: [`退院日 ${patient.discharge_date}・退院支援指導の実施記録あり`], confirms });
    }

    /* 12. 在宅患者連携指導加算（月1回） */
    if (has("home_liaison")) {
      const item = find("MED_ADD_HOME_LIAISON");
      push("MED_ADD_HOME_LIAISON", "在宅患者連携指導加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: ["歯科・薬局等との情報共有の記録あり（月1回）"], confirms: ["金額がマスタ未設定"] });
    }

    /* 13. 在宅患者緊急時等カンファレンス加算（月2回まで） */
    if (has("emergency_conf")) {
      const item = find("MED_ADD_EMERGENCY_CONF");
      const n = recorded["emergency_conf"];
      const confirms = ["金額がマスタ未設定"];
      if (n > 2) confirms.push(`当月の実施 ${n}回。月2回までの上限を超えています（要確認）`);
      push("MED_ADD_EMERGENCY_CONF", "在宅患者緊急時等カンファレンス加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: [`共同カンファレンスの実施記録 ${n}回`], confirms });
    }

    /* 14. 専門管理加算（月1回） */
    if (has("specialist_mgmt")) {
      const item = find("MED_ADD_SPECIALIST_MGMT");
      push("MED_ADD_SPECIALIST_MGMT", "専門管理加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: ["研修修了看護師による専門管理の記録あり"], confirms: ["担当看護師の研修修了・対象者の状態要件を一次資料で確認", "金額がマスタ未設定"] });
    }

    /* 15. 看護・介護職員連携強化加算（月1回） */
    if (has("care_staff_liaison")) {
      const item = find("MED_ADD_CARE_STAFF_LIAISON");
      push("MED_ADD_CARE_STAFF_LIAISON", "看護・介護職員連携強化加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: ["喀痰吸引等事業者との連携支援の記録あり"], confirms: ["金額がマスタ未設定"] });
    }

    /* 16. 訪問看護医療DX情報活用加算（月1回） */
    {
      const reg = office ? office.dx_info_registered : null;
      if (reg === true) {
        const item = find("MED_ADD_DX_INFO");
        push("MED_ADD_DX_INFO", "訪問看護医療DX情報活用加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: ["事業所がオンライン請求・オンライン資格確認体制を届出済み"], confirms: ["金額がマスタ未設定"] });
      } else if (reg == null && ctx.visits.length > 0) {
        const item = find("MED_ADD_DX_INFO");
        push("MED_ADD_DX_INFO", "訪問看護医療DX情報活用加算", { status: "needs_check", amount: null, reasons: [], confirms: ["医療DX情報活用の届出状況が未確認（事業所設定）"] });
      }
    }

    /* 17. 訪問看護情報提供療養費Ⅰ／Ⅱ／Ⅲ（提供先区分） */
    [["info_provide_1", "i", "Ⅰ（市町村等）"], ["info_provide_2", "ii", "Ⅱ（学校等）"], ["info_provide_3", "iii", "Ⅲ（転院・入院先医療機関）"]].forEach(([k, key, label]) => {
      if (has(k)) {
        const item = find("MED_RYO_INFO_PROVIDE");
        const amount = tier(item, key);
        const confirms = amount == null ? ["金額がマスタ未設定"] : [];
        push("MED_RYO_INFO_PROVIDE", `訪問看護情報提供療養費${label}`, { status: Engine.addStatus(item, amount, false), amount, reasons: ["情報提供の実施記録あり"], confirms });
      }
    });

    /* 18. 訪問看護ターミナルケア療養費（死亡日前14日以内に2回以上の訪問） */
    if (!isBlank(patient.death_date)) {
      const item = find("MED_RYO_TERMINAL");
      const from = addDaysISO(patient.death_date, -14);
      const n = ctx.allVisits.filter(v => v.date >= from && v.date <= patient.death_date).length;
      const reasons = [`死亡日 ${patient.death_date}／前14日以内の訪問 ${n}回`], confirms = [];
      let missing = false;
      if (n >= 2) reasons.push("死亡日前14日以内に2回以上の訪問（要件充足の見込み）");
      else { confirms.push("死亡日前14日以内の訪問が2回未満のため要件を満たさない可能性（要確認）"); }
      if (patient.terminal_consent === true) reasons.push("説明・同意の記録あり");
      else if (patient.terminal_consent === false) confirms.push("説明・同意の記録がないため算定不可（要確認）");
      else { confirms.push("説明・同意の記録有無が未確認"); missing = true; }
      confirms.push("療養費Ⅰ／Ⅱの区分（事業所区分等）と金額を一次資料で確認");
      push("MED_RYO_TERMINAL", "訪問看護ターミナルケア療養費", { status: n >= 2 ? Engine.addStatus(item, null, missing) : "needs_check", amount: null, reasons, confirms });
    }

    /* 19. 遠隔死亡診断補助加算 */
    if (has("remote_death")) {
      const item = find("MED_ADD_REMOTE_DEATH");
      const confirms = ["特定行為研修修了看護師による実施であることを確認", "金額がマスタ未設定"];
      if (!(office && office.special_area === true)) confirms.push("特別地域該当の要件を確認");
      push("MED_ADD_REMOTE_DEATH", "遠隔死亡診断補助加算", { status: Engine.addStatus(item, null, false), amount: null, reasons: ["遠隔死亡診断の補助の実施記録あり"], confirms });
    }

    return rows;
  }
};

/* ============================ 永続化（ローカルのみ） ============================ */

const STORE_KEYS = { office: "hkt_office", patients: "hkt_patients", visits: "hkt_visits", master: "hkt_master_override" };

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

const state = {
  office: loadJSON(STORE_KEYS.office, {
    urgent_visit_registered: null,
    ptotst_visit_ratio: null,
    system_24h_registered: null,   // 24時間対応体制加算（医療）の届出
    dx_info_registered: null,      // 訪問看護医療DX情報活用加算の届出
    special_area: null,            // 特別地域の指定に該当
    notes: ""
  }),
  patients: loadJSON(STORE_KEYS.patients, []),
  visits: loadJSON(STORE_KEYS.visits, []),
  masterOverride: loadJSON(STORE_KEYS.master, null)
};

function activeMaster() { return state.masterOverride || window.DEFAULT_FEE_MASTER; }
function persist() {
  saveJSON(STORE_KEYS.office, state.office);
  saveJSON(STORE_KEYS.patients, state.patients);
  saveJSON(STORE_KEYS.visits, state.visits);
  if (state.masterOverride) saveJSON(STORE_KEYS.master, state.masterOverride);
  else localStorage.removeItem(STORE_KEYS.master);
}

/* ============================ UI ============================ */

const $ = (sel) => document.querySelector(sel);

const TABS = [
  { id: "quick",    label: "かんたん判定" },
  { id: "judge",    label: "判定・計算" },
  { id: "patients", label: "利用者" },
  { id: "visits",   label: "訪問記録" },
  { id: "office",   label: "事業所設定" },
  { id: "master",   label: "報酬マスタ" },
  { id: "tests",    label: "テスト" }
];

let currentTab = "quick";
let selectedVisitId = null;

function switchTab(id) {
  currentTab = id;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  render();
}

function render() {
  const el = $("#content");
  if (currentTab === "quick") el.innerHTML = renderQuick();
  else if (currentTab === "judge") el.innerHTML = renderJudge();
  else if (currentTab === "patients") el.innerHTML = renderPatients();
  else if (currentTab === "visits") el.innerHTML = renderVisits();
  else if (currentTab === "office") el.innerHTML = renderOffice();
  else if (currentTab === "master") el.innerHTML = renderMaster();
  else if (currentTab === "tests") el.innerHTML = renderTests();
}

/* ---------- 共通部品 ---------- */

function triSelect(name, value) {
  const opts = [
    ["null", "未確認", value !== true && value !== false],
    ["true", "該当", value === true],
    ["false", "非該当", value === false]
  ];
  return `<select name="${name}">` +
    opts.map(([v, l, sel]) => `<option value="${v}" ${sel ? "selected" : ""}>${l}</option>`).join("") +
    `</select>`;
}
function triFromForm(v) { return v === "true" ? true : v === "false" ? false : null; }

function insuranceChip(ins) {
  const cls = ins === "medical" ? "chip-medical" : ins === "kaigo" ? "chip-kaigo" : "chip-confirm";
  return `<span class="chip ${cls}">${INSURANCE_LABEL[ins] || "要確認"}</span>`;
}

/** マスタ検証状態（3値）のチップ */
function verChip(state) {
  const cls = state === "official_confirmed" ? "chip-ok" : state === "needs_recheck" ? "chip-recheck" : "chip-confirm";
  return `<span class="chip ${cls}">${VERIFICATION_LABELS[state] || "未検証"}</span>`;
}

function confirmBadge(text) { return `<span class="chip chip-confirm">要確認</span> ${esc(text)}`; }

/* ---------- かんたん判定タブ ----------
 * 登録なし・1画面で保険種別だけを即座に出す。判定は Engine.judgeInsurance を
 * そのまま呼ぶため、「判定・計算」タブと結論は必ず一致する。
 * 質問は回答に応じて必要なものだけを出す（例: 特定疾病は40〜64歳のときだけ）。 */

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const quickState = {
  date: todayISO(),
  ageMode: "age",     // "age" = 年齢を直接入力 / "birth" = 生年月日から算出
  age: "",
  birth_date: "",
  special: null,      // 特別訪問看護指示書の交付期間中か
  hyou7: null,        // 別表7該当
  tokutei: null,      // 介護保険の特定疾病（16疾病）該当
  psych: null,        // 精神科訪問看護（認知症を除く）の対象
  care_level: ""      // 要介護認定の状況
};

const QUICK_Q = {
  special: {
    text: "訪問日は、特別訪問看護指示書の交付期間中ですか？",
    help: "交付期間中は、他の条件によらず医療保険が優先されます。",
    labels: { true: "期間中", false: "期間中でない" }
  },
  hyou7: {
    text: "別表7（厚生労働大臣が定める疾病等）に該当しますか？",
    help: "該当する疾病等は告示の別表第七でご確認ください（本ツールは疾病名の一覧を持ちません）。",
    labels: { true: "該当する", false: "該当しない" }
  },
  tokutei: {
    text: "介護保険の特定疾病（16疾病）に該当しますか？",
    help: "40〜64歳（第2号被保険者）の判定にのみ使用します。",
    labels: { true: "該当する", false: "該当しない" }
  },
  psych: {
    text: "精神科訪問看護（認知症を除く）の対象ですか？",
    help: "対象の場合は医療保険が優先されます。",
    labels: { true: "対象である", false: "対象でない" }
  }
};

/** 訪問日時点の満年齢。判定不能は null */
function quickAge() {
  if (quickState.ageMode === "birth") return calcAge(quickState.birth_date, quickState.date);
  const n = Number(quickState.age);
  if (quickState.age === "" || isNaN(n) || n < 0 || n > 130) return null;
  return Math.floor(n);
}

/** 現在の回答状況で「まだ聞く必要がある質問」だけを返す */
function quickApplicable() {
  const q = quickState;
  const age = quickAge();
  if (age === null) return [];
  if (age < 40) return [];              // 40歳未満は他の条件によらず医療保険
  const list = ["special"];
  if (q.special === true) return list;  // 特別指示期間中 → 確定
  list.push("hyou7");
  if (q.hyou7 === true) return list;    // 別表7該当 → 確定
  if (age < 65) {
    list.push("tokutei");
    if (q.tokutei !== true) return list;
  } else {
    list.push("psych");
    if (q.psych === true) return list;  // 精神科訪問看護 → 確定
  }
  list.push("care");
  return list;
}

/** かんたん判定の回答から、判定エンジンに渡す利用者オブジェクトを作る */
function quickPatient() {
  const q = quickState;
  const age = quickAge();
  const useBirth = q.ageMode === "birth";
  return {
    patient_id: "（かんたん判定）",
    birth_date: useBirth ? (q.birth_date || null) : null,
    age_at_visit: useBirth ? null : age,
    care_level: q.care_level || null,
    designated_disease_hyou7: q.hyou7,
    designated_disease_16_of_40to64: q.tokutei,
    psychiatric_non_dementia: q.psych,
    instruction_sheet: {
      issued_date: null,
      valid_until: null,
      // 「期間中」と回答された場合のみ、訪問日を含む期間として渡す
      special_instruction_period: q.special === true ? { start: q.date, end: q.date } : null
    }
  };
}

function segButtons(key, value, labels) {
  const opts = [
    ["true", labels.true, value === true],
    ["false", labels.false, value === false],
    ["null", "わからない", value !== true && value !== false]
  ];
  return `<div class="seg" role="group">` + opts.map(([v, l, on]) =>
    `<button type="button" class="seg-btn ${on ? "on" : ""} ${v === "null" ? "seg-unknown" : ""}" data-q="${key}" data-v="${v}">${esc(l)}</button>`
  ).join("") + `</div>`;
}

function quickCareButtons() {
  const opts = CARE_LEVELS_ALL.map(c =>
    `<button type="button" class="seg-btn ${quickState.care_level === c ? "on" : ""} ${c === "不明" || c === "申請中" ? "seg-unknown" : ""}" data-q="care" data-v="${esc(c)}">${esc(c)}</button>`
  ).join("");
  return `<div class="seg seg-wrap" role="group">${opts}</div>`;
}

function quickCard(key, n) {
  if (key === "care") {
    return `<div class="q-card ${quickState.care_level ? "answered" : ""}">
      <div class="q-text"><span class="q-no">${n}</span>要介護（要支援）認定の状況は？</div>
      <div class="q-help">認定を受けていない・申請中・不明の場合は、自動判定せず「要確認」になります。</div>
      ${quickCareButtons()}
    </div>`;
  }
  const def = QUICK_Q[key];
  const val = quickState[key];
  return `<div class="q-card ${val === true || val === false ? "answered" : ""}">
    <div class="q-text"><span class="q-no">${n}</span>${esc(def.text)}</div>
    <div class="q-help">${esc(def.help)}</div>
    ${segButtons(key, val, def.labels)}
  </div>`;
}

function renderQuick() {
  const q = quickState;
  const age = quickAge();

  /* --- 年齢の入力欄 --- */
  const ageInput = q.ageMode === "birth"
    ? `<input type="date" id="q-birth" value="${esc(q.birth_date)}" max="${esc(q.date)}">`
    : `<input type="number" id="q-age" inputmode="numeric" min="0" max="130" placeholder="例: 78"
         value="${esc(q.age)}" autocomplete="off"> <span class="unit">歳</span>`;

  const head = `
    <div class="q-basics">
      <label class="q-field">訪問日
        <input type="date" id="q-date" value="${esc(q.date)}">
      </label>
      <div class="q-field">
        <span class="q-field-head">訪問日時点の年齢
          <button type="button" class="linkish" id="q-agemode">${q.ageMode === "birth" ? "年齢で入力" : "生年月日で入力"}</button>
        </span>
        <span class="q-age-row">${ageInput}${age !== null && q.ageMode === "birth" ? `<span class="unit">→ ${age}歳</span>` : ""}</span>
      </div>
    </div>`;

  return `
  <section class="panel quick">
    <div class="panel-head"><h2>かんたん判定</h2><span class="q-sub">医療保険／介護保険を、登録なしでその場で判定します</span></div>
    ${head}
    <div id="q-body">${renderQuickBody()}</div>
  </section>`;
}

/* 年齢入力欄より下だけを描き直せるように分離する。
   こうすると年齢を1文字入力するたびに入力欄自体が作り直されず、
   フォーカスとカーソル位置がそのまま保たれる。 */
function renderQuickBody() {
  const q = quickState;
  const age = quickAge();
  const applicable = quickApplicable();
  const unanswered = applicable.filter(k => k === "care" ? !q.care_level : (q[k] !== true && q[k] !== false));

  if (age === null) {
    return `<p class="empty">まず年齢（または生年月日）を入力してください。以降の質問は、入力内容に応じて必要なものだけが表示されます。</p>`;
  }

  /* --- 判定を実行（既存エンジンをそのまま使用） --- */
  const j = Engine.judgeInsurance(quickPatient(), q.date);
  const extra = (applicable.includes("special") && q.special === null)
    ? ["特別訪問看護指示書の交付期間中かどうかが未回答です（期間中なら医療保険が優先されます）"]
    : [];
  const confirms = j.confirm.concat(extra);

  const resultCls = j.insurance === "medical" ? "res-medical" : j.insurance === "kaigo" ? "res-kaigo" : "res-unknown";
  const resultText = j.insurance === "unknown" ? "要確認" : INSURANCE_LABEL[j.insurance];

  const result = `
    <div class="q-result ${resultCls}">
      <div class="q-result-label">判定結果</div>
      <div class="q-result-main">${esc(resultText)}</div>
      ${j.reasons.length ? `<p class="q-result-why">${j.reasons.map(esc).join("／")}</p>` : ""}
      ${unanswered.length
        ? `<p class="q-remain">未回答の質問があと ${unanswered.length} 問あります</p>`
        : (j.insurance === "unknown"
            ? `<p class="q-remain">回答内容だけでは自動判定できません（下記の要確認事項をご確認ください）</p>`
            : "")}
    </div>
    ${confirms.length ? `
      <div class="q-confirms">
        <h3 class="q-confirms-head">要確認事項</h3>
        <ul class="confirm-list">${confirms.map(c => `<li>${confirmBadge(c)}</li>`).join("")}</ul>
      </div>` : ""}
    <details class="q-trace">
      <summary>判定の根拠（トレース）を見る</summary>
      <ol class="trace">${j.trace.map(t => `
        <li class="trace-step">
          <span class="trace-name">${esc(t.step)}</span>
          <span class="trace-result">${esc(t.result)}</span>
          ${t.note ? `<span class="trace-note">${esc(t.note)}</span>` : ""}
        </li>`).join("")}</ol>
    </details>`;

  const questions = applicable.length === 0
    ? `<p class="q-done">この条件では、追加の質問なしで判定が確定します。</p>`
    : applicable.map((k, i) => quickCard(k, i + 1)).join("");

  const canSave = q.ageMode === "birth" && q.birth_date;

  return `
    ${result}
    <div class="q-questions">${questions}</div>
    <div class="q-actions">
      <button type="button" class="btn" id="q-reset">回答をリセット</button>
      ${canSave
        ? `<button type="button" class="btn btn-primary" id="q-save">この内容で利用者を登録</button>`
        : `<span class="hint">生年月日で入力すると、この内容を利用者として登録できます。</span>`}
    </div>
    <p class="hint">この画面は保険種別のみを判定します（入力内容は保存されません）。基本報酬・加算の金額まで見るには「判定・計算」タブをご利用ください。</p>`;
}

/* ---------- 判定・計算タブ ---------- */

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
let judgeMonth = currentMonth();
let judgePatient = "";

function renderJudge() {
  const master = activeMaster();
  const monthVisits = state.visits.filter(v => v.date && v.date.startsWith(judgeMonth));
  const visits = monthVisits
    .filter(v => !judgePatient || v.patient_id === judgePatient)
    .sort((a, b) => (a.date + (a.start_time || "")).localeCompare(b.date + (b.start_time || "")));

  const patientOpts = ['<option value="">全利用者</option>']
    .concat(state.patients.map(p => `<option value="${esc(p.patient_id)}" ${p.patient_id === judgePatient ? "selected" : ""}>${esc(p.patient_id)}</option>`))
    .join("");

  // 利用者ごとの月コンテキストを一度だけ構築（訪問ごと加算の月次・週次集計に使用）
  const ctxCache = {};
  const monthCtxFor = (pid) => (ctxCache[pid] || (ctxCache[pid] = Engine.buildMonthContext(pid, monthVisits, state.visits)));

  let rows = "";
  let detail = "";
  for (const v of visits) {
    const p = state.patients.find(x => x.patient_id === v.patient_id);
    const r = Engine.judgeVisit(v, p, state.office, master, p ? monthCtxFor(v.patient_id) : null);
    const nAdd = (r.additions || []).length;
    const nConfirm = r.confirm.length + r.sheetWarnings.length;
    const totalCell = r.insurance === "unknown"
      ? "—"
      : (r.total.complete
          ? `${r.total.confirmed}${r.total.unit ? " " + esc(r.total.unit) : ""}`
          : `<span class="muted">確定分 ${r.total.confirmed}${r.total.unit ? " " + esc(r.total.unit) : ""}（未確定あり）</span>`);
    rows += `<tr class="visit-row ${v.visit_id === selectedVisitId ? "selected" : ""}" data-visit="${esc(v.visit_id)}">
      <td>${esc(v.date)}</td>
      <td>${esc(v.patient_id)}</td>
      <td>${esc(ROLES[v.role] || v.role || "")}</td>
      <td class="num">${esc(v.duration_minutes ?? "")}分</td>
      <td>${insuranceChip(r.insurance)}</td>
      <td class="num">${r.items.applied.length}/${r.items.unconfirmed.length + r.items.needsCheck.length}</td>
      <td class="num">${nAdd ? `<span class="chip chip-add">加算 ${nAdd}</span>` : '<span class="muted">—</span>'}</td>
      <td>${nConfirm ? `<span class="chip chip-confirm">要確認 ${nConfirm}</span>` : '<span class="chip chip-ok">なし</span>'}</td>
      <td class="num">${totalCell}</td>
    </tr>`;
    if (v.visit_id === selectedVisitId) detail = renderVisitDetail(r);
  }

  return `
  <section class="panel">
    <div class="panel-head">
      <h2>月次判定一覧</h2>
      <div class="toolbar">
        <label>対象月 <input type="month" id="judge-month" value="${esc(judgeMonth)}"></label>
        <label>利用者 <select id="judge-patient">${patientOpts}</select></label>
        <button class="btn" id="btn-csv">CSVエクスポート</button>
      </div>
    </div>
    ${visits.length === 0
      ? `<p class="empty">この条件の訪問記録がありません。「訪問記録」タブから登録してください。</p>`
      : `<div class="table-scroll"><table class="data">
          <thead><tr><th>訪問日</th><th>利用者ID</th><th>職種</th><th>時間</th><th>保険種別</th><th>適用/未確定</th><th>加算</th><th>要確認</th><th>確定合計</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="hint">行をタップすると判定の詳細（根拠トレース・加算）を表示します。「適用/未確定」は 確定した項目数/要確認の項目数、「加算」は訪問ごとの医療加算の候補件数です。</p>`}
    ${detail}
    ${renderMonthlyAdditions(monthVisits, master)}
  </section>`;
}

/* 月次で算定する医療加算（B群）・独立療養費（C群）を利用者ごとに表示する。 */
function renderMonthlyAdditions(monthVisits, master) {
  // 当月に医療保険の訪問がある利用者を対象にする
  const pids = [...new Set(monthVisits.map(v => v.patient_id))]
    .filter(pid => !judgePatient || pid === judgePatient);
  let blocks = "";
  for (const pid of pids) {
    const p = state.patients.find(x => x.patient_id === pid);
    if (!p) continue;
    // その利用者の当月訪問が医療保険になるものが1件でもあるか
    const anyMedical = monthVisits.some(v => v.patient_id === pid &&
      Engine.judgeInsurance(p, v.date).insurance === "medical");
    if (!anyMedical) continue;
    const ctx = Engine.buildMonthContext(pid, monthVisits, state.visits);
    const rows = Engine.medMonthlyAdditions(p, state.office, master, ctx, judgeMonth);
    if (rows.length === 0) continue;
    blocks += `
      <div class="month-add-block">
        <h4>${esc(pid)}</h4>
        ${rows.map(row => feeItemHTML(row, statusClass(row.status))).join("")}
      </div>`;
  }
  if (!blocks) return "";
  return `
    <div class="detail">
      <h3>月次の医療加算・療養費（${esc(judgeMonth)}・利用者ごと）</h3>
      <p class="hint">月単位で算定する加算（24時間対応体制・特別管理・退院時共同指導 等）と独立した療養費（ターミナルケア・情報提供 等）の候補です。実施記録の有無は「訪問記録」タブの各訪問で入力します。金額はマスタ未設定のため参考表示です。</p>
      ${blocks}
    </div>`;
}

/** 加算の状態→CSSクラス */
function statusClass(status) {
  return status === "matched" ? "st-applied"
    : status === "needs_check" ? "st-check"
    : status === "excluded" ? "st-excluded"
    : "st-unconfirmed";
}

/** 加算・報酬項目1件のHTML（判定詳細と月次加算で共用） */
function feeItemHTML(row, cls) {
  return `
    <div class="fee-item ${cls}">
      <div class="fee-head">
        <strong>${esc(row.item.name_ja)}</strong>
        <span class="code">${esc(row.item.code)}</span>
        ${row.amount != null ? `<span class="num">${esc(row.amount)}${esc(row.item.unit || "")}</span>` : `<span class="chip chip-confirm">金額未設定</span>`}
      </div>
      <ul class="reason-list">
        ${row.reasons.map(x => `<li class="reason">${esc(x)}</li>`).join("")}
        ${row.confirms.map(x => `<li class="need-confirm">${confirmBadge(x)}</li>`).join("")}
      </ul>
      ${row.item.source_reference ? `<p class="source">根拠: ${esc(row.item.source_reference)}</p>` : `<p class="source need-confirm-text">根拠告示・通知番号: 未設定（要確認）</p>`}
    </div>`;
}

function renderVisitDetail(r) {
  const j = r.judgment;
  const traceRows = (j ? j.trace : []).map(t => `
    <li class="trace-step">
      <span class="trace-name">${esc(t.step)}</span>
      <span class="trace-result">${esc(t.result)}</span>
      ${t.note ? `<span class="trace-note">${esc(t.note)}</span>` : ""}
    </li>`).join("");

  const itemGroup = (title, rows, cls) => rows.length === 0 ? "" : `
    <h4 class="${cls}">${title}（${rows.length}件）</h4>
    ${rows.map(row => feeItemHTML(row, cls)).join("")}`;

  // 訪問ごとの医療加算（A群）を状態別にまとめる
  const add = r.additions || [];
  const addApplied = add.filter(x => x.status === "matched");
  const addUnconf = add.filter(x => x.status === "matched_unconfirmed");
  const addCheck = add.filter(x => x.status === "needs_check");
  const additionsSection = add.length === 0 ? "" : `
    <h4 class="add-head">訪問ごとの医療加算（候補 ${add.length}件）</h4>
    ${itemGroup("適用（確定）", addApplied, "st-applied")}
    ${itemGroup("該当見込み・金額または検証が未確定", addUnconf, "st-unconfirmed")}
    ${itemGroup("判定不能（入力・マスタの不足）", addCheck, "st-check")}`;

  return `
  <div class="detail">
    <h3>判定詳細：${esc(r.visit.visit_id)}（${esc(r.visit.date)} / ${esc(r.visit.patient_id)}）</h3>

    <div class="detail-grid">
      <div>
        <h4>保険種別 ${insuranceChip(r.insurance)}</h4>
        <ol class="trace">${traceRows}</ol>
        ${j && j.reasons.length ? `<p class="judg-reason">結論の根拠: ${j.reasons.map(esc).join("／")}</p>` : ""}
      </div>
      <div>
        <h4>要確認事項</h4>
        ${(r.confirm.length + r.sheetWarnings.length) === 0
          ? `<p class="ok-text">要確認事項はありません。</p>`
          : `<ul class="confirm-list">
              ${r.sheetWarnings.map(w => `<li>${confirmBadge(w)}</li>`).join("")}
              ${r.confirm.map(w => `<li>${confirmBadge(w)}</li>`).join("")}
            </ul>`}
        <p class="muted">時間帯区分: ${esc(r.timeBand ? r.timeBand.label : "—")}</p>
      </div>
    </div>

    ${r.insurance === "unknown" ? "" : `
      ${itemGroup("適用（確定）", r.items.applied, "st-applied")}
      ${itemGroup("該当見込み・金額または検証が未確定", r.items.unconfirmed, "st-unconfirmed")}
      ${itemGroup("判定不能（入力・マスタの不足）", r.items.needsCheck, "st-check")}
      ${itemGroup("非該当", r.items.excluded, "st-excluded")}
      ${additionsSection}
      <p class="total-line">確定合計: <strong>${r.total.confirmed}${r.total.unit ? " " + esc(r.total.unit) : ""}</strong>
        ${r.total.complete ? "" : `<span class="chip chip-confirm">未確定項目あり・参考値</span>`}</p>
    `}
  </div>`;
}

function exportCSV() {
  const master = activeMaster();
  const visits = state.visits
    .filter(v => v.date && v.date.startsWith(judgeMonth))
    .filter(v => !judgePatient || v.patient_id === judgePatient);
  const header = ["訪問ID", "訪問日", "利用者ID", "職種", "所要時間(分)", "保険種別", "項目コード", "項目名", "状態", "金額", "単位", "根拠・要確認事項"];
  const lines = [header];
  for (const v of visits) {
    const p = state.patients.find(x => x.patient_id === v.patient_id);
    const r = Engine.judgeVisit(v, p, state.office, master);
    const base = [v.visit_id, v.date, v.patient_id, ROLES[v.role] || v.role || "", v.duration_minutes ?? "", INSURANCE_LABEL[r.insurance]];
    const all = [
      ...r.items.applied.map(x => [x, "適用"]),
      ...r.items.unconfirmed.map(x => [x, "要確認(未検証/金額未設定)"]),
      ...r.items.needsCheck.map(x => [x, "要確認(判定不能)"])
    ];
    if (all.length === 0) {
      lines.push([...base, "", "", r.insurance === "unknown" ? "保険種別要確認" : "該当なし", "", "", r.confirm.concat(r.sheetWarnings).join(" / ")]);
    } else {
      for (const [row, st] of all) {
        lines.push([...base, row.item.code, row.item.name_ja, st, row.amount ?? "", row.item.unit ?? "",
          row.reasons.concat(row.confirms).join(" / ")]);
      }
    }
  }
  const csv = "﻿" + lines.map(l => l.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `santei_${judgeMonth}${judgePatient ? "_" + judgePatient : ""}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 利用者タブ ---------- */

let editingPatientId = null;

function renderPatients() {
  const p = editingPatientId ? state.patients.find(x => x.patient_id === editingPatientId) : null;
  const rows = state.patients.map(x => `
    <tr>
      <td>${esc(x.patient_id)}</td>
      <td>${esc(x.birth_date || "")}${isBlank(x.birth_date) ? ' <span class="chip chip-confirm">未入力</span>' : ""}</td>
      <td>${esc(x.care_level || "")}${isBlank(x.care_level) || x.care_level === "不明" ? ' <span class="chip chip-confirm">要確認</span>' : ""}</td>
      <td>${Engine.triLabel(x.designated_disease_hyou7)}${x.designated_disease_hyou7 == null ? ' <span class="chip chip-confirm">要確認</span>' : ""}</td>
      <td>${Engine.triLabel(x.designated_disease_16_of_40to64)}</td>
      <td>${esc((x.instruction_sheet && x.instruction_sheet.valid_until) || "")}</td>
      <td>
        <button class="btn btn-sm" data-edit-patient="${esc(x.patient_id)}">編集</button>
        <button class="btn btn-sm btn-danger" data-del-patient="${esc(x.patient_id)}">削除</button>
      </td>
    </tr>`).join("");

  const s = p || {};
  const sheet = s.instruction_sheet || {};
  const sp = sheet.special_instruction_period || {};
  return `
  <section class="panel">
    <div class="panel-head"><h2>利用者マスタ</h2></div>
    <p class="hint">実名は入力せず、匿名ID（例: P0001）で管理してください。ID と実名の対応表は本ツールの外（既存の業務システム等）で管理します。</p>
    ${state.patients.length ? `<div class="table-scroll"><table class="data">
      <thead><tr><th>ID</th><th>生年月日</th><th>要介護度</th><th>別表7</th><th>特定疾病(40-64)</th><th>指示書期限</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : `<p class="empty">利用者が未登録です。</p>`}

    <h3>${p ? `利用者 ${esc(p.patient_id)} を編集` : "新規利用者を登録"}</h3>
    <form id="patient-form" class="form-grid">
      <label>利用者ID（匿名）<input name="patient_id" required value="${esc(s.patient_id || "")}" ${p ? "readonly" : ""} placeholder="P0001"></label>
      <label>生年月日 <input type="date" name="birth_date" value="${esc(s.birth_date || "")}"></label>
      <label>要介護度
        <select name="care_level">
          <option value="">未入力</option>
          ${CARE_LEVELS_ALL.map(c => `<option ${s.care_level === c ? "selected" : ""}>${c}</option>`).join("")}
        </select>
      </label>
      <label>別表7（厚労大臣が定める疾病等）該当 ${triSelect("designated_disease_hyou7", s.designated_disease_hyou7)}</label>
      <label>別表7の記載病名（指示書の記載をそのまま。任意） <input name="hyou7_disease_written" value="${esc(s.hyou7_disease_written || "")}" placeholder="指示書に別表7の疾病等が記載されていれば入力"></label>
      <label>介護保険の特定疾病（16疾病）該当 ※40〜64歳で使用 ${triSelect("designated_disease_16_of_40to64", s.designated_disease_16_of_40to64)}</label>
      <label>精神科訪問看護の対象（認知症を除く） ${triSelect("psychiatric_non_dementia", s.psychiatric_non_dementia)}</label>

      <label class="section-label wide">── 特別管理加算（別表8）※指示書の記載をそのまま入力 ──</label>
      <label>別表8（特別な管理を要する状態等）該当 ${triSelect("beppyou8_applicable", s.beppyou8_applicable)}</label>
      <label>うち重症度等の高いものに該当（上位区分5,000円） ${triSelect("beppyou8_severe", s.beppyou8_severe)}</label>
      <label class="wide">別表8の該当項目（記載どおり・参考） <input name="beppyou8_items" value="${esc(s.beppyou8_items || "")}" placeholder="例: 真皮を越える褥瘡、留置カテーテル 等"></label>

      <label class="section-label wide">── 指示書・特別指示 ──</label>
      <label>指示書 交付日 <input type="date" name="issued_date" value="${esc(sheet.issued_date || "")}"></label>
      <label>指示書 有効期限 <input type="date" name="valid_until" value="${esc(sheet.valid_until || "")}"></label>
      <label>特別指示書 開始日 <input type="date" name="sp_start" value="${esc(sp.start || "")}"></label>
      <label>特別指示書 終了日 <input type="date" name="sp_end" value="${esc(sp.end || "")}"></label>

      <label class="section-label wide">── 24時間対応体制・退院・ターミナル（医療加算用） ──</label>
      <label>24時間対応体制への同意（利用者） ${triSelect("consent_24h", s.consent_24h)}</label>
      <label>退院日 <input type="date" name="discharge_date" value="${esc(s.discharge_date || "")}"></label>
      <label>退院時共同指導を実施 ${triSelect("discharge_joint_guidance", s.discharge_joint_guidance)}</label>
      <label>死亡日（ターミナルケア判定用） <input type="date" name="death_date" value="${esc(s.death_date || "")}"></label>
      <label>ターミナルケアの説明・同意の記録 ${triSelect("terminal_consent", s.terminal_consent)}</label>

      <label class="wide">メモ（病状の詳細・氏名は書かないでください）<input name="notes" value="${esc(s.notes || "")}"></label>
      <div class="wide">
        <button class="btn btn-primary" type="submit">${p ? "更新" : "登録"}</button>
        ${p ? `<button class="btn" type="button" id="cancel-edit">キャンセル</button>` : ""}
      </div>
    </form>
  </section>`;
}

/* ---------- 訪問記録タブ ---------- */

function nextVisitId() {
  const nums = state.visits.map(v => parseInt(String(v.visit_id).replace(/^V/, ""), 10)).filter(n => !isNaN(n));
  return "V" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(5, "0");
}

function renderVisits() {
  const rows = [...state.visits].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map(v => `
    <tr>
      <td>${esc(v.visit_id)}</td><td>${esc(v.date)}</td><td>${esc(v.start_time || "")}</td>
      <td>${esc(v.patient_id)}</td><td>${esc(ROLES[v.role] || v.role || "")}</td>
      <td class="num">${esc(v.duration_minutes ?? "")}</td>
      <td>${v.same_building === true ? "該当" : v.same_building === false ? "非該当" : "未入力"}</td>
      <td>${esc(v.purpose || "")}</td>
      <td><button class="btn btn-sm btn-danger" data-del-visit="${esc(v.visit_id)}">削除</button></td>
    </tr>`).join("");

  const patientOpts = state.patients.map(p => `<option value="${esc(p.patient_id)}">${esc(p.patient_id)}</option>`).join("");
  return `
  <section class="panel">
    <div class="panel-head"><h2>訪問記録</h2></div>
    ${state.visits.length ? `<div class="table-scroll"><table class="data">
      <thead><tr><th>ID</th><th>日付</th><th>開始</th><th>利用者</th><th>職種</th><th>分</th><th>同一建物</th><th>内容</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : `<p class="empty">訪問記録がありません。</p>`}

    <h3>訪問を記録</h3>
    ${state.patients.length === 0 ? `<p class="hint">先に「利用者」タブで利用者を登録してください。</p>` : `
    <form id="visit-form" class="form-grid">
      <label>利用者ID <select name="patient_id" required>${patientOpts}</select></label>
      <label>訪問日 <input type="date" name="date" required></label>
      <label>開始時刻（時間帯判定に使用） <input type="time" name="start_time"></label>
      <label>所要時間（分） <input type="number" name="duration_minutes" min="1" required></label>
      <label>訪問職種
        <select name="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      </label>
      <label>同一建物居住者
        <select name="same_building"><option value="null">未確認</option><option value="false" selected>非該当</option><option value="true">該当</option></select>
      </label>
      <label>同一建物での訪問人数（複数名・難病等複数回の区分用・任意） <input type="number" name="same_building_count" min="1" placeholder="同一建物該当時のみ"></label>

      <label class="section-label wide">── 医療加算に関わる記録 ──</label>
      <label>緊急訪問（計画外の緊急訪問）
        <select name="is_emergency"><option value="false" selected>いいえ</option><option value="true">はい</option></select>
      </label>
      <label>緊急訪問の受信時刻（任意） <input type="time" name="emergency_contact_time"></label>
      <label>複数名訪問（同行者あり）
        <select name="accompanied"><option value="false" selected>いいえ</option><option value="true">はい</option></select>
      </label>
      <label>同行者の職種（複数名訪問時）
        <select name="partner_role"><option value="">未選択</option>${Object.entries(PARTNER_ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      </label>
      <fieldset class="wide activity-set">
        <legend>この訪問で実施した記録（該当するものにチェック）</legend>
        ${Object.entries(VISIT_ACTIVITIES).map(([k, v]) => `<label class="chk"><input type="checkbox" name="act_${k}"> ${esc(v)}</label>`).join("")}
      </fieldset>

      <label class="wide">訪問内容 <input name="purpose" placeholder="リハビリテーション 等"></label>
      <div class="wide"><button class="btn btn-primary" type="submit">記録する</button></div>
    </form>`}
  </section>`;
}

/* ---------- 事業所設定タブ ---------- */

function renderOffice() {
  const o = state.office;
  return `
  <section class="panel">
    <div class="panel-head"><h2>事業所マスタ（届出状況）</h2></div>
    <p class="hint">届出状況が「未確認」のままの加算は、判定時にすべて「要確認」になります。管理者に確認のうえ入力してください。</p>
    <form id="office-form" class="form-grid">
      <label>緊急時訪問看護（24時間対応）体制の届出【介護】 ${triSelect("urgent_visit_registered", o.urgent_visit_registered)}</label>
      <label>24時間対応体制加算の届出【医療】 ${triSelect("system_24h_registered", o.system_24h_registered)}</label>
      <label>訪問看護医療DX情報活用加算の届出（オンライン請求・資格確認体制） ${triSelect("dx_info_registered", o.dx_info_registered)}</label>
      <label>特別地域の指定に該当（特別地域訪問看護加算・遠隔死亡診断） ${triSelect("special_area", o.special_area)}</label>
      <label>理学療法士等の訪問割合（%・直近の実績）
        <input type="number" name="ptotst_ratio_pct" min="0" max="100" step="0.1"
          value="${o.ptotst_visit_ratio == null ? "" : o.ptotst_visit_ratio * 100}" placeholder="未入力=要確認">
      </label>
      <label class="wide">メモ <input name="notes" value="${esc(o.notes || "")}"></label>
      <div class="wide"><button class="btn btn-primary" type="submit">保存</button></div>
    </form>
    <p class="hint">※ 割合の算出方法（分子・分母の定義）と減算の基準割合・減算率は一次資料で確認し、「報酬マスタ」の ptotst_ratio_reduction_rule に設定してください。</p>
  </section>`;
}

/* ---------- 報酬マスタタブ ---------- */

function renderMaster() {
  const m = activeMaster();
  const rows = m.items.map(it => `
    <tr>
      <td>${esc(it.code)}</td>
      <td>${esc(it.name_ja)}</td>
      <td>${insuranceChip(it.insurance_type)}</td>
      <td>${esc({ basic: "基本", addition: "加算", reduction: "減算", ryoyohi: "療養費" }[it.category] || it.category)}</td>
      <td class="num">${it.amount != null ? esc(it.amount) + esc(it.unit || "") : (it.amount_tiers ? '<span class="chip chip-confirm">区分別・未設定</span>' : '<span class="chip chip-confirm">未設定</span>')}</td>
      <td>${it.effective_from ? esc(it.effective_from) : '<span class="chip chip-confirm">未設定</span>'}</td>
      <td>${verChip(Engine.verState(it))}</td>
      <td>${it.source_reference ? esc(it.source_reference) : '<span class="muted">—</span>'}</td>
    </tr>`).join("");

  const unverified = m.items.filter(i => Engine.verState(i) !== "official_confirmed").length;
  return `
  <section class="panel">
    <div class="panel-head">
      <h2>報酬・加算マスタ</h2>
      <div class="toolbar">
        <button class="btn" id="btn-master-export">JSONエクスポート</button>
        <label class="btn">JSONインポート<input type="file" id="master-import" accept=".json" hidden></label>
        ${state.masterOverride ? `<button class="btn btn-danger" id="btn-master-reset">既定に戻す</button>` : ""}
      </div>
    </div>
    <div class="notice notice-warn">
      <strong>使用中: ${esc(m.meta ? m.meta.master_name : "（名称なし）")}</strong> ／
      未検証項目 ${unverified}/${m.items.length} 件。
      金額・要件は一次資料（告示・通知PDF、請求ソフトのマスタ出力）と照合するまで <code>null</code>・「未検証」のままです。
      告示・通知PDFをこのチャットにアップロードいただければ、私（Claude）が読み取ってマスタJSONの叩き台を作成します。
      最終的な値の確認・承認は必ずご自身で行ってください。
      参考: 厚生労働省「令和8年度診療報酬改定について」
    </div>
    <div class="table-scroll"><table class="data">
      <thead><tr><th>コード</th><th>名称</th><th>保険</th><th>区分</th><th>金額</th><th>有効開始</th><th>検証</th><th>根拠</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint">時間帯区分定義: ${m.time_band_definitions && m.time_band_definitions.verified ? '<span class="chip chip-ok">設定済</span>' : '<span class="chip chip-confirm">未設定（要確認）</span>'}
    ／ PT等割合減算の基準: ${m.ptotst_ratio_reduction_rule && m.ptotst_ratio_reduction_rule.verified ? '<span class="chip chip-ok">設定済</span>' : '<span class="chip chip-confirm">未設定（要確認）</span>'}</p>
  </section>`;
}

/* ---------- テストタブ ---------- */

let lastTestResults = null;

function renderTests() {
  let body = "";
  if (lastTestResults) {
    const pass = lastTestResults.filter(r => r.pass).length;
    body = `
      <p class="${pass === lastTestResults.length ? "ok-text" : "need-confirm-text"}">
        ${pass} / ${lastTestResults.length} 件 合格</p>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>結果</th><th>シナリオ</th><th>期待値</th><th>実際</th><th>備考</th></tr></thead>
        <tbody>${lastTestResults.map(r => `
          <tr>
            <td>${r.pass ? '<span class="chip chip-ok">PASS</span>' : '<span class="chip chip-fail">FAIL</span>'}</td>
            <td>${esc(r.name)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td><td>${esc(r.note || "")}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
  }
  return `
  <section class="panel">
    <div class="panel-head">
      <h2>テストスイート（架空シナリオ）</h2>
      <div class="toolbar"><button class="btn btn-primary" id="btn-run-tests">テストを実行</button></div>
    </div>
    <p class="hint">架空の利用者シナリオで判定エンジンの動作を検証します。基本報酬の計算テストには
      <strong>実在しない架空の金額を持つテスト専用マスタ</strong>を使用します（実際の点数・単位数ではありません）。</p>
    ${body}
  </section>`;
}

/* ============================ イベント ============================ */

document.addEventListener("DOMContentLoaded", () => {
  const nav = $("#tabs");
  nav.innerHTML = TABS.map(t => `<button class="tab-btn ${t.id === currentTab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("");
  nav.addEventListener("click", (e) => {
    const b = e.target.closest(".tab-btn");
    if (b) switchTab(b.dataset.tab);
  });
  render();
});

/** かんたん判定の回答を利用者マスタへ保存する（生年月日が入力されている場合のみ） */
function quickSavePatient() {
  const q = quickState;
  const input = prompt("利用者ID（匿名IDを入力してください。例: P0001）", "");
  if (input === null) return;
  const pid = input.trim();
  if (!pid) { alert("利用者IDが入力されていません。"); return; }
  const idx = state.patients.findIndex(p => p.patient_id === pid);
  if (idx >= 0 && !confirm(`利用者 ${pid} は既に登録されています。上書きしますか？`)) return;

  const patient = {
    patient_id: pid,
    birth_date: q.birth_date || null,
    care_level: q.care_level || null,
    designated_disease_hyou7: q.hyou7,
    designated_disease_16_of_40to64: q.tokutei,
    psychiatric_non_dementia: q.psych,
    // かんたん判定では指示書の実際の日付を入力していないため、ここでは設定しない
    instruction_sheet: { issued_date: null, valid_until: null, special_instruction_period: null },
    special_management_conditions_hyou8: [],
    notes: ""
  };
  if (idx >= 0) state.patients[idx] = patient; else state.patients.push(patient);
  persist();
  alert(`利用者 ${pid} を登録しました。\n指示書の交付日・有効期限は「利用者」タブで入力してください（かんたん判定では未設定です）。`);
  editingPatientId = pid;
  switchTab("patients");
}

document.addEventListener("click", (e) => {
  const t = e.target;

  /* --- かんたん判定 --- */
  const seg = t.closest(".seg-btn");
  if (seg) {
    const key = seg.dataset.q;
    if (key === "care") quickState.care_level = (quickState.care_level === seg.dataset.v ? "" : seg.dataset.v);
    else quickState[key] = triFromForm(seg.dataset.v);
    render(); return;
  }
  if (t.id === "q-agemode") {
    quickState.ageMode = quickState.ageMode === "birth" ? "age" : "birth";
    render(); return;
  }
  if (t.id === "q-reset") {
    Object.assign(quickState, { age: "", birth_date: "", special: null, hyou7: null, tokutei: null, psych: null, care_level: "" });
    render(); return;
  }
  if (t.id === "q-save") { quickSavePatient(); return; }

  const row = t.closest(".visit-row");
  if (row) { selectedVisitId = row.dataset.visit === selectedVisitId ? null : row.dataset.visit; render(); return; }

  if (t.id === "btn-csv") { exportCSV(); return; }
  if (t.id === "btn-run-tests") {
    lastTestResults = window.runTestSuite(Engine);
    render(); return;
  }
  if (t.id === "cancel-edit") { editingPatientId = null; render(); return; }
  if (t.dataset.editPatient) { editingPatientId = t.dataset.editPatient; render(); return; }
  if (t.dataset.delPatient) {
    if (confirm(`利用者 ${t.dataset.delPatient} を削除しますか？（訪問記録は残ります）`)) {
      state.patients = state.patients.filter(p => p.patient_id !== t.dataset.delPatient);
      persist(); render();
    }
    return;
  }
  if (t.dataset.delVisit) {
    if (confirm(`訪問記録 ${t.dataset.delVisit} を削除しますか？`)) {
      state.visits = state.visits.filter(v => v.visit_id !== t.dataset.delVisit);
      persist(); render();
    }
    return;
  }
  if (t.id === "btn-master-export") {
    const blob = new Blob([JSON.stringify(activeMaster(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fee_master.json";
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  if (t.id === "btn-master-reset") {
    if (confirm("インポートしたマスタを破棄し、既定（全項目未検証）に戻しますか？")) {
      state.masterOverride = null; persist(); render();
    }
    return;
  }
});

/* 年齢は入力のたびに再判定する。入力欄より下（#q-body）だけを描き直すので、
   入力欄のDOMは作り直されず、フォーカスとカーソル位置がそのまま保たれる。 */
document.addEventListener("input", (e) => {
  if (e.target.id !== "q-age") return;
  quickState.age = e.target.value;
  const body = document.getElementById("q-body");
  if (body) body.innerHTML = renderQuickBody();
});

document.addEventListener("change", (e) => {
  if (e.target.id === "q-date") { quickState.date = e.target.value || todayISO(); render(); }
  if (e.target.id === "q-birth") { quickState.birth_date = e.target.value; render(); }
  if (e.target.id === "judge-month") { judgeMonth = e.target.value; selectedVisitId = null; render(); }
  if (e.target.id === "judge-patient") { judgePatient = e.target.value; selectedVisitId = null; render(); }
  if (e.target.id === "master-import") {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const m = JSON.parse(reader.result);
        if (!Array.isArray(m.items)) throw new Error("items 配列がありません");
        state.masterOverride = m;
        persist(); render();
        alert(`マスタを取り込みました：${m.meta ? m.meta.master_name : "(名称なし)"}（${m.items.length}項目）`);
      } catch (err) {
        alert("マスタJSONの読み込みに失敗しました: " + err.message);
      }
    };
    reader.readAsText(file);
  }
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const d = Object.fromEntries(new FormData(f).entries());

  if (f.id === "patient-form") {
    const patient = {
      patient_id: d.patient_id.trim(),
      birth_date: d.birth_date || null,
      care_level: d.care_level || null,
      designated_disease_hyou7: triFromForm(d.designated_disease_hyou7),
      hyou7_disease_written: d.hyou7_disease_written || "",
      designated_disease_16_of_40to64: triFromForm(d.designated_disease_16_of_40to64),
      psychiatric_non_dementia: triFromForm(d.psychiatric_non_dementia),
      // 別表8：指示書の記載をそのまま入力（診断名からの自動判定はしない）
      beppyou8_applicable: triFromForm(d.beppyou8_applicable),
      beppyou8_severe: triFromForm(d.beppyou8_severe),
      beppyou8_items: d.beppyou8_items || "",
      instruction_sheet: {
        issued_date: d.issued_date || null,
        valid_until: d.valid_until || null,
        special_instruction_period: (d.sp_start || d.sp_end) ? { start: d.sp_start || null, end: d.sp_end || null } : null
      },
      // 医療加算用
      consent_24h: triFromForm(d.consent_24h),
      discharge_date: d.discharge_date || null,
      discharge_joint_guidance: triFromForm(d.discharge_joint_guidance),
      death_date: d.death_date || null,
      terminal_consent: triFromForm(d.terminal_consent),
      // 後方互換のため残置（未使用）
      special_management_conditions_hyou8: [],
      notes: d.notes || ""
    };
    const idx = state.patients.findIndex(p => p.patient_id === patient.patient_id);
    if (idx >= 0) state.patients[idx] = patient;
    else state.patients.push(patient);
    editingPatientId = null;
    persist(); render();
  }

  if (f.id === "visit-form") {
    // チェックされた「実施した記録」を配列に集約
    const recorded = Object.keys(VISIT_ACTIVITIES).filter(k => d["act_" + k] === "on");
    state.visits.push({
      visit_id: nextVisitId(),
      patient_id: d.patient_id,
      date: d.date,
      start_time: d.start_time || null,
      duration_minutes: d.duration_minutes ? Number(d.duration_minutes) : null,
      role: d.role,
      staff: [{ role: d.role }],
      same_building: triFromForm(d.same_building),
      same_building_count: d.same_building_count ? Number(d.same_building_count) : null,
      is_emergency: d.is_emergency === "true",
      emergency_contact_time: d.emergency_contact_time || null,
      accompanied: d.accompanied === "true",
      partner_role: d.partner_role || null,
      recorded_activities: recorded,
      purpose: d.purpose || ""
    });
    persist(); render();
  }

  if (f.id === "office-form") {
    state.office.urgent_visit_registered = triFromForm(d.urgent_visit_registered);
    state.office.system_24h_registered = triFromForm(d.system_24h_registered);
    state.office.dx_info_registered = triFromForm(d.dx_info_registered);
    state.office.special_area = triFromForm(d.special_area);
    state.office.ptotst_visit_ratio = d.ptotst_ratio_pct === "" ? null : Number(d.ptotst_ratio_pct) / 100;
    state.office.notes = d.notes || "";
    persist(); render();
    alert("事業所設定を保存しました。");
  }
});

/* テストから参照できるように公開 */
window.Engine = Engine;
window.calcAge = calcAge;
