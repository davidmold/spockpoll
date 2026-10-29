"use strict";

const POLLING_PATH = "president.csv";
const ECONOMIC_PATH = "economic.csv";
const SENATE_PATH = "senate.csv";
const HOUSE_PATH = "house.csv";
const DISTRICTS_PATH = "house-districts.csv";
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

// ─── Election forecast ───────────────────────────────────────────────────────

const ELECTION_CONFIG = {
  simulations: 10_000,
  seed: 20_261_103,
  raceHalfLife: 21,
  raceWindowDays: 90,
  pollNoise: 6,
  raceErrorFloor: 4.5,
  nationalError: 3,
  districtError: 7,
  districtPollBias: 3,
  incumbency: 3,
  senateHoldover: { D: 34, R: 31 },
  senateRepublicanControl: 50,
  houseMajority: 218
};

// Seats on the 2026 ballot and the party that holds each. Holdovers include the two
// independents who caucus with Democrats; the vice president breaks a 50–50 tie.
const SENATE_SEATS = {
  AL: "R", AK: "R", AR: "R", CO: "D", DE: "D", FL: "R", GA: "D", ID: "R", IL: "D",
  IA: "R", KS: "R", KY: "R", LA: "R", ME: "R", MA: "D", MI: "D", MN: "D", MS: "R",
  MT: "R", NE: "R", NH: "D", NJ: "D", NM: "D", NC: "R", OH: "R", OK: "R", OR: "D",
  RI: "D", SC: "R", SD: "R", TN: "R", TX: "R", VA: "D", WV: "R", WY: "R"
};

const PARTY = {
  D: { name: "Democrats", short: "D", color: "#3f73b2", fill: "rgba(63, 115, 178, 0.78)" },
  R: { name: "Republicans", short: "R", color: "#c0505c", fill: "rgba(192, 80, 92, 0.78)" },
  I: { name: "Independents", short: "I", color: "#a8861a", fill: "rgba(168, 134, 26, 0.78)" }
};

