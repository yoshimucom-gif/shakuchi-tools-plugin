<?php
/**
 * WordPressなしでツールを動かす確認用サーバー（PHPの組み込みサーバーのルーター）。
 *
 *   $env:SKT_TEST_KEY = '<不動産情報ライブラリのAPIキー>'
 *   C:\Users\yoshi\php-portable\php82\php.exe -S 127.0.0.1:4413 dev_server.php
 *   → http://127.0.0.1:4413/
 *
 * プラグイン本体のPHP（集計・REST・ショートコード）をそのまま読み込み、
 * WordPressの関数だけをここで最小限に代用する。キーがあれば国交省APIを本当に叩く。
 * transient は preview/cache/ にファイルで置く（preview/ は git 管理外）。
 */

define('ABSPATH', __DIR__ . '/');
define('MINUTE_IN_SECONDS', 60);
define('HOUR_IN_SECONDS', 3600);

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/shakuchi-tools/#', $uri) && is_file(__DIR__ . $uri)) return false; // 静的ファイル

/* ---- WordPress の関数の最小限の代用 ---- */
function esc_html($s)  { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function esc_attr($s)  { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function esc_url($s)   { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function esc_url_raw($s) { return (string)$s; }
function sanitize_key($s) { return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string)$s)); }
function sanitize_text_field($s) { return trim(strip_tags((string)$s)); }
function wp_parse_args($a, $d) { return array_merge($d, (array)$a); }
function shortcode_atts($pairs, $atts, $sc = '') {
    $atts = (array)$atts; $out = array();
    foreach ($pairs as $k => $v) $out[$k] = array_key_exists($k, $atts) ? $atts[$k] : $v;
    return $out;
}
$GLOBALS['skt_preview_opt'] = array(
    'api_key'    => getenv('SKT_TEST_KEY') ?: (is_file(__DIR__ . '/preview/.key') ? trim(file_get_contents(__DIR__ . '/preview/.key')) : ''),
    'cta_url'    => '/contact/',
    'temple_url' => 'https://cv-n65.jp/category/ichiran/',
);
function get_option($k, $d = false) { return $k === 'skt_options' ? $GLOBALS['skt_preview_opt'] : $d; }
function add_shortcode($a, $b) {}
function add_action($a, $b, $c = 10, $d = 1) { if ($a === 'rest_api_init') $GLOBALS['skt_rest_init'] = $b; }
function add_filter($a, $b, $c = 10, $d = 1) {}
function plugin_dir_path($f) { return dirname($f) . '/'; }
function plugin_dir_url($f)  { return '/shakuchi-tools/'; }
function plugin_basename($f) { return basename(dirname($f)) . '/' . basename($f); }
function admin_url($p = '')  { return '/wp-admin/' . $p; }
function is_admin() { return false; }
function wp_register_style() {} function wp_register_script() {}
function wp_enqueue_style() {}  function wp_enqueue_script() {}
function wp_localize_script($h, $name, $data) { $GLOBALS['skt_localized'] = array($name, $data); }
function rest_url($p = '') { return '/wp-json/' . $p; }
function wp_json_encode($v) { return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); }
function current_time($f) { return date($f); }
function register_setting() {}  function add_options_page() {}

function skt_cache_file($k) { $d = __DIR__ . '/preview/cache'; if (!is_dir($d)) mkdir($d, 0777, true); return "$d/" . md5($k) . '.json'; }
function get_transient($k) {
    $f = skt_cache_file($k);
    if (!is_file($f)) return false;
    $x = json_decode(file_get_contents($f), true);
    return ($x && $x['exp'] > time()) ? $x['v'] : false;
}
function set_transient($k, $v, $ttl) { file_put_contents(skt_cache_file($k), json_encode(array('exp' => time() + $ttl, 'v' => $v))); return true; }

