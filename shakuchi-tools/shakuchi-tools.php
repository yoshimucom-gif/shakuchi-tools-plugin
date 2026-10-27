<?php
/**
 * Plugin Name: 借地権の計算ツール
 * Description: 借地権の売却相場・更新料・承諾料の目安を、ショートコード1本でページに置けます。土地の単価は国交省「不動産情報ライブラリ」の土地の取引事例から自動で取得できます（APIキーを設定した場合）。計算はブラウザ内で行い、入力値は保存しません。
 * Version: 1.1.3
 * Author: ミカタ株式会社
 * License: GPLv2 or later
 * Text Domain: shakuchi-tools
 *
 * ★設計上の決めごと（fudosan-tools・fudosan-satei から引き継いだもの）:
 *   - 計算はブラウザ側（skt-tools.js）で行う。入力値をサーバーに保存しないので、
 *     DBテーブル・同意取得・スパム対策がいらない。ページキャッシュとも干渉しない。
 *   - サーバーへ送るのは「市区町村コード」と「地区名」だけ（土地の単価を取りにいくため）。
 *     国交省APIの結果は12時間キャッシュし、キャッシュキーにAPIキーの指紋を含める
 *     （fudosan-satei の教訓: キーを替えても古い値を配り続けない）。
 *   - APIキーが無いときにダミーの取引事例へ落とさない。架空の事例を「周辺の取引」として
 *     見せることになるため（景品表示法5条1号）。キーが無ければ自動取得の選択肢を出さない。
 *   - 見出し・導入文・解説はPHPでサーバー出力する（検索エンジンに読ませるため）。
 *   - 表記は「参考価格の目安」。運営のミカタ株式会社は宅地建物取引業者ではないため、
 *     自動計算の結果を「査定」と呼ばない。「査定」と書くのはCTAの先（監修の宅建業者）だけ。
 *
 * ★掛け率（売り方ごとの減価・承諾料率・更新料率）は管理画面で変えられる設定値。
 *   既定値は暫定で、監修者の確認待ち（includes/rates.php の skt_rate_defaults）。
 */

if (!defined('ABSPATH')) exit;

define('SKT_VER', '1.1.3');
define('SKT_OPT', 'skt_options');
define('SKT_DIR', plugin_dir_path(__FILE__));
define('SKT_URL', plugin_dir_url(__FILE__));
define('SKT_ENDPOINT', 'https://www.reinfolib.mlit.go.jp/ex-api/external/XIT001');

/** 自動更新の置き場。空なら自動更新は無効 */
define('SKT_UPDATE_URL', 'https://raw.githubusercontent.com/yoshimucom-gif/shakuchi-tools-plugin/main/update.json');

/* 更新チェッカー。is_admin() だけで囲わないこと（WP-Cron は管理画面外で走る） */
if (is_admin() || (defined('DOING_CRON') && DOING_CRON) || (defined('WP_CLI') && WP_CLI)) {
    require_once __DIR__ . '/includes/plugin-updater.php';
    new SKT_Shakuchi_Updater(__FILE__, SKT_UPDATE_URL);
}

require_once __DIR__ . '/includes/rates.php';
require_once __DIR__ . '/includes/tools-data.php';

/* =========================================================================
 * 設定
 * ======================================================================= */

function skt_defaults() {
    return array(
        'accent'      => '#1F2E43',
        'brass'       => '#BB9C5E',
        'api_key'     => '',
        'cta_url'     => '',
        'cta_label'   => '正確な金額を無料で査定してもらう',
        'cta_note'    => '監修の宅地建物取引業者が査定します。入力した条件は相談フォームに引き継がれます',
        'temple_url'  => '',
        'handoff'     => '1',
        'f_message'   => 'your-message',
        'f_youken'    => 'youken',
        'f_tera'      => 'tera',
        'rates'       => skt_rate_defaults(),
        'rates_ok'    => '',
    );
}

function skt_opt($key = null) {
    $o = wp_parse_args((array) get_option(SKT_OPT, array()), skt_defaults());
    $o['rates'] = wp_parse_args(is_array($o['rates']) ? $o['rates'] : array(), skt_rate_defaults());
    return $key === null ? $o : (isset($o[$key]) ? $o[$key] : null);
}

