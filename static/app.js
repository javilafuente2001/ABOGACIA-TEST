const STORE_EXAM = "lexTest.exam.v2";
const STORE_WRONG = "lexTest.wrong.v2";
const STORE_LAST = "lexTest.lastResult.v2";

const $ = (id) => document.getElementById(id);

let examData = null;
let session = null;
let timerHandle = null;

const screens = {
  config: $("screenConfig"),
  test: $("screenTest"),
  results: $("screenResults"),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove("active"));
  screens[name].classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setMessage(text, type = "", el = $("importMessage")) {
  el.textContent = text;
  el.className = `message ${type}`.trim();
  el.classList.remove("hidden");
}

function hideMessage(el = $("importMessage")) {
  el.classList.add("hidden");
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60).toString().padStart(2, "0");
  const s = (safe % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function areaLabel(area) {
  if (area === "administrativo") return "Administrativo y contencioso-administrativo";
  if (area === "general") return "Materias comunes";
  return area || "Test";
}

function optionText(question, key) {
  if (!key) return "Sin responder";
  const opt = question.options.find((o) => o.key === key);
  return opt ? `${key.toUpperCase()}) ${opt.text}` : key.toUpperCase();
}

async function checkServer() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const el = $("serverStatus");
    el.classList.remove("bad", "warn", "ok");
    if (data.openai_configured) {
      el.textContent = "Servidor OK · IA activa";
      el.classList.add("ok");
    } else {
      el.textContent = "Servidor OK · IA pendiente";
      el.classList.add("warn");
    }
  } catch (err) {
    const el = $("serverStatus");
    el.textContent = "Servidor no disponible";
    el.classList.add("bad");
  }
}

function saveExam(data) {
  examData = data;
  localStorage.setItem(STORE_EXAM, JSON.stringify(data));
  renderLoadedExam();
}

function loadSavedExam() {
  const raw = localStorage.getItem(STORE_EXAM);
  if (!raw) return null;
  try {
    examData = JSON.parse(raw);
    renderLoadedExam();
    return examData;
  } catch {
    localStorage.removeItem(STORE_EXAM);
    return null;
  }
}

function renderLoadedExam() {
  const name = $("loadedExamName");
  const chips = $("loadedChips");
  if (!examData || !Array.isArray(examData.questions)) {
    name.textContent = "Todavía no hay preguntas cargadas.";
    chips.innerHTML = "";
    $("metricGeneral").textContent = "0";
    $("metricAdmin").textContent = "0";
    $("metricReview").textContent = "0";
    return;
  }

  const stats = examData.stats || {};
  const by = stats.by_area || {};
  const general = by.general || 0;
  const admin = by.administrativo || 0;
  const review = stats.needs_review || 0;

  name.textContent = `${examData.exam_name || "Examen importado"} · ${stats.total || examData.questions.length} preguntas`;
  $("metricGeneral").textContent = general;
  $("metricAdmin").textContent = admin;
  $("metricReview").textContent = review;

  chips.innerHTML = [
    `Generales: ${general}`,
    `General reserva: ${by.general_reserva || 0}`,
    `Administrativo: ${admin}`,
    `Admin reserva: ${by.administrativo_reserva || 0}`,
    `Revisar manualmente: ${review}`,
  ].map((t) => `<span class="chip">${t}</span>`).join("");
}

async function importFile() {
  const input = $("fileInput");
  const file = input.files?.[0];
  if (!file) {
    setMessage("Selecciona primero un PDF, Excel o JSON.", "error");
    return;
  }

  hideMessage();
  setMessage("Analizando archivo...", "");
  $("btnImport").disabled = true;

  try {
    let data;
    const lower = file.name.toLowerCase();

    if (lower.endsWith(".json")) {
      data = JSON.parse(await file.text());
      if (!Array.isArray(data.questions)) throw new Error("El JSON debe tener una propiedad questions.");
    } else {
      const form = new FormData();
      form.append("file", file);
      const url = lower.endsWith(".pdf") ? "/api/import/pdf" : "/api/import/excel";
      const res = await fetch(url, { method: "POST", body: form });
      data = await res.json();
      if (!res.ok) throw new Error(data.detail || "No se pudo importar el archivo.");
    }

    saveExam(data);
    setMessage(`Importado correctamente: ${data.stats?.total || data.questions.length} preguntas.`, "success");
  } catch (err) {
    setMessage(err.message || "Error al analizar el archivo.", "error");
  } finally {
    $("btnImport").disabled = false;
  }
}