function partySide(party) {
  if (party === "DEM") return "D";
  if (party === "REP") return "R";
  return "I";
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normalSampler(random) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    const angle = 2 * Math.PI * random();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function groupQuestions(rows) {
  const questions = new Map();
  rows.forEach((row) => {
    let question = questions.get(row.question_id);
    if (!question) {
      const startDate = parsePollingDate(row.start_date);
      const endDate = parsePollingDate(row.end_date);
      if (!endDate) return;
      question = {
        poll_id: row.poll_id,
        pollster: row.pollster,
        methodology: row.methodology,
        population: row.population,
        partisan: row.partisan,
        reallocated: row.ranked_choice_reallocated === "TRUE",
        sampleSize: Number(row.sample_size) || null,
        race: row.state === "US" ? "US" : `${row.state}-${row.seat_number || ""}`,
        endDate,
        midDate: startDate ? new Date((startDate.getTime() + endDate.getTime()) / 2) : endDate,
        answers: []
      };
      questions.set(row.question_id, question);
    }
    const pct = Number(row.pct);
    if (row.party !== "NONE" && Number.isFinite(pct)) {
      question.answers.push({ name: row.candidate_name, party: row.party, pct });
    }
  });
  return [...questions.values()];
}

function groupByRace(questions) {
  const races = new Map();
  questions.forEach((question) => {
    if (!races.has(question.race)) races.set(question.race, []);
    races.get(question.race).push(question);
  });
  return races;
}

function preferredQuestion(current, candidate) {
  if (!current) return candidate;
  if (current.reallocated !== candidate.reallocated) return candidate.reallocated ? current : candidate;
  const priority = MODEL_CONFIG.populationPriority;
  const currentRank = priority.indexOf(current.population);
  const candidateRank = priority.indexOf(candidate.population);
  if (currentRank !== candidateRank) return candidateRank >= 0 && (currentRank < 0 || candidateRank < currentRank) ? candidate : current;
  return candidate.answers.length > current.answers.length ? candidate : current;
}

// Recency-weighted average margin between a race's two leading candidates.
function raceAverage(questions, referenceTime) {
  const config = ELECTION_CONFIG;
  const decay = Math.LN2 / config.raceHalfLife;
  const recent = questions.filter((question) => referenceTime - question.endDate.getTime() <= config.raceWindowDays * DAY);
  if (!recent.length) return null;

  const scores = new Map();
  recent.forEach((question) => {
    const recency = Math.exp(-decay * (referenceTime - question.midDate.getTime()) / DAY);
    question.answers.forEach((answer) => {
      const key = `${answer.name}|${answer.party}`;
      scores.set(key, (scores.get(key) || 0) + recency * answer.pct);
    });
  });
  const leaders = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([key]) => {
    const [name, party] = key.split("|");
    return { name, party, side: partySide(party) };
  });
  if (leaders.length < 2) return null;

  // Orient the margin so positive values favor the non-Republican candidate.
  const [left, right] = leaders[1].side === "R" || leaders[0].side !== "R" ? leaders : [leaders[1], leaders[0]];
  const nationalSign = left.side !== "R" && right.side === "R" ? 1 : 0;
  const pctFor = (question, leader) => question.answers.find((answer) => answer.name === leader.name && answer.party === leader.party)?.pct;

  const byPoll = new Map();
  recent.forEach((question) => {
    if (pctFor(question, left) === undefined || pctFor(question, right) === undefined) return;
    byPoll.set(question.poll_id, preferredQuestion(byPoll.get(question.poll_id), question));
  });
  const polls = [...byPoll.values()].map((question) => {
    const recency = Math.exp(-decay * Math.abs(referenceTime - question.midDate.getTime()) / DAY);
    const sampleSize = Math.min(question.sampleSize || MODEL_CONFIG.sampleSizeDefault, MODEL_CONFIG.sampleSizeCap);
    return {
      pollster: question.pollster,
      recency,
      weight: recency
        * Math.sqrt(sampleSize / MODEL_CONFIG.sampleSizeRef)
        * methodologyWeight(question.methodology)
        * (MODEL_CONFIG.populationWeights[question.population] || 0.8)
        * (MODEL_CONFIG.partisanWeights[question.partisan] || 1),
      margin: pctFor(question, left) - pctFor(question, right)
    };
  });
  if (!polls.length) return null;

  const pollsterMass = {};
  polls.forEach((poll) => { pollsterMass[poll.pollster] = (pollsterMass[poll.pollster] || 0) + poll.recency; });
  let total = 0;
  let totalSquared = 0;
  let weightedMargin = 0;
  polls.forEach((poll) => {
    const weight = poll.weight / Math.sqrt(Math.max(1, pollsterMass[poll.pollster]));
    total += weight;
    totalSquared += weight * weight;
    weightedMargin += weight * poll.margin;
  });
  const effectivePolls = (total * total) / totalSquared;

  return {
    left,
    right,
    nationalSign,
    margin: weightedMargin / total,
    pollCount: polls.length,
    samplingError: config.pollNoise / Math.sqrt(effectivePolls)
  };
}

function latestPollTime(questions) {
  return Math.max(...questions.map((question) => question.endDate.getTime()));
}

function buildSenateRaces(questions) {
  const races = groupByRace(questions);
  const referenceTime = latestPollTime(questions);
  return Object.entries(SENATE_SEATS).map(([state, holder]) => {
    const average = raceAverage(races.get(`${state}-`) || [], referenceTime);
    if (!average) {
      return { label: state, holder, safe: holder, note: "No recent polls; assumed hold" };
    }
    return {
      label: state,
      holder,
      ...average,
      error: Math.hypot(ELECTION_CONFIG.raceErrorFloor, average.samplingError)
    };
  });
}

function genericBallot(questions) {
  const polls = questions.map((question) => {
    const dem = question.answers.find((answer) => answer.party === "DEM")?.pct;
    const rep = question.answers.find((answer) => answer.party === "REP")?.pct;
    return { ...question, approve: dem, disapprove: rep };
  }).filter((poll) => poll.approve && poll.disapprove)
    .sort((a, b) => a.endDate - b.endDate);
  const { estimates } = runModel(polls, "generic-ballot");
  return { margin: estimates.at(-1).net, pollCount: new Set(polls.map((poll) => poll.poll_id)).size };
}