/**
 * 国交省APIのキー。このプラグインの設定が空なら、同じサイトに入っている
 * 借地権の目安査定（shakuchi-satei）・相場データ（fudosan-souba）のキーを使う。二重に入れなくて済むように。
 */
function skt_api_key() {
    $k = trim((string) skt_opt('api_key'));
    if ($k !== '') return $k;
    foreach (array('ssa_options', 'fsb_options') as $o) {
        $v = get_option($o);
        if (is_array($v) && !empty($v['api_key'])) return trim((string) $v['api_key']);
    }
    return '';
}

function skt_api_ready() {
    return skt_api_key() !== '';
}

/* =========================================================================
 * 市区町村マスタ（fudosan-satei と同じ XIT002 由来のデータ）
 * ======================================================================= */

function skt_jp_data() {
    static $d = null;
    if ($d === null) {
        $d = @include __DIR__ . '/includes/jp-cities.php';
        if (!is_array($d) || empty($d['prefs'])) $d = array('prefs' => array(), 'cities' => array());
    }
    return $d;
}

/* 実在する市区町村コードだけ通す（transientキーの汚染と外部APIの濫用を防ぐ） */
function skt_city_valid($code) {
    if ($code === '' || !ctype_digit($code) || strlen($code) !== 5) return false;
    $cities = skt_jp_data()['cities'];
    $pref = substr($code, 0, 2);
    foreach (isset($cities[$pref]) ? $cities[$pref] : array() as $c) {
        if ((string) $c[0] === $code) return true;
    }
    return false;
}

/* =========================================================================
 * 土地の単価（国交省 不動産情報ライブラリ XIT001）
 * ======================================================================= */

function skt_to_int($s) {
    if ($s === null || $s === '') return null;
    if (preg_match('/\d+/', str_replace(',', '', (string) $s), $m)) return intval($m[0]);
    return null;
}

/**
 * 1件の取引から㎡単価を出す。fudosan-satei の fs_unit_price と同じ規則:
 *   UnitPrice があればそれを使う。無ければ TradePrice÷Area。
 *   Area=9999 は「9999㎡以上」の打ち切り値なので、割り算に使わない。
 */
function skt_unit_price($rec) {
    $up = skt_to_int(isset($rec['UnitPrice']) ? $rec['UnitPrice'] : '');
    if ($up) return floatval($up);
    $area = skt_to_int(isset($rec['Area']) ? $rec['Area'] : '');
    if ($area !== null && $area >= 9999) return null;
    $price = skt_to_int(isset($rec['TradePrice']) ? $rec['TradePrice'] : '');
    if ($price && $area && $area > 0) return $price / $area;
    return null;
}

function skt_percentile($sorted, $p) {
    $n = count($sorted);
    if ($n === 0) return 0;
    if ($n === 1) return $sorted[0];
    $rank = $p * ($n - 1);
    $lo = (int) floor($rank); $hi = (int) ceil($rank);
    if ($lo === $hi) return $sorted[$lo];
    return $sorted[$lo] + ($rank - $lo) * ($sorted[$hi] - $sorted[$lo]);
}

/** 1市区町村×1四半期。該当なしは仕様上404なので空配列として扱う */
function skt_api_fetch($city, $year, $quarter) {
    $res = wp_remote_get(SKT_ENDPOINT . '?' . http_build_query(array(
        'year' => (int) $year, 'quarter' => (int) $quarter, 'city' => $city,
    )), array(
        'timeout' => 15,
        'headers' => array('Ocp-Apim-Subscription-Key' => skt_api_key()),
    ));
    if (is_wp_error($res)) return null;
    $code = (int) wp_remote_retrieve_response_code($res);
    if ($code === 404) return array();
    if ($code !== 200) return null;
    $json = json_decode(wp_remote_retrieve_body($res), true);
    return (is_array($json) && isset($json['data']) && is_array($json['data'])) ? $json['data'] : array();
}

/**
 * 直近8四半期の「宅地(土地)」の取引だけを返す。
 * 戻り: array('ok'=>bool, 'rows'=>[...], 'from'=>'2024年1月', 'to'=>'2025年12月')
 */
