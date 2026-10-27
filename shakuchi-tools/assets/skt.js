/* 借地権の計算ツール — 共通エンジン
 *
 * 役割:
 *   1. ツール定義（window.SKT.tools[name]）から入力フォームを組み立てる
 *   2. 入力が変わるたびに compute() を呼び、返ってきた結果オブジェクトを描画する
 *   3. 印刷・コピー・CSV の書き出し
 *
 * 計算はすべてブラウザの中で完結する。サーバーへ値を送らないので、
 * 個人情報の保管・同意・スパム対策がいらず、ページキャッシュとも干渉しない。
 */
(function () {
  'use strict';

  var SKT = (window.SKT = window.SKT || {});
  SKT.tools = SKT.tools || {};

  /* ===================== 数値の整形 ===================== */

  function n(v, d) {
    var x = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
    return isFinite(x) ? x : (d || 0);
  }

  /** 円をそのまま「1,234,567円」に */
  function yen(v) {
    return Math.round(n(v)).toLocaleString('ja-JP') + '円';
  }

  /** 円を「1,234万円」に。端数が出るときは万円未満を切り捨てて注記側で補う */
  function man(v) {
    return Math.round(n(v) / 10000).toLocaleString('ja-JP') + '万円';
  }

  /** 桁が大きいときは万円、小さいときは円。結果パネルの見出し用 */
  function auto(v) {
    var x = Math.abs(n(v));
    if (x >= 1000000 && x % 10000 === 0) return man(v);
    return yen(v);
  }

  function pct(v, digits) {
    return (n(v) * 100).toFixed(digits == null ? 1 : digits) + '%';
  }

  SKT.fmt = { n: n, yen: yen, man: man, auto: auto, pct: pct };

  /* ===================== DOM のちょい足し ===================== */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 入力欄に打ちながら桁区切りを入れる。キャレット位置は「右から数えた桁数」で復元する
     （左から数えるとカンマが増減したときに1文字ずれる） */
  function commify(input) {
    var raw = input.value.replace(/[^\d]/g, '');
    var fromRight = input.value.length - (input.selectionStart || 0);
    input.value = raw === '' ? '' : parseInt(raw, 10).toLocaleString('ja-JP');
    var pos = Math.max(0, input.value.length - fromRight);
    try { input.setSelectionRange(pos, pos); } catch (e) { /* type=number 等では無視 */ }
  }

  /* ===================== フォームの組み立て ===================== */

  function fieldValue(f, wrap) {
    if (f.t === 'custom') {
      return wrap._sktGet ? wrap._sktGet() : null;
    }
    if (f.t === 'tiles' || f.t === 'sel') {
      var sel = wrap.querySelector('input:checked, select');
      return sel ? sel.value : (f.def != null ? f.def : '');
    }
    if (f.t === 'check') {
      var c = wrap.querySelector('input');
      return !!(c && c.checked);
    }
    if (f.t === 'checks') {
      return Array.prototype.slice
        .call(wrap.querySelectorAll('input:checked'))
        .map(function (i) { return i.value; });
    }
    if (f.t === 'date') {
      var d = wrap.querySelector('input');
      return d ? d.value : '';
    }
    if (f.t === 'ym') {
      var ss = wrap.querySelectorAll('select');
      if (ss.length < 2) return '';
      return ss[0].value + '-' + ('0' + ss[1].value).slice(-2);
    }
    var num = wrap.querySelector('input[data-num]');
    if (!num) return 0;
    var v = n(num.value);
    if (f.t === 'man') v *= 10000;
    return v;
  }

  function buildField(f, uid, onChange) {
    var wrap = el('div', 'skt-field');
    wrap.dataset.key = f.k;
    if (f.when) wrap.dataset.cond = '1';

    var id = uid + '-' + f.k;

    /* tiles と checks は複数のコントロールをまとめた「かたまり」なので、
       label[for] ではなく role + aria-labelledby で結びつける。
       for に単一のIDを書くと、存在しないIDを指すか、最初の1つだけを指してしまう。
       check（単独）は選択肢の文言そのものがラベルなので、上の見出しを出さない。 */
    var isGroup = (f.t === 'tiles' || f.t === 'checks');
    if (f.label && f.t !== 'check' && f.t !== 'custom') {
      var lab = el(isGroup ? 'div' : 'label', 'skt-label');
      if (isGroup) lab.id = id + '-lab'; else lab.htmlFor = id;
      lab.textContent = f.label;
      if (f.opt) lab.appendChild(el('span', 'skt-opt', '任意'));
      wrap.appendChild(lab);
    }

    if (f.t === 'custom') {
      /* ツール側が中身を組み立てる欄（土地の単価など）。値の取り出し口を wrap._sktGet に置く */
      f.build(wrap, id, onChange, SKT);

    } else if (f.t === 'tiles') {
      var tiles = el('div', 'skt-tiles');
      tiles.setAttribute('role', 'radiogroup');
      if (f.label) tiles.setAttribute('aria-labelledby', id + '-lab');
      if (f.cols) tiles.classList.add('skt-t' + f.cols);
      f.opts.forEach(function (o, i) {
        var l = el('label', 'skt-tile');
        var r = document.createElement('input');
        r.type = 'radio';
        r.name = id;
        r.value = o.v;
        r.checked = (f.def != null ? o.v === f.def : i === 0);
        var s = el('span');
        s.appendChild(document.createTextNode(o.l));
        if (o.s) s.appendChild(el('small', null, o.s));
        l.appendChild(r);
        l.appendChild(s);
        r.addEventListener('change', onChange);
        tiles.appendChild(l);
      });
      wrap.appendChild(tiles);

    } else if (f.t === 'sel') {
      var sw = el('div', 'skt-sel');
      var se = document.createElement('select');
      se.id = id;
      f.opts.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o.v;
        op.textContent = o.l;
        if (o.v === f.def) op.selected = true;
        se.appendChild(op);
      });
      se.addEventListener('change', onChange);
      sw.appendChild(se);
      wrap.appendChild(sw);

    } else if (f.t === 'check' || f.t === 'checks') {
      var box = el('div', 'skt-checks');
      if (f.t === 'checks') {
        box.setAttribute('role', 'group');
        if (f.label) box.setAttribute('aria-labelledby', id + '-lab');
      }
      var opts = f.t === 'check' ? [{ v: '1', l: f.text || f.label, note: f.note }] : f.opts;
      opts.forEach(function (o, i) {
        var l = el('label', 'skt-check');
        var c = document.createElement('input');
        c.type = 'checkbox';
        c.value = o.v;
        c.name = id;
        if (f.t === 'check' && f.def) c.checked = true;
        if (f.t === 'checks' && f.def && f.def.indexOf(o.v) >= 0) c.checked = true;
        if (i === 0) c.id = id;
        var s = el('span');
        var inner = el('div');
        inner.appendChild(document.createTextNode(o.l));
        if (o.note) inner.appendChild(el('em', null, o.note));
        s.appendChild(inner);
        l.appendChild(c);
        l.appendChild(s);
        c.addEventListener('change', onChange);
        box.appendChild(l);
      });
      wrap.appendChild(box);

    } else if (f.t === 'date') {
      var dw = el('div', 'skt-date');
      var di = document.createElement('input');
      di.type = 'date';
      di.id = id;
      di.value = f.def || todayPlus(f.defDays || 0);
      di.addEventListener('change', onChange);
      di.addEventListener('input', onChange);
      dw.appendChild(di);
      wrap.appendChild(dw);

    } else if (f.t === 'ym') {
      var yw = el('div', 'skt-ym');
      var now = new Date();
      var ys = document.createElement('select');
      var y0 = f.from || 1960;
      var y1 = f.to || now.getFullYear();
      for (var y = y1; y >= y0; y--) {
        var oy = document.createElement('option');
        oy.value = String(y);
        oy.textContent = y + '年';
        ys.appendChild(oy);
      }
      ys.value = String(f.defY || (y1 - 15));
      var ms = document.createElement('select');
      for (var m = 1; m <= 12; m++) {
        var om = document.createElement('option');
        om.value = String(m);
        om.textContent = m + '月';
        ms.appendChild(om);
      }
      ms.value = String(f.defM || 4);
      ys.id = id;
      ys.addEventListener('change', onChange);
      ms.addEventListener('change', onChange);
      var w1 = el('div', 'skt-sel'); w1.appendChild(ys);
      var w2 = el('div', 'skt-sel'); w2.appendChild(ms);
      yw.appendChild(w1); yw.appendChild(w2);
      wrap.appendChild(yw);

    } else {
      /* man / yen / num */
      var nw = el('div', 'skt-num');
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.inputMode = 'numeric';
      inp.id = id;
      inp.dataset.num = '1';
      inp.value = f.def != null ? Number(f.def).toLocaleString('ja-JP') : '';
      if (f.ph) inp.placeholder = f.ph;
      var unit = el('span', 'skt-unit', f.t === 'man' ? '万円' : (f.unit || '円'));
      nw.appendChild(inp);
      nw.appendChild(unit);
      wrap.appendChild(nw);

      var rng = null;
      if (f.max != null) {
        rng = document.createElement('input');
        rng.type = 'range';
        rng.className = 'skt-range';
        rng.min = String(f.min || 0);
        rng.max = String(f.max);
        rng.step = String(f.step || 1);
        rng.value = String(n(inp.value));
        rng.setAttribute('aria-label', (f.label || '') + ' のスライダー');
        wrap.appendChild(rng);
        var sc = el('div', 'skt-scale');
        sc.appendChild(el('span', null, Number(f.min || 0).toLocaleString('ja-JP')));
        sc.appendChild(el('span', null, Number(f.max).toLocaleString('ja-JP')));
        wrap.appendChild(sc);
        rng.addEventListener('input', function () {
          inp.value = Number(rng.value).toLocaleString('ja-JP');
          onChange();
        });
      }

      inp.addEventListener('input', function () {
        commify(inp);
        if (rng) rng.value = String(Math.min(n(inp.value), n(rng.max)));
        onChange();
      });
    }

    if (f.hint) wrap.appendChild(el('div', 'skt-hint', f.hint));
    return wrap;
  }

  function todayPlus(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  SKT.todayPlus = todayPlus;

  /* ===================== 結果の描画 ===================== */

  var PALETTE = ['#0f6f8f', '#3fa2c4', '#b4232a', '#d98324', '#0f7a4d', '#7c8b95', '#8a6fb0'];

  function renderResult(out, r) {
    out.innerHTML = '';
    if (!r) return;

    if (r.verdict) {
      var v = el('div', 'skt-verdict lv-' + (r.verdict.level || 'warn'));
      if (r.verdict.score != null) {
        var sc = el('div', 'skt-score');
        sc.appendChild(el('b', null, String(r.verdict.score)));
        sc.appendChild(el('i', null, '/ ' + r.verdict.max + '点'));
        v.appendChild(sc);
      }
      v.appendChild(el('h4', null, r.verdict.title));
      if (r.verdict.desc) v.appendChild(el('p', null, r.verdict.desc));
      out.appendChild(v);
    }

    if (r.headline) {
      var h = el('div');
      h.appendChild(el('div', 'skt-hl-label', r.headline.label));
      var hv = el('div', 'skt-hl-val');
      hv.appendChild(el('b', null, r.headline.value));
      if (r.headline.unit) hv.appendChild(el('i', null, r.headline.unit));
      h.appendChild(hv);
      if (r.headline.sub) h.appendChild(el('div', 'skt-hl-sub', r.headline.sub));
      out.appendChild(h);
    }

    if (r.bar && r.bar.length) {
      var total = r.bar.reduce(function (a, b) { return a + Math.abs(b.value); }, 0) || 1;
      var bar = el('div', 'skt-bar');
      var leg = el('div', 'skt-legend');
      r.bar.forEach(function (s, i) {
        var color = s.color || PALETTE[i % PALETTE.length];
        var seg = el('i');
        seg.style.width = (Math.abs(s.value) / total * 100).toFixed(2) + '%';
        seg.style.background = color;
        seg.title = s.label + ' ' + yen(s.value);
        bar.appendChild(seg);
        var row = el('div');
        var dot = el('b'); dot.style.background = color;
        row.appendChild(dot);
        row.appendChild(document.createTextNode(s.label));
        row.appendChild(el('span', null, yen(s.value)));
        leg.appendChild(row);
      });
      out.appendChild(bar);
      out.appendChild(leg);
    }

    if (r.rows && r.rows.length) {
      var rows = el('div', 'skt-rows');
      r.rows.forEach(function (x) {
        var c = 'skt-row';
        if (x.kind) c += ' is-' + x.kind;
        var row = el('div', c);
        row.appendChild(el('span', null, x.label));
        row.appendChild(el('span', null, x.value));
        rows.appendChild(row);
      });
      out.appendChild(rows);
    }

    if (r.flags && r.flags.length) {
      var fl = el('div', 'skt-flags');
      r.flags.forEach(function (x) {
        var f = el('div', 'skt-flag lv-' + (x.level || 'info'));
        var body = el('div');
        if (x.title) {
          body.appendChild(el('b', null, x.title));
          body.appendChild(document.createElement('br'));
        }
        body.appendChild(document.createTextNode(x.text));
        f.appendChild(body);
        fl.appendChild(f);
      });
      out.appendChild(fl);
    }

    if (r.list && r.list.length) {
      var ls = el('div', 'skt-list');
      r.list.forEach(function (g) {
        var blk = el('div');
        blk.appendChild(el('h5', null, g.group));
        var ul = document.createElement('ul');
        g.items.forEach(function (it) {
          var li = document.createElement('li');
          var d = el('div');
          d.appendChild(document.createTextNode(it.label));
          if (it.note) d.appendChild(el('em', null, it.note));
          li.appendChild(d);
          ul.appendChild(li);
        });
        blk.appendChild(ul);
        ls.appendChild(blk);
      });
      out.appendChild(ls);
    }

    if (r.table) {
      var tw = el('div', 'skt-table');
      var t = document.createElement('table');
      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      r.table.head.forEach(function (h2) { htr.appendChild(el('th', null, h2)); });
      thead.appendChild(htr);
      var tb = document.createElement('tbody');
      r.table.rows.forEach(function (rw, i) {
        var tr = document.createElement('tr');
        if (i === r.table.hit) tr.className = 'is-hit';
        rw.forEach(function (cell) { tr.appendChild(el('td', null, cell)); });
        tb.appendChild(tr);
      });
      t.appendChild(thead);
      t.appendChild(tb);
      tw.appendChild(t);
      out.appendChild(tw);
    }

    if (r.links && r.links.length) {
      var lk = el('div', 'skt-links');
      r.links.forEach(function (x) {
        var a = el('a', null, x.label);
        a.href = x.href;
        lk.appendChild(a);
      });
      out.appendChild(lk);
    }

    if (r.notes && r.notes.length) {
      var nw2 = el('div', 'skt-notes');
      var ul2 = document.createElement('ul');
      r.notes.forEach(function (s) { ul2.appendChild(el('li', null, s)); });
      nw2.appendChild(ul2);
      out.appendChild(nw2);
    }
  }

  /* ===================== 書き出し ===================== */

  function resultToLines(r, title) {
    var out = [title || ''];
    if (r.verdict) out.push(r.verdict.title + (r.verdict.score != null ? '（' + r.verdict.score + '/' + r.verdict.max + '点）' : ''));
    if (r.headline) out.push(r.headline.label + ': ' + r.headline.value + (r.headline.unit || ''));
    (r.rows || []).forEach(function (x) { out.push(x.label + ': ' + x.value); });
    (r.flags || []).forEach(function (x) { out.push('・' + (x.title ? x.title + ' — ' : '') + x.text); });
    (r.list || []).forEach(function (g) {
      out.push('【' + g.group + '】');
      g.items.forEach(function (it) { out.push('□ ' + it.label + (it.note ? '（' + it.note + '）' : '')); });
    });
    (r.notes || []).forEach(function (s) { out.push('※ ' + s); });
    return out.filter(Boolean);
  }

  function flash(btn, label) {
    var old = btn.textContent;
    btn.textContent = label;
    btn.classList.add('is-done');
    setTimeout(function () { btn.textContent = old; btn.classList.remove('is-done'); }, 1800);
  }

  /* ===================== 計測（GA4） ===================== */

  /* gtag も dataLayer も無いサイトでは何もしない */
  function track(ev, params) {
    try {
      if (typeof window.gtag === 'function') window.gtag('event', ev, params || {});
      else if (window.dataLayer && window.dataLayer.push) window.dataLayer.push(Object.assign({ event: ev }, params || {}));
    } catch (e) { /* 計測の失敗で画面を止めない */ }
  }
  SKT.track = track;

  /* ===================== 起動 ===================== */

  var seq = 0;

  function mount(root) {
    var name = root.dataset.tool;
    var tool = SKT.tools[name];
    if (!tool) return;

    var uid = 'skt' + (++seq);
    var app = root.querySelector('.skt-app');
    if (!app) return;

    var form = el('div', 'skt-in');
    var outWrap = el('div', 'skt-out-wrap');
    var out = el('div', 'skt-out');
    out.setAttribute('role', 'status');
    out.setAttribute('aria-live', 'polite');
    outWrap.appendChild(out);

    var fields = [];
    var groups = tool.groups || [{ fields: tool.fields }];

    function recompute() {
      var v = {};
      fields.forEach(function (x) { v[x.f.k] = fieldValue(x.f, x.wrap); });

      /* 条件付きの欄を出し入れしてから、もう一度読む（依存欄の値を正しく拾うため） */
      var changed = false;
      fields.forEach(function (x) {
        if (!x.f.when) return;
        var show = !!x.f.when(v);
        if (show === (x.wrap.style.display !== 'none')) return;
        x.wrap.style.display = show ? '' : 'none';
        changed = true;
      });
      if (changed) {
        fields.forEach(function (x) { v[x.f.k] = fieldValue(x.f, x.wrap); });
      }

      root._sktValues = v;
      var r;
      try {
        r = tool.compute(v, SKT);
      } catch (e) {
        r = { headline: { label: '計算できませんでした', value: '—' }, notes: ['入力を確認してください。'] };
        if (window.console) console.error('[SKT] ' + name, e);
      }
      root._sktResult = r;
      renderResult(out, r);
    }

    /* ---------- 1画面1問のステップ式（2026-10-27） ----------
       欄を1つずつ出し、最後に結果だけを大きく見せる。選ぶだけの欄は選んだら次へ進む。
       条件付きの欄（when）は、そのとき出ていなければ飛ばす。 */
    var steps = [];
    groups.forEach(function (g) {
      (g.fields || []).forEach(function (f) {
        var w = buildField(f, uid, recompute);
        fields.push({ f: f, wrap: w });
        var st = el('div', 'skt-step');
        st.hidden = true;
        st.appendChild(el('h3', 'skt-q', f.q || f.label || g.title || ''));
        st.appendChild(w);
        var err = el('p', 'skt-step-err'); err.hidden = true; err.setAttribute('role', 'alert');
        st.appendChild(err);
        var nav = el('div', 'skt-step-nav');
        var back = el('button', 'skt-btn skt-back', '戻る'); back.type = 'button';
        var next = el('button', 'skt-btn skt-next', '次へ'); next.type = 'button';
        nav.appendChild(back); nav.appendChild(next);
        st.appendChild(nav);
        steps.push({ f: f, wrap: w, el: st, err: err, back: back, next: next });
        form.appendChild(st);
      });
    });
    var head = el('div', 'skt-progress');
    var bar = el('div', 'skt-progress-bar'); head.appendChild(bar);
    var count = el('p', 'skt-progress-text');
    form.insertBefore(count, form.firstChild);
    form.insertBefore(head, form.firstChild);
    var cur = 0;
    var redo = el('button', 'skt-btn skt-redo', '条件を変える'); redo.type = 'button';

    function visible() { return steps.filter(function (x) { return x.wrap.style.display !== 'none'; }); }
    function stepOk(x) {
      var f = x.f;
      if (f.t === 'custom' && x.wrap._sktGet) {
        var g = x.wrap._sktGet();
        return g && g.ok ? '' : ((g && g.msg) || '入力してください。');
      }
      if (f.t === 'num' || f.t === 'man' || f.t === 'yen') return fieldValue(f, x.wrap) > 0 ? '' : '数字を入れてください。';
      return '';
    }
    function go(i) {
      var vs = visible();
      if (i >= vs.length) { finish(); return; }
      cur = Math.max(0, i);
      steps.forEach(function (x) { x.el.hidden = x !== vs[cur]; x.err.hidden = true; });
      vs[cur].back.style.visibility = cur === 0 ? 'hidden' : '';
      vs[cur].next.textContent = cur === vs.length - 1 ? '結果を見る' : '次へ';
      bar.style.width = Math.round(cur / vs.length * 100) + '%';
      count.textContent = (cur + 1) + ' / ' + vs.length;
      form.hidden = false; outWrap.hidden = true; app.classList.remove('is-done');
      var t = root.getBoundingClientRect().top;
      if (t < 0 || t > window.innerHeight * 0.5) root.scrollIntoView({ block: 'start', behavior: 'smooth' });
      track('skt_step', { tool: name, step: cur + 1 });
    }
    function forward() {
      var vs = visible(), x = vs[cur];
      var m = stepOk(x);
      if (m) { x.err.textContent = m; x.err.hidden = false; return; }
      go(cur + 1);
    }
    function finish() {
      recompute();
      form.hidden = true; outWrap.hidden = false; app.classList.add('is-done');
      var t = root.getBoundingClientRect().top;
      if (t < 0 || t > window.innerHeight * 0.5) root.scrollIntoView({ block: 'start', behavior: 'smooth' });
      track('skt_result', { tool: name });
    }
    steps.forEach(function (x) {
      x.next.addEventListener('click', forward);
      x.back.addEventListener('click', function () { go(cur - 1); });
      if (x.f.t === 'tiles') {
        // 選ぶだけの欄は、選んだら次へ（同じものを押し直しても進む）
        Array.prototype.forEach.call(x.wrap.querySelectorAll('input[type=radio]'), function (r) {
          var adv = function () { setTimeout(function () { if (visible()[cur] === x) forward(); }, 220); };
          r.addEventListener('change', adv);
          r.addEventListener('click', function () { if (r.checked) adv(); });
        });
      }
      x.wrap.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); forward(); }
      });
    });
    redo.addEventListener('click', function () { go(0); });

    app.classList.add('is-wizard');
    app.appendChild(form);
    app.appendChild(outWrap);
    outWrap.hidden = true;

    /* 操作ボタン */
    var acts = el('div', 'skt-actions');
    var bPrint = el('button', 'skt-btn', '印刷する');
    bPrint.type = 'button';
    bPrint.addEventListener('click', function () { window.print(); });
    var bCopy = el('button', 'skt-btn', '結果をコピー');
    bCopy.type = 'button';
    bCopy.addEventListener('click', function () {
      var txt = resultToLines(root._sktResult || {}, tool.title).join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { flash(bCopy, 'コピーしました'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); flash(bCopy, 'コピーしました'); } catch (e) { /* 失敗時は何もしない */ }
        ta.remove();
      }
    });
    acts.appendChild(redo);
    acts.appendChild(bPrint);
    acts.appendChild(bCopy);
    outWrap.appendChild(acts);

    /* CTA（設定画面で入れたURLがあるときだけ）。
       押したら、入力した条件の要約を相談フォームへ引き継ぐ（値はURLに載せず sessionStorage で渡す） */
    var cta = root.querySelector('[data-cta]');
    if (cta) {
      outWrap.appendChild(cta);
      cta.addEventListener('click', function () {
        track('skt_cta_click', { tool: name });
        var cfg = window.SKT_CFG || {};
        if (!cfg.handoff || !tool.handoff) return;
        try {
          var h = tool.handoff(root._sktValues || {}, root._sktResult || {}, SKT) || {};
          var lines = [tool.title + 'で計算した条件'].concat(h.lines || []);
          sessionStorage.setItem('skt_handoff', JSON.stringify({
            text: lines.join('\n'), youken: h.youken || '', tera: h.tera || '', at: Date.now()
          }));
        } catch (e) { /* 保存できない環境では引き継がないだけ */ }
      });
    }

    var ns = root.querySelector('.skt-noscript');
    if (ns) ns.remove();

    /* 最初に触ったときだけ「使われた」を送る（入力のたびに送らない） */
    var used = false;
    form.addEventListener('change', function () {
      if (used) return;
      used = true;
      track('skt_use', { tool: name });
    });
    root._sktRecompute = recompute;

    recompute();
    go(0);
  }

  function boot() {
    Array.prototype.slice.call(document.querySelectorAll('.skt[data-tool]')).forEach(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
