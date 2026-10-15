/* 借地権の計算ツール — 各ツールの定義と計算
 *
 * ツール: baikyaku（売却相場）／koushin（更新料）／shoudaku（承諾料）
 *
 * 計算の骨格（3ツール共通）:
 *   更地価格   = 土地の㎡単価 × 土地面積
 *   借地権価格 = 更地価格 × 借地権割合（路線価図のA〜G）
 *   そこに管理画面の「掛け率」（SKT_CFG.rates、下限〜上限）を掛けて幅で出す。
 *
 * 土地の㎡単価の取り方は3つ:
 *   auto  … 国交省 不動産情報ライブラリの「宅地(土地)」の取引、直近8四半期の㎡単価。
 *           25〜75パーセンタイルを幅、中央値を代表値にする（fudosan-satei と同じ集計）
 *   rosen … 路線価（千円/㎡）。路線価は公示価格の8割程度を目安に定められているため、
 *           0.8で割り戻して時価の目安にする（国税庁「財産評価基準書」の説明による）
 *   tsubo … 坪単価（万円/坪）。1坪＝3.30578㎡
 *
 * ★掛け率の既定値は暫定（監修確認待ち）。ここには数値を書かない。
 *   文言に出す％も SKT_CFG.rates から作る（設定を変えたら説明も一緒に変わる）。
 */