function buildHouseRaces(districts, questions, generic) {
  const config = ELECTION_CONFIG;
  const races = groupByRace(questions);
  const referenceTime = latestPollTime(questions);

  return districts.map((district) => {
    const label = `${district.state}-${district.district}`;
    const pvi = Number(district.pvi);
    const hasD = district.sides.includes("D");
    const hasR = district.sides.includes("R");
    const independentIncumbent = district.incumbent === "I" && district.sides.includes("I");
    const base = { label, pvi, incumbent: district.incumbent };

    if (hasD && !hasR && !independentIncumbent) return { ...base, safe: "D", note: "No Republican on the ballot" };
    if (hasR && !hasD) return { ...base, safe: "R", note: "No Democrat on the ballot" };

    const right = hasR ? { side: "R", party: "REP" } : { side: "I", party: "IND" };
    const incumbency = district.incumbent === "D" ? config.incumbency : district.incumbent === right.side ? -config.incumbency : 0;
    const prior = generic.margin + 2 * pvi + incumbency;
    let margin = prior;
    let error = config.districtError;

    const polled = raceAverage(races.get(label) || [], referenceTime);
    if (polled && polled.left.side === "D" && polled.right.side === right.side) {
      const pollError = Math.hypot(config.districtPollBias, polled.samplingError);
      const priorPrecision = 1 / config.districtError ** 2;
      const pollPrecision = 1 / pollError ** 2;
      margin = (prior * priorPrecision + polled.margin * pollPrecision) / (priorPrecision + pollPrecision);
      error = Math.sqrt(1 / (priorPrecision + pollPrecision));
      Object.assign(base, { pollMargin: polled.margin, pollCount: polled.pollCount });
    }

    return { ...base, left: { side: "D" }, right, nationalSign: right.side === "R" ? 1 : 0, prior, margin, error };
  });
}

function simulateChamber(races, fixedSeats, seed) {
  const random = seededRandom(seed);
  const normal = normalSampler(random);
  const outcomes = [];
  const contested = races.filter((race) => !race.safe);
  const leftWins = new Array(contested.length).fill(0);
  const fixed = { D: fixedSeats.D || 0, R: fixedSeats.R || 0, I: fixedSeats.I || 0 };
  races.filter((race) => race.safe).forEach((race) => { fixed[race.safe] += 1; });

  for (let run = 0; run < ELECTION_CONFIG.simulations; run += 1) {
    const national = normal() * ELECTION_CONFIG.nationalError;
    const seats = { ...fixed };
    contested.forEach((race, index) => {
      const margin = race.margin + race.nationalSign * national + normal() * race.error;
      const winner = margin > 0 ? race.left : race.right;
      if (margin > 0) leftWins[index] += 1;
      seats[winner.side] += 1;
    });
    outcomes.push(seats);
  }

  contested.forEach((race, index) => { race.leftProbability = leftWins[index] / ELECTION_CONFIG.simulations; });
  return outcomes;
}

function summarizeOutcomes(outcomes, total, republicanControl) {
  const mean = (side) => outcomes.reduce((sum, seats) => sum + seats[side], 0) / outcomes.length;
  const quantile = (side, q) => {
    const sorted = outcomes.map((seats) => seats[side]).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };
  const D = Math.round(mean("D"));
  const I = Math.round(mean("I"));
  const histogram = new Map();
  outcomes.forEach((seats) => histogram.set(seats.R, (histogram.get(seats.R) || 0) + 1));

  return {
    projected: { D, I, R: total - D - I },
    republicanRange: [quantile("R", 0.1), quantile("R", 0.9)],
    republicanControl: outcomes.filter((seats) => seats.R >= republicanControl).length / outcomes.length,
    histogram
  };
}

function marginLabel(margin, left, right) {
  const leader = margin >= 0 ? left : right;
  return `${leader.side}+${Math.abs(margin).toFixed(1)}`;
}

function percentLabel(probability) {
  if (probability > 0.99) return ">99%";
  if (probability < 0.01) return "<1%";
  return `${Math.round(probability * 100)}%`;
}

function renderSeatBar(elementId, projected, total, majority, majorityLabel) {
  const segments = ["D", "I", "R"].filter((side) => projected[side] > 0).map((side) => (
    `<span class="seat-segment" style="flex:${projected[side]};background:${PARTY[side].color}" title="${PARTY[side].name}: ${projected[side]}"></span>`
  )).join("");
  const labels = ["D", "I", "R"].filter((side) => projected[side] > 0).map((side) => (
    `<span class="seat-label"><span class="market-dot" style="background:${PARTY[side].color}"></span>${PARTY[side].name} <strong>${projected[side]}</strong></span>`
  )).join("");
  const position = `${(majority / total) * 100}%`;
  document.getElementById(elementId).innerHTML = `
    <div class="seat-labels">${labels}</div>
    <div class="seat-track">${segments}<i class="seat-majority" style="left:${position}"></i></div>
    <p class="seat-majority-label"><span style="left:${position}">${majorityLabel}</span></p>`;
}