function getQuestionBank() {
  const mode = $("modeSelect").value;
  const includeReserve = $("includeReserve").checked;

  if (mode === "falladas") {
    const raw = localStorage.getItem(STORE_WRONG);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  if (!examData || !Array.isArray(examData.questions)) return [];
  return examData.questions.filter((q) => {
    if (q.needs_review || !q.correct) return false;
    if (!includeReserve && q.reserve) return false;
    if (mode === "general") return q.area === "general";
    if (mode === "administrativo") return q.area === "administrativo";
    if (mode === "mixto") return ["general", "administrativo"].includes(q.area);
    return true;
  });
}

function defaultMinutes(mode) {
  if (mode === "general") return 120;
  if (mode === "administrativo") return 60;
  if (mode === "mixto") return 180;
  return 30;
}

function startTest(fromWrong = false) {
  let bank = getQuestionBank();
  if (!bank.length) {
    setMessage("No hay preguntas disponibles para esa configuración. Carga un PDF o cambia el bloque.", "error");
    return;
  }

  const shuffle = $("shuffleQuestions").checked;
  const limit = parseInt($("limitInput").value, 10);
  if (shuffle) bank = shuffleArray(bank);
  if (Number.isFinite(limit) && limit > 0) bank = bank.slice(0, limit);

  const questions = bank.map((q) => ({
    ...q,
    options: shuffle ? shuffleArray(q.options) : [...q.options],
  }));

  const mode = $("modeSelect").value;
  const customMinutes = parseInt($("timeInput").value, 10);
  const minutes = Number.isFinite(customMinutes) && customMinutes > 0 ? customMinutes : defaultMinutes(mode);

  session = {
    startedAt: Date.now(),
    secondsTotal: minutes * 60,
    secondsLeft: minutes * 60,
    index: 0,
    questions,
    answers: {},
    finished: false,
    mode,
  };

  showScreen("test");
  renderQuestion();
  startTimer();
}

function startTimer() {
  clearInterval(timerHandle);
  $("timerText").textContent = formatTime(session.secondsLeft);
  timerHandle = setInterval(() => {
    if (!session || session.finished) return;
    session.secondsLeft -= 1;
    $("timerText").textContent = formatTime(session.secondsLeft);
    if (session.secondsLeft <= 0) finishTest();
  }, 1000);
}

function renderQuestion() {
  if (!session) return;
  const q = session.questions[session.index];
  const total = session.questions.length;
  const current = session.index + 1;
  const selected = session.answers[q.id];

  $("questionWarning").classList.add("hidden");
  $("currentNumber").textContent = current;
  $("totalNumber").textContent = total;
  $("answeredCount").textContent = Object.keys(session.answers).length;
  $("questionArea").textContent = areaLabel(q.area) + (q.reserve ? " · reserva" : "");
  $("questionText").textContent = q.question;
  $("progressPercent").textContent = `${Math.round((current / total) * 100)}%`;
  $("progressFill").style.width = `${(current / total) * 100}%`;
  $("btnPrev").disabled = session.index === 0;
  $("btnNext").textContent = session.index === total - 1 ? "Finalizar y corregir" : "Siguiente pregunta →";

  $("optionsList").innerHTML = q.options.map((opt) => `
    <button class="option-card ${selected === opt.key ? "selected" : ""}" type="button" data-key="${opt.key}">
      <span class="option-letter">${opt.key}</span>
      <span class="option-text">${escapeHtml(opt.text)}</span>
    </button>
  `).join("");

  document.querySelectorAll(".option-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      session.answers[q.id] = btn.dataset.key;
      renderQuestion();
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function nextQuestion() {
  const q = session.questions[session.index];
  if (!session.answers[q.id]) {
    $("questionWarning").classList.remove("hidden");
    return;
  }
  if (session.index === session.questions.length - 1) {
    finishTest();
  } else {
    session.index += 1;
    renderQuestion();
  }
}

function prevQuestion() {
  if (!session || session.index === 0) return;
  session.index -= 1;
  renderQuestion();
}

function finishTest() {
  if (!session || session.finished) return;
  session.finished = true;
  clearInterval(timerHandle);

  const results = session.questions.map((q, idx) => {
    const selected = session.answers[q.id] || null;
    const ok = selected === q.correct;
    const blank = !selected;
    return { idx: idx + 1, question: q, selected, correct: q.correct, ok, blank };
  });

  const okCount = results.filter((r) => r.ok).length;
  const blankCount = results.filter((r) => r.blank).length;
  const koCount = results.length - okCount - blankCount;
  const percent = results.length ? Math.round((okCount / results.length) * 100) : 0;

  const wrongQuestions = results.filter((r) => !r.ok).map((r) => r.question);
  localStorage.setItem(STORE_WRONG, JSON.stringify(wrongQuestions));

  const summary = {
    finishedAt: new Date().toISOString(),
    examName: examData?.exam_name || "Test",
    mode: session.mode,
    total: results.length,
    ok: okCount,
    ko: koCount,
    blank: blankCount,
    percent,
    results,
  };
  localStorage.setItem(STORE_LAST, JSON.stringify(summary));
  renderResults(summary);
  showScreen("results");
}

function renderResults(summary) {
  $("resultSubtitle").textContent = `${summary.examName} · ${summary.total} preguntas`;
  $("scoreOk").textContent = summary.ok;
  $("scoreKo").textContent = summary.ko;
  $("scoreBlank").textContent = summary.blank;
  $("scorePercent").textContent = `${summary.percent}%`;
  $("btnRetryWrong").disabled = summary.ko + summary.blank === 0;

  const review = $("reviewList");
  review.innerHTML = summary.results.map((r) => {
    const state = r.ok ? "ok" : r.blank ? "blank" : "ko";
    const label = r.ok ? "Correcta" : r.blank ? "Sin responder" : "Fallada";
    const explainButton = r.ok ? "" : `<button class="btn ghost explain-btn" type="button" data-id="${r.question.id}">Explicar con IA</button>`;
    return `
      <article class="review-item ${state}" id="review-${r.question.id}">
        <div class="review-title">${r.idx}. ${escapeHtml(r.question.question)}</div>
        <div class="review-meta">
          <div>Estado: <strong>${label}</strong></div>
          <div>Marcada: <strong>${escapeHtml(optionText(r.question, r.selected))}</strong></div>
          <div>Correcta: <strong>${escapeHtml(optionText(r.question, r.correct))}</strong></div>
        </div>
        <div class="file-actions">${explainButton}</div>
        <div class="explain-box hidden"></div>
      </article>
    `;
  }).join("");

  document.querySelectorAll(".explain-btn").forEach((btn) => {
    btn.addEventListener("click", () => explainQuestion(btn.dataset.id, summary));
  });
}

async function explainQuestion(questionId, summary) {
  const result = summary.results.find((r) => r.question.id === questionId);
  if (!result) return;
  const card = $(`review-${questionId}`);
  const box = card.querySelector(".explain-box");
  const btn = card.querySelector(".explain-btn");
  box.textContent = "Generando explicación...";
  box.classList.remove("hidden");
  btn.disabled = true;

  try {
    const res = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: result.question.question,
        options: result.question.options,
        selected: result.selected,
        correct: result.correct,
        area: result.question.area,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "No se pudo generar la explicación.");
    box.textContent = data.explanation;
  } catch (err) {
    box.textContent = err.message || "Error al generar la explicación.";
  } finally {
    btn.disabled = false;
  }
}

function clearAll() {
  if (!confirm("¿Borrar los datos importados y resultados guardados?")) return;
  localStorage.removeItem(STORE_EXAM);
  localStorage.removeItem(STORE_WRONG);
  localStorage.removeItem(STORE_LAST);
  examData = null;
  renderLoadedExam();
  setMessage("Datos borrados.", "success");
}

function setupDragDrop() {
  const dz = $("dropzone");
  const input = $("fileInput");
  ["dragenter", "dragover"].forEach((eventName) => dz.addEventListener(eventName, (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach((eventName) => dz.addEventListener(eventName, (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
  }));
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer.files?.length) {
      input.files = e.dataTransfer.files;
      setMessage(`Archivo seleccionado: ${input.files[0].name}`);
    }
  });
  input.addEventListener("change", () => {
    if (input.files?.[0]) setMessage(`Archivo seleccionado: ${input.files[0].name}`);
  });
}

function bindEvents() {
  $("btnImport").addEventListener("click", importFile);
  $("btnLoadSaved").addEventListener("click", () => {
    if (loadSavedExam()) setMessage("Último examen cargado desde el navegador.", "success");
    else setMessage("No hay ningún examen guardado todavía.", "error");
  });
  $("btnClear").addEventListener("click", clearAll);
  $("btnStart").addEventListener("click", () => startTest());
  $("btnNext").addEventListener("click", nextQuestion);
  $("btnPrev").addEventListener("click", prevQuestion);
  $("btnExitTest").addEventListener("click", () => {
    if (confirm("¿Salir del test actual? Se perderá el progreso.")) {
      clearInterval(timerHandle);
      session = null;
      showScreen("config");
    }
  });
  $("btnBackConfig").addEventListener("click", () => showScreen("config"));
  $("btnNewTest").addEventListener("click", () => showScreen("config"));
  $("btnRetryWrong").addEventListener("click", () => {
    $("modeSelect").value = "falladas";
    showScreen("config");
  });
  $("modeSelect").addEventListener("change", () => {
    const value = $("modeSelect").value;
    $("timeInput").placeholder = value === "general" ? "120" : value === "administrativo" ? "60" : value === "mixto" ? "180" : "30";
  });
}

function init() {
  bindEvents();
  setupDragDrop();
  loadSavedExam();
  renderLoadedExam();
  checkServer();
}

document.addEventListener("DOMContentLoaded", init);
