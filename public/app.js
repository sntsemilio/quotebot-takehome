// Tienda Nopal, envíos: conversation, live quote progress, the comparison, and "Mis cotizaciones".
// Every status, message and order comes from the server's view (the client never ranks or words a status).
// Every text from the server goes in with textContent: site messages and notes can never inject markup.
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var thread = $("thread"), items = $("items"), empty = $("empty"), title = $("threadTitle");
  var input = $("composer-input"), form = $("composer"), sendBtn = $("send");
  var readonlyBar = $("readonly"), historyEl = $("history"), sidebar = $("sidebar"), scrim = $("scrim"), menuBtn = $("menuBtn");
  var segmented = $("priority"), sheet = $("sheet");
  var narrow = window.matchMedia("(max-width: 860px)");

  // id: the open conversation (null = new); live: it can be continued here; priority: the order the user picked.
  var state = { id: null, live: true, firstMessage: "", token: 0, streams: [], timers: [], blocks: [], priority: null, picked: false, history: [], memories: [] };

  if (document.documentElement.getAttribute("data-replay") === "1") $("replayNote").hidden = false;

  // The thread's bottom padding follows the floating composer's real height (it grows with the text, the read-only
  // bar is taller on phones, and its wrapper includes the safe area): the last content is never under it.
  var composerWrap = document.querySelector(".composer-wrap");
  function fitComposer() { thread.style.setProperty("--composer-h", Math.ceil(composerWrap.getBoundingClientRect().height) + "px"); }
  if (composerWrap && window.ResizeObserver) new ResizeObserver(fitComposer).observe(composerWrap);
  if (composerWrap) fitComposer();

  // ---- small builders ------------------------------------------------------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function icon(name, cls) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#i-" + name);
    svg.appendChild(use);
    return svg;
  }
  function msg(kind, text) {
    var d = el("div", "msg " + kind);
    if (kind.indexOf("user") === 0) d.appendChild(el("span", null, text));
    else if (kind.indexOf("error") >= 0) { d.appendChild(icon("alert")); d.appendChild(el("span", null, text)); }
    else rich(d, text);
    return d;
  }
  // The model writes **bold** sometimes: shown as bold, never as markup (text nodes only).
  function rich(node, text) {
    String(text).split(/(\*\*[^*\n]+\*\*)/).forEach(function (part) {
      if (/^\*\*[^*\n]+\*\*$/.test(part)) node.appendChild(el("strong", null, part.slice(2, -2)));
      else if (part) node.appendChild(document.createTextNode(part));
    });
  }
  function badge(text, iconName) {
    var b = el("span", "badge");
    if (iconName) b.appendChild(icon(iconName, "icon-sm"));
    b.appendChild(document.createTextNode(text));
    return b;
  }
  function scrollToEnd() { thread.scrollTop = thread.scrollHeight; }
  function money(n, cur) { return n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + cur; }
  function setTitle(text) {
    title.textContent = text;
    document.title = (text === "Nueva cotización" ? "Cotizar envío" : text) + " | Tienda Nopal";
  }

  // ---- "Mis cotizaciones" (source list) ------------------------------------
  var GROUPS = ["Hoy", "Ayer", "Esta semana", "Anteriores"];

  function loadHistory() {
    return fetch("/api/conversations")
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (data) {
        state.history = data.conversations || [];
        renderHistory(state.history);
        renderSuggestions();
        var mine = state.history.filter(function (c) { return c.id === state.id; })[0];
        if (mine) setTitle(mine.title);
      })
      .catch(function () {
        historyEl.textContent = "";
        historyEl.appendChild(el("p", "hist-empty", "No se pudo cargar el historial. Recarga la página para intentarlo de nuevo."));
      });
  }

  function renderHistory(list) {
    historyEl.textContent = "";
    if (!list.length) {
      historyEl.appendChild(el("p", "hist-empty", "Aquí aparecerán tus cotizaciones."));
      return;
    }
    GROUPS.forEach(function (g, gi) {
      var inGroup = list.filter(function (c) { return c.group === g; });
      if (!inGroup.length) return;
      var sec = el("section", "hist-group");
      var h = el("h2", null, g);
      h.id = "hist-g" + gi;
      var ul = el("ul");
      ul.setAttribute("aria-labelledby", h.id);
      inGroup.forEach(function (c) {
        var li = el("li");
        var a = el("a", "hist");
        a.href = "/?c=" + encodeURIComponent(c.id);
        a.setAttribute("data-id", c.id);
        if (c.id === state.id) a.setAttribute("aria-current", "page");
        a.appendChild(el("span", "hist-title", c.title));
        a.appendChild(el("span", "hist-line", c.line));
        a.addEventListener("click", function (ev) {
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; // let the browser open a new tab
          ev.preventDefault();
          closeSidebar(false);
          openConversation(c.id, true);
        });
        li.appendChild(a);
        ul.appendChild(li);
      });
      sec.appendChild(h);
      sec.appendChild(ul);
      historyEl.appendChild(sec);
    });
  }

  function markCurrent() {
    Array.prototype.forEach.call(historyEl.querySelectorAll(".hist"), function (a) {
      if (a.getAttribute("data-id") === state.id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  // Up to 3 recent routes from the real history; none when there is no history.
  function renderSuggestions() {
    var box = $("suggestions");
    box.textContent = "";
    var seen = {};
    state.history.filter(function (c) {
      if (!c.routeZips) return false;
      var k = c.routeZips.origin + ">" + c.routeZips.destination;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).slice(0, 3).forEach(function (c) {
      var b = el("button", "suggestion");
      b.type = "button";
      b.appendChild(icon("clock"));
      b.appendChild(document.createTextNode(c.route));
      b.setAttribute("aria-label", "Escribir la ruta " + c.route + " en el mensaje");
      b.addEventListener("click", function () {
        input.value = "De " + c.routeZips.origin + " a " + c.routeZips.destination + ", ";
        syncSend();
        autosize();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      box.appendChild(b);
    });
  }

  // ---- thread --------------------------------------------------------------
  function stopLive() {
    state.streams.forEach(function (es) { es.close(); });
    state.timers.forEach(clearTimeout);
    state.streams = [];
    state.timers = [];
    state.blocks = [];
    state.token++;
  }

  function setMode(live) {
    state.live = live;
    form.hidden = !live;
    readonlyBar.hidden = live;
  }

  function newQuote(prefill, push) {
    stopLive();
    state.id = null;
    state.firstMessage = "";
    if (state.priority === "by_date") state.priority = null; // a new quote has no deadline yet; the others carry over
    state.picked = false; // shown, but it travels only if she picks it again
    items.textContent = "";
    empty.hidden = false;
    setMode(true);
    setTitle("Nueva cotización");
    renderPriority();
    input.value = prefill || "";
    syncSend();
    autosize();
    if (push) history.pushState({}, "", "/");
    markCurrent();
    // Focus only after an action: on a phone, focusing at page load would open the keyboard by itself.
    if (push) {
      input.focus();
      if (prefill) input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function openConversation(id, push) {
    stopLive();
    state.priority = null;
    state.picked = false;
    var token = state.token;
    return fetch("/api/conversations/" + encodeURIComponent(id))
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(function (d) {
        if (token !== state.token) return;
        if (!d) {
          newQuote("", false);
          empty.hidden = true;
          items.appendChild(msg("assistant error", "No encontramos esa cotización en el servidor. Puedes empezar una nueva aquí."));
          return;
        }
        state.id = d.id;
        state.firstMessage = d.firstMessage;
        if (push) history.pushState({ id: d.id }, "", "/?c=" + encodeURIComponent(d.id));
        items.textContent = "";
        empty.hidden = true;
        setTitle(d.title);
        d.items.forEach(function (it) {
          if (it.kind !== "quote") { items.appendChild(msg(it.kind, it.text)); return; }
          var block = quoteBlock(it.runId);
          block.quotedLabel = it.quotedLabel;
          items.appendChild(block.root);
          if (it.view && !it.view.finished && !it.view.interrupted && d.live) { watchQuote(it.runId, block); return; }
          if (!it.view) { block.progress.textContent = "No encontramos los datos de esta cotización en el servidor."; return; }
          block.view = it.view;
          renderQuote(block);
          if (it.note) { block.noted = true; block.root.after(msg("assistant", it.note)); }
        });
        setMode(Boolean(d.live));
        renderPriority();
        markCurrent();
        thread.scrollTop = 0;
        title.focus();
      })
      .catch(function () {
        if (token !== state.token) return;
        items.textContent = "";
        empty.hidden = true;
        items.appendChild(msg("assistant error", "No se pudo abrir la cotización porque el servidor no respondió. Revisa que siga encendido y vuelve a intentarlo."));
      });
  }

  function send(text) {
    var token = state.token;
    empty.hidden = true;
    items.appendChild(msg("user", text));
    var pending = msg("assistant pending", "Revisando tu mensaje…");
    items.appendChild(pending);
    scrollToEnd();
    sendBtn.disabled = true;
    var body = state.id ? { conversationId: state.id, message: text } : { message: text };
    // Only a priority she picked in the control travels (an adopted one does not; a deadline is the model's
    // to set, so "Llega a tiempo" does not either).
    if (state.picked && (state.priority === "cheapest" || state.priority === "fastest")) body.priority = state.priority;
    var status = 0;
    fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { status = r.status; return r.json(); })
      .then(function (data) {
        if (token !== state.token) return;
        pending.remove();
        if (status === 409) {
          items.appendChild(msg("assistant error", data.answer));
          setMode(false);
          return;
        }
        if (status !== 200) throw new Error();
        if (!state.id) {
          state.id = data.conversationId;
          state.firstMessage = text;
          history.replaceState({ id: state.id }, "", "/?c=" + encodeURIComponent(state.id));
        }
        items.appendChild(msg(data.error ? "assistant error" : "assistant", data.answer || "No hubo respuesta. Envía tu mensaje otra vez."));
        if (data.runId) {
          var block = quoteBlock(data.runId);
          block.adopt = true; // its first view sets the control (see refresh)
          items.appendChild(block.root);
          watchQuote(data.runId, block);
        }
        scrollToEnd();
        loadHistory();
      })
      .catch(function () {
        if (token !== state.token) return;
        pending.remove();
        items.appendChild(msg("assistant error", "No se pudo conectar con el servidor. Revisa que siga encendido y vuelve a enviar el mensaje."));
        if (!input.value) input.value = text;
      })
      .then(function () { syncSend(); input.focus(); });
  }

  // ---- priority (segmented control; the server ranks) -------------------------
  var PRIORITIES = [["cheapest", "Más barato"], ["fastest", "Más rápido"], ["by_date", "Llega a tiempo"]];

  // Under the composer, visible before quoting. What the user picks reorders the visible quote (the server
  // ranks) and goes with the next message as its priority; "Llega a tiempo" only when a visible quote has a deadline.
  // Hidden only on a read-only conversation without prices.
  function renderPriority() {
    var views = state.blocks.map(function (b) { return b.view; }).filter(function (v) { return v && v.ranked && v.ranked.length; });
    if (!views.length && !state.live) { segmented.textContent = ""; segmented.hidden = true; return; }
    var current = state.priority || (views[0] && views[0].priority) || "cheapest";
    var options = PRIORITIES.filter(function (p) { return p[0] !== "by_date" || views.some(function (v) { return v.canRankByDate; }); });
    // Same options as shown: update the existing buttons in place, so a keyboard user keeps focus.
    var shown = Array.prototype.map.call(segmented.children, function (b) { return b.getAttribute("data-priority"); });
    if (shown.join() === options.map(function (p) { return p[0]; }).join()) {
      Array.prototype.forEach.call(segmented.children, function (b) {
        var on = b.getAttribute("data-priority") === current;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      });
      segmented.hidden = false;
      return;
    }
    var hadFocus = segmented.contains(document.activeElement);
    segmented.textContent = "";
    options.forEach(function (p) {
      var b = el("button", null, p[1]);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("data-priority", p[0]);
      b.setAttribute("aria-checked", String(p[0] === current));
      b.tabIndex = p[0] === current ? 0 : -1;
      b.addEventListener("click", function () { choosePriority(p[0]); });
      b.addEventListener("keydown", function (ev) {
        var i = options.indexOf(p);
        var next = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? i + 1 : ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? i - 1 : null;
        if (next === null) return;
        ev.preventDefault();
        var target = options[(next + options.length) % options.length][0];
        choosePriority(target);
      });
      segmented.appendChild(b);
    });
    segmented.hidden = false;
    if (hadFocus) { var checked = segmented.querySelector("[aria-checked='true']"); if (checked) checked.focus(); }
  }

  function choosePriority(p) {
    // Her choice, so it goes with the next message (adoption never sets it), even when she taps the option
    // already shown.
    state.picked = true;
    if (p === (state.priority || "")) { state.priority = p; return; }
    state.priority = p;
    state.blocks.forEach(function (b) { b.adopt = false; }); // her pick wins over a view still on its way
    renderPriority();
    var focus = segmented.querySelector("[aria-checked='true']");
    if (focus) focus.focus();
    state.blocks.forEach(function (b) { if (b.view) refresh(b); });
  }

  // ---- one quote: live progress, then the comparison ----------------------
  var ACTIVITY = {
    view_page: "Revisando la página", fill_field: "Llenando el formulario", click: "Eligiendo en la página", wait_for: "Esperando a la página",
    wait_ready: "Esperando a que cargue la página", capture_evidence: "Guardando la captura", report_price: "Comprobando un precio",
    close_carrier: "Terminando", scroll: "Recorriendo la página", choose_option: "Eligiendo una opción"
  };
  var DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  var MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

  function quoteBlock(runId) {
    var root = el("section", "quote");
    root.setAttribute("aria-label", "Comparación de precios");
    var head = el("div", "quote-head");
    var when = el("p", "quote-when");
    var progress = el("p", "quote-progress");
    progress.setAttribute("role", "status"); // polite live region: progress from the server's view
    // Replay mode only. The server's view says the prices below are a recording, not an answer to this request.
    var replay = el("p", "quote-replay");
    replay.hidden = true;
    replay.appendChild(icon("alert"));
    var replayText = el("span");
    replay.appendChild(replayText);
    head.appendChild(replay);
    head.appendChild(when);
    head.appendChild(progress);
    var body = el("div");
    root.appendChild(head);
    root.appendChild(body);
    var block = { runId: runId, root: root, replay: replay, replayText: replayText, when: when, progress: progress, body: body, view: null, live: false, activity: {}, expanded: {}, quotedLabel: null, noted: false };
    state.blocks.push(block);
    return block;
  }

  // A new quote is fetched in the order the server gave it until the control adopts that order.
  function quoteUrl(block) {
    var p = block.adopt ? null : state.priority;
    return "/api/quotes/" + encodeURIComponent(block.runId) + (p ? "?priority=" + p : "");
  }

  // Fetches the server's view of this quote and repaints it.
  function refresh(block) {
    var token = state.token;
    return fetch(quoteUrl(block))
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (v) {
        if (token !== state.token) return null;
        block.view = v;
        if (v.quotedLabel) block.quotedLabel = v.quotedLabel;
        // A new quote's first view (once its request is known) sets the control to the priority the server
        // ranked it with: if the message asked for another one, the message wins. Later picks in the control rule.
        var adopted = false;
        if (block.adopt && v.request) {
          block.adopt = false;
          adopted = state.priority !== v.priority;
          state.priority = v.priority;
        }
        renderQuote(block);
        renderPriority();
        if (adopted) state.blocks.forEach(function (b) { if (b !== block && b.view) refresh(b); });
        return v;
      });
  }

  function watchQuote(runId, block) {
    block.live = true;
    block.when.textContent = "Cotizando ahora";
    block.progress.textContent = "Abriendo las páginas de las paqueterías…";
    var es = new EventSource("/api/quotes/" + encodeURIComponent(runId) + "/events");
    state.streams.push(es);
    var finished = false;
    var pendingRefresh = null;
    var soon = function () {
      if (pendingRefresh) return;
      pendingRefresh = setTimeout(function () { pendingRefresh = null; refresh(block).catch(function () {}); }, 250);
      state.timers.push(pendingRefresh);
    };
    ["run.started", "carrier.started", "carrier.skipped", "carrier.closed", "price.verified", "total.computed", "request.invalid"].forEach(function (t) {
      es.addEventListener(t, soon);
    });
    es.addEventListener("step.executed", function (m) {
      var e = JSON.parse(m.data);
      block.activity[e.carrierId] = ACTIVITY[e.tool] || "Trabajando en la página";
      if (block.view) renderQuote(block);
    });
    var end = function () {
      if (finished) return;
      finished = true;
      es.close();
      waitForNote(block, 0, state.token);
    };
    es.addEventListener("run.finished", end);
    es.onerror = end;
  }

  // After the run: the final view, then the note once it is written (it takes a few seconds).
  function waitForNote(block, attempt, token) {
    refresh(block)
      .then(function (v) {
        if (!v || token !== state.token) return;
        if (v.finished && !v.note && attempt < 20) {
          state.timers.push(setTimeout(function () { waitForNote(block, attempt + 1, token); }, 1000));
          return;
        }
        block.live = false;
        renderQuote(block);
        if (v.note && !block.noted) {
          block.noted = true;
          block.root.after(msg("assistant", v.note));
        }
        loadHistory();
      })
      .catch(function () {
        if (token !== state.token) return;
        block.progress.textContent = "No se pudo cargar el resultado. Ábrelo desde Mis cotizaciones para verlo.";
      });
  }

  function vatBadge(v) { return v === true ? "IVA incluido" : v === false ? "IVA no incluido" : "IVA no indicado"; }
  function vatText(v) { return v === true ? "Incluido, según el sitio" : v === false ? "No incluido, según el sitio" : "El sitio no dice si incluye IVA"; }
  function arrival(r) {
    var d = r.delivery;
    if (!d) return "";
    if (d.source === "carrier_terms" && d.label) return d.label; // the carrier's published term, in words
    if (d.arrivalDate) {
      var dt = new Date(d.arrivalDate + "T12:00:00Z");
      return "Llega " + DAYS[dt.getUTCDay()] + " " + dt.getUTCDate() + " " + MONTHS[dt.getUTCMonth()];
    }
    var days = d.minDays === d.maxDays ? String(d.maxDays) : d.minDays + " a " + d.maxDays;
    return days + (d.maxDays === 1 ? " día" : " días");
  }
  // "FedEx Nacional Económico", never "FedEx México, FedEx Nacional Económico"; "Estafeta Terrestre" when the
  // service name does not carry the brand.
  function optionName(carrier, service) {
    var brand = (carrier || "").split(/\s+/)[0];
    return service.toLowerCase().indexOf(brand.toLowerCase()) === 0 ? service : brand + " " + service;
  }

  function renderQuote(block) {
    var v = block.view;
    if (!v) return;
    block.replay.hidden = !v.replayNotice;
    block.replayText.textContent = v.replayNotice || "";
    block.when.textContent = block.live && !v.finished && !v.interrupted ? "Cotizando ahora" : (block.quotedLabel || "");
    block.progress.textContent = v.progress || "";
    var body = block.body;
    // A repaint while the quote runs must not drop a keyboard user's focus: remember which row
    // had it and give it back after rebuilding.
    var focusedKey = body.contains(document.activeElement) ? document.activeElement.getAttribute("data-key") : null;
    body.textContent = "";
    paintQuote(block, v, body);
    if (focusedKey) {
      var again = body.querySelector("[data-key='" + focusedKey.replace(/'/g, "") + "']");
      if (again) again.focus();
    }
  }

  function paintQuote(block, v, body) {
    if (v.requestErrors && v.requestErrors.length) {
      body.appendChild(el("p", "group-title", "La solicitud no fue válida: " + v.requestErrors.join("; ")));
      return;
    }
    var names = {};
    (v.carriers || []).forEach(function (c) { names[c.carrierId] = c.name; });
    var ranked = v.ranked || [];
    var count = (v.request && v.request.count) || 1;

    if (ranked.length) {
      body.appendChild(el("h3", "group-title", "Primera opción"));
      var first = el("ul", "group first");
      first.appendChild(optionRow(block, ranked[0], names, count));
      body.appendChild(first);
      if (ranked.length > 1) {
        body.appendChild(el("h3", "group-title", "Otras opciones"));
        var rest = el("ul", "group");
        ranked.slice(1).forEach(function (r) { rest.appendChild(optionRow(block, r, names, count)); });
        body.appendChild(rest);
      }
      zipNotes(body, v);
    }

    // While it runs: every carrier with its activity; afterwards only the ones without a price.
    var running = block.live && !v.finished && !v.interrupted;
    var carriers = (v.carriers || []).filter(function (c) { return running || c.status !== "quoted"; });
    if (carriers.length) {
      body.appendChild(el("h3", "group-title", running ? "Paqueterías" : "Sin precio"));
      var ul = el("ul", "group");
      carriers.forEach(function (c) { ul.appendChild(carrierRow(block, c, running, v.shipmentText)); });
      body.appendChild(ul);
    }
    if (!ranked.length) {
      if (v.finished) body.appendChild(el("p", "group-foot", "Ninguna paquetería dio un precio esta vez."));
      zipNotes(body, v);
    }
  }

  function optionRow(block, r, names, count) {
    var p = r.price;
    var key = r.carrierId + ":" + (p.seq || p.priceText + p.service);
    var li = el("li");
    var detailId = "d-" + block.runId.replace(/\W/g, "") + "-" + String(key).replace(/\W/g, "");
    var btn = el("button", "row");
    btn.type = "button";
    btn.setAttribute("aria-expanded", String(Boolean(block.expanded[key])));
    btn.setAttribute("aria-controls", detailId);
    btn.setAttribute("data-key", String(key).replace(/'/g, ""));
    var left = el("span");
    left.appendChild(el("span", "row-name", optionName(names[r.carrierId], p.service)));
    var badges = el("span", "row-badges");
    var arr = arrival(r);
    if (arr) badges.appendChild(badge(arr));
    if (r.meetsDeadline === true) badges.appendChild(badge("Llega a tiempo", "check"));
    if (r.meetsDeadline === false) badges.appendChild(badge("No llega a tiempo", "alert"));
    badges.appendChild(badge(vatBadge(p.includesVAT)));
    left.appendChild(badges);
    var price = el("span", "row-price");
    if (count > 1 && p.total) {
      price.appendChild(document.createTextNode(money(p.total.total, p.currency)));
      price.appendChild(el("small", null, count + " cajas"));
    } else {
      price.appendChild(document.createTextNode(p.priceText + " " + p.currency));
    }
    btn.appendChild(left);
    btn.appendChild(price);
    btn.appendChild(icon("chevron", "chevron"));
    btn.addEventListener("click", function () {
      block.expanded[key] = !block.expanded[key];
      btn.setAttribute("aria-expanded", String(block.expanded[key]));
      detail.hidden = !block.expanded[key];
    });
    li.appendChild(btn);

    var detail = el("div", "detail");
    detail.id = detailId;
    detail.hidden = !block.expanded[key];
    var dl = el("dl", "facts");
    var fact = function (label, value) { dl.appendChild(el("dt", null, label)); var dd = el("dd"); if (typeof value === "string") dd.textContent = value; else dd.appendChild(value); dl.appendChild(dd); };
    fact(count > 1 ? "Precio por caja en el sitio" : "Precio en el sitio", p.priceText + " " + p.currency);
    if (count > 1 && p.total) fact("Total de " + count + " cajas", count + " × " + money(p.amount, p.currency) + " = " + money(p.total.total, p.currency));
    var delivery = p.deliveryDays || "El sitio no indica la entrega";
    if (!p.deliveryDays && r.delivery && r.delivery.source === "service_name") delivery += "; el tiempo sale del nombre del servicio";
    fact("Entrega según el sitio", delivery);
    // The carrier's published term for this service, said as such (never as this quote's date).
    if (r.delivery && r.delivery.source === "carrier_terms" && r.delivery.label) {
      fact("Plazo publicado por " + brandOf(names[r.carrierId]), r.delivery.label);
    }
    fact("IVA", r.breakdown && p.includesVAT === true ? "Incluido, según el desglose del sitio" : vatText(p.includesVAT));
    // The site's own breakdown, in the page's order, as the server's view gives it (no arithmetic here);
    // the other notices go below it.
    if (r.breakdown && r.breakdown.lines.length) {
      var lines = el("ul", "breakdown");
      r.breakdown.lines.forEach(function (n) { lines.appendChild(el("li", null, n)); });
      fact(r.breakdown.caption, lines);
    }
    var notices = r.notices || p.siteNotes || [];
    if (notices.length) {
      var notes = el("ul");
      notices.forEach(function (n) { notes.appendChild(el("li", null, n)); });
      fact("Avisos del sitio", notes);
    }
    if (p.optionalCharges && p.optionalCharges.length) {
      var charges = el("ul");
      p.optionalCharges.forEach(function (o) { charges.appendChild(el("li", null, o.name + ": " + o.amountText)); });
      fact("Cargos opcionales", charges);
    }
    detail.appendChild(dl);
    if (p.image) {
      var thumb = el("button", "thumb");
      thumb.type = "button";
      var img = el("img");
      img.src = "/" + p.image.replace(/^\/+/, "");
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
      thumb.appendChild(icon("photo"));
      thumb.appendChild(document.createTextNode("Ver la captura de la página"));
      thumb.addEventListener("click", function () { openSheet(names[r.carrierId], p, block.quotedLabel, thumb, r.delivery); });
      detail.appendChild(thumb);
    }
    li.appendChild(detail);
    return li;
  }

  // A carrier that closed without a price for a reason the user can work around (the server decides which:
  // view.manualQuote) gets a link to quote on its own site and the shipment's data to paste there. Nothing is sent to
  // the site and nothing goes in its URL.
  function manualActions(block, c, shipment) {
    var box = el("div", "carrier-actions");
    var link = el("a", "plain-button");
    link.href = c.manualQuote.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.appendChild(icon("external", "icon-sm"));
    link.appendChild(document.createTextNode(c.manualQuote.label));
    link.appendChild(el("span", "visually-hidden", " (se abre en una pestaña nueva)"));
    box.appendChild(link);
    if (!shipment) return box;
    block.manual = block.manual || {};
    var copy = el("button", "plain-button");
    copy.type = "button";
    copy.appendChild(icon("copy", "icon-sm"));
    copy.appendChild(document.createTextNode("Copiar datos del envío"));
    var status = el("span", "copy-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    box.appendChild(copy);
    box.appendChild(status);
    var area = null;
    // No clipboard (or it refused): the text, selected, to copy by hand. Kept across repaints of this quote.
    var showText = function (focus) {
      if (!area) {
        area = el("textarea", "shipment-text");
        area.readOnly = true;
        area.rows = shipment.split("\n").length;
        area.value = shipment;
        area.setAttribute("aria-label", "Datos del envío");
        box.parentNode.appendChild(area);
      }
      if (focus) { area.focus(); area.select(); }
    };
    copy.addEventListener("click", function () {
      var manual = function () {
        block.manual[c.carrierId] = true;
        showText(true);
        status.textContent = "Ya está seleccionado: cópialo con Ctrl+C o ⌘C.";
      };
      if (!navigator.clipboard || !navigator.clipboard.writeText) return manual();
      navigator.clipboard.writeText(shipment).then(function () {
        status.textContent = "";
        setTimeout(function () { status.textContent = "Datos copiados"; }, 50); // re-announced on every copy
      }, manual);
    });
    if (block.manual[c.carrierId]) setTimeout(function () { showText(false); }, 0);
    return box;
  }

  function carrierRow(block, c, running, shipment) {
    var li = el("li", "carrier st-" + c.status);
    if (running && (c.status === "running" || c.status === "pending")) {
      var sp = icon("spinner", "spinner");
      li.appendChild(sp);
    } else {
      var dot = el("span", "dot");
      dot.setAttribute("aria-hidden", "true");
      li.appendChild(dot);
    }
    li.appendChild(el("span", "carrier-name", c.name));
    li.appendChild(el("span", "carrier-label", c.label));
    var text = running && c.status === "running" ? (block.activity[c.carrierId] || c.message) : c.message;
    if (text) li.appendChild(el("span", "carrier-msg", text));
    if (c.manualQuote) li.appendChild(manualActions(block, c, shipment));
    return li;
  }

  // Postal codes: what a site that quoted showed next to them, or a doubt to check.
  function zipNotes(body, v) {
    var ul = el("ul", "group-foot");
    var nameOf = function (id) { var c = (v.carriers || []).filter(function (x) { return x.carrierId === id; })[0]; return c ? c.name : id; };
    (v.zips || []).forEach(function (z) {
      var role = z.role === "origin" ? "Origen" : "Destino";
      var li = el("li");
      var rejected = z.rejectedBy || [];
      if (rejected.length) {
        li.appendChild(icon("alert", "icon-sm warn"));
        // Without the site's words it is not a rejection: the form did not continue. When another site
        // recognized the code in this quote, that is said and nothing asks to check it.
        var seen = z.seen && z.seen[0];
        var ask = !seen || rejected.some(function (r) { return r.siteMessage; });
        li.appendChild(el("span", null, rejected.map(function (r) {
          return role + " " + z.zip + ": " + (r.siteMessage
            ? nameOf(r.carrierId) + " no lo reconoce («" + r.siteMessage + "»)"
            : "el formulario de " + nameOf(r.carrierId) + " no continuó con este CP y su página no mostró ningún error");
        }).join(". ") + (seen ? ". " + nameOf(seen.carrierId) + " sí lo reconoció («" + seen.text + "»)" : "") + (ask ? ". Revísalo." : ".")));
      } else if (z.seen.length) {
        li.appendChild(icon("check", "icon-sm ok"));
        li.appendChild(el("span", null, role + " " + z.zip + ": " + nameOf(z.seen[0].carrierId) + " mostró «" + z.seen[0].text + "»."));
      } else if ((v.ranked || []).length) {
        li.appendChild(icon("alert", "icon-sm warn"));
        li.appendChild(el("span", null, role + " " + z.zip + ": ningún sitio confirmó este código postal. Revísalo."));
      } else return;
      ul.appendChild(li);
    });
    if (ul.children.length) body.appendChild(ul);
  }

  // ---- evidence sheet ----------------------------------------------------------
  var sheetOpener = null;
  function brandOf(name) { return String(name || "").replace(/\s+México$/, ""); }
  function openSheet(carrier, p, quotedLabel, opener, delivery) {
    // A published term is named as such, with a link to where the carrier publishes it.
    var terms = $("sheetTerms");
    terms.textContent = "";
    terms.hidden = !(delivery && delivery.source === "carrier_terms" && delivery.label);
    if (!terms.hidden) {
      terms.appendChild(document.createTextNode(delivery.label + ". Plazo publicado por " + brandOf(carrier) + " para este servicio, no una fecha de esta cotización. "));
      var a = el("a", null, "Ver dónde lo publica");
      a.href = delivery.sourceUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      terms.appendChild(a);
    }
    sheetOpener = opener;
    $("sheetTitle").textContent = "Captura de " + (carrier || "la paquetería");
    $("sheetSub").textContent = p.service + ": " + p.priceText + " " + p.currency + (quotedLabel ? ". " + quotedLabel : "");
    var img = $("sheetImg");
    img.src = "/" + p.image.replace(/^\/+/, "");
    img.alt = "Página de " + (carrier || "la paquetería") + " donde aparece " + p.priceText;
    if (sheet.showModal) sheet.showModal(); else sheet.setAttribute("open", "");
    $("sheetClose").focus();
  }
  $("sheetClose").addEventListener("click", function () { sheet.close(); });
  sheet.addEventListener("close", function () { if (sheetOpener) sheetOpener.focus(); });
  sheet.addEventListener("click", function (ev) { if (ev.target === sheet) sheet.close(); }); // click on the backdrop

  // ---- composer ----------------------------------------------------------
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  function syncSend() { sendBtn.disabled = !input.value.trim(); }
  input.addEventListener("input", function () { autosize(); syncSend(); updateMention(); });
  input.addEventListener("click", updateMention);
  input.addEventListener("blur", function () { setTimeout(closeMention, 120); });
  input.addEventListener("keydown", function (ev) {
    if (mentionKey(ev)) return;
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    input.value = "";
    autosize();
    send(text);
  });

  // ---- # memories in the composer (listbox + aria-activedescendant, count announced) ----
  // Typing # opens the memories that match (name, kind and short value). Up/Down move, Enter or Tab insert
  // "#slug ", Escape closes. The server resolves the slug when the message is sent; the client only inserts text.
  var mentionList = $("mentionList"), mentionStatus = $("mentionStatus");
  var mention = { open: false, items: [], active: 0, start: 0 };
  function fold(t) { return String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function mentionQuery() {
    var caret = input.selectionStart;
    if (caret !== input.selectionEnd) return null;
    var m = input.value.slice(0, caret).match(/(^|[^\p{L}\p{N}_#-])#([a-z0-9-]*)$/iu);
    return m ? { query: fold(m[2]), start: caret - m[2].length - 1 } : null;
  }
  function updateMention() {
    var q = state.memories.length ? mentionQuery() : null;
    if (!q) return closeMention();
    var items = state.memories.filter(function (m) {
      return m.token.indexOf(q.query) === 0 || fold(m.name).indexOf(q.query.replace(/-/g, " ")) >= 0 || m.token.indexOf("-" + q.query) >= 0;
    }).slice(0, 8);
    if (!items.length) return closeMention();
    var same = mention.open && items.map(function (m) { return m.token; }).join() === mention.items.map(function (m) { return m.token; }).join();
    var countChanged = !mention.open || mention.items.length !== items.length;
    mention = { open: true, items: items, active: same ? mention.active : 0, start: q.start };
    paintMention();
    if (countChanged) {
      mentionStatus.textContent = (items.length === 1 ? "1 memoria" : items.length + " memorias") + ". Usa las flechas para elegir";
    }
  }
  function paintMention() {
    mentionList.textContent = "";
    mention.items.forEach(function (m, i) {
      var li = el("li", "mention" + (m.empty ? " is-empty" : ""));
      li.id = "mention-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === mention.active));
      var main = el("span", "mention-main");
      main.appendChild(el("span", "mention-name", m.name));
      main.appendChild(el("span", "mention-token", "#" + m.token));
      li.appendChild(main);
      var meta = el("span", "mention-meta");
      meta.appendChild(el("span", "mention-kind", m.kindLabel));
      meta.appendChild(el("span", "mention-value", m.short));
      li.appendChild(meta);
      li.addEventListener("mousedown", function (ev) { ev.preventDefault(); chooseMention(i); });
      mentionList.appendChild(li);
    });
    mentionList.hidden = false;
    input.setAttribute("aria-activedescendant", "mention-" + mention.active);
    var act = $("mention-" + mention.active);
    if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
  }
  function closeMention() {
    if (!mention.open && mentionList.hidden) return;
    mention.open = false;
    mentionList.hidden = true;
    mentionList.textContent = "";
    mentionStatus.textContent = "";
    input.removeAttribute("aria-activedescendant");
  }
  function chooseMention(i) {
    var m = mention.items[i];
    if (!m) return;
    var caret = input.selectionStart;
    var before = input.value.slice(0, mention.start) + "#" + m.token + " ";
    var after = input.value.slice(caret).replace(/^[a-z0-9-]*\s?/i, "");
    input.value = before + after;
    input.setSelectionRange(before.length, before.length);
    closeMention();
    autosize();
    syncSend();
    input.focus();
  }
  // Returns true when the key was for the open menu (so Enter does not send the message).
  function mentionKey(ev) {
    if (!mention.open || ev.isComposing) return false;
    var n = mention.items.length;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      mention.active = (mention.active + (ev.key === "ArrowDown" ? 1 : -1) + n) % n;
      paintMention();
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      chooseMention(mention.active);
      return true;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeMention();
      return true;
    }
    return false;
  }

  // ---- "Memorias" in the sidebar, edited in a sheet ------------------------------
  var memSection = $("memories"), memList = $("memList"), memSheet = $("memSheet"), memForm = $("memForm");
  var KIND_GROUPS = [["tienda", "Tienda"], ["caja", "Cajas"], ["destino", "Destinos"]];
  var memEditing = null, memOpener = null, memConfirm = false;

  function loadMemories() {
    return fetch("/api/memorias")
      .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) {
        if (!d) { memSection.hidden = true; state.memories = []; return; } // no memories on this server
        state.memories = d.memories || [];
        memSection.hidden = false;
        renderMemories();
      })
      .catch(function () {
        memSection.hidden = false;
        memList.textContent = "";
        memList.appendChild(el("p", "hist-empty", "No se pudieron cargar las memorias. Recarga la página para intentarlo de nuevo."));
      });
  }

  function renderMemories() {
    memList.textContent = "";
    if (!state.memories.length) {
      memList.appendChild(el("p", "hist-empty", "Guarda el CP de tu tienda y tus cajas para cotizar con #."));
      return;
    }
    KIND_GROUPS.forEach(function (g) {
      var inGroup = state.memories.filter(function (m) { return m.kind === g[0]; });
      if (!inGroup.length) return;
      var sec = el("section", "mem-group");
      var h = el("h3", null, g[1]);
      h.id = "mem-g-" + g[0];
      var ul = el("ul");
      ul.setAttribute("aria-labelledby", h.id);
      inGroup.forEach(function (m) {
        var li = el("li");
        var b = el("button", "mem" + (m.empty ? " is-empty" : ""));
        b.type = "button";
        var text = el("span", "mem-text");
        text.appendChild(el("span", "mem-name", "#" + m.token));
        text.appendChild(el("span", "mem-value", m.short));
        b.appendChild(text);
        if (m.empty) b.appendChild(el("span", "mem-action", "Completar"));
        b.setAttribute("aria-label", "#" + m.token + ", " + m.short + (m.empty ? ". Completar" : ". Editar"));
        b.addEventListener("click", function () { openMemory(m, b); });
        li.appendChild(b);
        ul.appendChild(li);
      });
      sec.appendChild(h);
      sec.appendChild(ul);
      memList.appendChild(sec);
    });
  }

  function slugOf(name) { return fold(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function syncKind() {
    var kind = $("memKind").value;
    Array.prototype.forEach.call(memForm.querySelectorAll("[data-kinds]"), function (f) {
      f.hidden = f.getAttribute("data-kinds").split(" ").indexOf(kind) < 0;
    });
  }
  function syncSlug() { var s = slugOf($("memName").value); $("memSlug").textContent = s ? "Se usa como #" + s : "Escribe un nombre para usarla con #"; }
  function clearErrors() {
    Array.prototype.forEach.call(memForm.querySelectorAll(".field-error"), function (e) { e.textContent = ""; });
    Array.prototype.forEach.call(memForm.querySelectorAll("[aria-invalid]"), function (e) { e.removeAttribute("aria-invalid"); });
    $("memError").textContent = "";
    $("memNote").textContent = "";
  }

  // The full memory (values included) comes from the list's fields the server gave; the sheet asks the server again
  // only through POST, which validates.
  function openMemory(m, opener) {
    memOpener = opener;
    memEditing = m;
    memConfirm = false;
    clearErrors();
    memForm.reset();
    $("memSheetTitle").textContent = m ? (m.empty ? "Completar #" + m.token : "Editar #" + m.token) : "Nueva memoria";
    $("memKind").value = m ? m.kind : "caja";
    $("memName").value = m ? m.name : "";
    var v = (m && m.values) || {};
    $("memZip").value = v.zip || "";
    $("memCustomer").value = v.customerType || "";
    $("memLength").value = v.lengthCm || "";
    $("memWidth").value = v.widthCm || "";
    $("memHeight").value = v.heightCm || "";
    $("memWeight").value = v.weightKg || "";
    $("memDelete").hidden = !m;
    $("memDelete").textContent = "Borrar";
    syncKind();
    syncSlug();
    if (memSheet.showModal) memSheet.showModal(); else memSheet.setAttribute("open", "");
    var first = m ? (m.kind === "caja" ? $("memLength") : $("memZip")) : $("memName");
    first.focus();
  }

  $("memKind").addEventListener("change", function () { syncKind(); clearErrors(); });
  $("memName").addEventListener("input", syncSlug);
  $("memAdd").addEventListener("click", function () { openMemory(null, $("memAdd")); });
  $("memClose").addEventListener("click", function () { memSheet.close(); });
  $("memCancel").addEventListener("click", function () { memSheet.close(); });
  memSheet.addEventListener("close", function () { if (memOpener && document.contains(memOpener)) memOpener.focus(); });
  memSheet.addEventListener("click", function (ev) { if (ev.target === memSheet) memSheet.close(); });

  memForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    clearErrors();
    var kind = $("memKind").value;
    var body = { kind: kind, name: $("memName").value };
    if (memEditing) body.previousSlug = memEditing.token;
    if (kind !== "caja") body.zip = $("memZip").value.trim();
    if (kind === "tienda") body.customerType = $("memCustomer").value;
    if (kind === "caja") {
      body.lengthCm = $("memLength").value; body.widthCm = $("memWidth").value; body.heightCm = $("memHeight").value; body.weightKg = $("memWeight").value;
    }
    $("memSave").disabled = true;
    fetch("/api/memorias", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 400) {
          var firstBad = null;
          (res.d.errors || []).forEach(function (e) {
            var slot = $("err-" + e.field);
            if (!slot) { $("memError").textContent = e.message; return; }
            slot.textContent = e.message;
            var field = memForm.querySelector("[name='" + e.field + "']");
            if (field) { field.setAttribute("aria-invalid", "true"); firstBad = firstBad || field; }
          });
          if (firstBad) firstBad.focus();
          return;
        }
        if (res.status !== 200) throw new Error();
        memSheet.close();
        return loadMemories();
      })
      .catch(function () { $("memError").textContent = "No se pudo guardar porque el servidor no respondió. Vuelve a intentarlo."; })
      .then(function () { $("memSave").disabled = false; });
  });

  // Two steps: the first click says what happens; the second deletes. Past quotes keep the values they used.
  $("memDelete").addEventListener("click", function () {
    if (!memEditing) return;
    if (!memConfirm) {
      memConfirm = true;
      $("memDelete").textContent = "Borrar #" + memEditing.token + " definitivamente";
      $("memNote").textContent = "Las cotizaciones pasadas no cambian: guardan los valores que usaron.";
      return;
    }
    $("memNote").textContent = "";
    fetch("/api/memorias/" + encodeURIComponent(memEditing.token), { method: "DELETE" })
      .then(function (r) { if (!r.ok) throw new Error(); memSheet.close(); return loadMemories(); })
      .catch(function () { $("memError").textContent = "No se pudo borrar porque el servidor no respondió. Vuelve a intentarlo."; });
  });

  // ---- source list as a panel on narrow screens -----------------------------------
  function openSidebar() {
    sidebar.classList.add("open");
    scrim.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    $("main").inert = true;
    var first = sidebar.querySelector("[aria-current='page']") || $("newQuote");
    first.focus();
  }
  function closeSidebar(returnFocus) {
    if (!sidebar.classList.contains("open")) return;
    sidebar.classList.remove("open");
    scrim.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
    $("main").inert = false;
    if (returnFocus) menuBtn.focus();
  }
  menuBtn.addEventListener("click", function () { if (sidebar.classList.contains("open")) closeSidebar(true); else openSidebar(); });
  scrim.addEventListener("click", function () { closeSidebar(true); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && !sheet.open && !memSheet.open) closeSidebar(true); });
  narrow.addEventListener("change", function () { closeSidebar(false); });

  $("newQuote").addEventListener("click", function () { closeSidebar(false); newQuote("", true); });
  $("newQuoteTop").addEventListener("click", function () { newQuote("", true); });
  $("again").addEventListener("click", function () { newQuote(state.firstMessage, true); });

  // ---- start ---------------------------------------------------------------
  function route() {
    var id = new URLSearchParams(location.search).get("c");
    if (id) openConversation(id, false);
    else newQuote("", false);
  }
  window.addEventListener("popstate", route);
  loadHistory();
  loadMemories();
  route();
})();
