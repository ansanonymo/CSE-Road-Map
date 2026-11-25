/* CSE Study Desk: a static, no-build single page app.
 * One course list (BUET CSE + Oxford CS merged). Progress, notes and the
 * course selection are saved in localStorage. */
(function () {
  "use strict";

  var VERSIONS = {
    main: {
      name: "CSE Study Desk", short: "Desk",
      blurb: "BUET CSE and Oxford CS courses merged into one study plan.",
      file: "data/courses.js"
    }
  };
  var SETTINGS_KEY = "csedesk:settings";
  var STATE_PREFIX = "csedesk:v1:";

  /* ------------------------------------------------------------------ */
  /* Storage (safe wrapper; falls back to memory if storage is blocked)  */
  /* ------------------------------------------------------------------ */
  var memoryStore = {};
  var storageOk = true;
  function readKey(k) {
    try { return localStorage.getItem(k); } catch (e) { storageOk = false; return memoryStore[k] || null; }
  }
  function writeKey(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { storageOk = false; memoryStore[k] = v; }
  }
  function readJSON(k, def) {
    var raw = readKey(k);
    if (!raw) return def;
    try { return JSON.parse(raw); } catch (e) { return def; }
  }

  var settings = Object.assign({ version: "main", theme: "light", dailyGoal: 10, sound: true }, readJSON(SETTINGS_KEY, {}));
  if (!(settings.dailyGoal > 0)) settings.dailyGoal = 10;
  settings.version = "main";
  function saveSettings() { writeKey(SETTINGS_KEY, JSON.stringify(settings)); }

  function emptyState() { return { removed: [], done: {}, courseNotes: {}, taskNotes: {}, focusDays: {}, focusCourses: {}, focusLog: {}, badges: [], defaults: 3 }; }
  function loadState(v) {
    var s = readJSON(STATE_PREFIX + v, null);
    var base = emptyState();
    if (!s || typeof s !== "object") return base;
    base.removed = Array.isArray(s.removed) ? s.removed : [];
    base.done = s.done && typeof s.done === "object" ? s.done : {};
    base.courseNotes = s.courseNotes && typeof s.courseNotes === "object" ? s.courseNotes : {};
    base.taskNotes = s.taskNotes && typeof s.taskNotes === "object" ? s.taskNotes : {};
    base.focusDays = s.focusDays && typeof s.focusDays === "object" ? s.focusDays : {};
    base.focusCourses = s.focusCourses && typeof s.focusCourses === "object" ? s.focusCourses : {};
    base.focusLog = s.focusLog && typeof s.focusLog === "object" ? s.focusLog : {};
    base.defaults = s.defaults || 1;
    base.treeStage = typeof s.treeStage === "number" ? s.treeStage : null;
    base.badges = Array.isArray(s.badges) ? s.badges : null; // null = never checked (set silently on first load)
    return base;
  }
  var S = null;          // state of the active version
  var removedSet = null; // Set of removed course codes
  function saveState() {
    S.removed = Array.from(removedSet);
    writeKey(STATE_PREFIX + settings.version, JSON.stringify(S));
  }

  /* ------------------------------------------------------------------ */
  /* Data loading and indexing                                           */
  /* ------------------------------------------------------------------ */
  var D = null;  // active dataset
  var IDX = {};  // per version index
  function loadData(v) {
    return new Promise(function (resolve, reject) {
      window.ROADMAP_DATA = window.ROADMAP_DATA || {};
      if (window.ROADMAP_DATA[v]) return resolve(window.ROADMAP_DATA[v]);
      var s = document.createElement("script");
      s.src = VERSIONS[v].file;
      s.onload = function () { window.ROADMAP_DATA[v] ? resolve(window.ROADMAP_DATA[v]) : reject(new Error("empty")); };
      s.onerror = function () { reject(new Error("Could not load " + VERSIONS[v].file)); };
      document.head.appendChild(s);
    });
  }
  function buildIndex(data) {
    var parentOf = {}, byCode = {}, bySlug = {}, nodes = {}, leavesOf = {}, courseOfNode = {}, neededBy = {};
    data.courses.forEach(function (c) {
      byCode[c.code] = c;
      function walk(n) {
        nodes[n.id] = n;
        courseOfNode[n.id] = c.code;
        if (!n.children || !n.children.length) { leavesOf[n.id] = [n.id]; return [n.id]; }
        var acc = [];
        n.children.forEach(function (ch) { parentOf[ch.id] = n.id; acc = acc.concat(walk(ch)); });
        leavesOf[n.id] = acc;
        return acc;
      }
      var all = [];
      c.tasks.forEach(function (t) { all = all.concat(walk(t)); });
      c._leaves = all;
      c._slug = slugify(c.title);
      bySlug[c._slug] = c;
      if (data.task_based) c.estimated_hours = all.length; // step-based version: every step counts 1
      c._leafHours = all.length ? (c.estimated_hours || 0) / all.length : 0;
    });
    data.courses.forEach(function (c) {
      (c.depends_on || []).forEach(function (d) { (neededBy[d] = neededBy[d] || []).push(c.code); });
    });
    var tagCount = {};
    data.courses.forEach(function (c) { c.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; }); });
    return { parentOf: parentOf, byCode: byCode, bySlug: bySlug, nodes: nodes, leavesOf: leavesOf, courseOfNode: courseOfNode, neededBy: neededBy, tagCount: tagCount };
  }
  function X() { return IDX[settings.version]; }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function fmtInt(n) { return Math.round(n).toLocaleString("en-US"); }
  function TM() { return !!VERSIONS[settings.version].taskMode; }
  function fmtHours(h) {
    if (TM()) return fmtInt(h) + (Math.round(h) === 1 ? " step" : " steps");
    return h >= 100 ? fmtInt(h) + " h" : (Math.round(h * 10) / 10) + " h";
  }
  function approx(h) { return (TM() ? "" : "~") + fmtHours(h); }
  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function fmtDate(d) { return WEEKDAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear(); }
  function fmtWhen(ts) {
    var d = new Date(ts);
    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function slugify(t) { return String(t).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function findCourse(key) { return X().bySlug[key] || X().byCode[key] || null; }
  function courseHref(code) { var c = X().byCode[code]; return "#/course/" + (c ? c._slug : encodeURIComponent(code)); }
  function nameOf(code) { var c = X().byCode[code]; return c ? c.title : code; }
  function tagHref(tag) { return "#/courses?list=all&tag=" + encodeURIComponent(tag); }
  function plural(n, w, p) { return n + " " + (n === 1 ? w : (p || w + "s")); }
  function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  var ICONS = {
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    timer: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };

  /* ------------------------------------------------------------------ */
  /* Progress calculations                                               */
  /* ------------------------------------------------------------------ */
  function isSelected(code) { return !removedSet.has(code); }
  function selectedCourses() { return D.courses.filter(function (c) { return isSelected(c.code); }); }
  function doneCount(ids) { var n = 0; for (var i = 0; i < ids.length; i++) if (S.done[ids[i]]) n++; return n; }
  function courseProgress(c) {
    var d = doneCount(c._leaves), t = c._leaves.length;
    return { done: d, total: t, hoursDone: d * c._leafHours, hours: c.estimated_hours || 0, complete: t > 0 && d === t, started: d > 0 };
  }
  function statusOf(p) { return p.complete ? "done" : p.started ? "prog" : "todo"; }
  function statusLabel(p) { return p.complete ? "Done" : p.started ? "In progress" : "Not started"; }

  function dashboardStats() {
    var sel = selectedCourses();
    var s = { courses: sel.length, complete: 0, inProgress: 0, steps: 0, stepsDone: 0, hours: 0, hoursDone: 0, levels: {}, core: { h: 0, d: 0 }, opt: { h: 0, d: 0 } };
    sel.forEach(function (c) {
      var p = courseProgress(c);
      if (p.complete) s.complete++; else if (p.started) s.inProgress++;
      s.steps += p.total; s.stepsDone += p.done; s.hours += p.hours; s.hoursDone += p.hoursDone;
      var lv = c.cse_level || "Other";
      var L = s.levels[lv] = s.levels[lv] || { h: 0, d: 0, n: 0, c: 0 };
      L.h += p.hours; L.d += p.hoursDone; L.n++; if (p.complete) L.c++;
      var bucket = c.optional ? s.opt : s.core; bucket.h += p.hours; bucket.d += p.hoursDone;
    });
    return s;
  }
  function selFocusDays() { // focus minutes per day, selected courses only
    var out = {};
    Object.keys(S.focusLog || {}).forEach(function (k) {
      var day = S.focusLog[k], n = 0;
      Object.keys(day).forEach(function (code) { if (isSelected(code)) n += day[code]; });
      if (n) out[k] = n;
    });
    return out;
  }
  function activityByDay() {
    var byDay = {};
    selectedCourses().forEach(function (c) {
      c._leaves.forEach(function (id) { var ts = S.done[id]; if (ts) { var k = dayKey(ts); byDay[k] = (byDay[k] || 0) + 1; } });
    });
    return byDay;
  }
  function streaks(byDay) {
    var keys = Object.keys(byDay).sort();
    if (!keys.length) return { current: 0, longest: 0, first: null, days: 0 };
    var longest = 0, run = 0, prev = null;
    keys.forEach(function (k) {
      var d = new Date(k + "T12:00:00");
      if (prev && Math.round((d - prev) / 864e5) === 1) run++; else run = 1;
      if (run > longest) longest = run;
      prev = d;
    });
    var cur = 0, day = new Date(); day.setHours(12, 0, 0, 0);
    if (!byDay[dayKey(day)]) day.setDate(day.getDate() - 1);
    while (byDay[dayKey(day)]) { cur++; day.setDate(day.getDate() - 1); }
    return { current: cur, longest: longest, first: keys[0], days: keys.length };
  }
  function nextUp(limit) {
    var out = [];
    var sel = selectedCourses();
    for (var i = 0; i < sel.length && out.length < limit; i++) {
      var c = sel[i], p = courseProgress(c);
      if (p.complete) continue;
      var blockers = (c.depends_on || []).filter(function (d) {
        var dc = X().byCode[d];
        return dc && isSelected(d) && !courseProgress(dc).complete;
      });
      if (!blockers.length) out.push(c);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Tags: what they mean and why they are used                          */
  /* ------------------------------------------------------------------ */
  var AREA_TEXT = {
    programming: "Writing programs: structured, object-oriented and functional programming.",
    algorithms: "Designing and analysing algorithms and data structures.",
    theory: "Theory of computation: automata, computability, complexity, discrete structures.",
    logic: "Mathematical logic and its use in computing.",
    math: "Mathematics that computer science relies on.",
    hardware: "Digital logic, computer architecture, microprocessors.",
    systems: "Operating systems, compilers, distributed and parallel systems.",
    networks: "Computer networks and data communication.",
    data: "Databases and data management.",
    "ai-ml": "Artificial intelligence, machine learning, deep learning, NLP.",
    security: "Computer and network security, cryptography.",
    "software-eng": "Software engineering, design and development practice.",
    "programming-languages": "How programming languages are designed and implemented.",
    "graphics-vision": "Computer graphics, image processing and computer vision.",
    signals: "Signals and systems, digital signal processing.",
    mobile: "Mobile and embedded computing.",
    numerical: "Numerical methods and scientific computing.",
    optimization: "Mathematical and combinatorial optimisation.",
    quantum: "Quantum computing and quantum information.",
    bio: "Computational biology and bioinformatics.",
    hci: "Human-computer interaction.",
    "formal-methods": "Formal specification and verification of software and hardware.",
    professional: "Professional skills such as technical writing.",
    project: "Project and thesis work."
  };
  function tagInfo(tag) {
    var m;
    var LEVEL_WHY = "Every course gets exactly one level tag, so you can see how deep a course goes and plan basics first.";
    switch (tag) {
      case "CSE-BASIC": return { group: "Level", text: "Foundation every CS degree needs: intro programming, discrete maths, linear algebra, calculus, probability, data structures and algorithms, digital logic, architecture, operating systems, networks, databases, theory of computation, software engineering.", why: LEVEL_WHY };
      case "CSE-INTERMEDIATE": return { group: "Level", text: "Builds on the basics and is still general CS, usually core at one of the two universities: compilers, programming languages, concurrency, AI, signals, data communication, microprocessors, numerical methods, HCI, technical writing.", why: LEVEL_WHY };
      case "CSE-ADVANCE": return { group: "Level", text: "Specialised or elective topics that need the basics first: ML/DL/NLP/vision, security, cloud/HPC, quantum, blockchain, complexity, formal verification, advanced theory, projects and thesis.", why: LEVEL_WHY };
      case "cse": return { group: "Subject", text: "A computer science course (taught by the CS/CSE department).", why: "Non-CS courses (physics, chemistry, humanities, electrical engineering) were removed, so this tag marks what is left as real CS." };
      case "cse-related-math": return { group: "Subject", text: "A maths course kept because CS needs it (for example linear algebra, probability, calculus, optimisation, game theory).", why: "Maths from the maths department was kept only when later CS courses depend on it; this tag says why it is on a CS roadmap." };
      case "theory": return { group: "Kind", text: "A lecture course: concepts, proofs and problem solving.", why: "Lets you tell lecture courses from lab courses; BUET marks odd-numbered courses as theory." };
      case "practical": return { group: "Kind", text: "A lab or practical course (BUET 'sessional'), or a course with hands-on practicals.", why: "A practical comes right after its theory course in the study order so you do them side by side. Renamed from 'sessional' so both universities use the same word." };
      case "project": return { group: "Kind", text: "A project or thesis course.", why: "Projects take a different kind of work (planning, building, writing up), so they are marked." };
      case "optional": return { group: "Status", text: "An elective. Pick the ones you want; the rest are core.", why: "Oxford marks its own options. BUET does not, so for BUET this is a guess: its advanced specialist courses are treated as optional. For a merged course, it is optional only if every source course is optional." };
      case "compulsory": return { group: "Status", text: "A course Oxford requires (Preliminary Examinations and Part A core).", why: "Kept from Oxford's own marking so you can see what the degree requires." };
      case "likely-service-course": return { group: "Status", text: "A BUET course that looks like a version taught to other departments.", why: "These were left out so the same subject does not appear twice." };
    }
    if ((m = /^track-(.+)$/.exec(tag))) {
      var TR = { "core-cse": "Core computer science every CS graduate needs.", "ai-and-ml": "Artificial intelligence and machine learning.", "data-science": "Data science: analysing data and the maths behind it.", "cyber-security": "Cyber security: protecting systems and networks." };
      return { group: "Track", text: TR[m[1]] || "A study track.", why: "Your default selection is made of these four tracks; this tag says which one the course belongs to. Courses without a track tag are unselected by default." };
    }
    if ((m = /^area-(.+)$/.exec(tag))) {
      return { group: "Area", text: AREA_TEXT[m[1]] || ("Subject area: " + m[1].replace(/-/g, " ") + "."), why: "Area tags group courses by subject across both universities, so you can filter for one field. A course can have more than one." };
    }
    return { group: "Other", text: "Tag from the source data.", why: "" };
  }
  var TAG_GROUPS = ["Level", "Track", "Kind", "Status", "Subject", "Area", "Other"];
  var LEVEL_ORDER = ["CSE-BASIC", "CSE-INTERMEDIATE", "CSE-ADVANCE"];
  function tagChip(tag, extraClass) {
    var info = tagInfo(tag);
    return '<a class="chip' + (info.group === "Level" ? " level" : "") + (extraClass ? " " + extraClass : "") + '" href="' + tagHref(tag) +
      '" data-tip="' + esc(tag + ": " + info.text) + '">' + esc(tag) + "</a>";
  }
  function sortTags(tags) {
    return tags.slice().sort(function (a, b) {
      var ga = TAG_GROUPS.indexOf(tagInfo(a).group), gb = TAG_GROUPS.indexOf(tagInfo(b).group);
      if (ga === gb && ga === 0) return LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b);
      return ga - gb || a.localeCompare(b);
    });
  }

  /* ------------------------------------------------------------------ */
  /* UI state (not persisted except where noted)                         */
  /* ------------------------------------------------------------------ */
  var ui = {
    open: {},        // details open state, by node id
    noteOpen: {},    // task note editors open, by node id
    courses: { list: "selected", q: "", tags: [] },
    roadmap: { q: "", hideDone: false, track: "" }
  };

  /* ------------------------------------------------------------------ */
  /* Routing                                                             */
  /* ------------------------------------------------------------------ */
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var qi = h.indexOf("?"), path = qi >= 0 ? h.slice(0, qi) : h, query = {};
    if (qi >= 0) h.slice(qi + 1).split("&").forEach(function (p) {
      var kv = p.split("="); if (kv[0]) query[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || "").replace(/\+/g, " "));
    });
    if (path.indexOf("course/") === 0) return { view: "course", code: decodeURIComponent(path.slice(7)), query: query };
    if (path === "roadmap") path = "desk";
    var view = ["dashboard", "desk", "courses", "tags", "settings"].indexOf(path) >= 0 ? path : "dashboard";
    return { view: view, query: query };
  }
  var route = parseHash();
  function onRoute() {
    var prev = route;
    route = parseHash();
    if (route.view === "courses") {
      if (route.query.list) ui.courses.list = route.query.list;
      if (route.query.tag) { ui.courses.tags = [route.query.tag]; ui.courses.q = ""; }
    }
    render();
    if (prev.view !== route.view || prev.code !== route.code) window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", onRoute);
  // A link to the page you are already on (e.g. the same tag twice) does not fire hashchange.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#/"]');
    if (a && a.getAttribute("href") === location.hash && !e.defaultPrevented) { e.preventDefault(); ui.jumped = null; onRoute(); }
  });

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  var main = document.getElementById("main");
  function render() {
    hideTip();
    document.querySelectorAll("#nav a").forEach(function (a) {
      var v = a.getAttribute("data-view");
      a.classList.toggle("active", v === route.view || (route.view === "course" && v === "desk"));
    });
    if (!D) { main.innerHTML = '<p class="loading">Loading courses…</p>'; return; }
    var html;
    switch (route.view) {
      case "desk": html = viewDesk(); break;
      case "courses": html = viewCourses(); break;
      case "tags": html = viewTags(); break;
      case "settings": html = viewSettings(); break;
      case "course": html = viewCourse(route.code); break;
      default: html = viewDashboard();
    }
    main.innerHTML = html;
    if (route.view === "dashboard") {
      var hw = main.querySelector(".heat-wrap"); if (hw) hw.scrollLeft = hw.scrollWidth;
    }
    if (route.view === "course" && route.query.step && ui.jumped !== route.code + "|" + route.query.step) {
      ui.jumped = route.code + "|" + route.query.step;
      setTimeout(function () {
        var b = main.querySelector('.check[data-id="' + CSS.escape(route.query.step) + '"]');
        if (!b) return;
        var row = b.closest(".node-row");
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        row.classList.add("flash");
      }, 30);
    }
    document.title = (route.view === "course" && findCourse(route.code) ? findCourse(route.code).title + " · " : "") + VERSIONS[settings.version].name;
  }

  /* ---------------- Dashboard ---------------- */
  function viewDashboard() {
    var s = dashboardStats();
    var byDay = activityByDay();
    var st = streaks(byDay);
    var removed = D.courses.length - s.courses;
    var hoursLeft = Math.max(0, s.hours - s.hoursDone);
    var overall = s.hours ? (s.hoursDone / s.hours) * 100 : 0;

    var h = '<div class="page-head"><h1>' + esc(VERSIONS[settings.version].name) + '</h1><p>' +
      esc(VERSIONS[settings.version].blurb) + " Stats count only the " + plural(s.courses, "course") + " you have selected.</p></div>";

    h += '<div class="hero">' + treeCard(s) + todayCard(st) + "</div>";
    h += '<div class="card overall section" data-tip="' + (TM() ? "Share of steps done" : "Share of estimated study hours done") + ', across selected courses."><div class="bar"><span style="width:' +
      overall.toFixed(1) + '%"></span></div><span class="pct">' + (overall < 1 && overall > 0 ? "<1" : Math.round(overall)) + "%</span></div>";

    function stat(label, value, sub, tip, href) {
      var inner = '<div class="label">' + label + '</div><div class="value">' + value + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "");
      return href ? '<a class="stat" href="' + href + '" style="color:inherit;text-decoration:none" data-tip="' + esc(tip) + '">' + inner + "</a>"
        : '<div class="stat" data-tip="' + esc(tip) + '">' + inner + "</div>";
    }
    h += '<div class="stats section">' +
      stat("Courses done", s.complete + '<span class="muted small"> / ' + s.courses + "</span>", pct(s.complete, s.courses) + "% of selected", "A course is done when every step in it is ticked.") +
      stat("In progress", s.inProgress, "started, not finished", "Courses with at least one step done.") +
      stat("Courses left", s.courses - s.complete, plural(s.courses - s.complete - s.inProgress, "not started", "not started"), "Selected courses that are not done yet.") +
      (TM() ? stat("Steps left", fmtInt(s.steps - s.stepsDone), "to finish your courses", "Steps not ticked yet in the selected courses.")
        : stat("Hours done", fmtHours(s.hoursDone), "estimated", "Time spent, estimated: each done step counts its share of the course's estimated hours.") +
          stat("Hours left", fmtHours(hoursLeft), "of " + fmtHours(s.hours) + " total", "Rough estimate of study time still needed for the selected courses.")) +
      stat("Steps done", fmtInt(s.stepsDone) + '<span class="muted small"> / ' + fmtInt(s.steps) + "</span>", pct(s.stepsDone, s.steps) + "%", "Every tickable step (study, practice, check, project) in the selected courses.") +
      stat("Focus time", fmtMin(sumObj(selFocusDays())), "logged with the timer", "Real study time you logged with the focus timer (the clock button).") +
      stat("Active days", st.days, st.first ? "since " + fmtDate(new Date(st.first + "T12:00:00")).slice(5) : "no activity yet", "Days on which you ticked at least one step.") +
      stat("Not selected", removed, removed ? "view and add" : "all selected", "Courses that are not selected. Their progress is kept.", "#/courses?list=unselected") +
      "</div>";

    /* heatmap */
    h += '<div class="card section"><div class="section-head"><h2>Activity</h2><span class="muted small">Current streak ' +
      plural(st.current, "day") + " · longest " + plural(st.longest, "day") + "</span></div>" + heatmap(byDay) + "</div>";

    /* level + next up */
    var lv = '<div class="card"><h2>By level</h2>';
    LEVEL_ORDER.concat(Object.keys(s.levels).filter(function (k) { return LEVEL_ORDER.indexOf(k) < 0; })).forEach(function (k) {
      var L = s.levels[k]; if (!L) return;
      var p = L.h ? (L.d / L.h) * 100 : 0;
      lv += '<div class="level-row" data-tip="' + esc(k + ": " + L.c + " of " + L.n + " courses done, " + fmtHours(L.d) + " of " + fmtHours(L.h) + (TM() ? "" : " estimated")) + '">' +
        '<a href="' + tagHref(k) + '" class="small">' + esc(k.replace("CSE-", "")) + '</a><div class="bar' + (p >= 100 ? " done" : "") + '"><span style="width:' + p.toFixed(1) + '%"></span></div>' +
        '<span class="num">' + L.c + "/" + L.n + "</span></div>";
    });
    [["Core", s.core, "Courses not tagged optional."], ["Optional", s.opt, "Electives (tagged optional)."]].forEach(function (r) {
      if (!r[1].h) return;
      var p = (r[1].d / r[1].h) * 100;
      lv += '<div class="level-row" data-tip="' + esc(r[2] + " " + fmtHours(r[1].d) + " of " + fmtHours(r[1].h) + (TM() ? "" : " estimated")) + '"><span class="small">' + r[0] +
        '</span><div class="bar"><span style="width:' + p.toFixed(1) + '%"></span></div><span class="num">' + Math.round(p) + "%</span></div>";
    });
    lv += "</div>";

    var nu = nextUp(5);
    var nx = '<div class="card"><div class="section-head"><h2>Next up</h2><a class="small" href="#/desk">Open desk</a></div>';
    if (!nu.length) nx += '<p class="empty">' + (s.courses ? "Everything selected is done. Nice work." : "No courses selected.") + "</p>";
    else nx += '<div class="list">' + nu.map(courseRow).join("") + "</div>";
    nx += '<p class="muted small" style="margin:8px 0 0">First courses in order whose selected prerequisites are done.</p></div>';
    h += '<div class="grid-2 section">' + nx + lv + "</div>";

    h += weeklyCard(byDay);
    h += badgesCard();

    /* recent */
    var recent = [];
    selectedCourses().forEach(function (c) { c._leaves.forEach(function (id) { if (S.done[id]) recent.push([S.done[id], id, c]); }); });
    recent.sort(function (a, b) { return b[0] - a[0]; });
    h += '<div class="card section"><h2>Recently done</h2>';
    if (!recent.length) h += '<p class="empty">Nothing ticked yet. Open a course on your desk and mark a step done.</p>';
    else h += '<ul class="log">' + recent.slice(0, 8).map(function (r) {
      var n = X().nodes[r[1]];
      return '<li><a href="' + courseHref(r[2].code) + '">' + esc(r[2].title) + "</a> · " + esc(pathTitle(r[1])) +
        ' <span class="muted small nowrap">' + esc(fmtWhen(r[0])) + "</span>" + (n.kind ? ' <span class="badge">' + esc(n.kind) + "</span>" : "") + "</li>";
    }).join("") + "</ul>";
    h += "</div>";
    return h;
  }
  function pathTitle(id) {
    // "Topic › Part › Step" for a leaf id
    var c = X().byCode[X().courseOfNode[id]];
    var trail = [];
    (function find(list) {
      for (var i = 0; i < list.length; i++) {
        trail.push(list[i].title);
        if (list[i].id === id) return true;
        if (list[i].children && find(list[i].children)) return true;
        trail.pop();
      }
      return false;
    })(c.tasks);
    return trail.map(function (t) { return truncate(t, 48); }).join(" › ");
  }
  function heatmap(byDay) {
    var today = new Date(); today.setHours(12, 0, 0, 0);
    var end = new Date(today); end.setDate(end.getDate() + (6 - end.getDay()));
    var start = new Date(end); start.setDate(start.getDate() - (53 * 7 - 1));
    var max = 0; Object.keys(byDay).forEach(function (k) { if (byDay[k] > max) max = byDay[k]; });
    var html = '<div class="heat-wrap"><div class="heat" role="img" aria-label="Activity heatmap for the last year">';
    var d = new Date(start), lastMonth = -1;
    for (var w = 0; w < 53; w++) {
      var label = "";
      for (var i = 0; i < 7; i++) {
        var dd = new Date(d); dd.setDate(dd.getDate() + i);
        if (dd.getDate() === 1 && w > 0 && w < 52 && dd.getMonth() !== lastMonth) { label = MONTHS[dd.getMonth()]; lastMonth = dd.getMonth(); }
      }
      html += '<span class="mlabel">' + label + "</span>";
      for (var j = 0; j < 7; j++) {
        var k = dayKey(d), n = byDay[k] || 0;
        if (d > today) html += '<span class="cell future"></span>';
        else {
          var l = n ? Math.max(1, Math.ceil((n / max) * 4)) : 0;
          html += '<span class="cell' + (l ? " l" + l : "") + '" data-tip="' + esc((n ? plural(n, "step") + " done" : "No steps done") + " on " + fmtDate(d)) + '"></span>';
        }
        d.setDate(d.getDate() + 1);
      }
    }
    html += "</div></div>";
    html += '<div class="heat-foot"><span class="muted small">Each square is a day; darker means more steps ticked.</span>' +
      '<span class="heat-legend">Less <span class="cell" style="background:var(--heat-0)"></span><span class="cell" style="background:var(--heat-1)"></span>' +
      '<span class="cell" style="background:var(--heat-2)"></span><span class="cell" style="background:var(--heat-3)"></span><span class="cell" style="background:var(--heat-4)"></span> More</span></div>';
    return html;
  }

  /* ---------------- Course rows (shared) ---------------- */
  function courseTip(c, p) {
    var lines = [c.title];
    if (c.summary) lines.push(truncate(c.summary, 160));
    else {
      var topics = c.tasks.filter(function (t) { return /\.t\d+$/.test(t.id) && !/\.t0$/.test(t.id); }).slice(0, 3).map(function (t) { return t.title; });
      if (topics.length) lines.push("Topics: " + truncate(topics.join("; "), 160));
    }
    lines.push(statusLabel(p) + " · " + p.done + "/" + p.total + " steps" + (TM() ? "" : " · ~" + fmtHours(p.hours)));
    if (c.depends_on && c.depends_on.length) lines.push("Needs: " + c.depends_on.map(nameOf).join(", "));
    return lines.join("\n");
  }
  function courseRow(c, opts) {
    opts = opts || {};
    var p = courseProgress(c), sel = isSelected(c.code);
    var ringP = pct(p.done, p.total);
    var side = "";
    if (opts.toggle) {
      side = sel
        ? '<button class="btn btn-small" type="button" data-action="remove-course" data-code="' + esc(c.code) + '" data-tip="Unselect this course. Progress is kept.">Remove</button>'
        : '<button class="btn btn-small btn-primary" type="button" data-action="add-course" data-code="' + esc(c.code) + '" data-tip="Select this course. Any old progress comes back with it.">Add</button>';
    }
    var meta = '<span class="nowrap">' + esc(c.period_label || "") + "</span>" +
      (TM() ? '<span class="nowrap">' + plural(p.total, "step") + "</span>" : '<span class="nowrap" data-tip="Estimated study time (rough guess)">~' + fmtHours(p.hours) + "</span>") +
      (c.track ? '<span class="nowrap">' + esc(c.track) + "</span>" : "") +
      (sel ? "" : '<span class="badge">not selected</span>') +
      (c.optional ? '<span class="badge">optional</span>' : "") +
      (c.is_practical ? '<span class="badge">practical</span>' : "") +
      (p.started ? '<span class="bar' + (p.complete ? " done" : "") + '"><span style="width:' + ringP + '%"></span></span><span class="nowrap">' + ringP + "%</span>" : "");
    return '<div class="row' + (sel ? "" : " unselected") + '">' +
      '<span class="ring' + (p.complete ? " done" : "") + '" style="--p:' + ringP + '" data-tip="' + esc(statusLabel(p) + ": " + p.done + " of " + p.total + " steps") + '"></span>' +
      '<a class="main-link" href="' + courseHref(c.code) + '" data-tip="' + esc(courseTip(c, p)) + '"><div class="title">' + esc(c.title) + "</div>" +
      '<div class="meta">' + meta + "</div></a>" +
      (side ? '<div class="side">' + side + "</div>" : "") + "</div>";
  }

  /* ---------------- Desk: courses in order, each followed by its tasks ---------------- */
  function defaultRemoved() {
    var keep = {};
    (D.default_selected || []).forEach(function (c) { keep[c] = 1; });
    return new Set(D.courses.filter(function (c) { return !keep[c.code]; }).map(function (c) { return c.code; }));
  }
  function unselectedDeps(c) {
    return (c.depends_on || []).filter(function (d) { return X().byCode[d] && !isSelected(d); });
  }
  var TRACKS = ["Core CSE", "AI and ML", "Data science", "Cyber security"];
  function viewDesk() {
    var h = '<div class="page-head"><h1>Desk</h1><p>Your selected courses in study order, each followed by its tasks. A course never comes before one it depends on.</p></div>';
    var anyOpen = selectedCourses().some(function (c) { return ui.open["c:" + c.code]; });
    h += '<div class="toolbar"><input class="input" type="search" id="roadmapSearch" placeholder="Search by name or tag" value="' + esc(ui.roadmap.q) + '" aria-label="Search the desk">' +
      '<select class="select" id="trackSelect" aria-label="Track"><option value="">All tracks</option>' +
      TRACKS.concat(["Other"]).map(function (t) { return '<option value="' + esc(t) + '"' + (ui.roadmap.track === t ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") + "</select></div>" +
      '<div class="toolbar"><div class="seg" role="group" aria-label="Show"><button type="button" data-action="rm-hide" data-val="0" class="' + (ui.roadmap.hideDone ? "" : "on") + '">All</button>' +
      '<button type="button" data-action="rm-hide" data-val="1" class="' + (ui.roadmap.hideDone ? "on" : "") + '">Hide done</button></div>' +
      '<button type="button" class="btn btn-small" data-action="desk-expand" data-val="' + (anyOpen ? "0" : "1") + '">' + (anyOpen ? "Collapse all" : "Expand all") + "</button></div>";
    h += '<div id="roadmapList">' + deskList() + "</div>";
    return h;
  }
  function deskList() {
    var list = selectedCourses().filter(function (c) {
      if (ui.roadmap.track && (c.track || "Other") !== ui.roadmap.track) return false;
      return matchesQuery(c, ui.roadmap.q) && !(ui.roadmap.hideDone && courseProgress(c).complete);
    });
    if (!list.length) return '<p class="empty">' + (selectedCourses().length ? "No courses match." : 'Your desk is empty. <a href="#/courses?list=unselected">Select courses</a>.') + "</p>";
    var groups = [];
    list.forEach(function (c) {
      var g = groups[groups.length - 1];
      if (!g || g.label !== c.period_label) groups.push(g = { label: c.period_label || "Other", items: [] });
      g.items.push(c);
    });
    return groups.map(function (g) {
      var hrs = 0, doneN = 0;
      g.items.forEach(function (c) { var p = courseProgress(c); hrs += p.hours; if (p.complete) doneN++; });
      return '<div class="phase"><div class="phase-head"><h2>' + esc(g.label) + '</h2><span class="muted small">' + doneN + "/" + g.items.length +
        " done · " + approx(hrs) + '</span></div><div class="list desk">' + g.items.map(deskCourse).join("") + "</div></div>";
    }).join("");
  }
  function deskCourse(c) {
    var p = courseProgress(c), open = !!ui.open["c:" + c.code], pc = pct(p.done, p.total);
    var state = p.complete ? "on" : p.done ? "part" : "";
    var tip = p.complete ? "Course done. Click to mark it not done" : "Mark the whole course done (" + plural(p.total - p.done, "step") + " left)";
    var missing = unselectedDeps(c);
    return '<details class="desk-course" data-cblock="' + esc(c.code) + '"' + (open ? " open" : "") + ">" +
      '<summary class="desk-head"><span class="caret" aria-hidden="true"></span>' +
      '<button type="button" class="check ' + state + '" data-action="toggle-course" data-code="' + esc(c.code) + '" aria-label="' + esc(tip + ": " + c.title) + '" data-tip="' + esc(tip) + '"></button>' +
      '<div class="desk-body"><div class="desk-title"><a href="' + courseHref(c.code) + '" data-tip="' + esc(courseTip(c, p)) + '">' + esc(c.title) + "</a></div>" +
      '<div class="meta"><span class="nowrap" data-tip="Estimated study time (rough guess)">~' + fmtHours(p.hours) + "</span>" +
      '<span class="nowrap">' + p.done + "/" + p.total + " steps</span>" +
      '<span class="bar' + (p.complete ? " done" : "") + '"><span style="width:' + pc + '%"></span></span>' +
      (missing.length ? '<span class="badge warn" data-tip="' + esc("Builds on " + missing.map(nameOf).join(", ") + ", not selected. Fine if you already know it; otherwise select it on the Courses page.") + '">needs unselected course</span>' : "") +
      '</div><div class="chips desk-chips">' + sortTags(c.tags).map(function (t) { return tagChip(t); }).join("") + "</div></div></summary>" +
      '<div class="desk-tasks tree">' + (open ? deskTasks(c) : "") + "</div></details>";
  }
  function deskTasks(c) {
    return c.tasks.map(function (t) { return renderNode(t, 0, c); }).join("");
  }
  function matchesQuery(c, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (c.title + " " + c.tags.join(" ") + " " + (c.summary || "") + " " + (c.period_label || "")).toLowerCase().indexOf(q) >= 0;
  }
  /* ---------------- Courses (selected / unselected) ---------------- */
  function viewCourses() {
    var allTags = sortTags(Object.keys(X().tagCount));
    var h = '<div class="page-head"><h1>Courses</h1><p>Choose what is on your desk. Removing a course keeps its progress and notes; adding it back restores them.</p></div>';
    var nSel = selectedCourses().length, nUn = D.courses.length - nSel;
    h += '<div class="toolbar"><div class="seg" role="group" aria-label="List">' +
      [["selected", "Selected (" + nSel + ")"], ["unselected", "Unselected (" + nUn + ")"], ["all", "All (" + D.courses.length + ")"]].map(function (o) {
        return '<button type="button" data-action="list-mode" data-val="' + o[0] + '" class="' + (ui.courses.list === o[0] ? "on" : "") + '">' + o[1] + "</button>";
      }).join("") + "</div></div>";
    h += '<div class="toolbar"><input class="input" type="search" id="courseSearch" placeholder="Search by name or summary" value="' + esc(ui.courses.q) + '" aria-label="Search courses">' +
      '<select class="select" id="tagSelect" aria-label="Filter by tag"><option value="">Filter by tag…</option>' +
      allTags.map(function (t) { return '<option value="' + esc(t) + '"' + (ui.courses.tags.indexOf(t) >= 0 ? " disabled" : "") + ">" + esc(t) + " (" + X().tagCount[t] + ")</option>"; }).join("") +
      "</select></div>";
    h += '<div id="courseList">' + courseList() + "</div>";
    return h;
  }
  function filteredCourses() {
    return D.courses.filter(function (c) {
      var sel = isSelected(c.code);
      if (ui.courses.list === "selected" && !sel) return false;
      if (ui.courses.list === "unselected" && sel) return false;
      for (var i = 0; i < ui.courses.tags.length; i++) if (c.tags.indexOf(ui.courses.tags[i]) < 0) return false;
      return matchesQuery(c, ui.courses.q);
    });
  }
  function courseList() {
    var list = filteredCourses();
    var h = '<div class="filter-line">';
    if (ui.courses.tags.length) {
      h += "<span>Tags:</span>" + ui.courses.tags.map(function (t) {
        return '<button type="button" class="chip on" data-action="untag" data-tag="' + esc(t) + '" data-tip="Remove this filter">' + esc(t) + ' <span class="x">×</span></button>';
      }).join("");
    }
    h += "<span>" + plural(list.length, "course") + " shown</span>";
    if (list.length) {
      var anySel = list.some(function (c) { return isSelected(c.code); }), anyUn = list.some(function (c) { return !isSelected(c.code); });
      if (anySel) h += '<button type="button" class="btn btn-small" data-action="bulk-remove">Remove all shown</button>';
      if (anyUn) h += '<button type="button" class="btn btn-small" data-action="bulk-add">Add all shown</button>';
    }
    h += "</div>";
    if (!list.length) return h + '<p class="empty">No courses match.</p>';
    return h + '<div class="list">' + list.map(function (c) { return courseRow(c, { toggle: true }); }).join("") + "</div>";
  }

  /* ---------------- Course detail ---------------- */
  function viewCourse(key) {
    var c = findCourse(key);
    var code = c && c.code;
    if (!c) return '<p class="empty">Course not found. <a href="#/desk">Back to the desk</a></p>';
    var p = courseProgress(c), sel = isSelected(code);
    if (route.query.step && X().nodes[route.query.step]) {
      for (var pid = X().parentOf[route.query.step]; pid; pid = X().parentOf[pid]) ui.open[pid] = true;
    }
    var h = '<div class="crumbs"><a href="#/desk">← Desk</a></div>';
    if (!sel) h += '<div class="removed-banner"><span>This course is not selected, so it is not on your desk or in your stats. Its progress and notes are kept.</span>' +
      '<button class="btn btn-primary btn-small" type="button" data-action="add-course" data-code="' + esc(code) + '">Select this course</button></div>';
    var missing = unselectedDeps(c);
    if (sel && missing.length) h += '<div class="removed-banner"><span>Builds on ' + missing.map(function (d) { return '<a href="' + courseHref(d) + '">' + esc(nameOf(d)) + "</a>"; }).join(", ") +
      ", which " + (missing.length > 1 ? "are" : "is") + " not selected. Fine if you already know it; otherwise select it too.</span></div>";
    h += '<div class="course-head"><div class="titles"><div class="muted small">' + esc(c.period_label || "") + " · #" + c.order + " in order</div>" +
      "<h1>" + esc(c.title) + '</h1><div class="chips">' + sortTags(c.tags).map(function (t) { return tagChip(t); }).join("") + "</div></div>" +
      '<div class="btn-row">' +
      (p.complete
        ? '<button class="btn" type="button" data-action="toggle-course" data-code="' + esc(code) + '" data-tip="Clear every step in this course">Mark course not done</button>'
        : '<button class="btn btn-primary" type="button" data-action="toggle-course" data-code="' + esc(code) + '" data-tip="Tick every remaining step in this course">Mark course done</button>') +
      '<button class="btn" type="button" data-action="timer-open" data-code="' + esc(code) + '" data-tip="Start a focus timer for this course">' + ICONS.timer + ' Focus</button>' +
      (sel ? '<button class="btn btn-danger" type="button" data-action="remove-course" data-code="' + esc(code) + '" data-tip="Unselect it. Progress is kept.">Remove</button>' : "") +
      "</div></div>";

    h += '<div class="card section"><div class="overall" data-tip="' + esc(p.done + " of " + p.total + " steps" + (TM() ? "" : " · " + fmtHours(p.hoursDone) + " of ~" + fmtHours(p.hours))) + '">' +
      '<span class="badge ' + statusOf(p) + '">' + statusLabel(p) + '</span><div class="bar' + (p.complete ? " done" : "") + '"><span style="width:' + pct(p.done, p.total) + '%"></span></div><span class="pct">' + pct(p.done, p.total) + "%</span></div></div>";

    /* details + note */
    var deps = (c.depends_on || []).map(function (d) { return depLink(d); }).join(", ") || '<span class="muted">None</span>';
    var needed = (X().neededBy[code] || []).map(function (d) { return depLink(d); }).join(", ") || '<span class="muted">None</span>';
    var kv = '<dl class="kv">' +
      "<dt>Segment</dt><dd data-tip=\"A stage of the study order, not a time limit\">" + esc(c.period_label || "—") + "</dd>" +
      (TM() ? "<dt>Size</dt><dd>" + plural(p.total, "step") + "</dd>" + ""
        : '<dt>Time</dt><dd><span data-tip="Rough guess: about 8 hours per outline topic plus 15 for the final check (and 15 for labs).">~' + fmtHours(c.estimated_hours || 0) + " estimated</span> · " + plural(p.total, "step") + "</dd>") +
      (c.credits ? "<dt>Credits</dt><dd>" + esc(c.credits) + "</dd>" : "") +
      (c.track ? "<dt>Track</dt><dd>" + esc(c.track) + "</dd>" : "") +
      "<dt>Level</dt><dd>" + esc(c.cse_level || "—") + (c.optional ? " · optional" : " · core") + "</dd>" +
      (S.focusCourses[code] ? '<dt>Focused</dt><dd data-tip="Time logged with the focus timer">' + fmtMin(S.focusCourses[code]) + "</dd>" : "") +
      "<dt>Depends on</dt><dd>" + deps + "</dd>" +
      "<dt>Needed by</dt><dd>" + needed + "</dd>" +
      (c.prerequisite_text && c.prerequisite_text !== "None" ? "<dt>Prerequisite</dt><dd>" + esc(c.prerequisite_text) + "</dd>" : "") +
      (c.url ? '<dt>Source</dt><dd><a href="' + esc(c.url) + '" target="_blank" rel="noopener">Official course page ↗</a></dd>' : "") +
      "</dl>";
    var details = '<div class="card"><h2>Details</h2>' + (c.summary ? "<p>" + esc(c.summary) + "</p>" : "") + kv + "</div>";
    var note = '<div class="card"><h2>Course note</h2><textarea class="input" id="courseNote" data-code="' + esc(code) + '" placeholder="Your notes for this course: resources, questions, plans…" rows="6">' +
      esc(S.courseNotes[code] || "") + '</textarea><div class="note-saved" id="courseNoteSaved">' + (S.courseNotes[code] ? "Saved in this browser." : "") + "</div></div>";
    if (c.about) h += '<div class="card section about"><h2>About this course</h2><h3>What it is</h3><p>' + esc(c.about.what) +
      '</p><h3>Why study it</h3><p>' + esc(c.about.why) + "</p></div>";
    h += '<div class="grid-2 section">' + details + note + "</div>";

    h += '<div class="card section"><h2>How this course was made</h2>' + howMade(c) + "</div>";

    /* task tree */
    var openAll = c.tasks.every(function (t) { return !t.children.length || ui.open[t.id]; });
    h += '<div class="section"><div class="section-head"><h2>Tasks</h2><div class="btn-row">' +
      '<button type="button" class="btn btn-small" data-action="expand" data-code="' + esc(code) + '" data-val="' + (openAll ? "0" : "1") + '">' + (openAll ? "Collapse all" : "Expand all") + "</button></div></div>" +
      '<p class="muted small">Tick a step to mark it done; ticking a task or part ticks everything inside it. You will always be asked to confirm. Use the pencil to add a note to any task.</p>' +
      '<div class="list tree">' + c.tasks.map(function (t) { return renderNode(t, 0, c); }).join("") + "</div></div>";
    return h;
  }
  function depLink(code) {
    var dc = X().byCode[code];
    if (!dc) return esc(code);
    var p = courseProgress(dc);
    return '<a href="' + courseHref(code) + '" data-tip="' + esc(dc.title + " · " + statusLabel(p) + (isSelected(code) ? "" : " · not selected")) + '">' + esc(dc.title) + "</a>" +
      (p.complete ? " ✓" : "");
  }
  function howMade(c) {
    var v = settings.version, h = "";
    if (c.track) h += "<p>Selected by default as part of your <b>" + esc(c.track) + "</b> track.</p>";
    if (c.sources) {
      var srcs = c.sources || [];
      if (srcs.length > 1) h += "<p>Merged from " + plural(srcs.length, "source course") + ". Topics that both cover were folded together; each topic appears once.</p>";
      else if (srcs.length === 1) h += "<p>Taken unchanged from " + esc(srcs[0].university) + " (no matching course at the other university).</p>";
      h += '<ul class="log">' + srcs.map(function (s) {
        return '<li><span class="from">' + esc(s.university) + "</span> · " + esc(s.title) + "</li>";
      }).join("") + "</ul>";
      if (c.merge_log && c.merge_log.length) {
        h += '<h3 style="margin-top:12px">Merge log</h3><ul class="log">' + c.merge_log.map(function (m) {
          var what;
          if (m.dropped_as_duplicate) what = "dropped: the whole topic was already covered";
          else if (m.merged_into) what = "folded into <b>" + esc(m.merged_into) + "</b>" + (m.added_parts && m.added_parts.length ? "; added: " + esc(m.added_parts.join(", ")) : "");
          else what = "added as its own topic" + (m.dropped_parts && m.dropped_parts.length ? "; parts already covered elsewhere: " + esc(m.dropped_parts.join(", ")) : "");
          if (m.merged_into && m.dropped_parts && m.dropped_parts.length) what += "; already covered: " + esc(m.dropped_parts.join(", "));
          return '<li><span class="from">' + esc(m.from) + ":</span> “" + esc(m.topic) + "” → " + what + "</li>";
        }).join("") + "</ul>";
      }
      h += '<p class="muted small" style="margin-top:10px">Level is the lowest of the sources; optional only if every source is optional; the segment follows where the course sits in the study order, moved later if a prerequisite comes later. University-specific tags were removed.</p>';
    } else {
      var uni = v === "buet" ? "BUET CSE" : "Oxford CS";
      h += "<p>Built from the official " + esc(uni) + " course list" + (c.url ? ' (<a href="' + esc(c.url) + '" target="_blank" rel="noopener">source</a>)' : "") +
        ". Non-CS courses were filtered out, then each course got one level tag and area tags.</p>";
      h += '<ul class="log">' +
        "<li>Each outline topic became a task, split into parts with a <b>Study</b> and a <b>Practice</b> step and a <b>Checkpoint</b>.</li>" +
        "<li>Every course starts with <b>Get ready</b> (tools, a main text, a schedule) and ends with a <b>Final check</b> (mini-project and timed self-exam).</li>" +
        "<li>Order: dependencies first, then segment and level" + (c.depends_on && c.depends_on.length ? "; this course comes after " + esc(c.depends_on.map(nameOf).join(", ")) : "") + ".</li>" +
        "<li>Hours: a rough guess (about 8 h per topic + 15 h final check), not an official workload.</li>" +
        (c.optional && v === "buet" ? "<li>“optional” is a guess: BUET does not mark electives; most Level 4 courses are treated as optional.</li>" : "") +
        "</ul>";
    }
    h += '<p class="muted small" style="margin-top:10px">Textbook suggestions are standard texts, not the official reading lists. <a href="#/tags">Learn about tags</a>.</p>';
    return h;
  }
  function renderNode(n, depth, c) {
    var leaves = X().leavesOf[n.id], d = doneCount(leaves), all = d === leaves.length, kids = n.children && n.children.length;
    var state = all ? "on" : d ? "part" : "";
    var note = S.taskNotes[n.id];
    var checkTip = all ? "Done. Click to mark not done" : (kids ? "Mark all " + leaves.length + " steps done" : "Mark this step done");
    var row =
      (kids ? '<span class="caret" aria-hidden="true"></span>' : '<span class="caret blank" aria-hidden="true"></span>') +
      '<button type="button" class="check ' + state + '" data-action="toggle-node" data-id="' + esc(n.id) + '" aria-pressed="' + (all ? "true" : d ? "mixed" : "false") +
      '" aria-label="' + esc(checkTip + ": " + n.title) + '" data-tip="' + esc(checkTip) + '"></button>' +
      '<div class="node-body"><div class="node-title' + (all ? " is-done" : "") + '">' + esc(n.title) + "</div>" +
      (n.detail ? '<div class="node-detail">' + esc(n.detail) + "</div>" : "") +
      '<div class="node-meta">' + (n.kind && n.kind !== "task" && n.kind !== "subtask" ? '<span class="badge" data-tip="' + esc(KIND_TEXT[n.kind] || n.kind) + '">' + esc(n.kind) + "</span>" : "") +
      (kids ? "<span>" + d + "/" + leaves.length + "</span>" : "") +
      (TM() ? "" : '<span data-tip="Estimated time for this part">~' + fmtHours(leaves.length * c._leafHours) + "</span>") +
      (!kids && S.done[n.id] ? '<span class="nowrap">done ' + esc(fmtWhen(S.done[n.id])) + "</span>" : "") + "</div>" +
      (note && !ui.noteOpen[n.id] ? '<div class="node-note-text">' + esc(note) + "</div>" : "") +
      "</div>" +
      '<button type="button" class="note-btn' + (note ? " has" : "") + '" data-action="note" data-id="' + esc(n.id) + '" aria-label="Note for ' + esc(n.title) + '" data-tip="' + (note ? "Edit note" : "Add a note") + '">' + ICONS.note + "</button>";
    var editor = ui.noteOpen[n.id]
      ? '<div class="node-note-edit"><textarea class="input task-note" data-id="' + esc(n.id) + '" placeholder="Note for this task…">' + esc(note || "") + '</textarea><div class="btn-row" style="margin-top:6px"><button type="button" class="btn btn-small" data-action="note" data-id="' + esc(n.id) + '">Done</button></div></div>'
      : "";
    if (kids) {
      return '<details class="node" data-node="' + esc(n.id) + '"' + (ui.open[n.id] ? " open" : "") + '><summary class="node-row">' + row + "</summary>" + editor +
        '<div class="node-children">' + n.children.map(function (ch) { return renderNode(ch, depth + 1, c); }).join("") + "</div></details>";
    }
    return '<div class="node"><div class="node-row">' + row + "</div>" + editor + "</div>";
  }
  var KIND_TEXT = { study: "Study: read and summarise", practice: "Practice: do something hands-on", check: "Check: verify you learned it", project: "Mini-project" };

  /* ---------------- Tags ---------------- */
  function viewTags() {
    var tags = sortTags(Object.keys(X().tagCount));
    var h = '<div class="page-head"><h1>About tags</h1><p>What each tag in ' + (TM() ? "" : "the ") + esc(VERSIONS[settings.version].name) + " means and why it is there. Click a tag to see its courses.</p></div>";
    TAG_GROUPS.forEach(function (g) {
      var list = tags.filter(function (t) { return tagInfo(t).group === g; });
      if (!list.length) return;
      h += '<div class="tag-group"><h2>' + esc(g) + '</h2><div class="list">' + list.map(function (t) {
        var info = tagInfo(t);
        var selN = D.courses.filter(function (c) { return isSelected(c.code) && c.tags.indexOf(t) >= 0; }).length;
        return '<div class="tag-card"><div>' + tagChip(t) + '<div class="count">' + plural(X().tagCount[t], "course") + " · " + selN + " selected</div></div>" +
          "<div><div>" + esc(info.text) + "</div>" + (info.why ? '<div class="why">Why: ' + esc(info.why) + "</div>" : "") + "</div></div>";
      }).join("") + "</div></div>";
    });
    return h;
  }

  /* ---------------- Settings ---------------- */
  function viewSettings() {
    var h = '<div class="page-head"><h1>Settings</h1><p>Your progress, notes and course selection are saved in this browser.</p></div>';
    h += '<div class="card"><h2>Theme</h2><div class="seg" role="group" aria-label="Theme">' + [["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(function (o) {
      return '<button type="button" data-action="set-theme" data-val="' + o[0] + '" class="' + (settings.theme === o[0] ? "on" : "") + '">' + o[1] + "</button>";
    }).join("") + "</div></div>";

    h += '<div class="card"><h2>Study</h2>' +
      '<div class="setting-row"><div class="txt"><b>Daily goal</b><div class="muted small">How many steps you want to tick each day. Shown on the dashboard and celebrated when you reach it.</div></div>' +
      '<div class="seg" role="group" aria-label="Daily goal">' + [3, 5, 10, 15, 20, 30].map(function (n) {
        return '<button type="button" data-action="set-goal" data-val="' + n + '" class="' + (settings.dailyGoal === n ? "on" : "") + '">' + n + "</button>";
      }).join("") + "</div></div>" +
      '<div class="setting-row"><div class="txt"><b>Sounds</b><div class="muted small">A soft chime when a timer ends, a course is finished or the daily goal is reached.</div></div>' +
      '<div class="seg" role="group" aria-label="Sounds"><button type="button" data-action="set-sound" data-val="1" class="' + (settings.sound ? "on" : "") + '">On</button>' +
      '<button type="button" data-action="set-sound" data-val="0" class="' + (settings.sound ? "" : "on") + '">Off</button></div></div></div>';
    h += '<div class="card"><h2>Your data</h2>' +
      (storageOk ? "" : '<p style="color:var(--warn)">This browser is blocking storage, so progress will be lost when you close the page.</p>') +
      '<div class="setting-row"><div class="txt"><b>Export</b><div class="muted small">Download progress, notes and selection as a JSON file (a backup, or to move to another browser).</div></div><button type="button" class="btn" data-action="export">Export</button></div>' +
      '<div class="setting-row"><div class="txt"><b>Import</b><div class="muted small">Load a file you exported earlier. It replaces your current data.</div></div><label class="btn">Import<input type="file" id="importFile" accept="application/json,.json" hidden></label></div>' +
      '<div class="setting-row"><div class="txt"><b>Default selection</b><div class="muted small">Select only your ' + (D.default_selected || []).length + ' default lecture courses again (core CSE, AI and ML, data science, cyber security); labs are unselected. Progress is kept.</div></div><button type="button" class="btn" data-action="reset-selection">Restore…</button></div>' +
      '<div class="setting-row"><div class="txt"><b>Reset</b><div class="muted small">Start over: clear all progress, notes, focus time and badges, and go back to the default selection.</div></div><button type="button" class="btn btn-danger" data-action="reset">Reset…</button></div>' +
      "</div>";

    h += '<div class="card"><h2>How to use this roadmap</h2><ul class="log">' + (D.how_to_use || []).map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" +
      '<h3 style="margin-top:12px">How it was built</h3><ul class="log">' + (D.notes || []).map(function (t) { return '<li class="muted">' + esc(t) + "</li>"; }).join("") + "</ul></div>";
    return h;
  }

  /* ------------------------------------------------------------------ */
  /* Modal confirm, toast, tooltip                                       */
  /* ------------------------------------------------------------------ */
  var modal = document.getElementById("modal"), modalOk = document.getElementById("modalOk"), modalCancel = document.getElementById("modalCancel");
  var modalResolve = null, lastFocus = null;
  function confirmBox(title, bodyHtml, okLabel, danger) {
    return new Promise(function (resolve) {
      lastFocus = document.activeElement;
      document.getElementById("modalTitle").textContent = title;
      document.getElementById("modalBody").innerHTML = bodyHtml;
      modalOk.textContent = okLabel || "Confirm";
      modalOk.className = "btn " + (danger ? "btn-danger" : "btn-primary");
      modal.hidden = false;
      modalResolve = resolve;
      hideTip();
      setTimeout(function () { modalOk.focus(); }, 0);
    });
  }
  function closeModal(val) {
    if (!modalResolve) return;
    modal.hidden = true;
    var r = modalResolve; modalResolve = null;
    r(val);
    if (lastFocus && document.contains(lastFocus)) try { lastFocus.focus({ preventScroll: true }); } catch (e) {}
  }
  modalOk.addEventListener("click", function () { closeModal(true); });
  modalCancel.addEventListener("click", function () { closeModal(false); });
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(false); });
  document.addEventListener("keydown", function (e) {
    if (modal.hidden) return;
    if (e.key === "Escape") closeModal(false);
    if (e.key === "Tab") { // keep focus inside the dialog
      var f = [modalCancel, modalOk], i = f.indexOf(document.activeElement);
      e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  });

  var toastEl = document.getElementById("toast"), toastTimer = null;
  function toast(msg, undoFn) {
    toastEl.innerHTML = "<span>" + esc(msg) + "</span>" + (undoFn ? '<button type="button">Undo</button>' : "");
    toastEl.hidden = false;
    if (undoFn) toastEl.querySelector("button").onclick = function () { toastEl.hidden = true; undoFn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, undoFn ? 6000 : 3000);
  }

  var tip = document.getElementById("tooltip"), tipTarget = null;
  function showTip(el) {
    var text = el.getAttribute("data-tip");
    if (!text) return;
    tipTarget = el;
    tip.textContent = text;
    tip.hidden = false;
    var r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    var y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideTip() { tip.hidden = true; tipTarget = null; }
  var canHover = window.matchMedia && window.matchMedia("(hover: hover)").matches;
  document.addEventListener("mouseover", function (e) {
    if (!canHover) return;
    var el = e.target.closest && e.target.closest("[data-tip]");
    if (el && el !== tipTarget) showTip(el); else if (!el) hideTip();
  });
  document.addEventListener("focusin", function (e) {
    var el = e.target.closest && e.target.closest("[data-tip]");
    if (el && e.target.matches(":focus-visible")) showTip(el);
  });
  document.addEventListener("focusout", hideTip);
  window.addEventListener("scroll", hideTip, { passive: true });
  // On touch screens a long press shows the tooltip.
  var pressTimer = null;
  document.addEventListener("touchstart", function (e) {
    var el = e.target.closest && e.target.closest("[data-tip]");
    clearTimeout(pressTimer); hideTip();
    if (el) pressTimer = setTimeout(function () { showTip(el); }, 450);
  }, { passive: true });
  document.addEventListener("touchend", function () { clearTimeout(pressTimer); setTimeout(hideTip, 1800); }, { passive: true });
  document.addEventListener("touchmove", function () { clearTimeout(pressTimer); }, { passive: true });

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */
  function setLeaves(ids, done) {
    var now = Date.now();
    ids.forEach(function (id) { if (done) { if (!S.done[id]) S.done[id] = now; } else delete S.done[id]; });
    saveState();
  }
  function toggleIds(ids, label, courseTitle, courseCode) {
    var d = doneCount(ids), all = d === ids.length;
    var body;
    if (all) {
      body = "<p><b>" + esc(label) + "</b>" + (courseTitle ? ' <span class="muted">in ' + esc(courseTitle) + "</span>" : "") + "</p><p>" +
        (ids.length > 1 ? "All " + ids.length + " steps inside will be marked not done." : "This step will be marked not done.") + " Its notes are kept.</p>";
      return confirmBox("Mark as not done?", body, "Mark not done", true).then(function (ok) {
        if (!ok) return false;
        setLeaves(ids, false); setTimeout(checkTree, 300); toast(ids.length > 1 ? plural(ids.length, "step") + " marked not done" : "Marked not done"); return true;
      });
    }
    var left = ids.length - d;
    body = "<p><b>" + esc(label) + "</b>" + (courseTitle ? ' <span class="muted">in ' + esc(courseTitle) + "</span>" : "") + "</p><p>" +
      (ids.length > 1 ? plural(left, "remaining step") + " will be marked done today" + (d ? " (" + d + " already done)." : ".") : "This step will be marked done today.") + "</p>";
    return confirmBox("Mark as done?", body, "Mark done").then(function (ok) {
      if (!ok) return false;
      var c = courseCode && X().byCode[courseCode];
      var wasComplete = c && courseProgress(c).complete, before = stepsToday();
      setLeaves(ids, true);
      var after = stepsToday(), goal = settings.dailyGoal;
      if (c && !wasComplete && courseProgress(c).complete) {
        celebrate(1); chime(true);
        toast("Course finished: " + c.title + ". " + cheer());
      } else if (before < goal && after >= goal) {
        celebrate(0.6); chime(true);
        toast("Daily goal reached: " + plural(after, "step") + " today. " + cheer());
      } else {
        toast((left > 1 ? plural(left, "step") + " marked done" : "Marked done") + (after < goal ? " · " + (goal - after) + " to today's goal" : ""));
      }
      setTimeout(checkBadges, 900);
      setTimeout(checkTree, 2200);
      return true;
    });
  }
  function setSelected(codes, selected) {
    codes.forEach(function (c) { if (selected) removedSet.delete(c); else removedSet.add(c); });
    saveState();
    setTimeout(checkTree, 1500);
  }
  function exportData() {
    var payload = { app: "cse-desk", version: settings.version, exported_at: new Date().toISOString(), state: S };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cse-desk-" + dayKey(Date.now()) + ".json";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }


  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-action]");
    if (!el) return;
    var a = el.getAttribute("data-action");
    if (el.closest("summary")) e.preventDefault(); // buttons inside a <summary> must not toggle it
    var code = el.getAttribute("data-code"), id = el.getAttribute("data-id"), val = el.getAttribute("data-val");
    switch (a) {
      case "toggle-node": {
        var n = X().nodes[id], c = X().byCode[X().courseOfNode[id]];
        toggleIds(X().leavesOf[id], n.title, c.title, c.code).then(function (ch) { if (ch) render(); });
        break;
      }
      case "toggle-course": {
        var cc = X().byCode[code];
        toggleIds(cc._leaves, "Whole course: " + cc.title, null, cc.code).then(function (ch) { if (ch) render(); });
        break;
      }
      case "note":
        if (ui.noteOpen[id]) delete ui.noteOpen[id]; else ui.noteOpen[id] = true;
        render();
        if (ui.noteOpen[id]) { var ta = main.querySelector('textarea.task-note[data-id="' + CSS.escape(id) + '"]'); if (ta) ta.focus(); }
        break;
      case "expand": {
        var co = X().byCode[code];
        (function walk(list) { list.forEach(function (t) { if (t.children.length) { if (val === "1") ui.open[t.id] = true; else delete ui.open[t.id]; if (val === "0") walk(t.children); } }); })(co.tasks);
        render();
        break;
      }
      case "remove-course":
        setSelected([code], false);
        render();
        toast(nameOf(code) + " unselected", function () { setSelected([code], true); render(); });
        break;
      case "add-course":
        setSelected([code], true);
        render();
        toast(nameOf(code) + " added back with its old progress", function () { setSelected([code], false); render(); });
        break;
      case "bulk-remove":
      case "bulk-add": {
        var add = a === "bulk-add";
        var codes = filteredCourses().filter(function (c) { return isSelected(c.code) !== add; }).map(function (c) { return c.code; });
        confirmBox(add ? "Add " + plural(codes.length, "course") + "?" : "Remove " + plural(codes.length, "course") + "?",
          "<p>" + (add ? "They come back with their old progress and notes." : "They move to the unselected list. Progress and notes are kept.") + "</p>",
          add ? "Add" : "Remove", !add).then(function (ok) {
          if (!ok) return;
          setSelected(codes, add); render();
          toast(plural(codes.length, "course") + (add ? " added" : " removed"), function () { setSelected(codes, !add); render(); });
        });
        break;
      }
      case "list-mode": ui.courses.list = val; render(); break;
      case "untag":
        ui.courses.tags = ui.courses.tags.filter(function (t) { return t !== el.getAttribute("data-tag"); });
        render(); break;
      case "rm-hide": ui.roadmap.hideDone = val === "1"; render(); break;
      case "rm-track": ui.roadmap.track = val; render(); break;
      case "desk-expand":
        selectedCourses().forEach(function (c) { if (val === "1") ui.open["c:" + c.code] = true; else delete ui.open["c:" + c.code]; });
        render(); break;
      case "reset-selection":
        confirmBox("Restore the default selection?", "<p>Your " + D.default_selected.length + " default courses (core CSE, AI and ML, data science, cyber security) are selected and every other course, including all labs, is unselected. Progress and notes are kept.</p>", "Restore")
          .then(function (ok) { if (!ok) return; removedSet = defaultRemoved(); saveState(); render(); toast("Default selection restored"); });
        break;
      case "set-goal": settings.dailyGoal = +val; saveSettings(); render(); break;
      case "set-sound": settings.sound = val === "1"; saveSettings(); render(); if (settings.sound) chime(false); break;
      case "timer-open": openTimer(code); break;
      case "timer-close": closeTimer(); break;
      case "timer-mode": timerSetMode(val); break;
      case "timer-start": timerStart(); break;
      case "timer-pause": timerPause(); break;
      case "timer-stop": timerStop(); break;
      case "timer-reset": timerReset(); break;
      case "set-theme": settings.theme = val; saveSettings(); applyTheme(); render(); break;
      case "export": exportData(); break;
      case "reset":
        confirmBox("Reset everything?", "<p>All progress, notes, focus time and badges will be deleted, and the default course selection comes back. Export first if you want a backup.</p>", "Reset", true)
          .then(function (ok) {
            if (!ok) return;
            S = emptyState(); S.badges = []; S.treeStage = 1; removedSet = defaultRemoved(); saveState(); render(); toast("Everything was reset");
          });
        break;
    }
  });
  document.addEventListener("toggle", function (e) {
    var d = e.target;
    if (d.tagName !== "DETAILS") return;
    if (d.hasAttribute("data-cblock")) { // a course on the desk: draw its task list the first time it opens
      var code = d.getAttribute("data-cblock");
      if (d.open) {
        ui.open["c:" + code] = true;
        var body = d.querySelector(".desk-tasks");
        if (body && !body.childElementCount) body.innerHTML = deskTasks(X().byCode[code]);
      } else delete ui.open["c:" + code];
      return;
    }
    if (!d.hasAttribute("data-node")) return;
    var id = d.getAttribute("data-node");
    if (d.open) ui.open[id] = true; else delete ui.open[id];
  }, true);

  var noteTimers = {};
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "roadmapSearch") { ui.roadmap.q = t.value; document.getElementById("roadmapList").innerHTML = deskList(); return; }
    if (t.id === "courseSearch") { ui.courses.q = t.value; document.getElementById("courseList").innerHTML = courseList(); return; }
    if (t.id === "courseNote" || t.classList.contains("task-note")) {
      var isCourse = t.id === "courseNote", key = isCourse ? t.getAttribute("data-code") : t.getAttribute("data-id");
      var bucket = isCourse ? "courseNotes" : "taskNotes";
      clearTimeout(noteTimers[key]);
      var savedEl = isCourse ? document.getElementById("courseNoteSaved") : null;
      if (savedEl) savedEl.textContent = "Saving…";
      noteTimers[key] = setTimeout(function () {
        var v = t.value;
        if (v.trim()) S[bucket][key] = v; else delete S[bucket][key];
        saveState();
        checkBadges();
        if (savedEl) savedEl.textContent = v.trim() ? "Saved in this browser." : "";
        if (!isCourse) {
          var btn = main.querySelector('.note-btn[data-id="' + CSS.escape(key) + '"]');
          if (btn) btn.classList.toggle("has", !!v.trim());
        }
      }, 350);
    }
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.id === "trackSelect") { ui.roadmap.track = t.value; document.getElementById("roadmapList").innerHTML = deskList(); return; }
    if (t.id === "tagSelect" && t.value) {
      if (ui.courses.tags.indexOf(t.value) < 0) ui.courses.tags.push(t.value);
      render();
      var sel = document.getElementById("tagSelect"); if (sel) sel.focus();
    }
    if (t.id === "importFile" && t.files && t.files[0]) {
      var reader = new FileReader();
      reader.onload = function () {
        var data;
        try { data = JSON.parse(reader.result); } catch (err) { toast("That file is not valid JSON"); return; }
        if (!data || data.app !== "cse-desk" || !data.state) { toast("That is not a CSE Study Desk export"); return; }
        var other = false;
        confirmBox("Import this backup?",
          "<p>This replaces your current progress, notes and course selection.</p>" + (other ? '<p style="color:var(--warn)">The file was exported from ' + esc((VERSIONS[data.version] || {}).name || data.version) + ". Steps that do not exist in this version are ignored.</p>" : ""),
          "Import", true).then(function (ok) {
          if (!ok) return;
          writeKey(STATE_PREFIX + settings.version, JSON.stringify(data.state));
          S = loadState(settings.version); removedSet = new Set(S.removed); render(); toast("Imported");
        });
      };
      reader.readAsText(t.files[0]);
      t.value = "";
    }
  });

  /* ------------------------------------------------------------------ */
  /* Theme                                                               */
  /* ------------------------------------------------------------------ */
  var themeBtn = document.getElementById("themeBtn");
  function effectiveDark() {
    if (settings.theme === "dark") return true;
    if (settings.theme === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function applyTheme() {
    if (settings.theme === "light" || settings.theme === "dark") document.documentElement.setAttribute("data-theme", settings.theme);
    else document.documentElement.removeAttribute("data-theme");
    themeBtn.innerHTML = effectiveDark() ? ICONS.sun : ICONS.moon;
    themeBtn.setAttribute("data-tip", effectiveDark() ? "Switch to light theme" : "Switch to dark theme");
  }
  themeBtn.addEventListener("click", function () {
    settings.theme = effectiveDark() ? "light" : "dark"; saveSettings(); applyTheme();
    if (route.view === "settings") render();
  });
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", applyTheme);
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  function activate() {
    var v = settings.version;
    var fresh = !readKey(STATE_PREFIX + v);
    S = loadState(v); removedSet = new Set(S.removed);
    document.getElementById("brandText").textContent = VERSIONS[v].name;
    D = null; render();
    return loadData(v).then(function (data) {
      if (settings.version !== v) return;
      if (!IDX[v]) IDX[v] = buildIndex(data);
      D = data;
      document.getElementById("footerText").textContent = (D.program || "") + " · data built " + (D.built_on || "") +
        (TM() ? ". Progress counts finished steps." : ". Hours are rough estimates.") + " Progress is saved in this browser only.";
      if (route.view === "courses") {
        if (route.query.list) ui.courses.list = route.query.list;
        if (route.query.tag) ui.courses.tags = [route.query.tag];
      }
      if (S.badges === null) { // first run with badges: count what is already earned, without a burst of toasts
        S.badges = badgeList().filter(function (b) { return b.got; }).map(function (b) { return b.id; });
        saveState();
      }
      if (typeof S.treeStage !== "number") checkTree();
      // fresh start, or saved with the old defaults (labs or Functional Programming selected): apply the current defaults, keep progress
      if (fresh || S.defaults < 3) { removedSet = defaultRemoved(); S.defaults = 3; saveState(); }
      if (route.view === "course" && !findCourse(route.code)) { location.hash = "#/desk"; return; }
      render();
      renderTimer();
    }).catch(function (err) {
      main.innerHTML = '<p class="empty">Could not load the course data (' + esc(err.message) + ").</p>";
    });
  }

  /* ------------------------------------------------------------------ */
  /* Extras: daily goal, continue, weekly summary, badges, celebration,  */
  /* focus timer                                                         */
  /* ------------------------------------------------------------------ */
  function sumObj(o) { var t = 0; for (var k in o) t += +o[k] || 0; return t; }
  function fmtMin(m) {
    m = Math.round(m || 0);
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    return h + " h" + (r ? " " + r + " min" : "");
  }
  function todayKey() { return dayKey(Date.now()); }
  function stepsToday() {
    var t = todayKey(), n = 0;
    selectedCourses().forEach(function (c) { c._leaves.forEach(function (id) { if (S.done[id] && dayKey(S.done[id]) === t) n++; }); });
    return n;
  }
  var CHEERS = ["Nice work!", "Keep it up!", "You're on a roll!", "Great progress!", "One step closer!", "Brilliant!", "That's how it's done!"];
  function cheer() { return CHEERS[Math.floor(Math.random() * CHEERS.length)]; }

  function continueStep() {
    var best = null, bestTs = 0;
    selectedCourses().forEach(function (c) {
      var p = courseProgress(c);
      if (p.complete || !p.started) return;
      c._leaves.forEach(function (id) { if (S.done[id] > bestTs) { bestTs = S.done[id]; best = c; } });
    });
    if (!best) best = nextUp(1)[0];
    if (!best) return null;
    for (var i = 0; i < best._leaves.length; i++) if (!S.done[best._leaves[i]]) return { c: best, leaf: best._leaves[i] };
    return null;
  }
  function stepHref(c, leaf) { return courseHref(c.code) + "?step=" + encodeURIComponent(leaf); }

  function todayCard(st) {
    var hr = new Date().getHours();
    var greet = hr < 5 ? "Burning the midnight oil" : hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
    var today = stepsToday(), goal = settings.dailyGoal, p = Math.min(1, today / goal);
    var line;
    if (today >= goal) line = "Daily goal reached. " + (today > goal ? (today - goal) + " extra step" + (today - goal === 1 ? "" : "s") + " today!" : "Great work!");
    else if (today > 0) line = (goal - today) + " more step" + (goal - today === 1 ? "" : "s") + " to reach today's goal.";
    else if (st.current > 0) line = "Keep your " + plural(st.current, "day") + " streak going: tick one step today.";
    else line = "A small step today is still progress.";
    var R = 26, C = 2 * Math.PI * R;
    var ring = '<svg class="goal-ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="' + R + '" class="track"/>' +
      '<circle cx="32" cy="32" r="' + R + '" class="fill' + (p >= 1 ? " done" : "") + '" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - p)).toFixed(1) + '"/></svg>' +
      '<div class="goal-num"><b>' + today + '</b><span>/' + goal + "</span></div>";
    var h = '<div class="card today"><div class="goal" data-tip="Today: ' + today + " of " + goal + ' steps (daily goal, change it in Settings)">' + ring + "</div>" +
      '<div class="today-main"><div class="today-greet">' + greet + '</div><div class="muted small">' + esc(line) + "</div>";
    var nx = continueStep();
    if (nx) {
      h += '<div class="continue"><div class="small muted">' + (courseProgress(nx.c).started ? "Continue" : "Start next") + ' · <a href="' + courseHref(nx.c.code) + '">' + esc(nx.c.title) + "</a></div>" +
        '<div class="continue-step">' + esc(pathTitle(nx.leaf)) + "</div>" +
        '<div class="btn-row"><a class="btn btn-small btn-primary" href="' + stepHref(nx.c, nx.leaf) + '">Open step</a>' +
        '<button type="button" class="btn btn-small" data-action="toggle-node" data-id="' + esc(nx.leaf) + '">Mark done</button>' +
        '<button type="button" class="btn btn-small" data-action="timer-open" data-code="' + esc(nx.c.code) + '">' + ICONS.timer + " Focus</button></div></div>";
    }
    return h + "</div></div>";
  }

  function weeklyCard(byDay) {
    var now = new Date(); now.setHours(12, 0, 0, 0);
    var fd = selFocusDays(), days = [], prev = { steps: 0, focus: 0, active: 0 }, cur = { steps: 0, focus: 0, active: 0, finished: 0 };
    for (var i = 13; i >= 0; i--) {
      var d = new Date(now); d.setDate(d.getDate() - i);
      var k = dayKey(d), n = byDay[k] || 0, f = fd[k] || 0, b = i < 7 ? cur : prev;
      b.steps += n; b.focus += f; if (n) b.active++;
      if (i < 7) days.push({ d: d, n: n, f: f });
    }
    var since = new Date(now); since.setDate(since.getDate() - 6); since.setHours(0, 0, 0, 0);
    selectedCourses().forEach(function (c) {
      var p = courseProgress(c); if (!p.complete) return;
      var last = 0; c._leaves.forEach(function (id) { if (S.done[id] > last) last = S.done[id]; });
      if (last >= since.getTime()) cur.finished++;
    });
    var max = Math.max.apply(null, days.map(function (x) { return x.n; }).concat([1]));
    function delta(a, b, fmt) {
      if (a === b) return '<span class="delta">same as last week</span>';
      return '<span class="delta ' + (a > b ? "up" : "down") + '">' + (a > b ? "▲ " : "▼ ") + (fmt ? fmt(Math.abs(a - b)) : Math.abs(a - b)) + " vs last week</span>";
    }
    var h = '<div class="card section"><div class="section-head"><h2>This week</h2><span class="muted small">last 7 days</span></div><div class="week">' +
      '<div class="week-stats">' +
      '<div><div class="label muted small">Steps</div><b>' + cur.steps + "</b>" + delta(cur.steps, prev.steps) + "</div>" +
      '<div><div class="label muted small">Focus</div><b>' + fmtMin(cur.focus) + "</b>" + delta(cur.focus, prev.focus, fmtMin) + "</div>" +
      '<div><div class="label muted small">Active days</div><b>' + cur.active + "/7</b>" + delta(cur.active, prev.active) + "</div>" +
      '<div><div class="label muted small">Courses finished</div><b>' + cur.finished + "</b></div></div>" +
      '<div class="week-bars" aria-label="Steps per day this week">' + days.map(function (x) {
        return '<div class="wb" data-tip="' + esc(fmtDate(x.d) + ": " + plural(x.n, "step") + (x.f ? ", " + fmtMin(x.f) + " focused" : "")) + '">' +
          '<div class="wb-bar"><span style="height:' + Math.round((x.n / max) * 100) + '%"' + (x.n >= settings.dailyGoal ? ' class="hit"' : "") + "></span></div>" +
          '<div class="wb-day">' + WEEKDAYS[x.d.getDay()].slice(0, 2) + "</div></div>";
      }).join("") + "</div></div></div>";
    return h;
  }

  function badgeList() {
    var s = dashboardStats(), byDay = activityByDay(), st = streaks(byDay);
    var focusH = sumObj(selFocusDays()) / 60;
    var goalDays = Object.keys(byDay).filter(function (k) { return byDay[k] >= settings.dailyGoal; }).length;
    var notes = Object.keys(S.courseNotes).length + Object.keys(S.taskNotes).length;
    var basics = selectedCourses().filter(function (c) { return c.cse_level === "CSE-BASIC"; });
    var basicsDone = basics.filter(function (c) { return courseProgress(c).complete; }).length;
    function b(id, icon, name, desc, cur, target) {
      return { id: id, icon: icon, name: name, desc: desc, got: target > 0 && cur >= target, cur: Math.min(cur, target), target: target };
    }
    return [
      b("first-step", "🌱", "First step", "Tick your first step", s.stepsDone, 1),
      b("steps-100", "💯", "Centurion", "Tick 100 steps", s.stepsDone, 100),
      b("steps-500", "🚀", "Liftoff", "Tick 500 steps", s.stepsDone, 500),
      b("steps-2000", "🏔️", "Mountain climber", "Tick 2,000 steps", s.stepsDone, 2000),
      b("goal-1", "🎯", "Goal getter", "Reach your daily goal", goalDays, 1),
      b("goal-10", "🏹", "Sharpshooter", "Reach your daily goal on 10 days", goalDays, 10),
      b("streak-3", "✨", "Warming up", "Study 3 days in a row", st.longest, 3),
      b("streak-7", "🔥", "On fire", "Study 7 days in a row", st.longest, 7),
      b("streak-30", "🌋", "Unstoppable", "Study 30 days in a row", st.longest, 30),
      b("course-1", "🎓", "First course", "Finish a whole course", s.complete, 1),
      b("course-5", "📚", "Bookworm", "Finish 5 courses", s.complete, 5),
      b("course-20", "🧠", "Big brain", "Finish 20 courses", s.complete, 20),
      b("basics", "🧱", "Solid foundation", "Finish every selected CSE-BASIC course", basicsDone, basics.length),
      b("focus-1", "⏱️", "Focused", "Log 1 hour with the focus timer", Math.floor(focusH * 10) / 10, 1),
      b("focus-25", "🧘", "Deep work", "Log 25 hours with the focus timer", Math.floor(focusH * 10) / 10, 25),
      b("notes-10", "📝", "Note taker", "Write 10 notes", notes, 10),
      b("finish", "🏆", "Desk cleared", "Finish every selected course", s.complete, s.courses)
    ];
  }
  function badgesCard() {
    var list = badgeList(), got = list.filter(function (x) { return x.got; }).length;
    return '<div class="card section"><div class="section-head"><h2>Badges</h2><span class="muted small">' + got + " of " + list.length + " earned</span></div>" +
      '<div class="badges">' + list.map(function (x) {
        var tip = x.name + ": " + x.desc + (x.got ? " · earned" : " · " + x.cur + " / " + x.target);
        return '<div class="bdg' + (x.got ? " got" : "") + '" data-tip="' + esc(tip) + '"><span class="bdg-icon">' + x.icon + '</span><span class="bdg-name">' + esc(x.name) + "</span>" +
          (x.got ? "" : '<span class="bdg-bar"><span style="width:' + (x.target ? Math.round((x.cur / x.target) * 100) : 0) + '%"></span></span>') + "</div>";
      }).join("") + "</div></div>";
  }
  function checkBadges() {
    if (!S.badges || !D) return;
    var fresh = badgeList().filter(function (x) { return x.got && S.badges.indexOf(x.id) < 0; });
    if (!fresh.length) return;
    fresh.forEach(function (x) { S.badges.push(x.id); });
    saveState();
    celebrate(0.5); chime(false);
    toast("Badge unlocked: " + fresh[0].icon + " " + fresh[0].name + (fresh.length > 1 ? " and " + (fresh.length - 1) + " more" : ""));
    if (route.view === "dashboard") render();
  }

  /* ---------- confetti and chime ---------- */
  function celebrate(scale) {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var cv = document.createElement("canvas"), dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.className = "confetti"; cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.appendChild(cv);
    var ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    var cs = getComputedStyle(document.documentElement);
    var colors = ["--accent", "--done", "--warn", "--heat-2", "--danger"].map(function (v) { return cs.getPropertyValue(v).trim() || "#2f6fdf"; });
    var n = Math.round(150 * scale), parts = [];
    for (var i = 0; i < n; i++) {
      var fromLeft = i % 2 === 0;
      parts.push({
        x: fromLeft ? -10 : innerWidth + 10, y: innerHeight * (0.55 + Math.random() * 0.3),
        vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 7), vy: -(9 + Math.random() * 9),
        r: 3 + Math.random() * 4, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[i % colors.length], sq: Math.random() < 0.5
      });
    }
    var t0 = performance.now();
    (function frame(t) {
      var e = t - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, e - 1400) / 600);
      parts.forEach(function (p) {
        p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
        if (p.sq) ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); else { ctx.beginPath(); ctx.arc(0, 0, p.r / 1.4, 0, 7); ctx.fill(); }
        ctx.restore();
      });
      if (e < 2000) requestAnimationFrame(frame); else cv.remove();
    })(t0);
  }
  var audioCtx = null;
  document.addEventListener("pointerdown", function () { // browsers only allow sound after a user gesture
    if (!audioCtx && settings.sound) try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }, { once: false, passive: true });
  function chime(big) {
    if (!settings.sound) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      var notes = big ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 987.77];
      notes.forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + i * 0.11;
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + 0.55);
      });
    } catch (e) {}
  }

  /* ---------- focus timer ---------- */
  var TIMER_KEY = "csedesk:timer";
  var MODES = { focus25: { len: 1500, label: "Focus 25", focus: true }, focus50: { len: 3000, label: "Focus 50", focus: true }, break5: { len: 300, label: "Break 5", focus: false } };
  var T = Object.assign({ mode: "focus25", running: false, remaining: 1500, endAt: 0, code: null, version: null }, readJSON(TIMER_KEY, {}));
  if (!MODES[T.mode]) T.mode = "focus25";
  var timerOpen = false;
  var fab = document.getElementById("timerFab"), panel = document.getElementById("timerPanel");
  function saveTimer() { writeKey(TIMER_KEY, JSON.stringify(T)); }
  function remainingNow() { return T.running ? Math.max(0, Math.ceil((T.endAt - Date.now()) / 1000)) : T.remaining; }
  function mmss(sec) { return pad(Math.floor(sec / 60)) + ":" + pad(sec % 60); }
  function timerCourseTitle() {
    var v = T.version || settings.version, d = window.ROADMAP_DATA && window.ROADMAP_DATA[v];
    var c = d && IDX[v] && IDX[v].byCode[T.code];
    return c ? c.title : "";
  }
  function openTimer(code) {
    if (code && !T.running) { T.code = code; T.version = settings.version; saveTimer(); }
    timerOpen = true; renderTimer();
    var b = panel.querySelector("[data-action=timer-start],[data-action=timer-pause]"); if (b) b.focus();
  }
  function closeTimer() { timerOpen = false; renderTimer(); fab.focus(); }
  function timerSetMode(m) { if (T.running || !MODES[m]) return; T.mode = m; T.remaining = MODES[m].len; saveTimer(); renderTimer(); }
  function timerStart() {
    if (MODES[T.mode].focus) {
      var sel = document.getElementById("timerCourse");
      if (sel && sel.value) { T.code = sel.value; T.version = settings.version; }
      if (!T.code) { toast("Pick a course for this focus session"); return; }
    }
    T.endAt = Date.now() + T.remaining * 1000; T.running = true; saveTimer(); renderTimer();
  }
  function timerPause() { T.remaining = remainingNow(); T.running = false; saveTimer(); renderTimer(); }
  function timerReset() { T.running = false; T.remaining = MODES[T.mode].len; saveTimer(); renderTimer(); }
  function timerStop() {
    var mins = Math.floor((MODES[T.mode].len - remainingNow()) / 60);
    var title = timerCourseTitle();
    if (MODES[T.mode].focus && mins >= 1) { logFocus(T.version, T.code, mins); toast("Logged " + fmtMin(mins) + (title ? " on " + title : "")); }
    else toast("Less than a minute, nothing logged");
    timerReset();
  }
  function logFocus(v, code, mins) {
    if (!v || !code || mins <= 0) return;
    var st = v === settings.version ? S : loadState(v), k = todayKey();
    st.focusDays[k] = (st.focusDays[k] || 0) + mins;
    st.focusCourses[code] = (st.focusCourses[code] || 0) + mins;
    var day = st.focusLog[k] = st.focusLog[k] || {}; day[code] = (day[code] || 0) + mins;
    if (v === settings.version) { saveState(); checkBadges(); if (route.view === "dashboard") render(); }
    else writeKey(STATE_PREFIX + v, JSON.stringify(st));
  }
  function timerFinish() {
    var m = MODES[T.mode];
    T.running = false;
    if (m.focus) {
      var title = timerCourseTitle();
      logFocus(T.version, T.code, Math.round(m.len / 60));
      celebrate(0.5); chime(true);
      toast("Focus session done: " + fmtMin(m.len / 60) + (title ? " on " + title : "") + ". Time for a short break!");
      T.mode = "break5";
    } else {
      chime(false);
      toast("Break over. Ready for another focus session?");
      T.mode = "focus25";
    }
    T.remaining = MODES[T.mode].len; saveTimer();
    timerOpen = true; renderTimer();
  }
  function renderTimer() {
    var rem = remainingNow(), m = MODES[T.mode], active = T.running || rem < m.len;
    fab.classList.toggle("active", active);
    fab.classList.toggle("running", T.running);
    fab.innerHTML = ICONS.timer + (active ? '<span class="fab-time">' + mmss(rem) + "</span>" : "");
    fab.setAttribute("aria-expanded", timerOpen ? "true" : "false");
    fab.setAttribute("data-tip", active ? (T.running ? "Timer running" : "Timer paused") + (m.focus && timerCourseTitle() ? ": " + timerCourseTitle() : "") : "Focus timer");
    if (!T.running && /^[⏱☕]/.test(document.title)) document.title = VERSIONS[settings.version].name;
    panel.hidden = !timerOpen;
    if (!timerOpen) return;
    var courseField;
    if (m.focus && (T.running || rem < m.len) && T.code) {
      courseField = '<div class="small">Course: <b>' + esc(timerCourseTitle() || "—") + "</b>" +
        (T.version && T.version !== settings.version ? ' <span class="muted">(' + esc(VERSIONS[T.version].short) + ")</span>" : "") + "</div>";
    } else if (m.focus && D) {
      var cur = T.version === settings.version ? T.code : null;
      if (!cur && route.view === "course" && findCourse(route.code)) cur = findCourse(route.code).code;
      if (!cur) { var nx = continueStep(); cur = nx ? nx.c.code : null; }
      courseField = '<label class="small muted" for="timerCourse">Course</label><select class="select" id="timerCourse">' +
        selectedCourses().map(function (c) { return '<option value="' + esc(c.code) + '"' + (c.code === cur ? " selected" : "") + ">" + esc(c.title) + "</option>"; }).join("") + "</select>";
    } else courseField = '<div class="small muted">Stand up, stretch, drink some water.</div>';
    var todayMin = S && D ? selFocusDays()[todayKey()] || 0 : 0;
    panel.innerHTML = '<div class="timer-head"><b>Focus timer</b><button type="button" class="icon-btn" data-action="timer-close" aria-label="Close timer">×</button></div>' +
      '<div class="seg timer-modes" role="group" aria-label="Timer length">' + Object.keys(MODES).map(function (k) {
        return '<button type="button" data-action="timer-mode" data-val="' + k + '" class="' + (T.mode === k ? "on" : "") + '"' + (T.running ? " disabled" : "") + ">" + MODES[k].label + "</button>";
      }).join("") + "</div>" +
      '<div class="timer-clock' + (m.focus ? "" : " brk") + '" id="timerClock">' + mmss(rem) + "</div>" +
      '<div class="bar timer-bar"><span id="timerBar" style="width:' + (100 - Math.round((rem / m.len) * 100)) + '%"></span></div>' +
      '<div class="timer-course">' + courseField + "</div>" +
      '<div class="btn-row timer-btns">' +
      (T.running ? '<button type="button" class="btn btn-primary" data-action="timer-pause">Pause</button>'
        : '<button type="button" class="btn btn-primary" data-action="timer-start">' + (rem < m.len ? "Resume" : "Start") + "</button>") +
      (m.focus && rem < m.len ? '<button type="button" class="btn" data-action="timer-stop" data-tip="End now and log the minutes so far">Stop &amp; log</button>' : "") +
      (rem < m.len ? '<button type="button" class="btn" data-action="timer-reset" data-tip="Start over without logging">Reset</button>' : "") +
      "</div>" +
      '<div class="muted small">Today: ' + fmtMin(todayMin) + " focused. Minutes are logged to the course when a focus session ends.</div>";
  }
  function timerTick() {
    if (!T.running) return;
    var rem = remainingNow();
    if (rem <= 0) { timerFinish(); return; }
    var t = fab.querySelector(".fab-time"); if (t) t.textContent = mmss(rem);
    var clock = document.getElementById("timerClock"); if (clock) clock.textContent = mmss(rem);
    var bar = document.getElementById("timerBar"); if (bar) bar.style.width = (100 - Math.round((rem / MODES[T.mode].len) * 100)) + "%";
    document.title = (MODES[T.mode].focus ? "⏱ " : "☕ ") + mmss(rem) + " · " + VERSIONS[settings.version].name;
  }
  setInterval(timerTick, 1000);
  fab.addEventListener("click", function () { timerOpen = !timerOpen; renderTimer(); });
  document.addEventListener("change", function (e) {
    if (e.target.id === "timerCourse") { T.code = e.target.value; T.version = settings.version; saveTimer(); }
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && timerOpen && modal.hidden) closeTimer(); });
  renderTimer();
  window.addEventListener("storage", function (e) { // keep several open tabs in step
    if (e.key === TIMER_KEY) { T = Object.assign(T, readJSON(TIMER_KEY, {})); renderTimer(); }
  });


  /* ------------------------------------------------------------------ */
  /* Growing tree: 25 stages from sapling to banyan                      */
  /* ------------------------------------------------------------------ */
  var TREE_STAGES = ["Sapling", "Tender Sapling", "Young Sapling", "Leafy Sapling", "Sturdy Sapling",
    "Young Tree", "Growing Tree", "Branching Tree", "Leafy Tree", "Shady Tree",
    "Strong Tree", "Spreading Tree", "Tall Tree", "Broad Tree", "Mature Tree",
    "Rooting Tree", "Young Banyan", "Spreading Banyan", "Leafy Banyan", "Shady Banyan",
    "Grand Banyan", "Great Banyan", "Ancient Banyan", "Mighty Banyan", "Banyan Tree"];
  function treeStageOf(frac) {
    if (frac >= 1) return { stage: 25, next: 1 };
    var x = Math.max(0, frac) * 24;
    return { stage: 1 + Math.floor(x), next: x - Math.floor(x) };
  }
  // Small deterministic random numbers, so the same stage always draws the same tree.
  function hrand(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  var treeCache = {};
  function treeSVG(stage) {
    if (treeCache[stage]) return treeCache[stage];
    var g = stage / 25, GROUND = 156, CX = 100;
    var maxDepth = stage <= 2 ? 0 : Math.min(5, 1 + Math.floor((stage + 1) / 5)); // sapling stem, then 1..5 levels of branches
    var size = 0.3 + 0.7 * Math.pow(g, 0.8);
    var branches = [], tips = [], rootSpots = [];
    function grow(x, y, ang, len, w, depth, path) {
      var x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
      // gentle curve for a natural look
      var bend = (hrand(path + "b") - 0.5) * len * 0.35;
      var mx = (x + x2) / 2 + Math.cos(ang + Math.PI / 2) * bend, my = (y + y2) / 2 + Math.sin(ang + Math.PI / 2) * bend;
      branches.push({ d: "M" + x.toFixed(1) + " " + y.toFixed(1) + "Q" + mx.toFixed(1) + " " + my.toFixed(1) + " " + x2.toFixed(1) + " " + y2.toFixed(1), w: w, depth: depth });
      if (depth >= 1 && depth <= 2) rootSpots.push({ x: mx, y: my, p: path }, { x: x2, y: y2, p: path + "e" });
      if (depth >= maxDepth) { tips.push({ x: x2, y: y2, depth: depth, p: path }); return; }
      tips.push({ x: x2, y: y2, depth: depth, p: path, inner: true });
      var n = depth === 0 ? 3 : 2 + (hrand(path + "n") < 0.55 ? 1 : 0);
      for (var i = 0; i < n; i++) {
        var spread = depth === 0 ? 1.15 : 0.95 - depth * 0.08;            // banyan: wide, flat crown
        var t = n === 1 ? 0 : i / (n - 1) - 0.5;
        var a = ang + t * spread * 2 + (hrand(path + i + "a") - 0.5) * 0.35;
        a = Math.max(-Math.PI + 0.25, Math.min(-0.25, a));                  // keep branches above the horizon
        grow(x2, y2, a, len * (0.7 + hrand(path + i + "l") * 0.14), w * 0.64, depth + 1, path + i);
      }
    }
    grow(CX, GROUND, -Math.PI / 2, (stage <= 2 ? 44 : 38) * size, 2 + 12 * Math.pow(g, 0.9), 0, "r");
    if (stage <= 3) { // a sapling: pairs of leaves along the stem
      var top = tips[0];
      [0.45, 0.7].forEach(function (f, i) { tips.push({ x: CX + (i ? -1 : 1) * 1.5, y: GROUND + (top.y - GROUND) * f, depth: 9, p: "s" + i }); });
    }

    var leafTips = tips.filter(function (t) { return !t.inner || t.depth >= maxDepth - 1; });
    var minX = 999, maxX = -999, minY = 999, maxY = -999;
    leafTips.forEach(function (t) { minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x); minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y); });
    var leafR = 2.2 + 5.2 * g, cluster = 3 + 12 * g, perTip = 2 + Math.round(stage * 0.55);
    // keep the whole crown inside the picture
    var halfW = Math.max(CX - minX, maxX - CX) + cluster + leafR, topY = minY - cluster - leafR;
    var fit = Math.min(1 + 0.8 * (1 - g), 92 / halfW, (GROUND - 6) / (GROUND - topY)); // small trees are drawn a bit closer
    var canopyA = Math.max(0, Math.min(1, (stage - 11) / 13));              // the solid canopy that hides branches

    var svg = '<svg class="tree-svg" viewBox="0 0 200 170" role="img" aria-label="Tree, stage ' + stage + " of 25: " + TREE_STAGES[stage - 1] + '">' +
      "<defs>" +
      '<linearGradient id="tSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sky1"/><stop offset="1" class="sky2"/></linearGradient>' +
      '<linearGradient id="tBark" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="bark1"/><stop offset=".55" class="bark2"/><stop offset="1" class="bark1"/></linearGradient>' +
      '<radialGradient id="tCanopy" cx=".5" cy=".4" r=".6"><stop offset="0" class="leaf3"/><stop offset="1" class="leaf4"/></radialGradient>' +
      "</defs>" +
      '<rect width="200" height="170" fill="url(#tSky)"/>' +
      '<circle class="sun" cx="168" cy="28" r="12"/>' +
      '<ellipse class="hill" cx="40" cy="168" rx="90" ry="24"/><ellipse class="hill" cx="175" cy="170" rx="80" ry="22"/>' +
      '<ellipse class="ground" cx="100" cy="' + (GROUND + 4) + '" rx="' + (30 + 60 * g).toFixed(1) + '" ry="7"/>';

    svg += '<g class="tree-sway"><g transform="translate(' + CX + " " + GROUND + ") scale(" + fit.toFixed(3) + ") translate(" + -CX + " " + -GROUND + ')">';
    // aerial roots (banyan) from stage 16
    if (stage >= 16) {
      var nRoots = Math.min(rootSpots.length, (stage - 15) * 3);
      rootSpots.slice().sort(function (a, b) { return hrand(a.p + "o") - hrand(b.p + "o"); }).slice(0, nRoots).forEach(function (r, i) {
        if (Math.abs(r.x - CX) < 10) return;
        var wig = (hrand(r.p + "w") - 0.5) * 6;
        svg += '<path class="aroot" d="M' + r.x.toFixed(1) + " " + r.y.toFixed(1) + "Q" + (r.x + wig).toFixed(1) + " " + ((r.y + GROUND) / 2).toFixed(1) + " " + (r.x + wig / 2).toFixed(1) + " " + GROUND +
          '" stroke-width="' + (0.8 + (i % 3) * 0.4) + '"/>';
      });
    }
    branches.forEach(function (b) {
      svg += '<path class="branch' + (b.depth === 0 ? " trunk" : "") + '" d="' + b.d + '" stroke-width="' + Math.max(0.8, b.w).toFixed(1) + '"/>';
    });
    if (canopyA > 0) {
      var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      // grows out from the middle of the crown, hiding the inner branches first
      svg += '<g class="canopy">' +
        '<ellipse cx="' + cx.toFixed(1) + '" cy="' + (cy + 4).toFixed(1) + '" rx="' + (((maxX - minX) / 2 + cluster * 0.9) * canopyA).toFixed(1) + '" ry="' + (((maxY - minY) / 2 + cluster * 0.9) * Math.sqrt(canopyA)).toFixed(1) + '" fill="url(#tCanopy)"/>';
      leafTips.forEach(function (t) { svg += '<circle cx="' + (cx + (t.x - cx) * canopyA).toFixed(1) + '" cy="' + (cy + (t.y - cy) * canopyA).toFixed(1) + '" r="' + (cluster * 1.05 * canopyA).toFixed(1) + '" class="leaf4f"/>'; });
      svg += "</g>";
    }
    // leaves: denser and bigger every stage
    var groups = ["", "", ""];
    leafTips.forEach(function (t) {
      for (var i = 0; i < perTip; i++) {
        var ang = hrand(t.p + i + "q") * Math.PI * 2, dist = Math.sqrt(hrand(t.p + i + "d")) * cluster;
        var lx = t.x + Math.cos(ang) * dist, ly = t.y + Math.sin(ang) * dist * 0.8 - cluster * 0.15;
        var r = leafR * (0.6 + hrand(t.p + i + "r") * 0.6), shade = 1 + Math.floor(hrand(t.p + i + "c") * 3);
        groups[i % 3] += '<ellipse cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" rx="' + r.toFixed(1) + '" ry="' + (r * 0.78).toFixed(1) + '" class="leaf' + shade + 'f"/>';
      }
    });
    svg += groups.map(function (gr, i) { return '<g class="lf lf' + i + '">' + gr + "</g>"; }).join("");
    // figs on a grown banyan
    if (stage >= 19) {
      var nFig = (stage - 18) * 4;
      for (var k = 0; k < nFig; k++) {
        var t = leafTips[Math.floor(hrand("fig" + k) * leafTips.length)];
        var fx = t.x + (hrand("fx" + k) - 0.5) * cluster * 1.6, fy = t.y + (hrand("fy" + k) - 0.5) * cluster * 1.2;
        svg += '<circle class="fig" cx="' + fx.toFixed(1) + '" cy="' + fy.toFixed(1) + '" r="1.5"/>';
      }
    }
    svg += "</g></g>";
    // a leaf drifting down now and then
    if (stage >= 4) {
      var ft = leafTips[Math.floor(leafTips.length / 2)];
      svg += '<ellipse class="falling leaf2f" cx="' + (ft.x + 8).toFixed(1) + '" cy="' + ft.y.toFixed(1) + '" rx="2.2" ry="1.4"/>';
    }
    svg += '<ellipse class="grass" cx="100" cy="' + (GROUND + 2) + '" rx="' + (22 + 40 * g).toFixed(1) + '" ry="3"/></svg>';
    return (treeCache[stage] = svg);
  }
  window.CSE_TREE_PREVIEW = function (n) { return treeSVG(Math.max(1, Math.min(25, n | 0))); }; // handy for previewing stages
  function treeCard(s) {
    var frac = s.hours ? s.hoursDone / s.hours : 0;
    var t = treeStageOf(frac), name = TREE_STAGES[t.stage - 1];
    var hoursToNext = t.stage < 25 ? Math.max(0, (t.stage / 24) * s.hours - s.hoursDone) : 0;
    return '<div class="card tree-card"><div class="tree-frame" data-tip="' + esc("Your tree grows with the " + (TM() ? "steps" : "hours of tasks") + " you finish in your selected courses. All of them done = Banyan Tree.") + '">' + treeSVG(t.stage) + "</div>" +
      '<div class="tree-info"><div class="tree-name">' + esc(name) + '</div><div class="muted small">Stage ' + t.stage + " of 25 · " + (frac > 0 && frac < 0.01 ? "<1" : Math.floor(frac * 100)) + "% of " + (TM() ? "steps" : "hours") + " done</div>" +
      (t.stage < 25
        ? '<div class="bar tree-bar" data-tip="' + esc("Next: " + TREE_STAGES[t.stage] + ", about " + fmtHours(Math.ceil(hoursToNext)) + (TM() ? "" : " of tasks") + " away") + '"><span style="width:' + (t.next * 100).toFixed(1) + '%"></span></div>' +
          '<div class="muted small">Next: ' + esc(TREE_STAGES[t.stage]) + " in " + approx(TM() ? Math.ceil(hoursToNext) : hoursToNext) + "</div>"
        : '<div class="small" style="color:var(--done)">Fully grown. Every selected course is done!</div>') +
      "</div></div>";
  }
  function checkTree() {
    if (!D || !S) return;
    var s = dashboardStats(), st = treeStageOf(s.hours ? s.hoursDone / s.hours : 0).stage;
    if (typeof S.treeStage !== "number") { S.treeStage = st; saveState(); return; }
    if (st === S.treeStage) return;
    var grew = st > S.treeStage;
    S.treeStage = st; saveState();
    if (grew) {
      celebrate(0.8); chime(true);
      toast("🌳 Your tree grew: stage " + st + ", " + TREE_STAGES[st - 1] + "!");
    }
    if (route.view === "dashboard") render();
  }

  applyTheme();
  activate();
})();
