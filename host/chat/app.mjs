// host/chat/app.mjs
// DOM glue for the chat page. Served after transcript.mjs (exports stripped) as
// one module, so initialTurn / accepted / submitFailed / cancelling / reduce /
// isLive are already in scope. No import or export statements in this file.
/* global initialTurn, accepted, submitFailed, cancelling, reduce, isLive */
/* global marked, DOMPurify */
(() => {
  var apiBase = location.pathname.replace(/\/chat\/?$/, '');

  var sessionId = (function() {
    var key = 'chat-session-id';
    var existing = null;
    try { existing = sessionStorage.getItem(key); } catch(e) {}
    if (existing) return existing;
    var id = 'ses-' + crypto.randomUUID().slice(0, 12);
    try { sessionStorage.setItem(key, id); } catch(e) {}
    return id;
  })();

  var conversationTurns = [];
  var $ = function(sel) { return document.querySelector(sel); };
  var transcriptEl = $('#transcript');
  var composerEl = $('#composer');
  var goalEl = $('#goal');
  var sendBtn = $('#send');
  var statusPill = $('#status-pill');
  var statusText = $('#status-text');
  var threadTitle = $('#thread-title');
  var hdrSub = $('#hdr-sub');
  var composerStatus = $('#composer-status');
  var markSrc = (function() { var img = $('.hdr-left img'); return img ? img.src : ''; })();

  // --- Theme toggle ---
  var themeToggle = $('#theme-toggle');
  var themeBtns = themeToggle ? themeToggle.querySelectorAll('button') : [];
  if (themeBtns.length < 2 && themeToggle) themeToggle.style.display = 'none';
  (function initTheme() {
    if (themeBtns.length < 2) return;
    var validThemes = [];
    for (var i = 0; i < themeBtns.length; i++) validThemes.push(themeBtns[i].getAttribute('data-theme'));
    var saved = null;
    try { saved = localStorage.getItem('chat-theme'); } catch(e) {}
    var theme = saved && validThemes.indexOf(saved) >= 0 ? saved : validThemes[0];
    document.documentElement.setAttribute('data-theme', theme);
    for (var j = 0; j < themeBtns.length; j++) {
      themeBtns[j].className = themeBtns[j].getAttribute('data-theme') === theme ? 'active' : '';
    }
  })();
  if (themeToggle) themeToggle.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn || btn.classList.contains('active')) return;
    var theme = btn.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', theme);
    for (var i = 0; i < themeBtns.length; i++) {
      themeBtns[i].className = themeBtns[i].getAttribute('data-theme') === theme ? 'active' : '';
    }
    try { localStorage.setItem('chat-theme', theme); } catch(e) {}
  });

  var current = null; // { turn, card, source, grouped }
  var cardStates = new WeakMap();

  function getCardState(card) {
    var s = cardStates.get(card);
    if (!s) { s = { planOpen: true, openStep: null, memRecallOpen: false, memLearnOpen: false }; cardStates.set(card, s); }
    return s;
  }

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pillText(turn) {
    switch (turn.status) {
      case 'submitting': return 'SENDING';
      case 'queued': return turn.position ? 'QUEUED #' + turn.position : 'QUEUED';
      case 'running': return turn.iteration ? 'WORKING · STEP ' + turn.iteration : 'WORKING';
      case 'cancelling': return 'CANCELLING';
      case 'completed': return 'DONE';
      case 'error': return 'ERROR';
      default: return turn.status.replace(/_/g, ' ').toUpperCase();
    }
  }

  function updatePill(turn) {
    statusText.textContent = pillText(turn);
    statusPill.className = 'hdr-pill' + (isLive(turn) ? ' status-running' : (turn.error ? ' status-error' : ''));
  }

  function updateComposer(busy) {
    sendBtn.disabled = busy;
    goalEl.disabled = busy;
    sendBtn.className = 'btn-send' + (!busy && goalEl.value.trim() ? ' ready' : '');
    composerStatus.textContent = busy ? 'WORKING… ENTER TO STOP' : 'ENTER TO SEND';
    if (busy) composerStatus.className = 'stop-hint'; else composerStatus.className = '';
  }

  goalEl.addEventListener('input', function() {
    sendBtn.className = 'btn-send' + (goalEl.value.trim() && !sendBtn.disabled ? ' ready' : '');
  });

  // --- Plan card rendering ---

  function planSummary(turn) {
    if (!turn.plan) return '';
    var done = 0, total = turn.plan.steps.length;
    for (var i = 0; i < total; i++) if (turn.plan.steps[i].status === 'completed') done++;
    if (done === total && total > 0) return 'DONE · ' + total + ' STEPS';
    return done + ' OF ' + total + ' DONE';
  }

  function planPct(turn) {
    if (!turn.plan || turn.plan.steps.length === 0) return '0%';
    var done = 0, run = 0;
    for (var i = 0; i < turn.plan.steps.length; i++) {
      if (turn.plan.steps[i].status === 'completed') done++;
      if (turn.plan.steps[i].status === 'running') run++;
    }
    return Math.round(((done + run * 0.5) / turn.plan.steps.length) * 100) + '%';
  }

  function stepGlyph(status) {
    if (status === 'completed') return '✓';
    if (status === 'running') return null; // use dot
    if (status === 'failed') return '✗';
    if (status === 'retrying') return '↻';
    return '○';
  }

  function stepColors(status) {
    var isDone = status === 'completed';
    var isRun = status === 'running';
    var style = getComputedStyle(document.documentElement);
    var accent = style.getPropertyValue('--accent-dark').trim() || '#6B9420';
    var primary = style.getPropertyValue('--text-primary').trim() || '#14171A';
    var accentText = style.getPropertyValue('--accent-text').trim() || '#5a7a1e';
    var runBg = style.getPropertyValue('--step-running-bg').trim() || '#F7FAF0';
    return {
      glyph: isDone || isRun ? accent : 'rgba(0,0,0,.28)',
      tool: isDone || isRun ? primary : 'rgba(0,0,0,.42)',
      detail: isRun ? accentText : 'rgba(0,0,0,.45)',
      caret: 'rgba(0,0,0,.3)',
      bg: isRun ? runBg : 'transparent'
    };
  }

  function renderPlan(turn, card) {
    var cs = getCardState(card);
    var plan = h('div', 'plan');
    // Header
    var hdr = h('div', 'plan-hdr');
    var left = h('div', 'plan-hdr-left');
    left.append(h('span', 'plan-label', 'PLAN'));
    left.append(h('span', 'plan-meta', planSummary(turn)));
    hdr.append(left);
    var toggle = h('span', 'plan-toggle', cs.planOpen ? 'HIDE STEPS' : 'SHOW STEPS');
    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      var s = getCardState(card);
      s.planOpen = !s.planOpen;
      renderCard(card, s.turn);
    });
    hdr.append(toggle);
    plan.append(hdr);
    // Progress bar
    var bar = h('div', 'plan-bar');
    var fill = h('div', 'plan-bar-fill');
    fill.style.width = planPct(turn);
    bar.append(fill);
    plan.append(bar);
    // Steps
    if (cs.planOpen) {
      var steps = h('div', 'plan-steps');
      for (var i = 0; i < turn.plan.steps.length; i++) {
        (function(idx) {
          var s = turn.plan.steps[idx];
          var c = stepColors(s.status);
          var isOpen = cs.openStep === idx;
          var hasContent = s.result != null || s.error;

          var row = h('div', 'plan-step');
          row.style.background = isOpen ? '#FAFBF7' : c.bg;
          row.addEventListener('click', function() {
            if (!hasContent) return;
            var st = getCardState(card);
            st.openStep = st.openStep === idx ? null : idx;
            renderCard(card, st.turn);
          });

          // Caret
          var caret = h('span', 'caret');
          caret.style.color = isOpen ? '#5a7a1e' : c.caret;
          caret.textContent = hasContent ? (isOpen ? '▼' : '▶') : '';
          row.append(caret);

          // Glyph
          var glyph = h('span', 'glyph');
          glyph.style.color = c.glyph;
          var g = stepGlyph(s.status);
          if (g) { glyph.textContent = g; } else { var dot = h('span', 'run-dot'); glyph.append(dot); }
          row.append(glyph);

          // Info column
          var info = h('div', 'step-info');
          var sr = h('div', 'step-row');
          var toolSpan = h('span', 'tool', s.tool || s.type);
          toolSpan.style.color = c.tool;
          sr.append(toolSpan);
          var detSpan = h('span', 'detail');
          detSpan.style.color = c.detail;
          detSpan.textContent = s.status === 'running' ? (s.description || '') + '…' : (s.description || '');
          sr.append(detSpan);
          info.append(sr);

          // Expanded content
          if (isOpen && hasContent) {
            var exp = h('div', 'step-expand');
            if (s.result) {
              var note = h('div', 'step-note', typeof s.result === 'string' ? s.result : JSON.stringify(s.result));
              exp.append(note);
            }
            if (s.error) {
              var errDiv = h('div', 'step-note');
              errDiv.style.color = '#b91c1c';
              errDiv.textContent = s.error;
              exp.append(errDiv);
            }
            info.append(exp);
          }
          row.append(info);

          // Timing
          var timing = h('span', 'timing');
          timing.textContent = s.status === 'running' ? '···' : '';
          row.append(timing);

          steps.append(row);
        })(i);
      }
      plan.append(steps);
    }
    // Footer — stop only (reviews shown in pipeline)
    var footer = h('div', 'plan-footer');
    if (isLive(turn) && turn.status !== 'submitting') {
      var stopBtn = h('span', 'plan-stop', 'STOP');
      stopBtn.addEventListener('click', function(e) { e.stopPropagation(); doStop(); });
      footer.append(stopBtn);
    }
    plan.append(footer);
    return plan;
  }

  // --- Answer rendering ---

  function humanizeKey(key) {
    return key.replace(/[_-]/g, ' ').replace(/\b[a-z]/g, function(c) { return c.toUpperCase(); });
  }

  function answerToMarkdown(obj) {
    if (typeof obj === 'string') return obj;
    if (obj == null) return '';
    var text = obj.message || obj.error || obj.answer;
    if (typeof text === 'string') return text;

    var parts = [];
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = obj[key];
      var label = humanizeKey(key);

      if (val == null) continue;
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        parts.push('**' + label + ':** ' + val);
      } else if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
        var cols = Object.keys(val[0]);
        var hdr = cols.map(humanizeKey);
        var rows = ['| ' + hdr.join(' | ') + ' |', '| ' + cols.map(function() { return '---'; }).join(' | ') + ' |'];
        for (var j = 0; j < val.length; j++) {
          rows.push('| ' + cols.map(function(c) { return val[j][c] != null ? String(val[j][c]) : ''; }).join(' | ') + ' |');
        }
        parts.push('**' + label + '**\n\n' + rows.join('\n'));
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        var items = Object.keys(val).map(function(k) {
          return '- **' + humanizeKey(k) + ':** ' + val[k];
        });
        parts.push('**' + label + '**\n\n' + items.join('\n'));
      } else {
        parts.push('**' + label + ':** ' + JSON.stringify(val));
      }
    }
    return parts.join('\n\n');
  }

  function renderAnswer(answer) {
    var text = typeof answer === 'string' ? answer : answerToMarkdown(answer);
    var div = h('div', 'answer-block');
    var inner = h('div', 'answer-text');
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      inner.innerHTML = DOMPurify.sanitize(marked.parse(text));
    } else {
      inner.textContent = text;
    }
    div.append(inner);
    return div;
  }

  // --- Status pipeline ---

  function pipelinePhase(turn) {
    // Determine which phase of the lifecycle we're in
    var hasStepsRunning = false;
    var hasStepsDone = false;
    if (turn.plan) {
      for (var i = 0; i < turn.plan.steps.length; i++) {
        if (turn.plan.steps[i].status === 'running') hasStepsRunning = true;
        if (turn.plan.steps[i].status === 'completed') hasStepsDone = true;
      }
    }
    var lastReview = turn.reviews.length > 0 ? turn.reviews[turn.reviews.length - 1] : null;
    var anyRejected = false;
    for (var j = 0; j < turn.reviews.length; j++) {
      if (!turn.reviews[j].approved) anyRejected = true;
    }

    if (turn.status === 'completed') return 'done';
    if (turn.status === 'submitting' || turn.status === 'queued') return 'sending';
    if (!turn.plan) return 'planning';
    if (!lastReview && !hasStepsRunning && !hasStepsDone) return 'reviewing';
    if (lastReview && !lastReview.approved && !hasStepsRunning && !hasStepsDone) return 'replanning';
    if (hasStepsRunning || hasStepsDone) return 'executing';
    if (lastReview && lastReview.approved && !hasStepsRunning) return 'executing';
    return 'executing';
  }

  function renderPipelineStage(label, state) {
    // state: 'pending' | 'active' | 'done' | 'rejected'
    var stage = h('div', 'pipeline-stage ' + state);
    var icon = h('span', 'stage-icon');
    if (state === 'done') icon.textContent = '✓';
    else if (state === 'rejected') icon.textContent = '!';
    else if (state === 'active') icon.textContent = '●';
    else icon.textContent = '○';
    stage.append(icon);
    stage.append(h('span', 'stage-label', label));
    return stage;
  }

  function renderArrow(done) {
    var arrow = h('span', 'pipeline-arrow' + (done ? ' done' : ''));
    arrow.textContent = '→';
    return arrow;
  }

  function renderRouteIndicator(label) {
    var indicator = h('div', 'route-indicator');
    var dots = h('span', 'route-dots');
    for (var i = 0; i < 3; i++) dots.append(h('span', 'dot'));
    indicator.append(dots);
    indicator.append(h('span', 'route-label', label));
    return indicator;
  }

  function renderPlanExecutePipeline(turn, frag) {
    var phase = pipelinePhase(turn);
    var pipeline = h('div', 'status-pipeline');

    // Stage 1: Plan
    var planState = 'pending';
    if (phase === 'planning') planState = 'active';
    else if (phase === 'replanning') planState = 'active';
    else if (turn.plan) planState = 'done';
    pipeline.append(renderPipelineStage(phase === 'sending' ? 'SENDING' : phase === 'planning' ? 'GENERATING PLAN' : phase === 'replanning' ? 'REVISING PLAN' : 'PLAN READY', planState === 'active' ? 'active' : planState));

    pipeline.append(renderArrow(planState === 'done'));

    // Stage 2: Review
    var lastReview = turn.reviews.length > 0 ? turn.reviews[turn.reviews.length - 1] : null;
    var reviewState = 'pending';
    if (phase === 'reviewing') reviewState = 'active';
    else if (lastReview && lastReview.approved) reviewState = 'done';
    else if (lastReview && !lastReview.approved) reviewState = 'rejected';
    var reviewLabel = reviewState === 'active' ? 'REVIEWING' : reviewState === 'done' ? 'APPROVED' : reviewState === 'rejected' ? 'NEEDS REVISION' : 'REVIEW';
    pipeline.append(renderPipelineStage(reviewLabel, reviewState));

    pipeline.append(renderArrow(reviewState === 'done'));

    // Stage 3: Execute
    var execState = 'pending';
    if (phase === 'executing') execState = 'active';
    else if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled') execState = 'done';
    var execLabel = execState === 'active' ? 'RUNNING' : execState === 'done' ? 'COMPLETE' : 'EXECUTE';
    pipeline.append(renderPipelineStage(execLabel, execState));

    frag.append(pipeline);

    // Show review feedback if rejected
    if (lastReview && !lastReview.approved && lastReview.feedback) {
      var fb = h('div', 'pipeline-feedback');
      fb.textContent = lastReview.feedback;
      frag.append(fb);
    }

    return frag;
  }

  function renderStatusPipeline(turn) {
    var frag = document.createDocumentFragment();
    var route = turn.routedTo;

    // Plan-execute or already has a plan: full 3-stage stepper
    if (route === 'plan-execute' || turn.plan) {
      return renderPlanExecutePipeline(turn, frag);
    }

    // Terminal turns without plan-execute: no indicator needed
    if (!isLive(turn)) return frag;

    // Pre-routing states: nothing (pill already shows SENDING/QUEUED)
    if (turn.status === 'submitting' || turn.status === 'queued') return frag;

    // Running — show route-specific indicator
    if (!route) {
      frag.append(renderRouteIndicator('ROUTING'));
    } else if (route.indexOf('workflow:') === 0) {
      var wfName = route.slice(9).toUpperCase().replace(/-/g, ' ');
      frag.append(renderRouteIndicator('WORKFLOW · ' + wfName));
    } else {
      frag.append(renderRouteIndicator('THINKING'));
    }

    return frag;
  }

  // --- Question form ---
  //
  // The run is parked on a question. Everything here is built from the batch
  // the server sent: five kinds of field, one submit, and per-field errors on
  // a rejection. A partial answer is never sent — the server validates the set
  // atomically and would reject it anyway.

  function fieldName(q, i) {
    return 'hi-' + i + '-' + q.fieldId;
  }

  function renderApproval(q, name) {
    var wrap = h('div', 'hi-choices');
    var vals = [{ value: 'approve', label: 'Yes, go ahead' }, { value: 'deny', label: 'No' }];
    for (var i = 0; i < vals.length; i++) {
      var lab = h('label', 'hi-choice');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = vals[i].value;
      if (q.default === vals[i].value) input.checked = true;
      lab.append(input, h('span', null, vals[i].label));
      wrap.append(lab);
    }
    return wrap;
  }

  function renderOptions(q, name, type) {
    var wrap = h('div', 'hi-choices');
    var opts = q.options || [];
    for (var i = 0; i < opts.length; i++) {
      var lab = h('label', 'hi-choice');
      var input = document.createElement('input');
      input.type = type;
      input.name = name;
      input.value = opts[i].value;
      if (q.default === opts[i].value) input.checked = true;
      // The label is the only thing shown. `value` may be an opaque id; the
      // label may not be, and the server guarantees that.
      lab.append(input, h('span', null, opts[i].label));
      wrap.append(lab);
    }
    return wrap;
  }

  function renderTextField(q, name, placeholder) {
    var input = document.createElement('textarea');
    input.name = name;
    input.rows = 2;
    input.className = 'hi-text';
    input.placeholder = placeholder || 'Your answer';
    if (typeof q.default === 'string') input.value = q.default;
    return input;
  }

  function renderQuestion(q, i, error) {
    var name = fieldName(q, i);
    var block = h('div', 'hi-q');
    block.append(h('div', 'hi-prompt', q.prompt));

    if (q.kind === 'approval') block.append(renderApproval(q, name));
    else if (q.kind === 'pick_one') block.append(renderOptions(q, name, 'radio'));
    else if (q.kind === 'pick_many') block.append(renderOptions(q, name, 'checkbox'));
    else if (q.kind === 'text') block.append(renderTextField(q, name));
    else if (q.kind === 'pick_one_or_text') {
      block.append(renderOptions(q, name, 'radio'));
      if (q.allowOther) {
        var lab = h('label', 'hi-choice');
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = name;
        radio.value = '__other__';
        lab.append(radio, h('span', null, q.otherPrompt || 'Something else'));
        block.append(lab);
        var other = renderTextField(q, name + '-other', q.otherPrompt || 'Tell me instead');
        other.className = 'hi-text hi-other';
        block.append(other);
      }
    }

    if (error) block.append(h('div', 'hi-field-error', error));
    return block;
  }

  // Read one field's answer back out of the DOM, in the shape the route wants.
  function readAnswer(form, q, i) {
    var name = fieldName(q, i);

    if (q.kind === 'pick_many') {
      var boxes = form.querySelectorAll('input[name="' + name + '"]:checked');
      var vals = [];
      for (var b = 0; b < boxes.length; b++) vals.push(boxes[b].value);
      // An empty array is a real answer meaning "none of these", so it is
      // always sent rather than treated as an unanswered field.
      return vals;
    }

    if (q.kind === 'text') {
      var ta = form.querySelector('[name="' + name + '"]');
      var text = ta ? ta.value.trim() : '';
      return text === '' ? undefined : text;
    }

    var picked = form.querySelector('input[name="' + name + '"]:checked');
    if (!picked) return undefined;

    if (q.kind === 'pick_one_or_text' && picked.value === '__other__') {
      var otherEl = form.querySelector('[name="' + name + '-other"]');
      var other = otherEl ? otherEl.value.trim() : '';
      return other === '' ? undefined : { other: other };
    }
    return picked.value;
  }

  function renderInputForm(turn) {
    var pending = turn.pendingInput;
    var wrap = h('div', 'hi-card');

    wrap.append(h('div', 'hi-head', pending.askedBy === 'guardrail' ? 'Needs your approval' : 'A question for you'));

    var form = document.createElement('form');
    form.className = 'hi-form';

    var fieldErrors = (turn.inputError && turn.inputError.fields) || {};
    for (var i = 0; i < pending.questions.length; i++) {
      var q = pending.questions[i];
      form.append(renderQuestion(q, i, fieldErrors[q.fieldId]));
    }

    if (turn.inputError && turn.inputError.message) {
      form.append(h('div', 'hi-error', turn.inputError.message));
    }

    var actions = h('div', 'hi-actions');
    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'hi-submit';
    submit.textContent = turn.submittingInput ? 'Sending...' : 'Send answer';
    submit.disabled = !!turn.submittingInput;
    actions.append(submit);
    form.append(actions);

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      if (turn.submittingInput) return;
      var answers = {};
      for (var k = 0; k < pending.questions.length; k++) {
        var qq = pending.questions[k];
        var v = readAnswer(form, qq, k);
        if (v !== undefined) answers[qq.fieldId] = v;
      }
      doAnswer(pending.batchId, answers);
    });

    wrap.append(form);
    return wrap;
  }

  function doAnswer(batchId, answers) {
    if (!current || !current.turn.jobId) return;
    var jobId = current.turn.jobId;
    apply(function(turn) { return inputSubmitting(turn); });

    fetch(apiBase + '/jobs/' + jobId + '/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: batchId, answers: answers }),
    })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(body) { return { res: res, body: body }; });
      })
      .then(function(r) {
        console.log('answer', r.res.status, r.body);
        if (r.res.status === 200) return;   // input_resolved will arrive over SSE
        var body = r.body || {};
        // 410 and 409 are not the user's fault and cannot be fixed by editing
        // the form, so they read as statements rather than validation errors.
        var message = body.error === 'batch_expired' ? 'That question expired before it was answered.'
          : body.error === 'already_answered' ? 'That question has already been answered.'
          : body.error === 'not_waiting' ? 'This run is no longer waiting for an answer.'
          : body.message || 'That answer was not accepted.';
        apply(function(turn) { return inputRejected(turn, { message: message, fields: body.fields || null }); });
      })
      .catch(function(err) {
        console.error('answer failed', err);
        apply(function(turn) { return inputRejected(turn, { message: err.message }); });
      });
  }


  // --- Card rendering ---

  // --- Memory panels ---

  function renderMemoryFact(fact, opts) {
    var row = h('div', 'mem-fact');
    var kindBadge = h('span', 'mem-kind mem-kind-' + (fact.kind || 'domain'), (fact.kind || 'domain').toUpperCase());
    row.append(kindBadge);
    var textEl = h('span', 'mem-text', fact.text);
    row.append(textEl);
    if (fact.tags && fact.tags.length > 0) {
      var tagsEl = h('span', 'mem-tags');
      for (var t = 0; t < fact.tags.length; t++) {
        tagsEl.append(h('span', 'mem-tag', fact.tags[t]));
      }
      row.append(tagsEl);
    }
    if (opts && opts.strength != null) {
      var str = h('span', 'mem-strength');
      var pct = Math.round(opts.strength * 100);
      str.textContent = pct + '%';
      str.title = 'Retrieval strength';
      row.append(str);
    }
    return row;
  }

  function renderMemoryRecall(recall, card) {
    if (!recall) return null;
    var cs = getCardState(card);
    var hasFacts = recall.facts && recall.facts.length > 0;
    var panel = h('div', 'mem-panel mem-recall');
    var hdr = h('div', 'mem-hdr');
    var icon = h('span', 'mem-icon', '⟵');
    hdr.append(icon);
    hdr.append(h('span', 'mem-label', recall.count > 0 ? 'RECALLED ' + recall.count + ' MEMORIES' : 'RECALLED · NOTHING MATCHED'));
    if (hasFacts) {
      var toggle = h('span', 'mem-toggle', cs.memRecallOpen ? 'HIDE' : 'SHOW');
      toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        var s = getCardState(card);
        s.memRecallOpen = !s.memRecallOpen;
        renderCard(card, s.turn);
      });
      hdr.append(toggle);
    }
    panel.append(hdr);
    if (cs.memRecallOpen && hasFacts) {
      var list = h('div', 'mem-list');
      for (var i = 0; i < recall.facts.length; i++) {
        list.append(renderMemoryFact(recall.facts[i], { strength: recall.facts[i].retrievalStrength }));
      }
      panel.append(list);
    }
    return panel;
  }

  function renderMemoryLearn(learn, card) {
    if (!learn) return null;
    var cs = getCardState(card);
    var hasNew = learn.newFacts && learn.newFacts.length > 0;
    var hasPromoted = learn.promotedIds && learn.promotedIds.length > 0;
    var panel = h('div', 'mem-panel mem-learn');
    var hdr = h('div', 'mem-hdr');
    var icon = h('span', 'mem-icon', '⟶');
    hdr.append(icon);
    if (hasNew || hasPromoted) {
      var parts = [];
      if (hasNew) parts.push(learn.newFacts.length + ' NEW');
      if (hasPromoted) parts.push(learn.promotedIds.length + ' REINFORCED');
      hdr.append(h('span', 'mem-label', 'LEARNED · ' + parts.join(' · ')));
    } else {
      hdr.append(h('span', 'mem-label', 'LEARNED · NOTHING NEW'));
    }
    if (hasNew) {
      var toggle = h('span', 'mem-toggle', cs.memLearnOpen ? 'HIDE' : 'SHOW');
      toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        var s = getCardState(card);
        s.memLearnOpen = !s.memLearnOpen;
        renderCard(card, s.turn);
      });
      hdr.append(toggle);
    }
    panel.append(hdr);
    if (cs.memLearnOpen && hasNew) {
      var list = h('div', 'mem-list');
      for (var i = 0; i < learn.newFacts.length; i++) {
        list.append(renderMemoryFact(learn.newFacts[i], {}));
      }
      panel.append(list);
    }
    return panel;
  }

  function renderCard(card, turn) {
    getCardState(card).turn = turn;
    card.replaceChildren();
    var img = h('img', 'bot-mark');
    img.src = markSrc;
    img.alt = '';
    img.style.opacity = isLive(turn) ? '.55' : '1';
    card.append(img);

    var body = h('div', 'bot-body');

    // Memory recall (before pipeline)
    var recallPanel = renderMemoryRecall(turn.memoryRecall, card);
    if (recallPanel) body.append(recallPanel);

    // Status pipeline + plan
    body.append(renderStatusPipeline(turn));

    if (turn.plan) {
      body.append(renderPlan(turn, card));
    }

    // Memory learn (after plan, before answer)
    var learnPanel = renderMemoryLearn(turn.memoryLearn, card);
    if (learnPanel) body.append(learnPanel);

    // A question the run is waiting on. Rendered above the answer slot because
    // it is the only thing the person can act on right now.
    if (isWaitingForInput(turn)) {
      body.append(renderInputForm(turn));
    }

    // Answer
    if (turn.status === 'completed' && turn.answer != null) {
      body.append(renderAnswer(turn.answer));
    } else if (turn.error) {
      body.append(h('div', 'error-card', turn.status.replace(/_/g, ' ') + ': ' + turn.error.message));
    }

    card.append(body);
    updatePill(turn);
  }

  // --- Lifecycle ---

  function finish() {
    if (current.source) { current.source.close(); current.source = null; }
    if (current.grouped) { console.groupEnd(); current.grouped = false; }
    updateComposer(false);
    if (current.turn.status === 'completed') goalEl.value = '';
    goalEl.focus();
    sendBtn.className = 'btn-send';
    // Collapse plan when done
    getCardState(current.card).planOpen = false;
    renderCard(current.card, current.turn);
  }

  function apply(fn) {
    current.turn = fn(current.turn);
    renderCard(current.card, current.turn);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    if (isLive(current.turn)) updateComposer(true); else finish();
  }

  function subscribe(url) {
    var source = new EventSource(url);
    current.source = source;
    var types = ['queued', 'started', 'progress', 'settled', 'input_required', 'input_resolved'];
    for (var t = 0; t < types.length; t++) {
      (function(type) {
        source.addEventListener(type, function(msg) {
          var event;
          try { event = JSON.parse(msg.data); } catch (err) { console.error('unparseable event', msg.data, err); return; }
          console.log(event.type, event.kind || '', event);
          apply(function(turn) { return reduce(turn, event); });
          if (type === 'settled' && event.status === 'completed' && event.result) {
            var answerText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
            if (answerText.length > 500) answerText = answerText.slice(0, 500);
            conversationTurns.push({ role: 'user', text: current.turn.goal });
            conversationTurns.push({ role: 'assistant', text: answerText });
          }
        });
      })(types[t]);
    }
    source.onerror = function(err) { console.error('SSE error; browser will reconnect with Last-Event-ID', err); };
  }

  function doSend(goal) {
    // User bubble
    var userDiv = h('div', 'user-msg', goal);
    transcriptEl.append(userDiv);

    // Update thread title
    var short = goal.length > 50 ? goal.slice(0, 50) + '…' : goal;
    threadTitle.textContent = short;
    hdrSub.textContent = '';

    // Bot card
    var card = h('div', 'bot-msg');
    transcriptEl.append(card);
    current = { turn: initialTurn(goal), card: card, source: null, grouped: false };
    renderCard(card, current.turn);
    updateComposer(true);

    fetch(apiBase + '/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: goal, sessionId: sessionId, conversation: conversationTurns.slice(-20) }) })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(body) { return { res: res, body: body }; });
      })
      .then(function(r) {
        var res = r.res, body = r.body;
        if (res.status !== 202) {
          var retry = res.headers.get('retry-after');
          var message = (body && body.message ? body.message : body && body.error ? body.error : 'HTTP ' + res.status) + (retry ? ' (retry in ' + retry + 's)' : '');
          console.error('submit rejected', res.status, body);
          apply(function(turn) { return submitFailed(turn, { message: message }); });
          return;
        }
        console.group('job ' + body.jobId);
        current.grouped = true;
        console.log('accepted', body);
        hdrSub.textContent = 'JOB ' + body.jobId.toUpperCase();
        apply(function(turn) { return accepted(turn, { jobId: body.jobId, position: body.position }); });
        subscribe(apiBase + (body.links && body.links.events ? body.links.events : '/jobs/' + body.jobId + '/events'));
      })
      .catch(function(err) {
        console.error('submit failed', err);
        apply(function(turn) { return submitFailed(turn, { message: err.message }); });
      });
  }

  function doStop() {
    if (!current || !current.turn.jobId || !isLive(current.turn)) return;
    fetch(apiBase + '/jobs/' + current.turn.jobId, { method: 'DELETE' })
      .then(function(res) {
        return res.json().catch(function() { return null; }).then(function(body) { return { res: res, body: body }; });
      })
      .then(function(r) {
        console.log('cancel', r.res.status, r.body);
        if (r.res.status === 200 || r.res.status === 202) apply(function(turn) { return cancelling(turn); });
      })
      .catch(function(err) { console.error('cancel failed', err); });
  }

  composerEl.addEventListener('submit', function(e) {
    e.preventDefault();
    var goal = goalEl.value.trim();
    if (goal && !sendBtn.disabled) doSend(goal);
  });
  goalEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (current && isLive(current.turn)) { doStop(); return; }
      composerEl.requestSubmit();
    }
  });
  composerStatus.addEventListener('click', function() {
    if (current && isLive(current.turn)) doStop();
  });
})();
