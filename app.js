"use strict";

const POLLING_PATH = "president.csv";
const ECONOMIC_PATH = "economic.csv";
const DAY = 86_400_000;
const isMobile = window.matchMedia("(max-width: 600px)").matches;
const charts = {};
let allPolls = [];
let modelCache = null;
let trendRange = "all";

Chart.defaults.color = "#66716c";
Chart.defaults.borderColor = "rgba(84, 92, 87, 0.14)";
Chart.defaults.font.family = 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
Chart.defaults.font.size = isMobile ? 10 : 11;
Chart.defaults.animation.duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 9;
Chart.defaults.plugins.legend.labels.padding = isMobile ? 10 : 18;

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCSVLine(lines.shift());
  return lines.filter(Boolean).map((line) => {
    const values = parseCSVLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function parsePollingDate(value) {
  if (!value) return null;
  const [month, day, yearValue] = value.split("/").map(Number);
  const year = yearValue < 100 ? yearValue + 2000 : yearValue;
  return month && day && year ? new Date(year, month - 1, day, 12) : null;
}

function parseISODate(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day, 12) : null;
}

function destroyChart(name) {
  if (charts[name]) {
    charts[name].destroy();
    delete charts[name];
  }
}

function showError(message) {
  const element = document.getElementById("loadError");
  element.textContent = element.textContent ? `${element.textContent} ${message}` : message;
  element.classList.add("visible");
}

function formatDate(date, options = { month: "short", year: "numeric" }) {
  return date.toLocaleDateString("en-US", options);
}

function formatNumber(value, maximumFractionDigits = 0) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function signed(value, digits = 1, suffix = "") {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
}

function endpointLabels(targets) {
  return {
    id: `endpointLabels-${Math.random()}`,
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      targets.forEach((target) => {
        const meta = chart.getDatasetMeta(target.index);
        if (!meta || meta.hidden || !meta.data.length) return;
        const point = meta.data[meta.data.length - 1];
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;

        ctx.save();
        ctx.fillStyle = target.color;
        ctx.beginPath();
        ctx.arc(point.x, point.y, isMobile ? 3 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `700 ${isMobile ? 9 : 10}px Inter, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(target.text(), point.x + (isMobile ? 6 : 8), point.y);
        ctx.restore();
      });
    }
  };
}

function timeChartOptions({
  unit = "month",
  legend = false,
  yTick = (value) => value,
  tooltipLabel,
  min,
  max,
  zeroLine = false,
  rightPadding = 18
} = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 6, right: rightPadding } },
    scales: {
      x: {
        type: "time",
        time: { unit, tooltipFormat: "MMM d, yyyy" },
        grid: { display: false },
        ticks: { maxRotation: 0, autoSkipPadding: 18 }
      },
      y: {
        min,
        max,
        grace: "8%",
        ticks: { callback: yTick, maxTicksLimit: 6 },
        grid: {
          color: (context) => zeroLine && context.tick.value === 0
            ? "rgba(36, 48, 44, 0.36)"
            : "rgba(84, 92, 87, 0.13)"
        }
      }
    },
    plugins: {
      legend: { display: legend, position: "top", align: "start" },
      tooltip: tooltipLabel ? { callbacks: { label: tooltipLabel } } : {}
    }
  };
}

// ─── Polling model ───────────────────────────────────────────────────────────

const MODEL_CONFIG = {
  lambda: Math.LN2 / 14,
  sampleSizeRef: 600,
  sampleSizeCap: 10_000,
  sampleSizeDefault: 1_000,
  methodologyWeights: {
    "Live Phone": 1,
    "Probability Panel": 1,
    IVR: 1,
    "Live Phone/Text-to-Web": 0.85,
    "Live Phone/Text/Nonprobability Panel": 0.85,
    "Live Phone/Nonprobability Panel": 0.85,
    "Text/IVR": 0.85,
    "Probability Panel/Nonprobability Panel/Text-to-Web": 0.8,
    "Live Phone/Nonprobability Panel/Text-to-Web": 0.85,
    "Live Phone/Text-to-Web/Nonprobability Panel": 0.85,
    "Nonprobability Panel": 0.7,
    "App Panel": 0.7,
    "Text-to-Web": 0.7,
    "Text-to-Web/Nonprobability Panel": 0.7,
    "Nonprobability Panel/Live Phone/Text-to-Web": 0.8,
    "": 0.65
  },
  populationWeights: { lv: 1, rv: 0.95, a: 0.8 },
  partisanWeights: { "": 1, REP: 0.5, DEM: 0.5 },
  populationPriority: ["lv", "rv", "a"],
  houseEffectShrinkage: 10,
  houseEffectIterations: 5,
  bandZ: 1.645,
  bandInflation: 1.3,
  outlierZ: 2.5,
  minPollsForTrend: 5
};

const modelMemo = new Map();

function methodologyWeight(methodology) {
  if (!methodology) return 0.65;
  if (MODEL_CONFIG.methodologyWeights[methodology] !== undefined) {
    return MODEL_CONFIG.methodologyWeights[methodology];
  }
  if (/Probability/i.test(methodology) && !/Non/i.test(methodology)) return 1;
  if (/Live Phone/i.test(methodology)) return 0.85;
  if (/Non|App|Text/i.test(methodology)) return 0.7;
  return 0.65;
}

function preprocessPolls(data) {
  const byPollId = new Map();
  data.filter((poll) => poll.midDate).forEach((poll, index) => {
    const id = poll.poll_id || `missing-${index}`;
    const existing = byPollId.get(id);
    if (!existing) {
      byPollId.set(id, poll);
      return;
    }

    const priority = MODEL_CONFIG.populationPriority;
    const oldIndex = priority.indexOf(existing.population);
    const newIndex = priority.indexOf(poll.population);
    if (newIndex >= 0 && (oldIndex < 0 || newIndex < oldIndex)) byPollId.set(id, poll);
  });

  return [...byPollId.values()].map((poll) => {
    const sampleSize = Math.min(poll.sampleSize || MODEL_CONFIG.sampleSizeDefault, MODEL_CONFIG.sampleSizeCap);
    return {
      ...poll,
      weightSample: Math.sqrt(sampleSize / MODEL_CONFIG.sampleSizeRef),
      weightMethod: methodologyWeight(poll.methodology),
      weightPopulation: MODEL_CONFIG.populationWeights[poll.population] || 0.8,
      weightPartisan: MODEL_CONFIG.partisanWeights[poll.partisan] || 1,
      midTime: poll.midDate.getTime()
    };
  });
}

function weightedLeastSquares(points, key) {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let t0 = 0;
  let t1 = 0;
  let sumWeightSquared = 0;

  points.forEach((point) => {
    s0 += point.weight;
    s1 += point.weight * point.x;
    s2 += point.weight * point.x * point.x;
    t0 += point.weight * point[key];
    t1 += point.weight * point.x * point[key];
    sumWeightSquared += point.weight * point.weight;
  });

  if (s0 <= 0) return null;
  const effectiveN = (s0 * s0) / sumWeightSquared;
  const denominator = s0 * s2 - s1 * s1;
  if (effectiveN < MODEL_CONFIG.minPollsForTrend || denominator < 1e-6) {
    return { intercept: t0 / s0, slope: 0, s0, sumWeightSquared };
  }

  return {
    intercept: (s2 * t0 - s1 * t1) / denominator,
    slope: (s0 * t1 - s1 * t0) / denominator,
    s0,
    sumWeightSquared
  };
}

function robustFit(points, key) {
  let fit = weightedLeastSquares(points, key);
  if (!fit) return null;

  let weighted = points;
  let totalWeight = 0;
  let weightedResiduals = 0;
  points.forEach((point) => {
    const residual = point[key] - (fit.intercept + fit.slope * point.x);
    totalWeight += point.weight;
    weightedResiduals += point.weight * residual * residual;
  });

  const sigma = Math.sqrt(weightedResiduals / totalWeight);
  if (sigma > 0.01) {
    const cutoff = MODEL_CONFIG.outlierZ * sigma;
    weighted = points.map((point) => {
      const residual = Math.abs(point[key] - (fit.intercept + fit.slope * point.x));
      return residual > cutoff ? { ...point, weight: point.weight * cutoff / residual } : point;
    });
    fit = weightedLeastSquares(weighted, key);
    totalWeight = 0;
    weightedResiduals = 0;
    weighted.forEach((point) => {
      const residual = point[key] - (fit.intercept + fit.slope * point.x);
      totalWeight += point.weight;
      weightedResiduals += point.weight * residual * residual;
    });
  }

  const varianceDenominator = totalWeight - fit.sumWeightSquared / totalWeight;
  return {
    estimate: fit.intercept,
    variance: varianceDenominator > 0
      ? weightedResiduals / varianceDenominator
      : weightedResiduals / totalWeight,
    s0: fit.s0,
    sumWeightSquared: fit.sumWeightSquared
  };
}

function computeDailyEstimates(polls, houseEffects) {
  if (!polls.length) return [];
  const start = Math.min(...polls.map((poll) => poll.midTime));
  const end = Math.max(...polls.map((poll) => poll.endDate?.getTime() || poll.midTime));
  const estimates = [];

  for (let time = start; time <= end; time += DAY) {
    const active = [];
    const pollsterMass = {};

    polls.forEach((poll) => {
      const x = (poll.midTime - time) / DAY;
      const recency = Math.exp(-MODEL_CONFIG.lambda * Math.abs(x));
      const weight = recency * poll.weightSample * poll.weightMethod * poll.weightPopulation * poll.weightPartisan;
      if (weight < 0.001) return;

      const houseEffect = houseEffects[poll.pollster] || { approve: 0, disapprove: 0 };
      active.push({
        weight,
        x,
        approve: poll.approve - houseEffect.approve,
        disapprove: poll.disapprove - houseEffect.disapprove,
        pollster: poll.pollster
      });
      pollsterMass[poll.pollster] = (pollsterMass[poll.pollster] || 0) + recency;
    });

    active.forEach((point) => {
      point.weight /= Math.sqrt(Math.max(1, pollsterMass[point.pollster]));
    });

    const approveFit = robustFit(active, "approve");
    const disapproveFit = robustFit(active, "disapprove");
    if (!approveFit || !disapproveFit || approveFit.s0 < 0.01) continue;

    const approveError = Math.sqrt(approveFit.variance) * MODEL_CONFIG.bandInflation;
    const disapproveError = Math.sqrt(disapproveFit.variance) * MODEL_CONFIG.bandInflation;
    const approve = approveFit.estimate;
    const disapprove = disapproveFit.estimate;

    estimates.push({
      date: new Date(time),
      approve,
      disapprove,
      net: approve - disapprove,
      approveUpper: approve + MODEL_CONFIG.bandZ * approveError,
      approveLower: approve - MODEL_CONFIG.bandZ * approveError,
      disapproveUpper: disapprove + MODEL_CONFIG.bandZ * disapproveError,
      disapproveLower: disapprove - MODEL_CONFIG.bandZ * disapproveError,
      netUpper: approve + MODEL_CONFIG.bandZ * approveError - (disapprove - MODEL_CONFIG.bandZ * disapproveError),
      netLower: approve - MODEL_CONFIG.bandZ * approveError - (disapprove + MODEL_CONFIG.bandZ * disapproveError)
    });
  }

  return estimates;
}

function estimateHouseEffects(polls) {
  let houseEffects = {};
  const pollsters = [...new Set(polls.map((poll) => poll.pollster))];

  for (let iteration = 0; iteration < MODEL_CONFIG.houseEffectIterations; iteration += 1) {
    const estimates = computeDailyEstimates(polls, houseEffects);
    if (!estimates.length) return {};
    const estimateByDay = new Map(estimates.map((estimate) => [Math.round(estimate.date.getTime() / DAY), estimate]));
    const next = {};

    pollsters.forEach((pollster) => {
      const pollsterPolls = polls.filter((poll) => poll.pollster === pollster);
      if (pollsterPolls.length < 3) return;
      let totalWeight = 0;
      let approveDeviation = 0;
      let disapproveDeviation = 0;

      pollsterPolls.forEach((poll) => {
        const dayKey = Math.round(poll.midTime / DAY);
        let estimate = estimateByDay.get(dayKey);
        if (!estimate) {
          estimate = estimates.reduce((closest, candidate) => (
            !closest || Math.abs(candidate.date - poll.midTime) < Math.abs(closest.date - poll.midTime)
              ? candidate
              : closest
          ), null);
        }
        if (!estimate) return;

        const prior = houseEffects[pollster] || { approve: 0, disapprove: 0 };
        const weight = poll.weightSample * poll.weightMethod * poll.weightPopulation * poll.weightPartisan;
        totalWeight += weight;
        approveDeviation += weight * ((poll.approve - prior.approve) - estimate.approve);
        disapproveDeviation += weight * ((poll.disapprove - prior.disapprove) - estimate.disapprove);
      });

      if (totalWeight > 0) {
        const shrinkage = pollsterPolls.length / (pollsterPolls.length + MODEL_CONFIG.houseEffectShrinkage);
        next[pollster] = {
          approve: approveDeviation / totalWeight * shrinkage,
          disapprove: disapproveDeviation / totalWeight * shrinkage
        };
      }
    });
    houseEffects = next;
  }

  return houseEffects;
}

function runModel(data, key) {
  if (modelMemo.has(key)) return modelMemo.get(key);
  const polls = preprocessPolls(data);
  const houseEffects = estimateHouseEffects(polls);
  const result = { polls, estimates: computeDailyEstimates(polls, houseEffects) };
  modelMemo.set(key, result);
  return result;
}

function filteredPolls() {
  const population = document.getElementById("popFilter").value;
  const partisan = document.getElementById("partisanFilter").value;
  return allPolls.filter((poll) => {
    const populationMatch = population === "all" || poll.population === population;
    const partisanMatch = partisan === "all"
      || (partisan === "nonpartisan" ? !poll.partisan : poll.partisan === partisan);
    return populationMatch && partisanMatch;
  });
}

function rangeStart(estimates) {
  if (trendRange === "all" || !estimates.length) return null;
  return estimates.at(-1).date.getTime() - Number(trendRange) * DAY;
}

function pollingTimeUnit() {
  if (trendRange === "all" || Number(trendRange) > 100) return "month";
  return Number(trendRange) <= 35 ? "day" : "week";
}

function renderPolling() {
  const data = filteredPolls();
  const cacheKey = `${document.getElementById("popFilter").value}|${document.getElementById("partisanFilter").value}`;
  modelCache = runModel(data, cacheKey);
  const { estimates } = modelCache;
  if (!estimates.length) {
    showError("There is not enough polling data for that filter combination.");
    return;
  }

  const latest = estimates.at(-1);
  const pollDates = data.map((poll) => poll.endDate).filter(Boolean).sort((a, b) => a - b);
  document.getElementById("avgApprove").textContent = `${latest.approve.toFixed(1)}%`;
  document.getElementById("avgDisapprove").textContent = `${latest.disapprove.toFixed(1)}%`;
  document.getElementById("netApproval").textContent = signed(latest.net);
  document.getElementById("latestPoll").textContent = pollDates.length
    ? formatDate(pollDates.at(-1), { month: "short", day: "numeric" })
    : "—";
  document.getElementById("trendCount").textContent = `${data.length} polls`;

  renderTrendChart(data, estimates);
  renderNetChart(data, estimates);
}

function pollingBounds(data, estimates, start, keys) {
  const values = [];
  estimates.forEach((estimate) => {
    if (start && estimate.date.getTime() < start) return;
    keys.forEach((key) => values.push(estimate[key]));
  });
  data.forEach((poll) => {
    if (start && poll.endDate?.getTime() < start) return;
    if (keys.includes("approveLower")) values.push(poll.approve, poll.disapprove);
    if (keys.includes("netLower")) values.push(poll.net);
  });
  return values.length
    ? { min: Math.floor(Math.min(...values) - 2), max: Math.ceil(Math.max(...values) + 2) }
    : {};
}

function renderTrendChart(data, estimates) {
  destroyChart("trend");
  const start = rangeStart(estimates);
  const bounds = start
    ? pollingBounds(data, estimates, start, ["approveLower", "approveUpper", "disapproveLower", "disapproveUpper"])
    : { min: 25, max: 70 };
  const latest = estimates.at(-1);

  charts.trend = new Chart(document.getElementById("trendChart"), {
    type: "line",
    data: {
      datasets: [
        { label: "90% approve band", data: estimates.map((item) => ({ x: item.date, y: item.approveUpper })), borderColor: "transparent", backgroundColor: "rgba(111, 166, 132, 0.15)", fill: "+1", pointRadius: 0, borderWidth: 0, order: 4 },
        { label: "_approveLower", data: estimates.map((item) => ({ x: item.date, y: item.approveLower })), borderColor: "transparent", backgroundColor: "transparent", pointRadius: 0, borderWidth: 0, order: 4 },
        { label: "90% disapprove band", data: estimates.map((item) => ({ x: item.date, y: item.disapproveUpper })), borderColor: "transparent", backgroundColor: "rgba(196, 104, 112, 0.13)", fill: "+1", pointRadius: 0, borderWidth: 0, order: 4 },
        { label: "_disapproveLower", data: estimates.map((item) => ({ x: item.date, y: item.disapproveLower })), borderColor: "transparent", backgroundColor: "transparent", pointRadius: 0, borderWidth: 0, order: 4 },
        { label: "Approve polls", data: data.map((poll) => ({ x: poll.endDate, y: poll.approve })), borderWidth: 0, pointRadius: isMobile ? 1.4 : 2.2, pointBackgroundColor: "rgba(77, 128, 102, 0.28)", showLine: false, order: 3 },
        { label: "Disapprove polls", data: data.map((poll) => ({ x: poll.endDate, y: poll.disapprove })), borderWidth: 0, pointRadius: isMobile ? 1.4 : 2.2, pointBackgroundColor: "rgba(189, 93, 103, 0.26)", showLine: false, order: 3 },
        { label: `Approve ${latest.approve.toFixed(1)}%`, data: estimates.map((item) => ({ x: item.date, y: item.approve })), borderColor: "#4d8066", borderWidth: 2.6, pointRadius: 0, tension: 0.2, order: 1 },
        { label: `Disapprove ${latest.disapprove.toFixed(1)}%`, data: estimates.map((item) => ({ x: item.date, y: item.disapprove })), borderColor: "#bd5d67", borderWidth: 2.6, pointRadius: 0, tension: 0.2, order: 1 }
      ]
    },
    options: {
      ...timeChartOptions({ unit: pollingTimeUnit(), legend: true, min: bounds.min, max: bounds.max, yTick: (value) => `${value}%`, rightPadding: isMobile ? 34 : 48 }),
      scales: {
        ...timeChartOptions().scales,
        x: { type: "time", min: start || undefined, time: { unit: pollingTimeUnit(), tooltipFormat: "MMM d, yyyy" }, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 18 } },
        y: { min: bounds.min, max: bounds.max, ticks: { callback: (value) => `${value}%`, maxTicksLimit: 6 }, grid: { color: "rgba(84, 92, 87, 0.13)" } }
      },
      plugins: {
        filler: { propagate: true },
        tooltip: {
          filter: (item) => !item.dataset.label.startsWith("_") && !item.dataset.label.startsWith("90%"),
          callbacks: { label: (context) => `${context.dataset.label.split(/ \d/)[0]}: ${context.parsed.y.toFixed(1)}%` }
        },
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: { filter: (item) => !item.text.startsWith("_") && !item.text.startsWith("90%") }
        }
      }
    },
    plugins: [endpointLabels([
      { index: 6, color: "#4d8066", text: () => `${latest.approve.toFixed(1)}%` },
      { index: 7, color: "#bd5d67", text: () => `${latest.disapprove.toFixed(1)}%` }
    ])]
  });
}

function renderNetChart(data, estimates) {
  destroyChart("net");
  const start = rangeStart(estimates);
  const bounds = start ? pollingBounds(data, estimates, start, ["netLower", "netUpper"]) : {};
  const latest = estimates.at(-1);

  charts.net = new Chart(document.getElementById("netChart"), {
    type: "line",
    data: {
      datasets: [
        { label: "_netUpper", data: estimates.map((item) => ({ x: item.date, y: item.netUpper })), borderColor: "transparent", backgroundColor: "rgba(85, 126, 167, 0.14)", fill: "+1", pointRadius: 0, borderWidth: 0, order: 4 },
        { label: "_netLower", data: estimates.map((item) => ({ x: item.date, y: item.netLower })), borderColor: "transparent", backgroundColor: "transparent", pointRadius: 0, borderWidth: 0, order: 4 },
        { label: "Polls", data: data.map((poll) => ({ x: poll.endDate, y: poll.net })), borderWidth: 0, pointRadius: isMobile ? 1.5 : 2.2, pointBackgroundColor: "rgba(85, 126, 167, 0.25)", showLine: false, order: 3 },
        { label: "Weighted net", data: estimates.map((item) => ({ x: item.date, y: item.net })), borderColor: "#557ea7", borderWidth: 2.8, pointRadius: 0, tension: 0.2, order: 1 }
      ]
    },
    options: {
      ...timeChartOptions({ unit: pollingTimeUnit(), min: bounds.min, max: bounds.max, zeroLine: true, yTick: (value) => signed(Number(value), 0), rightPadding: isMobile ? 34 : 48 }),
      scales: {
        x: { type: "time", min: start || undefined, time: { unit: pollingTimeUnit(), tooltipFormat: "MMM d, yyyy" }, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 18 } },
        y: { min: bounds.min, max: bounds.max, grace: "8%", ticks: { callback: (value) => signed(Number(value), 0), maxTicksLimit: 6 }, grid: { color: (context) => context.tick.value === 0 ? "rgba(36, 48, 44, 0.36)" : "rgba(84, 92, 87, 0.13)" } }
      },
      plugins: {
        filler: { propagate: true },
        legend: { display: false },
        tooltip: { filter: (item) => !item.dataset.label.startsWith("_"), callbacks: { label: (context) => `${context.dataset.label}: ${signed(context.parsed.y)}` } }
      }
    },
    plugins: [endpointLabels([{ index: 3, color: "#557ea7", text: () => signed(latest.net) }])]
  });
}

async function loadPolling() {
  const response = await fetch(POLLING_PATH);
  if (!response.ok) throw new Error(`Polling data returned HTTP ${response.status}`);
  const rows = parseCSV(await response.text());
  allPolls = rows.map((row) => {
    const startDate = parsePollingDate(row.start_date);
    const endDate = parsePollingDate(row.end_date);
    return {
      ...row,
      approve: Number(row.yes) || 0,
      disapprove: Number(row.no) || 0,
      net: (Number(row.yes) || 0) - (Number(row.no) || 0),
      sampleSize: Number(row.sample_size) || null,
      startDate,
      endDate,
      midDate: startDate && endDate ? new Date((startDate.getTime() + endDate.getTime()) / 2) : endDate
    };
  }).filter((poll) => poll.endDate && poll.approve && poll.disapprove)
    .sort((a, b) => a.endDate - b.endDate);

  renderPolling();
  return allPolls.at(-1)?.endDate;
}

// ─── Economic charts ─────────────────────────────────────────────────────────

const SERIES = {
  SP500: { name: "S&P 500", color: "#725e9e" },
  NASDAQCOM: { name: "NASDAQ", color: "#c46c3f" },
  DJIA: { name: "Dow", color: "#4d8066" }
};

function groupEconomicRows(rows) {
  const grouped = {};
  rows.forEach((row) => {
    const date = parseISODate(row.date);
    const value = Number(row.value);
    if (!date || !Number.isFinite(value)) return;
    (grouped[row.series] ||= []).push({ date, value });
  });
  Object.values(grouped).forEach((series) => series.sort((a, b) => a.date - b.date));
  return grouped;
}

function trailingYear(points) {
  if (!points?.length) return [];
  const cutoff = new Date(points.at(-1).date);
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  return points.filter((point) => point.date >= cutoff);
}

function tableMarkup(headers, rows) {
  const head = headers.map((header) => `<th scope="col">${header}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderStocks(grouped) {
  destroyChart("stocks");
  const datasets = Object.entries(SERIES).map(([id, config]) => {
    const points = trailingYear(grouped[id]);
    const base = points[0]?.value || 1;
    return {
      label: config.name,
      data: points.map((point) => ({ x: point.date, y: point.value / base * 100, actual: point.value })),
      borderColor: config.color,
      backgroundColor: config.color,
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.16
    };
  });

  const readouts = Object.entries(SERIES).map(([id, config]) => {
    const latest = grouped[id]?.at(-1);
    return `<div class="market-readout"><span class="market-name"><span class="market-dot" style="background:${config.color}"></span>${config.name}</span><span class="market-value">${latest ? formatNumber(latest.value, 2) : "—"}</span></div>`;
  });
  document.getElementById("marketReadouts").innerHTML = readouts.join("");

  charts.stocks = new Chart(document.getElementById("stocksChart"), {
    type: "line",
    data: { datasets },
    options: timeChartOptions({
      unit: "month",
      legend: true,
      yTick: (value) => Number(value).toFixed(0),
      tooltipLabel: (context) => `${context.dataset.label}: ${formatNumber(context.raw.actual, 2)} · indexed ${context.parsed.y.toFixed(1)}`
    })
  });

  const monthRows = new Map();
  Object.entries(SERIES).forEach(([id]) => {
    trailingYear(grouped[id]).forEach((point) => {
      const key = `${point.date.getFullYear()}-${String(point.date.getMonth() + 1).padStart(2, "0")}`;
      const row = monthRows.get(key) || { date: point.date };
      row[id] = point.value;
      row.date = point.date;
      monthRows.set(key, row);
    });
  });
  document.getElementById("stocksTable").innerHTML = tableMarkup(
    ["Month end", "S&P 500", "NASDAQ", "Dow"],
    [...monthRows.values()].sort((a, b) => a.date - b.date).map((row) => [
      formatDate(row.date),
      row.SP500 ? formatNumber(row.SP500, 2) : "—",
      row.NASDAQCOM ? formatNumber(row.NASDAQCOM, 2) : "—",
      row.DJIA ? formatNumber(row.DJIA, 2) : "—"
    ])
  );
}

function renderCPI(points) {
  destroyChart("cpi");
  const display = points.slice(-12);
  const latest = display.at(-1);
  const priorYear = points.find((point) => point.date.getFullYear() === latest.date.getFullYear() - 1 && point.date.getMonth() === latest.date.getMonth());
  const yearChange = priorYear ? (latest.value / priorYear.value - 1) * 100 : null;
  document.getElementById("cpiValue").textContent = latest.value.toFixed(1);
  document.getElementById("cpiDetail").textContent = yearChange === null ? "Latest index" : `${signed(yearChange)}% year over year`;

  charts.cpi = new Chart(document.getElementById("cpiChart"), {
    type: "line",
    data: { datasets: [{ label: "CPI", data: display.map((point) => ({ x: point.date, y: point.value })), borderColor: "#c46c3f", backgroundColor: "rgba(196, 108, 63, 0.12)", fill: true, borderWidth: 2.5, pointRadius: 3, pointBackgroundColor: "#c46c3f", tension: 0.25 }] },
    options: timeChartOptions({ unit: "month", yTick: (value) => Number(value).toFixed(0), tooltipLabel: (context) => `CPI: ${context.parsed.y.toFixed(3)}` })
  });
  document.getElementById("cpiTable").innerHTML = tableMarkup(["Month", "CPI index"], display.map((point) => [formatDate(point.date), point.value.toFixed(3)]));
}

function renderJobs(points) {
  destroyChart("jobs");
  const changes = points.slice(1).map((point, index) => ({ date: point.date, value: point.value - points[index].value })).slice(-12);
  const movingAverage = changes.map((point, index) => ({
    x: point.date,
    y: index < 2 ? null : (changes[index].value + changes[index - 1].value + changes[index - 2].value) / 3
  }));
  const latest = changes.at(-1);
  document.getElementById("jobsValue").textContent = `${latest.value > 0 ? "+" : ""}${formatNumber(latest.value)}K`;
  document.getElementById("jobsDetail").textContent = formatDate(latest.date, { month: "long", year: "numeric" });

  charts.jobs = new Chart(document.getElementById("jobsChart"), {
    data: {
      datasets: [
        { type: "bar", label: "Monthly change", data: changes.map((point) => ({ x: point.date, y: point.value })), backgroundColor: changes.map((point) => point.value >= 0 ? "rgba(77, 128, 102, 0.28)" : "rgba(189, 93, 103, 0.32)"), borderRadius: 3, order: 2 },
        { type: "line", label: "3-month average", data: movingAverage, borderColor: "#c46c3f", backgroundColor: "#c46c3f", borderWidth: 2.3, pointRadius: 2.5, tension: 0.2, spanGaps: true, order: 1 }
      ]
    },
    options: timeChartOptions({ unit: "month", legend: true, zeroLine: true, yTick: (value) => `${Number(value) > 0 ? "+" : ""}${formatNumber(Number(value))}K`, tooltipLabel: (context) => `${context.dataset.label}: ${signed(context.parsed.y, 0, "K")}` })
  });
  document.getElementById("jobsTable").innerHTML = tableMarkup(["Month", "Change in jobs"], changes.map((point) => [formatDate(point.date), `${signed(point.value, 0)} thousand`]));
}

function renderGas(points) {
  destroyChart("gas");
  const display = trailingYear(points);
  const latest = display.at(-1);
  document.getElementById("gasValue").textContent = `$${latest.value.toFixed(2)}`;
  document.getElementById("gasDetail").textContent = `Week of ${formatDate(latest.date, { month: "short", day: "numeric" })}`;

  charts.gas = new Chart(document.getElementById("gasChart"), {
    type: "line",
    data: { datasets: [{ label: "Regular gas", data: display.map((point) => ({ x: point.date, y: point.value })), borderColor: "#557ea7", backgroundColor: "rgba(85, 126, 167, 0.12)", fill: true, borderWidth: 2.5, pointRadius: 0, tension: 0.2 }] },
    options: timeChartOptions({ unit: "month", yTick: (value) => `$${Number(value).toFixed(2)}`, tooltipLabel: (context) => `$${context.parsed.y.toFixed(3)} per gallon` })
  });
  document.getElementById("gasTable").innerHTML = tableMarkup(["Week", "Dollars per gallon"], display.map((point) => [formatDate(point.date, { month: "short", day: "numeric", year: "numeric" }), `$${point.value.toFixed(3)}`]));
}

function renderTrade(points) {
  destroyChart("trade");
  const display = points.slice(-12).map((point) => ({ date: point.date, value: Math.abs(point.value) / 1_000 }));
  const latest = display.at(-1);
  document.getElementById("tradeValue").textContent = `$${latest.value.toFixed(1)}B`;
  document.getElementById("tradeDetail").textContent = formatDate(latest.date, { month: "long", year: "numeric" });

  charts.trade = new Chart(document.getElementById("tradeChart"), {
    type: "bar",
    data: { datasets: [{ label: "Trade deficit", data: display.map((point) => ({ x: point.date, y: point.value })), backgroundColor: "rgba(154, 123, 30, 0.34)", borderColor: "#9a7b1e", borderWidth: 1, borderRadius: 4 }] },
    options: timeChartOptions({ unit: "month", yTick: (value) => `$${Number(value).toFixed(0)}B`, tooltipLabel: (context) => `$${context.parsed.y.toFixed(1)} billion` })
  });
  document.getElementById("tradeTable").innerHTML = tableMarkup(["Month", "Trade deficit"], display.map((point) => [formatDate(point.date), `$${point.value.toFixed(1)} billion`]));
}

async function loadEconomic() {
  const response = await fetch(ECONOMIC_PATH);
  if (!response.ok) throw new Error(`Economic data returned HTTP ${response.status}`);
  const grouped = groupEconomicRows(parseCSV(await response.text()));
  const required = ["SP500", "NASDAQCOM", "DJIA", "CPIAUCSL", "PAYEMS", "GASREGW", "BOPGSTB"];
  if (required.some((id) => !grouped[id]?.length)) throw new Error("One or more economic series are missing");

  renderStocks(grouped);
  renderCPI(grouped.CPIAUCSL);
  renderJobs(grouped.PAYEMS);
  renderGas(grouped.GASREGW);
  renderTrade(grouped.BOPGSTB);
  return Math.max(...required.map((id) => grouped[id].at(-1).date.getTime()));
}

function bindControls() {
  document.getElementById("popFilter").addEventListener("change", renderPolling);
  document.getElementById("partisanFilter").addEventListener("change", renderPolling);
  document.querySelectorAll("#rangeSelector button").forEach((button) => {
    button.addEventListener("click", () => {
      trendRange = button.dataset.days;
      document.querySelectorAll("#rangeSelector button").forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      renderPolling();
    });
  });
}

async function init() {
  bindControls();
  const [pollingResult, economicResult] = await Promise.allSettled([loadPolling(), loadEconomic()]);

  if (pollingResult.status === "rejected") {
    console.error(pollingResult.reason);
    showError("Polling data could not be loaded. Run the site through a local web server and refresh the data cache.");
  }
  if (economicResult.status === "rejected") {
    console.error(economicResult.reason);
    showError("Economic data could not be loaded. Run ./update-data.sh, then reload the page.");
  }

  const dates = [
    pollingResult.status === "fulfilled" ? pollingResult.value?.getTime() : null,
    economicResult.status === "fulfilled" ? economicResult.value : null
  ].filter(Number.isFinite);
  const freshness = document.getElementById("freshness");
  freshness.textContent = dates.length
    ? `Latest source observation: ${formatDate(new Date(Math.max(...dates)), { month: "long", day: "numeric", year: "numeric" })}`
    : "Data unavailable";
}

init();