(function () {
  'use strict';

  var SKT = window.SKT;
  if (!SKT) return;
  var CFG = window.SKT_CFG || {};
  var RATES = CFG.rates || {};
  var M2_PER_TSUBO = 3.30578;
  var ROSEN_TO_MARKET = 0.8;

  /** 金額を「3,480万円」「1億2,300万円」に（1万円未満は四捨五入） */
  function man(v) {
    var m = Math.round(v / 10000 + 1e-9);   // 3,062.5万が浮動小数の誤差で切り下がらないように
    if (m < 10000) return m.toLocaleString('ja-JP') + '万円';
    var oku = Math.floor(m / 10000), rest = m % 10000;
    return oku + '億' + (rest ? rest.toLocaleString('ja-JP') + '万' : '') + '円';
  }

  /** 金額の幅を「1,230万〜1,560万円」に。上下が同じなら1つだけ */
  function rng(a) {
    var lo = man(a[0]), hi = man(a[1]);
    if (lo === hi) return lo;
    return lo.replace(/円$/, '') + '〜' + hi;
  }

  function yenM2(v) { return Math.round(v / 1000) * 1000 >= 10000 ? (Math.round(v / 1000) / 10).toLocaleString('ja-JP') + '万円/㎡' : Math.round(v).toLocaleString('ja-JP') + '円/㎡'; }

  function pctRange(key) {
    var r = RATES[key] || [0, 0];
    var a = +(r[0] * 100).toFixed(1), b = +(r[1] * 100).toFixed(1);
    return a === b ? a + '%' : a + '〜' + b + '%';
  }

  function mul(a, k) {
    var r = RATES[k] || [0, 0];
    return [a[0] * r[0], a[1] * r[1]];
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function numInput(unit, ph, onInput) {
    var w = el('div', 'skt-num');
    var i = document.createElement('input');
    i.type = 'text';
    i.inputMode = 'decimal';
    if (ph) i.placeholder = ph;
    w.appendChild(i);
    w.appendChild(el('span', 'skt-unit', unit));
    i.addEventListener('input', onInput);
    return { wrap: w, input: i, val: function () { return SKT.fmt.n(i.value, 0); } };
  }

  function selectBox(onChange) {
    var w = el('div', 'skt-sel');
    var s = document.createElement('select');
    s.addEventListener('change', onChange);
    w.appendChild(s);
    return { wrap: w, sel: s };
  }

  function fill(sel, items, first) {
    sel.innerHTML = '';
    if (first) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = first;
      sel.appendChild(o0);
    }
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it[0];
      o.textContent = it[1];
      sel.appendChild(o);
    });
  }

  function getJSON(path) {
    return fetch((CFG.rest || '/wp-json/skt/v1/') + path, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); });
  }

  /* ===================== 共通の欄：土地の単価 ===================== */

  var LAND = {
    k: 'land', t: 'custom', label: '土地の単価',
    build: function (wrap, id, onChange) {
      var st = { mode: CFG.api ? 'auto' : 'rosen', stats: null, busy: false, msg: '', where: '' };

      var lab = el('div', 'skt-label', '土地の単価');
      lab.id = id + '-lab';
      wrap.appendChild(lab);

      /* 取り方のタイル */
      var modes = [];
      if (CFG.api) modes.push(['auto', '住所から自動', '国の取引データ']);
      modes.push(['rosen', '路線価を入れる', '千円/㎡']);
      modes.push(['tsubo', '坪単価を入れる', '万円/坪']);
      var tiles = el('div', 'skt-tiles');
      tiles.setAttribute('role', 'radiogroup');
      tiles.setAttribute('aria-labelledby', id + '-lab');
      modes.forEach(function (m) {
        var l = el('label', 'skt-tile');
        var r = document.createElement('input');
        r.type = 'radio';
        r.name = id + '-mode';
        r.value = m[0];
        r.checked = m[0] === st.mode;
        var s = el('span');
        s.appendChild(document.createTextNode(m[1]));
        s.appendChild(el('small', null, m[2]));
        l.appendChild(r);
        l.appendChild(s);
        r.addEventListener('change', function () { st.mode = r.value; show(); onChange(); });
        tiles.appendChild(l);
      });
      wrap.appendChild(tiles);

      /* 住所から自動 */
      var pAuto = el('div', 'skt-land-panel');
      var pref = selectBox(function () { loadCities(); });
      var city = selectBox(function () { loadLand(''); });
      var dist = selectBox(function () { loadLand(dist.sel.value); });
      pAuto.appendChild(el('div', 'skt-sublabel', '都道府県'));
      pAuto.appendChild(pref.wrap);
      pAuto.appendChild(el('div', 'skt-sublabel', '市区町村'));
      pAuto.appendChild(city.wrap);
      var distLab = el('div', 'skt-sublabel', '町名（取引のある地区）');
      pAuto.appendChild(distLab);
      pAuto.appendChild(dist.wrap);
      var status = el('div', 'skt-land-status');
      status.setAttribute('aria-live', 'polite');
      pAuto.appendChild(status);
      wrap.appendChild(pAuto);

      /* 路線価 */
      var pRosen = el('div', 'skt-land-panel');
      var rosen = numInput('千円/㎡', '例：350', onChange);
      pRosen.appendChild(rosen.wrap);
      pRosen.appendChild(el('div', 'skt-hint',
        '路線価図で、土地が面した道路に書かれた数字です。「350C」なら350（千円/㎡）を入れ、後ろのアルファベットCは下の「借地権割合」で選んでください。'));
      wrap.appendChild(pRosen);

      /* 坪単価 */
      var pTsubo = el('div', 'skt-land-panel');
      var tsubo = numInput('万円/坪', '例：180', onChange);
      pTsubo.appendChild(tsubo.wrap);
      pTsubo.appendChild(el('div', 'skt-hint', '近所の土地の売り出し価格や、不動産会社から聞いた坪単価があれば入れてください。'));
      wrap.appendChild(pTsubo);

      function show() {
        pAuto.style.display = st.mode === 'auto' ? '' : 'none';
        pRosen.style.display = st.mode === 'rosen' ? '' : 'none';
        pTsubo.style.display = st.mode === 'tsubo' ? '' : 'none';
      }

      function setStatus(text, warn) {
        status.textContent = text || '';
        status.className = 'skt-land-status' + (warn ? ' is-warn' : '');
      }

      function loadCities() {
        st.stats = null;
        fill(city.sel, [], '読み込み中…');
        fill(dist.sel, [], '先に市区町村を選んでください');
        onChange();
        getJSON('cities?pref=' + encodeURIComponent(pref.sel.value)).then(function (list) {
          fill(city.sel, list || [], '市区町村を選ぶ');
        }).catch(function () {
          fill(city.sel, [], '読み込めませんでした');
        });
      }

      var reqSeq = 0;
      function loadLand(district) {
        var code = city.sel.value;
        st.stats = null;
        if (!code) { setStatus(''); onChange(); return; }
        var my = ++reqSeq;
        st.busy = true;
        setStatus('国の取引データを取得しています…');
        onChange();
        getJSON('land?city=' + encodeURIComponent(code) + '&district=' + encodeURIComponent(district || ''))
          .then(function (res) {
            if (my !== reqSeq) return;
            st.busy = false;
            if (!district) {
              var ds = (res && res.districts) || [];
              fill(dist.sel, ds.map(function (d) { return [d[0], d[0] + '（' + d[1] + '件）']; }),
                ds.length ? '町名を選ばない（市区町村全体）' : '地区の情報がありません');
            }
            if (!res || !res.ok) {
              setStatus((res && res.reason) || '取得できませんでした。路線価か坪単価を入れてください。', true);
            } else {
              st.stats = res;
              var place = city.sel.options[city.sel.selectedIndex].text + (res.scope === 'district' ? ' ' + district : '');
              st.where = pref.sel.options[pref.sel.selectedIndex].text + place;
              setStatus(place + '：土地の取引' + res.n + '件（' + res.period + '）の㎡単価を使います。' + (res.warn || ''), !!res.warn);
            }
            onChange();
          })
          .catch(function () {
            if (my !== reqSeq) return;
            st.busy = false;
            setStatus('取得できませんでした。路線価か坪単価を入れてください。', true);
            onChange();
          });
      }

      if (CFG.api) {
        fill(pref.sel, CFG.prefs || [], null);
        pref.sel.value = '13';
        loadCities();
      }
      show();

      wrap._sktGet = function () {
        if (st.mode === 'auto') {
          if (st.busy) return { ok: false, msg: '土地の取引データを取得しています。' };
          var s = st.stats;
          if (!s) return { ok: false, msg: '市区町村を選ぶと、土地の単価を自動で入れます。' };
          return {
            ok: true, mode: 'auto', lo: s.p25, mid: s.med, hi: s.p75, where: st.where,
            warn: s.warn || '',
            note: '土地の単価は、国土交通省「不動産情報ライブラリ」の土地の取引' + s.n + '件（' + s.period +
              '）の㎡単価の中央値（' + yenM2(s.med) + '）です。取引の中ほどの半分は' + yenM2(s.p25) + '〜' + yenM2(s.p75) + 'に収まっています。'
          };
        }
        if (st.mode === 'rosen') {
          var r = rosen.val();
          if (!(r > 0)) return { ok: false, msg: '路線価を入れてください。' };
          var u = r * 1000 / ROSEN_TO_MARKET;
          return {
            ok: true, mode: 'rosen', lo: u, mid: u, hi: u, where: '',
            input: '路線価 ' + r.toLocaleString('ja-JP') + '千円/㎡',
            note: '路線価は公示価格の8割程度を目安に決められているため、0.8で割り戻して時価の目安にしています。'
          };
        }
        var t = tsubo.val();
        if (!(t > 0)) return { ok: false, msg: '坪単価を入れてください。' };
        var u2 = t * 10000 / M2_PER_TSUBO;
        return {
          ok: true, mode: 'tsubo', lo: u2, mid: u2, hi: u2, where: '',
          input: '坪単価 ' + t.toLocaleString('ja-JP') + '万円',
          note: '坪単価を㎡単価に直して（1坪＝3.30578㎡）計算しています。'
        };
      };
    }
  };

  var AREA = {
    k: 'area', t: 'num', unit: '㎡', label: '土地の面積', def: 100, min: 0, max: 500, step: 1,
    hint: '登記簿や固定資産税の通知書に書かれた面積です。坪で分かる場合は、坪数×3.31で㎡になります。'
  };

  var RATIO = {
    k: 'ratio', t: 'tiles', label: '借地権割合（路線価図のアルファベット）', def: 'x', cols: 4,
    opts: [
      { v: '0.9', l: 'A', s: '90%' }, { v: '0.8', l: 'B', s: '80%' }, { v: '0.7', l: 'C', s: '70%' },
      { v: '0.6', l: 'D', s: '60%' }, { v: '0.5', l: 'E', s: '50%' }, { v: '0.4', l: 'F', s: '40%' },
      { v: '0.3', l: 'G', s: '30%' }, { v: 'x', l: '不明', s: '60〜70%' }
    ],
    hint: '東京23区の住宅地は60%（D）か70%（C）の地域が多くあります。分からなければ「不明」を選ぶと、60%と70%の両方で計算します。'
  };

  function ratioRange(v) {
    if (v.ratio === 'x') return [0.6, 0.7];
    var r = parseFloat(v.ratio);
    return [r, r];
  }

  function ratioLabel(v) {
    if (v.ratio === 'x') return '不明（60〜70%で計算）';
    var o = RATIO.opts.filter(function (x) { return x.v === v.ratio; })[0];
    return o ? o.l + '（' + o.s + '）' : '';
  }

  /** 更地価格と借地権価格（幅）。入力が足りなければ理由を返す */
  function base(v) {
    var land = v.land || { ok: false, msg: '土地の単価を入れてください。' };
    if (!land.ok) return { err: land.msg };
    if (!(v.area > 0)) return { err: '土地の面積を入れてください。' };
    /* 土地は代表値（自動なら中央値）で計算する。取引の幅まで掛けると、借地権割合の幅・
       掛け率の幅と3重に広がり、目安として使えなくなる（目黒区で実測: 3,000万〜7,840万円）。
       取引の幅は注記で見せる */
    var sar = [land.mid * v.area, land.mid * v.area];
    var rr = ratioRange(v);
    return { land: land, sar: sar, ratio: rr, shak: [sar[0] * rr[0], sar[1] * rr[1]] };
  }

  function pending(label, msg) {
    return { headline: { label: label, value: '—' }, notes: [msg] };
  }

  function commonNotes(b) {
    var n = ['参考価格の目安です。不動産鑑定評価や、宅地建物取引業者による価格査定ではありません。'];
    if (b && b.land && b.land.note) n.push(b.land.note);
    return n;
  }

  function landFlags(b) {
    var f = [];
    if (b.land.warn) f.push({ level: 'warn', text: b.land.warn });
    return f;
  }

  function landLines(v, b) {
    var lines = [];
    if (b.land.where) lines.push('所在地：' + b.land.where);
    if (b.land.input) lines.push('土地の単価：' + b.land.input);
    lines.push('土地の面積：' + v.area + '㎡');
    lines.push('借地権割合：' + ratioLabel(v));
    return lines;
  }

  function templeLinks() {
    return CFG.templeUrl ? [{ label: 'お寺が地主の借地：寺院ごとのページを見る', href: CFG.templeUrl }] : [];
  }

  var T = SKT.tools;

  /* ===================== 売却相場 ===================== */

  var WAYS = {
    jinushi: '地主に売る',
    third: '第三者に売る',
    doji: '底地と一緒に売る'
  };
  var JINUSHI = { tera: 'お寺・神社', kojin: '個人', hojin: '会社' };
  var KIND = { kyu: '旧法の借地権', futsu: '普通借地権（1992年8月以降）', teiki: '定期借地権' };

  function wayRange(way, b) {
    if (way === 'jinushi') return { price: mul(b.shak, 'jinushi') };
    if (way === 'doji') return { price: mul(b.shak, 'doji') };
    var gross = mul(b.shak, 'third');
    var fee = mul(b.shak, 'jouto');
    return { gross: gross, fee: fee, price: [Math.max(0, gross[0] - fee[1]), Math.max(0, gross[1] - fee[0])] };
  }

  T.baikyaku = {
    title: '借地権の売却相場シミュレーター',
    groups: [
      { title: '土地', fields: [LAND, AREA] },
      { title: '借地の条件', fields: [
        RATIO,
        { k: 'kind', t: 'tiles', label: '借地の種類', def: 'kyu', opts: [
          { v: 'kyu', l: '旧法', s: '1992年7月以前' }, { v: 'futsu', l: '普通借地権', s: '1992年8月以降' },
          { v: 'teiki', l: '定期借地権', s: '期限で終わる' }
        ], hint: '契約が1992年（平成4年）7月以前から続いていれば、更新していても旧法の借地権です。' },
        { k: 'jinushi', t: 'tiles', label: '地主', def: 'tera', opts: [
          { v: 'tera', l: 'お寺・神社' }, { v: 'kojin', l: '個人' }, { v: 'hojin', l: '会社' }
        ] }
      ] },
      { title: '売り方', fields: [
        { k: 'way', t: 'tiles', def: 'all', cols: 2, opts: [
          { v: 'all', l: '3つを比べる' }, { v: 'jinushi', l: '地主に売る' },
          { v: 'third', l: '第三者に売る' }, { v: 'doji', l: '底地と一緒に売る' }
        ] }
      ] }
    ],
    compute: function (v) {
      var b = base(v);
      if (b.err) return pending('借地権の売却価格の目安', b.err);

      if (v.kind === 'teiki') {
        return {
          verdict: { level: 'info', title: '定期借地権は、残りの期間で価格が大きく変わります',
            desc: '期限が来ると更地にして返す契約のため、残りの年数が短いほど価格は下がります。この計算は旧法と普通借地権を前提にしているので、定期借地権は個別に査定を受けてください。' },
          notes: commonNotes(b)
        };
      }

      var r = { flags: landFlags(b), notes: commonNotes(b) };

      if (v.way === 'all') {
        r.headline = { label: '借地権価格（売り方を比べる基準）', value: rng(b.shak),
          sub: '更地価格 ' + rng(b.sar) + ' × 借地権割合' };
        var rows = ['jinushi', 'third', 'doji'].map(function (w) {
          return [WAYS[w], rng(wayRange(w, b).price)];
        });
        r.table = { head: ['売り方', '売却価格の目安'], rows: rows };
      } else {
        var wr = wayRange(v.way, b);
        r.headline = { label: WAYS[v.way] + 'ときの売却価格の目安', value: rng(wr.price) };
        r.rows = [
          { label: '更地価格', value: rng(b.sar) },
          { label: '借地権価格（借地権割合を掛けた額）', value: rng(b.shak) }
        ];
        if (v.way === 'third') {
          r.rows.push({ label: '第三者への売却価格（借地権価格の' + pctRange('third') + '）', value: rng(wr.gross) });
          r.rows.push({ label: '地主に払う譲渡承諾料（借地権価格の' + pctRange('jouto') + '）', value: '−' + rng(wr.fee), kind: 'minus' });
        } else if (v.way === 'jinushi') {
          r.rows.push({ label: '地主への売却（借地権価格の' + pctRange('jinushi') + '）', value: rng(wr.price) });
        } else {
          r.rows.push({ label: '借地人の取り分（借地権価格の' + pctRange('doji') + '）', value: rng(wr.price) });
        }
        r.rows.push({ label: '売却価格の目安', value: rng(wr.price), kind: 'total' });
      }

      r.notes.push('掛け率：地主に売る＝借地権価格の' + pctRange('jinushi') + '、第三者に売る＝借地権価格の' +
        pctRange('third') + 'から譲渡承諾料（' + pctRange('jouto') + '）を引いた額、底地と一緒に売る＝借地権価格の' + pctRange('doji') + '。');
      r.notes.push('建物の価値は含めていません。仲介手数料や税金を引く前の金額です。');

      if (v.jinushi === 'tera') {
        r.flags.push({ level: 'info', title: '地主がお寺の場合',
          text: '承諾や売買の判断は住職ひとりではなく、責任役員会で決めるのが原則です（宗教法人法18条）。回答までの期間に余裕を見てください。' });
        if (v.way === 'all' || v.way === 'doji') {
          r.flags.push({ level: 'info', title: '底地と一緒に売るとき',
            text: 'お寺が底地を手放すには、少なくとも1か月前に信者などへ公告する手続きが必要です（宗教法人法23条）。' });
        }
        r.links = templeLinks();
      }
      if (v.kind === 'kyu') {
        r.flags.push({ level: 'ok', text: '旧法の借地権は、地主が更新を断るには正当な理由が必要で、期間が来ても契約が続くのが通常です。借地人の立場が強いことは、売却の交渉で材料になります。' });
      }
      return r;
    },
    handoff: function (v, r) {
      var b = base(v);
      if (b.err) return { youken: '借地権の売却価格査定', lines: [] };
      var lines = landLines(v, b);
      lines.push('借地の種類：' + (KIND[v.kind] || ''));
      lines.push('地主：' + (JINUSHI[v.jinushi] || ''));
      lines.push('売り方：' + (v.way === 'all' ? '比べたい' : WAYS[v.way]));
      if (r.headline) lines.push(r.headline.label + '：' + r.headline.value);
      if (r.table) r.table.rows.forEach(function (x) { lines.push('　' + x[0] + '：' + x[1]); });
      return { youken: '借地権の売却価格査定', lines: lines };
    }
  };

  /* ===================== 更新料 ===================== */

  T.koushin = {
    title: '借地権の更新料 計算ツール',
    groups: [
      { title: '土地', fields: [LAND, AREA] },
      { title: '借地の条件', fields: [
        RATIO,
        { k: 'tokuyaku', t: 'tiles', label: '契約書に更新料の取り決めがありますか', def: 'yes', opts: [
          { v: 'yes', l: 'ある' }, { v: 'no', l: 'ない' }, { v: 'unknown', l: '分からない' }
        ] }
      ] }
    ],
    compute: function (v) {
      var b = base(v);
      if (b.err) return pending('借地権の更新料の目安', b.err);
      var a = mul(b.sar, 'k_sarachi');
      var c = mul(b.shak, 'k_shakuchi');
      var all = [Math.min(a[0], c[0]), Math.max(a[1], c[1])];
      var r = {
        headline: { label: '借地権の更新料の目安', value: rng(all),
          sub: '2つの考え方で出した額の、低いほうから高いほうまで' },
        rows: [
          { label: '更地価格', value: rng(b.sar) },
          { label: '借地権価格', value: rng(b.shak) },
          { label: '更地価格の' + pctRange('k_sarachi') + 'で見た場合', value: rng(a) },
          { label: '借地権価格の' + pctRange('k_shakuchi') + 'で見た場合', value: rng(c) }
        ],
        flags: landFlags(b),
        notes: commonNotes(b)
      };
      if (v.tokuyaku === 'no') {
        r.flags.unshift({ level: 'warn', title: '取り決めがない場合',
          text: '契約に更新料の定めがなければ、地主に払う法的な義務はないとした最高裁判決があります（昭和51年10月1日）。請求を受けたら、払う前に相談してください。' });
      } else if (v.tokuyaku === 'unknown') {
        r.flags.unshift({ level: 'info', text: '払う義務があるかどうかは、契約書の更新料の条項で決まります。先に契約書を確かめてください。' });
      }
      return r;
    },
    handoff: function (v, r) {
      var b = base(v);
      if (b.err) return { youken: '更新料の相談', lines: [] };
      var lines = landLines(v, b);
      lines.push('更新料の取り決め：' + ({ yes: 'ある', no: 'ない', unknown: '分からない' }[v.tokuyaku] || ''));
      if (r.headline) lines.push(r.headline.label + '：' + r.headline.value);
      return { youken: '更新料の相談', lines: lines };
    }
  };

  /* ===================== 承諾料 ===================== */

  var SHOUDAKU = {
    jouto:   { l: '譲渡（第三者に売る）', key: 'jouto',   on: 'shak', law: '借地借家法19条' },
    tatekae: { l: '建て替え',             key: 'tatekae', on: 'sar',  law: '借地借家法17条' },
    zoukai:  { l: '増改築・リフォーム',   key: 'zoukai',  on: 'sar',  law: '借地借家法17条' },
    jouken:  { l: '木造から鉄骨・RCへ',   key: 'jouken',  on: 'sar',  law: '借地借家法17条' }
  };

  T.shoudaku = {
    title: '借地権の承諾料 計算ツール',
    groups: [
      { title: '土地', fields: [LAND, AREA] },
      { title: '承諾を求めること', fields: [
        RATIO,
        { k: 'kind', t: 'tiles', label: '何の承諾ですか', def: 'jouto', cols: 2, opts: [
          { v: 'jouto', l: '譲渡', s: '第三者に売る・名義を変える' }, { v: 'tatekae', l: '建て替え' },
          { v: 'zoukai', l: '増改築', s: 'リフォーム' }, { v: 'jouken', l: '借地条件の変更', s: '木造→鉄骨・RC' }
        ] }
      ] }
    ],
    compute: function (v) {
      var b = base(v);
      if (b.err) return pending('承諾料の目安', b.err);
      var s = SHOUDAKU[v.kind] || SHOUDAKU.jouto;
      var basis = s.on === 'shak' ? b.shak : b.sar;
      var fee = mul(basis, s.key);
      return {
        headline: { label: s.l + 'の承諾料の目安', value: rng(fee) },
        rows: [
          { label: '更地価格', value: rng(b.sar) },
          { label: '借地権価格', value: rng(b.shak) },
          { label: (s.on === 'shak' ? '借地権価格' : '更地価格') + 'の' + pctRange(s.key), value: rng(fee), kind: 'total' }
        ],
        flags: landFlags(b).concat([{ level: 'info', title: '地主が承諾しないとき',
          text: '裁判所に、地主の承諾に代わる許可を求める手続きがあります（' + s.law + '）。その場合も、許可と引き換えに承諾料に当たる金額の支払いを命じられるのが通常です。' }]),
        notes: commonNotes(b)
      };
    },
    handoff: function (v, r) {
      var b = base(v);
      var s = SHOUDAKU[v.kind] || SHOUDAKU.jouto;
      if (b.err) return { youken: 'その他', lines: [] };
      var lines = landLines(v, b);
      lines.push('承諾の内容：' + s.l);
      if (r.headline) lines.push(r.headline.label + '：' + r.headline.value);
      return { youken: v.kind === 'jouto' ? '借地権の売却価格査定' : 'その他', lines: lines };
    }
  };
})();