function wp_remote_get($url, $args = array()) {
    $h = array();
    foreach (($args['headers'] ?? array()) as $k => $v) $h[] = "$k: $v";
    $ch = curl_init($url);
    curl_setopt_array($ch, array(CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $h,
        CURLOPT_TIMEOUT => $args['timeout'] ?? 15, CURLOPT_ENCODING => '',
        CURLOPT_SSL_OPTIONS => 16 /* CURLSSLOPT_NATIVE_CA: このPCの証明書ストアを使う（確認用サーバーだけの設定） */));
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) return new WP_Error($err);
    return array('code' => $code, 'body' => $body);
}
class WP_Error { public $m; function __construct($m) { $this->m = $m; } function get_error_message() { return $this->m; } }
function is_wp_error($x) { return $x instanceof WP_Error; }
function wp_remote_retrieve_response_code($r) { return $r['code']; }
function wp_remote_retrieve_body($r) { return $r['body']; }
function rest_ensure_response($x) { return $x; }
class SKT_Req { private $p; function __construct($p) { $this->p = $p; } function get_param($k) { return $this->p[$k] ?? null; } }
function register_rest_route($ns, $route, $args) { $GLOBALS['skt_routes'][$route] = $args['callback']; }

require __DIR__ . '/shakuchi-tools/shakuchi-tools.php';

/* ---- REST ---- */
if (strpos($uri, '/wp-json/skt/v1/') === 0) {
    ($GLOBALS['skt_rest_init'])();
    $route = '/' . substr($uri, strlen('/wp-json/skt/v1/'));
    header('Content-Type: application/json; charset=utf-8');
    if (!isset($GLOBALS['skt_routes'][$route])) { http_response_code(404); echo '{}'; return true; }
    echo json_encode($GLOBALS['skt_routes'][$route](new SKT_Req($_GET)), JSON_UNESCAPED_UNICODE);
    return true;
}

/* ---- 相談フォームの代用（引き継ぎの確認用） ---- */
if ($uri === '/contact/') {
    echo '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>相談フォーム（確認用）</title></head><body style="font-family:sans-serif;padding:24px">';
    echo '<h1>相談フォーム（確認用）</h1><form>';
    foreach (array('借地権の売却価格査定', '更新料の相談', '親族の借地権相談', '地主トラブルの解決', 'その他') as $i => $v) {
        echo '<label><input type="radio" name="youken" value="' . esc_attr($v) . '"' . ($i === 0 ? ' checked' : '') . '> ' . esc_html($v) . '</label><br>';
    }
    echo '<p>お寺の名前 <input type="text" name="tera"></p><textarea name="your-message" rows="16" cols="90"></textarea></form>';
    skt_handoff_script();
    echo '</body></html>';
    return true;
}

/* ---- ツールのページ ---- */
$only = isset($_GET['tool']) ? array($_GET['tool']) : array_keys(skt_tools());
$body = '';
foreach ($only as $slug) $body .= skt_shortcode_tool(array('name' => $slug)) . '<hr>';
$loc = $GLOBALS['skt_localized'] ?? array('SKT_CFG', array());
$t = time();
echo '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
   . '<title>借地権の計算ツール 確認用</title>'
   . '<link rel="stylesheet" href="/shakuchi-tools/assets/skt.css?t=' . $t . '">'
   . '<style>html{background:#fff;color-scheme:light}body{margin:0 auto;padding:24px 16px 80px;max-width:960px;font-family:-apple-system,"Hiragino Sans","Noto Sans JP",Meiryo,sans-serif}hr{margin:56px 0;border:0;border-top:1px dashed #ccd}</style>'
   . '</head><body>' . $body
   . '<script>var ' . $loc[0] . ' = ' . wp_json_encode($loc[1]) . ';</script>'
   . '<script src="/shakuchi-tools/assets/skt.js?t=' . $t . '"></script>'
   . '<script src="/shakuchi-tools/assets/skt-tools.js?t=' . $t . '"></script>'
   . '</body></html>';
return true;