function majorityLine(threshold) {
  return {
    id: `majorityLine-${threshold}`,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const index = chart.data.labels.indexOf(threshold);
      if (index < 0) return;
      const x = scales.x.getPixelForValue(index) - (scales.x.getPixelForValue(1) - scales.x.getPixelForValue(0)) / 2;
      ctx.save();
      ctx.strokeStyle = "rgba(36, 48, 44, 0.55)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#24302c";
      ctx.font = `700 ${isMobile ? 9 : 10}px Inter, sans-serif`;
      ctx.textBaseline = "top";
      const label = `${threshold}+ Republican control`;
      const fitsRight = x + 6 + ctx.measureText(label).width <= chartArea.right;
      ctx.textAlign = fitsRight ? "left" : "right";
      ctx.fillText(label, fitsRight ? x + 6 : x - 6, chartArea.top + 2);
      ctx.restore();
    }
  };
}

function renderSeatHistogram(name, summary, threshold, total) {
  destroyChart(name);
  // Trim the extreme 0.2% tails so the bulk of the distribution fills the chart.
  const seatCounts = [...summary.histogram.keys()].sort((a, b) => a - b);
  const tail = ELECTION_CONFIG.simulations * 0.002;
  let cumulative = 0;
  const kept = seatCounts.filter((seats) => {
    const before = cumulative;
    cumulative += summary.histogram.get(seats);
    return cumulative > tail && before < ELECTION_CONFIG.simulations - tail;
  });
  const low = Math.min(kept[0], threshold - 1);
  const high = Math.max(kept.at(-1), threshold);
  const labels = [];
  for (let seats = low; seats <= high; seats += 1) labels.push(seats);
  const share = labels.map((seats) => (summary.histogram.get(seats) || 0) / ELECTION_CONFIG.simulations * 100);

  charts[name] = new Chart(document.getElementById(`${name}Chart`), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Share of simulations",
        data: share,
        backgroundColor: labels.map((seats) => seats >= threshold ? PARTY.R.fill : PARTY.D.fill),
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: "bottom",
        barPercentage: 1,
        categoryPercentage: labels.length > 40 ? 0.9 : 0.86
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 6, right: 8 } },
      scales: {
        x: {
          title: { display: true, text: "Republican seats" },
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkipPadding: 10 }
        },
        y: {
          beginAtZero: true,
          ticks: { callback: (value) => `${value}%`, maxTicksLimit: 5 },
          grid: { color: "rgba(84, 92, 87, 0.13)" }
        }
      },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "start",
          labels: {
            generateLabels: () => [
              { text: "Democratic control", fillStyle: PARTY.D.color, strokeStyle: PARTY.D.color, pointStyle: "rectRounded" },
              { text: "Republican control", fillStyle: PARTY.R.color, strokeStyle: PARTY.R.color, pointStyle: "rectRounded" }
            ]
          }
        },
        tooltip: {
          callbacks: {
            title: (items) => `Republicans ${items[0].label} · others ${total - Number(items[0].label)}`,
            label: (context) => `${context.parsed.y.toFixed(1)}% of simulations`
          }
        }
      }
    },
    plugins: [majorityLine(threshold)]
  });
}

function controlText(probability) {
  return probability >= 0.5
    ? { value: percentLabel(probability), detail: "Chance of Republican control", side: "R" }
    : { value: percentLabel(1 - probability), detail: "Chance of Democratic control", side: "D" };
}

function renderControlMetric(prefix, probability) {
  const control = controlText(probability);
  const value = document.getElementById(`${prefix}Control`);
  value.textContent = control.value;
  value.style.color = PARTY[control.side].color;
  document.getElementById(`${prefix}ControlDetail`).textContent = control.detail;
}

function candidateName(candidate) {
  return candidate.name ? `${candidate.name} (${candidate.side})` : candidate.side;
}

function renderSenate(questions) {
  const races = buildSenateRaces(questions);
  const outcomes = simulateChamber(races, ELECTION_CONFIG.senateHoldover, ELECTION_CONFIG.seed);
  const summary = summarizeOutcomes(outcomes, 100, ELECTION_CONFIG.senateRepublicanControl);

  renderControlMetric("senate", summary.republicanControl);
  renderSeatBar("senateSeats", summary.projected, 100, 50, "50 + vice president’s tiebreak");
  renderSeatHistogram("senate", summary, ELECTION_CONFIG.senateRepublicanControl, 100);
  document.getElementById("senateRange").textContent = `${summary.republicanRange[0]}–${summary.republicanRange[1]}`;

  const rows = races.slice().sort((a, b) => (a.safe ? 1 : 0) - (b.safe ? 1 : 0) || Math.abs(a.margin) - Math.abs(b.margin));
  document.getElementById("senateTable").innerHTML = tableMarkup(
    ["State", "Matchup", "Polling average", "Polls", "Win probability"],
    rows.map((race) => race.safe
      ? [race.label, race.note, "—", "0", `${PARTY[race.safe].short} assumed`]
      : [
        race.label,
        `${candidateName(race.left)} vs. ${candidateName(race.right)}`,
        marginLabel(race.margin, race.left, race.right),
        String(race.pollCount),
        race.leftProbability >= 0.5
          ? `${race.left.side} ${percentLabel(race.leftProbability)}`
          : `${race.right.side} ${percentLabel(1 - race.leftProbability)}`
      ])
  );
}