function skt_land_records($city) {
    $latest = intval(current_time('Y')) - 1;   // 前年の4Qから遡る（当年分は公開が遅れる）
    $ck = 'skt_land_' . substr(md5(skt_api_key()), 0, 8) . '_' . $city . '_' . $latest;
    $cached = get_transient($ck);
    if (is_array($cached)) return $cached;

    $rows = array(); $failed = 0;
    $y = $latest; $q = 4;
    for ($i = 0; $i < 8; $i++) {
        $part = skt_api_fetch($city, $y, $q);
        if ($part === null) { $failed++; }
        else {
            foreach ($part as $r) {
                if ((isset($r['Type']) ? $r['Type'] : '') === '宅地(土地)') {
                    $rows[] = array(
                        'd' => trim(isset($r['DistrictName']) ? $r['DistrictName'] : ''),
                        'u' => skt_unit_price($r),
                    );
                }
            }
        }
        if (--$q === 0) { $q = 4; $y--; }
    }
    $out = array(
        'ok'   => $failed < 8,
        'rows' => $rows,
        'from' => ($latest - 1) . '年1月',
        'to'   => $latest . '年12月',
    );
    // 全滅（キー不正・API停止）はキャッシュしない。直ったらすぐ取り直せるように
    if ($out['ok']) set_transient($ck, $out, 12 * HOUR_IN_SECONDS);
    return $out;
}

/**
 * 単価の集計。地区の事例が5件以上あれば地区で、足りなければ市区町村全体で出す。
 * 絞り込めなかったことは必ず利用者に伝える（黙って全体に落とさない）。
 */
function skt_land_stats($city, $district) {
    $rec = skt_land_records($city);
    if (!$rec['ok']) {
        return array('ok' => false, 'reason' => '国の取引データに接続できませんでした。時間をおいて試すか、路線価か坪単価を入力してください。');
    }

    $counts = array();
    foreach ($rec['rows'] as $r) {
        if ($r['d'] === '' || !$r['u']) continue;
        $counts[$r['d']] = (isset($counts[$r['d']]) ? $counts[$r['d']] : 0) + 1;
    }
    arsort($counts);
    $districts = array();
    foreach ($counts as $name => $c) $districts[] = array($name, $c);

    $scope = 'city'; $warn = '';
    $pool = $rec['rows'];
    if ($district !== '') {
        $dp = array_values(array_filter($pool, function ($r) use ($district) { return $r['d'] === $district; }));
        if (count($dp) >= 5) { $pool = $dp; $scope = 'district'; }
        else {
            $warn = sprintf('「%s」の土地の取引が5件未満のため、市区町村全体の取引で出しています。', $district);
        }
    }

    $units = array();
    foreach ($pool as $r) if ($r['u'] && $r['u'] > 0) $units[] = $r['u'];
    if (count($units) < 5) {
        return array('ok' => false, 'districts' => $districts,
            'reason' => 'この地域は土地の取引事例が5件未満のため、自動では出せません。路線価か坪単価を入力してください。');
    }
    sort($units);
    return array(
        'ok'        => true,
        'n'         => count($units),
        'p25'       => (int) round(skt_percentile($units, 0.25)),
        'med'       => (int) round(skt_percentile($units, 0.5)),
        'p75'       => (int) round(skt_percentile($units, 0.75)),
        'scope'     => $scope,
        'warn'      => $warn,
        'period'    => $rec['from'] . '〜' . $rec['to'],
        'districts' => $districts,
    );
}

/* 公開エンドポイントなので、IPごとに回数を絞る（外部APIのクォータを守る） */
function skt_rate_ok() {
    $ip = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '';
    $k = 'skt_rl_' . md5($ip);
    $n = (int) get_transient($k);
    if ($n >= 60) return false;
    set_transient($k, $n + 1, 10 * MINUTE_IN_SECONDS);
    return true;
}

