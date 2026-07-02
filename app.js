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

    const age = calcAge(patient.birth_date, visitDate);
    if (age === null) {
      trace.push({ step: "年齢の算出", result: "不可", note: "生年月日または訪問日が未入力・不正" });
      confirm.push("生年月日が未入力のため年齢を判定できません");
      return done("unknown");
    }
    trace.push({ step: "年齢の算出", result: `${age}歳`, note: `生年月日 ${patient.birth_date} / 基準日 ${visitDate}` });

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

    if (!item.verified) {
      confirms.push("この項目は未検証です（一次資料と照合し verified を true にするまで合計に含めません）");
    }

    let status;
    if (excluded) status = "excluded";
    else if (unknown) status = "needs_check";
    else if (item.verified && amount != null) status = "matched";
    else status = "matched_unconfirmed";

    return { status, amount, reasons, confirms };
  },

  /**
   * 訪問1件の総合判定：保険種別 → 基本報酬・減算・加算の評価 → 合計
   */
  judgeVisit(visit, patient, office, master) {
    const result = {
      visit, patient,
      insurance: null,
      judgment: null,
      timeBand: null,
      sheetWarnings: [],
      items: { applied: [], unconfirmed: [], needsCheck: [], excluded: [] },
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
    return result;
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
  { id: "judge",    label: "判定・計算" },
  { id: "patients", label: "利用者" },
  { id: "visits",   label: "訪問記録" },
  { id: "office",   label: "事業所設定" },
  { id: "master",   label: "報酬マスタ" },
  { id: "tests",    label: "テスト" }
];

let currentTab = "judge";
let selectedVisitId = null;

function switchTab(id) {
  currentTab = id;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  render();
}

function render() {
  const el = $("#content");
  if (currentTab === "judge") el.innerHTML = renderJudge();
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

function confirmBadge(text) { return `<span class="chip chip-confirm">要確認</span> ${esc(text)}`; }

/* ---------- 判定・計算タブ ---------- */

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
let judgeMonth = currentMonth();
let judgePatient = "";

function renderJudge() {
  const master = activeMaster();
  const visits = state.visits
    .filter(v => v.date && v.date.startsWith(judgeMonth))
    .filter(v => !judgePatient || v.patient_id === judgePatient)
    .sort((a, b) => (a.date + (a.start_time || "")).localeCompare(b.date + (b.start_time || "")));

  const patientOpts = ['<option value="">全利用者</option>']
    .concat(state.patients.map(p => `<option value="${esc(p.patient_id)}" ${p.patient_id === judgePatient ? "selected" : ""}>${esc(p.patient_id)}</option>`))
    .join("");

  let rows = "";
  let detail = "";
  for (const v of visits) {
    const p = state.patients.find(x => x.patient_id === v.patient_id);
    const r = Engine.judgeVisit(v, p, state.office, master);
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
      : `<table class="data">
          <thead><tr><th>訪問日</th><th>利用者ID</th><th>職種</th><th>時間</th><th>保険種別</th><th>適用/未確定</th><th>要確認</th><th>確定合計</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="hint">行をクリックすると判定の詳細（根拠トレース）を表示します。「適用/未確定」は 確定した項目数/要確認の項目数 です。</p>`}
    ${detail}
  </section>`;
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
    ${rows.map(row => `
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
      </div>`).join("")}`;

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
    ${state.patients.length ? `<table class="data">
      <thead><tr><th>ID</th><th>生年月日</th><th>要介護度</th><th>別表7</th><th>特定疾病(40-64)</th><th>指示書期限</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : `<p class="empty">利用者が未登録です。</p>`}

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
      <label>介護保険の特定疾病（16疾病）該当 ※40〜64歳で使用 ${triSelect("designated_disease_16_of_40to64", s.designated_disease_16_of_40to64)}</label>
      <label>精神科訪問看護の対象（認知症を除く） ${triSelect("psychiatric_non_dementia", s.psychiatric_non_dementia)}</label>
      <label>指示書 交付日 <input type="date" name="issued_date" value="${esc(sheet.issued_date || "")}"></label>
      <label>指示書 有効期限 <input type="date" name="valid_until" value="${esc(sheet.valid_until || "")}"></label>
      <label>特別指示書 開始日 <input type="date" name="sp_start" value="${esc(sp.start || "")}"></label>
      <label>特別指示書 終了日 <input type="date" name="sp_end" value="${esc(sp.end || "")}"></label>
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
    ${state.visits.length ? `<table class="data">
      <thead><tr><th>ID</th><th>日付</th><th>開始</th><th>利用者</th><th>職種</th><th>分</th><th>同一建物</th><th>内容</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : `<p class="empty">訪問記録がありません。</p>`}

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
      <label>緊急時訪問看護（24時間対応）体制の届出 ${triSelect("urgent_visit_registered", o.urgent_visit_registered)}</label>
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
      <td>${esc({ basic: "基本", addition: "加算", reduction: "減算" }[it.category] || it.category)}</td>
      <td class="num">${it.amount != null ? esc(it.amount) + esc(it.unit || "") : '<span class="chip chip-confirm">未設定</span>'}</td>
      <td>${it.effective_from ? esc(it.effective_from) : '<span class="chip chip-confirm">未設定</span>'}</td>
      <td>${it.verified ? '<span class="chip chip-ok">検証済</span>' : '<span class="chip chip-confirm">未検証</span>'}</td>
      <td>${it.source_reference ? esc(it.source_reference) : '<span class="muted">—</span>'}</td>
    </tr>`).join("");

  const unverified = m.items.filter(i => !i.verified).length;
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
    <table class="data">
      <thead><tr><th>コード</th><th>名称</th><th>保険</th><th>区分</th><th>金額</th><th>有効開始</th><th>検証</th><th>根拠</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
      <table class="data">
        <thead><tr><th>結果</th><th>シナリオ</th><th>期待値</th><th>実際</th><th>備考</th></tr></thead>
        <tbody>${lastTestResults.map(r => `
          <tr>
            <td>${r.pass ? '<span class="chip chip-ok">PASS</span>' : '<span class="chip chip-fail">FAIL</span>'}</td>
            <td>${esc(r.name)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td><td>${esc(r.note || "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
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

document.addEventListener("click", (e) => {
  const t = e.target;

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

document.addEventListener("change", (e) => {
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
      designated_disease_16_of_40to64: triFromForm(d.designated_disease_16_of_40to64),
      psychiatric_non_dementia: triFromForm(d.psychiatric_non_dementia),
      instruction_sheet: {
        issued_date: d.issued_date || null,
        valid_until: d.valid_until || null,
        special_instruction_period: (d.sp_start || d.sp_end) ? { start: d.sp_start || null, end: d.sp_end || null } : null
      },
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
    state.visits.push({
      visit_id: nextVisitId(),
      patient_id: d.patient_id,
      date: d.date,
      start_time: d.start_time || null,
      duration_minutes: d.duration_minutes ? Number(d.duration_minutes) : null,
      role: d.role,
      staff: [{ role: d.role }],
      same_building: triFromForm(d.same_building),
      purpose: d.purpose || ""
    });
    persist(); render();
  }

  if (f.id === "office-form") {
    state.office.urgent_visit_registered = triFromForm(d.urgent_visit_registered);
    state.office.ptotst_visit_ratio = d.ptotst_ratio_pct === "" ? null : Number(d.ptotst_ratio_pct) / 100;
    state.office.notes = d.notes || "";
    persist(); render();
    alert("事業所設定を保存しました。");
  }
});

/* テストから参照できるように公開 */
window.Engine = Engine;
window.calcAge = calcAge;