function renderHouse(questions, districts) {
  const generic = genericBallot(questions.filter((question) => question.race === "US"));
  const races = buildHouseRaces(districts, questions.filter((question) => question.race !== "US"), generic);
  const outcomes = simulateChamber(races, {}, ELECTION_CONFIG.seed + 1);
  const summary = summarizeOutcomes(outcomes, 435, ELECTION_CONFIG.houseMajority);

  renderControlMetric("house", summary.republicanControl);
  renderSeatBar("houseSeats", summary.projected, 435, ELECTION_CONFIG.houseMajority, `${ELECTION_CONFIG.houseMajority} for majority`);
  renderSeatHistogram("house", summary, ELECTION_CONFIG.houseMajority, 435);
  document.getElementById("houseRange").textContent = `${summary.republicanRange[0]}–${summary.republicanRange[1]}`;
  document.getElementById("genericBallot").textContent = `${generic.margin >= 0 ? "D" : "R"}+${Math.abs(generic.margin).toFixed(1)}`;

  const competitive = races
    .filter((race) => !race.safe && race.leftProbability > 0.05 && race.leftProbability < 0.95)
    .sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin));
  document.getElementById("houseCompetitive").textContent = String(competitive.length);
  document.getElementById("houseTable").innerHTML = tableMarkup(
    ["District", "PVI", "Incumbent", "District polls", "Projected margin", "Win probability"],
    competitive.map((race) => [
      race.label,
      race.pvi === 0 ? "EVEN" : `${race.pvi > 0 ? "D" : "R"}+${Math.abs(race.pvi)}`,
      race.incumbent || "Open",
      race.pollCount ? `${marginLabel(race.pollMargin, race.left, race.right)} (${race.pollCount})` : "—",
      marginLabel(race.margin, race.left, race.right),
      race.leftProbability >= 0.5
        ? `D ${percentLabel(race.leftProbability)}`
        : `${race.right.side} ${percentLabel(1 - race.leftProbability)}`
    ])
  );
}

async function fetchCSV(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return parseCSV(await response.text());
}

async function loadElection() {
  const [senateRows, houseRows, districts] = await Promise.all([
    fetchCSV(SENATE_PATH),
    fetchCSV(HOUSE_PATH),
    fetchCSV(DISTRICTS_PATH)
  ]);
  const senateQuestions = groupQuestions(senateRows);
  const houseQuestions = groupQuestions(houseRows);
  renderSenate(senateQuestions);
  renderHouse(houseQuestions, districts);
  return Math.max(latestPollTime(senateQuestions), latestPollTime(houseQuestions));
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
  const [pollingResult, electionResult, economicResult] = await Promise.allSettled([loadPolling(), loadElection(), loadEconomic()]);

  if (pollingResult.status === "rejected") {
    console.error(pollingResult.reason);
    showError("Polling data could not be loaded. Run the site through a local web server and refresh the data cache.");
  }
  if (electionResult.status === "rejected") {
    console.error(electionResult.reason);
    showError("Senate and House polling could not be loaded. Run ./update-data.sh, then reload the page.");
  }
  if (economicResult.status === "rejected") {
    console.error(economicResult.reason);
    showError("Economic data could not be loaded. Run ./update-data.sh, then reload the page.");
  }

  const dates = [
    pollingResult.status === "fulfilled" ? pollingResult.value?.getTime() : null,
    electionResult.status === "fulfilled" ? electionResult.value : null,
    economicResult.status === "fulfilled" ? economicResult.value : null
  ].filter(Number.isFinite);
  const freshness = document.getElementById("freshness");
  freshness.textContent = dates.length
    ? `Latest source observation: ${formatDate(new Date(Math.max(...dates)), { month: "long", day: "numeric", year: "numeric" })}`
    : "Data unavailable";
}

init();