add_action('rest_api_init', function () {
    register_rest_route('skt/v1', '/cities', array(
        'methods' => 'GET', 'permission_callback' => '__return_true',
        'callback' => function ($req) {
            $pref = preg_replace('/\D/', '', (string) $req->get_param('pref'));
            $cities = skt_jp_data()['cities'];
            return rest_ensure_response(isset($cities[$pref]) ? $cities[$pref] : array());
        },
    ));
    register_rest_route('skt/v1', '/land', array(
        'methods' => 'GET', 'permission_callback' => '__return_true',
        'callback' => function ($req) {
            if (!skt_api_ready()) return rest_ensure_response(array('ok' => false, 'reason' => '自動取得は設定されていません。'));
            $city = preg_replace('/\D/', '', (string) $req->get_param('city'));
            if (!skt_city_valid($city)) return rest_ensure_response(array('ok' => false, 'reason' => '市区町村を選んでください。'));
            if (!skt_rate_ok()) return rest_ensure_response(array('ok' => false, 'reason' => '短時間に何度も取得したため、少し時間をおいてください。'));
            $district = mb_substr(sanitize_text_field((string) $req->get_param('district')), 0, 40);
            return rest_ensure_response(skt_land_stats($city, $district));
        },
    ));
});

/* =========================================================================
 * アセット（ショートコードがあるページだけで読み込む）
 * ======================================================================= */

function skt_register_assets() {
    wp_register_style('skt', SKT_URL . 'assets/skt.css', array(), SKT_VER);
    wp_register_script('skt', SKT_URL . 'assets/skt.js', array(), SKT_VER, true);
    wp_register_script('skt-tools', SKT_URL . 'assets/skt-tools.js', array('skt'), SKT_VER, true);
}
add_action('wp_enqueue_scripts', 'skt_register_assets');

function skt_enqueue() {
    static $done = false;
    wp_enqueue_style('skt');
    wp_enqueue_script('skt');
    wp_enqueue_script('skt-tools');
    if ($done) return;
    $done = true;
    $o = skt_opt();
    $prefs = array();
    foreach (skt_jp_data()['prefs'] as $code => $name) $prefs[] = array((string) $code, $name);
    wp_localize_script('skt', 'SKT_CFG', array(
        'api'       => skt_api_ready() ? 1 : 0,
        'rest'      => esc_url_raw(rest_url('skt/v1/')),
        'prefs'     => $prefs,
        'rates'     => skt_rates_for_js($o['rates']),
        'templeUrl' => $o['temple_url'],
        'handoff'   => $o['handoff'] === '1' ? 1 : 0,
    ));
}

/**
 * 相談フォームへの引き継ぎ。ツールのボタンを押すと sessionStorage に条件の要約が入り、
 * フォームのあるページでそれを本文欄に書き込む（Contact Form 7 の欄名は設定で変えられる）。
 * fudosan-honki のティザー → フォームと同じ受け渡し方。値はURLに載せない。
 */
