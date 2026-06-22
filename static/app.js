const STORE_LIBRARY = "lexTest.library.v3";
const STORE_SELECTED = "lexTest.selectedExam.v3";
const STORE_WRONG = "lexTest.wrongBank.v3";
const STORE_LAST = "lexTest.lastResult.v3";
const LEGACY_EXAM = "lexTest.exam.v2";

const $ = (id) => document.getElementById(id);

let library = [];
let selectedExamId = null;
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

function uid(prefix = "id") {
  if (window.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function checkServer() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const el = $("serverStatus");
    el.classList.remove("bad", "warn", "ok");
    if (data.ai_configured || data.openai_configured) {
      const provider = data.ai_provider === "gemini" ? "Gemini" : data.ai_provider === "openai" ? "OpenAI" : "IA";
      el.textContent = `Servidor OK · IA activa (${provider})`;
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

function readJson(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function computeStats(questions) {
  const valid = Array.isArray(questions) ? questions : [];
  const by_area = {
    general: valid.filter((q) => q.area === "general" && !q.reserve).length,
    general_reserva: valid.filter((q) => q.area === "general" && q.reserve).length,
    administrativo: valid.filter((q) => q.area === "administrativo" && !q.reserve).length,
    administrativo_reserva: valid.filter((q) => q.area === "administrativo" && q.reserve).length,
  };
  return {
    total: valid.length,
    by_area,
    needs_review: valid.filter((q) => q.needs_review || !q.correct).length,
  };
}

function normalizeExamForStorage(data, fileName = "") {
  if (!data || !Array.isArray(data.questions)) {
    throw new Error("El archivo importado no tiene preguntas válidas.");
  }

  const examId = uid("exam");
  const importedAt = new Date().toISOString();
  const examName = data.exam_name || fileName || "Examen importado";

  const questions = data.questions.map((q, index) => {
    const sourceId = q.id || `${q.area || "area"}-${q.number || index + 1}`;
    return {
      ...q,
      id: `${examId}-${sourceId}`,
      source_id: sourceId,
      exam_id: examId,
      exam_name: examName,
      number: q.number || index + 1,
      options: Array.isArray(q.options) ? q.options : [],
    };
  });

  return {
    ...data,
    exam_id: examId,
    exam_name: examName,
    imported_at: data.imported_at || importedAt,
    saved_at: importedAt,
    questions,
    stats: computeStats(questions),
  };
}

function loadLibrary() {
  library = readJson(STORE_LIBRARY, []);
  if (!Array.isArray(library)) library = [];

  // Migración suave desde la versión anterior, donde solo existía un único examen guardado.
  if (!library.length) {
    const legacy = readJson(LEGACY_EXAM, null);
    if (legacy?.questions?.length) {
      try {
        const migrated = normalizeExamForStorage(legacy, legacy.exam_name || "Examen migrado");
        library = [migrated];
        writeJson(STORE_LIBRARY, library);
        localStorage.removeItem(LEGACY_EXAM);
      } catch {
        localStorage.removeItem(LEGACY_EXAM);
      }
    }
  }

  selectedExamId = localStorage.getItem(STORE_SELECTED);
  if (!selectedExamId || !library.some((exam) => exam.exam_id === selectedExamId)) {
    selectedExamId = library[0]?.exam_id || null;
    if (selectedExamId) localStorage.setItem(STORE_SELECTED, selectedExamId);
  }
}

function saveLibrary() {
  writeJson(STORE_LIBRARY, library);
  if (selectedExamId) localStorage.setItem(STORE_SELECTED, selectedExamId);
  else localStorage.removeItem(STORE_SELECTED);
  renderLibrary();
}

function getSelectedExam() {
  return library.find((exam) => exam.exam_id === selectedExamId) || null;
}

function getWrongBank() {
  const wrong = readJson(STORE_WRONG, []);
  return Array.isArray(wrong) ? wrong : [];
}

function saveWrongBank(items) {
  writeJson(STORE_WRONG, items);
}

function validQuestion(q, includeReserve) {
  if (!q || q.needs_review || !q.correct) return false;
  if (!includeReserve && q.reserve) return false;
  if (!Array.isArray(q.options) || q.options.length < 2) return false;
  return true;
}

function countAllQuestions(area) {
  return library.flatMap((exam) => exam.questions || []).filter((q) => q.area === area && !q.reserve && !q.needs_review && q.correct).length;
}

function renderLibrary() {
  const selectedExam = getSelectedExam();
  const allGeneral = countAllQuestions("general");
  const allAdmin = countAllQuestions("administrativo");
  const wrongCount = getWrongBank().length;

  $("metricExams").textContent = library.length;
  $("metricGeneral").textContent = allGeneral;
  $("metricAdmin").textContent = allAdmin;
  $("metricWrong").textContent = wrongCount;

  const list = $("libraryList");
  const empty = $("libraryEmpty");
  empty.classList.toggle("hidden", library.length > 0);

  if (!library.length) {
    list.innerHTML = "";
    $("loadedExamName").textContent = "Ninguno seleccionado.";
    $("loadedChips").innerHTML = "";
    return;
  }

  list.innerHTML = library.map((exam) => {
    const stats = exam.stats || computeStats(exam.questions || []);
    const by = stats.by_area || {};
    const selected = exam.exam_id === selectedExamId;
    return `
      <article class="exam-tile ${selected ? "selected" : ""}" data-exam-id="${escapeHtml(exam.exam_id)}">
        <div class="exam-tile-top">
          <div>
            <h3>${escapeHtml(exam.exam_name || "Examen")}</h3>
            <p>${formatDate(exam.saved_at || exam.imported_at) || "Guardado"}</p>
          </div>
          <span class="exam-badge">${stats.total || (exam.questions || []).length} preg.</span>
        </div>
        <div class="exam-tile-stats">
          <span>General: <b>${by.general || 0}</b></span>
          <span>Admin: <b>${by.administrativo || 0}</b></span>
          <span>Reserva: <b>${(by.general_reserva || 0) + (by.administrativo_reserva || 0)}</b></span>
          <span>Revisar: <b>${stats.needs_review || 0}</b></span>
        </div>
        <div class="exam-tile-actions">
          <button class="btn ${selected ? "primary" : "ghost"} select-exam" type="button" data-exam-id="${escapeHtml(exam.exam_id)}">
            ${selected ? "Seleccionado" : "Elegir examen"}
          </button>
          <button class="btn danger-ghost delete-exam" type="button" data-exam-id="${escapeHtml(exam.exam_id)}">Borrar</button>
        </div>
      </article>
    `;
  }).join("");

  if (selectedExam) {
    const stats = selectedExam.stats || computeStats(selectedExam.questions || []);
    const by = stats.by_area || {};
    $("loadedExamName").textContent = selectedExam.exam_name || "Examen seleccionado";
    $("loadedChips").innerHTML = [
      `General: ${by.general || 0}`,
      `Admin: ${by.administrativo || 0}`,
      `Reservas: ${(by.general_reserva || 0) + (by.administrativo_reserva || 0)}`,
      `Revisar: ${stats.needs_review || 0}`,
    ].map((t) => `<span class="chip">${t}</span>`).join("");
  }
}

async function importFile() {
  const input = $("fileInput");
  const file = input.files?.[0];
  if (!file) {
    setMessage("Selecciona primero un PDF, Excel o JSON.", "error");
    return;
  }

  hideMessage();
  setMessage("Analizando archivo y guardándolo en biblioteca...", "");
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

    const storedExam = normalizeExamForStorage(data, file.name);
    library.unshift(storedExam);
    selectedExamId = storedExam.exam_id;
    saveLibrary();
    setMessage(`Guardado correctamente: ${storedExam.exam_name} · ${storedExam.stats.total} preguntas.`, "success");
  } catch (err) {
    setMessage(err.message || "Error al analizar el archivo.", "error");
  } finally {
    $("btnImport").disabled = false;
  }
}

function getQuestionBank() {
  const mode = $("modeSelect").value;
  const includeReserve = $("includeReserve").checked;

  if (mode.startsWith("wrong_")) {
    const wrong = getWrongBank().filter((q) => validQuestion(q, includeReserve));
    if (mode === "wrong_general") return wrong.filter((q) => q.area === "general");
    if (mode === "wrong_administrativo") return wrong.filter((q) => q.area === "administrativo");
    return wrong;
  }

  let base = [];
  if (mode.startsWith("all_")) {
    base = library.flatMap((exam) => exam.questions || []);
  } else {
    const selectedExam = getSelectedExam();
    base = selectedExam?.questions || [];
  }

  base = base.filter((q) => validQuestion(q, includeReserve));

  if (mode === "general" || mode === "all_general") return base.filter((q) => q.area === "general");
  if (mode === "administrativo" || mode === "all_administrativo") return base.filter((q) => q.area === "administrativo");
  if (mode === "mixto" || mode === "all_mixto") return base.filter((q) => ["general", "administrativo"].includes(q.area));
  return base;
}

function defaultMinutes(mode) {
  if (mode === "general" || mode === "all_general") return 120;
  if (mode === "administrativo" || mode === "all_administrativo") return 60;
  if (mode === "mixto" || mode === "all_mixto") return 180;
  return 30;
}

function modeLabel(mode) {
  const labels = {
    general: "General · examen seleccionado",
    administrativo: "Administrativo · examen seleccionado",
    mixto: "General + administrativo · examen seleccionado",
    all_general: "Aleatorio general · todos los exámenes",
    all_administrativo: "Aleatorio administrativo · todos los exámenes",
    all_mixto: "Aleatorio mixto · todos los exámenes",
    wrong_all: "Falladas · todas",
    wrong_general: "Falladas · general",
    wrong_administrativo: "Falladas · administrativo",
  };
  return labels[mode] || "Test";
}

function startTest() {
  const mode = $("modeSelect").value;
  let bank = getQuestionBank();
  if (!bank.length) {
    const msg = mode.startsWith("wrong_")
      ? "No hay falladas guardadas para esa configuración."
      : "No hay preguntas disponibles para esa configuración. Carga un PDF, elige otro examen o cambia el bloque.";
    setMessage(msg, "error");
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

  const customMinutes = parseInt($("timeInput").value, 10);
  const minutes = Number.isFinite(customMinutes) && customMinutes > 0 ? customMinutes : defaultMinutes(mode);
  const selectedExam = getSelectedExam();
  const examName = mode.startsWith("all_")
    ? "Todos los exámenes"
    : mode.startsWith("wrong_")
      ? "Banco de falladas"
      : selectedExam?.exam_name || "Test";

  session = {
    startedAt: Date.now(),
    secondsTotal: minutes * 60,
    secondsLeft: minutes * 60,
    index: 0,
    questions,
    answers: {},
    finished: false,
    mode,
    examName,
    modeName: modeLabel(mode),
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
  $("questionArea").textContent = `${areaLabel(q.area)}${q.reserve ? " · reserva" : ""}${q.exam_name ? ` · ${q.exam_name}` : ""}`;
  $("questionText").textContent = q.question;
  $("progressPercent").textContent = `${Math.round((current / total) * 100)}%`;
  $("progressFill").style.width = `${(current / total) * 100}%`;
  $("btnPrev").disabled = session.index === 0;
  $("btnNext").textContent = session.index === total - 1 ? "Finalizar y corregir" : "Siguiente pregunta →";

  $("optionsList").innerHTML = q.options.map((opt) => `
    <button class="option-card ${selected === opt.key ? "selected" : ""}" type="button" data-key="${escapeHtml(opt.key)}">
      <span class="option-letter">${escapeHtml(opt.key)}</span>
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

function nextQuestion() {
  if (!session) return;
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

function updateWrongBank(results) {
  const wrongMap = new Map(getWrongBank().map((q) => [q.id, q]));
  results.forEach((r) => {
    const existing = wrongMap.get(r.question.id);
    if (r.ok) {
      // Si ya estaba en falladas y ahora se acierta, se limpia del banco.
      if (existing) wrongMap.delete(r.question.id);
      return;
    }
    wrongMap.set(r.question.id, {
      ...r.question,
      last_selected: r.selected,
      last_wrong_at: new Date().toISOString(),
      wrong_attempts: (existing?.wrong_attempts || 0) + 1,
    });
  });
  const items = Array.from(wrongMap.values()).sort((a, b) => String(b.last_wrong_at || "").localeCompare(String(a.last_wrong_at || "")));
  saveWrongBank(items);
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

  updateWrongBank(results);

  const summary = {
    finishedAt: new Date().toISOString(),
    examName: session.examName || "Test",
    mode: session.mode,
    modeName: session.modeName,
    total: results.length,
    ok: okCount,
    ko: koCount,
    blank: blankCount,
    percent,
    results,
  };
  localStorage.setItem(STORE_LAST, JSON.stringify(summary));
  renderResults(summary);
  renderLibrary();
  showScreen("results");
}

function renderResults(summary) {
  $("resultSubtitle").textContent = `${summary.examName} · ${summary.modeName || "Test"} · ${summary.total} preguntas`;
  $("scoreOk").textContent = summary.ok;
  $("scoreKo").textContent = summary.ko;
  $("scoreBlank").textContent = summary.blank;
  $("scorePercent").textContent = `${summary.percent}%`;
  $("btnRetryWrong").disabled = getWrongBank().length === 0;

  const review = $("reviewList");
  review.innerHTML = summary.results.map((r) => {
    const state = r.ok ? "ok" : r.blank ? "blank" : "ko";
    const label = r.ok ? "Correcta" : r.blank ? "Sin responder" : "Fallada";
    const explainButton = r.ok ? "" : `<button class="btn ghost explain-btn" type="button" data-id="${escapeHtml(r.question.id)}">Explicar con IA</button>`;
    return `
      <article class="review-item ${state}" id="review-${escapeHtml(r.question.id)}">
        <div class="review-title">${r.idx}. ${escapeHtml(r.question.question)}</div>
        <div class="review-meta">
          <div>Examen: <strong>${escapeHtml(r.question.exam_name || summary.examName)}</strong></div>
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
  const card = $("review-" + questionId);
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
  if (!confirm("¿Borrar todos los exámenes guardados, falladas y resultados?")) return;
  localStorage.removeItem(STORE_LIBRARY);
  localStorage.removeItem(STORE_SELECTED);
  localStorage.removeItem(STORE_WRONG);
  localStorage.removeItem(STORE_LAST);
  localStorage.removeItem(LEGACY_EXAM);
  library = [];
  selectedExamId = null;
  renderLibrary();
  setMessage("Datos borrados.", "success");
}

function clearWrong() {
  if (!confirm("¿Borrar todas las preguntas falladas guardadas?")) return;
  localStorage.removeItem(STORE_WRONG);
  renderLibrary();
  setMessage("Banco de falladas borrado.", "success");
}

function deleteExam(examId) {
  const exam = library.find((item) => item.exam_id === examId);
  if (!exam) return;
  if (!confirm(`¿Borrar el examen "${exam.exam_name}"?`)) return;
  const questionIds = new Set((exam.questions || []).map((q) => q.id));
  library = library.filter((item) => item.exam_id !== examId);
  saveWrongBank(getWrongBank().filter((q) => !questionIds.has(q.id)));
  if (selectedExamId === examId) selectedExamId = library[0]?.exam_id || null;
  saveLibrary();
  setMessage("Examen borrado de la biblioteca.", "success");
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

function updateTimePlaceholder() {
  const value = $("modeSelect").value;
  $("timeInput").placeholder = String(defaultMinutes(value));
}

function bindEvents() {
  $("btnImport").addEventListener("click", importFile);
  $("btnLoadSaved").addEventListener("click", () => {
    loadLibrary();
    renderLibrary();
    setMessage("Biblioteca actualizada desde este navegador.", "success");
  });
  $("btnClear").addEventListener("click", clearAll);
  $("btnClearWrong").addEventListener("click", clearWrong);
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
    $("modeSelect").value = "wrong_all";
    updateTimePlaceholder();
    showScreen("config");
  });
  $("modeSelect").addEventListener("change", updateTimePlaceholder);
  $("libraryList").addEventListener("click", (event) => {
    const selectButton = event.target.closest(".select-exam");
    if (selectButton) {
      selectedExamId = selectButton.dataset.examId;
      saveLibrary();
      setMessage("Examen seleccionado.", "success");
      return;
    }
    const deleteButton = event.target.closest(".delete-exam");
    if (deleteButton) {
      deleteExam(deleteButton.dataset.examId);
    }
  });
}

function init() {
  bindEvents();
  setupDragDrop();
  loadLibrary();
  renderLibrary();
  updateTimePlaceholder();
  checkServer();
}

document.addEventListener("DOMContentLoaded", init);