function skt_handoff_script() {
    $o = skt_opt();
    if ($o['handoff'] !== '1') return;
    $cfg = wp_json_encode(array('m' => $o['f_message'], 'y' => $o['f_youken'], 't' => $o['f_tera']));
    ?>
<script>
(function(){try{var raw=sessionStorage.getItem('skt_handoff');if(!raw)return;var c=<?php echo $cfg; ?>;
var d=JSON.parse(raw);if(!d||!d.text||Date.now()-(d.at||0)>3600000){sessionStorage.removeItem('skt_handoff');return;}
function go(){var m=c.m&&document.querySelector('textarea[name="'+c.m+'"]');if(!m)return;
if(!m.value){m.value=d.text+'\n\n';m.dispatchEvent(new Event('input',{bubbles:true}));}
if(c.y&&d.youken){var r=document.querySelector('input[name="'+c.y+'"][value="'+d.youken.replace(/"/g,'')+'"]');if(r){r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}));}}
if(c.t&&d.tera){var t=document.querySelector('input[name="'+c.t+'"]');if(t&&!t.value)t.value=d.tera;}
sessionStorage.removeItem('skt_handoff');}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();}catch(e){}})();
</script>
    <?php
}
add_action('wp_footer', 'skt_handoff_script', 99);

/* =========================================================================
 * 描画
 * ======================================================================= */

function skt_shades($hex, $darken = 0.78, $lighten = 0.92) {
    if (!preg_match('/^#[0-9a-fA-F]{6}$/', (string) $hex)) return null;
    list($r, $g, $b) = array(hexdec(substr($hex, 1, 2)), hexdec(substr($hex, 3, 2)), hexdec(substr($hex, 5, 2)));
    return array(
        'base'  => $hex,
        'dark'  => sprintf('#%02x%02x%02x', (int) ($r * $darken), (int) ($g * $darken), (int) ($b * $darken)),
        'light' => sprintf('#%02x%02x%02x',
            (int) ($r + (255 - $r) * $lighten), (int) ($g + (255 - $g) * $lighten), (int) ($b + (255 - $b) * $lighten)),
    );
}

function skt_accent_style() {
    $o = skt_opt();
    $css = '';
    if ($n = skt_shades($o['accent'])) {
        $css .= sprintf('--skt-navy:%s;--skt-navy-d:%s;--skt-navy-l:%s;', $n['base'], $n['dark'], $n['light']);
    }
    if ($b = skt_shades($o['brass'], 0.9, 0.9)) {
        $css .= sprintf('--skt-brass:%s;--skt-brass-l:%s;', $b['base'], $b['light']);
    }
    return $css;
}

function skt_cta_html() {
    $o = skt_opt();
    if (empty($o['cta_url'])) return '';
    $html  = '<a class="skt-cta" data-cta="1" href="' . esc_url($o['cta_url']) . '">';
    $html .= esc_html($o['cta_label']);
    if (!empty($o['cta_note'])) $html .= '<small>' . esc_html($o['cta_note']) . '</small>';
    $html .= '</a>';
    return $html;
}

/**
 * [shakuchi_tool name="baikyaku"]
 *   title="" … 見出しを差し替える
 *   desc="off" … 解説（サーバー出力）を出さない
 *   head="off" … 見出しと導入文を出さない（記事の途中に埋めるとき）
 *   cta="off" … ボタンを出さない
 */
function skt_shortcode_tool($atts) {
    $a = shortcode_atts(array(
        'name' => '', 'title' => '', 'desc' => 'on', 'head' => 'on', 'cta' => 'on',
    ), $atts, 'shakuchi_tool');

    $slug  = sanitize_key($a['name']);
    $tools = skt_tools();
    if (!isset($tools[$slug])) {
        return '<!-- shakuchi_tool: 「' . esc_html($a['name']) . '」というツールはありません -->';
    }
    $t = $tools[$slug];
    skt_enqueue();

    $style = skt_accent_style();
    $out  = '<div class="skt" data-tool="' . esc_attr($slug) . '"' . ($style ? ' style="' . esc_attr($style) . '"' : '') . '>';

    if ($a['head'] !== 'off') {
        $out .= '<div class="skt-head">';
        $out .= '<span class="skt-eyebrow">' . esc_html($t['eyebrow']) . '</span>';
        $out .= '<h2 class="skt-title">' . esc_html($a['title'] !== '' ? $a['title'] : $t['title']) . '</h2>';
        $out .= '<p class="skt-lead">' . esc_html($t['lead']) . '</p>';
        $out .= '</div>';
    }

    $out .= '<noscript><div class="skt-noscript">この計算ツールはブラウザの中で動きます。ご利用にはJavaScriptを有効にしてください。</div></noscript>';
    $out .= '<div class="skt-app"></div>';

    if ($a['cta'] !== 'off') $out .= skt_cta_html();

    if ($a['desc'] !== 'off') {
        $out .= '<div class="skt-desc">' . $t['desc'] . '</div>';
        if (!empty($t['sources'])) {
            $links = array();
            foreach ($t['sources'] as $s) {
                $links[] = '<a href="' . esc_url($s[1]) . '" target="_blank" rel="noopener nofollow">' . esc_html($s[0]) . '</a>';
            }
            $out .= '<p class="skt-src">出典：' . implode('／', $links) . '</p>';
        }
    }

    $out .= '</div>';
    return $out;
}
add_shortcode('shakuchi_tool', 'skt_shortcode_tool');

/* =========================================================================
 * 管理画面
 * ======================================================================= */

function skt_admin_menu() {
    add_options_page('借地権の計算ツール', '借地権ツール', 'manage_options', 'shakuchi-tools', 'skt_settings_page');
}
add_action('admin_menu', 'skt_admin_menu');

function skt_admin_init() {
    register_setting('skt_group', SKT_OPT, array('sanitize_callback' => 'skt_sanitize'));
}
add_action('admin_init', 'skt_admin_init');

function skt_sanitize($in) {
    $d = skt_defaults();
    $old = skt_opt();
    $o = array();
    $o['accent']     = preg_match('/^#[0-9a-fA-F]{6}$/', (string) ($in['accent'] ?? '')) ? $in['accent'] : $d['accent'];
    $o['brass']      = preg_match('/^#[0-9a-fA-F]{6}$/', (string) ($in['brass'] ?? '')) ? $in['brass'] : $d['brass'];
    $o['cta_url']    = esc_url_raw(trim((string) ($in['cta_url'] ?? '')));
    $o['cta_label']  = sanitize_text_field((string) ($in['cta_label'] ?? $d['cta_label']));
    $o['cta_note']   = sanitize_text_field((string) ($in['cta_note'] ?? ''));
    $o['temple_url'] = esc_url_raw(trim((string) ($in['temple_url'] ?? '')));
    $o['handoff']    = !empty($in['handoff']) ? '1' : '';
    foreach (array('f_message', 'f_youken', 'f_tera') as $k) {
        $o[$k] = preg_replace('/[^A-Za-z0-9_\-\[\]]/', '', (string) ($in[$k] ?? $d[$k]));
    }
    /* APIキーは空で送られたら前の値を残す（画面に出さない欄なので、空送信＝変更なし） */
    $key = trim(sanitize_text_field((string) ($in['api_key'] ?? '')));
    $o['api_key'] = !empty($in['api_key_clear']) ? '' : ($key !== '' ? $key : $old['api_key']);
    $o['rates']    = skt_sanitize_rates(isset($in['rates']) ? $in['rates'] : array());
    $o['rates_ok'] = !empty($in['rates_ok']) ? '1' : '';
    return $o;
}

function skt_settings_page() {
    if (!current_user_can('manage_options')) return;
    $o = skt_opt();
    $tools = skt_tools();
    $own_key = trim((string) $o['api_key']) !== '';
    ?>
    <div class="wrap">
      <h1>借地権の計算ツール</h1>
      <p>ページや記事に <code>[shakuchi_tool name="スラッグ"]</code> を貼ると、そのツールが表示されます。</p>

      <?php if ($o['rates_ok'] !== '1') : ?>
        <div class="notice notice-warning inline"><p>
          <strong>掛け率は暫定値です。</strong>下の「掛け率」を監修者に確認し、確定したら「確認済み」にチェックを入れてください（表示には影響しません。管理用の印です）。
        </p></div>
      <?php endif; ?>

      <form method="post" action="options.php">
        <?php settings_fields('skt_group'); ?>

        <h2>土地の単価の自動取得</h2>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row"><label for="skt-api">不動産情報ライブラリのAPIキー</label></th>
            <td>
              <input type="password" class="regular-text" id="skt-api" name="<?php echo SKT_OPT; ?>[api_key]" value="" autocomplete="new-password"
                placeholder="<?php echo $own_key ? '設定済み（変えるときだけ入力）' : '未設定'; ?>">
              <?php if ($own_key) : ?>
                <label style="margin-left:8px"><input type="checkbox" name="<?php echo SKT_OPT; ?>[api_key_clear]" value="1"> 消す</label>
              <?php endif; ?>
              <p class="description">
                状態：<strong><?php
                  if ($own_key) echo 'このプラグインのキーを使用中';
                  elseif (skt_api_ready()) echo '相場データプラグイン（fudosan-souba）のキーを使用中';
                  else echo '未設定（住所からの自動取得は出さず、路線価・坪単価の入力だけになります）';
                ?></strong><br>
                キーは国土交通省の<a href="https://www.reinfolib.mlit.go.jp/api/request/" target="_blank" rel="noopener">利用申請ページ</a>で発行します。
              </p>
            </td>
          </tr>
        </table>

        <h2>結果の下に出すボタン</h2>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row"><label for="skt-cta-url">リンク先URL</label></th>
            <td>
              <input type="url" class="regular-text" id="skt-cta-url" name="<?php echo SKT_OPT; ?>[cta_url]" value="<?php echo esc_attr($o['cta_url']); ?>" placeholder="https://cv-n65.jp/contact-us/">
              <p class="description">空にするとボタンを出しません。</p>
            </td>
          </tr>
          <tr>
            <th scope="row"><label for="skt-cta-label">ボタンの文言</label></th>
            <td><input type="text" class="regular-text" id="skt-cta-label" name="<?php echo SKT_OPT; ?>[cta_label]" value="<?php echo esc_attr($o['cta_label']); ?>"></td>
          </tr>
          <tr>
            <th scope="row"><label for="skt-cta-note">ボタンの下の一言</label></th>
            <td><input type="text" class="large-text" id="skt-cta-note" name="<?php echo SKT_OPT; ?>[cta_note]" value="<?php echo esc_attr($o['cta_note']); ?>"></td>
          </tr>
          <tr>
            <th scope="row">相談フォームへの引き継ぎ</th>
            <td>
              <label><input type="checkbox" name="<?php echo SKT_OPT; ?>[handoff]" value="1" <?php checked($o['handoff'], '1'); ?>>
                ボタンを押したら、入力した条件をフォームの本文欄に書き込む</label>
              <p class="description" style="margin-top:8px">Contact Form 7 の欄名（name属性）：</p>
              <p>
                本文 <input type="text" name="<?php echo SKT_OPT; ?>[f_message]" value="<?php echo esc_attr($o['f_message']); ?>" style="width:140px">
                用件 <input type="text" name="<?php echo SKT_OPT; ?>[f_youken]" value="<?php echo esc_attr($o['f_youken']); ?>" style="width:110px">
                お寺の名前 <input type="text" name="<?php echo SKT_OPT; ?>[f_tera]" value="<?php echo esc_attr($o['f_tera']); ?>" style="width:110px">
              </p>
              <p class="description">本文欄が空のときだけ書き込みます。値はURLに載せず、ブラウザの sessionStorage で渡します（1時間で破棄）。</p>
            </td>
          </tr>
          <tr>
            <th scope="row"><label for="skt-temple">寺院一覧ページのURL</label></th>
            <td>
              <input type="url" class="regular-text" id="skt-temple" name="<?php echo SKT_OPT; ?>[temple_url]" value="<?php echo esc_attr($o['temple_url']); ?>" placeholder="https://cv-n65.jp/category/ichiran/">
              <p class="description">地主に「お寺・神社」を選んだときの案内に出すリンクです。空なら出しません。</p>
            </td>
          </tr>
        </table>

        <h2>掛け率</h2>
        <p>ツールの計算に使う割合です。<strong>下限〜上限</strong>の幅で結果を出します。％で入れてください。</p>
        <?php skt_rates_table($o['rates']); ?>
        <p><label><input type="checkbox" name="<?php echo SKT_OPT; ?>[rates_ok]" value="1" <?php checked($o['rates_ok'], '1'); ?>>
          監修者に確認済み</label></p>

        <h2>配色</h2>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row"><label for="skt-accent">濃色</label></th>
            <td><input type="color" id="skt-accent" name="<?php echo SKT_OPT; ?>[accent]" value="<?php echo esc_attr($o['accent']); ?>">
              <p class="description">合計行の罫、選択中のタイル、フォーカス枠に使います。</p></td>
          </tr>
          <tr>
            <th scope="row"><label for="skt-brass">差し色</label></th>
            <td><input type="color" id="skt-brass" name="<?php echo SKT_OPT; ?>[brass]" value="<?php echo esc_attr($o['brass']); ?>">
              <p class="description">ラベルの下線とボタンに使います。</p></td>
          </tr>
        </table>

        <?php submit_button(); ?>
      </form>

      <h2>ショートコード一覧</h2>
      <table class="widefat striped" style="max-width:920px">
        <thead><tr><th style="width:290px">書き方</th><th>出るもの</th></tr></thead>
        <tbody>
        <?php foreach ($tools as $slug => $t) : ?>
          <tr>
            <td><code>[shakuchi_tool name="<?php echo esc_html($slug); ?>"]</code></td>
            <td><strong><?php echo esc_html($t['title']); ?></strong><br><span style="color:#666"><?php echo esc_html($t['lead']); ?></span></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
      <p style="color:#666;max-width:920px">
        属性：<code>head="off"</code> で見出しと導入文を省略（記事の途中に埋めるとき）、
        <code>desc="off"</code> で解説を省略、<code>cta="off"</code> でボタンを省略、
        <code>title="…"</code> で見出しを差し替えます。
      </p>
    </div>
    <?php
}

function skt_action_links($links) {
    array_unshift($links, '<a href="' . admin_url('options-general.php?page=shakuchi-tools') . '">設定</a>');
    return $links;
}
add_filter('plugin_action_links_' . plugin_basename(__FILE__), 'skt_action_links');
